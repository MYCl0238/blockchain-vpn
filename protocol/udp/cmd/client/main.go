package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"blockchain-vpn/protocol/udp/internal/proto"
)

type MsgHello struct {
	Type       string `json:"type"`
	ClientPub  string `json:"clientPub"`
	ClientNonce string `json:"clientNonce"`
	Auth       string `json:"auth"`
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

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" { return v }
	return d
}
func getenvInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil { return n }
	}
	return d
}

func main() {
	host := getenv("PROTO_SERVER_HOST", "127.0.0.1")
	port := getenvInt("PROTO_SERVER_PORT", 7000)
	psk := os.Getenv("PROTO_PSK")
	if psk == "" {
		fmt.Println("PROTO_PSK is required")
		os.Exit(1)
	}

	raddr, _ := net.ResolveUDPAddr("udp4", fmt.Sprintf("%s:%d", host, port))
	conn, _ := net.DialUDP("udp4", nil, raddr)
	defer conn.Close()

	curve := ecdh.X25519()
	clientPriv, _ := curve.GenerateKey(rand.Reader)
	clientPubB64 := base64.StdEncoding.EncodeToString(clientPriv.PublicKey().Bytes())
	nonceBytes, _ := proto.RandomBytes(12)
	clientNonce := fmt.Sprintf("%x", nonceBytes)
	auth := proto.HMACHex(psk, clientPubB64+"."+clientNonce)

	hello := MsgHello{Type: "hello", ClientPub: clientPubB64, ClientNonce: clientNonce, Auth: auth}
	hb, _ := json.Marshal(hello)
	conn.Write(hb)

	buf := make([]byte, 65535)
	n, _ := conn.Read(buf)
	var ack MsgHelloAck
	json.Unmarshal(buf[:n], &ack)
	if ack.Type != "hello_ack" {
		fmt.Printf("[blockchain-vpnd-client] bad hello ack: %s\n", string(buf[:n]))
		os.Exit(1)
	}

	serverPubRaw, _ := base64.StdEncoding.DecodeString(ack.ServerPub)
	serverPub, _ := curve.NewPublicKey(serverPubRaw)
	shared, _ := clientPriv.ECDH(serverPub)
	salt, _ := base64.StdEncoding.DecodeString(ack.Salt)
	rxKey, _ := proto.HKDF32(shared, salt, "vpnd-proto/server-tx")
	txKey, _ := proto.HKDF32(shared, salt, "vpnd-proto/server-rx")

	body := map[string]any{"kind": "ping", "ts": time.Now().UTC().Format(time.RFC3339Nano)}
	bb, _ := json.Marshal(body)
	seq := 0
	aad := []byte(fmt.Sprintf("seq:%d", seq))
	on, oct, otag, _ := proto.EncryptAEAD(txKey, aad, bb)

	data := MsgData{Type: "data", Seq: seq, Nonce: base64.StdEncoding.EncodeToString(on), CT: base64.StdEncoding.EncodeToString(oct), Tag: base64.StdEncoding.EncodeToString(otag)}
	db, _ := json.Marshal(data)
	conn.Write(db)

	n, _ = conn.Read(buf)
	var dataAck MsgData
	json.Unmarshal(buf[:n], &dataAck)
	if dataAck.Type != "data_ack" {
		fmt.Printf("[blockchain-vpnd-client] bad data ack: %s\n", string(buf[:n]))
		os.Exit(1)
	}

	an, _ := base64.StdEncoding.DecodeString(dataAck.Nonce)
	act, _ := base64.StdEncoding.DecodeString(dataAck.CT)
	atag, _ := base64.StdEncoding.DecodeString(dataAck.Tag)
	plain, err := proto.DecryptAEAD(rxKey, []byte(fmt.Sprintf("seq:%d", dataAck.Seq)), an, act, atag)
	if err != nil {
		fmt.Printf("[blockchain-vpnd-client] decrypt error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[blockchain-vpnd-client] server reply: %s\n", string(plain))
}
