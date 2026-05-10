package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
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
	tunName   string
	tunCIDR   string
	listen    string
	wanIf     string
	enableNAT bool
	mtu       int
	tunFile   *os.File
	udpConn   *net.UDPConn
	peerMu    sync.RWMutex
	peers     map[string]*net.UDPAddr
	rules     []string
	debugSeen int
}

func main() {
	var w worker
	flag.StringVar(&w.tunName, "tun", "bvpntun0", "TUN interface name")
	flag.StringVar(&w.tunCIDR, "tun-cidr", "10.99.0.1/24", "TUN interface CIDR")
	flag.StringVar(&w.listen, "listen", ":7001", "UDP listen address")
	flag.StringVar(&w.wanIf, "wan-if", "eth0", "WAN interface for NAT")
	flag.BoolVar(&w.enableNAT, "enable-nat", true, "Enable iptables FORWARD + MASQUERADE")
	flag.IntVar(&w.mtu, "mtu", 1380, "MTU for TUN interface")
	flag.Parse()

	if os.Geteuid() != 0 {
		log.Fatal("tun-server must run as root (needs TUN + routing privileges)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := w.run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func (w *worker) run(ctx context.Context) error {
	w.peers = make(map[string]*net.UDPAddr)

	if err := w.setupTun(); err != nil {
		return fmt.Errorf("setup tun: %w", err)
	}
	defer w.cleanupTun()

	if w.enableNAT {
		if err := w.setupForwarding(); err != nil {
			return fmt.Errorf("setup forwarding/nat: %w", err)
		}
		defer w.cleanupRules()
	}

	addr, err := net.ResolveUDPAddr("udp", w.listen)
	if err != nil {
		return err
	}
	w.udpConn, err = net.ListenUDP("udp", addr)
	if err != nil {
		return err
	}
	defer w.udpConn.Close()

	log.Printf("tun-server running: tun=%s cidr=%s udp=%s nat=%v", w.tunName, w.tunCIDR, w.listen, w.enableNAT)

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
	_ = run("ip", "link", "del", w.tunName)
}

func (w *worker) setupForwarding() error {
	if err := run("sysctl", "-w", "net.ipv4.ip_forward=1"); err != nil {
		return err
	}

	cidr := networkCIDR(w.tunCIDR)
	toAdd := []string{
		fmt.Sprintf("iptables -A FORWARD -i %s -o %s -j ACCEPT", w.tunName, w.wanIf),
		fmt.Sprintf("iptables -A FORWARD -i %s -o %s -m state --state RELATED,ESTABLISHED -j ACCEPT", w.wanIf, w.tunName),
		fmt.Sprintf("iptables -t nat -A POSTROUTING -s %s -o %s -j MASQUERADE", cidr, w.wanIf),
	}

	for _, cmd := range toAdd {
		check := strings.Replace(cmd, " -A ", " -C ", 1)
		if err := runShell(check); err == nil {
			continue
		}
		if err := runShell(cmd); err != nil {
			return err
		}
		w.rules = append(w.rules, cmd)
	}
	return nil
}

func (w *worker) cleanupRules() {
	for i := len(w.rules) - 1; i >= 0; i-- {
		del := strings.Replace(w.rules[i], " -A ", " -D ", 1)
		_ = runShell(del)
	}
}

func (w *worker) loopUDPToTun(ctx context.Context) error {
	buf := make([]byte, 65535)
	for {
		n, addr, err := w.udpConn.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
		srcIP, _, err := packetEndpoints(buf[:n])
		if err == nil && srcIP.IsValid() {
			w.peerMu.Lock()
			w.peers[srcIP.String()] = cloneUDPAddr(addr)
			w.peerMu.Unlock()
			if w.debugSeen < 20 {
				log.Printf("udp->tun peer=%s src=%s len=%d", addr.String(), srcIP.String(), n)
			}
		} else if w.debugSeen < 20 {
			log.Printf("udp->tun invalid-packet peer=%s len=%d err=%v", addr.String(), n, err)
		}

		if _, err := w.tunFile.Write(buf[:n]); err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			log.Printf("udp->tun write failed peer=%s len=%d err=%v", addr.String(), n, err)
			return err
		}
		if w.debugSeen < 20 {
			log.Printf("udp->tun write-ok peer=%s len=%d", addr.String(), n)
		}
		w.debugSeen++
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

		_, dstIP, err := packetEndpoints(buf[:n])
		if err != nil {
			continue
		}

		w.peerMu.RLock()
		peer := w.peers[dstIP.String()]
		w.peerMu.RUnlock()
		if peer == nil {
			continue
		}
		if _, err := w.udpConn.WriteToUDP(buf[:n], peer); err != nil {
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

func runShell(command string) error {
	c := exec.Command("bash", "-lc", command)
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", command, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func networkCIDR(cidr string) string {
	ip, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return cidr
	}
	ipNet.IP = ip.Mask(ipNet.Mask)
	return ipNet.String()
}

func packetEndpoints(packet []byte) (netip.Addr, netip.Addr, error) {
	if len(packet) < 1 {
		return netip.Addr{}, netip.Addr{}, fmt.Errorf("empty packet")
	}

	switch packet[0] >> 4 {
	case 4:
		if len(packet) < 20 {
			return netip.Addr{}, netip.Addr{}, fmt.Errorf("short ipv4 packet")
		}
		src, ok := netip.AddrFromSlice(packet[12:16])
		if !ok {
			return netip.Addr{}, netip.Addr{}, fmt.Errorf("invalid ipv4 source")
		}
		dst, ok := netip.AddrFromSlice(packet[16:20])
		if !ok {
			return netip.Addr{}, netip.Addr{}, fmt.Errorf("invalid ipv4 destination")
		}
		return src.Unmap(), dst.Unmap(), nil
	case 6:
		if len(packet) < 40 {
			return netip.Addr{}, netip.Addr{}, fmt.Errorf("short ipv6 packet")
		}
		src, ok := netip.AddrFromSlice(packet[8:24])
		if !ok {
			return netip.Addr{}, netip.Addr{}, fmt.Errorf("invalid ipv6 source")
		}
		dst, ok := netip.AddrFromSlice(packet[24:40])
		if !ok {
			return netip.Addr{}, netip.Addr{}, fmt.Errorf("invalid ipv6 destination")
		}
		return src, dst, nil
	default:
		return netip.Addr{}, netip.Addr{}, fmt.Errorf("unsupported ip version")
	}
}

func cloneUDPAddr(addr *net.UDPAddr) *net.UDPAddr {
	if addr == nil {
		return nil
	}
	ip := make(net.IP, len(addr.IP))
	copy(ip, addr.IP)
	return &net.UDPAddr{
		IP:   ip,
		Port: addr.Port,
		Zone: addr.Zone,
	}
}
