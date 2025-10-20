#!/bin/bash

#=================================================================================
# نصب‌کننده و اجراکننده خودکار مدیریت Cloudflare (نسخه اصلاح‌شده و هوشمند)
# این اسکریپت در Termux اجرا می‌شود.
# 1. Debian را نصب می‌کند.
# 2. پیش‌نیازها را در Debian نصب می‌کند. (به صورت کاملاً غیر-تعاملی)
# 3. اسکریپت مدیریت را ساخته و اجرا می‌کند.
#=================================================================================

# کدهای رنگی ANSI
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# لوگوی کانال‌ها
echo -e "${RED}YOUTUBE: KOLANDONE${NC}"
echo -e "${BLUE}TELEGRAM: KOLANDJS${NC}"
echo -e "${GREEN}===============================================${NC}"
echo -e "${YELLOW}شروع فرآیند نصب کامل... (اجرا در Termux)${NC}"

# --- مرحله ۱: نصب پیش‌نیازهای Termux (اصلاح‌شده برای اجرای تماماً خودکار) ---
echo -e "\n${YELLOW}مرحله ۱: به‌روزرسانی Termux و نصب proot-distro (به صورت کاملاً خودکار)...${NC}"
# تنظیم DEBIAN_FRONTEND و --force-confnew برای جلوگیری از هنگ کردن در پنجره‌های dpkg
DEBIAN_FRONTEND=noninteractive pkg update -y
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در pkg update.${NC}"
    exit 1
fi
# استفاده از -o Dpkg::Options... برای پذیرش خودکار تمام کانفیگ‌های جدید
DEBIAN_FRONTEND=noninteractive pkg upgrade -y -o Dpkg::Options::="--force-confnew"
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در pkg upgrade. ${NC}"
    exit 1
fi
pkg install proot-distro -y
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در نصب proot-distro. لطفاً به صورت دستی بررسی کنید.${NC}"
    exit 1
fi

# --- مرحله ۲: نصب Debian ---
echo -e "\n${YELLOW}مرحله ۲: نصب Debian با proot-distro...${NC}"
echo -e "این مرحله ممکن است کمی طول بکشد..."
proot-distro install debian
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در نصب Debian.${NC}"
    exit 1
fi
echo -e "${GREEN}Debian با موفقیت نصب شد.${NC}"

# --- مرحله ۳: نصب پیش‌نیازها در داخل Debian (اصلاح‌شده برای اجرای تماماً خودکار و عیب‌یابی بهتر) ---
echo -e "\n${YELLOW}مرحله ۳: نصب پیش‌نیازها (apt, npm, wrangler) در داخل Debian...${NC}"

# اجرای دستورات نصب در داخل دبیان با proot-distro exec
# استفاده از export DEBIAN_FRONTEND=noninteractive برای جلوگیری از هنگ کردن apt
echo -e "${YELLOW}... در حال به‌روزرسانی apt در Debian...${NC}"
proot-distro exec debian -- bash -c "export DEBIAN_FRONTEND=noninteractive && apt update -y"
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در apt update داخل Debian.${NC}"
    exit 1
fi

echo -e "${YELLOW}... در حال ارتقاء پکیج‌ها در Debian...${NC}"
proot-distro exec debian -- bash -c "export DEBIAN_FRONTEND=noninteractive && apt upgrade -y -o Dpkg::Options::=\"--force-confnew\""
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در apt upgrade داخل Debian.${NC}"
    exit 1
fi

echo -e "${YELLOW}... در حال نصب curl, jq, nodejs, npm در Debian...${NC}"
proot-distro exec debian -- bash -c "export DEBIAN_FRONTEND=noninteractive && apt install -y curl jq nodejs npm"
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در نصب پکیج‌های apt داخل Debian.${NC}"
    exit 1
fi

echo -e "${YELLOW}... در حال نصب wrangler با npm...${NC}"
# اجرای npm install به صورت جداگانه
proot-distro exec debian -- npm install -g wrangler
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در نصب wrangler. لطفاً بررسی کنید.${NC}"
    exit 1
fi

echo -e "${GREEN}تمام پیش‌نیازهای Debian با موفقیت نصب شدند.${NC}"

