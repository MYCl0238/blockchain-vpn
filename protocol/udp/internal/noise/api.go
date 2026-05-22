package noise

import (
	"crypto/rand"
	"errors"
	"io"
	"math"
)

// Keypair is a Curve25519 long-term static keypair.
type Keypair struct {
	Public  [32]byte
	Private [32]byte
}

// GenerateKeypair returns a fresh random X25519 keypair suitable for use as
// the Noise static identity. Falls back to a panic-on-no-entropy
// (crypto/rand.Read failure) since we cannot safely produce a key otherwise.
func GenerateKeypair() Keypair {
	kp := generateKeypair()
	return Keypair{Public: kp.public_key, Private: kp.private_key}
}

// KeypairFromSeed deterministically derives a static keypair from a 32-byte
// seed. Use this with the wallet-derivation helper in identity.go so the
// same wallet across devices yields the same Noise identity.
func KeypairFromSeed(seed [32]byte) Keypair {
	// curve25519 clamps internally; we just feed the seed as the scalar.
	kp := keypair{private_key: seed}
	kp.public_key = generatePublicKey(kp.private_key)
	if !validatePublicKey(kp.public_key[:]) {
		// Vanishingly unlikely (the seed maps to a small-subgroup or
		// otherwise weak point). Caller should pick a different seed.
		panic("noise: derived public key failed validation; pick a different seed")
	}
	return Keypair{Public: kp.public_key, Private: kp.private_key}
}

// HandshakeMessage is the on-wire payload for one Noise IK handshake step.
//
// The IK pattern emits two handshake messages:
//
//	A (initiator -> responder): e, es, s, ss [+ optional payload]
//	B (responder -> initiator): e, ee, se   [+ optional payload]
//
// After B both sides Split() into two CipherStates for transport.
type HandshakeMessage struct {
	Ephemeral  [32]byte // ne
	StaticEnc  []byte   // ns (encrypted static; empty for msg B)
	Ciphertext []byte   // encrypted payload (and AEAD tag)
}

// TransportMessage carries an encrypted payload after the handshake.
// `Nonce` is included on the wire so receivers tolerate UDP loss /
// reordering via a sliding window.
type TransportMessage struct {
	Nonce      uint64
	Ciphertext []byte
}

// Session wraps a Noise IK handshake/transport state, plus a receive-side
// replay window so the transport survives lossy UDP.
//
// The TX side uses a monotonic counter (cs.n in the wrapped Noise impl)
// and emits the value of that counter on the wire alongside each frame.
//
// The RX side maintains:
//
//	recvLast   = highest nonce accepted so far
//	recvWindow = 64-bit bitmap, bit i set <=> nonce (recvLast - i) accepted
//
// Per WireGuard's RFC-6479-style anti-replay. A frame whose nonce is in
// the window with the corresponding bit already set is a replay and
// rejected without attempting to decrypt.
type Session struct {
	inner noisesession

	// RX replay window — initialized when handshake completes.
	recvLast   uint64
	recvWindow uint64
	recvAny    bool // true once we've accepted at least one frame
}

// NewInitiator builds an initiator session with a known responder static
// key (the IK "rs" — must be pinned in the client out-of-band).
// `prologue` is mixed into the handshake hash. Pass the same prologue on
// both sides — using e.g. a fixed app id "blockchain-vpn-v1" is fine.
func NewInitiator(prologue []byte, s Keypair, rs [32]byte) *Session {
	inner := InitSession(true, prologue, toInnerKeypair(s), rs)
	return &Session{inner: inner}
}

// NewResponder builds a responder session. The responder learns the
// initiator's static key from msg A; pass zero for the unknown peer key.
func NewResponder(prologue []byte, s Keypair) *Session {
	var zero [32]byte
	inner := InitSession(false, prologue, toInnerKeypair(s), zero)
	return &Session{inner: inner}
}

// IsInitiator reports whether this session is the initiator side.
func (s *Session) IsInitiator() bool { return s.inner.i }

// HandshakeComplete reports whether the handshake has finished (both sides
// have processed all handshake messages and derived transport keys).
//
// For Noise IK the initiator completes after it has sent msg A AND
// received msg B; the responder completes after it has received msg A
// AND sent msg B. message counter `mc` reaches 2 after the handshake.
func (s *Session) HandshakeComplete() bool { return s.inner.mc >= 2 }

// PeerStatic returns the peer's long-term static public key. For the
// initiator this is just the rs it was constructed with; for the
// responder it is only populated after readMessageA has run.
func (s *Session) PeerStatic() [32]byte { return s.inner.hs.rs }

// WriteHandshake produces the next outgoing handshake message.
// Returns ErrHandshakeDone after both messages have been written.
func (s *Session) WriteHandshake(payload []byte) (HandshakeMessage, error) {
	if s.inner.mc >= 2 {
		return HandshakeMessage{}, ErrHandshakeDone
	}
	_, mb, err := SendMessage(&s.inner, payload)
	if err != nil {
		return HandshakeMessage{}, err
	}
	return HandshakeMessage{
		Ephemeral:  mb.ne,
		StaticEnc:  mb.ns,
		Ciphertext: mb.ciphertext,
	}, nil
}

