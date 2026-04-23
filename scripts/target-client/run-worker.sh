#!/usr/bin/env bash
set -euo pipefail

# Cross-platform target worker launcher (Linux/macOS/Windows via Git Bash/WSL, Android Termux)
# Requires Go-built binary on target device.
# Env:
#   BVPN_WORKER_BIN (optional) default: ../../bin/blockchain-vpn-target-worker
#   PROTO_SERVER_HOST, PROTO_SERVER_PORT, PROTO_PSK
#   PROTO_CLIENT_ID, PROTO_BIND, PROTO_KEEPALIVE_MS, PROTO_RECONNECT_MS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKER_BIN="${BVPN_WORKER_BIN:-$ROOT_DIR/bin/blockchain-vpn-target-worker}"

: "${PROTO_SERVER_HOST:?PROTO_SERVER_HOST is required}"
: "${PROTO_SERVER_PORT:?PROTO_SERVER_PORT is required}"
: "${PROTO_PSK:?PROTO_PSK is required}"

if [[ ! -x "$WORKER_BIN" ]]; then
  echo "Worker binary not found/executable: $WORKER_BIN" >&2
  echo "Build first:" >&2
  echo "  cd $ROOT_DIR/protocol/udp && go build -o $ROOT_DIR/bin/blockchain-vpn-target-worker ./cmd/worker" >&2
  exit 1
fi

exec "$WORKER_BIN"
