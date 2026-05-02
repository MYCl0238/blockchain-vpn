//go:build windows

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

type worker struct {
	tunName         string
	tunCIDR         string
	tunGateway      string
	serverAddr      string
	localListen     string
	routeDefault    bool
	mtu             int
	tunDev          tun.Device
	udpConn         *net.UDPConn
	serverRouteLUID *winipcfg.LUID
	serverRouteDest netip.Prefix
	serverRouteNext netip.Addr
}

func main() {
	var w worker
	flag.StringVar(&w.tunName, "tun", "bvpntun1", "TUN interface name")
	flag.StringVar(&w.tunCIDR, "tun-cidr", "10.99.0.2/24", "TUN interface CIDR")
	flag.StringVar(&w.tunGateway, "tun-gateway", "10.99.0.1", "TUN gateway address")
	flag.StringVar(&w.serverAddr, "server", "127.0.0.1:7001", "VPN tunnel server UDP address (host:port)")
	flag.StringVar(&w.localListen, "bind", ":0", "Local UDP bind address")
	flag.BoolVar(&w.routeDefault, "route-default", false, "Route default traffic through TUN")
	flag.IntVar(&w.mtu, "mtu", 1380, "MTU for TUN interface")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := w.run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func (w *worker) run(ctx context.Context) error {
	serverAddr, err := net.ResolveUDPAddr("udp", w.serverAddr)
	if err != nil {
		return err
	}

	if err := w.setupTun(serverAddr); err != nil {
		return fmt.Errorf("setup tun: %w", err)
	}
	defer w.cleanupTun()

	localAddr, err := net.ResolveUDPAddr("udp", w.localListen)
	if err != nil {
		return err
	}

	w.udpConn, err = net.DialUDP("udp", localAddr, serverAddr)
	if err != nil {
		return err
	}
	defer w.udpConn.Close()

	log.Printf("tun-client running (windows): tun=%s cidr=%s local=%s server=%s routeDefault=%v", w.tunName, w.tunCIDR, w.udpConn.LocalAddr(), w.serverAddr, w.routeDefault)

	errCh := make(chan error, 2)
	go func() { errCh <- w.loopUDPToTun(ctx) }()
	go func() { errCh <- w.loopTunToUDP(ctx) }()

	select {
	case <-ctx.Done():
		_ = w.udpConn.Close()
		if w.tunDev != nil {
			_ = w.tunDev.Close()
		}
		return context.Canceled
	case err := <-errCh:
		return err
	}
}

func (w *worker) setupTun(serverAddr *net.UDPAddr) error {
	tunDev, err := tun.CreateTUN(w.tunName, w.mtu)
	if err != nil {
		return err
	}
	w.tunDev = tunDev

	nativeTun, ok := tunDev.(*tun.NativeTun)
	if !ok {
		return fmt.Errorf("unexpected tun device type %T", tunDev)
	}

	luid := winipcfg.LUID(nativeTun.LUID())
	tunPrefix, err := netip.ParsePrefix(w.tunCIDR)
	if err != nil {
		return err
	}
	tunGateway, err := netip.ParseAddr(w.tunGateway)
	if err != nil {
		return err
	}

	if err := luid.SetIPAddresses([]netip.Prefix{tunPrefix}); err != nil {
		return fmt.Errorf("set tun address: %w", err)
	}

	ipif, err := luid.IPInterface(windows.AF_INET)
	if err != nil {
		return fmt.Errorf("get ip interface: %w", err)
	}
	ipif.RouterDiscoveryBehavior = winipcfg.RouterDiscoveryDisabled
	ipif.DadTransmits = 0
	ipif.UseAutomaticMetric = false
	ipif.Metric = 0
	ipif.NLMTU = uint32(w.mtu)
	if w.routeDefault {
		ipif.DisableDefaultRoutes = false
	}
	if err := ipif.Set(); err != nil {
		return fmt.Errorf("configure ip interface: %w", err)
	}

	if w.routeDefault {
		if err := w.pinServerRoute(serverAddr); err != nil {
			return err
		}
		if err := luid.SetRoutesForFamily(windows.AF_INET, []*winipcfg.RouteData{{
			Destination: netip.PrefixFrom(netip.IPv4Unspecified(), 0),
			NextHop:     tunGateway,
			Metric:      0,
		}}); err != nil {
			return fmt.Errorf("set default route: %w", err)
		}
	}
	return nil
}

func (w *worker) cleanupTun() {
	if w.serverRouteLUID != nil && w.serverRouteDest.IsValid() && w.serverRouteNext.IsValid() {
		_ = w.serverRouteLUID.DeleteRoute(w.serverRouteDest, w.serverRouteNext)
	}
	if w.tunDev != nil {
		_ = w.tunDev.Close()
	}
}

func (w *worker) pinServerRoute(serverAddr *net.UDPAddr) error {
	if serverAddr == nil || serverAddr.IP == nil {
		return fmt.Errorf("server address has no IP")
	}

	serverIP, ok := netip.AddrFromSlice(serverAddr.IP)
	if !ok {
		return fmt.Errorf("invalid server ip: %v", serverAddr.IP)
	}
	serverIP = serverIP.Unmap()

	defaultRoute, err := bestDefaultRoute()
	if err != nil {
		return err
	}
	nextHop := defaultRoute.NextHop.Addr().Unmap()
	if !nextHop.IsValid() {
		return fmt.Errorf("default route next hop is invalid")
	}

	luid := defaultRoute.InterfaceLUID
	dest := netip.PrefixFrom(serverIP, serverIP.BitLen())
	if err := luid.AddRoute(dest, nextHop, defaultRoute.Metric); err != nil {
		return fmt.Errorf("add server host route: %w", err)
	}

	w.serverRouteLUID = &luid
	w.serverRouteDest = dest
	w.serverRouteNext = nextHop
	return nil
}

func bestDefaultRoute() (*winipcfg.MibIPforwardRow2, error) {
	routes, err := winipcfg.GetIPForwardTable2(windows.AF_INET)
	if err != nil {
		return nil, err
	}

	var best *winipcfg.MibIPforwardRow2
	for i := range routes {
		route := &routes[i]
		dest := route.DestinationPrefix.Prefix()
		if !dest.IsValid() || dest.Bits() != 0 || !dest.Addr().Is4() {
			continue
		}
		nextHop := route.NextHop.Addr().Unmap()
		if !nextHop.IsValid() || !nextHop.Is4() || nextHop.IsUnspecified() {
			continue
		}
		if best == nil || route.Metric < best.Metric {
			best = route
		}
	}
	if best == nil {
		return nil, fmt.Errorf("no default IPv4 route found")
	}
	return best, nil
}

func (w *worker) loopUDPToTun(ctx context.Context) error {
	batchSize := w.tunDev.BatchSize()
	if batchSize < 1 {
		batchSize = 1
	}
	bufs := make([][]byte, batchSize)
	sizes := make([]int, batchSize)
	for i := range bufs {
		bufs[i] = make([]byte, 65535)
	}
	for {
		n, err := w.udpConn.Read(bufs[0])
		if err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
		sizes[0] = n
		packet := [][]byte{bufs[0][:n]}
		if _, err := w.tunDev.Write(packet, 0); err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
	}
}

func (w *worker) loopTunToUDP(ctx context.Context) error {
	batchSize := w.tunDev.BatchSize()
	if batchSize < 1 {
		batchSize = 1
	}
	bufs := make([][]byte, batchSize)
	sizes := make([]int, batchSize)
	for i := range bufs {
		bufs[i] = make([]byte, 65535)
	}
	for {
		n, err := w.tunDev.Read(bufs, sizes, 0)
		if err != nil {
			if ctx.Err() != nil {
				return context.Canceled
			}
			return err
		}
		for i := 0; i < n; i++ {
			if _, err := w.udpConn.Write(bufs[i][:sizes[i]]); err != nil {
				if ctx.Err() != nil {
					return context.Canceled
				}
				return err
			}
		}
		time.Sleep(0)
	}
}
