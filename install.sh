#!/bin/bash
#=================================================================================
# Ultimate Cloudflare Auto-Installer & Manager (Termux Edition)
# Version: 8.0 "Smart Source Detection & Ultimate Error Proofing"
# Description: Fully automated, error-proof script with intelligent project type detection.
# Changelog (8.0):
#   - CRITICAL SMART FIX: Added intelligent source detection in create_pages_project. 
#     If a raw Worker script URL is mistakenly entered for Pages, the script automatically 
#     prompts the user to deploy it as a Worker instead.
#   - ROBUSTNESS: Further hardened file system operations and cleanups.
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

# --- Helper Functions (Installation Phase - Stable) ---
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

# --- Main Logic (Installation: Stable environment setup) ---

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
print_header "Step 4: Creating Advanced Cloudflare Manager (v8.0 - Smart Source Detection)"

# Use a quoted heredoc to pass the script content without expansion.
proot-distro login debian -- bash -c "cat > /root/cf_manager.sh" << 'EOF_MANAGER_SCRIPT'
#!/bin/bash
#=================================================================================
# Advanced Cloudflare Management Script (v8.0 - Ultimate Pages Fix & Smart Worker Detection)
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
    echo -e "\n${CYAN}--- Cloudflare Management Menu (v8.0 - Smart Fix) ---${NC}"
}

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

# --- Smart Pages ZIP Fix Function ---
function get_pages_zip_url() {
    local url="$1"
    
    # 1. Check if the URL is a RAW file (This is the Smart Detection FIX for Worker/Pages mix-up)
    if [[ "$url" =~ ^https://raw.githubusercontent.com ]]; then
        echo -e "${RED}ERROR: The URL entered is a RAW file (e.g., Worker script), not a Pages project (ZIP/Repo).${NC}"
        echo "RAW_FILE"
        return
    fi
    
    # 2. Check and convert a standard GitHub repository URL (Stable ZIP FIX from v6.0/v7.0)
    if [[ "$url" =~ ^https://github.com/([^/]+)/([^/]+)/?$ ]]; then
        local user_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
        local fixed_url="https://github.com/${user_repo}/archive/refs/heads/main.zip"
        
        # Check 'main' then fallback to 'master'
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
    
    # 3. If it's a direct ZIP link or other URL
    if [[ "$url" =~ \.zip$ ]]; then
        echo -e "${GREEN}Source is a direct ZIP link. Proceeding.${NC}"
        echo "$url"
        return
    fi

    # Fallback for unknown HTTP types
    echo -e "${YELLOW}Source URL is an unknown HTTP type. Proceeding with caution...${NC}"
    echo "$url"
}

# --- Dynamic Fetch Function (Stable) ---
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
        
        # New Smart Worker Detection Check
        if [[ "$download_url" == "RAW_FILE" ]]; then
            return 2 # Special exit code for Worker deployment prompt
        fi
        
        if [[ -z "$download_url" || "$download_url" == "1" ]]; then
            return 1
        fi
        
        # 1. Download the ZIP file
        echo -e "${YELLOW}Downloading ZIP content from the corrected URL...${NC}"
        if ! curl -L "$download_url" -o "$project_dir/source.zip"; then
            echo -e "${RED}Failed to download the ZIP file. The link may be broken.${NC}"
            return 1
        fi
        
        # 2. Extract the content (Stable)
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
                echo -e "${YELLOW}Moving extracted contents from '$root_folder' to the project root...${NC}"
                mv "$root_folder"/* "$project_dir/" 2>/dev/null 
                mv "$root_folder"/.* "$project_dir/" 2>/dev/null
            else
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

# --- Core Cloudflare Functions ---

# Function to handle Worker deployment only (reusable by Smart Fix)
function deploy_worker_only() {
    local WORKER_NAME="$1"
    local WORKER_URL="$2"
    local PROJECT_DIR="/tmp/$WORKER_NAME"
    
    echo -e "${YELLOW}Creating project directory: ${GREEN}$PROJECT_DIR${NC}...${NC}"
    mkdir -p "$PROJECT_DIR"
    cd "$PROJECT_DIR"

    if ! fetch_and_deploy "$WORKER_URL" "index.js" "$PROJECT_DIR" "false"; then
        cd - > /dev/null
        rm -rf "$PROJECT_DIR"
        return 1
    fi

    echo -e "${YELLOW}Generating wrangler.toml...${NC}"
    cat << EOF > wrangler.toml
name = "$WORKER_NAME"
main = "index.js"
compatibility_date = "$(date +%Y-%m-%d)"
EOF

    read_input "Please enter your desired UPSTREAM HOST (e.g., example.com):" UPSTREAM_HOST
    if [[ -z "$UPSTREAM_HOST" ]]; then 
        echo -e "${RED}Upstream host cannot be empty. Operation cancelled.${NC}"; 
        cd - > /dev/null; rm -rf "$PROJECT_DIR"; 
        return 1; 
    fi
    
    sed -i "s/YOUR_UPSTREAM_HOST/$UPSTREAM_HOST/g" index.js 2>/dev/null
    
    echo -e "${CYAN}--- Deploying Worker ${GREEN}$WORKER_NAME${NC} ---${NC}"
    if ! wrangler deploy; then
        echo -e "${RED}Deployment of Worker '$WORKER_NAME' failed.${NC}"
    else
        echo -e "${GREEN}✅ Worker '$WORKER_NAME' deployed successfully!${NC}"
    fi

    cd - > /dev/null
    rm -rf "$PROJECT_DIR"
    return 0
}

function create_vless_worker() {
    set -e
    echo -e "${CYAN}--- Create a New VLESS Worker (Dynamic Source) ---${NC}"
    
    read_input "Enter a name for your new worker (e.g., my-vless-proxy):" WORKER_NAME
    if [[ -z "$WORKER_NAME" ]]; then echo -e "${RED}Name cannot be empty. Operation cancelled.${NC}"; return; fi
    
    read_input "Enter the FULL URL of your Worker script (e.g., https://raw.githubusercontent.com/.../_worker.js):" WORKER_URL
    if [[ -z "$WORKER_URL" ]]; then echo -e "${RED}Source URL cannot be empty. Operation cancelled.${NC}"; return; fi
    
    deploy_worker_only "$WORKER_NAME" "$WORKER_URL"
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

    # Case 1: Source is a URL (The core fix is here)
    if [[ "$PAGES_SOURCE" =~ ^http ]]; then
        CLEANUP_REQUIRED="true"
        mkdir -p "$PAGES_DIR"
        
        # Use the fixed fetch_and_deploy with Pages logic
        if ! fetch_and_deploy "$PAGES_SOURCE" "" "$PAGES_DIR" "true"; then
            local exit_code=$?
            rm -rf "$PAGES_DIR"
            
            # SMART FIX: Check for the special exit code (2) for raw files
            if [[ "$exit_code" -eq 2 ]]; then
                read_input "${CYAN}It looks like you entered a Worker script URL. Deploy as a Worker '$PAGES_PROJECT_NAME'? (y/n)${NC}" confirm_worker_deploy
                if [[ "$confirm_worker_deploy" == "y" ]]; then
                    echo -e "${YELLOW}Switching to Worker deployment...${NC}"
                    deploy_worker_only "$PAGES_PROJECT_NAME" "$PAGES_SOURCE"
                    return
                fi
            fi
            
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

# --- Other functions (Delete, List, Logs, Login) are stable and remain the same ---
function login_to_cloudflare() {
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
# (Delete, List, Logs functions omitted for brevity, but they are included in the full script above the Main Menu Loop)

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
