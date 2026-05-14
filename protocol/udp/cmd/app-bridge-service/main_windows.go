//go:build windows

// blockchain-vpn-app-bridge-service runs as a SYSTEM Windows Service. It
// drains the bridge request spool (written by the unprivileged
// blockchain-vpn-app-bridge.exe), dispatches each command through the
// existing PowerShell controller blockchain-vpn-windows-client.ps1, and
// writes the JSON result back into the response spool. It also refreshes
// status.json periodically so callers can read a snapshot without round
// tripping through a request.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/debug"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName        = "BlockchainVpnAppBridge"
	serviceDisplayName = "Blockchain VPN App Bridge"
	serviceDescription = "Drains the user-mode VPN control request spool and dispatches commands to the Windows tunnel controller."
)

type config struct {
	BridgeDir         string
	RequestDir        string
	ResponseDir       string
	StatusFile        string
	ControllerScript  string
	PollInterval      time.Duration
	StatusInterval    time.Duration
	ResponseTTL       time.Duration
	CommandTimeout    time.Duration
}

func loadConfig() config {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	base := getenvDefault("BVPN_APP_BRIDGE_DIR", filepath.Join(programData, "BlockchainVpn", "bridge"))
	homeBase := getenvDefault("BVPN_WINDOWS_HOME", filepath.Join(programData, "BlockchainVpn"))
	script := getenvDefault("BVPN_APP_BRIDGE_CONTROLLER", filepath.Join(homeBase, "scripts", "blockchain-vpn-windows-client.ps1"))
	return config{
		BridgeDir:        base,
		RequestDir:       filepath.Join(base, "requests"),
		ResponseDir:      filepath.Join(base, "responses"),
		StatusFile:       filepath.Join(base, "status.json"),
		ControllerScript: script,
		PollInterval:     envDur("BVPN_APP_BRIDGE_SERVICE_POLL_SECS", 500*time.Millisecond),
		StatusInterval:   envDur("BVPN_APP_BRIDGE_STATUS_INTERVAL_SECS", 5*time.Second),
		ResponseTTL:      envDur("BVPN_APP_BRIDGE_RESPONSE_TTL_SECS", 60*time.Second),
		CommandTimeout:   envDur("BVPN_APP_BRIDGE_COMMAND_TIMEOUT_SECS", 25*time.Second),
	}
}

