//go:build linux

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"unsafe"
)

const (
	tunSetIFF = 0x400454ca
	iffTun    = 0x0001
	iffNoPI   = 0x1000
)

type ifreq struct {
	Name  [16]byte
	Flags uint16
	Pad   [22]byte
}

type worker struct {
	tunName      string
	tunCIDR      string
	serverAddr   string
	localListen  string
	routeDefault bool
	mtu          int
	tunFile      *os.File
	udpConn      *net.UDPConn
	serverRoute  []string
}

func main() {
	var w worker
	flag.StringVar(&w.tunName, "tun", "bvpntun1", "TUN interface name")
	flag.StringVar(&w.tunCIDR, "tun-cidr", "10.99.0.2/24", "TUN interface CIDR")
	flag.StringVar(&w.serverAddr, "server", "127.0.0.1:7001", "VPN tunnel server UDP address (host:port)")
	flag.StringVar(&w.localListen, "bind", ":0", "Local UDP bind address")
	flag.BoolVar(&w.routeDefault, "route-default", false, "Route default traffic through TUN")
	flag.IntVar(&w.mtu, "mtu", 1380, "MTU for TUN interface")
	flag.Parse()

	// Need TUN + routing privileges. Accept either root or the binary
	// being granted CAP_NET_ADMIN (and CAP_NET_RAW) via setcap, so the
	// daemon can spawn this as an unprivileged user.
	if os.Geteuid() != 0 && !hasNetAdminCap() {
		log.Fatal("tun-client must run as root or have CAP_NET_ADMIN (run setcap cap_net_admin,cap_net_raw+ep on the binary)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := w.run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func (w *worker) run(ctx context.Context) error {
	serverAddr, err := net.ResolveUDPAddr("udp", w.serverAddr)
	if err != nil {
		return err
	}

	if err := w.setupTun(); err != nil {
		return fmt.Errorf("setup tun: %w", err)
	}
	defer w.cleanupTun()

	if w.routeDefault {
		if err := w.pinServerRoute(serverAddr); err != nil {
			return fmt.Errorf("pin server route: %w", err)
		}
		if err := w.setupDefaultRoute(); err != nil {
			return fmt.Errorf("setup default route: %w", err)
		}
	}

	localAddr, err := net.ResolveUDPAddr("udp", w.localListen)
	if err != nil {
		return err
	}

	w.udpConn, err = net.DialUDP("udp", localAddr, serverAddr)
	if err != nil {
		return err
	}
	defer w.udpConn.Close()

	log.Printf("tun-client running: tun=%s cidr=%s local=%s server=%s routeDefault=%v", w.tunName, w.tunCIDR, w.udpConn.LocalAddr(), w.serverAddr, w.routeDefault)

	errCh := make(chan error, 2)
	go func() { errCh <- w.loopUDPToTun(ctx) }()
	go func() { errCh <- w.loopTunToUDP(ctx) }()

	select {
	case <-ctx.Done():
		_ = w.udpConn.Close()
		if w.tunFile != nil {
			_ = w.tunFile.Close()
		}
		return context.Canceled
	case err := <-errCh:
		return err
	}
}

func (w *worker) setupTun() error {
	_ = run("ip", "link", "del", w.tunName)

	f, err := os.OpenFile("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return err
	}

	var req ifreq
	copy(req.Name[:], []byte(w.tunName))
	req.Flags = iffTun | iffNoPI

	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(tunSetIFF), uintptr(unsafe.Pointer(&req)))
	if errno != 0 {
		_ = f.Close()
		return errno
	}

	w.tunFile = f
	if err := run("ip", "addr", "replace", w.tunCIDR, "dev", w.tunName); err != nil {
		_ = f.Close()
		w.tunFile = nil
		_ = run("ip", "link", "del", w.tunName)
		return err
	}
	if err := run("ip", "link", "set", "dev", w.tunName, "mtu", fmt.Sprint(w.mtu), "up"); err != nil {
		_ = f.Close()
		w.tunFile = nil
		_ = run("ip", "link", "del", w.tunName)
		return err
	}
	return nil
}

func (w *worker) cleanupTun() {
	if w.tunFile != nil {
		_ = w.tunFile.Close()
	}
	if len(w.serverRoute) > 0 {
		_ = run("ip", append([]string{"route", "del"}, w.serverRoute...)...)
	}
	_ = run("ip", "link", "del", w.tunName)
}

func (w *worker) setupDefaultRoute() error {
	if err := run("ip", "route", "replace", "default", "dev", w.tunName); err != nil {
		return err
	}
	return nil
}

func (w *worker) pinServerRoute(serverAddr *net.UDPAddr) error {
	if serverAddr == nil || serverAddr.IP == nil {
		return fmt.Errorf("server address has no IP")
	}

	routeArgs, err := lookupRoute(serverAddr.IP.String())
	if err != nil {
		return err
	}
	w.serverRoute = append([]string{}, routeArgs...)
	return run("ip", append([]string{"route", "replace"}, routeArgs...)...)
}

func lookupRoute(ip string) ([]string, error) {
	c := exec.Command("ip", "route", "get", ip)
	out, err := c.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ip route get %s: %w: %s", ip, err, strings.TrimSpace(string(out)))
	}

	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) == 0 {
		return nil, fmt.Errorf("empty route lookup for %s", ip)
	}

	args := []string{ip + "/32"}
	for i := 0; i < len(fields); i++ {
		switch fields[i] {
		case "via":
			if i+1 >= len(fields) {
				return nil, fmt.Errorf("route lookup missing gateway for %s", ip)
			}
			args = append(args, "via", fields[i+1])
			i++
		case "dev":
			if i+1 >= len(fields) {
				return nil, fmt.Errorf("route lookup missing device for %s", ip)
			}
			args = append(args, "dev", fields[i+1])
			i++
		}
	}

	if len(args) < 3 {
		return nil, fmt.Errorf("could not parse route for %s from %q", ip, strings.TrimSpace(string(out)))
	}
	return args, nil
}

func (w *worker) loopUDPToTun(ctx context.Context) error {
	buf := make([]byte, 65535)
	for {
		n, err := w.udpConn.Read(buf)
		if err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
		if _, err := w.tunFile.Write(buf[:n]); err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
	}
}

func (w *worker) loopTunToUDP(ctx context.Context) error {
	buf := make([]byte, 65535)
	for {
		n, err := w.tunFile.Read(buf)
		if err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
		if _, err := w.udpConn.Write(buf[:n]); err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
	}
}

func run(cmd string, args ...string) error {
	c := exec.Command(cmd, args...)
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %v: %w: %s", cmd, args, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func hasNetAdminCap() bool {
	// /proc/self/status reports the current process's effective capability
	// set as a bitmask. CAP_NET_ADMIN is bit 12; check bit 12 of CapEff.
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "CapEff:") {
			continue
		}
		hex := strings.TrimSpace(strings.TrimPrefix(line, "CapEff:"))
		var caps uint64
		fmt.Sscanf(hex, "%x", &caps)
		return caps&(1<<12) != 0
	}
	return false
}
