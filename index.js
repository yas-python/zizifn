/**
 * Ultimate Cloudflare Worker VLESS Proxy - Final Version
 *
 * This script is the result of merging two powerful scripts, fixing connection issues,
 * and implementing a suite of professional and intelligent features.
 *
 * --- KEY FEATURES ---
 *
 * Admin & Management:
 * - Advanced, secure, and responsive Admin Panel at /admin.
 * - Secure session-based login with CSRF token protection for all actions.
 * - Full user lifecycle management: Create, Edit, Delete.
 * - Time-based expiration with full timezone support.
 * - Smart Traffic Limiting: Set data caps (MB/GB/Unlimited) for users.
 * - Usage is tracked, and connections are cut off when the limit is reached.
 * - Admin dashboard with key stats: Total/Active/Expired users, Total Traffic.
 *
 * User Experience & Intelligence:
 * - Smart Network Information Panel: On the user's config page, it displays:
 * - [Proxy Server] info: Worker's public IP, Location, and ISP.
 * - [Your Connection] info: User's public IP, Location, and ISP.
 * - Dynamic Config Page: Shows relative expiration time, data usage with a progress bar.
 * - One-Click Import: Links for popular clients (V2rayNG, Shadowrocket, Stash, etc.).
 * - QR Code generation for all subscriptions.
 *
 * Security & Performance:
 * - IP-Based Connection Limiting: Prevents account sharing by limiting simultaneous IPs per user (default is 2).
 * - High-Performance Caching: User data is cached in KV for near-instant connection authentication.
 * - Persistent D1 Database: All user data is reliably stored in Cloudflare's D1.
 * - Stable Connection Logic: Uses the robust connection and subscription generation engine.
 *
 * --- SETUP INSTRUCTIONS ---
 *
 * 1. D1 Database:
 * - Create a D1 Database.
 * - Bind it to the worker as `DB`.
 * - Run this SQL command to initialize the schema:
 * CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0);
 *
 * 2. KV Namespace:
 * - Create a KV Namespace.
 * - Bind it to the worker as `USER_KV`. (Used for caching, admin sessions, and IP limiting).
 *
 * 3. Secrets:
 * - In worker settings, add the following secrets:
 * - `ADMIN_KEY`: Your password for the /admin panel.
 * - `UUID` (Optional): A fallback UUID.
 * - `PROXYIP` (Optional): A fallback proxy IP/domain for links.
 */

import { connect } from 'cloudflare:sockets';

// --- Constants & Configuration ---
const MAX_IPS_PER_USER = 2; // Max simultaneous IPs per user.
const IP_LIMIT_TTL_SECONDS = 3600; // How long an IP is remembered (1 hour).

// --- Helper & Utility Functions ---

/**
 * Validates if a string is a standard RFC4122 UUID.
 * @param {string} uuid The string to validate.
 * @returns {boolean} True if the string is a valid UUID.
 */
function isValidUUID(uuid) {
    if (typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

/**
 * Checks if a user's expiration date and time have passed.
 * @param {string} expDate - The expiration date in 'YYYY-MM-DD' format (UTC).
 * @param {string} expTime - The expiration time in 'HH:MM:SS' format (UTC).
 * @returns {boolean} True if expired.
 */
function isExpired(expDate, expTime) {
    if (!expDate || !expTime) return true;
    const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
    return expDatetimeUTC <= new Date();
}

/**
 * Retrieves user data, checking KV cache first, then falling back to D1.
 * @param {object} env - The worker environment object.
 * @param {string} uuid - The user's UUID.
 * @returns {Promise<object|null>} The user data or null if not found/invalid.
 */
async function getUserData(env, uuid) {
    if (!isValidUUID(uuid)) return null;
    const cacheKey = `user:${uuid}`;

    try {
        const cachedData = await env.USER_KV.get(cacheKey, 'json');
        if (cachedData && typeof cachedData.uuid === 'string') {
            return cachedData;
        }
    } catch (e) {
        console.error(`Failed to parse cached user data for ${uuid}`, e);
    }

    const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!userFromDb) return null;

    await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 });
    return userFromDb;
}


// --- IP Geolocation/Intelligence Functions ---

/**
 * Fetches geolocation and ISP data for a given IP address using ip-api.com.
 * @param {string} ip - The IP address to check.
 * @returns {Promise<{ip: string, country: string, city: string, isp: string}|null>}
 */