// ReadHandshake consumes an incoming handshake message and returns its
// authenticated payload (if any). Errors if the session has already
// completed or if AEAD verification fails.
func (s *Session) ReadHandshake(m HandshakeMessage) ([]byte, error) {
	if s.inner.mc >= 2 {
		return nil, ErrHandshakeDone
	}
	mb := messagebuffer{ne: m.Ephemeral, ns: m.StaticEnc, ciphertext: m.Ciphertext}
	_, pt, ok, err := RecvMessage(&s.inner, &mb)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrAEADFailure
	}
	return pt, nil
}

// Encrypt seals a transport payload with the appropriate sending key
// (cs1 on the initiator, cs2 on the responder). The returned message
// carries the explicit nonce used for AEAD so the peer's windowed
// receiver can tolerate UDP loss/reorder.
func (s *Session) Encrypt(plaintext []byte) (TransportMessage, error) {
	if !s.HandshakeComplete() {
		return TransportMessage{}, ErrNotReady
	}
	cs := s.txCipherState()
	if cs.n == math.MaxUint64 {
		return TransportMessage{}, errors.New("noise: send nonce wrapped")
	}
	nonce := cs.n
	ct := encrypt(cs.k, nonce, nil, plaintext)
	cs.n++
	return TransportMessage{Nonce: nonce, Ciphertext: ct}, nil
}

// Decrypt opens a transport message with the appropriate receiving key.
// Uses the wire nonce + replay window; tolerates loss & reorder; rejects
// replays. Returns ErrAEADFailure on tag mismatch or rejected nonce.
func (s *Session) Decrypt(m TransportMessage) ([]byte, error) {
	if !s.HandshakeComplete() {
		return nil, ErrNotReady
	}
	if !s.replayCheck(m.Nonce) {
		return nil, ErrAEADFailure
	}
	cs := s.rxCipherState()
	ok, _, pt := decrypt(cs.k, m.Nonce, nil, m.Ciphertext)
	if !ok {
		// Don't mark the nonce as seen — let a future, valid frame at the
		// same number through. (Replay-window protection still rejects
		// genuine replays via the bitmap check above.)
		s.replayUndo(m.Nonce)
		return nil, ErrAEADFailure
	}
	return pt, nil
}

// txCipherState returns the CipherState we encrypt with: cs1 for the
// initiator's outbound, cs2 for the responder's outbound.
func (s *Session) txCipherState() *cipherstate {
	if s.inner.i {
		return &s.inner.cs1
	}
	return &s.inner.cs2
}

// rxCipherState returns the CipherState we decrypt with: cs2 for the
// initiator's inbound (= responder's outbound), cs1 for the responder's
// inbound (= initiator's outbound).
func (s *Session) rxCipherState() *cipherstate {
	if s.inner.i {
		return &s.inner.cs2
	}
	return &s.inner.cs1
}

// replayCheck validates an incoming nonce against the sliding window.
// Returns true if the nonce is acceptable AND not a known replay; the
// window state is updated (bit set) as a side effect.
//
// Window math (per RFC 6479, simplified to one 64-bit word):
//
//	if n > recvLast:        shift the window left by (n - recvLast), set bit 0
//	if recvLast - n >= 64:  reject as too old
//	if bit (recvLast - n) set: reject as replay
//	else: set bit (recvLast - n)
func (s *Session) replayCheck(n uint64) bool {
	if !s.recvAny {
		s.recvAny = true
		s.recvLast = n
		s.recvWindow = 1
		return true
	}
	if n > s.recvLast {
		shift := n - s.recvLast
		if shift >= 64 {
			s.recvWindow = 1
		} else {
			s.recvWindow = (s.recvWindow << shift) | 1
		}
		s.recvLast = n
		return true
	}
	// n <= recvLast
	diff := s.recvLast - n
	if diff >= 64 {
		return false // too old
	}
	mask := uint64(1) << diff
	if s.recvWindow&mask != 0 {
		return false // replay
	}
	s.recvWindow |= mask
	return true
}

// replayUndo clears the bit we set in replayCheck — used when AEAD then
// fails, so a later legitimate frame at the same nonce isn't blocked.
func (s *Session) replayUndo(n uint64) {
	if !s.recvAny {
		return
	}
	if n > s.recvLast {
		// We had shifted past it; can't cleanly undo. Leave the window
		// alone — at worst we reject one future legitimate frame at this
		// exact nonce, which won't happen in practice (nonces are
		// monotonic on the wire).
		return
	}
	diff := s.recvLast - n
	if diff >= 64 {
		return
	}
	s.recvWindow &^= uint64(1) << diff
}

func toInnerKeypair(k Keypair) keypair {
	return keypair{public_key: k.Public, private_key: k.Private}
}

// randomBytes fills b with crypto-strong randomness, panicking on error.
// We use it sparingly; most randomness comes from generateKeypair.
func randomBytes(b []byte) {
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic("noise: crypto/rand.Reader failed: " + err.Error())
	}
}

// Errors returned by the wrapper.
var (
	ErrHandshakeDone = errors.New("noise: handshake already complete")
	ErrAEADFailure   = errors.New("noise: AEAD verification failed")
	ErrNotReady      = errors.New("noise: handshake not yet complete")
)