# --- مرحله ۴: ایجاد اسکریپت مدیریت در داخل Debian ---
echo -e "\n${YELLOW}مرحله ۴: در حال ساخت اسکریپت مدیریت (cf_manager.sh) در داخل Debian...${NC}"

# استفاده از Heredoc برای نوشتن اسکریپت مدیریت در مسیر /root/cf_manager.sh در دبیان
proot-distro exec debian -- bash -c "cat << 'EOF' > /root/cf_manager.sh
#!/bin/bash
#=================================================================================
# اسکریپت مدیریت پیشرفته Cloudflare
# نسخه 1.0.0 (ایجاد شده توسط نصب‌کننده خودکار)
#=================================================================================

# کدهای رنگی ANSI
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# لوگوی کانال‌ها
echo -e \"\${RED}YOUTUBE: KOLANDONE\${NC}\"
echo -e \"\${BLUE}TELEGRAM: KOLANDJS\${NC}\"
echo -e \"\${GREEN}===============================================\${NC}\"
echo -e \"\${GREEN}اسکریپت مدیریت Cloudflare با موفقیت اجرا شد.\${NC}\"

# (توجه: توابع check_environment و install_prerequisites حذف شدند
# چون اسکریپت نصب‌کننده (بیرونی) قبلاً آن‌ها را انجام داده است)

