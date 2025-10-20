#!/usr/bin/env bash
# zizifn-termux-setup.sh
# Universal, robust and mostly-noninteractive Termux installer for:
# - proot-distro + Debian chroot
# - Node.js 20 inside chroot
# - wrangler (npm) inside chroot
# - wrapper to call wrangler from Termux
# - clone and quick-check of https://github.com/yas-python/zizifn.git
# - supports "workers", "pages", or "both" as install target
#
# Usage:
#   ./zizifn-termux-setup.sh [workers|pages|both] [conf_behavior]
#   conf_behavior: "maintainer" (install package maintainer's config) or "keep" (keep current) [default: maintainer]
#
# Example:
#   ./zizifn-termux-setup.sh both maintainer
#
set -euo pipefail
IFS=$'\n\t'

### ---------- Configurable variables ----------
TARGET="${1:-both}"         # workers | pages | both
CONF_BEHAVIOR="${2:-maintainer}" # maintainer | keep

# Name of proot-distro container
DISTRO_NAME="debian"

# repo to inspect/clone
REPO_URL="https://github.com/yas-python/zizifn.git"
REPO_ZIP="https://github.com/yas-python/zizifn/archive/main.zip"

# wrapper name
WRAPPER_NAME="wrangler-proot"

# choose dpkg conf option based on user variable
if [[ "$CONF_BEHAVIOR" == "keep" ]]; then
  # keep current installed config files
  DPKG_CONF_OPT='-o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef"'
else
  # install package maintainer's version (default)
  DPKG_CONF_OPT='-o Dpkg::Options::="--force-confnew" -o Dpkg::Options::="--force-confdef"'
fi

### ---------- helper functions ----------
log() { printf "\e[1;32m[INFO]\e[0m %s\n" "$*"; }
warn() { printf "\e[1;33m[WARN]\e[0m %s\n" "$*"; }
err() { printf "\e[1;31m[ERROR]\e[0m %s\n" "$*" >&2; }

ensure_termux() {
  if ! command -v pkg >/dev/null 2>&1; then
    err "This script is intended to run in Termux. 'pkg' not found."
    exit 1
  fi
}

ensure_termux

log "Target: $TARGET"
log "dpkg conf behavior: $CONF_BEHAVIOR"

### ---------- Stage 1: Update Termux & install base packages ----------
log "Updating Termux pkg repositories and installing base packages..."
pkg update -y
pkg upgrade -y

# essential packages in Termux
pkg install -y proot-distro curl git wget unzip tar jq openssl termux-api

# termux-api gives termux-open/termux-open-url if available
# If proot-distro isn't present this will install above. If already installed we continue.

### ---------- Stage 2: Install proot-distro Debian if needed ----------
if proot-distro list | grep -qi "^${DISTRO_NAME}$"; then
  log "proot-distro '${DISTRO_NAME}' already installed. Skipping proot-distro install."
else
  log "Installing proot-distro '${DISTRO_NAME}' (Debian)..."
  proot-distro install "${DISTRO_NAME}"
fi

### ---------- Stage 3: Prepare commands to run inside chroot ----------
# We'll create a single "bootstrap" script inside $HOME that will be copied into chroot home and run there.
CHROOT_BOOTSTRAP="/data/data/$(whoami)/bootstrap-${DISTRO_NAME}.sh"
# But proot-distro's chroot home will be /root or /home? We'll place file into Termux home and then use proot-distro login ... --copy-in if needed.
# Simpler: we'll use proot-distro login ... -- bash -lc "cat > /root/bootstrap.sh <<'EOF' && bash /root/bootstrap.sh"
# So we'll build an inline here-doc.

NODE_SETUP_SCRIPT=$(cat <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ensure apt is usable
apt update -y
apt upgrade -y

# install base tools inside chroot
apt install -y curl ca-certificates gnupg build-essential ca-certificates git python3 python3-venv python3-pip

# install Node.js 20 (Nodesource)
# nodesource script may add sources; allow failure fallback to distro node if nodesource fails
if command -v curl >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
fi
apt-get install -y nodejs || apt-get install -y nodejs --allow-unauthenticated || true

# check node version
node -v || true
npm -v || true

# Allow npm global installs in chroot (we're root inside container)
npm set unsafe-perm true

# Install wrangler globally
npm install -g wrangler --unsafe-perm=true || { echo "wrangler install failed"; exit 0; }

# Install git inside chroot (already done) and clone repo copy for chroot inspection
cd /root || exit 0
if [ -d "/root/zizifn" ]; then
  rm -rf /root/zizifn || true
fi
git clone --depth 1 REPO_URL_PLACEHOLDER || true

# simple wrangler version check
wrangler --version || true

echo "CHROOT BOOTSTRAP COMPLETE"
EOF
)

# replace placeholder with actual repo url safely (escape)
NODE_SETUP_SCRIPT="${NODE_SETUP_SCRIPT//REPO_URL_PLACEHOLDER/${REPO_URL}}"

log "Running bootstrap inside chroot (this will run apt/node/wrangler setup). This may take several minutes..."
# Run the chroot bootstrap non-interactively, applying dpkg conf options
# We wrap apt calls with DEBIAN_FRONTEND and pass dpkg options to apt-get via -o flags.
proot-distro login "${DISTRO_NAME}" --shared-tmp -- bash -lc "
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# Apply dpkg conf options globally for this session via APT
APT_OPTS='${DPKG_CONF_OPT}'
# write script
cat > /root/bootstrap-termux.sh <<'BEOF'
${NODE_SETUP_SCRIPT}
BEOF
chmod +x /root/bootstrap-termux.sh
# run apt with dpkg options by prefixing env options on apt-get inside the script
# inside the bootstrap script apt/apt-get will run normally; we also re-run apt-get here to ensure dpkg options applied
eval apt-get update ${DPKG_CONF_OPT} -y || true
# run the bootstrap (this contains its own apt calls which will respect DEBIAN_FRONTEND)
bash /root/bootstrap-termux.sh
"

