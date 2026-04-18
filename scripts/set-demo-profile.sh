#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BVPN_URL:-${VPND_URL:-http://127.0.0.1:8787}}"
TOKEN="${BVPN_TOKEN:-${VPND_TOKEN:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "BVPN_TOKEN (or VPND_TOKEN) is required" >&2
  exit 1
fi

payload='{
  "id":"demo",
  "name":"Blockchain VPN Protocol Daemon",
  "command":"/usr/bin/env",
  "args":[
    "bash",
    "-lc",
    "systemctl --user stop blockchain-vpnd.service >/dev/null 2>&1 || true; set -a; source /home/mustafa/.config/blockchain-vpn/proto.env; set +a; exec /home/mustafa/blockchain-vpn/bin/blockchain-vpnd"
  ],
  "cwd":"/home/mustafa/blockchain-vpn",
  "env":{}
}'

# remove old profile if present
curl -sS -H "Authorization: Bearer ${TOKEN}" -X DELETE "${BASE_URL}/v1/profiles/demo" >/dev/null || true

# add new profile
curl -sS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d "$payload" "${BASE_URL}/v1/profiles"

echo
