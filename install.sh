#!/usr/bin/env bash
# ===========================================================
# 🌐 UltraX Cloudflare UltraPro Edition (v7.9)
# Fully Automated Cloudflare + GitHub Actions Environment
# Author: GPT-5 SmartOps AI
# ===========================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
IFS=$'\n\t'

echo -e "\n🧠 Initializing UltraPro Environment..."

# === [1] Termux Preparation ===
pkg update -y || true
pkg upgrade -y || true
pkg install -y proot-distro curl wget git unzip jq openssl termux-api nodejs-lts || true

# === [2] Debian Install / Reinstall if Corrupted ===
if ! proot-distro list | grep -q "^debian$"; then
  echo -e "\n📦 Installing Debian container..."
  proot-distro install debian
else
  echo -e "\n✅ Debian already installed. Repairing..."
  proot-distro login debian -- bash -lc "apt-get update -y; apt-get -f install -y" || true
fi

# === [3] Bootstrap Inside Debian ===
BOOTSTRAP=$(cat <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo -e "\n🧩 Updating Debian..."
apt-get update -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"
apt-get dist-upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

echo -e "\n📦 Installing Core Dependencies..."
apt-get install -y git curl gnupg build-essential python3 python3-pip ca-certificates openssl \
  -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

echo -e "\n🧠 Installing Node.js 20 and npm..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

npm set unsafe-perm true
npm install -g wrangler @cloudflare/pages gh || true

echo -e "\n📂 Cloning project repository..."
cd /root
rm -rf zizifn || true
git clone --depth 1 https://github.com/yas-python/zizifn.git || true

echo -e "\n🔧 Setting up GitHub CLI..."
mkdir -p /root/.config/gh
cat > /root/.config/gh/config.yml <<GEOF
git_protocol: https
prompt: disabled
GEOF

echo -e "\n🧠 Verifying installation..."
node -v
npm -v
wrangler -V
gh --version
EOF
)

echo -e "\n🚀 Executing Debian Bootstrap..."
proot-distro login debian --shared-tmp -- bash -lc "
cat > /root/bootstrap.sh <<'BEOF'
${BOOTSTRAP}
BEOF
bash /root/bootstrap.sh
"

# === [4] Add Wrappers ===
mkdir -p "$HOME/bin"
cat > "$HOME/bin/wrangler-proot" <<'EOF'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "wrangler $*"
EOF
cat > "$HOME/bin/gh-proot" <<'EOF'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "gh $*"
EOF
cat > "$HOME/bin/pages-proot" <<'EOF'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "npx @cloudflare/pages $*"
EOF

chmod +x $HOME/bin/*-proot
grep -qxF 'export PATH=$HOME/bin:$PATH' ~/.profile || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
export PATH=$HOME/bin:$PATH

# === [5] Auto Login Helper ===
cat > "$HOME/cloudflare-login.sh" <<'EOF'
#!/usr/bin/env bash
echo "🌐 Opening Cloudflare Login..."
termux-open-url "https://dash.cloudflare.com/sign-up" >/dev/null 2>&1 || am start -a android.intent.action.VIEW -d "https://dash.cloudflare.com/sign-up"
proot-distro login debian -- bash -lc "wrangler login"
EOF
chmod +x "$HOME/cloudflare-login.sh"

# === [6] Final Summary ===
echo -e "\n============================================"
echo "✅ Installation Complete – UltraX Cloudflare UltraPro"
echo "➡️ To login Cloudflare: ./cloudflare-login.sh"
echo "➡️ To run Wrangler:     wrangler-proot dev"
echo "➡️ To deploy Pages:     pages-proot deploy"
echo "➡️ To use GitHub CLI:   gh-proot auth login"
echo "============================================"
