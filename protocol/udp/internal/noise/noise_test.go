package noise

import (
	"bytes"
	"testing"
)

// TestIKHandshakeRoundtrip exercises a full Noise IK handshake +
// bidirectional transport between two in-process sessions. This is the
// thing the rest of the codebase will depend on.
func TestIKHandshakeRoundtrip(t *testing.T) {
	prologue := []byte("blockchain-vpn-v1")
	server := GenerateKeypair()
	client := GenerateKeypair()

	initiator := NewInitiator(prologue, client, server.Public)
	responder := NewResponder(prologue, server)

	// Msg A: initiator -> responder.
	msgA, err := initiator.WriteHandshake([]byte("hello server"))
	if err != nil {
		t.Fatalf("WriteHandshake A: %v", err)
	}
	gotAPayload, err := responder.ReadHandshake(msgA)
	if err != nil {
		t.Fatalf("ReadHandshake A: %v", err)
	}
	if string(gotAPayload) != "hello server" {
		t.Fatalf("A payload mismatch: %q", gotAPayload)
	}
	if responder.PeerStatic() != client.Public {
		t.Fatalf("responder did not learn client static")
	}

	// Msg B: responder -> initiator.
	msgB, err := responder.WriteHandshake([]byte("hi client"))
	if err != nil {
		t.Fatalf("WriteHandshake B: %v", err)
	}
	gotBPayload, err := initiator.ReadHandshake(msgB)
	if err != nil {
		t.Fatalf("ReadHandshake B: %v", err)
	}
	if string(gotBPayload) != "hi client" {
		t.Fatalf("B payload mismatch: %q", gotBPayload)
	}

	if !initiator.HandshakeComplete() || !responder.HandshakeComplete() {
		t.Fatalf("handshake not complete (init=%v resp=%v)",
			initiator.HandshakeComplete(), responder.HandshakeComplete())
	}

	// Transport phase: a few packets each way.
	for i, pt := range [][]byte{
		[]byte("first inner packet"),
		[]byte(""),
		bytes.Repeat([]byte{0xAB}, 1300),
	} {
		ct, err := initiator.Encrypt(pt)
		if err != nil {
			t.Fatalf("init Encrypt[%d]: %v", i, err)
		}
		got, err := responder.Decrypt(ct)
		if err != nil {
			t.Fatalf("resp Decrypt[%d]: %v", i, err)
		}
		if !bytes.Equal(got, pt) {
			t.Fatalf("init->resp[%d] mismatch", i)
		}
	}
	for i, pt := range [][]byte{
		[]byte("reply"),
		bytes.Repeat([]byte{0x55}, 800),
	} {
		ct, err := responder.Encrypt(pt)
		if err != nil {
			t.Fatalf("resp Encrypt[%d]: %v", i, err)
		}
		got, err := initiator.Decrypt(ct)
		if err != nil {
			t.Fatalf("init Decrypt[%d]: %v", i, err)
		}
		if !bytes.Equal(got, pt) {
			t.Fatalf("resp->init[%d] mismatch", i)
		}
	}
}

// TestIKBulkTransport sends 1000 transport frames in each direction.
// If decryption ever fails, the nonce counters have desynced.
func TestIKBulkTransport(t *testing.T) {
	prologue := []byte("bulk")
	initiator := NewInitiator(prologue, GenerateKeypair(), GenerateKeypair().Public)
	// Need consistent server kp for IK; do it explicitly:
	srv := GenerateKeypair()
	cli := GenerateKeypair()
	initiator = NewInitiator(prologue, cli, srv.Public)
	responder := NewResponder(prologue, srv)

	mA, _ := initiator.WriteHandshake(nil)
	if _, err := responder.ReadHandshake(mA); err != nil {
		t.Fatal(err)
	}
	mB, _ := responder.WriteHandshake(nil)
	if _, err := initiator.ReadHandshake(mB); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 1000; i++ {
		pt := []byte{byte(i), byte(i >> 8), 0xff}
		ct, err := initiator.Encrypt(pt)
		if err != nil {
			t.Fatalf("init Encrypt[%d]: %v", i, err)
		}
		got, err := responder.Decrypt(ct)
		if err != nil {
			t.Fatalf("resp Decrypt[%d]: %v (initiator nonce path desynced from responder)", i, err)
		}
		if got[0] != pt[0] || got[1] != pt[1] {
			t.Fatalf("mismatch[%d]: %x vs %x", i, got, pt)
		}
		// Also reply path:
		rt, _ := responder.Encrypt(pt)
		got2, err := initiator.Decrypt(rt)
		if err != nil {
			t.Fatalf("init Decrypt[%d]: %v", i, err)
		}
		_ = got2
	}
}