log "Chroot bootstrap finished."

### ---------- Stage 4: Create wrapper on Termux side to call wrangler inside chroot ----------
log "Creating wrapper '$WRAPPER_NAME' in \$HOME/bin ..."
mkdir -p "$HOME/bin"
cat > "$HOME/bin/$WRAPPER_NAME" <<'EOF'
#!/usr/bin/env bash
# wrapper: run wrangler inside proot-distro debian from Termux
# usage: wrangler-proot <wrangler-args...>
set -euo pipefail
args="\$*"
# ensure proot-distro exists
if ! command -v proot-distro >/dev/null 2>&1; then
  echo "proot-distro not found"
  exit 1
fi
# run wrangler inside the debian container; preserve TERM and HOME
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler \$args"
EOF
chmod +x "$HOME/bin/$WRAPPER_NAME"

# ensure ~/bin is in PATH
grep -qxF 'export PATH=$HOME/bin:$PATH' ~/.profile || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
# load PATH for current session
export PATH="$HOME/bin:$PATH"

log "Wrapper created. You can run: $WRAPPER_NAME --version"

### ---------- Stage 5: Clone repo in Termux home for inspection (outside chroot) ----------
log "Cloning repository into Termux home for inspection: $REPO_URL"
cd "$HOME"
if [ -d "$HOME/zizifn" ]; then
  log "Removing existing $HOME/zizifn (stale) ..."
  rm -rf "$HOME/zizifn" || true
fi
git clone --depth 1 "$REPO_URL" || {
  warn "git clone failed, attempting zip fallback..."
  wget -qO /tmp/zizifn-main.zip "$REPO_ZIP" || { warn "zip download failed"; }
  unzip -q /tmp/zizifn-main.zip -d /tmp || true
  if [ -d /tmp/zizifn-main ]; then
    mv /tmp/zizifn-main "$HOME/zizifn" || true
  fi
}

# quick scan: list top-level files and detect package.json or wrangler.toml
log "Repository top-level files:"
ls -la "$HOME/zizifn" | sed -n '1,120p' || true

if [ -f "$HOME/zizifn/package.json" ]; then
  log "Found package.json — printing name/version:"
  jq -r '{name: .name, version: .version} | select(.name != null) ' "$HOME/zizifn/package.json" || true
fi

if [ -f "$HOME/zizifn/wrangler.toml" ]; then
  log "Found wrangler.toml in repo."
fi

### ---------- Stage 6: Optional: configure wrangler for workers/pages inside chroot ----------
# Provide user-friendly config files: we won't auto-publish but will prepare environment.
log "Preparing example wrangler commands for target: $TARGET"
prepare_cmds="echo 'No publish executed; review before publishing.'"
if [[ "$TARGET" == "workers" || "$TARGET" == "both" ]]; then
  prepare_cmds="$prepare_cmds
echo 'Workers target selected. Inside chroot you can run: wrangler publish --env production'
"
fi
if [[ "$TARGET" == "pages" || "$TARGET" == "both" ]]; then
  prepare_cmds="$prepare_cmds
echo 'Pages target selected. Inside chroot you can run: wrangler pages publish ./ --project-name=...'
"
fi

# Save small helper script in home to show next steps
cat > "$HOME/zizifn-next-steps.sh" <<EOF
#!/usr/bin/env bash
echo "================ NEXT STEPS ================"
echo "To use wrangler inside the Debian chroot from Termux, run:"
echo "  $WRAPPER_NAME --version"
echo ""
echo "To login interactively (opens login flow inside chroot):"
echo "  proot-distro login ${DISTRO_NAME} --shared-tmp -- bash -lc 'wrangler login'"
echo ""
echo "Repository cloned at: $HOME/zizifn"
echo ""
$prepare_cmds
echo ""
EOF
chmod +x "$HOME/zizifn-next-steps.sh"

### ---------- Stage 7: Show summary info ----------
log "INSTALLATION SUMMARY:"
log " - Debian container: ${DISTRO_NAME}"
log " - wrangler wrapper: $HOME/bin/$WRAPPER_NAME"
log " - repo cloned: $HOME/zizifn"
log " - next-steps helper: $HOME/zizifn-next-steps.sh"

### ---------- Stage 8: Attempt to open browser to repo (Android) ----------
open_url() {
  url="$1"
  # try termux-open-url first
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "$url" >/dev/null 2>&1 || true
    return 0
  fi
  # older termux uses termux-open
  if command -v termux-open >/dev/null 2>&1; then
    termux-open "$url" >/dev/null 2>&1 || true
    return 0
  fi
  # fallback to am start (Android intent) if available
  if command -v am >/dev/null 2>&1; then
    am start -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1 || true
    return 0
  fi
  warn "Could not open browser automatically. Please open: $url"
  return 1
}

log "Opening repository page in Android browser..."
open_url "$REPO_URL" || warn "Open browser failed; see $HOME/zizifn"

log "Done. Run '$HOME/zizifn-next-steps.sh' for actionable next commands."
