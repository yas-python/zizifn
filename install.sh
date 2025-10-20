#!/usr/bin/env bash
# install_zizifn_wrangler.sh
# Termux installer: proot-distro Debian + Node + wrangler + clone & checks + open Cloudflare OAuth
# Designed to be robust: detects arch, installs dependencies, creates wrapper, opens login URL.
set -euo pipefail
LOG="$HOME/zizifn-installer.log"
exec 3>&1 1>>"$LOG" 2>&1

echo "=== Zizifn & Wrangler Termux Auto-Installer ===" >&3
echo "Log: $LOG" >&3
date >&3

# helper: print both to stdout and log
log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >&3; echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# 0. sanity: must run in Termux
if [ -z "${PREFIX:-}" ] || [[ "$PREFIX" != /data/data/*/files/usr ]]; then
  log "Warning: This script is intended for Termux. PREFIX=$PREFIX"
fi

# 1. update termux and install basic packages
log "1) Updating Termux packages and installing core packages..."
pkg update -y || true
pkg install -y proot-distro curl git termux-api || true

# Ensure bin dir
mkdir -p "$HOME/bin"
export PATH="$HOME/bin:$PATH"

# 2. install proot-distro Debian if not exists
DIST_NAME=debian
if proot-distro list | grep -q "^$DIST_NAME "; then
  log "proot-distro: $DIST_NAME already installed."
else
  log "Installing proot-distro $DIST_NAME (may take time)..."
  proot-distro install "$DIST_NAME"
fi

# 3. ensure Debian chroot has node + npm + wrangler
log "3) Ensuring Debian chroot has Node.js and wrangler..."
# Create a small script to run inside chroot to idempotently install Node and wrangler
CHROOT_SETUP_SCRIPT="/tmp/zizifn_chroot_setup.sh"
cat > "$CHROOT_SETUP_SCRIPT" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
apt update -y
apt install -y curl ca-certificates gnupg build-essential python3 python3-venv
# Install Node.js 20 via NodeSource (arm64/x64 handled by distro)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
# npm may warn about new version, ignore
# Install wrangler globally (allow unsafe-perm for root in chroot)
npm install -g wrangler --unsafe-perm=true || { echo "wrangler install failed"; exit 1; }
# Show versions
node -v || true
npm -v || true
wrangler --version || true
EOF

chmod +x "$CHROOT_SETUP_SCRIPT"
log "Running chroot setup script (this may take several minutes)..."
proot-distro login "$DIST_NAME" --shared-tmp -- bash -lc "cat > /tmp/zizifn_chroot_setup.sh <<'SCRIPTEOF'
$(sed 's/\\/\\\\/g; s/\$/\\$/g' "$CHROOT_SETUP_SCRIPT")
SCRIPTEOF
chmod +x /tmp/zizifn_chroot_setup.sh
/tmp/zizifn_chroot_setup.sh
# keep chroot script output visible in host log
log "Chroot setup finished."

# 4. clone the repository and basic checks
REPO_URL="https://github.com/yas-python/zizifn.git"
TARGET="$HOME/zizifn"
if [ -d "$TARGET/.git" ]; then
  log "Repository already cloned at $TARGET. Pulling latest..."
  git -C "$TARGET" pull || log "git pull failed"
else
  log "Cloning repository $REPO_URL into $TARGET..."
  git clone "$REPO_URL" "$TARGET"
fi

log "Listing repository top-level files:"
ls -la "$TARGET" | sed -n '1,200p' >&3

# Optional: if project has package.json, install deps inside chroot (safe)
if [ -f "$TARGET/package.json" ]; then
  log "Detected package.json — installing npm deps inside chroot..."
  proot-distro login "$DIST_NAME" --shared-tmp -- bash -lc "cd /root/$(basename "$TARGET") && npm install --no-audit --no-fund || true"
else
  log "No package.json found — skipping npm install."
fi

# 5. create wrapper on host to run wrangler inside chroot
WRAPPER="$HOME/bin/wrangler-proot"
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
# wrapper: run wrangler inside proot-distro debian
proot-distro login debian --shared-tmp -- bash -lc "wrangler $*"
EOF
chmod +x "$WRAPPER"
log "Created wrapper: $WRAPPER"

# 6. ensure ~/bin is in shell startup (create ~/.profile if needed)
if [ ! -f "$HOME/.profile" ]; then
  log "Creating ~/.profile and exporting PATH..."
  cat > "$HOME/.profile" <<'EOF'
# ~/.profile created by install_zizifn_wrangler.sh
export PATH="$HOME/bin:$PATH"
EOF
else
  grep -qxF 'export PATH=$HOME/bin:$PATH' "$HOME/.profile" || echo 'export PATH=$HOME/bin:$PATH' >> "$HOME/.profile"
fi
# load it for current session
. "$HOME/.profile" || true

# 7. attempt to run wrangler login inside chroot and capture login URL
log "7) Running 'wrangler login' inside chroot and attempting to open the OAuth URL in device browser..."
# Run wrangler login inside chroot and capture stdout/stderr to host var
OUT=$(proot-distro login "$DIST_NAME" --shared-tmp -- bash -lc "wrangler login 2>&1" || true)
echo "$OUT" >> "$LOG"
# Try to extract the first https URL from the output
URL=$(printf "%s\n" "$OUT" | grep -Eo 'https?://[^ ]+' | sed -n '1p' || true)

if [ -n "$URL" ]; then
  log "Found URL: $URL"
  # If termux-open-url is available, use it to open the system browser
  if command -v termux-open-url >/dev/null 2>&1; then
    log "Opening URL in device browser using termux-open-url..."
    termux-open-url "$URL" || log "termux-open-url failed"
  else
    log "termux-open-url not found. Please open this URL in your browser manually:"
    echo "$URL" >&3
  fi
else
  log "Could not automatically parse login URL from wrangler output."
  log "Fallback: show full wrangler output — please copy the login link and open in browser:"
  echo "---------------- wrangler login output start ----------------" >&3
  printf "%s\n" "$OUT" >&3
  echo "---------------- wrangler login output end ------------------" >&3
  log "If no link present, consider creating a Cloudflare API token and using it with wrangler (recommended for automation)."
fi

# 8. final messages
log "Installation complete. Check the log at $LOG"
echo ""
echo "USAGE EXAMPLES (host Termux):" >&3
echo "  wrangler-proot --version" >&3
echo "  wrangler-proot whoami" >&3
echo "  wrangler-proot pages publish ./public --project-name=my-pages-project" >&3
echo ""
echo "If OAuth page opened, follow steps in browser to Allow Wrangler access (the page like your screenshot)." >&3
echo "If you prefer token-based auth, generate CF_API_TOKEN from Cloudflare dashboard and set it as an env var." >&3

# finish
exec 1>&3 2>&3 3>&-  # restore stdout/stderr to terminal
log "Script finished at $(date)."