async function getIPInfo(ip) {
    if (!ip) return null;
    try {
        // Using a more reliable field set for ip-api.com
        const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,isp,query,org`);
        if (!response.ok) throw new Error(`ip-api.com status: ${response.status}`);
        const data = await response.json();

        if (data.status === 'success') {
            return {
                ip: data.query,
                country: data.country || 'Unknown',
                countryCode: data.countryCode,
                city: data.city || 'Unknown',
                isp: data.isp || data.org || 'Unknown',
            };
        }
        return null;
    } catch (e) {
        console.error(`Error fetching IP info for ${ip}:`, e);
        return null;
    }
}

/**
 * Determines the Cloudflare Worker's egress IP and fetches its info.
 * Caches the result in KV for 1 hour to reduce API calls.
 * @param {object} env - The worker environment object.
 * @returns {Promise<object|null>}
 */
async function getProxyIPInfo(env) {
    const cacheKey = 'proxy_ip_info';
    try {
        const cachedInfo = await env.USER_KV.get(cacheKey, 'json');
        if (cachedInfo) return cachedInfo;
    } catch (e) { console.error("KV get for proxy IP failed", e); }


    try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        if (!ipResponse.ok) throw new Error("ipify failed");
        const { ip } = await ipResponse.json();

        const ipInfo = await getIPInfo(ip);

        if (ipInfo) {
            await env.USER_KV.put(cacheKey, JSON.stringify(ipInfo), { expirationTtl: 3600 });
            return ipInfo;
        }
    } catch (e) {
        console.error('Failed to determine proxy IP info:', e);
    }
    return null;
}

// --- IP-Based Connection Limiting Logic ---
/**
 * Checks if a user's IP is allowed to connect based on the limit.
 * @param {object} env - The worker environment.
 * @param {string} uuid - User's UUID.
 * @param {string} ip - User's connecting IP.
 * @returns {Promise<boolean>} - True if connection is allowed.
 */
async function checkIPLimit(env, uuid, ip) {
    const key = `ip_limit:${uuid}`;
    let data = await env.USER_KV.get(key, 'json');

    if (!data || !Array.isArray(data.ips)) {
        data = { ips: [] };
    }

    const now = Date.now();
    // Filter out old IPs
    data.ips = data.ips.filter(record => now - record.timestamp < IP_LIMIT_TTL_SECONDS * 1000);

    const existingIp = data.ips.find(record => record.ip === ip);

    if (existingIp) {
        // IP is already in the list, refresh its timestamp
        existingIp.timestamp = now;
    } else {
        // New IP, check if there's space
        if (data.ips.length >= MAX_IPS_PER_USER) {
            console.log(`IP limit reached for user ${uuid}. Denying IP ${ip}.`);
            return false; // Limit reached
        }
        // Add the new IP
        data.ips.push({ ip: ip, timestamp: now });
    }

    await env.USER_KV.put(key, JSON.stringify(data), { expirationTtl: IP_LIMIT_TTL_SECONDS });
    return true;
}


// --- Admin Panel & API ---

const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1F2937;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #374151}h1{color:#F9FAFB;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#374151;border:1px solid #4B5563;color:#F9FAFB;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px;transition:border-color .2s,box-shadow .2s}input[type=password]:focus{outline:0;border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}button{background-color:#3B82F6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#2563EB}.error{color:#EF4444;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST" action="/admin"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;

const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>:root{--bg-main:#0c0a09;--bg-card:#1c1917;--bg-input:#292524;--border:#44403c;--text-primary:#f5f5f4;--text-secondary:#a8a29e;--accent:#fb923c;--accent-hover:#f97316;--danger:#ef4444;--danger-hover:#dc2626;--success:#4ade80;--expired:#facc15;--btn-secondary-bg:#57534e;--btn-secondary-hover:#78716c}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1280px;margin:30px auto;padding:0 20px}.card{background-color:var(--bg-card);border-radius:12px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3)}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}.stat-card{background-color:var(--bg-card);border-radius:12px;padding:20px;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}.stat-card:hover{transform:translateY(-5px);box-shadow:0 8px 16px rgba(0,0,0,.4)}.stat-title{font-size:14px;color:var(--text-secondary);margin:0 0 10px}.stat-value{font-size:28px;font-weight:600;margin:0}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.input-group{display:flex}input,select{width:100%;box-sizing:border-box;background-color:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s,box-shadow .2s}input:focus,select:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(251,146,60,.3)}.btn{padding:10px 16px;border:none;border-radius:6px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.97)}.btn-primary{background-color:var(--accent);color:var(--bg-main)}.btn-primary:hover{background-color:var(--accent-hover)}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:var(--btn-secondary-hover)}.input-group button{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input,.input-group select{border-radius:0;border-right:none}.input-group input:first-child{border-top-left-radius:6px;border-bottom-left-radius:6px}.input-group button:last-child{border-top-right-radius:6px;border-bottom-right-radius:6px;border-right:1px solid var(--border)}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase}.status-badge{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:rgba(74,222,128,.2);color:var(--success)}.status-expired{background-color:rgba(250,204,21,.2);color:var(--expired)}.actions-cell{display:flex;gap:8px;justify-content:flex-start}#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:var(--bg-card);color:#fff;padding:15px 25px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:all .3s}#toast.show{display:block;opacity:1;transform:translate(-50%,-10px)}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;width:90%;max-width:550px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:15px;margin-bottom:20px;border-bottom:1px solid var(--border)}.modal-header h2{margin:0;font-size:20px}.modal-close-btn{background:0 0;border:none;color:var(--text-secondary);font-size:24px;cursor:pointer}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.traffic-bar{width:100%;background-color:var(--bg-input);border-radius:4px;height:6px;overflow:hidden;margin-top:4px}.traffic-bar-inner{height:100%;background-color:var(--accent);border-radius:4px;transition:width .5s}.form-check{display:flex;align-items:center;margin-top:10px}.form-check input{width:auto;margin-right:8px}@media (max-width:768px){.container{padding:0 10px;margin-top:15px}.stats-grid{grid-template-columns:1fr 1fr}.user-list-wrapper{overflow-x:auto;-webkit-overflow-scrolling:touch}table{min-width:800px}}</style></head><body><div class="container"><div id="stats" class="stats-grid"></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><input type="hidden" id="csrf_token" name="csrf_token"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" placeholder="e.g., 10"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group" style="grid-column:1/-1;align-items:flex-start;margin-top:10px"><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="user-list-wrapper"><table><thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm" class="form-grid"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div><div class="form-group"><label for="editExpiryTime">Expiry Time (Your Local Time)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required></div><div class="form-group"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" placeholder="e.g., 10"><select id="editDataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group form-check" style="grid-column:1/-1"><input type="checkbox" id="resetTraffic"><label for="resetTraffic">Reset Traffic Usage</label></div><div class="modal-footer" style="grid-column:1/-1"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>document.addEventListener("DOMContentLoaded",()=>{const e="/admin/api",t=document.getElementById("csrf_token").value,n={get:t=>fetch(`${e}${t}`).then(handleResponse),post:(t,n)=>fetch(`${e}${t}`,{method:"POST",headers:{...s,Accept:"application/json"},body:JSON.stringify(n)}).then(handleResponse),put:(t,n)=>fetch(`${e}${t}`,{method:"PUT",headers:{...s,Accept:"application/json"},body:JSON.stringify(n)}).then(handleResponse),delete:t=>fetch(`${e}${t}`,{method:"DELETE",headers:s}).then(handleResponse)},s={"Content-Type":"application/json","X-CSRF-Token":t};async function handleResponse(e){if(403===e.status)throw showToast("Session expired or invalid. Please refresh the page.",!0),new Error("Forbidden: Invalid session or CSRF token.");if(!e.ok){const t=await e.json().catch(()=>({error:"An unknown error occurred."}));throw new Error(t.error||`Request failed with status ${e.status}`)}return 204===e.status?null:e.json()}function o(e,t=!1){const n=document.getElementById("toast");n.textContent=e,n.style.backgroundColor=t?"var(--danger)":"var(--success)",n.classList.add("show"),setTimeout(()=>{n.classList.remove("show")},3e3)}const a=e=>e.toString().padStart(2,"0"),i=(e,t)=>{if(!e||!t)return{utcDate:"",utcTime:""};const n=new Date(`${e}T${t}`);return{utcDate:`${n.getUTCFullYear()}-${a(n.getUTCMonth()+1)}-${a(n.getUTCDate())}`,utcTime:`${a(n.getUTCHours())}:${a(n.getUTCMinutes())}:${a(n.getUTCSeconds())}`}},d=(e,t)=>{if(!e||!t)return{localDate:"",localTime:""};const n=new Date(`${e}T${t}Z`);return{localDate:`${n.getFullYear()}-${a(n.getMonth()+1)}-${a(n.getDate())}`,localTime:`${a(n.getHours())}:${a(n.getMinutes())}:${a(n.getSeconds())}`}},r=e=>{if(0===e)return"0 Bytes";const t=Math.floor(Math.log(e)/Math.log(1024));return`${parseFloat((e/Math.pow(1024,t)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][t]}`};function c(e){document.getElementById("stats").innerHTML=`<div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">${e.totalUsers}</p></div>
<div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">${e.activeUsers}</p></div>
<div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">${e.expiredUsers}</p></div>
<div class="stat-card"><h3 class="stat-title">Total Traffic Used</h3><p class="stat-value">${r(e.totalTraffic)}</p></div>`}function l(e){const t=document.getElementById("userList");t.innerHTML=0===e.length?'<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>':e.map(e=>{const t=new Date(`${e.expiration_date}T${e.expiration_time}Z`),n=t<new Date,s=e.data_limit>0?`${r(e.data_usage)} / ${r(e.data_limit)}`:`${r(e.data_usage)} / &infin;`,o=e.data_limit>0?Math.min(100,e.data_usage/e.data_limit*100):0;return`<tr data-uuid="${e.uuid}"><td title="${e.uuid}">${e.uuid.substring(0,8)}...</td><td>${new Date(e.created_at).toLocaleString()}</td><td>${t.toLocaleString()}</td><td><span class="status-badge ${n?"status-expired":"status-active"}">${n?"Expired":"Active"}</span></td><td>${s}<div class="traffic-bar"><div class="traffic-bar-inner" style="width: ${o}%;"></div></div></td><td>${e.notes||"-"}</td><td class="actions-cell"><button class="btn btn-secondary btn-edit">Edit</button>
<button class="btn btn-danger btn-delete">Delete</button></td></tr>`}).join("")}async function u(){try{const[e,t]=await Promise.all([n.get("/stats"),n.get("/users")]);window.allUsers=t,c(e),l(t)}catch(e){o(e.message,!0)}}const m=(e,t)=>{const n=parseFloat(document.getElementById(e).value),s=document.getElementById(t).value;if(isNaN(n)||n<=0)return 0;return Math.round(n*("GB"===s?1073741824:1048576))},p=(e,t,n)=>{const s=document.getElementById(t),o=document.getElementById(n);if(e<=0)return s.value="",void(o.value="GB");const a=e>=1073741824,i=a?"GB":"MB",d=a?1073741824:1048576;s.value=parseFloat((e/d).toFixed(2)),o.value=i};document.getElementById("createUserForm").addEventListener("submit",async e=>{e.preventDefault();const t=i(document.getElementById("expiryDate").value,document.getElementById("expiryTime").value),s={uuid:document.getElementById("uuid").value,exp_date:t.utcDate,exp_time:t.utcTime,data_limit:m("dataLimitValue","dataLimitUnit"),notes:document.getElementById("notes").value};try{await n.post("/users",s),o("User created successfully!"),e.target.reset(),document.getElementById("uuid").value=crypto.randomUUID(),g(),u()}catch(e){o(e.message,!0)}});const f=document.getElementById("editModal");document.getElementById("userList").addEventListener("click",e=>{const t=e.target.closest("button");if(!t)return;const s=e.target.closest("tr").dataset.uuid;if(t.classList.contains("btn-edit")){const e=window.allUsers.find(e=>e.uuid===s);if(!e)return;const t=d(e.expiration_date,e.expiration_time);document.getElementById("editUuid").value=e.uuid,document.getElementById("editExpiryDate").value=t.localDate,document.getElementById("editExpiryTime").value=t.localTime,p(e.data_limit,"editDataLimitValue","editDataLimitUnit"),document.getElementById("editNotes").value=e.notes||"",document.getElementById("resetTraffic").checked=!1,f.classList.add("show")}else t.classList.contains("btn-delete")&&confirm(`Are you sure you want to delete user ${s.substring(0,8)}...?`)&&n.delete(`/users/${s}`).then(()=>{o("User deleted successfully!"),u()}).catch(e=>o(e.message,!0))}),document.getElementById("editUserForm").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("editUuid").value,s=i(document.getElementById("editExpiryDate").value,document.getElementById("editExpiryTime").value),a={exp_date:s.utcDate,exp_time:s.utcTime,data_limit:m("editDataLimitValue","editDataLimitUnit"),notes:document.getElementById("editNotes").value,reset_traffic:document.getElementById("resetTraffic").checked};try{await n.put(`/users/${t}`,a),o("User updated successfully!"),f.classList.remove("show"),u()}catch(e){o(e.message,!0)}});const h=()=>f.classList.remove("show");document.getElementById("modalCloseBtn").addEventListener("click",h),document.getElementById("modalCancelBtn").addEventListener("click",h),f.addEventListener("click",e=>{e.target===f&&h()}),document.addEventListener("keydown",e=>{"Escape"===e.key&&h()}),document.getElementById("generateUUID").addEventListener("click",()=>document.getElementById("uuid").value=crypto.randomUUID()),document.getElementById("unlimitedBtn").addEventListener("click",()=>{document.getElementById("dataLimitValue").value=""}),document.getElementById("editUnlimitedBtn").addEventListener("click",()=>{document.getElementById("editDataLimitValue").value=""});const g=()=>{const e=new Date;e.setMonth(e.getMonth()+1),document.getElementById("expiryDate").value=`${e.getFullYear()}-${a(e.getMonth()+1)}-${a(e.getDate())}`,document.getElementById("expiryTime").value=`${a(e.getHours())}:${a(e.getMinutes())}:${a(e.getSeconds())}`};document.getElementById("uuid").value=crypto.randomUUID(),g(),u()});</script></body></html>`;

/**
 * Middleware to check admin authentication and CSRF token.
 */
async function checkAdminAuth(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    const sessionToken = cookieHeader?.match(/auth_token=([^;]+)/)?.[1];
    
    if (!sessionToken) {
        return { isAdmin: false, errorResponse: null, csrfToken: null };
    }

    const storedSession = await env.USER_KV.get(`admin_session:${sessionToken}`, 'json');
    if (!storedSession) {
        const headers = new Headers({ 'Set-Cookie': 'auth_token=; Path=/admin; Expires=Thu, 01 Jan 1970 00:00:00 GMT' });
        return { isAdmin: false, errorResponse: new Response(null, { status: 403, headers }), csrfToken: null };
    }
    const { csrfToken } = storedSession;

    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
        const requestCsrfToken = request.headers.get('X-CSRF-Token');
        if (!requestCsrfToken || requestCsrfToken !== csrfToken) {
            const errorResponse = new Response(JSON.stringify({ error: 'Invalid CSRF token or session expired.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
            return { isAdmin: false, errorResponse, csrfToken: null };
        }
    }

    return { isAdmin: true, errorResponse: null, csrfToken };
}

/**
 * Handles all incoming requests to /admin/* routes.
 */
async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured. Please set ADMIN_KEY secret.', { status: 503 });
    }

    if (pathname.startsWith('/admin/api/')) {
        const { isAdmin, errorResponse } = await checkAdminAuth(request, env);
        if (errorResponse) return errorResponse;
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });

        if (pathname === '/admin/api/stats' && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT expiration_date, expiration_time, data_usage FROM users").all();
                const now = new Date();
                const stats = {
                    totalUsers: results.length,
                    activeUsers: results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) > now).length,
                    expiredUsers: results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) <= now).length,
                    totalTraffic: results.reduce((sum, u) => sum + (u.data_usage || 0), 0)
                };
                return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }
        
        if (pathname === '/admin/api/users' && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
        }

        if (pathname === '/admin/api/users' && request.method === 'POST') {
            try {
                const { uuid, exp_date, exp_time, notes, data_limit } = await request.json();
                if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) {
                    throw new Error('Invalid or missing fields.');
                }
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, data_limit) VALUES (?, ?, ?, ?, ?)")
                    .bind(uuid, exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0).run();
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            } catch (e) {
                const errorMsg = e.message.includes('UNIQUE constraint failed') ? 'UUID already exists.' : e.message;
                return new Response(JSON.stringify({ error: errorMsg }), { status: 400, headers: jsonHeader });
            }
        }

        const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/);
        if (userRouteMatch) {
            const uuid = userRouteMatch[1];
            if (request.method === 'PUT') {
                 try {
                    const { exp_date, exp_time, notes, data_limit, reset_traffic } = await request.json();
                    if (!exp_date || !exp_time) throw new Error('Invalid date/time fields.');
                    const sql = `UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ? ${reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?`;
                    await env.DB.prepare(sql).bind(exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, uuid).run();
                    await env.USER_KV.delete(`user:${uuid}`);
                    return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
                } catch (e) {
                    return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: jsonHeader });
                }
            }
            if (request.method === 'DELETE') {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete(`user:${uuid}`);
                return new Response(null, { status: 204 });
            }
        }
        return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
    }

    if (pathname === '/admin') {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const sessionToken = crypto.randomUUID();
                const csrfToken = crypto.randomUUID();
                await env.USER_KV.put(`admin_session:${sessionToken}`, JSON.stringify({ csrfToken }), { expirationTtl: 86400 });
                const headers = new Headers({
                    'Location': '/admin',
                    'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict`
                });
                return new Response(null, { status: 302, headers });
            } else {
                return new Response(adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        
        if (request.method === 'GET') {
            const { isAdmin, csrfToken, errorResponse } = await checkAdminAuth(request, env);
            if (errorResponse) return errorResponse;
            
            if (isAdmin) {
                const panelWithCsrf = adminPanelHTML.replace(
                    '<input type="hidden" id="csrf_token" name="csrf_token">',
                    `<input type="hidden" id="csrf_token" name="csrf_token" value="${csrfToken}">`
                );
                return new Response(panelWithCsrf, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            } else {
                return new Response(adminLoginHTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        return new Response('Method Not Allowed', { status: 405 });
    }
    return new Response('Not found', { status: 404 });
}


// --- Core VLESS & Subscription Logic ---

const CoreConfig = {
    userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
    proxyIPs: [''],
    fromEnv(env) {
        const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
        return {
            userID: env.UUID || this.userID,
            proxyAddress: selectedProxyIP,
        };
    },
};

const CONST = {
    ED_PARAMS: { ed: 2560, eh: 'Sec-WebSocket-Protocol' },
    WS_READY_STATE_OPEN: 1,
    WS_READY_STATE_CLOSING: 2,
};

function generateRandomPath(length = 12, query = '') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
    xray: { tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} } },
    sb: { tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: CONST.ED_PARAMS } },
};

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
    const params = new URLSearchParams({ type: 'ws', host, path });
    if (security) params.set('security', security);
    if (sni) params.set('sni', sni);
    if (fp) params.set('fp', fp);
    if (alpn) params.set('alpn', alpn);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildLink({ core, proto, userID, hostName, address, port, tag }) {
    const p = CORE_PRESETS[core][proto];
    return createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `${tag}-${proto.toUpperCase()}` });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function handleIpSubscription(core, userID, hostName) {
    const mainDomains = [hostName, 'www.speedtest.net', 'www.visa.com', 'cdnjs.com'];
    const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
    let links = [];
    mainDomains.forEach((domain, i) => {
        links.push(buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i+1}` }));
    });
    try {
        const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
        if (r.ok) {
            const json = await r.json();
            const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
            ips.forEach((ip, i) => {
                const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
                links.push(buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i+1}` }));
            });
        }
    } catch (e) { console.error('Fetch IP list failed', e); }

    return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

