param(
    [Parameter(Position = 0)]
    [string]$Command = "status",

    [switch]$Json,

    [int]$LogLines = 100
)

$ErrorActionPreference = "Stop"

$BaseDir = if ($env:BVPN_WINDOWS_HOME) { $env:BVPN_WINDOWS_HOME } else { Join-Path $env:ProgramData "BlockchainVpn" }
$StateDir = Join-Path $BaseDir "state"
$LogDir = Join-Path $BaseDir "logs"
$ConfigPath = if ($env:BVPN_WINDOWS_CONFIG) { $env:BVPN_WINDOWS_CONFIG } else { Join-Path $BaseDir "blockchain-vpn-windows-client.env.ps1" }
$PidFile = Join-Path $StateDir "tun-client.pid"
$LogFile = Join-Path $LogDir "tun-client.log"
$TunBin = if ($env:BVPN_TUN_BIN) { $env:BVPN_TUN_BIN } else { Join-Path $BaseDir "bin\blockchain-vpn-tun-client.exe" }
$ServiceBin = if ($env:BVPN_TUN_SERVICE_BIN) { $env:BVPN_TUN_SERVICE_BIN } else { Join-Path $BaseDir "bin\blockchain-vpn-tun-service.exe" }
$ServiceName = if ($env:BVPN_TUN_SERVICE_NAME) { $env:BVPN_TUN_SERVICE_NAME } else { "BlockchainVpnTunnel" }
$ServiceDisplayName = if ($env:BVPN_TUN_SERVICE_DISPLAY_NAME) { $env:BVPN_TUN_SERVICE_DISPLAY_NAME } else { "Blockchain VPN Tunnel" }

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-Path $ConfigPath) {
    . $ConfigPath
}

$TunServerHost = if ($env:BVPN_TUN_SERVER_HOST) { $env:BVPN_TUN_SERVER_HOST } else { throw "BVPN_TUN_SERVER_HOST is required. Configure $ConfigPath" }
$TunServerPort = if ($env:BVPN_TUN_SERVER_PORT) { $env:BVPN_TUN_SERVER_PORT } else { "7001" }
$TunCIDR = if ($env:BVPN_TUN_CIDR) { $env:BVPN_TUN_CIDR } else { "10.99.0.3/24" }
$TunGateway = if ($env:BVPN_TUN_GATEWAY) { $env:BVPN_TUN_GATEWAY } else { "10.99.0.1" }
$TunBind = if ($env:BVPN_TUN_BIND) { $env:BVPN_TUN_BIND } else { ":0" }
$TunName = if ($env:BVPN_TUN_NAME) { $env:BVPN_TUN_NAME } else { "bvpntun1" }
$TunRouteDefault = if ($env:BVPN_TUN_ROUTE_DEFAULT) { $env:BVPN_TUN_ROUTE_DEFAULT } else { "true" }
$TunMtu = if ($env:BVPN_TUN_MTU) { $env:BVPN_TUN_MTU } else { "1380" }
$TunApiUrl = if ($env:BVPN_TUN_API_URL) { $env:BVPN_TUN_API_URL } else { "" }
$TunApiToken = if ($env:BVPN_TUN_API_TOKEN) { $env:BVPN_TUN_API_TOKEN } else { "" }
$TunAutoLease = if ($env:BVPN_TUN_AUTO_LEASE) { $env:BVPN_TUN_AUTO_LEASE } else { "false" }
$TunClientIdFile = if ($env:BVPN_TUN_CLIENT_ID_FILE) { $env:BVPN_TUN_CLIENT_ID_FILE } else { Join-Path $StateDir "client-id.txt" }
$TunClientId = if ($env:BVPN_TUN_CLIENT_ID) { $env:BVPN_TUN_CLIENT_ID } else { "" }

function Get-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-BoolTrue([string]$Value) {
    if (-not $Value) { return $false }
    return @("1", "true", "yes", "on") -contains $Value.ToLowerInvariant()
}

function Load-ClientId {
    if ($TunClientId) {
        return $TunClientId
    }
    if (Test-Path $TunClientIdFile) {
        return (Get-Content $TunClientIdFile -Raw).Trim()
    }
    return ""
}