// TestIKReplayWindowTolerance proves the windowed receiver survives the
// real-world UDP failure modes: packet loss, reordering, and replays.
// Without the window, a single dropped packet wedges the session and
// every subsequent decrypt fails AEAD — that was the bug observed in
// production when the tun-client encountered any WiFi loss.
func TestIKReplayWindowTolerance(t *testing.T) {
	prologue := []byte("window")
	srv := GenerateKeypair()
	cli := GenerateKeypair()
	initiator := NewInitiator(prologue, cli, srv.Public)
	responder := NewResponder(prologue, srv)
	mA, _ := initiator.WriteHandshake(nil)
	_, _ = responder.ReadHandshake(mA)
	mB, _ := responder.WriteHandshake(nil)
	_, _ = initiator.ReadHandshake(mB)

	// Build 200 sealed transport frames in order. The TX side is always
	// monotonic; reordering happens at the wire.
	frames := make([]TransportMessage, 200)
	for i := range frames {
		ct, err := initiator.Encrypt([]byte{byte(i), byte(i >> 8)})
		if err != nil {
			t.Fatalf("Encrypt[%d]: %v", i, err)
		}
		frames[i] = ct
	}

	// Deliver to the responder out of order: shuffle within sliding chunks
	// of 32 (smaller than the 64-bit window), simulating reorder on lossy
	// WiFi. Drop every 17th frame entirely.
	delivered := 0
	for chunkStart := 0; chunkStart < len(frames); chunkStart += 32 {
		chunkEnd := chunkStart + 32
		if chunkEnd > len(frames) {
			chunkEnd = len(frames)
		}
		// Reverse the chunk to maximize out-of-order delivery.
		for i := chunkEnd - 1; i >= chunkStart; i-- {
			if i%17 == 0 {
				continue // simulate drop
			}
			pt, err := responder.Decrypt(frames[i])
			if err != nil {
				t.Fatalf("Decrypt frame %d (chunk-reverse delivery): %v", i, err)
			}
			if pt[0] != byte(i) || pt[1] != byte(i>>8) {
				t.Fatalf("frame %d plaintext mismatch", i)
			}
			delivered++
		}
	}
	if delivered == 0 {
		t.Fatal("nothing delivered")
	}

	// Replays of already-accepted frames must be rejected. Pick frame 5,
	// which we already accepted, and try again.
	if _, err := responder.Decrypt(frames[5]); err == nil {
		t.Fatal("expected replay of frame 5 to be rejected")
	}

	// Frames far in the past (more than 64 below highest) must be rejected.
	// Frame 0 should be too old by now (highest accepted is ~199).
	if _, err := responder.Decrypt(frames[0]); err == nil {
		t.Fatal("expected ancient frame 0 to be rejected as out-of-window")
	}
}

// TestIKTamperRejection — flip a byte in a transport ciphertext and the
// receiver must refuse to decrypt. Sanity-checks ChaCha20-Poly1305
// integrity through the wrapper.
func TestIKTamperRejection(t *testing.T) {
	prologue := []byte("p")
	server := GenerateKeypair()
	client := GenerateKeypair()
	initiator := NewInitiator(prologue, client, server.Public)
	responder := NewResponder(prologue, server)
	msgA, _ := initiator.WriteHandshake(nil)
	_, _ = responder.ReadHandshake(msgA)
	msgB, _ := responder.WriteHandshake(nil)
	_, _ = initiator.ReadHandshake(msgB)

	ct, err := initiator.Encrypt([]byte("don't tamper with me"))
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	// flip a byte
	ct.Ciphertext[0] ^= 0x01
	if _, err := responder.Decrypt(ct); err != ErrAEADFailure {
		t.Fatalf("expected ErrAEADFailure on tampered ct, got %v", err)
	}
}