// --- Main Fetch Handler ---

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/admin')) {
            return handleAdminRequest(request, env);
        }

        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
            return ProtocolOverWSHandler(request, env, ctx);
        }

        const handleSubscription = async (core) => {
            const uuid = url.pathname.slice(`/${core}/`.length);
            const userData = await getUserData(env, uuid);
            if (!userData || isExpired(userData.expiration_date, userData.expiration_time) || (userData.data_limit > 0 && userData.data_usage >= userData.data_limit)) {
                return new Response('Invalid, expired, or data limit reached', { status: 403 });
            }
            return handleIpSubscription(core, uuid, url.hostname);
        };

        if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
        if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData) {
                return new Response('User not found', { status: 404 });
            }

            const userIP = request.headers.get('CF-Connecting-IP');
            const [userIPInfo, proxyIPInfo] = await Promise.all([
                getIPInfo(userIP),
                getProxyIPInfo(env),
            ]);

            const cfg = CoreConfig.fromEnv(env);
            return handleConfigPage(path, url.hostname, cfg.proxyAddress, userData, userIPInfo, proxyIPInfo);
        }

        return new Response('Not found.', { status: 404 });
    },
};

// --- VLESS Protocol Handler with Traffic & IP Tracking ---

async function ProtocolOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let sessionUsage = 0;
    let userUUID = '';
    const clientIP = request.headers.get('CF-Connecting-IP');

    const updateUsageInDB = async () => {
        if (sessionUsage > 0 && userUUID) {
            try {
                await env.DB.prepare("UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?")
                    .bind(Math.round(sessionUsage), userUUID).run();
                await env.USER_KV.delete(`user:${userUUID}`);
                console.log(`Updated usage for ${userUUID} by ${sessionUsage} bytes.`);
            } catch (err) {
                console.error(`Failed to update usage for ${userUUID}:`, err);
            }
        }
    };
    
    // Defer the usage update until the connection ends.
    ctx.waitUntil(new Promise(resolve => webSocket.addEventListener('close', () => resolve(updateUsageInDB()))));
    ctx.waitUntil(new Promise(resolve => webSocket.addEventListener('error', () => resolve(updateUsageInDB()))));

    const createUsageCountingStream = () => new TransformStream({ transform(chunk, controller) { sessionUsage += chunk.byteLength; controller.enqueue(chunk); } });
    
    let remoteSocketWapper = { value: null };

    const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, request.headers.get('Sec-WebSocket-Protocol') || '');
    
    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                if (remoteSocketWapper.value) {
                    const writer = remoteSocketWapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const { user, hasError, message, addressRemote, portRemote, rawDataIndex, ProtocolVersion } = await ProcessProtocolHeader(chunk, env);

                if (hasError) {
                    controller.error(new Error(message));
                    return;
                }
                
                userUUID = user.uuid;

                // --- ALL VALIDATION CHECKS ---
                if (isExpired(user.expiration_date, user.expiration_time)) { controller.error(new Error('User expired.')); return; }
                if (user.data_limit > 0 && (user.data_usage + sessionUsage) >= user.data_limit) { controller.error(new Error('Data limit reached.')); return; }
                if (!(await checkIPLimit(env, userUUID, clientIP))) { controller.error(new Error('IP limit reached.')); return; }

                const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                HandleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, createUsageCountingStream());
            },
        }))
        .catch(err => {
            console.error('WebSocket pipeline failed:', err.stack || err);
            safeCloseWebSocket(webSocket);
        });

    return new Response(null, { status: 101, webSocket: client });
}

