package keystore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateStaticRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server-static.key")

	kp1, created, err := LoadOrCreateStatic(path)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if !created {
		t.Fatalf("expected created=true on first call")
	}

	// Files must exist with expected sizes.
	if info, err := os.Stat(path); err != nil || info.Size() != 32 {
		t.Fatalf("private key file: %v size=%d", err, info.Size())
	}
	pubHexPath := path + ".pub.hex"
	if info, err := os.Stat(pubHexPath); err != nil || info.Size() != 65 { // 64 hex + newline
		t.Fatalf("pub.hex file: %v size=%d", err, info.Size())
	}

	// Second call must return the same keypair.
	kp2, created, err := LoadOrCreateStatic(path)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if created {
		t.Fatalf("expected created=false on second call")
	}
	if kp1.Public != kp2.Public || kp1.Private != kp2.Private {
		t.Fatalf("keypair changed on reload")
	}

	// PublicKeyHex round-trip.
	if PublicKeyHex(kp1) == "" || len(PublicKeyHex(kp1)) != 64 {
		t.Fatalf("bad pubkey hex: %q", PublicKeyHex(kp1))
	}
}

func TestLoadOrCreateStaticBadSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "garbage.key")
	if err := os.WriteFile(path, []byte("too short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadOrCreateStatic(path); err == nil {
		t.Fatalf("expected size-check error")
	}
}
