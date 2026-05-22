//go:build linux

// blockchain-vpn-tun-client (Noise IK edition, Linux).
//
// One process speaks one encrypted tunnel to a tun-server. Wire format
// matches what the server expects (see cmd/tun-server/main.go):
//
//	[ PV1 | FrameHandshakeA | ne | ns | ciphertext ]  client → server (once)
//	[ PV1 | FrameHandshakeB | ne | ciphertext       ] server → client (once)
//	[ PV1 | FrameTransport  | ciphertext            ] either direction (steady state)
//
// Client supplies its long-term static private key (--noise-key) and the
// server's pinned static public key (--server-pubkey). Both come out of
// the wallet flow on the desktop / mobile / Windows clients via the
// webui's /api/wallet/noise-identity + /api/vpn/config endpoints.

package main

import (
	"context"
	"encoding/hex"
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
	"time"
	"unsafe"

	"blockchain-vpn/protocol/udp/internal/noise"
)

const (
	tunSetIFF = 0x400454ca
	iffTun    = 0x0001
	iffNoPI   = 0x1000

	handshakeTimeout = 5 * time.Second
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

	noiseKeyPath string
	serverPubHex string

	tunFd          int
	udpConn        *net.UDPConn
	serverRoute    []string
	ipv6Blackholed bool // we installed a v6 default-blackhole on bring-up

	static    noise.Keypair
	serverPub [32]byte
	prologue  []byte
	session   *noise.Session
}