async function ProcessProtocolHeader(protocolBuffer, env) {
    if (protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
    const dataView = new DataView(protocolBuffer);
    const version = dataView.getUint8(0);
    const uuid = unsafeStringify(new Uint8Array(protocolBuffer.slice(1, 17)));
    
    const user = await getUserData(env, uuid);
    if (!user) return { hasError: true, message: 'invalid user' };

    const optLength = dataView.getUint8(17);
    const command = dataView.getUint8(18 + optLength);
    if (command !== 1) return { hasError: true, message: `command ${command} is not supported` };

    const portIndex = 18 + optLength + 1;
    const portRemote = dataView.getUint16(portIndex);
    const addressType = dataView.getUint8(portIndex + 2);
    let addressValue, addressLength, addressValueIndex;
    switch (addressType) {
        case 1: addressLength = 4; addressValueIndex = portIndex + 3; addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.'); break;
        case 2: addressLength = dataView.getUint8(portIndex + 3); addressValueIndex = portIndex + 4; addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)); break;
        case 3: addressLength = 16; addressValueIndex = portIndex + 3; const arr = new Uint16Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength).buffer); addressValue = Array.from(arr).map(x => x.toString(16)).join(':'); break;
        default: return { hasError: true, message: `invalid addressType: ${addressType}` };
    }
    if (!addressValue) return { hasError: true, message: 'address is empty' };

    return { user, hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, ProtocolVersion: new Uint8Array([version]) };
}

