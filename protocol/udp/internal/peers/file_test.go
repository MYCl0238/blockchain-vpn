package peers

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestFileAllowlistRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.list")

	k1 := [32]byte{}
	k2 := [32]byte{}
	for i := range k1 {
		k1[i] = byte(i)
		k2[i] = byte(i ^ 0xFF)
	}
	content := []byte(
		"# comment\n" +
			hex.EncodeToString(k1[:]) + "\n" +
			"\n" +
			hex.EncodeToString(k2[:]) + "\n",
	)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}

	a, err := NewFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if a.Count() != 2 {
		t.Fatalf("expected 2 keys, got %d", a.Count())
	}
	if !a.Allow(k1) || !a.Allow(k2) {
		t.Fatalf("both keys must be allowed")
	}
	var stranger [32]byte
	stranger[0] = 0xAB
	if a.Allow(stranger) {
		t.Fatalf("stranger key must NOT be allowed")
	}

	// Reload after removing k2.
	if err := os.WriteFile(path, []byte(hex.EncodeToString(k1[:])+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.Reload(path); err != nil {
		t.Fatal(err)
	}
	if a.Count() != 1 || !a.Allow(k1) || a.Allow(k2) {
		t.Fatalf("reload didn't take effect")
	}
}

func TestFileAllowlistRejectsBadHex(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.list")
	if err := os.WriteFile(path, []byte("not-hex\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFile(path); err == nil {
		t.Fatalf("expected parse error")
	}
}

func TestFileAllowlistRejectsWrongLength(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "short.list")
	if err := os.WriteFile(path, []byte("00010203\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFile(path); err == nil {
		t.Fatalf("expected length error")
	}
}
