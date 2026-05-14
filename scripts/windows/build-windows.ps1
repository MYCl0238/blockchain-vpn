$ErrorActionPreference = "Stop"

# Builds all Windows binaries used by the blockchain-vpn target client:
#
#   blockchain-vpn-tun-client.exe          full-tunnel client (UDP <-> TUN)
#   blockchain-vpn-tun-service.exe         SCM supervisor for the tun client
#   blockchain-vpn-app-bridge.exe          unprivileged CLI used by the UI
#   blockchain-vpn-app-bridge-service.exe  SYSTEM service that drains the spool

$Root = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$OutputDir = Join-Path $Root "bin"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Push-Location (Join-Path $Root "protocol\udp")
try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -o (Join-Path $OutputDir "blockchain-vpn-tun-client.exe")          .\cmd\tun-client
    go build -o (Join-Path $OutputDir "blockchain-vpn-tun-service.exe")         .\cmd\tun-service
    go build -o (Join-Path $OutputDir "blockchain-vpn-app-bridge.exe")          .\cmd\app-bridge
    go build -o (Join-Path $OutputDir "blockchain-vpn-app-bridge-service.exe")  .\cmd\app-bridge-service
} finally {
    Remove-Item Env:GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
    Pop-Location
}

Get-ChildItem (Join-Path $OutputDir "blockchain-vpn-*.exe") | ForEach-Object {
    "Built $($_.FullName)"
}
