#!/data/data/com.termux/files/usr/bin/bash
# Bash Script for setting up the zizifn project with Wrangler on Termux
# This script is designed to be fully automated and robust.

# --- Color Definitions ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Start of Script ---
clear
echo -e "${BLUE}=====================================================${NC}"
echo -e "${GREEN}🚀 Zizifn Project & Cloudflare Wrangler Setup Script 🚀${NC}"
echo -e "${BLUE}=====================================================${NC}"
echo -e "\n${YELLOW}This script will automatically:${NC}"
echo "1. Update Termux packages."
echo "2. Install necessary dependencies (git, nodejs)."
echo "3. Install Cloudflare Wrangler CLI."
echo "4. Clone the zizifn project repository."
echo "5. Start the login process by opening your browser."
echo -e "\n${YELLOW}Press Enter to start the installation...${NC}"
read

# --- Step 1: Update System Packages ---
echo -e "\n${BLUE}--> Step 1: Updating Termux packages...${NC}"
pkg update -y && pkg upgrade -y
echo -e "${GREEN}System packages updated successfully!${NC}"

# --- Step 2: Install Dependencies ---
echo -e "\n${BLUE}--> Step 2: Installing core dependencies (git & nodejs)...${NC}"
pkg install -y git nodejs-lts
echo -e "${GREEN}Dependencies installed successfully!${NC}"

# --- Step 3: Install Cloudflare Wrangler ---
echo -e "\n${BLUE}--> Step 3: Installing Cloudflare Wrangler CLI via npm...${NC}"
# This command installs wrangler globally
npm install -g wrangler
echo -e "${GREEN}Wrangler installed successfully!${NC}"

# --- Step 4: Clone the Project Repository ---
echo -e "\n${BLUE}--> Step 4: Cloning the zizifn project from GitHub...${NC}"
# Check if directory exists to avoid errors on re-run
if [ -d "zizifn" ]; then
    echo -e "${YELLOW}Warning: 'zizifn' directory already exists. Skipping clone.${NC}"
else
    git clone https://github.com/yas-python/zizifn.git
fi
cd zizifn
echo -e "${GREEN}Project cloned and current directory changed to 'zizifn'.${NC}"

# --- Step 5: Initiate Cloudflare Login ---
echo -e "\n${BLUE}--> Step 5: Initiating Cloudflare login...${NC}"
echo -e "${YELLOW}A browser window will now open for you to log in and authorize Wrangler.${NC}"
echo -e "${YELLOW}Please complete the authorization in your browser.${NC}"
sleep 3

# This command automatically opens the authentication URL in the default browser
wrangler login

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}✅ All Done! The script has finished. ✅${NC}"
echo -e "${GREEN}Check your browser to complete the Cloudflare authorization.${NC}"
echo -e "${GREEN}======================================================${NC}"
