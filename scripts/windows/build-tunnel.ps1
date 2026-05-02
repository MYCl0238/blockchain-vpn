$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$OutputDir = Join-Path $Root "bin"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Push-Location (Join-Path $Root "protocol\udp")
try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -o (Join-Path $OutputDir "blockchain-vpn-tun-client.exe") .\cmd\tun-client
} finally {
    Remove-Item Env:GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host "Built $OutputDir\blockchain-vpn-tun-client.exe"
