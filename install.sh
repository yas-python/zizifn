#!/bin/bash
#=================================================================================
# Ultimate Cloudflare Auto-Installer & Manager (Termux Edition)
# Version: 7.0 "CRITICAL Pages Deployment Fix & Ultimate Robustness"
# Description: Fully automated, error-free script for Termux/Debian.
# Changelog (7.0):
#   - CRITICAL FIX: Pages project deployment logic refined to ensure `wrangler` 
#     correctly detects the site content after ZIP extraction, resolving 
#     'Deployment of Pages project failed' error by separating source preparation 
#     from the final deploy command.
#   - ENHANCEMENT: Improved directory handling and cleanup for pages to ensure 
#     only the core site files are deployed.
#=================================================================================

# Exit immediately if a command exits with a non-zero status.
set -e

# --- ANSI Color Codes ---
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# --- Helper Functions (Installation Phase - Minimal Changes for Stability) ---
print_header() {
    echo -e "${CYAN}=====================================================================${NC}"
    echo -e "${YELLOW}$1${NC}"
    echo -e "${CYAN}=====================================================================${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ ERROR: $1. Aborting script.${NC}"
    exit 1
}

# --- Main Logic (Installation: Identical to 6.0 for environment stability) ---

# 1. Prepare Termux Environment
print_header "Step 1: Preparing Termux Environment"
DEBIAN_FRONTEND=noninteractive pkg update -y || print_error "Failed to update pkg"
DEBIAN_FRONTEND=noninteractive pkg upgrade -y -o Dpkg::Options::="--force-confnew" || print_error "Failed to upgrade pkg"
pkg install proot-distro unzip -y || print_error "Failed to install proot-distro or unzip"
print_success "Termux setup complete."

# 2. Install Debian
if ! proot-distro list | grep -q "debian"; then
    print_header "Step 2: Installing Debian with proot-distro"
    echo "This may take several minutes..."
    proot-distro install debian || print_error "Failed to install Debian"
    print_success "Debian installed successfully."
fi

# 3. Setup Debian Environment
print_header "Step 3: Setting up Debian Environment"

proot-distro login debian -- bash -c "
    set -e
    export DEBIAN_FRONTEND=noninteractive
    
    echo -e '${YELLOW}... Updating apt package lists ...${NC}'
    apt update -y
    
    echo -e '${YELLOW}... Upgrading packages ...${NC}'
    apt upgrade -y -o Dpkg::Options::=\"--force-confnew\"
    
    echo -e '${YELLOW}... Installing core dependencies (curl, jq, gnupg, grep, unzip) ...${NC}'
    apt install -y curl jq gnupg grep unzip
    
    echo -e '${YELLOW}... Installing modern NodeJS (LTS) ...${NC}'
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    
    echo -e '${YELLOW}... Installing wrangler globally ...${NC}'
    npm install -g wrangler

" || print_error "Failed to set up Debian environment."

print_success "Debian environment is fully configured."

# 4. Create the Advanced Management Script inside Debian (The core fix is here)
print_header "Step 4: Creating Advanced Cloudflare Manager (v7.0 - Ultimate Deployment Fix)"

# Use a quoted heredoc to pass the script content without expansion.
proot-distro login debian -- bash -c "cat > /root/cf_manager.sh" << 'EOF_MANAGER_SCRIPT'
#!/bin/bash
#=================================================================================
# Advanced Cloudflare Management Script (v7.0 - Ultimate Pages Fix)
# Designed for Proot/Termux/Debian environment
#=================================================================================

# --- ANSI Color Codes ---
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Helper Functions ---
print_menu_header() {
    echo -e "\n${CYAN}--- Cloudflare Management Menu (v7.0 - Ultimate Fix) ---${NC}"
}

# Forces the 'read' command to listen directly to the keyboard for high stability.
read_input() {
    local prompt="$1"
    local variable_name="$2"
    echo -e "${YELLOW}$prompt${NC}"
    # Read directly from the terminal device for robustness in Termux/Proot
    read -r "$variable_name" < /dev/tty
}

