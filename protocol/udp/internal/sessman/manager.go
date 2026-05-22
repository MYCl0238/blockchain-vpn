// Package sessman is the server-side Noise session table for tun-server.
//
// Maintains two indexes over active sessions:
//
//	udpKey   ("ip:port")        → *Entry   used by the UDP read loop
//	tunIP    (netip.Addr)        → *Entry  used by the TUN read loop
//
// All access is mutex-guarded. Sessions also carry their peer's static
// public key (the wallet-bound Noise identity) so callers can audit who
// owns a slot.
package sessman

import (
	"net"
	"net/netip"
	"sync"
	"time"

	"blockchain-vpn/protocol/udp/internal/noise"
)

// Entry is one authenticated peer.
type Entry struct {
	Session   *noise.Session
	PeerKey   [32]byte    // peer's static pubkey
	UDPAddr   *net.UDPAddr // last UDP address we saw a transport frame from
	TunIP     netip.Addr   // inner tunnel IP (10.99.0.x); set when the first
	                       // inbound packet's source can be parsed
	CreatedAt time.Time
	LastSeen  time.Time
}

// Manager is the session table.
type Manager struct {
	mu       sync.RWMutex
	byUDPKey map[string]*Entry
	byTunIP  map[netip.Addr]*Entry
	byPeer   map[[32]byte]*Entry // optional reverse lookup; nil-safe if missing
}

// New returns an empty session manager.
func New() *Manager {
	return &Manager{
		byUDPKey: make(map[string]*Entry),
		byTunIP:  make(map[netip.Addr]*Entry),
		byPeer:   make(map[[32]byte]*Entry),
	}
}

// Put records a freshly handshaked session keyed by its current UDP address
// and peer static. Replaces any previous entry for the same UDP key (e.g.
// after a client reconnect from the same source:port).
func (m *Manager) Put(udpAddr *net.UDPAddr, peerKey [32]byte, sess *noise.Session) *Entry {
	now := time.Now()
	e := &Entry{
		Session:   sess,
		PeerKey:   peerKey,
		UDPAddr:   cloneUDPAddr(udpAddr),
		CreatedAt: now,
		LastSeen:  now,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if old := m.byUDPKey[udpKey(udpAddr)]; old != nil {
		if old.TunIP.IsValid() {
			delete(m.byTunIP, old.TunIP)
		}
		delete(m.byPeer, old.PeerKey)
	}
	m.byUDPKey[udpKey(udpAddr)] = e
	m.byPeer[peerKey] = e
	return e
}

// LookupByUDP returns the entry currently bound to a UDP source endpoint,
// or nil if none. Updates LastSeen.
func (m *Manager) LookupByUDP(addr *net.UDPAddr) *Entry {
	m.mu.RLock()
	e := m.byUDPKey[udpKey(addr)]
	m.mu.RUnlock()
	if e != nil {
		e.LastSeen = time.Now()
	}
	return e
}

// LookupByTunIP returns the entry whose inner-IP source has been observed
// at this address, or nil.
func (m *Manager) LookupByTunIP(ip netip.Addr) *Entry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.byTunIP[ip]
}

// LookupByPeer returns the entry for a known static peer key, or nil.
// Used to enforce one-active-session-per-wallet.
func (m *Manager) LookupByPeer(pk [32]byte) *Entry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.byPeer[pk]
}

// BindTunIP records the inner-IP source of an entry the first time we see
// one. Idempotent if the same (entry, ip) pair is bound again.
func (m *Manager) BindTunIP(e *Entry, ip netip.Addr) {
	if !ip.IsValid() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if e.TunIP.IsValid() && e.TunIP != ip {
		delete(m.byTunIP, e.TunIP)
	}
	e.TunIP = ip
	m.byTunIP[ip] = e
}

// RebindUDP updates the entry's last-known UDP address when the underlying
// flow rebinds (NAT timeout, mobile network handoff). Caller passes the
// new address from the most recent transport frame.
func (m *Manager) RebindUDP(e *Entry, addr *net.UDPAddr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	oldKey := udpKey(e.UDPAddr)
	newKey := udpKey(addr)
	if oldKey == newKey {
		return
	}
	delete(m.byUDPKey, oldKey)
	e.UDPAddr = cloneUDPAddr(addr)
	m.byUDPKey[newKey] = e
}

// Remove evicts an entry from every index.
func (m *Manager) Remove(e *Entry) {
	if e == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byUDPKey, udpKey(e.UDPAddr))
	if e.TunIP.IsValid() {
		delete(m.byTunIP, e.TunIP)
	}
	delete(m.byPeer, e.PeerKey)
}

// Count returns the number of live entries (sized off the UDP index).
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.byUDPKey)
}

func udpKey(addr *net.UDPAddr) string {
	if addr == nil {
		return ""
	}
	return addr.String()
}

func cloneUDPAddr(a *net.UDPAddr) *net.UDPAddr {
	if a == nil {
		return nil
	}
	c := *a
	if a.IP != nil {
		c.IP = append(net.IP(nil), a.IP...)
	}
	return &c
}
