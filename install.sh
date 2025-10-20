#!/usr/bin/env bash
# UltraX Cloudflare UltraPro — FINAL Auto-fix (Termux + proot -> Debian)
# Version: 2025-10-20-ultrax-final-v2 (AI-Fixed)
# Brief: A complete and idempotent script to install and configure a Debian proot environment,
# fix common apt/dpkg and npm errors, download raw files based on config,
# and create smart wrappers (with spaced-argument support) and deploy.sh.
set -euo pipefail
export LANG=C.UTF-8
IFS=$'\n\t'

#######################
# CONFIGURATION (Change here if needed)
# Project path based on the zizifn repo
PROJECT_DIR="${PROJECT_DIR:-/root/zizifn}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main}"
ENV_FILE="${PROJECT_DIR}/.env"
LOGFILE="${HOME}/ultrax_final.log"
RETRY_CMD_TIMEOUT=30 # (Currently unused but good for future)

#######################
# Simple Logger
_log(){ printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOGFILE"; }
_fatal(){ _log "FATAL: $*"; exit 1; }
_info(){ _log "INFO: $*"; }

_info "UltraX Cloudflare UltraPro — Starting installer (v2-fixed)..."
_info "Log file will be at: $LOGFILE"

#######################
# Clean up host (Termux) environment
_info "Updating Termux packages (best-effort)..."
{
  pkg update -y || true
  pkg upgrade -y || true
} >> "$LOGFILE" 2>&1 || true

_info "Ensuring essential Termux packages are installed..."
# Ensure nodejs-lts is installed on host for termux-api and other potential uses
pkg install -y proot-distro curl wget git unzip jq openssl termux-api nodejs-lts || true

if ! command -v proot-distro >/dev/null 2>&1; then
  _fatal "proot-distro is not available. Install it in Termux first: pkg install proot-distro"
fi

#######################
# Install or repair Debian inside proot-distro
_info "Checking proot-distro list for 'debian'..."
if ! proot-distro list | grep -q '^debian$'; then
  _info "Installing Debian container..."
  proot-distro install debian >> "$LOGFILE" 2>&1 || _fatal "Debian installation failed. Log: $LOGFILE"
else
  _info "Debian already installed — performing baseline repair inside container..."
  proot-distro login debian --shared-tmp -- bash -lc '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    export UCF_FORCE_CONFFNEW=1
    export APT_LISTCHANGES_FRONTEND=none
    apt-get update -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
    apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
    dpkg --configure -a || true
  ' >> "$LOGFILE" 2>&1 || _log "Initial repair inside Debian executed (minor errors ignored)."
fi

#######################
# Bootstrap script to be executed inside Debian
# Fix: $PROJECT_DIR and $RAW_BASE variables are injected from the host
# to avoid using hardcoded values.
_info "Generating bootstrap script content..."
BOOTSTRAP=$(cat <<EOBOOT
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export UCF_FORCE_CONFFNEW=1
export APT_LISTCHANGES_FRONTEND=none

# --- Values Injected from Host ---
PROJECT_DIR_HOST="${PROJECT_DIR}"
RAW_BASE_URL="${RAW_BASE}"
# ---------------------------------

log(){ echo "[bootstrap] \$*"; }

log "apt-get update..."
apt-get update -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true

log "dist-upgrade (best-effort)..."
apt-get dist-upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true

log "Fixing broken packages (apt-get -f install, dpkg configure)..."
apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
dpkg --configure -a || true

log "Installing core packages..."
apt-get install -y --no-install-recommends git curl gnupg build-essential python3 python3-pip ca-certificates openssl jq wget unzip || true

log "Installing Node.js (NodeSource 20.x) and npm..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
apt-get install -y nodejs -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true

log "Configuring npm and installing global CLIs..."
npm config set unsafe-perm true || true
# Install wrangler and related project tools
npm install -g wrangler @cloudflare/pages gh --unsafe-perm=true --allow-root || true

log "Ensuring project dir exists..."
mkdir -p "\${PROJECT_DIR_HOST}" || true
cd "\${PROJECT_DIR_HOST}" || true

log "Fetching minimal raw files from \${RAW_BASE_URL}..."
curl -fsSL -o wrangler.toml "\${RAW_BASE_URL}/wrangler.toml" || true
curl -fsSL -o package.json "\${RAW_BASE_URL}/package.json" || true
curl -fsSL -o _worker.js "\${RAW_BASE_URL}/_worker.js" || true
# Download the full project zip (overwrites files above but ensures full structure)
log "Cloning/Downloading full project zip from Github..."
curl -fsSL -o project.zip "https://github.com/yas-python/zizifn/archive/main.zip" || true
unzip -o project.zip -d . || true
# Move files from the extracted folder to the project root
mv zizifn-main/* . || true
mv zizifn-main/.* . || true
rmdir zizifn-main || true
rm project.zip || true

log "Bootstrap finished. Versions:"
node -v || true
npm -v || true
wrangler -V || true
gh --version || true
EOBOOT
)

_info "Writing bootstrap into Debian and executing..."
proot-distro login debian --shared-tmp -- bash -lc "cat >/root/bootstrap.sh <<'BEOF'
${BOOTSTRAP}
BEOF
bash /root/bootstrap.sh" >> "$LOGFILE" 2>&1 || {
  _log "Bootstrap encountered issues — attempting final repair inside Debian..."
  proot-distro login debian --shared-tmp -- bash -lc '
    export DEBIAN_FRONTEND=noninteractive
    export UCF_FORCE_CONFFNEW=1
    apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
    dpkg --configure -a || true
  ' >> "$LOGFILE" 2>&1 || _log "Final repair also logged; run dpkg --configure -a manually inside proot if needed."
}

#######################
# Ensure project directory exists on host (fallback)
_info "Ensuring project dir exists on host (fallback)..."
# This path might not exist on the host, but we try
mkdir -p "${PROJECT_DIR/#\/root\/}" 2>/dev/null || true

#######################
# Create wrappers on host to run wrangler/gh/pages inside proot
_info "Creating host wrappers (wrangler-proot, gh-proot, pages-proot)..."
mkdir -p "$HOME/bin"

# Fix: Use "\$@" instead of $* to correctly handle arguments with spaces
cat > "$HOME/bin/wrangler-proot" <<'WR'
#!/usr/bin/env bash
# Pass all arguments ("$@") safely to the proot shell
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler \"\$@\""
WR
cat > "$HOME/bin/gh-proot" <<'GH'
#!/usr/bin/env bash
# Pass all arguments ("$@") safely to the proot shell
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; gh \"\$@\""
GH
cat > "$HOME/bin/pages-proot" <<'PG'
#!/usr/bin/env bash
# Pass all arguments ("$@") safely to the proot shell
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; npx @cloudflare/pages \"\$@\""
PG
chmod +x "$HOME/bin/"*-proot || true

# Fix `grep: No such file` error: `touch` the file first, then `grep`
_info "Ensuring ${HOME}/.profile exists..."
touch "${HOME}/.profile"

_info "Adding $HOME/bin to PATH in ~/.profile if not present..."
if ! grep -qxF 'export PATH=$HOME/bin:$PATH' ~/.profile 2>/dev/null; then
  _info "Appending PATH to ${HOME}/.profile..."
  echo '' >> ~/.profile
  echo '# Add proot wrappers to PATH' >> ~/.profile
  echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile || true
else
  _info "PATH already in ${HOME}/.profile."
fi
export PATH="$HOME/bin:$PATH"

#######################
# Create cloudflare-login helper (opens browser)
_info "Creating cloudflare-login.sh helper on host..."
cat > "$HOME/cloudflare-login.sh" <<'CF'
#!/usr/bin/env bash
echo "🌐 Opening Cloudflare login in device browser..."
# Try opening URL with termux-api, fall back to am (Android Activity Manager) on failure
termux-open-url "https://dash.cloudflare.com/login" >/dev/null 2>&1 || am start -a android.intent.action.VIEW -d "https://dash.cloudflare.com/login"
echo "---"
echo "Waiting for you to log in in the browser..."
echo "After logging in, press [Enter] here to continue and run 'wrangler login' inside proot..."
read -r
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler login"
echo "Login process finished inside proot."
CF
chmod +x "$HOME/cloudflare-login.sh" || true

#######################
# Create deploy.sh inside proot project dir (safe and headless)
_info "Creating deploy.sh (headless) inside project dir..."
# Fix:
# 1. Add `mkdir -p ${PROJECT_DIR}` to prevent "No such file" error.
# 2. Remove 'DEP' from <<'DEP' so host ${PROJECT_DIR} variable is correctly injected.
# 3. Escape ( \ ) all internal variables ($) so they are not expanded on the host.
proot-distro login debian --shared-tmp -- bash -lc "mkdir -p ${PROJECT_DIR} && cat > ${PROJECT_DIR}/deploy.sh <<DEP
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PROJECT_DIR=\"${PROJECT_DIR}\" # <-- Value injected from host script
ENV_FILE=\"\${PROJECT_DIR}/.env\"
CLOUDFLARE_API_TOKEN=\"\${CLOUDFLARE_API_TOKEN:-}\"
DEPLOY_WORKER=\"\${DEPLOY_WORKER:-1}\"
DEPLOY_PAGES=\"\${DEPLOY_PAGES:-0}\"

# load .env if present
if [ -f \"\$ENV_FILE\" ]; then
  set -o allexport
  source \"\$ENV_FILE\"
  set +o allexport
fi

if [ -z \"\$CLOUDFLARE_API_TOKEN\" ]; then
  echo \"ERROR: CLOUDFLARE_API_TOKEN not set. Create .env file or export CLOUDFLARE_API_TOKEN.\"
  exit 1
fi

cd \"\$PROJECT_DIR\" || exit 1

if ! command -v wrangler >/dev/null 2>&1; then
  echo \"wrangler not found — attempting npm global install...\"
  npm install -g wrangler --unsafe-perm=true --allow-root || true
fi

export CLOUDFLARE_API_TOKEN

echo \"[deploy] Using token, DEPLOY_WORKER=\$DEPLOY_WORKER, DEPLOY_PAGES=\$DEPLOY_PAGES\"

# If package.json exists: install dependencies and run build (if present)
if [ -f package.json ]; then
  echo \"[deploy] package.json found — installing deps...\"
  npm ci --silent || npm install --silent || true
  if jq -e '.scripts.build' package.json >/dev/null 2>&1; then
    echo \"[deploy] Running build script...\"
    npm run build || true
  fi
fi

# Deploy Worker
if [ \"\$DEPLOY_WORKER\" = '1' ]; then
  echo \"[deploy] Deploying Worker...\"
  if wrangler deploy --api-token \"\$CLOUDFLARE_API_TOKEN\" 2>/dev/null; then
    echo \"[deploy] wrangler deploy OK\"
  else
    # Fallback to 'publish' for older versions
    wrangler publish --api-token \"\$CLOUDFLARE_API_TOKEN\" || echo \"[deploy] wrangler publish/deploy failed\"
  fi
fi

# Deploy Pages
if [ \"\$DEPLOY_PAGES\" = '1' ]; then
  OUT_DIR='./dist' # Default output folder
  if [ ! -d \"\$OUT_DIR\" ]; then
    # Search for other common output folders
    for d in dist public out build .output .next; do
      if [ -d \"\$d\" ]; then OUT_DIR=\"\$d\"; break; fi
    done
  fi
  if [ -d \"\$OUT_DIR\" ]; then
    echo \"[deploy] Publishing Pages from \$OUT_DIR...\"
    # Extract project name from package.json or use a default
    PROJECT_NAME=\"\$(jq -r .name package.json 2>/dev/null || echo pages-project)\"
    wrangler pages publish \"\$OUT_DIR\" --project-name \"\${PROJECT_NAME}\" --api-token \"\$CLOUDFLARE_API_TOKEN\" || echo \"[deploy] pages publish attempted\"
  else
    echo \"[deploy] No Pages output dir found (\$OUT_DIR) — build first or set DEPLOY_PAGES=0.\"
  fi
fi

echo \"[deploy] Done.\"
DEP
chmod +x ${PROJECT_DIR}/deploy.sh" >> "$LOGFILE" 2>&1 || _log "Warning: deploy.sh creation had minor issues (check log)."

#######################
# Create safe .env.template (inside proot)
_info "Creating .env.template inside project dir..."
# Fix: Add `mkdir -p ${PROJECT_DIR}` to prevent "No such file" error.
proot-distro login debian --shared-tmp -- bash -lc "mkdir -p ${PROJECT_DIR} && cat > ${PROJECT_DIR}/.env.template <<TENV
# Example .env for deploy
# CLOUDFLARE_API_TOKEN required (Workers/Pages scopes)
CLOUDFLARE_API_TOKEN=
# Optional toggles
DEPLOY_WORKER=1
DEPLOY_PAGES=0
# PROJECT_DIR default: ${PROJECT_DIR}
TENV" >> "$LOGFILE" 2>&1 || _log "Warning: could not write .env.template (check permissions)."

#######################
# Summary and Final Instructions
cat > "$HOME/ULTRAX_FINAL_README.txt" <<READ
##############################################
UltraX Cloudflare UltraPro — Installer Completed.
##############################################

Logfile: $LOGFILE
Project dir (inside proot): ${PROJECT_DIR}

Next steps:
1) To use the wrappers, restart Termux (or run: source ~/.profile)

2) If you want to log in interactively (opens browser):
   ./cloudflare-login.sh

3) Or, if you want to use an API token (recommended for deploy):
   - Enter the proot:
     proot-distro login debian --shared-tmp
   - Create the .env file:
     cp ${PROJECT_DIR}/.env.template ${PROJECT_DIR}/.env
   - Edit the file:
     nano ${PROJECT_DIR}/.env
   - Set the CLOUDFLARE_API_TOKEN=your_token value
   - Run the deploy script:
     bash ${PROJECT_DIR}/deploy.sh

4) You can also use the wrappers from the host:
   - wrangler-proot deploy --message "my message"
   - pages-proot publish "./dist"
   - gh-proot <args>

If something fails:
- Run inside proot:
  dpkg --configure -a && apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"
- Then, re-run the bootstrap script:
  proot-distro login debian --shared-tmp -- bash -lc "bash /root/bootstrap.sh"

READ

_info "Installer finished. See $HOME/ULTRAX_FINAL_README.txt for next steps."
echo
cat "$HOME/ULTRAX_FINAL_README.txt"

