#!/bin/bash

# ANSI color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to show menu and handle user input
function show_menu() {
    # Display channel names in colors
    echo -e "${RED}YOUTUBE: KOLANDONE${NC}"
    echo -e "${BLUE}TELEGRAM: KOLANDJS${NC}"

    echo "Choose an option or type 'exit' to quit:"
    echo "1) List all Workers"
    echo "2) Create a Worker or Pages Project"
    echo "3) Delete a Worker"
    echo "4) List all Pages Projects"
    echo "5) Delete a Pages Project"
    read -r USER_OPTION

    case $USER_OPTION in
        1)
            list_all_workers
            ;;
        2)
            create_project
            ;;
        3)
            delete_worker
            ;;
        4)
            list_all_pages
            ;;
        5)
            delete_pages
            ;;
        "exit")
            echo "Exiting script."
            exit 0
            ;;
        *)
            echo "Invalid option selected."
            ;;
    esac
}

# Function to list all Workers and allow user to select one to get the visit link
function list_all_workers() {
    # Retrieve the list of Workers and their details
    WORKERS_DETAILS=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

    if echo "$WORKERS_DETAILS" | grep -q '"success":false'; then
        echo "Failed to list workers: $(echo "$WORKERS_DETAILS" | jq -r '.errors[0].message')"
        return
    fi
    
    # Parse the list of Workers
    echo "List of Workers:"
    WORKER_LIST=$(echo "$WORKERS_DETAILS" | jq -r '.result[] | .id')
    echo "$WORKER_LIST" | nl -w1 -s') '

    # Ask the user to select a Worker to get the visit link
    echo "Enter the number of the Worker to get the visit link or type 'back' to return to the main menu:"
    read -r WORKER_SELECTION

    if [[ "$WORKER_SELECTION" =~ ^[0-9]+$ ]]; then
        # Get the Worker name based on user selection
        SELECTED_WORKER_NAME=$(echo "$WORKER_LIST" | sed -n "${WORKER_SELECTION}p")
        
        # Call the function to get the workers.dev subdomain for the selected Worker
        get_workers_dev_subdomain "$SELECTED_WORKER_NAME"
    elif [ "$WORKER_SELECTION" == "back" ]; then
        return
    else
        echo "Invalid selection."
    fi
}

# Function to get the workers.dev subdomain for a Worker
function get_workers_dev_subdomain() {
    local WORKER_NAME=$1
    # Retrieve the workers.dev subdomain for the given Worker name
    WORKER_SUBDOMAIN=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result.subdomain' 2>/dev/null)

    # Check if the workers.dev subdomain was retrieved successfully
    if [ -n "$WORKER_SUBDOMAIN" ]; then
        echo -e "The visit link for ${GREEN}$WORKER_NAME${NC} is: ${GREEN}https://${WORKER_NAME}.${WORKER_SUBDOMAIN}.workers.dev${NC}"
    else
        echo "Failed to retrieve the workers.dev subdomain for $WORKER_NAME."
    fi
}

# Function to list all Pages projects
function list_all_pages() {
    # Retrieve the list of Pages projects
    PAGES_DETAILS=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

    if echo "$PAGES_DETAILS" | grep -q '"success":false'; then
        echo "Failed to list pages projects: $(echo "$PAGES_DETAILS" | jq -r '.errors[0].message')"
        return
    fi
    
    # Parse the list of Pages projects
    echo "List of Pages Projects:"
    PAGES_LIST=$(echo "$PAGES_DETAILS" | jq -r '.result[] | .name')
    echo "$PAGES_LIST" | nl -w1 -s') '

    # Ask the user to select a project to get the visit link
    echo "Enter the number of the Pages project to get the visit link or type 'back' to return to the main menu:"
    read -r PAGES_SELECTION

    if [[ "$PAGES_SELECTION" =~ ^[0-9]+$ ]]; then
        # Get the project name based on user selection
        SELECTED_PAGES_NAME=$(echo "$PAGES_LIST" | sed -n "${PAGES_SELECTION}p")
        
        # Echo the pages.dev link
        echo -e "The visit link for ${GREEN}$SELECTED_PAGES_NAME${NC} is: ${GREEN}https://${SELECTED_PAGES_NAME}.pages.dev${NC}"
    elif [ "$PAGES_SELECTION" == "back" ]; then
        return
    else
        echo "Invalid selection."
    fi
}