async function HandleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, usageCounterStream) {
    const tcpSocket = await connect({ hostname: addressRemote, port: portRemote });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, usageCounterStream);
}

function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', e => controller.enqueue(e.data));
            webSocketServer.addEventListener('close', () => { safeCloseWebSocket(webSocketServer); controller.close(); });
            webSocketServer.addEventListener('error', err => controller.error(err));
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
    });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, usageCounterStream) {
    try {
        await remoteSocket.readable
            .pipeThrough(usageCounterStream)
            .pipeTo(new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN) return;
                    const dataToSend = protocolResponseHeader ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer() : chunk;
                    webSocket.send(dataToSend);
                    protocolResponseHeader = null;
                },
            }));
    } catch (error) {
        console.error('RemoteSocketToWS error:', error.stack || error);
        safeCloseWebSocket(webSocket);
    }
}

// --- Lower-level utilities ---
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { earlyData: null, error: null };
    try {
        const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        const buffer = new ArrayBuffer(binaryStr.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binaryStr.length; i++) view[i] = binaryStr.charCodeAt(i);
        return { earlyData: buffer, error: null };
    } catch (error) { return { earlyData: null, error }; }
}

function safeCloseWebSocket(socket) {
    try { if (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING) { socket.close(); } } catch (error) { console.error('safeCloseWebSocket error:', error); }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}


