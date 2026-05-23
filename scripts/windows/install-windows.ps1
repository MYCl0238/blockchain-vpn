<#
.SYNOPSIS
  Installs the Blockchain VPN Windows client end-to-end.

.DESCRIPTION
  Run from an elevated PowerShell. Installs:
    - tun-client.exe + wintun.dll into C:\ProgramData\BlockchainVpn\bin\
    - The Node.js control-plane daemon (HTTP API on 127.0.0.1:8787) that
      the Tauri desktop UI talks to. Registered as a Scheduled Task
      `BlockchainVpnControlPlane` running as SYSTEM at boot.
    - (Optional) the legacy file-spool app-bridge stack, enabled with
      -LegacyBridge. Off by default -- the Tauri UI uses the HTTP daemon.

.PARAMETER LegacyBridge
  Also install the file-spool app-bridge service + the PowerShell-based
  tun-service supervisor. Use this only if you're driving the client
  from the older `blockchain-vpn-app-bridge.exe` CLI.

.PARAMETER ServerHost
  VPS public IP/DNS. Default: 84.21.171.106.

.PARAMETER ControlPlaneToken
  Optional Bearer token to require on /v1/* endpoints. Loopback only,
  so usually unnecessary.

.EXAMPLE
  PS> .\install-windows.ps1
  Installs tun-client + control-plane daemon (Tauri-ready).

.EXAMPLE
  PS> .\install-windows.ps1 -LegacyBridge
  Also installs the old app-bridge + tun-service stack alongside.
#>
param(
    [switch]$LegacyBridge,
    [string]$ServerHost = "84.21.171.106",
    [string]$ControlPlaneToken = ""
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    throw "install-windows.ps1 must be run from an elevated PowerShell."
}

# --------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------
$Root           = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$BinSrc         = Join-Path $Root "bin"
$ControlPlaneSrc = Join-Path $Root "backend\control-plane"
$BvpnHome       = if ($env:BVPN_WINDOWS_HOME) { $env:BVPN_WINDOWS_HOME } else { Join-Path $env:ProgramData "BlockchainVpn" }
$BinDst         = Join-Path $BvpnHome "bin"
$CtrlDst        = Join-Path $BvpnHome "control-plane"
$DataDst        = Join-Path $BvpnHome "data"
$ScriptsDst     = Join-Path $BvpnHome "scripts"
$LogsDst        = Join-Path $BvpnHome "logs"

New-Item -ItemType Directory -Force -Path $BinDst, $CtrlDst, $DataDst, $ScriptsDst, $LogsDst | Out-Null

# --------------------------------------------------------------------
# Sanity: required binaries built?
# --------------------------------------------------------------------
$RequiredBins = @("blockchain-vpn-tun-client.exe")
if ($LegacyBridge) {
    $RequiredBins += @(
        "blockchain-vpn-tun-service.exe",
        "blockchain-vpn-app-bridge.exe",
        "blockchain-vpn-app-bridge-service.exe"
    )
}
foreach ($n in $RequiredBins) {
    $p = Join-Path $BinSrc $n
    if (-not (Test-Path $p)) {
        throw "Missing $p -- run .\scripts\windows\build-windows.ps1 first."
    }
}

# --------------------------------------------------------------------
# 1) Stop everything that might hold the binaries open
# --------------------------------------------------------------------
Write-Host "==> Stopping existing services (if any)"
foreach ($svc in @("BlockchainVpnTunnel","BlockchainVpnAppBridge")) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s -and $s.Status -ne 'Stopped') {
        Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
        # SCM stop can be slow; small wait.
        Start-Sleep -Seconds 2
    }
}
$task = Get-ScheduledTask -TaskName "BlockchainVpnControlPlane" -ErrorAction SilentlyContinue
if ($task) {
    try { Stop-ScheduledTask -TaskName "BlockchainVpnControlPlane" -ErrorAction SilentlyContinue } catch {}
}

# --------------------------------------------------------------------
# 2) Copy binaries
# --------------------------------------------------------------------
Write-Host "==> Installing binaries to $BinDst"
foreach ($n in $RequiredBins) {
    Copy-Item -Force (Join-Path $BinSrc $n) (Join-Path $BinDst $n)
}
# wintun.dll, if present in bin/ (needed by tun-client.exe at runtime).
$wintun = Join-Path $BinSrc "wintun.dll"
if (Test-Path $wintun) {
    Copy-Item -Force $wintun (Join-Path $BinDst "wintun.dll")
} else {
    Write-Warning "wintun.dll not found in $BinSrc. tun-client will fail to load if not on PATH."
}

# --------------------------------------------------------------------
# 3) Copy control-plane daemon
# --------------------------------------------------------------------
Write-Host "==> Installing control-plane daemon to $CtrlDst"
Copy-Item -Recurse -Force (Join-Path $ControlPlaneSrc "*") $CtrlDst

# --------------------------------------------------------------------
# 4) Ensure Node.js is available
# --------------------------------------------------------------------
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "==> Node.js not found on PATH; trying winget install"
    try {
        winget install -e --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --silent | Out-Host
        # Refresh PATH in this session.
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
    } catch {
        Write-Warning "winget install failed: $_"
    }
}
if (-not $node) {
    throw "Node.js (v18+) is required. Install it from https://nodejs.org/ and re-run."
}
$nodeExe = $node.Source
Write-Host "    using $nodeExe"

# --------------------------------------------------------------------
# 5) Register the control-plane as a Scheduled Task running as SYSTEM
#    (a Scheduled Task is the simplest way to run Node as a long-lived
#    service without bundling a third-party service wrapper.)
# --------------------------------------------------------------------
Write-Host "==> Registering control-plane Scheduled Task"

# Wrapper batch so we can set env vars + restart-on-exit cheaply.
$WrapperPath = Join-Path $ScriptsDst "run-control-plane.cmd"
$wrapperContent = @"
@echo off
setlocal
set BVPN_HOST=127.0.0.1
set BVPN_PORT=8787
set BVPN_DATA_DIR=$DataDst
set BVPN_LOG_FILE=$LogsDst\control-plane.log
rem daemon.js defaults BVPN_TUN_CLIENT_BIN to /usr/local/bin/... on Linux — pin
rem it to the installed Windows .exe so the spawn() finds it.
set BVPN_TUN_CLIENT_BIN=$BinDst\blockchain-vpn-tun-client.exe
set PATH=$BinDst;%PATH%
"$nodeExe" "$CtrlDst\daemon.js" 1>>"$LogsDst\control-plane.log" 2>&1
"@
Set-Content -Path $WrapperPath -Value $wrapperContent -Encoding ASCII

# Replace any prior task.
$existing = Get-ScheduledTask -TaskName "BlockchainVpnControlPlane" -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName "BlockchainVpnControlPlane" -Confirm:$false }

$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$WrapperPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

Register-ScheduledTask -TaskName "BlockchainVpnControlPlane" `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "Blockchain VPN local control-plane (HTTP :8787)" | Out-Null

# Kick it off now.
Start-ScheduledTask -TaskName "BlockchainVpnControlPlane"
Start-Sleep -Seconds 3

# Smoke check.
$ok = $false
for ($i = 0; $i -lt 6; $i++) {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri http://127.0.0.1:8787/v1/status
        if ($resp.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}
if (-not $ok) {
    Write-Warning "Control-plane didn't respond on :8787 within 6s. Check $LogsDst\control-plane.log."
} else {
    Write-Host "    control-plane up: http://127.0.0.1:8787/v1/status"
}

# --------------------------------------------------------------------
# 6) Optional: install the legacy file-spool bridge
# --------------------------------------------------------------------
if ($LegacyBridge) {
    Write-Host "==> Installing legacy file-spool bridge"
    $ControllerSrc = Join-Path $PSScriptRoot "blockchain-vpn-windows-client.ps1"
    $ControllerDst = Join-Path $ScriptsDst "blockchain-vpn-windows-client.ps1"
    $EnvDst = Join-Path $BvpnHome "blockchain-vpn-windows-client.env.ps1"
    $EnvSrc = Join-Path $PSScriptRoot "blockchain-vpn-windows-client.env.ps1.example"
    Copy-Item -Force $ControllerSrc $ControllerDst
    Set-ItemProperty -Path $ControllerDst -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
    if (-not (Test-Path $EnvDst)) {
        Copy-Item -Force $EnvSrc $EnvDst
        Write-Host "    seeded $EnvDst -- edit before starting"
    }
    Set-ItemProperty -Path $EnvDst -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
    & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ControllerDst install-service -Json | Out-Host
    try { & (Join-Path $BinDst "blockchain-vpn-app-bridge-service.exe") install } catch { Write-Warning "$_" }
    Start-Service -Name BlockchainVpnAppBridge -ErrorAction SilentlyContinue
}

# --------------------------------------------------------------------
# 7) Summary
# --------------------------------------------------------------------
Write-Host ""
Write-Host "================================================================"
Write-Host "Install complete."
Write-Host "  binaries        : $BinDst"
Write-Host "  control-plane   : http://127.0.0.1:8787  (Scheduled Task as SYSTEM)"
Write-Host "  data dir        : $DataDst"
Write-Host "  logs            : $LogsDst"
Write-Host ""
Write-Host "Now launch the Blockchain VPN desktop app and click Connect VPN."
Write-Host "Check daemon log : Get-Content $LogsDst\control-plane.log -Tail 30"
Write-Host "================================================================"
