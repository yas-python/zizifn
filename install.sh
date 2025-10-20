#!/usr/bin/env bash
# UltraX Cloudflare UltraPro — FINAL Auto-fix (Termux + proot -> Debian)
# نسخه: 2025-10-20-ultrax-final-v2 (اصلاح شده توسط AI)
# توضیح مختصر: اسکریپت کامل و idempotent برای نصب و راه‌اندازی محیط proot Debian،
# رفع خطاهای apt/dpkg و npm، دانلود فایل‌های raw بر اساس پیکربندی،
# ساخت wrappers هوشمند (با پشتیبانی از آرگومان‌های فاصله‌دار) و deploy.sh.
set -euo pipefail
export LANG=C.UTF-8
IFS=$'\n\t'

#######################
# پیکربندی (در صورت نیاز این‌جا را تغییر بده)
PROJECT_DIR="${PROJECT_DIR:-/root/zizifn}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/yas-python/zizifn/refs/heads/main}"
ENV_FILE="${PROJECT_DIR}/.env"
LOGFILE="${HOME}/ultrax_final.log"
RETRY_CMD_TIMEOUT=30 # (در حال حاضر استفاده نشده اما برای آینده خوب است)

#######################
# لاگر ساده
_log(){ printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOGFILE"; }
_fatal(){ _log "FATAL: $*"; exit 1; }
_info(){ _log "INFO: $*"; }

_info "UltraX Cloudflare UltraPro — Starting installer (v2-fixed)..."

#######################
# تطهیر محیط host (Termux)
_info "Updating Termux packages (best-effort)..."
{
  pkg update -y || true
  pkg upgrade -y || true
} >> "$LOGFILE" 2>&1 || true

_info "Ensuring essential Termux packages are installed..."
# اطمینان از نصب nodejs-lts در هاست برای termux-api و موارد احتمالی
pkg install -y proot-distro curl wget git unzip jq openssl termux-api nodejs-lts || true

if ! command -v proot-distro >/dev/null 2>&1; then
  _fatal "proot-distro موجود نیست. ابتدا داخل Termux نصب کن: pkg install proot-distro"
fi

#######################
# نصب یا تعمیر Debian داخل proot-distro
_info "Checking proot-distro list for 'debian'..."
if ! proot-distro list | grep -q '^debian$'; then
  _info "Installing Debian container..."
  proot-distro install debian >> "$LOGFILE" 2>&1 || _fatal "نصب Debian شکست خورد. لاگ: $LOGFILE"
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
  ' >> "$LOGFILE" 2>&1 || _log "تعمیر اولیه داخل Debian اجرا شد (خطاهای جزئی نادیده گرفته شدند)."
fi

#######################
# bootstrap script که داخل Debian اجرا می‌شود
# رفع باگ: متغیرهای $PROJECT_DIR و $RAW_BASE از هاست به داخل اسکریپت تزریق می‌شوند
# تا از مقادیر hardcode شده استفاده نشود.
_info "Generating bootstrap script content..."
BOOTSTRAP=$(cat <<EOBOOT
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export UCF_FORCE_CONFFNEW=1
export APT_LISTCHANGES_FRONTEND=none

# --- مقادیر تزریق شده از هاست ---
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
npm install -g wrangler @cloudflare/pages gh --unsafe-perm=true --allow-root || true

log "Ensuring project dir exists..."
mkdir -p "\${PROJECT_DIR_HOST}" || true
cd "\${PROJECT_DIR_HOST}" || true

log "Fetching minimal raw files from \${RAW_BASE_URL}..."
curl -fsSL -o wrangler.toml "\${RAW_BASE_URL}/wrangler.toml" || true
curl -fsSL -o package.json "\${RAW_BASE_URL}/package.json" || true
curl -fsSL -o _worker.js "\${RAW_BASE_URL}/_worker.js" || true

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
  ' >> "$LOGFILE" 2>&1 || _log "Final repair also logged; در صورت نیاز dpkg --configure -a را دستی درون proot اجرا کن."
}

#######################
# اطمینان از وجود دایرکتوری پروژه روی سیستم میزبان
_info "Ensuring project dir exists on host (fallback)..."
# این مسیر ممکن است در هاست وجود نداشته باشد، اما تلاش می‌کنیم
mkdir -p "${PROJECT_DIR/#\/root\/}" 2>/dev/null || true

#######################
# ساخت wrappers در host برای اجرای wrangler/gh/pages داخل proot
_info "Creating host wrappers (wrangler-proot, gh-proot, pages-proot)..."
mkdir -p "$HOME/bin"

# رفع باگ: استفاده از "\$@" به جای $* برای مدیریت صحیح آرگومان‌های دارای فاصله
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

# رفع خطای `grep: No such file`: ابتدا فایل را `touch` می‌کنیم و سپس `grep`
_info "Ensuring ${HOME}/.profile exists..."
touch "${HOME}/.profile"

_info "Adding $HOME/bin to PATH in ~/.profile if not present..."
if ! grep -qxF 'export PATH=$HOME/bin:$PATH' ~/.profile 2>/dev/null; then
  _info "Appending PATH to ${HOME}/.profile..."
  echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile || true
else
  _info "PATH already in ${HOME}/.profile."
fi
export PATH="$HOME/bin:$PATH"

#######################
# ساخت cloudflare-login helper
_info "Creating cloudflare-login.sh helper on host..."
cat > "$HOME/cloudflare-login.sh" <<'CF'
#!/usr/bin/env bash
echo "🌐 Opening Cloudflare login in device browser..."
termux-open-url "https://dash.cloudflare.com/sign-up" >/dev/null 2>&1 || am start -a android.intent.action.VIEW -d "https://dash.cloudflare.com/sign-up"
proot-distro login debian -- bash -lc "export DEBIAN_FRONTEND=noninteractive; wrangler login"
CF
chmod +x "$HOME/cloudflare-login.sh" || true

#######################
# ساخت deploy.sh داخل proot project dir (ایمن و headless)
_info "Creating deploy.sh (headless) inside project dir..."
# رفع باگ:
# 1. افزودن `mkdir -p ${PROJECT_DIR}` برای جلوگیری از خطای "No such file".
# 2. حذف 'DEP' از <<'DEP' تا متغیر ${PROJECT_DIR} هاست به درستی به اسکریپت deploy تزریق شود.
# 3. Escape کردن ( \ ) تمام متغیرهای داخلی ($) تا در هاست اجرا نشوند.
proot-distro login debian --shared-tmp -- bash -lc "mkdir -p ${PROJECT_DIR} && cat > ${PROJECT_DIR}/deploy.sh <<DEP
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PROJECT_DIR=\"${PROJECT_DIR}\" # <-- مقدار از اسکریپت هاست تزریق شد
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
  echo \"ERROR: CLOUDFLARE_API_TOKEN not set. ایجاد فایل .env یا export CLOUDFLARE_API_TOKEN لازم است.\"
  exit 1
fi

cd \"\$PROJECT_DIR\" || exit 1

if ! command -v wrangler >/dev/null 2>&1; then
  echo \"wrangler not found — attempting npm global install...\"
  npm install -g wrangler --unsafe-perm=true --allow-root || true
fi

export CLOUDFLARE_API_TOKEN

echo \"[deploy] Using token, DEPLOY_WORKER=\$DEPLOY_WORKER, DEPLOY_PAGES=\$DEPLOY_PAGES\"

# در صورت وجود package.json: نصب وابستگی‌ها و اجرای build (در صورت وجود)
if [ -f package.json ]; then
  echo \"[deploy] package.json found — installing deps...\"
  npm ci --silent || npm install --silent || true
  if jq -e '.scripts.build' package.json >/dev/null 2>&1; then
    npm run build || true
  fi
fi

# دیپلوی Worker
if [ \"\$DEPLOY_WORKER\" = '1' ]; then
  echo \"[deploy] Deploying Worker...\"
  if wrangler deploy --api-token \"\$CLOUDFLARE_API_TOKEN\" 2>/dev/null; then
    echo \"[deploy] wrangler deploy OK\"
  else
    wrangler publish --api-token \"\$CLOUDFLARE_API_TOKEN\" || echo \"[deploy] wrangler publish attempted\"
  fi
fi

# دیپلوی Pages
if [ \"\$DEPLOY_PAGES\" = '1' ]; then
  OUT_DIR='./dist'
  if [ ! -d \"\$OUT_DIR\" ]; then
    for d in dist public out build; do
      if [ -d \"\$d\" ]; then OUT_DIR=\"\$d\"; break; fi
    done
  fi
  if [ -d \"\$OUT_DIR\" ]; then
    echo \"[deploy] Publishing Pages from \$OUT_DIR...\"
    wrangler pages publish \"\$OUT_DIR\" --project-name \"\$(jq -r .name package.json 2>/dev/null || echo pages-project)\" --api-token \"\$CLOUDFLARE_API_TOKEN\" || echo \"[deploy] pages publish attempted\"
  else
    echo \"[deploy] No Pages output dir found — build first or set DEPLOY_PAGES=0.\"
  fi
fi

echo \"[deploy] Done.\"
DEP
chmod +x ${PROJECT_DIR}/deploy.sh" >> "$LOGFILE" 2>&1 || _log "Warning: deploy.sh creation had minor issues (check log)."

#######################
# ساخت .env.template مطمئن (داخل proot)
_info "Creating .env.template inside project dir..."
# رفع باگ: افزودن `mkdir -p ${PROJECT_DIR}` برای جلوگیری از خطای "No such file".
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
# خلاصه و راهنمای نهایی
cat > "$HOME/ULTRAX_FINAL_README.txt" <<READ
UltraX Cloudflare UltraPro — Installer Completed.
Logfile: $LOGFILE
Project dir (inside proot): ${PROJECT_DIR}

Next steps:
1) اگر می‌خوای interactive لاگین با wrangler داشته باشی:
   ./cloudflare-login.sh

2) یا از API token استفاده کن:
   - داخل proot: proot-distro login debian --shared-tmp -- bash -lc "nano ${PROJECT_DIR}/.env"
   - مقدار CLOUDFLARE_API_TOKEN=your_token را ست کن
   - سپس داخل proot اجرا کن:
     proot-distro login debian --shared-tmp -- bash -lc "bash ${PROJECT_DIR}/deploy.sh"

3) می‌توانی از host هم استفاده کنی (با پشتیبانی کامل از آرگومان‌های دارای فاصله):
   - wrangler-proot deploy --message "my message"
   - pages-proot publish "./my build dir"
   - gh-proot <args>

If something fails:
- داخل proot اجرا کن:
  dpkg --configure -a && apt-get -f install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confnew"
- سپس مجدداً bootstrap را اجرا کن:
  proot-distro login debian --shared-tmp -- bash -lc "bash /root/bootstrap.sh"

READ

_info "Installer finished. See $HOME/ULTRAX_FINAL_README.txt for next steps."
echo
cat "$HOME/ULTRAX_FINAL_README.txt"