// --- Config Page Generation & Scripts ---
function handleConfigPage(userID, hostName, proxyAddress, userData, userIPInfo, proxyIPInfo) {
    const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
    const html = generateBeautifulConfigPage(userID, hostName, userData, userIPInfo, proxyIPInfo);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, userData, userIPInfo, proxyIPInfo) {
    const { expiration_date: expDate, expiration_time: expTime, data_usage: dataUsage, data_limit: dataLimit } = userData;

    const subXrayUrl = `https://${hostName}/xray/${userID}`;
    const subSbUrl = `https://${hostName}/sb/${userID}`;
    
    const clientUrls = {
        universal: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
        shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
        stash: `stash://install-config?url=${encodeURIComponent(subXrayUrl)}`,
        clashMeta: `clash://install-config?url=${encodeURIComponent(subSbUrl)}`,
    };

    const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;
    const isUserExpired = isExpired(expDate, expTime);
    const hasDataLimit = dataLimit > 0;
    const dataLimitReached = hasDataLimit && (dataUsage >= dataLimit);
    
    let statusMessage = isUserExpired ? "Subscription Expired" : (dataLimitReached ? "Data limit reached" : "Expires in ...");

    const renderNetworkCard = (title, ipInfo, isProxy = false) => {
        const ip = ipInfo?.ip || '...';
        const location = ipInfo ? `${ipInfo.city || 'N/A'}, ${ipInfo.country || 'N/A'}` : '...';
        const isp = ipInfo?.isp || '...';
        const flag = ipInfo?.countryCode ? `<img src="https://flagcdn.com/w20/${ipInfo.countryCode.toLowerCase()}.png" alt="${ipInfo.countryCode}" style="vertical-align: middle; margin-right: 5px;">` : '';

        return `<div class="network-card">
                <h3 class="network-title">${title}</h3>
                <div class="network-info-grid">
                    <div><strong>IP Address:</strong> <span>${ip}</span></div>
                    <div><strong>Location:</strong> <span>${flag}${location}</span></div>
                    <div><strong>ISP Provider:</strong> <span>${isp}</span></div>
                </div>
            </div>`;
    };

    const networkInfoBlock = `<div class="config-card">
            <div class="config-title"><span>Network Information</span><button class="button" onclick="location.reload()">Refresh</button></div>
            <div class="network-grid">
                ${renderNetworkCard('Proxy Server', proxyIPInfo, true)}
                ${renderNetworkCard('Your Connection', userIPInfo)}
            </div>
        </div>`;

    const expirationBlock = `<div class="info-card rainbow-border">
          <div class="info-card-content">
            <h2 class="info-title">Expiration Date</h2>
            <div id="expiration-relative" class="info-relative-time ${isUserExpired || dataLimitReached ? 'status-expired-text':'status-active-text'}">${statusMessage}</div>
            <div class="info-time-grid" id="expiration-display" data-utc-time="${utcTimestamp}">
                <div><strong>Your Local Time:</strong> <span id="local-time">--</span></div>
                <div><strong>Tehran Time:</strong> <span id="tehran-time">--</span></div>
                <div><strong>Universal Time:</strong> <span id="utc-time">--</span></div>
            </div>
          </div>
        </div>`;
    
    const trafficPercent = hasDataLimit ? Math.min(100, (dataUsage / dataLimit * 100)) : 0;
    const dataUsageBlock = `<div class="info-card">
            <div class="info-card-content">
                <h2 class="info-title">Data Usage</h2>
                <div class="data-usage-text" id="data-usage-display" data-usage="${dataUsage}" data-limit="${dataLimit}">Loading...</div>
                <div class="traffic-bar-container"><div class="traffic-bar" style="width: ${trafficPercent}%"></div></div>
            </div>
        </div>`;

    return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>VLESS Proxy Configuration</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>:root{--bg-main:#121212;--bg-card:#1e1e1e;--bg-inner:#2f2f2f;--border-color:#333;--text-primary:#e0e0e0;--text-secondary:#b0b0b0;--accent:#6200ee;--accent-hover:#7f39fb;--status-active:#03dac6;--status-expired:#cf6679}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background-color:var(--bg-main);color:var(--text-primary);padding:20px}.container{max-width:900px;margin:auto}.header{text-align:center;margin-bottom:24px}.header h1{font-size:2em;margin-bottom:8px}.header p{color:var(--text-secondary)}.top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;margin-bottom:20px}.info-card{background:var(--bg-card);border-radius:12px;position:relative;overflow:hidden;border:1px solid var(--border-color)}.info-card.rainbow-border::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(from 180deg at 50% 50%,#cf6679,#6200ee,#03dac6,#cf6679);animation:spin 4s linear infinite;z-index:1}.info-card-content{background:var(--bg-card);padding:20px;border-radius:10px;position:relative;z-index:2;margin:2px}.info-title{font-size:1.25em;text-align:center;margin:0 0 16px;font-weight:500}.info-relative-time{text-align:center;font-size:1.4em;font-weight:600;margin-bottom:16px}.status-active-text{color:var(--status-active)}.status-expired-text{color:var(--status-expired)}.info-time-grid{display:grid;gap:8px;font-size:.9em;text-align:center;color:var(--text-secondary)}.data-usage-text{font-size:1.4em!important;font-weight:600;text-align:center;color:var(--text-primary);margin-bottom:16px}.traffic-bar-container{height:8px;background-color:var(--bg-inner);border-radius:4px;overflow:hidden}.traffic-bar{height:100%;background:linear-gradient(90deg,var(--accent) 0,var(--status-active) 100%);border-radius:4px;transition:width .5s ease-out}.config-card{background:var(--bg-card);border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid var(--border-color)}.config-title{display:flex;justify-content:space-between;align-items:center;font-size:1.4rem;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)}.button,.client-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;border:1px solid var(--border-color);background-color:var(--bg-inner);color:var(--text-primary);text-decoration:none;transition:all .2s}.button:hover{background-color:#3f3f3f}.client-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.client-btn{width:100%;box-sizing:border-box;background-color:var(--accent);color:#fff;border:none}.client-btn:hover{background-color:var(--accent-hover)}.qr-container{display:none;margin-top:20px;background:#fff;padding:16px;border-radius:8px;max-width:288px;margin-left:auto;margin-right:auto}.network-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}.network-card{background:var(--bg-inner);border:1px solid var(--border-color);border-radius:8px;padding:16px}.network-title{font-size:1.1em;margin-top:0;margin-bottom:12px;border-bottom:1px solid var(--border-color);padding-bottom:8px;color:var(--status-active)}.network-info-grid{display:grid;gap:8px;font-size:.9em}.network-info-grid strong{color:var(--text-secondary);font-weight:400;display:inline-block;width:120px}.network-info-grid span{color:var(--text-primary);font-weight:500}@keyframes spin{100%{transform:rotate(360deg)}}@media (max-width:768px){body{padding:10px}.top-grid,.network-grid{grid-template-columns:1fr}}</style></head><body>
        <div class="container">
            <div class="header"><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></div>
            ${networkInfoBlock}
            <div class="top-grid">${expirationBlock}${dataUsageBlock}</div>
            <div class="config-card">
                <div class="config-title"><span>Xray Subscription</span><button class="button" onclick="copyToClipboard(this, '${subXrayUrl}')">Copy Link</button></div>
                <div class="client-buttons">
                    <a href="${clientUrls.universal}" class="client-btn">Universal Import (V2rayNG, etc.)</a>
                    <a href="${clientUrls.shadowrocket}" class="client-btn">Import to Shadowrocket</a>
                    <a href="${clientUrls.stash}" class="client-btn">Import to Stash (VLESS)</a>
                    <button class="client-btn" onclick="toggleQR('xray', '${subXrayUrl}')">Show QR Code</button>
                </div>
                <div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div>
            </div>
            <div class="config-card">
                <div class="config-title"><span>Sing-Box / Clash Subscription</span><button class="button" onclick="copyToClipboard(this, '${subSbUrl}')">Copy Link</button></div>
                <div class="client-buttons">
                    <a href="${clientUrls.clashMeta}" class="client-btn">Import to Clash Meta / Stash</a>
                    <button class="client-btn" onclick="toggleQR('singbox', '${subSbUrl}')">Show QR Code</button>
                </div>
                <div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div>
            </div>
        </div>
        <script>
            function copyToClipboard(e,t){const n=e.textContent;navigator.clipboard.writeText(t).then(()=>{e.textContent="Copied!",setTimeout(()=>{e.textContent=n},1500)})}function toggleQR(e,t){const n=document.getElementById("qr-"+e+"-container"),o=document.getElementById("qr-"+e);""===n.style.display||"none"===n.style.display?(n.style.display="block",o.hasChildNodes()||new QRCode(o,{text:t,width:256,height:256,colorDark:"#000",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.H})):n.style.display="none"}function displayExpirationTimes(){const e=document.getElementById("expiration-display"),t=document.getElementById("expiration-relative");if(!e?.dataset.utcTime)return;const n=new Date(e.dataset.utcTime);if(isNaN(n.getTime()))return;const o=(n.getTime()-Date.now())/1e3,a=o<0;if(!a&&t.textContent.includes("...")){const e=new Intl.RelativeTimeFormat("en",{numeric:"auto"});let o="";Math.abs(o)<3600?o=e.format(Math.round(o/60),"minute"):Math.abs(o)<86400?o=e.format(Math.round(o/3600),"hour"):o=e.format(Math.round(o/86400),"day"),t.textContent=`Expires ${o}`}document.getElementById("local-time").textContent=n.toLocaleString(),document.getElementById("tehran-time").textContent=n.toLocaleString("en-US",{timeZone:"Asia/Tehran",hour12:!0,year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}),document.getElementById("utc-time").textContent=`${n.toISOString().substring(0,19).replace("T"," ")} UTC`}function displayDataUsage(){const e=document.getElementById("data-usage-display"),t=parseInt(e.dataset.usage,10),n=parseInt(e.dataset.limit,10),o=e=>{if(e<=0)return"0 Bytes";const t=Math.floor(Math.log(e)/Math.log(1024));return`${parseFloat((e/Math.pow(1024,t)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][t]}`};e.innerHTML=`${o(t)} / ${n>0?o(n):"&infin;"}`}document.addEventListener("DOMContentLoaded",()=>{displayExpirationTimes(),displayDataUsage(),setInterval(displayExpirationTimes,6e4)});
        </script>
    </body></html>`;
}
