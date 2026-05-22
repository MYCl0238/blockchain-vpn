#!/usr/bin/env bash
# Blockchain VPN — one-shot Linux installer.
#
# Pulls the latest release artifacts from GitHub, installs
#   /usr/local/bin/blockchain-vpn-tun-client        (Go binary, setcap'd)
#   /usr/share/blockchain-vpn/daemon.js             (control-plane)
#   /etc/systemd/system/blockchain-vpn-control-plane.service
#   ~/.local/bin/blockchain-vpn-desktop.AppImage    (Tauri UI)
#   ~/.local/share/applications/blockchain-vpn.desktop
#
# After install:
#   * The control-plane systemd unit is enabled + started as root.
#   * The user runs the AppImage (or app-menu entry "Blockchain VPN") to
#     pair their wallet and connect.
#
# Usage:
#   curl -fsSL https://github.com/MYCl0238/blockchain-vpn/releases/latest/download/install-linux.sh | bash
#   # or
#   curl -fsSL <url-to-this-script> > install.sh && bash install.sh
#
# Idempotent: re-running upgrades to the latest release in place.

set -euo pipefail

REPO_DEFAULT="MYCl0238/blockchain-vpn"
REPO="${BVPN_REPO:-$REPO_DEFAULT}"
TAG="${BVPN_TAG:-latest}"
USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
DESKTOP_BIN_DIR="$USER_HOME/.local/bin"
DESKTOP_APP_DIR="$USER_HOME/.local/share/applications"
TMP="$(mktemp -d -t bvpn-install-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# -------------------------------------------------------------------- preflight
[[ "$(uname -s)" == "Linux" ]] || die "This installer is Linux-only. For Windows see docs/INSTALL_WINDOWS.md; for Android grab the APK from the Releases page."
[[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "amd64" ]] || die "Only x86_64 is supported in v0.1; arm64 builds aren't published yet."

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }
need_cmd curl
need_cmd sudo
need_cmd tar
need_cmd install
need_cmd systemctl

# Node.js is required to run the control-plane daemon. Install it via the
# distro's package manager if missing. We don't pin a version because the
# daemon is plain Node 18+ APIs.
ensure_node() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  step "Node.js not found — installing via your distro's package manager"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm --needed nodejs
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add --no-cache nodejs
  else
    die "Couldn't auto-install Node.js — install it manually (apt/dnf/pacman/zypper/apk) and re-run."
  fi
  command -v node >/dev/null 2>&1 || die "Node.js install reported success but \`node\` is still not on PATH."
}
ensure_node

# libcap-ng's `setcap` is needed to grant CAP_NET_ADMIN to the unprivileged
# tun-client binary; without it the tunnel can only come up as root.
ensure_setcap() {
  if command -v setcap >/dev/null 2>&1; then return 0; fi
  warn "setcap not found — will install libcap (or equivalent) via package manager"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y libcap2-bin
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y libcap
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm --needed libcap
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y libcap-progs
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add --no-cache libcap libcap-utils
  fi
  command -v setcap >/dev/null 2>&1 || die "Could not install setcap. tun-client would have to run as root otherwise."
}
ensure_setcap

# -------------------------------------------------------------------- resolve release
api_url() {
  if [[ "$TAG" == "latest" ]]; then
    echo "https://api.github.com/repos/$REPO/releases/latest"
  else
    echo "https://api.github.com/repos/$REPO/releases/tags/$TAG"
  fi
}

step "Resolving release $TAG of $REPO"
RELEASE_JSON="$TMP/release.json"
curl -fsSL "$(api_url)" -o "$RELEASE_JSON" || die "Could not fetch release metadata from GitHub. Network blocked?"

# Match the artifact filenames produced by `gh release create` in the
# project. If the user pinned a tag whose assets are named differently,
# they can override via BVPN_APPIMAGE_URL / BVPN_TARBALL_URL env vars.
asset_url() {
  local pattern="$1"
  python3 -c "
import json, re, sys
with open('$RELEASE_JSON') as f:
    rel = json.load(f)
matches = [a for a in rel.get('assets', []) if re.search(r'$pattern', a['name'])]
print(matches[0]['browser_download_url']) if matches else sys.exit(1)
" || return 1
}

APPIMAGE_URL="${BVPN_APPIMAGE_URL:-$(asset_url 'AppImage$' || true)}"
TARBALL_URL="${BVPN_TARBALL_URL:-$(asset_url '^blockchain-vpn-linux.*\\.tar\\.gz$' || true)}"
[[ -n "$APPIMAGE_URL" ]] || die "Could not find an AppImage asset in this release."
[[ -n "$TARBALL_URL" ]] || die "Could not find a Linux backend tarball in this release."

# -------------------------------------------------------------------- download
step "Downloading $(basename "$APPIMAGE_URL")"
curl -fL --progress-bar "$APPIMAGE_URL" -o "$TMP/blockchain-vpn.AppImage"
step "Downloading $(basename "$TARBALL_URL")"
curl -fL --progress-bar "$TARBALL_URL" -o "$TMP/backend.tar.gz"

