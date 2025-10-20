#!/usr/bin/env bash
# UltraX Cloudflare UltraPro — FINAL (Termux + proot -> Debian)
# Version: 2025-10-20-final
set -euo pipefail
export LANG=C.UTF-8
IFS=$'\n\t'

# ---------- Configuration ----------
PROJECT_DIR="${PROJECT_DIR:-/root/zizifn}"
RAW_BASE="https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main"
ENV_FILE="${PROJECT_DIR}/.env"
LOGFILE="${HOME}/ultrax_install.log"

# Helper logging
_log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOGFILE"; }
_fatal() { _log "FATAL: $*"; exit 1; }
_info() { _log "INFO: $*"; }

_info "Starting UltraX Cloudflare UltraPro installer..."

# ---------- Termux prerequisites (best-effort) ----------
_info "Updating pkg (Termux) and installing proot-distro + utilities..."
{
  pkg update -y || true
  pkg upgrade -y || true
  pkg install -y proot-distro curl wget git unzip jq openssl termux-api nodejs-lts || true
} >> "$LOGFILE" 2>&1 || true

if ! command -v proot-distro >/dev/null 2>&1; then
  _fatal "proot-distro not found. داخل Termux نصبش کن: pkg install proot-distro"
fi

# ---------- Ensure Debian container ----------
_info "Checking Debian proot-distro..."
if ! proot-distro list | grep -q '^debian$'; then
  _info "Installing Debian container (proot-distro install debian)..."
  proot-distro install debian >> "$LOGFILE" 2>&1 || _fatal "نصب Debian شکست خورد."
else
  _info "Debian موجود است — اعمال تعمیرات پایه درون container..."
  proot-distro login debian --shared-tmp -- bash -lc '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    export UCF_FORCE_CONFFNEW=1
    export APT_LISTCHANGES_FRONTEND=none
    apt-get update -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
    apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
    dpkg --configure -a || true
  ' >> "$LOGFILE" 2>&1 || _log "تعمیر اولیه داخل proot انجام شد (ممکن است خطاهای جزئی نادیده گرفته شده باشد)."
fi

# ---------- Bootstrap script to run inside Debian ----------
BOOTSTRAP=$(cat <<'BOOTSTRAP_EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export UCF_FORCE_CONFFNEW=1
export APT_LISTCHANGES_FRONTEND=none

log(){ echo "[bootstrap] $*"; }

log "apt update (noninteractive)..."
apt-get update -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"

log "apt dist-upgrade..."
apt-get dist-upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true

log "Fix broken packages..."
apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
dpkg --configure -a || true

log "Install core packages..."
apt-get install -y --no-install-recommends git curl gnupg build-essential python3 python3-pip ca-certificates openssl jq wget unzip ca-certificates || true

log "Install Node.js via NodeSource (20.x) and npm..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
apt-get install -y nodejs -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true

log "Configure npm global permissions and install CLI tools..."
# correct command to set unsafe-perm
npm config set unsafe-perm true || true
# install wrangler/pages/gh; allow-root flags to help container envs
npm install -g wrangler @cloudflare/pages gh --unsafe-perm=true --allow-root || true

log "Make project dir and fetch minimal files..."
mkdir -p /root/zizifn || true
cd /root/zizifn || exit 0

# Download only required raw files if available (ignore errors)
curl -fsSL -o wrangler.toml "https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main/wrangler.toml" || true
curl -fsSL -o package.json "https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main/package.json" || true
curl -fsSL -o _worker.js "https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main/_worker.js" || true

log "Bootstrap complete. Versions:"
node -v || true
npm -v || true
wrangler -V || true
gh --version || true
BOOTSTRAP_EOF
)

_info "Writing bootstrap into Debian and executing..."
proot-distro login debian --shared-tmp -- bash -lc "cat >/root/bootstrap.sh <<'BEOF'
${BOOTSTRAP}
BEOF
bash /root/bootstrap.sh" >> "$LOGFILE" 2>&1 || {
  _log "Bootstrap failed — تلاش برای تعمیر نهایی..."
  proot-distro login debian --shared-tmp -- bash -lc '
    export DEBIAN_FRONTEND=noninteractive
    export UCF_FORCE_CONFFNEW=1
    apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew" || true
    dpkg --configure -a || true
  ' >> "$LOGFILE" 2>&1 || _log "تلاش تعمیر نهایی هم کامل نشد. در صورت نیاز dpkg --configure -a را دستی اجرا کن."
}

# ---------- Create wrappers to call tools easily from Termux host ----------
_info "Creating host wrappers (wrangler-proot, gh-proot, pages-proot)..."
mkdir -p "$HOME/bin"
cat > "$HOME/bin/wrangler-proot" <<'WR'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler $*"
WR
cat > "$HOME/bin/gh-proot" <<'GH'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; gh $*"
GH
cat > "$HOME/bin/pages-proot" <<'PG'
#!/usr/bin/env bash
proot-distro login debian --shared-tmp -- bash -lc "export DEBIAN_FRONTEND=noninteractive; npx @cloudflare/pages $*"
PG
chmod +x "$HOME/bin/"*-proot || true
grep -qxF 'export PATH=$HOME/bin:$PATH' ~/.profile || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
export PATH="$HOME/bin:$PATH"