press_enter_to_continue() {
    echo -e "\n${YELLOW}Press [Enter] to return to the menu...${NC}"
    read -r < /dev/tty
}

# --- Dynamic Pages ZIP Fix Function ---
function get_pages_zip_url() {
    local url="$1"
    local fixed_url
    
    # 1. Check if the URL is already a direct ZIP link (e.g., archive/refs/heads/main.zip)
    if [[ "$url" =~ \.zip$ ]]; then
        echo -e "${GREEN}Source is already a direct ZIP link. Proceeding.${NC}"
        echo "$url"
        return
    fi
    
    # 2. Check and convert a standard GitHub repository URL (CRITICAL FIX for Pages deployment)
    if [[ "$url" =~ ^https://github.com/([^/]+)/([^/]+)/?$ ]]; then
        local user_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
        
        # Try to find the default branch (main or master)
        fixed_url="https://github.com/${user_repo}/archive/refs/heads/main.zip"
        
        if ! curl --head --fail --silent "$fixed_url" > /dev/null; then
            fixed_url="https://github.com/${user_repo}/archive/refs/heads/master.zip"
            if ! curl --head --fail --silent "$fixed_url" > /dev/null; then
                 echo -e "${RED}Error: Cannot find 'main' or 'master' branch ZIP for this GitHub repository. Operation cancelled.${NC}"
                 return 1
            fi
        fi

        echo -e "${GREEN}Converted GitHub URL to direct ZIP download URL:${NC}"
        echo -e "${CYAN}$fixed_url${NC}"
        echo "$fixed_url"
        return
    fi
    
    # 3. If it's a raw file or an unknown URL type
    echo -e "${YELLOW}Source URL seems to be a raw file or non-GitHub URL. Proceeding with caution...${NC}"
    echo "$url"
}

# --- Dynamic Fetch Function (Combined and Improved) ---
function fetch_and_deploy() {
    local url="$1"
    local target_file="$2"
    local project_dir="$3"
    local is_pages="$4"
    local status=0

    echo -e "${CYAN}Downloading content from: ${GREEN}$url${NC}"
    
    if [[ "$is_pages" == "true" ]]; then
        # --- Pages Deployment Source Preparation ---
        
        local download_url
        download_url=$(get_pages_zip_url "$url")
        
        if [[ -z "$download_url" || "$download_url" == "1" ]]; then
            return 1
        fi
        
        # 1. Download the ZIP file
        echo -e "${YELLOW}Downloading ZIP content from the corrected URL...${NC}"
        if ! curl -L "$download_url" -o "$project_dir/source.zip"; then
            echo -e "${RED}Failed to download the ZIP file. The link may be broken.${NC}"
            return 1
        fi
        
        # 2. Extract the content (CRITICAL: Handle the root folder created by GitHub ZIPs)
        echo -e "${YELLOW}Extracting ZIP file into ${GREEN}$project_dir${NC}...${NC}"
        
        mkdir -p "$project_dir/temp_extract"
        if ! unzip -q "$project_dir/source.zip" -d "$project_dir/temp_extract"; then
            echo -e "${RED}Failed to extract the ZIP file. The file is corrupted or invalid (ZIP ERROR FIX).${NC}"
            status=1
        else
            # Move contents from the single root folder created by GitHub ZIPs (e.g., repo-main/)
            local root_folder
            root_folder=$(find "$project_dir/temp_extract" -maxdepth 1 -mindepth 1 -type d -print -quit)
            
            if [[ -d "$root_folder" ]]; then
                echo -e "${YELLOW}Moving extracted contents from '$root_folder' to the project root (Deployment FIX)...${NC}"
                # Use -T for overwrite, and mv for moving the contents, ensuring all files are moved
                mv "$root_folder"/* "$project_dir/" 2>/dev/null 
                mv "$root_folder"/.* "$project_dir/" 2>/dev/null # Handle hidden files
            else
                # Fallback: move everything directly from temp to project_dir
                mv "$project_dir/temp_extract"/* "$project_dir/" 2>/dev/null
                mv "$project_dir/temp_extract"/.* "$project_dir/" 2>/dev/null
            fi
            echo -e "${GREEN}Extraction and file preparation complete! Pages source is ready.${NC}"
        fi
        
        # 3. Final Clean up
        rm -rf "$project_dir/temp_extract" 2>/dev/null
        rm "$project_dir/source.zip" 2>/dev/null
        
        return $status
    else
        # Worker Deployment (Standard single-file download)
        if ! curl -L "$url" -o "$project_dir/$target_file"; then
            echo -e "${RED}Failed to download the Worker script file.${NC}"
            return 1
        fi
        echo -e "${GREEN}Worker file downloaded successfully!${NC}"
        return 0
    fi
}

# --- Cloudflare Functions (The menu logic) ---

function login_to_cloudflare() {
    # Existing login logic (stable)
    local whoami_output
    whoami_output=$(wrangler whoami 2>&1)

    if echo "$whoami_output" | grep -q "You are not authenticated"; then
        echo -e "${YELLOW}Authentication token is invalid or missing. Starting new login automatically...${NC}"
        echo -e "A login link will appear. Open it in your browser and click '${GREEN}Allow${NC}'."
        if ! wrangler login; then
            echo -e "${RED}Login failed. Please try again.${NC}"
            exit 1
        fi
        echo -e "${GREEN}Authentication successful!${NC}"
        wrangler whoami
    else
        echo -e "${GREEN}You are currently logged into Cloudflare as:${NC}"
        echo "$whoami_output"
        read_input "Do you want to log in with a different account? (y/n)" re_login
        if [[ "$re_login" == "y" ]]; then
            echo -e "${YELLOW}Starting new login...${NC}"
            wrangler login
            echo -e "${GREEN}Authentication successful!${NC}"
            wrangler whoami
        fi
    fi
}

function create_vless_worker() {
    # Existing Worker creation logic (stable)
    set -e
    echo -e "${CYAN}--- Create a New VLESS Worker (Dynamic Source) ---${NC}"
    
    read_input "Enter a name for your new worker (e.g., my-vless-proxy):" WORKER_NAME
    if [[ -z "$WORKER_NAME" ]]; then echo -e "${RED}Name cannot be empty. Operation cancelled.${NC}"; return; fi
    
    read_input "Enter the FULL URL of your Worker script (e.g., https://raw.githubusercontent.com/.../_worker.js):" WORKER_URL
    if [[ -z "$WORKER_URL" ]]; then echo -e "${RED}Source URL cannot be empty. Operation cancelled.${NC}"; return; fi
    
    PROJECT_DIR="/tmp/$WORKER_NAME"
    echo -e "${YELLOW}Creating project directory: ${GREEN}$PROJECT_DIR${NC}...${NC}"
    mkdir -p "$PROJECT_DIR"
    cd "$PROJECT_DIR"

    if ! fetch_and_deploy "$WORKER_URL" "index.js" "$PROJECT_DIR" "false"; then
        cd - > /dev/null
        rm -rf "$PROJECT_DIR"
        return
    fi

    echo -e "${YELLOW}Generating wrangler.toml...${NC}"
    cat << EOF > wrangler.toml
name = "$WORKER_NAME"
main = "index.js"
compatibility_date = "$(date +%Y-%m-%d)"
EOF

    read_input "Please enter your desired UPSTREAM HOST (e.g., example.com):" UPSTREAM_HOST
    if [[ -z "$UPSTREAM_HOST" ]]; then echo -e "${RED}Upstream host cannot be empty. Operation cancelled.${NC}"; cd - > /dev/null; rm -rf "$PROJECT_DIR"; return; fi
    
    # Replace placeholder (assuming the script has 'YOUR_UPSTREAM_HOST')
    sed -i "s/YOUR_UPSTREAM_HOST/$UPSTREAM_HOST/g" index.js 2>/dev/null
    
    echo -e "${CYAN}--- Deploying Worker ${GREEN}$WORKER_NAME${NC} ---${NC}"
    if ! wrangler deploy; then
        echo -e "${RED}Deployment of Worker '$WORKER_NAME' failed.${NC}"
    else
        echo -e "${GREEN}✅ Worker '$WORKER_NAME' deployed successfully!${NC}"
    fi

    cd - > /dev/null
    rm -rf "$PROJECT_DIR"
    set +e
}

function create_pages_project() {
    set -e
    echo -e "${CYAN}--- Create a New Cloudflare Pages Project (Dynamic Source URL/ZIP or Local Path) ---${NC}"
    
    read_input "Enter a name for your Pages project:" PAGES_PROJECT_NAME
    if [[ -z "$PAGES_PROJECT_NAME" ]]; then echo -e "${RED}Project name cannot be empty. Operation cancelled.${NC}"; return; fi
    
    read_input "Enter the FULL URL of your Pages content (GitHub Repo/ZIP) or a local DIRECTORY path:" PAGES_SOURCE
    if [[ -z "$PAGES_SOURCE" ]]; then echo -e "${RED}Source cannot be empty. Operation cancelled.${NC}"; return; fi
    
    PAGES_DIR="/tmp/$PAGES_PROJECT_NAME-site"
    
    CLEANUP_REQUIRED="false"

    # Case 1: Source is a URL (treat it as a ZIP archive)
    if [[ "$PAGES_SOURCE" =~ ^http ]]; then
        echo -e "${YELLOW}Source is a URL. Preparing to download and fix ZIP content...${NC}"
        CLEANUP_REQUIRED="true" # Need to clean up temp directory later
        
        mkdir -p "$PAGES_DIR"
        
        # Use the fixed fetch_and_deploy with Pages logic
        if ! fetch_and_deploy "$PAGES_SOURCE" "" "$PAGES_DIR" "true"; then
            rm -rf "$PAGES_DIR"
            return
        fi
        
    # Case 2: Source is a local directory path
    elif [[ -d "$PAGES_SOURCE" ]]; then
        PAGES_DIR="$PAGES_SOURCE"
        echo -e "${GREEN}Using local directory: $PAGES_DIR${NC}"
        
    else
        echo -e "${RED}Source '$PAGES_SOURCE' is neither a valid URL nor an existing directory. Operation cancelled.${NC}"
        return
    fi
    
    # CRITICAL DEPLOYMENT FIX: Change directory to the source path for successful deployment.
    cd "$PAGES_DIR"
    
    echo -e "${CYAN}--- Deploying local path ${GREEN}$PAGES_DIR${NC} to project ${GREEN}$PAGES_PROJECT_NAME${NC} ---${NC}"
    
    # Deploy using the project name and the current directory ('.')
    if ! wrangler pages deploy . --project-name "$PAGES_PROJECT_NAME" --commit-dirty=true --yes; then
        echo -e "${RED}Deployment of Pages project '$PAGES_PROJECT_NAME' failed. (Deployment FIX Failed)${NC}"
    else
        echo -e "${GREEN}✅ Pages project '$PAGES_PROJECT_NAME' deployed successfully!${NC}"
    fi

    # Return to the previous directory and clean up if needed
    cd - > /dev/null
    if [[ "$CLEANUP_REQUIRED" == "true" ]]; then
        rm -rf "$PAGES_DIR"
    fi
    set +e
}

# --- Other functions (Delete, List, Logs) are stable ---

function delete_worker() {
    echo -e "${CYAN}--- Delete a Cloudflare Worker ---${NC}"
    wrangler worker list
    read_input "Enter the exact name of the worker to delete:" WORKER_TO_DELETE
    if [[ -z "$WORKER_TO_DELETE" ]]; then echo -e "${RED}Name cannot be empty. Operation cancelled.${NC}"; return; fi
    
    read_input "${RED}WARNING: Are you sure you want to delete '$WORKER_TO_DELETE'? (y/n)${NC}" confirm
    if [[ "$confirm" == "y" ]]; then
        if wrangler delete "$WORKER_TO_DELETE"; then
            echo -e "${GREEN}✅ Worker '$WORKER_TO_DELETE' has been deleted.${NC}"
        else
            echo -e "${RED}Failed to delete worker '$WORKER_TO_DELETE'. Check name and permissions.${NC}"
        fi
    else
        echo "Deletion cancelled."
    fi
}

function delete_pages_project() {
    echo -e "${CYAN}--- Delete a Cloudflare Pages Project ---${NC}"
    wrangler pages project list
    read_input "Enter the exact name of the Pages project to delete:" PAGES_TO_DELETE
    if [[ -z "$PAGES_TO_DELETE" ]]; then echo -e "${RED}Name cannot be empty. Operation cancelled.${NC}"; return; fi
    
    read_input "${RED}WARNING: Are you sure you want to delete '$PAGES_TO_DELETE'? (y/n)${NC}" confirm
    if [[ "$confirm" == "y" ]]; then
        if wrangler pages project delete "$PAGES_TO_DELETE" --yes; then
            echo -e "${GREEN}✅ Pages project '$PAGES_TO_DELETE' has been deleted.${NC}"
        else
            echo -e "${RED}Failed to delete Pages project '$PAGES_TO_DELETE'. Check name and permissions.${NC}"
        fi
    else
        echo "Deletion cancelled."
    fi
}

function view_worker_logs() {
    echo -e "${CYAN}--- View Live Worker Logs ---${NC}"
    wrangler worker list
    read_input "Enter the name of the worker to view its logs:" WORKER_TO_LOG
    if [[ -z "$WORKER_TO_LOG" ]]; then echo -e "${RED}Name cannot be empty. Operation cancelled.${NC}"; return; fi
    echo -e "${CYAN}Streaming logs for '$WORKER_TO_LOG'. Press Ctrl+C to stop.${NC}"
    wrangler tail "$WORKER_TO_LOG"
}

# --- Main Menu Loop ---
login_to_cloudflare

while true; do
    print_menu_header
    echo "1) Create New VLESS Worker (Dynamic Source URL)"
    echo "2) Create New Pages Project (Dynamic Source URL/ZIP or Local Path)"
    echo "3) Delete an existing Worker"
    echo "4) Delete an existing Pages Project"
    echo "5) View Live Logs for a Worker"
    echo "6) List all Workers and Pages"
    echo "7) Check Login Status (wrangler whoami)"
    echo -e "${RED}q) Exit${NC}"
    read_input "Select an option:" choice

    case $choice in
        1) create_vless_worker ;;
        2) create_pages_project ;;
        3) delete_worker ;;
        4) delete_pages_project ;;
        5) view_worker_logs ;;
        6) echo -e "${CYAN}--- Workers ---${NC}"; wrangler worker list; echo -e "\n${CYAN}--- Pages ---${NC}"; wrangler pages project list ;;
        7) wrangler whoami ;;
        q|Q) echo "Exiting. Thank you!"; exit 0 ;;
        *) echo -e "${RED}گزینه نامعتبر است. لطفاً دوباره امتحان کنید. (Invalid option)${NC}" ;;
    esac
    press_enter_to_continue
done
EOF_MANAGER_SCRIPT

# 5. Make the Manager Script Executable
print_header "Step 5: Finalizing Installation"
proot-distro login debian -- chmod +x /root/cf_manager.sh || print_error "Failed to make manager script executable"
print_success "Manager script is ready."

# 6. Execute the Manager Script
print_header "Installation Complete! Launching Cloudflare Manager..."
sleep 1
proot-distro login debian -- /root/cf_manager.sh