function Save-ClientId([string]$ClientId) {
    if (-not $ClientId) { return }
    Set-Content -Path $TunClientIdFile -Value $ClientId -Encoding UTF8
    $script:TunClientId = $ClientId
}

function Update-ConfigValue([string]$Key, [string]$Value) {
    $line = "`$env:$Key = ""$Value"""
    $existing = @()
    if (Test-Path $ConfigPath) {
        $existing = Get-Content $ConfigPath
    }
    $replaced = $false
    $next = foreach ($item in $existing) {
        if ($item -match "^\s*\$env:$([regex]::Escape($Key))\s*=") {
            $replaced = $true
            $line
        } else {
            $item
        }
    }
    if (-not $replaced) {
        $next += $line
    }
    $next | Set-Content -Path $ConfigPath -Encoding UTF8
}

function Ensure-TunnelLease {
    if (-not $TunApiUrl -or -not (Test-BoolTrue $TunAutoLease)) {
        return
    }
    $headers = @{}
    if ($TunApiToken) {
        $headers["Authorization"] = "Bearer $TunApiToken"
    }
    $body = @{
        clientId = (Load-ClientId)
        platform = "windows"
        deviceName = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Method Post -Uri (($TunApiUrl.TrimEnd('/')) + "/v1/tunnel/lease") -Headers $headers -ContentType "application/json" -Body $body
    if ($response.clientId) {
        Save-ClientId $response.clientId
        Update-ConfigValue "BVPN_TUN_CLIENT_ID" $response.clientId
    }
    if ($response.lease.cidr) {
        $script:TunCIDR = [string]$response.lease.cidr
        Update-ConfigValue "BVPN_TUN_CIDR" $script:TunCIDR
    }
    if ($response.lease.gateway) {
        $script:TunGateway = [string]$response.lease.gateway
        Update-ConfigValue "BVPN_TUN_GATEWAY" $script:TunGateway
    }
}

function Require-Administrator {
    if (-not (Get-IsAdministrator)) {
        throw "Administrator privileges are required."
    }
}

function Get-ServiceObject {
    return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

function Get-ServiceCim {
    return Get-CimInstance Win32_Service -Filter "Name = '$ServiceName'" -ErrorAction SilentlyContinue
}

function Get-EnabledState {
    $svc = Get-ServiceCim
    if (-not $svc) {
        return "disabled"
    }
    if ($svc.StartMode -eq "Disabled") {
        return "disabled"
    }
    return "enabled"
}

function Get-ClientPid {
    if (Test-Path $PidFile) {
        return (Get-Content $PidFile -Raw).Trim()
    }
    return ""
}

function Get-ClientProcess {
    $pidValue = Get-ClientPid
    if (-not $pidValue) {
        return $null
    }
    try {
        return Get-Process -Id ([int]$pidValue) -ErrorAction Stop
    } catch {
        return $null
    }
}

function Get-CommandLine([int]$PidValue) {
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $PidValue"
        if ($proc) {
            return $proc.CommandLine
        }
    } catch {
    }
    return ""
}

function Get-ServerRouteLine {
    try {
        $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$TunServerHost/32" -ErrorAction Stop |
            Sort-Object -Property RouteMetric, InterfaceMetric |
            Select-Object -First 1
        if ($route) {
            return "$($route.DestinationPrefix) via $($route.NextHop) ifIndex=$($route.InterfaceIndex) metric=$($route.RouteMetric)"
        }
    } catch {
    }
    return ""
}

function Get-DefaultRouteLine {
    try {
        $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop |
            Sort-Object -Property RouteMetric, InterfaceMetric |
            Select-Object -First 1
        if ($route) {
            return "$($route.DestinationPrefix) via $($route.NextHop) ifIndex=$($route.InterfaceIndex) metric=$($route.RouteMetric)"
        }
    } catch {
    }
    return ""
}

function Get-State {
    $proc = Get-ClientProcess
    $serviceObj = Get-ServiceObject
    $serviceState = if ($serviceObj -and $serviceObj.Status -eq "Running") { "active" } else { "inactive" }
    $tunnel = if ($proc) { "up" } else { "down" }
    $pidValue = if ($proc) { [string]$proc.Id } else { $null }
    $defaultRouteLine = Get-DefaultRouteLine
    $serverRouteLine = Get-ServerRouteLine
    $defaultRoute = if ($proc -and $TunRouteDefault -eq "true") { "on" } else { "off" }

    [ordered]@{
        service = $serviceState
        enabled = Get-EnabledState
        backend = "windows-tun-service"
        tunnel = $tunnel
        default_route = $defaultRoute
        tun_name = $TunName
        tun_cidr = $TunCIDR
        tun_gateway = $TunGateway
        server = "$TunServerHost`:$TunServerPort"
        pid = $pidValue
        default_route_line = $defaultRouteLine
        server_route_line = $serverRouteLine
        public_ip = $null
        log_file = $LogFile
        tun_bin = $TunBin
        service_bin = $ServiceBin
        service_name = $ServiceName
        admin = if (Get-IsAdministrator) { "yes" } else { "no" }
        command_line = if ($proc) { Get-CommandLine $proc.Id } else { "" }
    }
}

function Emit-Result([bool]$Ok, [string]$Cmd, [string]$Code, [string]$Message, $State, $Extra = $null) {
    $payload = [ordered]@{
        ok = $Ok
        command = $Cmd
        code = $Code
        message = $Message
        state = $State
    }
    if ($Extra) {
        foreach ($k in $Extra.Keys) {
            $payload[$k] = $Extra[$k]
        }
    }
    $payload | ConvertTo-Json -Depth 8
}

function Quote-ServiceArg([string]$Value) {
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-ServiceBinaryPath {
    $parts = @(
        (Quote-ServiceArg $ServiceBin),
        "--service-name", (Quote-ServiceArg $ServiceName),
        "--config", (Quote-ServiceArg $ConfigPath),
        "--tun-bin", (Quote-ServiceArg $TunBin),
        "--pid-file", (Quote-ServiceArg $PidFile),
        "--log-file", (Quote-ServiceArg $LogFile)
    )
    return ($parts -join " ")
}

function Wait-ServiceState([string]$DesiredStatus, [int]$TimeoutSeconds = 15) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $svc = Get-ServiceObject
        if ($svc -and $svc.Status.ToString().Equals($DesiredStatus, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Install-Service {
    Require-Administrator
    if (-not (Test-Path $TunBin)) {
        throw "Tunnel binary not found: $TunBin"
    }
    if (-not (Test-Path $ServiceBin)) {
        throw "Service binary not found: $ServiceBin"
    }

    $existing = Get-ServiceObject
    if ($existing) {
        return Emit-Result $true "install-service" "installed" "windows tunnel service is already installed" (Get-State)
    }

    $binaryPath = Get-ServiceBinaryPath
    New-Service -Name $ServiceName -BinaryPathName $binaryPath -DisplayName $ServiceDisplayName -StartupType Automatic | Out-Null
    & sc.exe description $ServiceName "Blockchain VPN custom Windows tunnel service" | Out-Null

    return Emit-Result $true "install-service" "installed" "windows tunnel service installed" (Get-State)
}

function Uninstall-Service {
    Require-Administrator
    $existing = Get-ServiceObject
    if (-not $existing) {
        return Emit-Result $true "uninstall-service" "removed" "windows tunnel service is already removed" (Get-State)
    }

    if ($existing.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force
        [void](Wait-ServiceState "Stopped" 20)
    }

    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Milliseconds 500
    Remove-Item -ErrorAction SilentlyContinue $PidFile
    return Emit-Result $true "uninstall-service" "removed" "windows tunnel service removed" (Get-State)
}

function Start-Tunnel {
    Require-Administrator
    Ensure-TunnelLease
    $svc = Get-ServiceObject
    if (-not $svc) {
        return Emit-Result $false "up" "not_enabled" "windows tunnel service is not installed" (Get-State)
    }
    if ($svc.Status -eq "Running") {
        return Emit-Result $true "up" "started" "windows tunnel service already running" (Get-State)
    }

    Start-Service -Name $ServiceName
    if (-not (Wait-ServiceState "Running" 20)) {
        return Emit-Result $false "up" "start_failed" "windows tunnel service did not reach running state" (Get-State)
    }
    Start-Sleep -Milliseconds 1200
    return Emit-Result $true "up" "started" "windows tunnel service started" (Get-State)
}

function Stop-Tunnel {
    Require-Administrator
    $svc = Get-ServiceObject
    if (-not $svc) {
        return Emit-Result $true "down" "stopped" "windows tunnel service is not installed" (Get-State)
    }
    if ($svc.Status -ne "Running") {
        return Emit-Result $true "down" "stopped" "windows tunnel service already stopped" (Get-State)
    }

    Stop-Service -Name $ServiceName -Force
    if (-not (Wait-ServiceState "Stopped" 20)) {
        return Emit-Result $false "down" "stop_failed" "windows tunnel service did not stop cleanly" (Get-State)
    }
    Start-Sleep -Milliseconds 300
    return Emit-Result $true "down" "stopped" "windows tunnel service stopped" (Get-State)
}

function Restart-Tunnel {
    Require-Administrator
    Ensure-TunnelLease
    $svc = Get-ServiceObject
    if (-not $svc) {
        return Emit-Result $false "restart" "not_enabled" "windows tunnel service is not installed" (Get-State)
    }
    Restart-Service -Name $ServiceName -Force
    if (-not (Wait-ServiceState "Running" 20)) {
        return Emit-Result $false "restart" "restart_failed" "windows tunnel service did not restart cleanly" (Get-State)
    }
    Start-Sleep -Milliseconds 1200
    return Emit-Result $true "restart" "restarted" "windows tunnel service restarted" (Get-State)
}

function Toggle-Tunnel {
    $svc = Get-ServiceObject
    if (-not $svc) {
        return Emit-Result $false "toggle" "not_enabled" "windows tunnel service is not installed" (Get-State)
    }
    if ($svc.Status -eq "Running") {
        return Stop-Tunnel
    }
    return Start-Tunnel
}

function Show-Health {
    $state = Get-State
    if ($state.service -ne "active") {
        return Emit-Result $false "health" "unhealthy" "windows tunnel service is not active" $state
    }

    try {
        $publicIp = (Invoke-WebRequest -UseBasicParsing -Uri "https://ifconfig.me" -TimeoutSec 5).Content.Trim()
    } catch {
        $publicIp = $null
    }
    $state.public_ip = $publicIp
    return Emit-Result $true "health" "healthy" "windows tunnel service is active" $state
}

function Show-Logs {
    if (-not (Test-Path $LogFile)) {
        return Emit-Result $true "logs" "logs" "no logs yet" (Get-State) @{ logs = "" }
    }
    $logs = (Get-Content -Path $LogFile -Tail $LogLines) -join "`n"
    return Emit-Result $true "logs" "logs" "logs collected" (Get-State) @{ logs = $logs }
}

switch ($Command) {
    "install-service" { Install-Service; break }
    "uninstall-service" { Uninstall-Service; break }
    { $_ -in @("up", "start", "enable") } { Start-Tunnel; break }
    { $_ -in @("down", "stop", "disable") } { Stop-Tunnel; break }
    "toggle" { Toggle-Tunnel; break }
    "restart" { Restart-Tunnel; break }
    "status" { Emit-Result $true "status" "status" "windows tunnel status collected" (Get-State); break }
    "health" { Show-Health; break }
    "publicIp" { Show-Health; break }
    "public-ip" { Show-Health; break }
    "isEnabled" {
        $state = Get-State
        if ($state.enabled -eq "enabled") {
            Emit-Result $true "is-enabled" "enabled" "windows tunnel service is enabled" $state
        } else {
            Emit-Result $false "is-enabled" "not_enabled" "windows tunnel service is not enabled" $state
        }
        break
    }
    "is-enabled" {
        $state = Get-State
        if ($state.enabled -eq "enabled") {
            Emit-Result $true "is-enabled" "enabled" "windows tunnel service is enabled" $state
        } else {
            Emit-Result $false "is-enabled" "not_enabled" "windows tunnel service is not enabled" $state
        }
        break
    }
    "logs" { Show-Logs; break }
    default {
        Emit-Result $false $Command "usage_error" "unsupported command: $Command" (Get-State)
        exit 2
    }
}
