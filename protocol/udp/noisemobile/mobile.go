// Package noisemobile exposes a gomobile-bind-friendly facade over the
// internal Noise IK library. gomobile can only export functions with a
// small set of types (primitives, []byte, error, opaque struct
// pointers). The wrapper here presents Session as a struct with
// []byte-returning Encrypt/Decrypt and the handshake as
// marshal-friendly []byte returns, so the Android Kotlin caller can
// drive Noise IK without seeing the lower-level HandshakeMessage /
// TransportMessage struct types.
//
// This is a public counterpart to internal/noise — gomobile bind needs
// a non-internal package because it generates a sibling Go module that
// imports the wrapped package by path, and Go's internal-package rule
// would block that import from outside this module.

package noisemobile

import (
	"encoding/hex"
	"errors"

	"blockchain-vpn/protocol/udp/internal/noise"
)

// Session is gomobile-callable. Wraps an *noise.Session and exposes
// wire-serialized helpers. Mirrors what the Linux tun-client does
// inline in its handshake() and read/write loops.
type Session struct {
	inner *noise.Session
}

// NewInitiator builds an initiator session given the 32-byte client
// static private key seed, the 32-byte pinned server public key, and
// the prologue bytes. privSeed is the same byte blob the Linux
// tun-client reads from /var/lib/blockchain-vpn/noise-static.key.
func NewInitiator(privSeed []byte, serverPub []byte, prologue []byte) (*Session, error) {
	if len(privSeed) != 32 {
		return nil, errors.New("noisemobile: privSeed must be 32 bytes")
	}
	if len(serverPub) != 32 {
		return nil, errors.New("noisemobile: serverPub must be 32 bytes")
	}
	var seed [32]byte
	copy(seed[:], privSeed)
	clientKP := noise.KeypairFromSeed(seed)
	var srv [32]byte
	copy(srv[:], serverPub)
	return &Session{inner: noise.NewInitiator(prologue, clientKP, srv)}, nil
}

// WriteHandshakeA produces the wire bytes for FrameHandshakeA,
// including the [PV1 | type | ne | ns | ciphertext] envelope so the
// caller can just `socket.send(bytes)`. payload may be nil/empty.
func (s *Session) WriteHandshakeA(payload []byte) ([]byte, error) {
	msg, err := s.inner.WriteHandshake(payload)
	if err != nil {
		return nil, err
	}
	return noise.MarshalHandshakeA(msg), nil
}

// ReadHandshakeB consumes the server's reply (the full FrameHandshakeB
// datagram, starting with PV1 + type byte). After this returns nil the
// session is ready for EncryptTransport/DecryptTransport.
func (s *Session) ReadHandshakeB(wire []byte) error {
	version, frameType, body, err := noise.ParseFrame(wire)
	if err != nil {
		return err
	}
	if version != noise.PV1 {
		return errors.New("noisemobile: unexpected protocol version")
	}
	if frameType != noise.FrameHandshakeB {
		return errors.New("noisemobile: expected FrameHandshakeB")
	}
	msgB, err := noise.ParseHandshakeB(body)
	if err != nil {
		return err
	}
	if _, err := s.inner.ReadHandshake(msgB); err != nil {
		return err
	}
	if !s.inner.HandshakeComplete() {
		return errors.New("noisemobile: handshake did not complete after msg B")
	}
	return nil
}

// HandshakeComplete reports whether transport messages may now flow.
func (s *Session) HandshakeComplete() bool {
	return s.inner.HandshakeComplete()
}

// EncryptTransport seals an inner IP packet into a full FrameTransport
// wire blob ([PV1 | type | nonce | ciphertext+tag]) ready to write to
// the UDP socket.
func (s *Session) EncryptTransport(innerPacket []byte) ([]byte, error) {
	ct, err := s.inner.Encrypt(innerPacket)
	if err != nil {
		return nil, err
	}
	return noise.MarshalTransport(ct), nil
}

// DecryptTransport consumes a full FrameTransport wire blob and returns
// the recovered inner IP packet. Returns an error on bad frame type,
// short frame, or AEAD/replay-window failure.
func (s *Session) DecryptTransport(wire []byte) ([]byte, error) {
	version, frameType, body, err := noise.ParseFrame(wire)
	if err != nil {
		return nil, err
	}
	if version != noise.PV1 || frameType != noise.FrameTransport {
		return nil, errors.New("noisemobile: not a transport frame")
	}
	t, err := noise.ParseTransport(body)
	if err != nil {
		return nil, err
	}
	return s.inner.Decrypt(t)
}

// PublicKeyHex returns the hex-encoded public key matching a 32-byte
// private seed. Used for diagnostic display in the Android UI.
func PublicKeyHex(privSeed []byte) (string, error) {
	if len(privSeed) != 32 {
		return "", errors.New("noisemobile: privSeed must be 32 bytes")
	}
	var seed [32]byte
	copy(seed[:], privSeed)
	kp := noise.KeypairFromSeed(seed)
	return hex.EncodeToString(kp.Public[:]), nil
}

// DeriveSeedFromSignatureHex takes a wallet signature (with or without
// "0x" prefix) and returns the 32-byte X25519 private seed + 32-byte
// public key. Same derivation as the server-side and desktop
// implementations.
type DerivedKey struct {
	Priv []byte
	Pub  []byte
}

func DeriveSeedFromSignatureHex(signatureHex string) (*DerivedKey, error) {
	hexStr := signatureHex
	if len(hexStr) >= 2 && (hexStr[:2] == "0x" || hexStr[:2] == "0X") {
		hexStr = hexStr[2:]
	}
	raw, err := hex.DecodeString(hexStr)
	if err != nil {
		return nil, err
	}
	kp, err := noise.DeriveStaticFromSignature(raw)
	if err != nil {
		return nil, err
	}
	priv := make([]byte, 32)
	pub := make([]byte, 32)
	copy(priv, kp.Private[:])
	copy(pub, kp.Public[:])
	return &DerivedKey{Priv: priv, Pub: pub}, nil
}