step "Extracting backend"
mkdir -p "$TMP/backend"
tar -xzf "$TMP/backend.tar.gz" -C "$TMP/backend"
BACKEND_ROOT="$(find "$TMP/backend" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -d "$BACKEND_ROOT" ]] || die "Backend tarball didn't unpack into a single top-level directory."
[[ -x "$BACKEND_ROOT/bin/blockchain-vpn-tun-client" ]] || die "Backend tarball is missing bin/blockchain-vpn-tun-client."
[[ -f "$BACKEND_ROOT/backend/control-plane/daemon.js" ]] || die "Backend tarball is missing backend/control-plane/daemon.js."

# -------------------------------------------------------------------- install
step "Installing tun-client to /usr/local/bin"
sudo install -m 0755 "$BACKEND_ROOT/bin/blockchain-vpn-tun-client" /usr/local/bin/blockchain-vpn-tun-client
sudo setcap cap_net_admin,cap_net_raw+ep /usr/local/bin/blockchain-vpn-tun-client

step "Installing control-plane daemon to /usr/share/blockchain-vpn"
sudo install -d -m 0755 /usr/share/blockchain-vpn
sudo install -m 0644 "$BACKEND_ROOT/backend/control-plane/daemon.js" /usr/share/blockchain-vpn/daemon.js
sudo install -d -m 0755 /var/lib/blockchain-vpn

step "Writing systemd unit"
sudo tee /etc/systemd/system/blockchain-vpn-control-plane.service > /dev/null <<EOF
[Unit]
Description=Blockchain VPN local control-plane (desktop UI backend)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
Environment=BVPN_HOST=127.0.0.1
Environment=BVPN_PORT=8787
Environment=BVPN_DATA_DIR=/var/lib/blockchain-vpn
ExecStart=/usr/bin/node /usr/share/blockchain-vpn/daemon.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

step "Enabling + starting blockchain-vpn-control-plane.service"
sudo systemctl daemon-reload
sudo systemctl enable --now blockchain-vpn-control-plane.service
sleep 1
sudo systemctl is-active blockchain-vpn-control-plane.service >/dev/null \
  || warn "Daemon did not become active — check 'journalctl -u blockchain-vpn-control-plane.service'"

step "Installing desktop AppImage to $DESKTOP_BIN_DIR"
install -d -m 0755 "$DESKTOP_BIN_DIR"
install -m 0755 "$TMP/blockchain-vpn.AppImage" "$DESKTOP_BIN_DIR/blockchain-vpn-desktop.AppImage"
if [[ -n "${SUDO_USER:-}" ]]; then
  chown "$USER_NAME":"$USER_NAME" "$DESKTOP_BIN_DIR/blockchain-vpn-desktop.AppImage"
fi

step "Writing menu entry to $DESKTOP_APP_DIR"
install -d -m 0755 "$DESKTOP_APP_DIR"
cat > "$DESKTOP_APP_DIR/blockchain-vpn.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Blockchain VPN
GenericName=VPN Client
Comment=Wallet-paired Noise IK VPN client
Exec=$DESKTOP_BIN_DIR/blockchain-vpn-desktop.AppImage %U
Terminal=false
Categories=Network;Security;
StartupNotify=true
StartupWMClass=Blockchain VPN
Keywords=VPN;Privacy;Network;
EOF
if [[ -n "${SUDO_USER:-}" ]]; then
  chown "$USER_NAME":"$USER_NAME" "$DESKTOP_APP_DIR/blockchain-vpn.desktop"
fi

# Refresh the desktop database if the tool is around (purely cosmetic;
# without it the menu may take a logout to pick up the new entry).
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_APP_DIR" 2>/dev/null || true
fi

# -------------------------------------------------------------------- done
cat <<EOF

\033[1;32mBlockchain VPN installed.\033[0m

  Desktop app    : $DESKTOP_BIN_DIR/blockchain-vpn-desktop.AppImage
  App-menu entry : Blockchain VPN
  Daemon         : systemctl status blockchain-vpn-control-plane

Next step:
  Launch \"Blockchain VPN\" from your app menu (or run the AppImage above).
  On first start the dashboard shows a \"Pair this device\" screen — open the
  pairing page in your browser, sign with MetaMask, paste the signature.

Uninstall:
  sudo systemctl disable --now blockchain-vpn-control-plane.service
  sudo rm /etc/systemd/system/blockchain-vpn-control-plane.service
  sudo rm /usr/local/bin/blockchain-vpn-tun-client
  sudo rm -rf /usr/share/blockchain-vpn /var/lib/blockchain-vpn
  rm $DESKTOP_BIN_DIR/blockchain-vpn-desktop.AppImage
  rm $DESKTOP_APP_DIR/blockchain-vpn.desktop

EOF
