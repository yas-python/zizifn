#!/usr/bin/env bash
# UltraX Cloudflare UltraPro Edition (v7.9) - FIXED noninteractive apt/dpkg for Termux+proot
set -euo pipefail
export LANG=C.UTF-8
IFS=$'\n\t'

echo -e "\n🧠 Initializing UltraPro Environment..."

# Termux packages (best-effort)
pkg update -y || true
pkg upgrade -y || true
pkg install -y proot-distro curl wget git unzip jq openssl termux-api nodejs-lts || true

# Ensure proot-distro present
if ! command -v proot-distro >/dev/null 2>&1; then
  echo "❗ proot-distro not found. Install Termux package 'proot-distro' and re-run."
  exit 1
fi

# Install Debian if missing, otherwise attempt repair
if ! proot-distro list | grep -q '^debian$'; then
  echo -e "\n📦 Installing Debian container..."
  proot-distro install debian
else
  echo -e "\n✅ Debian already installed. Running basic repair..."
  proot-distro login debian --shared-tmp -- bash -lc "
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    export UCF_FORCE_CONFFNEW=1
    apt-get update -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confnew' || true
    apt-get -f install -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confnew' || true
    dpkg --configure -a || true
  "
fi

# Create bootstrap script content (runs inside Debian)
BOOTSTRAP=$(cat <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export UCF_FORCE_CONFFNEW=1
export APT_LISTCHANGES_FRONTEND=none

log() { echo -e "\n[bootstrap] $*"; }

log "Updating package lists (noninteractive)..."
apt-get update -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

log "Upgrading distro (noninteractive)..."
apt-get dist-upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

log "Attempting to repair broken packages if any..."
apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
dpkg --configure -a || true

log "Installing core dependencies..."
apt-get install -y --no-install-recommends git curl gnupg build-essential python3 python3-pip ca-certificates openssl jq wget unzip \
  -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

log "Installing Node.js (NodeSource) and npm..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
apt-get install -y nodejs -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

log "Setting npm global prerequisites..."
npm set unsafe-perm true || true
npm install -g wrangler @cloudflare/pages gh || true

log "Cloning project repository (safe)..."
cd /root || exit 1
rm -rf zizifn || true
git clone --depth 1 https://github.com/yas-python/zizifn.git || true

log "Preparing gh config..."
mkdir -p /root/.config/gh
cat > /root/.config/gh/config.yml <<GEOF
git_protocol: https
prompt: disabled
GEOF

log "Verification (versions):"
node -v || true
npm -v || true
wrangler -V || true
gh --version || true

log "Bootstrap finished."
EOF
)

echo -e "\n🚀 Executing Debian Bootstrap..."
# Write and run bootstrap inside Debian
proot-distro login debian --shared-tmp -- bash -lc "cat >/root/bootstrap.sh <<'BEOF'
${BOOTSTRAP}
BEOF
bash /root/bootstrap.sh" || {
  echo -e "\n❗ Bootstrap failed. Attempting final repair commands inside Debian..."
  proot-distro login debian --shared-tmp -- bash -lc "
    export DEBIAN_FRONTEND=noninteractive
    export UCF_FORCE_CONFFNEW=1
    apt-get -f install -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confnew' || true
    dpkg --configure -a || true
  "
  echo -e "🟠 If problem persists, run inside proot: dpkg --configure -a && apt-get -f install -y"
}

# Wrappers
mkdir -p "$HOME/bin"
cat > "$HOME/bin/wrangler-proot" <<'EOF'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler $*"
EOF
cat > "$HOME/bin/gh-proot" <<'EOF'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; gh $*"
EOF
cat > "$HOME/bin/pages-proot" <<'EOF'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; npx @cloudflare/pages $*"
EOF
chmod +x "$HOME/bin/"*-proot
grep -qxF 'export PATH=$HOME/bin:$PATH' ~/.profile || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
export PATH=$HOME/bin:$PATH

# Cloudflare login helper
cat > "$HOME/cloudflare-login.sh" <<'EOF'
#!/usr/bin/env bash
echo "🌐 Opening Cloudflare Login..."
termux-open-url "https://dash.cloudflare.com/sign-up" >/dev/null 2>&1 || am start -a android.intent.action.VIEW -d "https://dash.cloudflare.com/sign-up"
proot-distro login debian -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler login"
EOF
chmod +x "$HOME/cloudflare-login.sh"

echo -e "\n============================================"
echo "✅ Installation Complete – UltraX Cloudflare UltraPro (fixed)"
echo "➡️ To login Cloudflare: ./cloudflare-login.sh"
echo "➡️ To run Wrangler:     wrangler-proot dev"
echo "➡️ To deploy Pages:     pages-proot deploy"
echo "➡️ To use GitHub CLI:   gh-proot auth login"
echo "============================================"
