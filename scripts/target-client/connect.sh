#!/usr/bin/env bash
set -euo pipefail

# Minimal target-device client for vpnd
# Required env vars:
#   VPND_URL   e.g. http://SERVER_IP:8787
#   VPND_TOKEN bearer token
# Optional:
#   VPND_PROFILE_ID default: demo

: "${VPND_URL:?VPND_URL is required}"
: "${VPND_TOKEN:?VPND_TOKEN is required}"
PROFILE_ID="${VPND_PROFILE_ID:-demo}"

auth=(-H "Authorization: Bearer ${VPND_TOKEN}" -H 'content-type: application/json')

case "${1:-status}" in
  connect)
    curl -sS "${auth[@]}" -d "{\"profileId\":\"${PROFILE_ID}\"}" "${VPND_URL}/v1/connect"; echo ;;
  disconnect)
    curl -sS "${auth[@]}" -X POST "${VPND_URL}/v1/disconnect"; echo ;;
  status)
    curl -sS "${auth[@]:0:2}" "${VPND_URL}/v1/status"; echo ;;
  health)
    curl -sS "${VPND_URL}/health"; echo ;;
  *)
    echo "Usage: $0 {connect|disconnect|status|health}" >&2
    exit 1 ;;
esac
