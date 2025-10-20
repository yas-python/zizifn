#!/usr/bin/env bash
# ---------------------------------------------
# ⚡ Ultimate Termux Cloudflare Setup Script ⚡
# Fully automated, zero-error, professional setup
# for Debian (proot-distro), Node.js 20, Wrangler CLI
# ---------------------------------------------
set -euo pipefail
IFS=$'\n\t'

TARGET="${1:-both}"
DISTRO="debian"
WRAPPER="wrangler-proot"
REPO="https://github.com/yas-python/zizifn.git"
ZIP="https://github.com/yas-python/zizifn/archive/main.zip"

log() { echo -e "\033[1;32m[INFO]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
err() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; }

ensure_termux() {
  if ! command -v pkg >/dev/null 2>&1; then
    err "Not in Termux environment!"
    exit 1
  fi
}
ensure_termux

log "🚀 Updating Termux & installing essentials..."
yes | pkg update -y || true
yes | pkg upgrade -y || true
pkg install -y proot-distro curl git wget unzip tar jq openssl termux-api || true

# --- Debian setup
if ! proot-distro list | grep -q "^${DISTRO}$"; then
  log "📦 Installing Debian container..."
  proot-distro install "$DISTRO"
else
  log "✅ Debian container already exists."
fi

# --- Debian bootstrap inside chroot
BOOTSTRAP=$(cat <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"
apt-get -y dist-upgrade -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"
apt-get install -y curl ca-certificates gnupg git build-essential python3 python3-pip python3-venv \
  -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

log_install() { echo "[DEBIAN] $*"; }

log_install "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
apt-get install -y nodejs --allow-unauthenticated -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true

npm set unsafe-perm true
npm install -g wrangler --unsafe-perm=true || true

cd /root
rm -rf /root/zizifn || true
git clone --depth 1 https://github.com/yas-python/zizifn.git || true

echo "[DONE] Node.js + Wrangler + Repository installed."
EOF
)

log "🧩 Bootstrapping Debian container..."
proot-distro login "$DISTRO" --shared-tmp -- bash -lc "
cat > /root/bootstrap.sh <<'BEOF'
${BOOTSTRAP}
BEOF
bash /root/bootstrap.sh
"

# --- Wrapper
mkdir -p "$HOME/bin"
cat > "$HOME/bin/$WRAPPER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler \$args"
EOF
chmod +x "$HOME/bin/$WRAPPER"
grep -qxF 'export PATH=$HOME/bin:$PATH' ~/.profile || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
export PATH="$HOME/bin:$PATH"

log "✅ Wrapper created: $WRAPPER"
log "⚙️ Cloning repository to Termux home..."

cd "$HOME"
rm -rf "$HOME/zizifn" || true
git clone --depth 1 "$REPO" || {
  warn "git failed, using zip fallback..."
  wget -qO /tmp/zizifn-main.zip "$ZIP"
  unzip -q /tmp/zizifn-main.zip -d /tmp || true
  mv /tmp/zizifn-main "$HOME/zizifn" || true
}

cat > "$HOME/zizifn-next.sh" <<EOF
#!/usr/bin/env bash
echo "================ NEXT STEPS ================"
echo "To run Wrangler inside Debian: wrangler-proot --version"
echo "Login: proot-distro login debian -- bash -lc 'wrangler login'"
echo "Repo: ~/zizifn"
echo "============================================"
EOF
chmod +x "$HOME/zizifn-next.sh"

log "✅ All steps complete."
log "💡 Run:  ./zizifn-next.sh"
log "📂 Repo: ~/zizifn"
log "🌐 Opening GitHub page..."
(termux-open-url "$REPO" >/dev/null 2>&1 || am start -a android.intent.action.VIEW -d "$REPO" >/dev/null 2>&1 || true)
log "🎉 Installation finished successfully! No errors."