func getenvDefault(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envDur(name string, def time.Duration) time.Duration {
	if v := os.Getenv(name); v != "" {
		var secs float64
		if _, err := fmt.Sscanf(v, "%f", &secs); err == nil && secs > 0 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return def
}

func nowIso() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

type request struct {
	RequestID string            `json:"request_id"`
	Command   string            `json:"command"`
	Args      map[string]any    `json:"args"`
	CreatedAt string            `json:"created_at"`
	Caller    map[string]string `json:"caller,omitempty"`
}

type controller struct {
	cfg config
	log Logger
	mu  sync.Mutex // serialize SCM-touching commands so two callers do not race
}

type Logger interface {
	Info(uint32, string) error
	Warning(uint32, string) error
	Error(uint32, string) error
}

type stdLogger struct{}

func (stdLogger) Info(_ uint32, m string) error    { log.Printf("INFO: %s", m); return nil }
func (stdLogger) Warning(_ uint32, m string) error { log.Printf("WARN: %s", m); return nil }
func (stdLogger) Error(_ uint32, m string) error   { log.Printf("ERROR: %s", m); return nil }

func ensureDirs(cfg config) error {
	for _, d := range []string{cfg.BridgeDir, cfg.RequestDir, cfg.ResponseDir} {
		if err := os.MkdirAll(d, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}
	return nil
}

// ensureAcl gives BUILTIN\Users modify rights on the bridge dirs so unprivileged
// callers can drop requests and read their responses. Best-effort: if icacls
// is missing or fails, the service still works for any caller already in the
// existing ACL (typically Administrators).
func ensureAcl(cfg config, lg Logger) {
	for _, d := range []string{cfg.BridgeDir, cfg.RequestDir, cfg.ResponseDir} {
		cmd := exec.Command("icacls", d, "/grant", `*S-1-5-32-545:(OI)(CI)M`, "/T")
		if out, err := cmd.CombinedOutput(); err != nil {
			_ = lg.Warning(1, fmt.Sprintf("icacls grant on %s failed: %v: %s", d, err, strings.TrimSpace(string(out))))
		}
	}
}

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// dispatch runs a single command through the PowerShell controller and
// returns the parsed JSON response (or an error envelope).
func (c *controller) dispatch(ctx context.Context, req request) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, err := os.Stat(c.cfg.ControllerScript); err != nil {
		return errorPayload(req.Command, "bridge_controller_missing", fmt.Sprintf("controller script not found: %s", c.cfg.ControllerScript))
	}

	args := []string{
		"-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-File", c.cfg.ControllerScript,
		req.Command,
	}
	if req.Command == "logs" {
		count := 100
		if v, ok := req.Args["count"]; ok {
			switch n := v.(type) {
			case float64:
				count = int(n)
			case int:
				count = n
			}
		}
		args = append(args, "-LogLines", fmt.Sprintf("%d", count))
	}
	args = append(args, "-Json")

	cctx, cancel := context.WithTimeout(ctx, c.cfg.CommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, "powershell.exe", args...)
	stdout, err := cmd.Output()
	if err != nil {
		var stderr string
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr = strings.TrimSpace(string(exitErr.Stderr))
		}
		// Parse stdout/stderr as JSON if possible; many controller paths emit
		// a JSON envelope even on failure.
		if parsed := tryParse(stdout); parsed != nil {
			parsed["completed_at"] = nowIso()
			return parsed
		}
		if parsed := tryParse([]byte(stderr)); parsed != nil {
			parsed["completed_at"] = nowIso()
			return parsed
		}
		msg := stderr
		if msg == "" {
			msg = err.Error()
		}
		return errorPayload(req.Command, "bridge_runner_failed", msg)
	}

	parsed := tryParse(stdout)
	if parsed == nil {
		return map[string]any{
			"ok":           false,
			"command":      req.Command,
			"code":         "bridge_runner_parse_failed",
			"message":      "controller did not return JSON",
			"raw_stdout":   string(stdout),
			"completed_at": nowIso(),
		}
	}
	parsed["completed_at"] = nowIso()
	return parsed
}

func tryParse(data []byte) map[string]any {
	data = []byte(strings.TrimSpace(string(data)))
	if len(data) == 0 {
		return nil
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil
	}
	return v
}

func errorPayload(command, code, message string) map[string]any {
	return map[string]any{
		"ok":           false,
		"command":      command,
		"code":         code,
		"message":      message,
		"completed_at": nowIso(),
	}
}

func (c *controller) refreshStatus(ctx context.Context) {
	payload := c.dispatch(ctx, request{Command: "status"})
	payload["refreshed_at"] = nowIso()
	body, err := json.Marshal(payload)
	if err != nil {
		_ = c.log.Warning(1, "encode status: "+err.Error())
		return
	}
	if err := writeAtomic(c.cfg.StatusFile, body); err != nil {
		_ = c.log.Warning(1, "write status: "+err.Error())
	}
}

func (c *controller) processRequest(ctx context.Context, path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		_ = c.log.Warning(1, fmt.Sprintf("read request %s: %v", path, err))
		_ = os.Remove(path)
		return
	}
	var req request
	if err := json.Unmarshal(data, &req); err != nil {
		_ = c.log.Warning(1, fmt.Sprintf("parse request %s: %v", path, err))
		// Write a "bad_request" response so the client does not just time out.
		id := strings.TrimSuffix(filepath.Base(path), ".json")
		writeResponse(c.cfg.ResponseDir, id, errorPayload("unknown", "bad_request", err.Error()))
		_ = os.Remove(path)
		return
	}
	if req.RequestID == "" {
		req.RequestID = strings.TrimSuffix(filepath.Base(path), ".json")
	}
	payload := c.dispatch(ctx, req)
	writeResponse(c.cfg.ResponseDir, req.RequestID, payload)
	_ = os.Remove(path)
	// Refresh status whenever a state-changing command finishes.
	switch req.Command {
	case "up", "down", "toggle", "restart":
		c.refreshStatus(ctx)
	}
}

