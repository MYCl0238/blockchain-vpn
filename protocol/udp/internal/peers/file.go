// Package peers exposes the server-side allowlist of permitted Noise IK
// static keys. There are two implementations:
//
//   - File: reads "<hex-pubkey>\n..." from a path on disk, reloadable via
//     ReloadFromFile(). Useful for unit tests and minimal deployments.
//
//   - (future) Postgres: queries users.noise_public_key — drops in via a
//     small interface so tun-server can swap implementations.
//
// The shared Allower interface lives in this file.
package peers

import (
	"bufio"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Allower decides whether a peer presenting a given Noise static public
// key may complete a handshake.
type Allower interface {
	Allow(pubkey [32]byte) bool
}

// File is a Set-backed Allower loaded from a text file. Lines starting
// with '#' and blank lines are ignored. Pubkeys are case-insensitive
// 64-char hex.
type File struct {
	mu  sync.RWMutex
	set map[[32]byte]struct{}
}

// NewFile loads the allowlist from `path`. Returns an Allower with the
// loaded set; reload by calling Reload().
func NewFile(path string) (*File, error) {
	f := &File{set: map[[32]byte]struct{}{}}
	if err := f.Reload(path); err != nil {
		return nil, err
	}
	return f, nil
}

// NewMemory builds an Allower from an in-memory list (test helper).
func NewMemory(keys [][32]byte) *File {
	f := &File{set: map[[32]byte]struct{}{}}
	for _, k := range keys {
		f.set[k] = struct{}{}
	}
	return f
}

// Allow reports whether the given pubkey is in the current allowlist.
func (f *File) Allow(pk [32]byte) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	_, ok := f.set[pk]
	return ok
}

// Count returns the number of allowed peers.
func (f *File) Count() int {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return len(f.set)
}

// Reload re-reads the file. Atomic: a parse error leaves the previous
// set intact.
func (f *File) Reload(path string) error {
	if path == "" {
		return errors.New("peers: empty path")
	}
	fh, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("peers: open %s: %w", path, err)
	}
	defer fh.Close()

	next := map[[32]byte]struct{}{}
	s := bufio.NewScanner(fh)
	lineNo := 0
	for s.Scan() {
		lineNo++
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		raw, err := hex.DecodeString(line)
		if err != nil {
			return fmt.Errorf("peers: %s:%d: invalid hex: %w", path, lineNo, err)
		}
		if len(raw) != 32 {
			return fmt.Errorf("peers: %s:%d: pubkey must be 32 bytes (got %d)", path, lineNo, len(raw))
		}
		var k [32]byte
		copy(k[:], raw)
		next[k] = struct{}{}
	}
	if err := s.Err(); err != nil {
		return fmt.Errorf("peers: read %s: %w", path, err)
	}

	f.mu.Lock()
	f.set = next
	f.mu.Unlock()
	return nil
}
