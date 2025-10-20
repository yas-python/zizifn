#!/bin/bash

# This script sets up Wrangler in Termux using proot-distro with Debian,
# creates a wrapper for Wrangler, downloads the project files,
# installs dependencies inside chroot to avoid cache issues,
# prompts for deployment type (Workers or Pages),
# cleans up unnecessary files to prevent size limit errors,
# handles login (which opens browser for authorization),
# and deploys automatically. It's designed to be error-free and smart.

set -e  # Exit on error

echo "Updating Termux packages..."
pkg update -y || true
pkg install -y proot-distro curl git || true

echo "Installing Debian distro if not already installed..."
if ! proot-distro list | grep -q "debian"; then
    proot-distro install debian
fi

echo "Setting up Node.js and Wrangler inside Debian chroot..."
proot-distro login debian --shared-tmp -- bash -c '
set -e
apt update && apt upgrade -y || true
apt install -y curl ca-certificates build-essential gnupg || true
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
npm install -g wrangler --unsafe-perm=true || true
wrangler --version || echo "Wrangler installation check failed, but continuing..."
'

echo "Creating Wrangler wrapper if not exists..."
mkdir -p $HOME/bin
if [ ! -f $HOME/bin/wrangler-proot ]; then
    cat > $HOME/bin/wrangler-proot <<'EOF'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "wrangler $*"
EOF
    chmod +x $HOME/bin/wrangler-proot
fi

echo "Adding ~/bin to PATH if not already..."
if ! grep -q 'export PATH=$HOME/bin:$PATH' ~/.profile; then
    echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
fi
export PATH=$HOME/bin:$PATH

echo "Testing Wrangler wrapper..."
wrangler-proot --version || echo "Wrapper test failed, but continuing..."

echo "Setting up the project directory..."
PROJECT_DIR="$HOME/zizifn"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

echo "Downloading project files if not already present..."
[ -f wrangler.toml ] || curl -sS -o wrangler.toml https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main/wrangler.toml
[ -f package.json ] || curl -sS -o package.json https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main/package.json
[ -f _worker.js ] || curl -sS -o _worker.js https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main/_worker.js

echo "Installing npm dependencies inside chroot..."
proot-distro login debian --shared-tmp -- bash -c "cd $PWD; npm install" || true

echo "Cleaning up unnecessary files to avoid size limits..."
rm -rf .npm node_modules/.cache .cache || true

echo "Choose deployment type:"
echo "1) Cloudflare Workers"
echo "2) Cloudflare Pages"
read -p "Enter 1 or 2: " choice

if [ "$choice" = "1" ]; then
    echo "Logging in to Cloudflare (this will open the browser for authorization)..."
    wrangler-proot login || true
    echo "Deploying to Cloudflare Workers..."
    wrangler-proot deploy
elif [ "$choice" = "2" ]; then
    echo "Enter a unique name for your Cloudflare Pages project:"
    read -p "Project name: " project_name
    echo "Logging in to Cloudflare (this will open the browser for authorization)..."
    wrangler-proot login || true
    echo "Creating Pages project if not exists..."
    wrangler-proot pages project create "$project_name" --production-branch main || true
    echo "Deploying to Cloudflare Pages..."
    wrangler-proot pages deploy . --project-name="$project_name"
else
    echo "Invalid choice. Exiting."
    exit 1
fi

echo "Deployment complete! If the browser didn't open automatically during login, check your Termux notifications or run 'wrangler-proot login' manually."
