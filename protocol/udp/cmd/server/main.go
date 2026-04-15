package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"blockchain-vpn/protocol/udp/internal/proto"
)

type Session struct {
	TxKey, RxKey   []byte
	SeqIn, SeqOut  int
	LastSeen       time.Time
	RxBytes, TxBytes int
}

type MsgHello struct {
	Type       string `json:"type"`
	ClientPub  string `json:"clientPub"`
	ClientNonce string `json:"clientNonce"`
	Auth       string `json:"auth"`
}

type MsgHelloAck struct {
	Type         string `json:"type"`
	ServerPub    string `json:"serverPub"`
	Salt         string `json:"salt"`
	SessionTtlMs int64  `json:"sessionTtlMs"`
}

type MsgData struct {
	Type  string `json:"type"`
	Seq   int    `json:"seq"`
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
	Tag   string `json:"tag"`
}

type MsgError struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

type KeepalivePayload struct {
	SessionID string                 `json:"sessionId"`
	State     string                 `json:"state"`
	RxBytes   int                    `json:"rxBytes"`
	TxBytes   int                    `json:"txBytes"`
	Meta      map[string]interface{} `json:"meta"`
}

var (
	host       = getenv("PROTO_HOST", "0.0.0.0")
	port       = getenvInt("PROTO_PORT", 7000)
	psk        = os.Getenv("PROTO_PSK")
	sessionTTL = time.Duration(getenvInt("PROTO_SESSION_TTL_MS", 300000)) * time.Millisecond
	apiURL     = os.Getenv("BVPN_API_URL")
	apiToken   = os.Getenv("BVPN_API_TOKEN")

	sessions = map[string]*Session{}
	mu       sync.Mutex
)

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func getenvInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil {
			return n
		}
	}
	return d
}

func sendJSON(conn *net.UDPConn, addr *net.UDPAddr, v any) {
	b, _ := json.Marshal(v)
	conn.WriteToUDP(b, addr)
}

func emit(path string, payload any) {
	if apiURL == "" {
		return
	}
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", apiURL+path, bytes.NewReader(b))
	req.Header.Set("content-type", "application/json")
	if apiToken != "" {
		req.Header.Set("authorization", "Bearer "+apiToken)
	}
	client := &http.Client{Timeout: 1200 * time.Millisecond}
	resp, err := client.Do(req)
	if err == nil && resp != nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

func main() {
	if psk == "" {
		log.Fatal("PROTO_PSK is required")
	}
	addr, err := net.ResolveUDPAddr("udp4", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		log.Fatal(err)
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	go gcLoop()
	log.Printf("[blockchain-vpnd] listening on %s:%d", host, port)

	buf := make([]byte, 65535)
	for {
		n, raddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			continue
		}
		payload := append([]byte{}, buf[:n]...)
		go handlePacket(conn, raddr, payload)
	}
}

func gcLoop() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for range t.C {
		mu.Lock()
		now := time.Now()
		for k, s := range sessions {
			if now.Sub(s.LastSeen) > sessionTTL {
				delete(sessions, k)
				emit("/v1/proto/events", map[string]any{"level": "info", "event": "session_expired", "sessionId": k})
			}
		}
		mu.Unlock()
	}
}

func handlePacket(conn *net.UDPConn, raddr *net.UDPAddr, payload []byte) {
	var envelope map[string]any
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return
	}
	t, _ := envelope["type"].(string)
	if t == "hello" {
		handleHello(conn, raddr, payload)
		return
	}
	if t == "data" {
		handleData(conn, raddr, payload)
	}
}

