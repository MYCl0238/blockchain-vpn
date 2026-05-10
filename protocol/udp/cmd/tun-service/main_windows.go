//go:build windows

package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows/svc"
)

type serviceConfig struct {
	ServiceName  string
	ConfigPath   string
	WindowsHome  string
	TunBin       string
	TunServerHost string
	TunServerPort string
	TunCIDR      string
	TunGateway   string
	TunBind      string
	TunName      string
	TunRouteDefault string
	TunMTU       string
	PidFile      string
	LogFile      string
}

type tunnelService struct {
	cfg      serviceConfig
	stopCh   chan struct{}
	doneCh   chan struct{}

	mu       sync.Mutex
	cmd      *exec.Cmd
	logFile  *os.File
	stopping bool
}

func main() {
	cfg := defaultConfig()

	flag.StringVar(&cfg.ServiceName, "service-name", cfg.ServiceName, "Windows service name")
	flag.StringVar(&cfg.ConfigPath, "config", cfg.ConfigPath, "PowerShell env config file path")
	flag.StringVar(&cfg.TunBin, "tun-bin", cfg.TunBin, "Path to blockchain-vpn-tun-client.exe")
	flag.StringVar(&cfg.PidFile, "pid-file", cfg.PidFile, "PID file path")
	flag.StringVar(&cfg.LogFile, "log-file", cfg.LogFile, "log file path")
	flag.Parse()

	if err := cfg.loadConfig(); err != nil {
		log.Fatal(err)
	}

	isInteractive, err := svc.IsAnInteractiveSession()
	if err != nil {
		log.Fatal(err)
	}

	if isInteractive {
		if err := runConsole(cfg); err != nil {
			log.Fatal(err)
		}
		return
	}

	if err := svc.Run(cfg.ServiceName, &tunnelService{cfg: cfg}); err != nil {
		log.Fatal(err)
	}
}

func runConsole(cfg serviceConfig) error {
	s := &tunnelService{cfg: cfg}
	if err := s.startSupervisor(); err != nil {
		return err
	}
	defer s.stopSupervisor()

	log.Printf("%s running in console mode", cfg.ServiceName)
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	<-ch
	return nil
}

func (s *tunnelService) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	if err := s.startSupervisor(); err != nil {
		log.Printf("service start failed: %v", err)
		return false, 1
	}

	changes <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}

	for change := range r {
		switch change.Cmd {
		case svc.Interrogate:
			changes <- change.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			s.stopSupervisor()
			return false, 0
		default:
		}
	}

	s.stopSupervisor()
	return false, 0
}

func (s *tunnelService) startSupervisor() error {
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	go s.supervise()
	return nil
}

func (s *tunnelService) stopSupervisor() {
	if s.stopCh == nil {
		return
	}
	close(s.stopCh)
	<-s.doneCh
}

func (s *tunnelService) supervise() {
	defer close(s.doneCh)

	for {
		select {
		case <-s.stopCh:
			s.stopChild()
			return
		default:
		}

		if err := s.startChild(); err != nil {
			log.Printf("failed to start tunnel child: %v", err)
			if !sleepOrStop(s.stopCh, 5*time.Second) {
				return
			}
			continue
		}

		exitCh := make(chan error, 1)
		s.mu.Lock()
		cmd := s.cmd
		s.mu.Unlock()

		go func() {
			exitCh <- cmd.Wait()
		}()

		select {
		case <-s.stopCh:
			s.stopChild()
			<-exitCh
			s.clearChild()
			return
		case err := <-exitCh:
			s.clearChild()
			if s.isStopping() {
				return
			}
			if err != nil {
				log.Printf("tunnel child exited with error: %v", err)
			} else {
				log.Printf("tunnel child exited cleanly, restarting")
			}
			if !sleepOrStop(s.stopCh, 2*time.Second) {
				return
			}
		}
	}
}

func (s *tunnelService) startChild() error {
	if err := os.MkdirAll(filepath.Dir(s.cfg.PidFile), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.cfg.LogFile), 0o755); err != nil {
		return err
	}

	logFile, err := os.OpenFile(s.cfg.LogFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}

	cmd := exec.Command(s.cfg.TunBin, s.cfg.tunArgs()...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return err
	}

	if err := os.WriteFile(s.cfg.PidFile, []byte(fmt.Sprintf("%d\n", cmd.Process.Pid)), 0o644); err != nil {
		_ = cmd.Process.Kill()
		_ = logFile.Close()
		return err
	}

	s.mu.Lock()
	s.cmd = cmd
	s.logFile = logFile
	s.stopping = false
	s.mu.Unlock()

	log.Printf("started tunnel child pid=%d", cmd.Process.Pid)
	return nil
}

func (s *tunnelService) stopChild() {
	s.mu.Lock()
	s.stopping = true
	cmd := s.cmd
	s.mu.Unlock()

	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func (s *tunnelService) clearChild() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.logFile != nil {
		_ = s.logFile.Close()
		s.logFile = nil
	}
	s.cmd = nil
	_ = os.Remove(s.cfg.PidFile)
}

