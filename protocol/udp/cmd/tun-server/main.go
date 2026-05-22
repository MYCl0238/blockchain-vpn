// blockchain-vpn-tun-server (Noise IK edition).
//
// One process terminates many encrypted tunnels from clients. Wire format:
//
//	[ PV1 | FrameType | body ]
//
// Frame types (see internal/noise/wire.go):
//
//	FrameHandshakeA — client initiates IK; payload may carry hints
//	FrameHandshakeB — sent by server in reply (never received here)
//	FrameTransport  — AEAD-sealed inner IP packet
//
// Authentication: every connecting client presents a static Curve25519
// public key inside msg A. The server accepts the handshake only if the
// pubkey appears in --peers (file allowlist). The webui writes that
// allowlist when users bind their Noise identity via the wallet flow.
//
// Multi-peer routing: sessions are indexed both by (src_udp_addr) for
// the UDP read loop and by inner tunnel IP for the TUN read loop. NAT
// rebinds are absorbed by re-keying byUDPKey on the first transport
// frame from a new source endpoint.

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
	"syscall"
	"unsafe"

	"time"

	"blockchain-vpn/protocol/udp/internal/keystore"
	"blockchain-vpn/protocol/udp/internal/noise"
	"blockchain-vpn/protocol/udp/internal/peers"
	"blockchain-vpn/protocol/udp/internal/sessman"
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

	noiseKeyPath string
	peersPath    string
	peersDSN     string

	tunFd   int
	udpConn *net.UDPConn
	rules   []string

	static   noise.Keypair
	prologue []byte
	peers    peers.Allower
	sessions *sessman.Manager
}

func main() {
	var w worker
	flag.StringVar(&w.tunName, "tun", "bvpntun0", "TUN interface name")
	flag.StringVar(&w.tunCIDR, "tun-cidr", "10.99.0.1/24", "TUN interface CIDR")
	flag.StringVar(&w.listen, "listen", ":7001", "UDP listen address")
	flag.StringVar(&w.wanIf, "wan-if", "eth0", "WAN interface for NAT")
	flag.BoolVar(&w.enableNAT, "enable-nat", true, "Enable iptables FORWARD + MASQUERADE")
	flag.IntVar(&w.mtu, "mtu", 1380, "MTU for TUN interface")
	flag.StringVar(&w.noiseKeyPath, "noise-key", "/etc/blockchain-vpn/server-static.key",
		"Path to server's 32-byte X25519 static private key (auto-generated on first run)")
	flag.StringVar(&w.peersPath, "peers", "",
		"Path to allowlist file with one hex client static pubkey per line "+
			"(used if --peers-db is empty)")
	flag.StringVar(&w.peersDSN, "peers-db", "",
		"Postgres DSN for live allowlist (queries users.noise_public_key); "+
			"takes priority over --peers when set")
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
	w.tunFd = -1
	kp, created, err := keystore.LoadOrCreateStatic(w.noiseKeyPath)
	if err != nil {
		return fmt.Errorf("load server static: %w", err)
	}
	w.static = kp
	if created {
		log.Printf("generated new server static key; published at %s.pub.hex", w.noiseKeyPath)
	}
	log.Printf("server static pubkey: %s", keystore.PublicKeyHex(kp))

	switch {
	case w.peersDSN != "":
		pg, err := peers.NewPostgres(ctx, w.peersDSN)
		if err != nil {
			return fmt.Errorf("load peers (db): %w", err)
		}
		defer pg.Close()
		w.peers = pg
		log.Printf("loaded %d allowed peers from postgres", pg.Count())
		go pg.RefreshLoop(ctx, 30*time.Second, func(err error) {
			log.Printf("peers refresh error: %v", err)
		})
	case w.peersPath != "":
		fp, err := peers.NewFile(w.peersPath)
		if err != nil {
			return fmt.Errorf("load peers (file): %w", err)
		}
		w.peers = fp
		log.Printf("loaded %d allowed peers from %s", fp.Count(), w.peersPath)
	default:
		return fmt.Errorf("no peer source configured (set --peers-db or --peers)")
	}

	w.prologue = []byte("blockchain-vpn-v1")
	w.sessions = sessman.New()

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

	log.Printf("tun-server running: tun=%s cidr=%s udp=%s nat=%v",
		w.tunName, w.tunCIDR, w.listen, w.enableNAT)

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

func (w *worker) setupTun() error {
	_ = run("ip", "link", "del", w.tunName)

	// Open /dev/net/tun via raw syscall so we never hand the fd to Go's
	// netpoll runtime. Newer Go runtimes (1.21+) try to add character
	// devices to epoll and fail with "not pollable" on TUN devices. We
	// avoid that by doing all reads/writes through syscall.Read/Write.
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

// loopUDPToTun consumes datagrams from the UDP socket: handshake msgs
// become new sessions, transport frames get decrypted and forwarded to
// the TUN device.
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
		w.handleUDPDatagram(buf[:n], addr)
	}
}

