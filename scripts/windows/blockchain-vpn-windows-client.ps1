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
$StatusFile = Join-Path $StateDir "status.json"
$LogFile = Join-Path $LogDir "tun-client.log"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-Path $ConfigPath) {
    . $ConfigPath
}

$TunBin = if ($env:BVPN_TUN_BIN) { $env:BVPN_TUN_BIN } else { Join-Path $BaseDir "bin\blockchain-vpn-tun-client.exe" }
$TunServerHost = if ($env:BVPN_TUN_SERVER_HOST) { $env:BVPN_TUN_SERVER_HOST } else { throw "BVPN_TUN_SERVER_HOST is required. Configure $ConfigPath" }
$TunServerPort = if ($env:BVPN_TUN_SERVER_PORT) { $env:BVPN_TUN_SERVER_PORT } else { "7001" }
$TunCIDR = if ($env:BVPN_TUN_CIDR) { $env:BVPN_TUN_CIDR } else { "10.99.0.2/24" }
$TunGateway = if ($env:BVPN_TUN_GATEWAY) { $env:BVPN_TUN_GATEWAY } else { "10.99.0.1" }
$TunBind = if ($env:BVPN_TUN_BIND) { $env:BVPN_TUN_BIND } else { ":0" }
$TunName = if ($env:BVPN_TUN_NAME) { $env:BVPN_TUN_NAME } else { "bvpntun1" }
$TunRouteDefault = if ($env:BVPN_TUN_ROUTE_DEFAULT) { $env:BVPN_TUN_ROUTE_DEFAULT } else { "true" }
$TunMtu = if ($env:BVPN_TUN_MTU) { $env:BVPN_TUN_MTU } else { "1380" }

function Get-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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
    $service = if ($proc) { "active" } else { "inactive" }
    $tunnel = if ($proc) { "up" } else { "down" }
    $pidValue = if ($proc) { [string]$proc.Id } else { $null }
    $publicIp = $null
    $defaultRouteLine = Get-DefaultRouteLine
    $serverRouteLine = Get-ServerRouteLine
    $defaultRoute = if ($proc -and $TunRouteDefault -eq "true") { "on" } else { "off" }

    [ordered]@{
        service = $service
        enabled = "disabled"
        backend = "windows-tun"
        tunnel = $tunnel
        default_route = $defaultRoute
        tun_name = $TunName
        tun_cidr = $TunCIDR
        tun_gateway = $TunGateway
        server = "$TunServerHost`:$TunServerPort"
        pid = $pidValue
        default_route_line = $defaultRouteLine
        server_route_line = $serverRouteLine
        public_ip = $publicIp
        log_file = $LogFile
        tun_bin = $TunBin
        admin = if (Get-IsAdministrator) { "yes" } else { "no" }
        command_line = if ($proc) { Get-CommandLine $proc.Id } else { "" }
    }
}

function Write-StatusFile {
    $payload = @{
        ok = $true
        command = "status"
        code = "status"
        message = "windows tunnel status collected"
        state = Get-State
        updated_at = [DateTime]::UtcNow.ToString("o")
    }
    ($payload | ConvertTo-Json -Depth 6) | Set-Content -Path $StatusFile -Encoding UTF8
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

function Get-StartArguments {
    return @(
        "--tun", $TunName,
        "--tun-cidr", $TunCIDR,
        "--tun-gateway", $TunGateway,
        "--server", "$TunServerHost`:$TunServerPort",
        "--bind", $TunBind,
        "--route-default=$TunRouteDefault",
        "--mtu", $TunMtu
    )
}

function Start-Tunnel {
    if (-not (Get-IsAdministrator)) {
        return Emit-Result $false "up" "permission_denied" "administrator privileges are required to create the Windows tunnel" (Get-State)
    }
    if (-not (Test-Path $TunBin)) {
        throw "Tunnel binary not found: $TunBin"
    }

    $existing = Get-ClientProcess
    if ($existing) {
        return Emit-Result $true "up" "started" "windows tunnel already running" (Get-State)
    }

    $wrapperPath = Join-Path $StateDir "launch-tun-client.ps1"
    $argItems = Get-StartArguments | ForEach-Object { "'$_'" }
    $wrapper = @"
& '$TunBin' $($argItems -join ' ') *>> '$LogFile'
"@
    Set-Content -Path $wrapperPath -Value $wrapper -Encoding UTF8

    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $wrapperPath) -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value ([string]$proc.Id) -Encoding UTF8
    Start-Sleep -Milliseconds 1000
    Write-StatusFile
    return Emit-Result $true "up" "started" "windows tunnel started" (Get-State)
}

function Stop-Tunnel {
    $proc = Get-ClientProcess
    if (-not $proc) {
        Remove-Item -ErrorAction SilentlyContinue $PidFile
        Write-StatusFile
        return Emit-Result $true "down" "stopped" "windows tunnel already stopped" (Get-State)
    }

    Stop-Process -Id $proc.Id -Force
    Remove-Item -ErrorAction SilentlyContinue $PidFile
    Start-Sleep -Milliseconds 300
    Write-StatusFile
    return Emit-Result $true "down" "stopped" "windows tunnel stopped" (Get-State)
}

function Show-Health {
    $state = Get-State
    if ($state.service -ne "active") {
        return Emit-Result $false "health" "unhealthy" "windows tunnel is not active" $state
    }

    try {
        $publicIp = (Invoke-WebRequest -UseBasicParsing -Uri "https://ifconfig.me" -TimeoutSec 5).Content.Trim()
    } catch {
        $publicIp = $null
    }
    $state.public_ip = $publicIp
    return Emit-Result $true "health" "healthy" "windows tunnel is active" $state
}

function Show-Logs {
    if (-not (Test-Path $LogFile)) {
        return Emit-Result $true "logs" "logs" "no logs yet" (Get-State) @{ logs = "" }
    }
    $logs = (Get-Content -Path $LogFile -Tail $LogLines) -join "`n"
    return Emit-Result $true "logs" "logs" "logs collected" (Get-State) @{ logs = $logs }
}

Write-StatusFile

switch ($Command) {
    { $_ -in @("up", "start", "enable") } { Start-Tunnel; break }
    { $_ -in @("down", "stop", "disable") } { Stop-Tunnel; break }
    "toggle" {
        if (Get-ClientProcess) { Stop-Tunnel } else { Start-Tunnel }
        break
    }
    "restart" {
        Stop-Tunnel | Out-Null
        Start-Tunnel
        break
    }
    "status" { Emit-Result $true "status" "status" "windows tunnel status collected" (Get-State); break }
    "health" { Show-Health; break }
    "publicIp" { Show-Health; break }
    "public-ip" { Show-Health; break }
    "isEnabled" { Emit-Result $false "is-enabled" "not_enabled" "windows tunnel is not installed as a service yet" (Get-State); break }
    "is-enabled" { Emit-Result $false "is-enabled" "not_enabled" "windows tunnel is not installed as a service yet" (Get-State); break }
    "logs" { Show-Logs; break }
    default {
        Emit-Result $false $Command "usage_error" "unsupported command: $Command" (Get-State)
        exit 2
    }
}