func (s *tunnelService) isStopping() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopping
}

func (cfg *serviceConfig) tunArgs() []string {
	return []string{
		"--tun", cfg.TunName,
		"--tun-cidr", cfg.TunCIDR,
		"--tun-gateway", cfg.TunGateway,
		"--server", fmt.Sprintf("%s:%s", cfg.TunServerHost, cfg.TunServerPort),
		"--bind", cfg.TunBind,
		fmt.Sprintf("--route-default=%s", cfg.TunRouteDefault),
		"--mtu", cfg.TunMTU,
	}
}

func (cfg *serviceConfig) loadConfig() error {
	settings := map[string]string{}
	if cfg.ConfigPath != "" {
		if fileSettings, err := parsePowerShellEnvFile(cfg.ConfigPath); err == nil {
			for k, v := range fileSettings {
				settings[k] = v
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}

	overrideEnv(settings, "BVPN_WINDOWS_HOME")
	overrideEnv(settings, "BVPN_TUN_BIN")
	overrideEnv(settings, "BVPN_TUN_SERVER_HOST")
	overrideEnv(settings, "BVPN_TUN_SERVER_PORT")
	overrideEnv(settings, "BVPN_TUN_CIDR")
	overrideEnv(settings, "BVPN_TUN_GATEWAY")
	overrideEnv(settings, "BVPN_TUN_BIND")
	overrideEnv(settings, "BVPN_TUN_NAME")
	overrideEnv(settings, "BVPN_TUN_ROUTE_DEFAULT")
	overrideEnv(settings, "BVPN_TUN_MTU")

	if v := settings["BVPN_WINDOWS_HOME"]; v != "" {
		cfg.WindowsHome = v
	}

	defaultTunBin := filepath.Join(cfg.WindowsHome, "bin", "blockchain-vpn-tun-client.exe")
	defaultPidFile := filepath.Join(cfg.WindowsHome, "state", "tun-client.pid")
	defaultLogFile := filepath.Join(cfg.WindowsHome, "logs", "tun-client.log")

	if cfg.TunBin == "" {
		cfg.TunBin = defaultTunBin
	}
	if v := settings["BVPN_TUN_BIN"]; v != "" {
		cfg.TunBin = v
	}
	if cfg.PidFile == "" {
		cfg.PidFile = defaultPidFile
	}
	if cfg.LogFile == "" {
		cfg.LogFile = defaultLogFile
	}
	if cfg.TunServerHost == "" {
		cfg.TunServerHost = firstNonEmpty(settings["BVPN_TUN_SERVER_HOST"], "84.21.171.106")
	}
	cfg.TunServerPort = firstNonEmpty(settings["BVPN_TUN_SERVER_PORT"], "7001")
	cfg.TunCIDR = firstNonEmpty(settings["BVPN_TUN_CIDR"], "10.99.0.2/24")
	cfg.TunGateway = firstNonEmpty(settings["BVPN_TUN_GATEWAY"], "10.99.0.1")
	cfg.TunBind = firstNonEmpty(settings["BVPN_TUN_BIND"], ":0")
	cfg.TunName = firstNonEmpty(settings["BVPN_TUN_NAME"], "bvpntun1")
	cfg.TunRouteDefault = firstNonEmpty(settings["BVPN_TUN_ROUTE_DEFAULT"], "true")
	cfg.TunMTU = firstNonEmpty(settings["BVPN_TUN_MTU"], "1380")

	if cfg.TunServerHost == "" {
		return fmt.Errorf("BVPN_TUN_SERVER_HOST is required")
	}
	if cfg.TunBin == "" {
		return fmt.Errorf("BVPN_TUN_BIN is required")
	}
	return nil
}

func defaultConfig() serviceConfig {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	windowsHome := firstNonEmpty(os.Getenv("BVPN_WINDOWS_HOME"), filepath.Join(programData, "BlockchainVpn"))
	return serviceConfig{
		ServiceName: "BlockchainVpnTunnel",
		ConfigPath:  filepath.Join(windowsHome, "blockchain-vpn-windows-client.env.ps1"),
		WindowsHome: windowsHome,
		PidFile:     filepath.Join(windowsHome, "state", "tun-client.pid"),
		LogFile:     filepath.Join(windowsHome, "logs", "tun-client.log"),
	}
}

func parsePowerShellEnvFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	settings := map[string]string{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(line), "$env:") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(strings.TrimPrefix(parts[0], "$env:"))
		val := strings.TrimSpace(parts[1])
		val = strings.TrimSuffix(strings.TrimPrefix(val, `"`), `"`)
		val = strings.TrimSuffix(strings.TrimPrefix(val, `'`), `'`)
		settings[key] = val
	}
	return settings, scanner.Err()
}

func overrideEnv(settings map[string]string, key string) {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		settings[key] = value
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func sleepOrStop(stopCh <-chan struct{}, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-stopCh:
		return false
	case <-timer.C:
		return true
	}
}
