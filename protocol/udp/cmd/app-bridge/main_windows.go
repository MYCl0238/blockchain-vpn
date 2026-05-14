//go:build windows

// blockchain-vpn-app-bridge is the unprivileged Windows client used by the
// UI / native modules to request VPN control operations. It posts a JSON
// request into the bridge spool that blockchain-vpn-app-bridge-service
// (running as SYSTEM) drains, then waits for the matching response and
// prints it to stdout. The shape of the result matches the contract in
// docs/CLIENT_CONTROL_API.md so the same caller code works on Linux and
// Windows.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type bridgeRequest struct {
	RequestID string            `json:"request_id"`
	Command   string            `json:"command"`
	Args      map[string]any    `json:"args"`
	CreatedAt string            `json:"created_at"`
	Caller    map[string]string `json:"caller,omitempty"`
}

func nowIso() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

func newRequestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func bridgeDir() string {
	if v := os.Getenv("BVPN_APP_BRIDGE_DIR"); v != "" {
		return v
	}
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return filepath.Join(programData, "BlockchainVpn", "bridge")
}

func envDuration(name string, def time.Duration) time.Duration {
	if v := os.Getenv(name); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return def
}

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func usage() string {
	return "Usage: blockchain-vpn-app-bridge <command> [args...]\n" +
		"Commands: up down toggle restart status health public-ip is-enabled logs [count]"
}

func parseCommand(args []string) (string, map[string]any, error) {
	if len(args) == 0 {
		return "status", nil, nil
	}
	command := args[0]
	switch command {
	case "up", "down", "toggle", "restart", "status", "health":
		return command, nil, nil
	case "publicIp", "public-ip":
		return "public-ip", nil, nil
	case "isEnabled", "is-enabled":
		return "is-enabled", nil, nil
	case "logs":
		count := 100
		if len(args) >= 2 {
			n, err := strconv.Atoi(args[1])
			if err != nil || n <= 0 {
				return "", nil, fmt.Errorf("logs count must be a positive integer, got %q", args[1])
			}
			count = n
		}
		return "logs", map[string]any{"count": count}, nil
	default:
		return "", nil, fmt.Errorf("unsupported command: %s", command)
	}
}

func emitError(command, code, message string, exit int) {
	payload, _ := json.Marshal(map[string]any{
		"ok":      false,
		"command": command,
		"code":    code,
		"message": message,
	})
	fmt.Fprintln(os.Stderr, string(payload))
	os.Exit(exit)
}

func main() {
	command, args, err := parseCommand(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, usage())
		emitError("unknown", "usage_error", err.Error(), 2)
	}

	base := bridgeDir()
	requestDir := filepath.Join(base, "requests")
	responseDir := filepath.Join(base, "responses")
	statusFile := filepath.Join(base, "status.json")

	// Best-effort directory bootstrap; the service is expected to set the ACLs.
	for _, dir := range []string{base, requestDir, responseDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			emitError(command, "bridge_dir_unavailable", err.Error(), 30)
		}
	}

	requestID, err := newRequestID()
	if err != nil {
		emitError(command, "bridge_error", "could not allocate request id: "+err.Error(), 30)
	}

	req := bridgeRequest{
		RequestID: requestID,
		Command:   command,
		Args:      args,
		CreatedAt: nowIso(),
		Caller: map[string]string{
			"user": os.Getenv("USERNAME"),
			"host": os.Getenv("COMPUTERNAME"),
		},
	}
	body, err := json.Marshal(req)
	if err != nil {
		emitError(command, "bridge_error", "could not marshal request: "+err.Error(), 30)
	}

	requestPath := filepath.Join(requestDir, requestID+".json")
	if err := writeAtomic(requestPath, body); err != nil {
		emitError(command, "bridge_write_failed", err.Error(), 30)
	}

	timeout := envDuration("BVPN_APP_BRIDGE_TIMEOUT_SECS", 15*time.Second)
	poll := envDuration("BVPN_APP_BRIDGE_POLL_SECS", 200*time.Millisecond)

	responsePath := filepath.Join(responseDir, requestID+".json")
	deadline := time.Now().Add(timeout)
	for {
		data, err := os.ReadFile(responsePath)
		if err == nil {
			out := strings.TrimRight(string(data), "\r\n")
			fmt.Println(out)
			// Best-effort cleanup; service also TTLs responses.
			_ = os.Remove(responsePath)
			os.Exit(0)
		}
		if !errors.Is(err, fs.ErrNotExist) {
			emitError(command, "bridge_read_failed", err.Error(), 30)
		}
		if time.Now().After(deadline) {
			fallback := map[string]any{
				"ok":      false,
				"command": command,
				"code":    "bridge_timeout",
				"message": fmt.Sprintf("timed out waiting for response after %s", timeout),
			}
			if status, err := os.ReadFile(statusFile); err == nil {
				var parsed any
				if json.Unmarshal(status, &parsed) == nil {
					fallback["last_status"] = parsed
				}
			}
			b, _ := json.Marshal(fallback)
			fmt.Println(string(b))
			os.Exit(24)
		}
		time.Sleep(poll)
	}
}
