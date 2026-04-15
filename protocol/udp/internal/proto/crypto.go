package proto

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

func HMACHex(key, payload string) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(payload))
	return hex.EncodeToString(h.Sum(nil))
}

func EqualHex(a, b string) bool {
	ab, errA := hex.DecodeString(a)
	bb, errB := hex.DecodeString(b)
	if errA != nil || errB != nil {
		return false
	}
	return hmac.Equal(ab, bb)
}

func HKDF32(shared, salt []byte, info string) ([]byte, error) {
	r := hkdf.New(sha256.New, shared, salt, []byte(info))
	out := make([]byte, 32)
	if _, err := r.Read(out); err != nil {
		return nil, err
	}
	return out, nil
}

func RandomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return b, err
}

func EncryptAEAD(key, aad, plaintext []byte) (nonce, ct, tag []byte, err error) {
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, nil, nil, err
	}
	nonce, err = RandomBytes(chacha20poly1305.NonceSize)
	if err != nil {
		return nil, nil, nil, err
	}
	sealed := aead.Seal(nil, nonce, plaintext, aad)
	if len(sealed) < chacha20poly1305.Overhead {
		return nil, nil, nil, errors.New("ciphertext too short")
	}
	split := len(sealed) - chacha20poly1305.Overhead
	ct = sealed[:split]
	tag = sealed[split:]
	return nonce, ct, tag, nil
}

func DecryptAEAD(key, aad, nonce, ct, tag []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, err
	}
	sealed := append(append([]byte{}, ct...), tag...)
	return aead.Open(nil, nonce, sealed, aad)
}