# Function to create a Worker or Pages project
function create_project() {
    # Prompt for the type: Worker or Pages
    echo "Do you want to create a Worker or a Pages project? (worker/pages)"
    read -r PROJECT_TYPE

    if [ "$PROJECT_TYPE" == "worker" ]; then
        create_worker
    elif [ "$PROJECT_TYPE" == "pages" ]; then
        create_pages
    else
        echo "Invalid type selected."
        return
    fi
}

# Function to create a Worker
function create_worker() {
    # Prompt for the Worker name
    echo "Please enter a name for your Cloudflare Worker:"
    read -r PROJECT_NAME

    # Check if worker exists
    WORKER_CHECK=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$PROJECT_NAME" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

    if ! echo "$WORKER_CHECK" | grep -q '"success":false'; then
        echo "Worker $PROJECT_NAME already exists."
        return
    fi

    # Ask if the user needs a KV namespace
    echo "Do you need a KV namespace? (yes/no)"
    read -r NEED_KV

    KV_BINDING=""
    KV_ID=""

    if [ "$NEED_KV" == "yes" ]; then
        # Prompt for the KV namespace name
        echo "Please enter a name for your KV namespace:"
        read -r KV_NAMESPACE_NAME

        # Prompt for the binding variable name
        echo "Please enter the name for the KV binding variable (e.g., USER_KV):"
        read -r KV_BINDING

        # Create the KV namespace using the Cloudflare API
        CREATE_KV_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/storage/kv/namespaces" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" \
            --data "{\"title\":\"$KV_NAMESPACE_NAME\"}")

        # Extract the KV namespace ID from the response
        KV_ID=$(echo "$CREATE_KV_RESPONSE" | jq -r '.result.id' 2>/dev/null)

        # Check if the KV namespace was created successfully
        if [ -n "$KV_ID" ] && echo "$CREATE_KV_RESPONSE" | grep -q '"success":true'; then
            echo "KV namespace created successfully with ID: $KV_ID"
        else
            echo "Failed to create KV namespace."
            echo "Response: $CREATE_KV_RESPONSE"
            return
        fi
    fi

    # Ask if the user needs a D1 database
    echo "Do you need a D1 database? (yes/no)"
    read -r NEED_D1

    D1_BINDING=""
    D1_NAME=""
    D1_ID=""

    if [ "$NEED_D1" == "yes" ]; then
        # Prompt for the D1 database name
        echo "Please enter a name for your D1 database:"
        read -r D1_NAME

        # Prompt for the binding variable name
        echo "Please enter the name for the D1 binding variable (e.g., DB):"
        read -r D1_BINDING

        # Create the D1 database using the Cloudflare API
        CREATE_D1_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" \
            --data "{\"name\":\"$D1_NAME\"}")

        # Extract the D1 ID from the response
        D1_ID=$(echo "$CREATE_D1_RESPONSE" | jq -r '.result.id' 2>/dev/null)

        # Check if the D1 was created successfully
        if [ -n "$D1_ID" ] && echo "$CREATE_D1_RESPONSE" | grep -q '"success":true'; then
            echo "D1 database created successfully with ID: $D1_ID"
            
            # Initialize the DB with the create table command
            INIT_COMMAND="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 2);"
            wrangler d1 execute "$D1_NAME" --command="$INIT_COMMAND" --yes
            if [ $? -eq 0 ]; then
                echo "D1 table initialized successfully."
            else
                echo "Failed to initialize D1 table."
            fi
        else
            echo "Failed to create D1 database."
            echo "Response: $CREATE_D1_RESPONSE"
            return
        fi
    fi

    # Generate the worker directory
    wrangler generate "$PROJECT_NAME" --quiet

    if [ $? -ne 0 ]; then
        echo "Failed to generate worker directory."
        return
    fi

    # Change to the worker directory
    cd "$PROJECT_NAME" || { echo "Failed to change directory to $PROJECT_NAME"; return; }

    # Add account_id to wrangler.toml
    echo "account_id = \"$ACCOUNT_ID\"" >> wrangler.toml

    # Add KV binding if created
    if [ -n "$KV_ID" ]; then
        echo "kv_namespaces = [" >> wrangler.toml
        echo "  { binding = \"$KV_BINDING\", id = \"$KV_ID\" }" >> wrangler.toml
        echo "]" >> wrangler.toml
    fi

    # Add D1 binding if created
    if [ -n "$D1_ID" ]; then
        echo "d1_databases = [" >> wrangler.toml
        echo "  { binding = \"$D1_BINDING\", database_name = \"$D1_NAME\", database_id = \"$D1_ID\" }" >> wrangler.toml
        echo "]" >> wrangler.toml
    fi

    # Prompt for the URL of the new script
    echo "Please enter the URL of the script you want to use to update index.js (or leave blank for default):"
    read -r SCRIPT_URL

    if [ -n "$SCRIPT_URL" ]; then
        # Fetch the new script content from the URL and save it as index.js in the src directory
        curl -s "$SCRIPT_URL" -o src/index.js
        if [ $? -ne 0 ]; then
            echo "Failed to download the new script content."
            cd ..
            return
        fi
        echo "New script content downloaded successfully to src/index.js."
    fi

    # Ask if the user wants to change the UUID
    echo "Do you want to change the UUID in the script? (yes/no)"
    read -r CHANGE_UUID

    if [ "$CHANGE_UUID" == "yes" ]; then
        # Generate a random UUID
        if command -v uuidgen &> /dev/null; then
            NEW_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
        else
            NEW_UUID=$(cat /proc/sys/kernel/random/uuid)
        fi

        # Replace UUID in the script using cross-platform sed
        sed -i.bak "s/[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}/$NEW_UUID/g" src/index.js && rm -f src/index.js.bak

        echo "UUID has been changed to: $NEW_UUID"
    fi

    # Ask if to add secrets
    echo "Do you want to add secrets (e.g., ADMIN_KEY, etc.)? (yes/no)"
    read -r ADD_SECRETS

    if [ "$ADD_SECRETS" == "yes" ]; then
        # Prompt for each secret
        declare -a SECRETS=("ADMIN_KEY" "ADMIN_PATH" "UUID" "PROXYIP" "SCAMALYTICS_API_KEY" "SOCKS5" "SOCKS5_RELAY" "ROOT_PROXY_URL")

        for SECRET in "${SECRETS[@]}"; do
            echo "Enter value for $SECRET (or leave blank to skip):"
            read -rs SECRET_VALUE  # Use -s for secure input if sensitive
            if [ -n "$SECRET_VALUE" ]; then
                echo "$SECRET_VALUE" | wrangler secret put "$SECRET"
                if [ $? -ne 0 ]; then
                    echo "Failed to set secret $SECRET."
                else
                    echo "Secret $SECRET set successfully."
                fi
            fi
        done
    fi

    # Deploy the worker
    DEPLOY_RESPONSE=$(wrangler deploy 2>&1)
    if [ $? -eq 0 ]; then
        echo "Worker deployed successfully."
        # Show the visit link
        get_workers_dev_subdomain "$PROJECT_NAME"

        # If UUID was changed, display it
        if [ "$CHANGE_UUID" == "yes" ]; then
            echo "New UUID: $NEW_UUID"
        fi
    else
        echo "Failed to deploy worker."
        echo "Response: $DEPLOY_RESPONSE"
    fi

    # Change back to original directory
    cd ..
}