# ---------- Create cloudflare-login helper ----------
_info "Creating cloudflare-login.sh helper..."
cat > "$HOME/cloudflare-login.sh" <<'CF'
#!/usr/bin/env bash
echo "🌐 Opening Cloudflare OAuth in device browser..."
termux-open-url "https://dash.cloudflare.com/sign-up" >/dev/null 2>&1 || am start -a android.intent.action.VIEW -d "https://dash.cloudflare.com/sign-up"
proot-distro login debian -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler login"
CF
chmod +x "$HOME/cloudflare-login.sh"

# ---------- Create deploy.sh (inside PROJECT_DIR) ----------
_info "Creating deploy.sh (headless deploy for Worker & Pages)..."
proot-distro login debian --shared-tmp -- bash -lc "cat > ${PROJECT_DIR}/deploy.sh <<'DEP'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PROJECT_DIR='${PROJECT_DIR}'
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
  echo \"ERROR: CLOUDFLARE_API_TOKEN not set. export CLOUDFLARE_API_TOKEN=... or create .env in project.\"
  exit 1
fi

cd \"\$PROJECT_DIR\" || exit 1

# Ensure wrangler is available (installed in bootstrap)
if ! command -v wrangler >/dev/null 2>&1; then
  echo \"wrangler not found — attempting npm global install...\"
  npm install -g wrangler --unsafe-perm=true --allow-root || true
fi

export CLOUDFLARE_API_TOKEN

echo \"[deploy] Using token, DEPLOY_WORKER=\$DEPLOY_WORKER, DEPLOY_PAGES=\$DEPLOY_PAGES\"

# Optional: install npm deps and build if package.json present
if [ -f package.json ]; then
  echo \"[deploy] package.json found — running npm ci and build if defined...\"
  npm ci --silent || npm install --silent || true
  if jq -e '.scripts.build' package.json >/dev/null 2>&1; then
    npm run build || true
  fi
fi

# Worker deploy
if [ \"\$DEPLOY_WORKER\" = '1' ]; then
  echo \"[deploy] Deploying Worker (wrangler deploy)...\"
  # prefer wrangler deploy, fallback to wrangler publish
  if wrangler deploy --api-token \"\$CLOUDFLARE_API_TOKEN\" 2>/dev/null; then
    echo \"[deploy] wrangler deploy OK\"
  else
    wrangler publish --api-token \"\$CLOUDFLARE_API_TOKEN\" || echo \"[deploy] wrangler publish attempted\"
  fi
fi

# Pages deploy (if built)
if [ \"\$DEPLOY_PAGES\" = '1' ]; then
  # assume output dir ./dist or build output from package.json
  OUT_DIR='./dist'
  if [ ! -d \"\$OUT_DIR\" ]; then
    # try 'build' output location from package.json (common: build, public, out)
    for d in dist public out build; do
      if [ -d \"\$d\" ]; then OUT_DIR=\"\$d\"; break; fi
    done
  fi
  if [ -d \"\$OUT_DIR\" ]; then
    echo \"[deploy] Publishing Pages from \$OUT_DIR...\"
    wrangler pages publish \"\$OUT_DIR\" --project-name \"\$(jq -r .name package.json 2>/dev/null || echo pages-project)\" --api-token \"\$CLOUDFLARE_API_TOKEN\" || echo \"[deploy] wrangler pages publish attempted\"
  else
    echo \"[deploy] No Pages output dir found (./dist/public/out). Build first or set DEPLOY_PAGES=0.\"
  fi
fi

echo \"[deploy] Done.\"
DEP
chmod +x ${PROJECT_DIR}/deploy.sh
" >> "$LOGFILE" 2>&1 || _log "ساخت deploy.sh داخل proot با خطا همراه بود."

# ---------- Create example .env template ----------
_info "Creating .env.template..."
cat > "${PROJECT_DIR}/.env.template" <<'TENV'
# Example .env for deploy
# CLOUDFLARE_API_TOKEN required (Workers/Pages scopes)
CLOUDFLARE_API_TOKEN=
# Optional toggles
DEPLOY_WORKER=1
DEPLOY_PAGES=0
# PROJECT_DIR can be left as default
TENV

# ---------- Final message ----------
cat > "$HOME/ULTRAX_INFO.txt" <<INFO
UltraX Cloudflare UltraPro installer finished.
- Project dir: ${PROJECT_DIR}
- To login to Cloudflare (interactive): $HOME/cloudflare-login.sh
- Host wrappers: $HOME/bin/wrangler-proot   $HOME/bin/pages-proot   $HOME/bin/gh-proot
- To run deploy inside proot: proot-distro login debian --shared-tmp -- bash -lc "bash ${PROJECT_DIR}/deploy.sh"
- Or from host use: wrangler-proot (this runs wrangler inside proot)
- .env template: ${PROJECT_DIR}/.env.template
- Logfile: ${LOGFILE}

If something fails:
1) داخل proot اجرا کن: dpkg --configure -a && apt-get -f install -y
2) چک کن که API token را درست ست کرده‌ای (CLOUDFLARE_API_TOKEN)
3) مسیر پروژه و مجوزها را بررسی کن.
INFO

_info "Installation completed. Read $HOME/ULTRAX_INFO.txt for next steps."
echo
cat "$HOME/ULTRAX_INFO.txt"