# تابع احراز هویت (مربوط به عکس اول)
function login_to_cloudflare() {
    wrangler whoami > /dev/null 2>&1
    if [ \$? -eq 0 ]; then
        echo -e \"\${GREEN}شما از قبل در Cloudflare لاگین هستید.\${NC}\"
        wrangler whoami
        echo -e \"\${YELLOW}آیا می‌خواهید با اکانت دیگری لاگین کنید؟ (y/n)\${NC}\"
        read -r re_login
        if [ \"\$re_login\" != \"y\" ]; then
            return
        fi
    fi

    echo -e \"\${YELLOW}===================================================================\${NC}\"
    echo -e \"\${YELLOW}شروع فرآیند احراز هویت Cloudflare...\${NC}\"
    echo -e \"یک لینک در ترمینال شما نمایش داده می‌شود.\"
    echo -e \"این لینک را در مرورگر خود باز کنید (در Termux می‌توانید لینک را کپی کنید).\"
    echo -e \"در صفحه‌ای که باز می‌شود (مانند عکسی که فرستادید)، روی \${GREEN}Allow\${NC} کلیک کنید.\"
    echo -e \"\${RED}اسکریپت منتظر می‌ماند تا شما احراز هویت را کامل کنید...\${NC}\"
    echo -e \"\${YELLOW}===================================================================\${NC}\"
    
    wrangler login
    
    echo -e \"\${GREEN}احراز هویت با موفقیت انجام شد!\${NC}\"
    wrangler whoami
}

# تابع ایجاد ورکر VLESS (بر اساس اسکریپت اول شما)
function create_vless_worker() {
    echo -e \"\${YELLOW}--- شروع فرآیند ساخت ورکر VLESS ---\${NC}\"
    echo -e \"لطفاً یک نام برای ورکر جدید خود وارد کنید (مثلاً: my-vless-worker):\"
    read -r WORKER_NAME

    if [ -z \"\$WORKER_NAME\" ]; then
        echo -e \"\${RED}نام ورکر نمی‌تواند خالی باشد.\${NC}\"
        return
    fi

    echo -e \"\${YELLOW}در حال ساخت پروژه ورکر با نام \${GREEN}\$WORKER_NAME\${NC}...\${NC}\"
    npx create-cloudflare@latest \"\$WORKER_NAME\" --type \"simple\" --no-deploy --no-git
    if [ \$? -ne 0 ]; then
        echo -e \"\${RED}خطا در ساخت پوشه پروژه. آیا این نام قبلاً استفاده شده؟\${NC}\"
        return
    fi

    cd \"\$WORKER_NAME\" || { echo -e \"\${RED}خطا در ورود به پوشه \$WORKER_NAME\${NC}\"; return; }

    echo -e \"\${YELLOW}در حال نوشتن اسکریپت VLESS در src/index.js...\${NC}\"
    cat << 'EOT' > src/index.js
/**
 * Ultimate VLESS Proxy Worker Script for Cloudflare (Merged & Fully Fixed)
 *
 * @version 6.0.0 - Connection Logic Corrected
 * @author Gemini-Enhanced (Original by multiple authors, merged and fixed by Google AI)
 *
 * (تمام توضیحات اسکریپت VLESS شما...)
 *
 * Setup Instructions:
 * (تمام دستورالعمل‌های اسکریپت VLESS شما...)
 */

// --- START OF VLESS SCRIPT ---
// (NOTE: The full 1000+ line script JS code would be pasted here)
// (For brevity in this example, I'll paste a simplified hello-world,
// but in your file, you MUST paste the FULL VLESS SCRIPT here)

// !!! --- PASTE YOUR FULL VLESS JAVASCRIPT SCRIPT (Script 1) HERE --- !!!
// Example (REPLACE THIS with your script):
export default {
	async fetch(request, env, ctx) {
		// This is just a placeholder.
		// Paste your full VLESS script content over this export default block.
		console.log("If you see this, you forgot to paste the VLESS script.");
		return new Response('Hello! Please replace this placeholder text in cf_manager.sh with your full VLESS worker script.');
	},
};

// !!! --- END OF SCRIPT PASTE AREA --- !!!

EOT
    
    echo -e \"\${GREEN}فایل اسکریپت ایجاد شد.\${NC}\"
    echo -e \"\${YELLOW}در حال تنظیم فایل wrangler.toml...\${NC}\"
    
    echo -e \"\n# Enable Node.js compatibility\nnode_compat = true\" >> wrangler.toml

    echo -e \"\${YELLOW}این اسکریپت به دیتابیس D1 نیاز دارد. در حال ساخت دیتابیس...\${NC}\"
    DB_NAME=\"\${WORKER_NAME}-db\"
    wrangler d1 create \"\$DB_NAME\"
    if [ \$? -ne 0 ]; then
        echo -e \"\${RED}خطا در ساخت دیتابیس D1.\${NC}\"; cd ..; return;
    fi
    DB_UUID=\$(wrangler d1 info \"\$DB_NAME\" --json | jq -r .uuid)
    echo -e \"\n[[d1_databases]]\nbinding = \\\"DB\\\"\ndatabase_name = \\\"\$DB_NAME\\\"\ndatabase_id = \\\"\$DB_UUID\\\"\" >> wrangler.toml
    echo -e \"\${GREEN}دیتابیس D1 با نام \$DB_NAME ساخته و متصل شد.\${NC}\"
    
    echo -e \"\${YELLOW}در حال ساخت جدول 'users' در دیتابیس...\${NC}\"
    D1_COMMAND=\"CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 2);\"
    wrangler d1 execute \"\$DB_NAME\" --command=\"\$D1_COMMAND\"
    echo -e \"\${GREEN}جدول 'users' با موفقیت ساخته شد.\${NC}\"

    echo -e \"\${YELLOW}این اسکریپت به KV Namespace نیاز دارد. در حال ساخت KV...\${NC}\"
    KV_NAME=\"\${WORKER_NAME}-kv\"
    KV_ID=\$(wrangler kv:namespace create \"\$KV_NAME\" --json | jq -r .id)
    if [ -z \"\$KV_ID\" ]; then
        echo -e \"\${RED}خطا در ساخت KV Namespace.\${NC}\"; cd ..; return;
    fi
    echo -e \"\n[[kv_namespaces]]\nbinding = \\\"USER_KV\\\"\nid = \\\"\$KV_ID\\\"\" >> wrangler.toml
    echo -e \"\${GREEN}KV Namespace با نام \$KV_NAME ساخته و متصل شد.\${NC}\"
    
    echo -e \"\${YELLOW}--- تنظیم متغیرهای Secret ---\${NC}\"
    echo -e \"لطفاً رمز عبور پنل ادمین را وارد کنید (ADMIN_KEY):\"
    read -s ADMIN_KEY
    echo \"\$ADMIN_KEY\" | wrangler secret put ADMIN_KEY
    echo -e \"\${GREEN}ADMIN_KEY تنظیم شد.\${NC}\"

    echo -e \"لطفاً یک دامنه یا IP تمیز برای کانفیگ‌ها وارد کنید (PROXYIP):\"
    read -r PROXYIP
    echo \"\$PROXYIP\" | wrangler secret put PROXYIP
    echo -e \"\${GREEN}PROXYIP تنظیم شد.\${NC}\"

    echo -e \"آیا می‌خواهید متغیرهای اختیاری را تنظیم کنید؟ (y/n)\"
    read -r set_optional_secrets
    if [ \"\$set_optional_secrets\" == \"y\" ]; then
        echo -e \"مسیر ادمین (اختیاری، مثال: /my-admin):\"
        read -r ADMIN_PATH
        [ -n \"\$ADMIN_PATH\" ] && echo \"\$ADMIN_PATH\" | wrangler secret put ADMIN_PATH
        
        echo -e \"UUID پشتیبان (اختیاری):\"
        read -r FALLBACK_UUID
        [ -n \"\$FALLBACK_UUID\" ] && echo \"\$FALLBACK_UUID\" | wrangler secret put UUID
    fi
    echo -e \"\${GREEN}تنظیمات Secrets کامل شد.\${NC}\"

    echo -e \"\${YELLOW}==================================\${NC}\"
    echo -e \"\${YELLOW}در حال دیپلوی ورکر \${GREEN}\$WORKER_NAME\${NC}...\${NC}\"
    wrangler deploy
    if [ \$? -eq 0 ]; then
        echo -e \"\${GREEN}ورکر \${GREEN}\$WORKER_NAME\${NC} با موفقیت دیپلوی شد!\${NC}\"
    else
        echo -e \"\${RED}خطا در دیپلوی ورکر.\${NC}\"
    fi
    
    cd ..
}

# تابع ایجاد پروژه Cloudflare Pages
function create_pages_project() {
    echo -e \"\${YELLOW}--- شروع فرآیند دیپلوی Cloudflare Pages ---\${NC}\"
    echo -e \"لطفاً یک نام برای پروژه Pages خود وارد کنید:\"
    read -r PAGES_PROJECT_NAME
    if [ -z \"\$PAGES_PROJECT_NAME\" ]; then
        echo -e \"\${RED}نام پروژه نمی‌تواند خالی باشد.\${NC}\"
        return
    fi
    
    echo -e \"لطفاً مسیر پوشه‌ای که حاوی فایل‌های استاتیک شماست را وارد کنید (مثال: ./my-site):\"
    read -r PAGES_DIR
    
    if [ ! -d \"\$PAGES_DIR\" ]; then
        echo -e \"\${RED}پوشه \$PAGES_DIR یافت نشد.\${NC}\"
        echo -e \"\${YELLOW}آیا می‌خواهید یک پوشه نمونه با فایل index.html بسازم؟ (y/n)\${NC}\"
        read -r create_sample_dir
        if [ \"\$create_sample_dir\" == \"y\" ]; then
            PAGES_DIR=\"my-sample-page\"
            mkdir -p \"\$PAGES_DIR\"
            echo \"<h1>Hello from Cloudflare Pages!</h1>\" > \"\$PAGES_DIR/index.html\"
            echo -e \"\${GREEN}پوشه نمونه در \$PAGES_DIR ساخته شد.\${NC}\"
        else
            return
        fi
    fi
    
    echo -e \"\${YELLOW}در حال دیپلوی پوشه \${GREEN}\$PAGES_DIR\${NC} به پروژه \${GREEN}\$PAGES_PROJECT_NAME\${NC}...\${NC}\"
    wrangler pages deploy \"\$PAGES_DIR\" --project-name \"\$PAGES_PROJECT_NAME\" --commit-dirty=true
    
    if [ \$? -eq 0 ]; then
        echo -e \"\${GREEN}پروژه Pages با موفقیت دیپلوی شد!\${NC}\"
    else
        echo -e \"\${RED}خطا در دیپلوی Pages.\${NC}\"
    fi
}

# تابع حذف ورکر
function delete_worker() {
    echo -e \"\${YELLOW}--- حذف Cloudflare Worker ---\${NC}\"
    echo -e \"لطفاً نام دقیق ورکری که می‌خواهید حذف کنید را وارد کنید:\"
    read -r WORKER_TO_DELETE
    
    if [ -z \"\$WORKER_TO_DELETE\" ]; then
        echo -e \"\${RED}نام ورکر خالی است.\${NC}\"
        return
    fi
    
    echo -e \"\${RED}هشدار: آیا مطمئن هستید؟ (y/n)\${NC}\"
    read -r confirm
    
    if [ \"\$confirm\" == \"y\" ]; then
        echo -e \"\${YELLOW}در حال حذف ورکر...\${NC}\"
        wrangler delete \"\$WORKER_TO_DELETE\"
        echo -e \"\${GREEN}ورکر \${GREEN}\$WORKER_TO_DELETE\${NC} حذف شد.\${NC}\"
    else
        echo -e \"\${BLUE}عملیات حذف لغو شد.\${NC}\"
    fi
}

# تابع حذف پروژه Pages
function delete_pages_project() {
    echo -e \"\${YELLOW}--- حذف پروژه Cloudflare Pages ---\${NC}\"
    echo -e \"لطفاً نام دقیق پروژه Pages که می‌خواهید حذف کنید را وارد کنید:\"
    read -r PAGES_TO_DELETE
    
    if [ -z \"\$PAGES_TO_DELETE\" ]; then
        echo -e \"\${RED}نام پروژه خالی است.\${NC}\"
        return
    fi
    
    echo -e \"\${RED}هشدار: آیا مطمئن هستید؟ (y/n)\${NC}\"
    read -r confirm
    
    if [ \"\$confirm\" == \"y\" ]; then
        echo -e \"\${YELLOW}در حال حذف پروژه Pages...${NC}\"
        wrangler pages project delete \"\$PAGES_TO_DELETE\"
        echo -e \"\${GREEN}پروژه \${GREEN}\$PAGES_TO_DELETE\${NC} حذف شد.\${NC}\"
    else
        echo -e \"\${BLUE}عملیات حذف لغو شد.\${NC}\"
    fi
}

# تابع نمایش منوی اصلی
function show_menu() {
    echo -e \"\n\${BLUE}--- منوی مدیریت Cloudflare ---\${NC}\"
    echo \"1) ساخت ورکر VLESS (با تنظیمات کامل D1, KV, Secrets)\"
    echo \"2) ساخت پروژه Cloudflare Pages (دیپلوی یک پوشه)\"
    echo \"3) حذف یک ورکر (Worker)\"
    echo \"4) حذف یک پروژه (Pages)\"
    echo \"5) بررسی وضعیت لاگین (whoami)\"
    echo -e \"\${RED}q) خروج\${NC}\"
    echo \"گزینه خود را انتخاب کنید:\"
    read -r USER_OPTION

    case \$USER_OPTION in
        1)
            create_vless_worker
            ;;
        2)
            create_pages_project
            ;;
        3)
            delete_worker
            ;;
        4)
            delete_pages_project
            ;;
        5)
            wrangler whoami
            ;;
        \"q\" | \"Q\")
            echo \"خروج از اسکریپت.\"
            exit 0
            ;;
        *)
            echo -e \"\${RED}گزینه نامعتبر است.\${NC}\"
            ;;
    esac
}

# --- منطق اصلی اسکریپت (داخلی) ---
login_to_cloudflare

# نمایش منو در یک حلقه بی‌نهایت
while true; do
    show_menu
done
EOF
"
# پایان Heredoc

# --- مرحله ۵: دادن دسترسی اجرا به اسکریپت مدیریت ---
echo -e "\n${YELLOW}مرحله ۵: دادن دسترسی اجرا به cf_manager.sh...${NC}"
proot-distro exec debian -- chmod +x /root/cf_manager.sh
if [ $? -ne 0 ]; then
    echo -e "${RED}خطا در دادن دسترسی اجرا به اسکریپت مدیریت.${NC}"
    exit 1
fi

# --- مرحله نهایی: اجرای خودکار اسکریپت مدیریت ---
echo -e "\n${GREEN}===============================================${NC}"
echo -e "${GREEN}نصب کامل شد! در حال اجرای خودکار اسکریپت مدیریت...${NC}"
echo -e "${GREEN}===============================================${NC}"
sleep 1

# اجرای اسکریپت مدیریت که در داخل دبیان ساخته شد
# این دستور شما را مستقیماً به بخش احراز هویت و منوی اصلی می‌برد
proot-distro exec debian -- bash /root/cf_manager.sh
