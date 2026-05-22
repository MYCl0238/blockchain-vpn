package noise

import (
	"encoding/binary"
	"errors"
)

// Wire envelope for tunnel datagrams:
//
//	byte 0       protocol version  (PV1 = Noise IK)
//	byte 1       frame type        (FrameHandshakeA / FrameHandshakeB / FrameTransport)
//	bytes 2..    body              (frame-type specific)
//
// The server also accepts legacy version 0 datagrams (cleartext, current
// blockchain-vpn protocol) so the rollout is incremental.

const (
	// PVLegacy is the pre-Noise cleartext envelope already in production.
	PVLegacy byte = 0
	// PV1 is the first Noise IK envelope. Currently the only Noise version.
	PV1 byte = 1
)

const (
	FrameHandshakeA byte = 0 // initiator -> responder: e, es, s, ss
	FrameHandshakeB byte = 1 // responder -> initiator: e, ee, se
	FrameTransport  byte = 2 // either direction, AEAD-sealed payload
)

// MarshalHandshakeA encodes a Noise IK msg A onto the wire:
//
//	[ PV1 | FrameHandshakeA | ne(32) | ns(0..) | ciphertext(0..) ]
//
// ne is fixed 32 bytes; ns is the encrypted-static blob (length = 32 + 16
// AEAD tag = 48 bytes when present, 0 when omitted); ciphertext is the
// remaining bytes.
//
// We don't need a length prefix for ns because in the IK pattern its
// length is implied by hasKey state at the time of encryptAndHash — it
// is always 48 bytes for msg A under Noise_IK_25519_ChaChaPoly_BLAKE2s.
func MarshalHandshakeA(m HandshakeMessage) []byte {
	const nsLen = 48 // 32-byte static + 16-byte ChaCha20-Poly1305 tag
	if len(m.StaticEnc) != nsLen {
		// Caller should never produce a non-IK-shaped message here.
		panic("noise: msg A static blob must be 48 bytes")
	}
	out := make([]byte, 0, 2+32+nsLen+len(m.Ciphertext))
	out = append(out, PV1, FrameHandshakeA)
	out = append(out, m.Ephemeral[:]...)
	out = append(out, m.StaticEnc...)
	out = append(out, m.Ciphertext...)
	return out
}

// MarshalHandshakeB encodes a Noise IK msg B onto the wire:
//
//	[ PV1 | FrameHandshakeB | ne(32) | ciphertext(0..) ]
//
// Msg B has no encrypted static, so ns is omitted entirely.
func MarshalHandshakeB(m HandshakeMessage) []byte {
	out := make([]byte, 0, 2+32+len(m.Ciphertext))
	out = append(out, PV1, FrameHandshakeB)
	out = append(out, m.Ephemeral[:]...)
	out = append(out, m.Ciphertext...)
	return out
}

// MarshalTransport encodes an AEAD-sealed transport datagram:
//
//	[ PV1 | FrameTransport | nonce(8B LE) | ciphertext(0..) ]
//
// The explicit nonce on the wire lets the receiver tolerate packet loss
// and reordering on the underlying UDP transport — without it, a single
// dropped packet desyncs the counters and every subsequent frame fails
// AEAD verification. The receiver tracks accepted nonces with a 64-bit
// sliding window (see Session.Decrypt) to also reject replays.
func MarshalTransport(m TransportMessage) []byte {
	out := make([]byte, 0, 2+8+len(m.Ciphertext))
	out = append(out, PV1, FrameTransport)
	out = binary.LittleEndian.AppendUint64(out, m.Nonce)
	out = append(out, m.Ciphertext...)
	return out
}

// ParseFrame splits a received datagram into version + type + body.
// Returns ErrShortFrame if there's no room for the 2-byte header.
func ParseFrame(buf []byte) (version, frameType byte, body []byte, err error) {
	if len(buf) < 2 {
		return 0, 0, nil, ErrShortFrame
	}
	return buf[0], buf[1], buf[2:], nil
}

// ParseHandshakeA decodes the body of a FrameHandshakeA frame back into
// a HandshakeMessage.
func ParseHandshakeA(body []byte) (HandshakeMessage, error) {
	const nsLen = 48
	if len(body) < 32+nsLen {
		return HandshakeMessage{}, ErrShortFrame
	}
	var m HandshakeMessage
	copy(m.Ephemeral[:], body[:32])
	m.StaticEnc = append([]byte(nil), body[32:32+nsLen]...)
	m.Ciphertext = append([]byte(nil), body[32+nsLen:]...)
	return m, nil
}

// ParseHandshakeB decodes the body of a FrameHandshakeB frame.
func ParseHandshakeB(body []byte) (HandshakeMessage, error) {
	if len(body) < 32 {
		return HandshakeMessage{}, ErrShortFrame
	}
	var m HandshakeMessage
	copy(m.Ephemeral[:], body[:32])
	m.Ciphertext = append([]byte(nil), body[32:]...)
	return m, nil
}

// ParseTransport decodes the body of a FrameTransport frame.
func ParseTransport(body []byte) (TransportMessage, error) {
	if len(body) < 8 {
		return TransportMessage{}, ErrShortFrame
	}
	return TransportMessage{
		Nonce:      binary.LittleEndian.Uint64(body[:8]),
		Ciphertext: append([]byte(nil), body[8:]...),
	}, nil
}

// MarshalUint32 / MarshalUint64 small helpers — used in tests for now,
// kept here to give callers stable little-endian sizes if they want to
// stash a session id alongside the wire envelope later.
func MarshalUint32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}

func MarshalUint64(v uint64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, v)
	return b
}

// Errors for the wire codec.
var (
	ErrShortFrame    = errors.New("noise: frame too short")
	ErrUnknownFrame  = errors.New("noise: unknown frame type")
	ErrUnknownVer    = errors.New("noise: unknown protocol version")
)