# Function to create a Pages project
function create_pages() {
    # Prompt for the Pages project name
    echo "Please enter a name for your Cloudflare Pages project:"
    read -r PROJECT_NAME

    # Check if project exists
    PAGES_CHECK=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

    if echo "$PAGES_CHECK" | grep -q '"success":true'; then
        echo "Pages project $PROJECT_NAME already exists. Proceeding to update."
    else
        # Create the Pages project
        wrangler pages project create "$PROJECT_NAME" --production-branch main
        if [ $? -ne 0 ]; then
            echo "Failed to create Pages project."
            return
        fi
        echo "Pages project created successfully."
    fi

    # Ask for KV and D1, same as worker
    echo "Do you need a KV namespace? (yes/no)"
    read -r NEED_KV

    KV_BINDING=""
    KV_ID=""

    if [ "$NEED_KV" == "yes" ]; then
        echo "Please enter a name for your KV namespace:"
        read -r KV_NAMESPACE_NAME

        echo "Please enter the name for the KV binding variable (e.g., USER_KV):"
        read -r KV_BINDING

        CREATE_KV_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/storage/kv/namespaces" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" \
            --data "{\"title\":\"$KV_NAMESPACE_NAME\"}")

        KV_ID=$(echo "$CREATE_KV_RESPONSE" | jq -r '.result.id' 2>/dev/null)

        if [ -n "$KV_ID" ] && echo "$CREATE_KV_RESPONSE" | grep -q '"success":true'; then
            echo "KV namespace created successfully with ID: $KV_ID"
        else
            echo "Failed to create KV namespace."
            return
        fi
    fi

    echo "Do you need a D1 database? (yes/no)"
    read -r NEED_D1

    D1_BINDING=""
    D1_NAME=""
    D1_ID=""

    if [ "$NEED_D1" == "yes" ]; then
        echo "Please enter a name for your D1 database:"
        read -r D1_NAME

        echo "Please enter the name for the D1 binding variable (e.g., DB):"
        read -r D1_BINDING

        CREATE_D1_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" \
            --data "{\"name\":\"$D1_NAME\"}")

        D1_ID=$(echo "$CREATE_D1_RESPONSE" | jq -r '.result.id' 2>/dev/null)

        if [ -n "$D1_ID" ] && echo "$CREATE_D1_RESPONSE" | grep -q '"success":true'; then
            echo "D1 database created successfully with ID: $D1_ID"

            INIT_COMMAND="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 2);"
            wrangler d1 execute "$D1_NAME" --command="$INIT_COMMAND" --yes
            if [ $? -eq 0 ]; then
                echo "D1 table initialized successfully."
            else
                echo "Failed to initialize D1 table."
            fi
        else
            echo "Failed to create D1 database."
            return
        fi
    fi

    # Create a directory for the Pages project if not exists
    mkdir -p "$PROJECT_NAME"
    cd "$PROJECT_NAME" || { echo "Failed to change directory to $PROJECT_NAME"; return; }

    # Create or update wrangler.toml
    echo "name = \"$PROJECT_NAME\"" > wrangler.toml
    echo "account_id = \"$ACCOUNT_ID\"" >> wrangler.toml
    echo "compatibility_date = \"$(date +%Y-%m-%d)\"" >> wrangler.toml

    # Add KV binding if created
    if [ -n "$KV_ID" ]; then
        echo "kv_namespaces = [" >> wrangler.toml
        echo "  { binding = \"$KV_BINDING\", id = \"$KV_ID\" }" >> wrangler.toml
        echo "]" >> wrangler.toml
    fi

    # Add D1 binding if created
    if [ -n "$D1_ID" ]; then
        echo "d1_databases = [" >> wrangler.toml
        echo "  { binding = \"$D1_BINDING\", database_name = \"$D1_NAME\", database_id = \"$D1_ID\" }" >> wrangler.toml
        echo "]" >> wrangler.toml
    fi

    # Prompt for the script URL
    echo "Please enter the URL of the script you want to use to update _worker.js (or leave blank for default):"
    read -r SCRIPT_URL

    if [ -n "$SCRIPT_URL" ]; then
        curl -s "$SCRIPT_URL" -o _worker.js
        if [ $? -ne 0 ]; then
            echo "Failed to download the script content."
            cd ..
            return
        fi
        echo "Script content downloaded successfully to _worker.js."
    fi

    # Change UUID if yes
    echo "Do you want to change the UUID in the script? (yes/no)"
    read -r CHANGE_UUID

    if [ "$CHANGE_UUID" == "yes" ]; then
        if command -v uuidgen &> /dev/null; then
            NEW_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
        else
            NEW_UUID=$(cat /proc/sys/kernel/random/uuid)
        fi
        sed -i.bak "s/[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}/$NEW_UUID/g" _worker.js && rm -f _worker.js.bak
        echo "UUID has been changed to: $NEW_UUID"
    fi

    # Add secrets
    echo "Do you want to add secrets (e.g., ADMIN_KEY, etc.)? (yes/no)"
    read -r ADD_SECRETS

    if [ "$ADD_SECRETS" == "yes" ]; then
        declare -a SECRETS=("ADMIN_KEY" "ADMIN_PATH" "UUID" "PROXYIP" "SCAMALYTICS_API_KEY" "SOCKS5" "SOCKS5_RELAY" "ROOT_PROXY_URL")

        for SECRET in "${SECRETS[@]}"; do
            echo "Enter value for $SECRET (or leave blank to skip):"
            read -rs SECRET_VALUE
            if [ -n "$SECRET_VALUE" ]; then
                echo "$SECRET_VALUE" | wrangler pages secret put "$SECRET" --project-name "$PROJECT_NAME"
                if [ $? -ne 0 ]; then
                    echo "Failed to set secret $SECRET."
                else
                    echo "Secret $SECRET set successfully."
                fi
            fi
        done
    fi

    # Deploy the pages project
    DEPLOY_RESPONSE=$(wrangler pages deploy . --project-name "$PROJECT_NAME" 2>&1)
    if [ $? -eq 0 ]; then
        echo "Pages project deployed successfully."
        echo -e "The visit link is: ${GREEN}https://${PROJECT_NAME}.pages.dev${NC}"

        if [ "$CHANGE_UUID" == "yes" ]; then
            echo "New UUID: $NEW_UUID"
        fi
    else
        echo "Failed to deploy pages project."
        echo "Response: $DEPLOY_RESPONSE"
    fi

    # Change back
    cd ..
}