func (w *worker) handleUDPDatagram(packet []byte, addr *net.UDPAddr) {
	version, frameType, body, err := noise.ParseFrame(packet)
	if err != nil {
		log.Printf("drop short frame from %s (%d bytes)", addr, len(packet))
		return
	}
	if version != noise.PV1 {
		log.Printf("drop unsupported protocol version %d from %s", version, addr)
		return
	}

	switch frameType {
	case noise.FrameHandshakeA:
		w.handleHandshakeA(addr, body)
	case noise.FrameHandshakeB:
		log.Printf("dropped FrameHandshakeB from %s (servers don't receive B)", addr)
	case noise.FrameTransport:
		w.handleTransport(addr, body)
	default:
		log.Printf("unknown frame type %d from %s", frameType, addr)
	}
}

func (w *worker) handleHandshakeA(addr *net.UDPAddr, body []byte) {
	msgA, err := noise.ParseHandshakeA(body)
	if err != nil {
		log.Printf("malformed FrameHandshakeA from %s: %v", addr, err)
		return
	}

	sess := noise.NewResponder(w.prologue, w.static)
	if _, err := sess.ReadHandshake(msgA); err != nil {
		log.Printf("ReadHandshakeA from %s failed: %v", addr, err)
		return
	}

	peer := sess.PeerStatic()
	if !w.peers.Allow(peer) {
		log.Printf("REJECT handshake from %s — peer key %x not in allowlist", addr, peer[:8])
		return
	}

	msgB, err := sess.WriteHandshake(nil)
	if err != nil {
		log.Printf("WriteHandshakeB for %s failed: %v", addr, err)
		return
	}
	wireB := noise.MarshalHandshakeB(msgB)
	if _, err := w.udpConn.WriteToUDP(wireB, addr); err != nil {
		log.Printf("send HandshakeB to %s: %v", addr, err)
		return
	}

	if existing := w.sessions.LookupByPeer(peer); existing != nil {
		log.Printf("re-handshake from peer %x; evicting prior session @%s", peer[:8], existing.UDPAddr)
		w.sessions.Remove(existing)
	}
	w.sessions.Put(addr, peer, sess)
	log.Printf("session up: peer=%x addr=%s", peer[:8], addr)
}

func (w *worker) handleTransport(addr *net.UDPAddr, body []byte) {
	t, err := noise.ParseTransport(body)
	if err != nil {
		log.Printf("malformed transport from %s: %v", addr, err)
		return
	}

	entry := w.sessions.LookupByUDP(addr)
	if entry == nil {
		log.Printf("transport from unknown UDP source %s — drop", addr)
		return
	}

	plaintext, err := entry.Session.Decrypt(t)
	if err != nil {
		log.Printf("Decrypt from %s failed: %v", addr, err)
		return
	}

	// Route by inner src → session. Clients legitimately send multiple
	// inner sources (e.g. a 10.99.0.x tunnel IP plus IPv6 link-local
	// from the kernel stack); we always rebind to the latest IPv4 in
	// our tunnel CIDR so reply lookups by IPv4 dst find the right
	// session. Non-IPv4 sources update the binding only if no IPv4 has
	// been seen yet — keeps return traffic to 10.99.0.X working.
	src, _, err := packetEndpoints(plaintext)
	if err == nil && src.IsValid() {
		preferRebind := src.Is4() || !entry.TunIP.IsValid() || !entry.TunIP.Is4()
		if preferRebind && entry.TunIP != src {
			w.sessions.BindTunIP(entry, src)
			log.Printf("bound tun ip %s to peer %x", src, entry.PeerKey[:8])
		}
	}

	if _, err := syscall.Write(w.tunFd, plaintext); err != nil {
		log.Printf("tun write failed: %v", err)
	}
}

// loopTunToUDP reads packets from the TUN device and encrypts them back
// to the session owner identified by inner dst IP.
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

		_, dstIP, err := packetEndpoints(buf[:n])
		if err != nil {
			continue
		}

		entry := w.sessions.LookupByTunIP(dstIP)
		if entry == nil {
			continue
		}

		ct, err := entry.Session.Encrypt(buf[:n])
		if err != nil {
			log.Printf("Encrypt for peer %x failed: %v", entry.PeerKey[:8], err)
			continue
		}
		wire := noise.MarshalTransport(ct)
		if _, err := w.udpConn.WriteToUDP(wire, entry.UDPAddr); err != nil {
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