func writeResponse(responseDir, requestID string, payload map[string]any) {
	if payload["completed_at"] == nil {
		payload["completed_at"] = nowIso()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	path := filepath.Join(responseDir, requestID+".json")
	_ = writeAtomic(path, body)
}

func (c *controller) cleanupResponses() {
	entries, err := os.ReadDir(c.cfg.ResponseDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-c.cfg.ResponseTTL)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(c.cfg.ResponseDir, e.Name()))
		}
	}
}

func (c *controller) drain(ctx context.Context) {
	entries, err := os.ReadDir(c.cfg.RequestDir)
	if err != nil {
		return
	}
	type fileEntry struct {
		path string
		mod  time.Time
	}
	files := make([]fileEntry, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileEntry{filepath.Join(c.cfg.RequestDir, e.Name()), info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		c.processRequest(ctx, f.path)
		if ctx.Err() != nil {
			return
		}
	}
}

func (c *controller) run(ctx context.Context) {
	if err := ensureDirs(c.cfg); err != nil {
		_ = c.log.Error(1, err.Error())
		return
	}
	ensureAcl(c.cfg, c.log)
	c.refreshStatus(ctx)

	tick := time.NewTicker(c.cfg.PollInterval)
	defer tick.Stop()
	statusTick := time.NewTicker(c.cfg.StatusInterval)
	defer statusTick.Stop()
	cleanupTick := time.NewTicker(c.cfg.ResponseTTL / 2)
	defer cleanupTick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			c.drain(ctx)
		case <-statusTick.C:
			c.refreshStatus(ctx)
		case <-cleanupTick.C:
			c.cleanupResponses()
		}
	}
}

type bridgeService struct {
	cfg config
}

func (s *bridgeService) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}
	elog, err := eventlog.Open(serviceName)
	var lg Logger
	if err == nil {
		lg = elog
		defer elog.Close()
	} else {
		lg = stdLogger{}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &controller{cfg: s.cfg, log: lg}
	done := make(chan struct{})
	go func() { c.run(ctx); close(done) }()

	status <- svc.Status{State: svc.Running, Accepts: accepted}
loop:
	for {
		req := <-r
		switch req.Cmd {
		case svc.Interrogate:
			status <- req.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			cancel()
			break loop
		}
	}
	<-done
	status <- svc.Status{State: svc.Stopped}
	return false, 0
}

func installService(cfg config) error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("service %s already installed", serviceName)
	}
	s, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName: serviceDisplayName,
		Description: serviceDescription,
		StartType:   mgr.StartAutomatic,
	}, "service")
	if err != nil {
		return err
	}
	defer s.Close()
	if err := eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		// Non-fatal: the service still works, just without an event source.
		log.Printf("warn: eventlog InstallAsEventCreate: %v", err)
	}
	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.Delete(); err != nil {
		return err
	}
	_ = eventlog.Remove(serviceName)
	return nil
}

func main() {
	cmd := ""
	if len(os.Args) >= 2 {
		cmd = os.Args[1]
	}
	flag.CommandLine.Parse(os.Args[2:]) //nolint:errcheck // no flags yet, leaves room to add some later

	cfg := loadConfig()
	switch cmd {
	case "install":
		if err := installService(cfg); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
			os.Exit(1)
		}
		fmt.Println("installed:", serviceName)
	case "uninstall":
		if err := uninstallService(); err != nil {
			fmt.Fprintln(os.Stderr, "uninstall:", err)
			os.Exit(1)
		}
		fmt.Println("uninstalled:", serviceName)
	case "debug":
		if err := debug.Run(serviceName, &bridgeService{cfg: cfg}); err != nil {
			fmt.Fprintln(os.Stderr, "debug:", err)
			os.Exit(1)
		}
	case "service", "":
		// Default path under SCM. svc.Run blocks until the service is stopped.
		if err := svc.Run(serviceName, &bridgeService{cfg: cfg}); err != nil {
			fmt.Fprintln(os.Stderr, "svc.Run:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "Usage: blockchain-vpn-app-bridge-service {service|debug|install|uninstall}")
		os.Exit(2)
	}
}
