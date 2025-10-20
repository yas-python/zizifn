#!/data/data/com.termux/files/usr/bin/bash
# ────────────────────────────────────────────────
# ⚡ UltraX Cloudflare UltraPro v8.0 (Termux + Debian)
# Author: Mehdi + GPT-5 AI
# Goal: Fully automated, zero-error, smart environment builder
# ────────────────────────────────────────────────

set -e

echo -e "\n🌐 UltraX Cloudflare UltraPro v8.0 — Starting installation...\n"

# ────────────────────────────────────────────────
# 🧩 1. نصب پیش‌نیازهای Termux
# ────────────────────────────────────────────────
echo -e "\n📦 Installing Termux base packages...\n"
pkg update -y && pkg upgrade -y
pkg install -y proot-distro git curl wget nodejs npm nano

# ────────────────────────────────────────────────
# 🐧 2. نصب Debian (در صورت عدم وجود)
# ────────────────────────────────────────────────
if ! proot-distro list | grep -q "debian"; then
  echo -e "\n📥 Installing Debian environment...\n"
  proot-distro install debian
fi

# ────────────────────────────────────────────────
# 🧠 3. ایجاد اسکریپت ورود خودکار به Debian
# ────────────────────────────────────────────────
cat > $PREFIX/bin/debian-proot <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
proot-distro login debian --shared-tmp --termux-home
EOF
chmod +x $PREFIX/bin/debian-proot

# ────────────────────────────────────────────────
# ⚙️ 4. اجرای داخل Debian و نصب محیط حرفه‌ای
# ────────────────────────────────────────────────
proot-distro login debian --shared-tmp --termux-home <<'INDEBIAN'
set -e

echo -e "\n🧰 Updating Debian system...\n"
apt-get update -y
apt-get install -y git curl wget sudo nano build-essential npm nodejs python3 python3-pip

echo -e "\n🧩 Configuring npm environment...\n"
npm config set unsafe-perm true
npm config set legacy-peer-deps true

# ────────────────────────────────────────────────
# ☁️ 5. نصب ابزارهای Cloudflare + GitHub CLI
# ────────────────────────────────────────────────
echo -e "\n⚙️ Installing Wrangler + GitHub CLI...\n"
npm install -g wrangler@latest gh@latest

# بررسی نصب
echo -e "\n✅ Checking installed versions...\n"
node -v
npm -v
wrangler -V
gh --version

# ────────────────────────────────────────────────
# ⚡ 6. ساخت شورت‌کات‌های حرفه‌ای (wrangler-proot و gh-proot)
# ────────────────────────────────────────────────
mkdir -p /usr/local/bin

cat > /usr/local/bin/wrangler-proot <<'EOW'
#!/bin/bash
npx wrangler "$@"
EOW
chmod +x /usr/local/bin/wrangler-proot

cat > /usr/local/bin/gh-proot <<'EOG'
#!/bin/bash
gh "$@"
EOG
chmod +x /usr/local/bin/gh-proot

# ────────────────────────────────────────────────
# 🚀 7. تست نهایی
# ────────────────────────────────────────────────
echo -e "\n🚀 Testing Wrangler...\n"
npx wrangler --version

echo -e "\n✅ Everything installed successfully inside Debian!\n"
INDEBIAN

# ────────────────────────────────────────────────
# 🌐 8. افزودن PATH در Termux
# ────────────────────────────────────────────────
echo -e "\n🧭 Setting PATH in Termux...\n"
if ! grep -q 'export PATH=$HOME/bin:$PATH' ~/.profile; then
  echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
fi
source ~/.profile

# ────────────────────────────────────────────────
# 🎉 پایان نصب
# ────────────────────────────────────────────────
echo -e "\n🎉 UltraX Cloudflare UltraPro v8.0 installation completed successfully!\n"
echo "🪄 Available Commands:"
echo "   • debian-proot         → Login to Debian environment"
echo "   • wrangler-proot dev   → Run Wrangler locally"
echo "   • gh-proot auth login  → GitHub CLI authentication"
echo ""
echo "✨ Enjoy your fully automated, error-free environment!"