func main() {
	var w worker
	flag.StringVar(&w.tunName, "tun", "bvpntun1", "TUN interface name")
	flag.StringVar(&w.tunCIDR, "tun-cidr", "10.99.0.2/24", "TUN interface CIDR")
	flag.StringVar(&w.serverAddr, "server", "127.0.0.1:7001", "VPN tunnel server UDP address (host:port)")
	flag.StringVar(&w.localListen, "bind", ":0", "Local UDP bind address")
	flag.BoolVar(&w.routeDefault, "route-default", false, "Route default traffic through TUN")
	flag.IntVar(&w.mtu, "mtu", 1380, "MTU for TUN interface")
	flag.StringVar(&w.noiseKeyPath, "noise-key", "",
		"Path to 32-byte X25519 client static private key (derived from wallet signature)")
	flag.StringVar(&w.serverPubHex, "server-pubkey", "",
		"Server's pinned X25519 static public key, hex (64 chars)")
	flag.Parse()

	if os.Geteuid() != 0 && !hasNetAdminCap() {
		log.Fatal("tun-client must run as root or have CAP_NET_ADMIN (run setcap cap_net_admin,cap_net_raw+ep on the binary)")
	}
	if w.noiseKeyPath == "" || w.serverPubHex == "" {
		log.Fatal("both --noise-key and --server-pubkey are required (wallet derivation must run first)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := w.run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func (w *worker) run(ctx context.Context) error {
	w.tunFd = -1
	if err := w.loadIdentity(); err != nil {
		return fmt.Errorf("load identity: %w", err)
	}
	w.prologue = []byte("blockchain-vpn-v1")

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

	log.Printf("tun-client running: tun=%s cidr=%s local=%s server=%s routeDefault=%v",
		w.tunName, w.tunCIDR, w.udpConn.LocalAddr(), w.serverAddr, w.routeDefault)

	if err := w.handshake(); err != nil {
		return fmt.Errorf("noise handshake: %w", err)
	}
	log.Printf("noise handshake complete with server %s", w.serverAddr)

	errCh := make(chan error, 2)
	go func() { errCh <- w.loopUDPToTun(ctx) }()
	go func() { errCh <- w.loopTunToUDP(ctx) }()

	select {
	case <-ctx.Done():
		_ = w.udpConn.Close()
		if w.tunFd > 0 {
			_ = syscall.Close(w.tunFd)
			w.tunFd = -1
		}
		return context.Canceled
	case err := <-errCh:
		return err
	}
}

func (w *worker) loadIdentity() error {
	priv, err := os.ReadFile(w.noiseKeyPath)
	if err != nil {
		return fmt.Errorf("read noise key %s: %w", w.noiseKeyPath, err)
	}
	if len(priv) != 32 {
		return fmt.Errorf("noise key %s is %d bytes, expected 32", w.noiseKeyPath, len(priv))
	}
	var seed [32]byte
	copy(seed[:], priv)
	w.static = noise.KeypairFromSeed(seed)

	pub, err := hex.DecodeString(strings.TrimSpace(w.serverPubHex))
	if err != nil {
		return fmt.Errorf("parse --server-pubkey: %w", err)
	}
	if len(pub) != 32 {
		return fmt.Errorf("--server-pubkey is %d bytes, expected 32", len(pub))
	}
	copy(w.serverPub[:], pub)
	log.Printf("client static pubkey: %x", w.static.Public[:])
	log.Printf("server pinned pubkey:  %x", w.serverPub[:])
	return nil
}

func (w *worker) handshake() error {
	w.session = noise.NewInitiator(w.prologue, w.static, w.serverPub)

	// Send msg A.
	msgA, err := w.session.WriteHandshake(nil)
	if err != nil {
		return fmt.Errorf("WriteHandshakeA: %w", err)
	}
	wireA := noise.MarshalHandshakeA(msgA)
	if _, err := w.udpConn.Write(wireA); err != nil {
		return fmt.Errorf("send msg A: %w", err)
	}

	// Wait for msg B.
	if err := w.udpConn.SetReadDeadline(time.Now().Add(handshakeTimeout)); err != nil {
		return err
	}
	defer w.udpConn.SetReadDeadline(time.Time{}) // clear

	buf := make([]byte, 65535)
	n, err := w.udpConn.Read(buf)
	if err != nil {
		return fmt.Errorf("await msg B: %w", err)
	}
	version, frameType, body, err := noise.ParseFrame(buf[:n])
	if err != nil {
		return fmt.Errorf("parse msg B frame: %w", err)
	}
	if version != noise.PV1 {
		return fmt.Errorf("unexpected protocol version %d in msg B", version)
	}
	if frameType != noise.FrameHandshakeB {
		return fmt.Errorf("expected FrameHandshakeB, got frame type %d", frameType)
	}
	msgB, err := noise.ParseHandshakeB(body)
	if err != nil {
		return fmt.Errorf("parse msg B: %w", err)
	}
	if _, err := w.session.ReadHandshake(msgB); err != nil {
		return fmt.Errorf("ReadHandshakeB: %w", err)
	}
	if !w.session.HandshakeComplete() {
		return fmt.Errorf("session not complete after msg B")
	}
	return nil
}

func (w *worker) setupTun() error {
	_ = run("ip", "link", "del", w.tunName)

	// Raw syscall.Open so the TUN fd never enters Go's netpoll (which
	// fails with "not pollable" on TUN devices in newer runtimes).
	fd, err := syscall.Open("/dev/net/tun", syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}

	var req ifreq
	copy(req.Name[:], []byte(w.tunName))
	req.Flags = iffTun | iffNoPI

	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(tunSetIFF), uintptr(unsafe.Pointer(&req)))
	if errno != 0 {
		_ = syscall.Close(fd)
		return errno
	}

	w.tunFd = fd
	if err := run("ip", "addr", "replace", w.tunCIDR, "dev", w.tunName); err != nil {
		_ = syscall.Close(fd)
		w.tunFd = -1
		_ = run("ip", "link", "del", w.tunName)
		return err
	}
	if err := run("ip", "link", "set", "dev", w.tunName, "mtu", fmt.Sprint(w.mtu), "up"); err != nil {
		_ = syscall.Close(fd)
		w.tunFd = -1
		_ = run("ip", "link", "del", w.tunName)
		return err
	}
	return nil
}

func (w *worker) cleanupTun() {
	if w.tunFd > 0 {
		_ = syscall.Close(w.tunFd)
		w.tunFd = -1
	}
	if len(w.serverRoute) > 0 {
		_ = run("ip", append([]string{"route", "del"}, w.serverRoute...)...)
	}
	if w.ipv6Blackholed {
		// Remove the blackhole we installed. The kernel will then accept
		// router-advertisement re-discovery for the original v6 default.
		_ = run("ip", "-6", "route", "del", "blackhole", "default", "metric", "1")
		w.ipv6Blackholed = false
	}
	_ = run("ip", "link", "del", w.tunName)
}

func (w *worker) setupDefaultRoute() error {
	if err := run("ip", "route", "replace", "default", "dev", w.tunName); err != nil {
		return err
	}

	// Drop IPv6 default-route so v6-preferring apps (browsers, curl on
	// dual-stack systems) don't bypass the tunnel via the underlying
	// wlan/eth interface. The tunnel itself is IPv4-only, so any v6
	// egress while connected would leak the user's real IP. We install
	// a blackhole default at metric 1 so the kernel prefers it over
	// any router-advertised v6 default at metric 600; on disconnect,
	// cleanupTun removes it.
	//
	// `ip` grammar puts the route type BEFORE the destination, so the
	// command is `ip -6 route replace blackhole default metric 1`.
	if err := run("ip", "-6", "route", "replace", "blackhole", "default", "metric", "1"); err != nil {
		log.Printf("warning: could not install IPv6 blackhole route (%v); IPv6 traffic may leak", err)
	} else {
		w.ipv6Blackholed = true
		log.Printf("IPv6 default route blackholed (tunnel is IPv4-only)")
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

// loopUDPToTun: read encrypted UDP datagrams from the server, decrypt,
// write plaintext IP packets to the TUN device.
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
		version, frameType, body, err := noise.ParseFrame(buf[:n])
		if err != nil {
			log.Printf("drop short frame (%d bytes)", n)
			continue
		}
		if version != noise.PV1 || frameType != noise.FrameTransport {
			log.Printf("drop unexpected frame v=%d type=%d", version, frameType)
			continue
		}
		t, err := noise.ParseTransport(body)
		if err != nil {
			log.Printf("malformed transport frame: %v", err)
			continue
		}
		plaintext, err := w.session.Decrypt(t)
		if err != nil {
			log.Printf("Decrypt failed: %v", err)
			continue
		}
		if _, err := syscall.Write(w.tunFd, plaintext); err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
	}
}

// loopTunToUDP: read IP packets from the TUN device, encrypt, send via
// UDP to the server.
func (w *worker) loopTunToUDP(ctx context.Context) error {
	buf := make([]byte, 65535)
	for {
		n, err := syscall.Read(w.tunFd, buf)
		if err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
		if n == 0 {
			return errors.New("tun read returned EOF")
		}
		ct, err := w.session.Encrypt(buf[:n])
		if err != nil {
			log.Printf("Encrypt failed: %v", err)
			continue
		}
		wire := noise.MarshalTransport(ct)
		if _, err := w.udpConn.Write(wire); err != nil {
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
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "CapEff:") {
			continue
		}
		hexStr := strings.TrimSpace(strings.TrimPrefix(line, "CapEff:"))
		var caps uint64
		fmt.Sscanf(hexStr, "%x", &caps)
		return caps&(1<<12) != 0
	}
	return false
}
