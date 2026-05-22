package peers

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres reads the allowlist from users.noise_public_key, the column
// populated by the webui when a user binds their wallet to a Noise key.
//
// On startup the table is loaded once; afterwards Refresh() can be
// called on a timer (RefreshLoop helper provided) so new bindings show
// up without a tun-server restart.
type Postgres struct {
	pool *pgxpool.Pool

	mu  sync.RWMutex
	set map[[32]byte]struct{}
}

// NewPostgres opens a connection pool against dsn and loads the initial
// allowlist.
func NewPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	if dsn == "" {
		return nil, errors.New("peers: empty postgres dsn")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("peers: parse dsn: %w", err)
	}
	// Keep the pool tiny — tun-server only needs to poll the allowlist.
	cfg.MaxConns = 2
	cfg.MinConns = 1

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("peers: connect: %w", err)
	}
	p := &Postgres{pool: pool, set: map[[32]byte]struct{}{}}
	if err := p.Refresh(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return p, nil
}

// Allow reports whether the given pubkey is in the latest snapshot.
func (p *Postgres) Allow(pk [32]byte) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	_, ok := p.set[pk]
	return ok
}

// Count returns the snapshot size.
func (p *Postgres) Count() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.set)
}

// Refresh re-queries postgres and atomically swaps in the new allowlist.
// A query error leaves the previous snapshot in place.
func (p *Postgres) Refresh(ctx context.Context) error {
	rows, err := p.pool.Query(ctx,
		"SELECT noise_public_key FROM users WHERE noise_public_key IS NOT NULL")
	if err != nil {
		return fmt.Errorf("peers: query: %w", err)
	}
	defer rows.Close()

	next := map[[32]byte]struct{}{}
	for rows.Next() {
		var hexStr string
		if err := rows.Scan(&hexStr); err != nil {
			return fmt.Errorf("peers: scan: %w", err)
		}
		raw, err := hex.DecodeString(strings.TrimSpace(hexStr))
		if err != nil || len(raw) != 32 {
			// Skip malformed rows — log noise only, don't poison the set.
			continue
		}
		var k [32]byte
		copy(k[:], raw)
		next[k] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("peers: rows: %w", err)
	}

	p.mu.Lock()
	p.set = next
	p.mu.Unlock()
	return nil
}

// RefreshLoop polls Refresh on `interval` until ctx is cancelled. Errors
// are sent to `onError` (nil-safe).
func (p *Postgres) RefreshLoop(ctx context.Context, interval time.Duration, onError func(error)) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := p.Refresh(ctx); err != nil && onError != nil {
				onError(err)
			}
		}
	}
}

// Close releases the connection pool.
func (p *Postgres) Close() {
	if p.pool != nil {
		p.pool.Close()
	}
}