// TestWireMarshalRoundtrip — MarshalHandshakeA/B/Transport should be
// inverses of ParseFrame + ParseHandshake*/ParseTransport.
func TestWireMarshalRoundtrip(t *testing.T) {
	prologue := []byte("wire-test")
	server := GenerateKeypair()
	client := GenerateKeypair()
	initiator := NewInitiator(prologue, client, server.Public)
	responder := NewResponder(prologue, server)

	msgA, err := initiator.WriteHandshake([]byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	wireA := MarshalHandshakeA(msgA)
	if wireA[0] != PV1 || wireA[1] != FrameHandshakeA {
		t.Fatalf("wireA header wrong: %x %x", wireA[0], wireA[1])
	}
	v, ft, body, err := ParseFrame(wireA)
	if err != nil || v != PV1 || ft != FrameHandshakeA {
		t.Fatalf("ParseFrame A: %v %x %x", err, v, ft)
	}
	parsedA, err := ParseHandshakeA(body)
	if err != nil {
		t.Fatalf("ParseHandshakeA: %v", err)
	}
	pt, err := responder.ReadHandshake(parsedA)
	if err != nil || string(pt) != "hi" {
		t.Fatalf("ReadHandshake A: %v %q", err, pt)
	}

	msgB, err := responder.WriteHandshake(nil)
	if err != nil {
		t.Fatal(err)
	}
	wireB := MarshalHandshakeB(msgB)
	v, ft, body, _ = ParseFrame(wireB)
	if v != PV1 || ft != FrameHandshakeB {
		t.Fatalf("wireB header wrong")
	}
	parsedB, _ := ParseHandshakeB(body)
	if _, err := initiator.ReadHandshake(parsedB); err != nil {
		t.Fatalf("ReadHandshake B: %v", err)
	}

	ct, err := initiator.Encrypt([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	wireT := MarshalTransport(ct)
	v, ft, body, _ = ParseFrame(wireT)
	if v != PV1 || ft != FrameTransport {
		t.Fatalf("wireT header wrong")
	}
	parsedT, perr := ParseTransport(body)
	if perr != nil {
		t.Fatalf("ParseTransport: %v", perr)
	}
	got, err := responder.Decrypt(parsedT)
	if err != nil || string(got) != "payload" {
		t.Fatalf("transport roundtrip: %v %q", err, got)
	}
}

// TestDeriveStaticDeterministic — same input signature must yield the
// same Noise keypair. This is the property we rely on to give a wallet
// the same identity across devices.
func TestDeriveStaticDeterministic(t *testing.T) {
	sig := make([]byte, 65)
	for i := range sig {
		sig[i] = byte(i)
	}
	a, err := DeriveStaticFromSignature(sig)
	if err != nil {
		t.Fatal(err)
	}
	b, err := DeriveStaticFromSignature(sig)
	if err != nil {
		t.Fatal(err)
	}
	if a.Private != b.Private || a.Public != b.Public {
		t.Fatalf("derivation not deterministic")
	}

	// Different signature must produce a different key.
	sig[0] ^= 0x01
	c, err := DeriveStaticFromSignature(sig)
	if err != nil {
		t.Fatal(err)
	}
	if a.Public == c.Public {
		t.Fatalf("different sigs produced same pubkey")
	}

	if _, err := DeriveStaticFromSignature(sig[:10]); err != ErrShortSignature {
		t.Fatalf("expected ErrShortSignature, got %v", err)
	}
}

// TestDerivedKeyUsableForHandshake — make sure a key derived from a
// signature actually works as a Noise IK static identity end-to-end.
func TestDerivedKeyUsableForHandshake(t *testing.T) {
	sig := make([]byte, 65)
	for i := range sig {
		sig[i] = byte(0xC0 ^ i)
	}
	client, err := DeriveStaticFromSignature(sig)
	if err != nil {
		t.Fatal(err)
	}
	server := GenerateKeypair()

	initiator := NewInitiator([]byte("p"), client, server.Public)
	responder := NewResponder([]byte("p"), server)

	msgA, _ := initiator.WriteHandshake(nil)
	if _, err := responder.ReadHandshake(msgA); err != nil {
		t.Fatalf("ReadHandshake A: %v", err)
	}
	msgB, _ := responder.WriteHandshake(nil)
	if _, err := initiator.ReadHandshake(msgB); err != nil {
		t.Fatalf("ReadHandshake B: %v", err)
	}
	ct, err := initiator.Encrypt([]byte("inner packet"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := responder.Decrypt(ct)
	if err != nil || string(got) != "inner packet" {
		t.Fatalf("transport: %v %q", err, got)
	}
}
