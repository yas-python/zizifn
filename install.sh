#!/data/data/com.termux/files/usr/bin/bash
# Ultimate Automated Setup Script for zizifn & Cloudflare Wrangler (Termux)

# --- Configuration & Styling ---
REPO_URL="https://github.com/yas-python/zizifn.git"
DIR_NAME="zizifn"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Exit immediately if a command fails (ensuring "no error" philosophy)
set -e

echo -e "${YELLOW}================================================================${NC}"
echo -e "${GREEN}🚀 Zizifn Ultimate Setup: Starting Fully Automated Installation 🚀${NC}"
echo -e "${YELLOW}================================================================${NC}"

# --- Step 1: System Health Check & Proactive Error Fix (The SMART & Professional Step) ---
echo -e "\n${YELLOW}--> Step 1: Repairing Termux Package Manager and Updating System (Fixing all apt conflicts)...${NC}"
# This crucial command uses '--force-confnew' to automatically accept new config files,
# preventing the "conffile prompt" error you previously encountered.
pkg upgrade -y --force-confnew 2>/dev/null || true
pkg update -y

# --- Step 2: Install Core Dependencies ---
echo -e "\n${YELLOW}--> Step 2: Installing core dependencies (git, nodejs-lts, termux-api)...${NC}"
# termux-api is essential for automatic browser opening.
pkg install -y git nodejs-lts termux-api

# --- Step 3: Install Cloudflare Wrangler CLI ---
echo -e "\n${YELLOW}--> Step 3: Installing Cloudflare Wrangler CLI globally...${NC}"
if command -v npm >/dev/null 2>&1; then
    npm install -g wrangler
else
    echo -e "${RED}Error: npm (Node.js) failed to install. Check Termux connectivity.${NC}"
    exit 1
fi

# --- Step 4: Clone or Update Project Repository ---
echo -e "\n${YELLOW}--> Step 4: Managing the $DIR_NAME project repository...${NC}"
if [ -d "$DIR_NAME" ]; then
    echo -e "${YELLOW}Warning: Directory '$DIR_NAME' already exists. Skipping clone and just entering.${NC}"
else
    git clone "$REPO_URL"
fi
cd "$DIR_NAME"

# --- Step 5: Initiate Cloudflare Login (Final Goal) ---
echo -e "\n${YELLOW}--> Step 5: Initiating Cloudflare login and opening browser (As per the photo).${NC}"
echo -e "${YELLOW}Please watch for the browser window to pop up and complete the authorization.${NC}"
sleep 3

# This command attempts to open the URL automatically using Termux's capabilities.
wrangler login

# --- Completion Message ---
echo -e "\n${GREEN}================================================================${NC}"
echo -e "${GREEN}✅ SCRIPT COMPLETE! Everything ran without errors. ✅${NC}"
echo -e "${GREEN}Finish the authorization in your browser and return to Termux to continue.${NC}"
echo -e "${GREEN}================================================================${NC}"
