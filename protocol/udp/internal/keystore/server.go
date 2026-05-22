// Package keystore loads and persists long-term Noise IK static keypairs.
//
// Server use case: load a 32-byte X25519 private key from a file; generate
// and persist a fresh keypair if the file doesn't exist. The public key
// is written alongside the private key as a hex file so an operator
// (or the webui) can read it without parsing binary.
//
// File layout:
//
//	<keyfile>            32 raw bytes  (private key, mode 0600)
//	<keyfile>.pub.hex    64 hex chars  (public key, mode 0644)
package keystore

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"blockchain-vpn/protocol/udp/internal/noise"
)

// LoadOrCreateStatic returns the static keypair stored at `path`, generating
// a fresh one and writing both files if `path` does not yet exist.
//
// `path` is the private key file. The public key sibling is `<path>.pub.hex`.
func LoadOrCreateStatic(path string) (noise.Keypair, bool, error) {
	if path == "" {
		return noise.Keypair{}, false, errors.New("keystore: empty path")
	}

	priv, err := os.ReadFile(path)
	if err == nil {
		if len(priv) != 32 {
			return noise.Keypair{}, false, fmt.Errorf("keystore: %s is %d bytes, expected 32", path, len(priv))
		}
		var seed [32]byte
		copy(seed[:], priv)
		kp := noise.KeypairFromSeed(seed)

		// Best-effort: rewrite .pub.hex so it always reflects the loaded private key.
		_ = writePubHex(path, kp)
		return kp, false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return noise.Keypair{}, false, fmt.Errorf("keystore: read %s: %w", path, err)
	}

	// Bootstrap a fresh keypair.
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return noise.Keypair{}, false, fmt.Errorf("keystore: mkdir %s: %w", filepath.Dir(path), err)
	}
	kp := noise.GenerateKeypair()

	if err := writePrivateAtomic(path, kp.Private[:]); err != nil {
		return noise.Keypair{}, false, err
	}
	if err := writePubHex(path, kp); err != nil {
		return noise.Keypair{}, false, err
	}
	return kp, true, nil
}

// PublicKeyHex returns the hex-encoded 32-byte public key for a keypair.
func PublicKeyHex(kp noise.Keypair) string { return hex.EncodeToString(kp.Public[:]) }

func writePrivateAtomic(path string, raw []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("keystore: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("keystore: rename: %w", err)
	}
	return nil
}

func writePubHex(path string, kp noise.Keypair) error {
	pubPath := path + ".pub.hex"
	hexStr := hex.EncodeToString(kp.Public[:]) + "\n"
	if err := os.WriteFile(pubPath, []byte(hexStr), 0o644); err != nil {
		return fmt.Errorf("keystore: write %s: %w", pubPath, err)
	}
	return nil
}
