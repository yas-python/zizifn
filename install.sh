#!/usr/bin/env bash
#
# install.sh — Termux installer for Zizifn + Wrangler (final, idempotent)
# - Installs proot-distro, creates Debian chroot (if needed)
# - Installs Node.js 20 and wrangler inside chroot
# - Clones https://github.com/yas-python/zizifn.git
# - Creates wrapper ~/bin/wrangler-proot to run wrangler from Termux host
# - Runs `wrangler login` inside chroot, extracts login URL and opens browser
#
# Usage: curl -fsSL <this-script> | bash
set -euo pipefail

# ---- config ----
LOG="$HOME/zizifn-installer.log"
DISTRO_NAME="debian"
REPO_URL="https://github.com/yas-python/zizifn.git"
REPO_DIR="$HOME/zizifn"
WRAPPER="$HOME/bin/wrangler-proot"
CHROOT_SETUP_REMOTE="/tmp/zizifn_chroot_setup.sh"
# -----------------

exec 3>&1 1>>"$LOG" 2>&1 || true
echo "=== Zizifn & Wrangler Termux Auto-Installer ===" >&3
echo "Log file: $LOG" >&3
date >&3

# helper
logh() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >&3; echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

logh "Start installer"

# Basic check: Termux prefix
if [ -z "${PREFIX:-}" ] || [[ "$PREFIX" != /data/data/*/files/usr ]]; then
  logh "Warning: PREFIX indicates this may not be Termux (PREFIX=$PREFIX). Script is designed for Termux."
fi

# Ensure HOME/bin and PATH
mkdir -p "$HOME/bin"
export PATH="$HOME/bin:$PATH"

# 1) Install Termux packages
logh "1) Installing Termux packages: proot-distro, curl, git, termux-api (if not present)..."
pkg update -y || true
pkg install -y proot-distro curl git termux-api || true

# 2) Install distribution if missing
if proot-distro list | grep -q "^$DISTRO_NAME "; then
  logh "2) $DISTRO_NAME already installed in proot-distro."
else
  logh "2) Installing $DISTRO_NAME via proot-distro (this may download ~30-40MB)..."
  proot-distro install "$DISTRO_NAME"
fi

# 3) Prepare a chroot setup script content (idempotent)
logh "3) Preparing chroot setup script"
read -r -d '' CHROOT_SCRIPT <<'EOF' || true
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt update -y
apt upgrade -y || true
apt install -y curl ca-certificates gnupg build-essential python3 python3-venv git
# Install Node.js 20 via NodeSource (works for Debian arm64/x86_64)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
# Ensure npm is present
npm --version || true
# Install wrangler globally (allow root in chroot)
if command -v wrangler >/dev/null 2>&1; then
  echo "wrangler already installed; skipping npm install"
else
  npm install -g wrangler --unsafe-perm=true || {
    echo "ERROR: npm install -g wrangler failed"
    exit 1
  }
fi
# create a non-root project folder mirror (optional)
mkdir -p /root/zizifn
EOF

# Push chroot script into chroot and execute
logh "Pushing and running chroot script inside $DISTRO_NAME..."
# Safely transfer content into chroot
proot-distro login "$DISTRO_NAME" --shared-tmp -- bash -lc "cat > $CHROOT_SETUP_REMOTE <<'SCRIPTEOF'
$(printf '%s\n' "$CHROOT_SCRIPT" | sed "s/'/'\"'\"'/g")
SCRIPTEOF
chmod +x "$CHROOT_SETUP_REMOTE"
proot-distro login "$DISTRO_NAME" --shared-tmp -- bash -lc "$CHROOT_SETUP_REMOTE"
logh "Chroot setup completed"

# 4) Clone repository on host (not inside chroot) for convenience
logh "4) Cloning repository $REPO_URL into $REPO_DIR (if needed) ..."
if [ -d "$REPO_DIR/.git" ]; then
  logh "Repo exists, pulling latest..."
  git -C "$REPO_DIR" pull || true
else
  git clone "$REPO_URL" "$REPO_DIR" || {
    logh "Warning: git clone failed; continuing (you can clone manually later)"
  }
fi

# 5) Optionally install repo npm deps inside chroot if package.json exists
if [ -f "$REPO_DIR/package.json" ]; then
  logh "5) Installing repository npm deps inside chroot..."
  # copy project into chroot root dir if not present to run installs inside chroot
  proot-distro login "$DISTRO_NAME" --shared-tmp -- bash -lc "rm -rf /root/zizifn || true"
  # using tar pipe to copy reliably
  tar -C "$REPO_DIR" -cf - . | proot-distro login "$DISTRO_NAME" --shared-tmp -- tar -C /root/zizifn -xf -
  proot-distro login "$DISTRO_NAME" --shared-tmp -- bash -lc "cd /root/zizifn && npm install --no-audit --no-fund || true"
else
  logh "No package.json in repo — skipping npm install in chroot."
fi

# 6) Create wrapper on host to call wrangler inside chroot
logh "6) Creating wrapper $WRAPPER"
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
# wrapper: run wrangler inside proot-distro debian
if [ "$#" -eq 0 ]; then
  proot-distro login debian --shared-tmp -- bash -lc "wrangler --version"
else
  proot-distro login debian --shared-tmp -- bash -lc "wrangler $*"
fi
EOF
chmod +x "$WRAPPER"

# 7) Ensure PATH setup in ~/.profile for persistent use
if [ ! -f "$HOME/.profile" ]; then
  logh "Creating ~/.profile and adding $HOME/bin to PATH"
  cat > "$HOME/.profile" <<'EOF'
# ~/.profile auto-created by install_zizifn_wrangler.sh
export PATH="$HOME/bin:$PATH"
EOF
else
  grep -qxF 'export PATH=$HOME/bin:$PATH' "$HOME/.profile" || echo 'export PATH=$HOME/bin:$PATH' >> "$HOME/.profile"
fi
# Reload profile for current session if possible
if [ -n "${BASH:-}" ]; then
  # shell is bash
  source "$HOME/.profile" 2>/dev/null || true
fi

# 8) Attempt to run 'wrangler login' inside chroot and capture URL
logh "7) Running 'wrangler login' inside chroot to get OAuth URL (if interactive)..."
OUT=$(proot-distro login "$DISTRO_NAME" --shared-tmp -- bash -lc "wrangler login 2>&1 || true" || true)
echo "$OUT" >> "$LOG"
# Try extract first https URL
URL=$(printf "%s\n" "$OUT" | grep -Eo 'https?://[^ ]+' | sed -n '1p' || true)

if [ -n "$URL" ]; then
  logh "Found login URL: $URL"
  # open on device using termux-open-url if present
  if command -v termux-open-url >/dev/null 2>&1; then
    logh "Opening URL in system browser via termux-open-url"
    termux-open-url "$URL" || logh "termux-open-url failed"
  else
    # fallback: try am start (Android intent) if available
    if command -v am >/dev/null 2>&1; then
      logh "Opening URL via am start"
      am start -a android.intent.action.VIEW -d "$URL" || logh "am start failed"
    else
      logh "No method to auto-open URL. Please open this URL manually:"
      echo "$URL" >&3
    fi
  fi
else
  logh "No URL parsed from wrangler output. Dumping output to console for manual copy-open:"
  echo "---- WRANGLER LOGIN OUTPUT BEGIN ----" >&3
  printf "%s\n" "$OUT" >&3
  echo "---- WRANGLER LOGIN OUTPUT END ----" >&3
  logh "If no interactive URL appears, consider creating a Cloudflare API Token and using it for non-interactive auth."
fi

# 9) Summarize and finish
logh "Installation finished. Key info:"
logh " - Repo dir: $REPO_DIR"
logh " - Wrapper: $WRAPPER (run 'wrangler-proot <args>')"
logh " - Log file: $LOG"
exec 1>&3 2>&3 3>&- || true
echo ""
echo "Installation finished. Please check the browser that opened (or the URL printed) and allow Wrangler access (the page like your screenshot)."
echo "If you prefer token-based auth, create a CF_API_TOKEN in Cloudflare and use wrangler with it for automation."
echo "Examples:"
echo "  wrangler-proot --version"
echo "  wrangler-proot whoami"
echo "  wrangler-proot pages publish ./public --project-name=my-pages-project"
echo ""
echo "Log file: $LOG"
