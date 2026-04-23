package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"time"

	"blockchain-vpn/protocol/udp/internal/proto"
)

type MsgHello struct {
	Type        string `json:"type"`
	ClientPub   string `json:"clientPub"`
	ClientNonce string `json:"clientNonce"`
	Auth        string `json:"auth"`
}

type MsgHelloAck struct {
	Type      string `json:"type"`
	ServerPub string `json:"serverPub"`
	Salt      string `json:"salt"`
}

type MsgData struct {
	Type  string `json:"type"`
	Seq   int    `json:"seq"`
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
	Tag   string `json:"tag"`
}

type sessionKeys struct {
	txKey []byte
	rxKey []byte
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func getenvInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

func handshake(conn *net.UDPConn, psk string) (*sessionKeys, error) {
	curve := ecdh.X25519()
	clientPriv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}

	clientPubB64 := base64.StdEncoding.EncodeToString(clientPriv.PublicKey().Bytes())
	nonceBytes, err := proto.RandomBytes(12)
	if err != nil {
		return nil, err
	}
	clientNonce := fmt.Sprintf("%x", nonceBytes)
	auth := proto.HMACHex(psk, clientPubB64+"."+clientNonce)

	hello := MsgHello{Type: "hello", ClientPub: clientPubB64, ClientNonce: clientNonce, Auth: auth}
	hb, _ := json.Marshal(hello)
	if _, err := conn.Write(hb); err != nil {
		return nil, err
	}

	_ = conn.SetReadDeadline(time.Now().Add(8 * time.Second))
	buf := make([]byte, 65535)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	_ = conn.SetReadDeadline(time.Time{})

	var ack MsgHelloAck
	if err := json.Unmarshal(buf[:n], &ack); err != nil {
		return nil, err
	}
	if ack.Type != "hello_ack" {
		return nil, fmt.Errorf("bad hello ack: %s", string(buf[:n]))
	}

	serverPubRaw, err := base64.StdEncoding.DecodeString(ack.ServerPub)
	if err != nil {
		return nil, err
	}
	serverPub, err := curve.NewPublicKey(serverPubRaw)
	if err != nil {
		return nil, err
	}
	shared, err := clientPriv.ECDH(serverPub)
	if err != nil {
		return nil, err
	}
	salt, err := base64.StdEncoding.DecodeString(ack.Salt)
	if err != nil {
		return nil, err
	}
	rxKey, err := proto.HKDF32(shared, salt, "vpnd-proto/server-tx")
	if err != nil {
		return nil, err
	}
	txKey, err := proto.HKDF32(shared, salt, "vpnd-proto/server-rx")
	if err != nil {
		return nil, err
	}

	return &sessionKeys{txKey: txKey, rxKey: rxKey}, nil
}

func sendPing(conn *net.UDPConn, keys *sessionKeys, seq int, clientID string) error {
	body := map[string]any{
		"kind":     "ping",
		"clientId": clientID,
		"ts":       time.Now().UTC().Format(time.RFC3339Nano),
	}
	bb, _ := json.Marshal(body)
	aad := []byte(fmt.Sprintf("seq:%d", seq))
	on, oct, otag, err := proto.EncryptAEAD(keys.txKey, aad, bb)
	if err != nil {
		return err
	}

	data := MsgData{Type: "data", Seq: seq, Nonce: base64.StdEncoding.EncodeToString(on), CT: base64.StdEncoding.EncodeToString(oct), Tag: base64.StdEncoding.EncodeToString(otag)}
	db, _ := json.Marshal(data)
	if _, err := conn.Write(db); err != nil {
		return err
	}

	_ = conn.SetReadDeadline(time.Now().Add(8 * time.Second))
	buf := make([]byte, 65535)
	n, err := conn.Read(buf)
	if err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Time{})

	var dataAck MsgData
	if err := json.Unmarshal(buf[:n], &dataAck); err != nil {
		return err
	}
	if dataAck.Type != "data_ack" {
		return fmt.Errorf("bad data ack: %s", string(buf[:n]))
	}

	an, err := base64.StdEncoding.DecodeString(dataAck.Nonce)
	if err != nil {
		return err
	}
	act, err := base64.StdEncoding.DecodeString(dataAck.CT)
	if err != nil {
		return err
	}
	atag, err := base64.StdEncoding.DecodeString(dataAck.Tag)
	if err != nil {
		return err
	}
	_, err = proto.DecryptAEAD(keys.rxKey, []byte(fmt.Sprintf("seq:%d", dataAck.Seq)), an, act, atag)
	if err != nil {
		return err
	}
	return nil
}

func runOnce(host string, port int, psk, bind, clientID string, interval time.Duration) error {
	raddr, err := net.ResolveUDPAddr("udp4", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return err
	}
	laddr, err := net.ResolveUDPAddr("udp4", bind)
	if err != nil {
		return err
	}
	conn, err := net.DialUDP("udp4", laddr, raddr)
	if err != nil {
		return err
	}
	defer conn.Close()

	keys, err := handshake(conn, psk)
	if err != nil {
		return err
	}
	log.Printf("[target-worker] handshake ok => %s", raddr.String())

	seq := 0
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := sendPing(conn, keys, seq, clientID); err != nil {
			return err
		}
		log.Printf("[target-worker] keepalive ok seq=%d", seq)
		seq++
		<-ticker.C
	}
}

func main() {
	host := getenv("PROTO_SERVER_HOST", "127.0.0.1")
	port := getenvInt("PROTO_SERVER_PORT", 7000)
	psk := os.Getenv("PROTO_PSK")
	bind := getenv("PROTO_BIND", ":0")
	clientID := getenv("PROTO_CLIENT_ID", "target-worker")
	intervalMs := getenvInt("PROTO_KEEPALIVE_MS", 10000)
	reconnectMs := getenvInt("PROTO_RECONNECT_MS", 3000)

	if psk == "" {
		log.Fatal("PROTO_PSK is required")
	}

	interval := time.Duration(intervalMs) * time.Millisecond
	reconnect := time.Duration(reconnectMs) * time.Millisecond

	log.Printf("[target-worker] starting clientId=%s server=%s:%d bind=%s", clientID, host, port, bind)
	for {
		if err := runOnce(host, port, psk, bind, clientID, interval); err != nil {
			log.Printf("[target-worker] disconnected: %v", err)
			log.Printf("[target-worker] reconnecting in %s", reconnect)
			time.Sleep(reconnect)
		}
	}
}