# Function to delete a Worker
function delete_worker() {
    # Prompt for the Worker name to delete
    echo "Enter the name of the Worker you want to delete:"
    read -r DELETE_NAME

    # Delete the selected Worker
    DELETE_RESPONSE=$(curl -s -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$DELETE_NAME" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

    if echo "$DELETE_RESPONSE" | grep -q '"success":true'; then
        echo "Worker $DELETE_NAME deleted successfully."
    else
        echo "Failed to delete worker $DELETE_NAME."
        echo "Response: $DELETE_RESPONSE"
    fi
}

# Function to delete a Pages project
function delete_pages() {
    # Prompt for the Pages project name to delete
    echo "Enter the name of the Pages project you want to delete:"
    read -r DELETE_NAME

    # Delete the selected Pages project
    DELETE_RESPONSE=$(curl -s -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$DELETE_NAME" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

    if echo "$DELETE_RESPONSE" | grep -q '"success":true'; then
        echo "Pages project $DELETE_NAME deleted successfully."
    else
        echo "Failed to delete pages project $DELETE_NAME."
        echo "Response: $DELETE_RESPONSE"
    fi
}

# Main script logic
echo "Please enter your Cloudflare API token:"
read -rs CLOUDFLARE_API_TOKEN  # Secure input
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN"
echo "Please enter your Cloudflare Account ID:"
read -r ACCOUNT_ID
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "jq is not installed. Please install jq to parse JSON responses."
    exit 1
fi

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "wrangler is not installed. Please install wrangler CLI."
    exit 1
fi

# Check if curl is installed
if ! command -v curl &> /dev/null; then
    echo "curl is not installed. Please install curl."
    exit 1
fi

# Loop to show the menu repeatedly
while true; do
    show_menu
done