func handleHello(conn *net.UDPConn, raddr *net.UDPAddr, payload []byte) {
	var h MsgHello
	if err := json.Unmarshal(payload, &h); err != nil {
		return
	}
	signed := h.ClientPub + "." + h.ClientNonce
	expected := proto.HMACHex(psk, signed)
	if !proto.EqualHex(h.Auth, expected) {
		sendJSON(conn, raddr, MsgError{Type: "error", Reason: "auth_failed"})
		emit("/v1/proto/events", map[string]any{"level": "warn", "event": "auth_failed", "sessionId": raddr.String()})
		return
	}

	curve := ecdh.X25519()
	serverPriv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		sendJSON(conn, raddr, MsgError{Type: "error", Reason: "internal_keygen_failed"})
		return
	}
	clientPubRaw, err := base64.StdEncoding.DecodeString(h.ClientPub)
	if err != nil {
		sendJSON(conn, raddr, MsgError{Type: "error", Reason: "bad_client_key"})
		return
	}
	clientPub, err := curve.NewPublicKey(clientPubRaw)
	if err != nil {
		sendJSON(conn, raddr, MsgError{Type: "error", Reason: "bad_client_key"})
		return
	}
	shared, err := serverPriv.ECDH(clientPub)
	if err != nil {
		sendJSON(conn, raddr, MsgError{Type: "error", Reason: "ecdh_failed"})
		return
	}

	salt, _ := proto.RandomBytes(16)
	txKey, _ := proto.HKDF32(shared, salt, "vpnd-proto/server-tx")
	rxKey, _ := proto.HKDF32(shared, salt, "vpnd-proto/server-rx")

	mu.Lock()
	sessions[raddr.String()] = &Session{TxKey: txKey, RxKey: rxKey, SeqIn: -1, SeqOut: 0, LastSeen: time.Now()}
	mu.Unlock()

	ack := MsgHelloAck{
		Type:         "hello_ack",
		ServerPub:    base64.StdEncoding.EncodeToString(serverPriv.PublicKey().Bytes()),
		Salt:         base64.StdEncoding.EncodeToString(salt),
		SessionTtlMs: int64(sessionTTL / time.Millisecond),
	}
	sendJSON(conn, raddr, ack)
	emit("/v1/proto/events", map[string]any{"level": "info", "event": "session_created", "sessionId": raddr.String()})
}

func handleData(conn *net.UDPConn, raddr *net.UDPAddr, payload []byte) {
	var d MsgData
	if err := json.Unmarshal(payload, &d); err != nil {
		return
	}

	mu.Lock()
	s, ok := sessions[raddr.String()]
	if !ok {
		mu.Unlock()
		sendJSON(conn, raddr, MsgError{Type: "error", Reason: "no_session"})
		return
	}
	if d.Seq <= s.SeqIn {
		mu.Unlock()
		return
	}
	nonce, err1 := base64.StdEncoding.DecodeString(d.Nonce)
	ct, err2 := base64.StdEncoding.DecodeString(d.CT)
	tag, err3 := base64.StdEncoding.DecodeString(d.Tag)
	if err1 != nil || err2 != nil || err3 != nil {
		mu.Unlock()
		return
	}
	aad := []byte(fmt.Sprintf("seq:%d", d.Seq))
	plain, err := proto.DecryptAEAD(s.RxKey, aad, nonce, ct, tag)
	if err != nil {
		mu.Unlock()
		sendJSON(conn, raddr, MsgError{Type: "error", Reason: "decrypt_failed"})
		emit("/v1/proto/events", map[string]any{"level": "warn", "event": "decrypt_failed", "sessionId": raddr.String()})
		return
	}
	_ = plain
	s.SeqIn = d.Seq
	s.LastSeen = time.Now()
	s.RxBytes += len(ct)
	outSeq := s.SeqOut
	s.SeqOut++

	reply := map[string]any{"ok": true, "echoType": "ping", "ts": time.Now().UTC().Format(time.RFC3339Nano)}
	replyBytes, _ := json.Marshal(reply)
	outAAD := []byte(fmt.Sprintf("seq:%d", outSeq))
	on, oct, otag, err := proto.EncryptAEAD(s.TxKey, outAAD, replyBytes)
	if err != nil {
		mu.Unlock()
		return
	}
	s.TxBytes += len(oct)
	rxDelta := len(ct)
	txDelta := len(oct)
	seqIn := s.SeqIn
	seqOut := s.SeqOut
	mu.Unlock()

	ack := MsgData{Type: "data_ack", Seq: outSeq, Nonce: base64.StdEncoding.EncodeToString(on), CT: base64.StdEncoding.EncodeToString(oct), Tag: base64.StdEncoding.EncodeToString(otag)}
	sendJSON(conn, raddr, ack)

	emit("/v1/proto/keepalive", KeepalivePayload{SessionID: raddr.String(), State: "active", RxBytes: rxDelta, TxBytes: txDelta, Meta: map[string]any{"seqIn": seqIn, "seqOut": seqOut}})
}
