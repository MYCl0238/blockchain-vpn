package noise

import (
	"bytes"
	"net"
	"testing"
	"time"
)

// TestUDPRoundtrip exercises the entire wire protocol over real UDP
// loopback sockets:
//
//   - Initiator sends MarshalHandshakeA over UDP.
//   - Responder receives, parses, replies with MarshalHandshakeB.
//   - Initiator parses B and completes the handshake.
//   - Both sides exchange a transport frame each way.
//
// This is the moral equivalent of running tun-server + tun-client without
// the TUN device part, and is the highest-fidelity protocol test we have
// without root/kernel access.
func TestUDPRoundtrip(t *testing.T) {
	prologue := []byte("blockchain-vpn-v1")
	serverKP := GenerateKeypair()
	clientKP := GenerateKeypair()

	// Server side: bind loopback UDP.
	srvAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srvConn, err := net.ListenUDP("udp", srvAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer srvConn.Close()

	// Client side: dial the server.
	cliConn, err := net.DialUDP("udp", nil, srvConn.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer cliConn.Close()

	deadline := time.Now().Add(5 * time.Second)
	_ = srvConn.SetDeadline(deadline)
	_ = cliConn.SetDeadline(deadline)

	// --- Initiator sends msg A. ------------------------------------------
	initiator := NewInitiator(prologue, clientKP, serverKP.Public)
	mA, err := initiator.WriteHandshake([]byte("hello"))
	if err != nil {
		t.Fatalf("WriteHandshake A: %v", err)
	}
	if _, err := cliConn.Write(MarshalHandshakeA(mA)); err != nil {
		t.Fatalf("send A: %v", err)
	}

	// --- Responder reads msg A. ------------------------------------------
	buf := make([]byte, 65535)
	n, cliAddr, err := srvConn.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("server read A: %v", err)
	}
	v, ft, body, err := ParseFrame(buf[:n])
	if err != nil || v != PV1 || ft != FrameHandshakeA {
		t.Fatalf("server parse A: v=%d ft=%d err=%v", v, ft, err)
	}
	parsedA, err := ParseHandshakeA(body)
	if err != nil {
		t.Fatalf("ParseHandshakeA: %v", err)
	}
	responder := NewResponder(prologue, serverKP)
	pl, err := responder.ReadHandshake(parsedA)
	if err != nil {
		t.Fatalf("responder ReadHandshake A: %v", err)
	}
	if string(pl) != "hello" {
		t.Fatalf("A payload: %q", pl)
	}
	if responder.PeerStatic() != clientKP.Public {
		t.Fatalf("responder did not recover client static")
	}

	// --- Responder writes msg B. -----------------------------------------
	mB, err := responder.WriteHandshake(nil)
	if err != nil {
		t.Fatalf("WriteHandshake B: %v", err)
	}
	if _, err := srvConn.WriteToUDP(MarshalHandshakeB(mB), cliAddr); err != nil {
		t.Fatalf("send B: %v", err)
	}

	// --- Initiator reads msg B. ------------------------------------------
	n, err = cliConn.Read(buf)
	if err != nil {
		t.Fatalf("client read B: %v", err)
	}
	v, ft, body, err = ParseFrame(buf[:n])
	if err != nil || v != PV1 || ft != FrameHandshakeB {
		t.Fatalf("client parse B: v=%d ft=%d err=%v", v, ft, err)
	}
	parsedB, err := ParseHandshakeB(body)
	if err != nil {
		t.Fatalf("ParseHandshakeB: %v", err)
	}
	if _, err := initiator.ReadHandshake(parsedB); err != nil {
		t.Fatalf("initiator ReadHandshake B: %v", err)
	}
	if !initiator.HandshakeComplete() || !responder.HandshakeComplete() {
		t.Fatalf("not complete after handshake")
	}

	// --- Transport: client → server. -------------------------------------
	innerPkt := bytes.Repeat([]byte{0x42}, 1300) // pretend inner IP packet
	cT, err := initiator.Encrypt(innerPkt)
	if err != nil {
		t.Fatalf("init Encrypt: %v", err)
	}
	if _, err := cliConn.Write(MarshalTransport(cT)); err != nil {
		t.Fatalf("send transport: %v", err)
	}
	n, _, err = srvConn.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("server read transport: %v", err)
	}
	v, ft, body, _ = ParseFrame(buf[:n])
	if v != PV1 || ft != FrameTransport {
		t.Fatalf("expected FrameTransport, got v=%d ft=%d", v, ft)
	}
	parsedT, err := ParseTransport(body)
	if err != nil {
		t.Fatalf("ParseTransport: %v", err)
	}
	got, err := responder.Decrypt(parsedT)
	if err != nil {
		t.Fatalf("server Decrypt: %v", err)
	}
	if !bytes.Equal(got, innerPkt) {
		t.Fatalf("transport mismatch client→server")
	}

	// --- Transport: server → client (reply path). -----------------------
	reply := []byte("ack — packet received")
	sT, err := responder.Encrypt(reply)
	if err != nil {
		t.Fatalf("resp Encrypt: %v", err)
	}
	if _, err := srvConn.WriteToUDP(MarshalTransport(sT), cliAddr); err != nil {
		t.Fatalf("send reply: %v", err)
	}
	n, err = cliConn.Read(buf)
	if err != nil {
		t.Fatalf("client read reply: %v", err)
	}
	v, ft, body, _ = ParseFrame(buf[:n])
	if v != PV1 || ft != FrameTransport {
		t.Fatalf("reply frame wrong: v=%d ft=%d", v, ft)
	}
	parsedReply, err := ParseTransport(body)
	if err != nil {
		t.Fatalf("ParseTransport reply: %v", err)
	}
	gotReply, err := initiator.Decrypt(parsedReply)
	if err != nil {
		t.Fatalf("init Decrypt reply: %v", err)
	}
	if !bytes.Equal(gotReply, reply) {
		t.Fatalf("reply mismatch: %q vs %q", gotReply, reply)
	}
}

// TestRejectsUnpinnedServer — initiator must fail msg-B verification if
// the server has a different static key than the one the initiator pinned.
// Catches accidental key swap / MITM at the AEAD level.
func TestRejectsUnpinnedServer(t *testing.T) {
	prologue := []byte("p")
	realServer := GenerateKeypair()
	bogusServer := GenerateKeypair()
	client := GenerateKeypair()

	initiator := NewInitiator(prologue, client, bogusServer.Public) // wrong pin
	responder := NewResponder(prologue, realServer)

	mA, _ := initiator.WriteHandshake(nil)
	// Responder will fail at the encrypted-static decryption because the
	// SS mix (DH(initiator e, responder s)) won't match what initiator
	// derived against bogus pubkey.
	if _, err := responder.ReadHandshake(mA); err == nil {
		t.Fatalf("expected responder to reject msg A built with wrong pin")
	}
}
