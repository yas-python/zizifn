/**
 * Ultimate VLESS Proxy Worker Script for Cloudflare (Final Version)
 *
 * @version 5.0.0 - The Definitive Edition by Gemini
 * @author Gemini-Enhanced
 *
 * This is the final, stable, and feature-complete version, merging the best of all previous scripts.
 * It includes a professional admin panel, a smart user configuration page, and fixes all known bugs.
 *
 * --- KEY FEATURES ---
 * - Robust VLESS over WebSocket Protocol Handling.
 * - Professional Admin Panel:
 * - Secure login with CSRF protection.
 * - Full user CRUD (Create, Read, Update, Delete).
 * - Per-user data usage limits (GB/MB/Unlimited).
 * - Per-user IP-based connection limiting to prevent account sharing.
 * - Traffic usage tracking and reset functionality.
 * - Smart User Configuration Page:
 * - Live Network Information panel (Proxy & User IP, location, ISP).
 * - Functional Scamalytics Risk Score (Requires SCAMALYTICS_API_KEY).
 * - Displays expiration date and a visual data usage bar.
 * - Advanced Subscription Generation:
 * - Creates both TLS (https) and TCP (http) links.
 * - Intelligently skips TCP links if deployed on *.pages.dev.
 * - Fetches a smart IP pool for diverse config generation.
 * - Advanced Network Handling:
 * - UDP Proxying Support (for DNS on port 53).
 * - SOCKS5 Outbound Support (via `SOCKS5` secret).
 * - Optional root path reverse proxy (via `ROOT_PROXY_URL` secret).
 *
 * --- SETUP INSTRUCTIONS ---
 * 1.  **Create D1 Database:**
 * - Go to your Cloudflare Dashboard -> Workers & Pages -> D1.
 * - Create a new database. Note its "Database Name" and "Database ID".
 * - Bind it to your worker in `wrangler.toml` or via the dashboard settings:
 * - Variable name: `DB`
 * - D1 Database: Select the one you created.
 *
 * 2.  **Initialize D1 Database Schema:**
 * - You need to run this command once using Wrangler CLI. Replace `your-worker-name` and `your-database-name`.
 * - `wrangler d1 execute <your-database-name> --command="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 2);"`
 *
 * 3.  **Create KV Namespace:**
 * - Go to Workers & Pages -> KV.
 * - Create a new namespace.
 * - Bind it to your worker:
 * - Variable name: `USER_KV`
 * - KV Namespace: Select the one you created.
 *
 * 4.  **Set Secrets in Worker Settings (NOT in the code):**
 * - `ADMIN_KEY`: Your desired password for the admin panel.
 * - `UUID` (Optional): A fallback UUID for testing.
 * - `PROXYIP` (Optional): A clean IP/domain for generated configs (e.g., sub.yourdomain.com).
 * - `SCAMALYTICS_API_KEY` (Optional): Your API key from scamalytics.com for risk scoring.
 * - `SOCKS5` (Optional): SOCKS5 outbound proxy address (e.g., user:pass@host:port).
 * - `ROOT_PROXY_URL` (Optional): A URL to reverse-proxy on the root path (/).
 * - `ADMIN_PATH` (Optional): A secret path for the admin panel (e.g., /my-secret-dashboard). Defaults to /admin.
 */

import { connect } from 'cloudflare:sockets';

// --- Constants and Configuration ---
const CONST = {
    VLESS_VERSION: 0,
    WS_READY_STATE: { OPEN: 1, CLOSING: 2 },
    ED_PARAMS: { ed: 2560, eh: 'Sec-WebSocket-Protocol' },
};

const Config = {
    defaultUserID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
    proxyIPs: ['nima.nscl.ir:443'], // Fallback if PROXYIP is not set
    
    fromEnv(env) {
        const adminPath = (env.ADMIN_PATH || '/admin').replace(/^\//, '');
        const candidate = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
        const [proxyHost, proxyPort = '443'] = candidate.split(':');

        return {
            userID: env.UUID || this.defaultUserID,
            adminPath: `/${adminPath}`,
            proxyIP: proxyHost,
            proxyPort,
            proxyAddress: candidate,
            scamalytics: {
                apiKey: env.SCAMALYTICS_API_KEY || null,
                baseUrl: 'https://api12.scamalytics.com/v3/',
            },
            socks5: {
                enabled: Boolean(env.SOCKS5),
                address: env.SOCKS5 || '',
            },
            rootProxyURL: env.ROOT_PROXY_URL || null,
        };
    }
};

// --- Helper & Utility Functions ---

function isValidUUID(uuid) {
    if (typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function isExpired(expDate, expTime) {
    if (!expDate || !expTime) return true;
    const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
    return expDatetimeUTC <= new Date();
}

function hasRemainingData(user) {
  const limit = Number(user?.data_limit ?? 0);
  if (limit <= 0) return true; // 0 or less means unlimited
  return (Number(user?.data_usage ?? 0)) < limit;
}

async function getUserData(env, uuid) {
    if (!isValidUUID(uuid)) return null;
    
    const cacheKey = `user:${uuid}`;
    try {
        const cachedData = await env.USER_KV.get(cacheKey, 'json');
        if (cachedData && cachedData.uuid) {
            return cachedData;
        }
    } catch (e) {
        console.error(`Failed to parse cached user data for ${uuid}:`, e);
    }

    const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!userFromDb) return null;

    await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 }); // Cache for 1 hour
    return userFromDb;
}

async function updateUserUsage(env, uuid, bytes) {
  if (!uuid || bytes <= 0) return;
  try {
      await env.DB.prepare(`UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?`)
        .bind(Math.round(bytes), uuid)
        .run();
      // Invalidate the cache for this user so the next request gets fresh data
      await env.USER_KV.delete(`user:${uuid}`);
  } catch (e) {
      console.error(`Failed to update usage for ${uuid}:`, e);
  }
}


// --- Admin Panel ---
const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1F2937;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #374151}h1{color:#F9FAFB;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#374151;border:1px solid #4B5563;color:#F9FAFB;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px;transition:border-color .2s,box-shadow .2s}input[type=password]:focus{outline:0;border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}button{background-color:#3B82F6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#2563EB}.error{color:#EF4444;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;
const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>:root{--bg-main:#0c0a09;--bg-card:#1c1917;--bg-input:#292524;--border:#44403c;--text-primary:#f5f5f4;--text-secondary:#a8a29e;--accent:#fb923c;--accent-hover:#f97316;--danger:#ef4444;--danger-hover:#dc2626;--success:#4ade80;--expired:#facc15;--btn-secondary-bg:#57534e;--btn-secondary-hover:#78716c}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1280px;margin:30px auto;padding:0 20px}.card{background-color:var(--bg-card);border-radius:12px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3)}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}.stat-card{background-color:var(--bg-card);border-radius:12px;padding:20px;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}.stat-card:hover{transform:translateY(-5px);box-shadow:0 8px 16px rgba(0,0,0,.4)}.stat-title{font-size:14px;color:var(--text-secondary);margin:0 0 10px}.stat-value{font-size:28px;font-weight:600;margin:0}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.input-group{display:flex}input,select{width:100%;box-sizing:border-box;background-color:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s,box-shadow .2s}input:focus,select:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(251,146,60,.3)}.btn{padding:10px 16px;border:none;border-radius:6px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.97)}.btn-primary{background-color:var(--accent);color:var(--bg-main)}.btn-primary:hover{background-color:var(--accent-hover)}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:var(--btn-secondary-hover)}.input-group button{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input,.input-group select{border-radius:0;border-right:none}.input-group input:first-child,.input-group select:first-child{border-top-left-radius:6px;border-bottom-left-radius:6px}.input-group button:last-child{border-top-right-radius:6px;border-bottom-right-radius:6px;border-right:1px solid var(--border)}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase}.status-badge{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:rgba(74,222,128,.2);color:var(--success)}.status-expired{background-color:rgba(250,204,21,.2);color:var(--expired)}.actions-cell{display:flex;gap:8px;justify-content:flex-start}#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:var(--bg-card);color:#fff;padding:15px 25px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:all .3s}#toast.show{display:block;opacity:1;transform:translate(-50%,-10px)}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;width:90%;max-width:550px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:15px;margin-bottom:20px;border-bottom:1px solid var(--border)}.modal-header h2{margin:0;font-size:20px}.modal-close-btn{background:0 0;border:none;color:var(--text-secondary);font-size:24px;cursor:pointer}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.traffic-bar{width:100%;background-color:var(--bg-input);border-radius:4px;height:6px;overflow:hidden;margin-top:4px}.traffic-bar-inner{height:100%;background-color:var(--accent);border-radius:4px;transition:width .5s}.form-check{display:flex;align-items:center;margin-top:10px}.form-check input{width:auto;margin-right:8px}@media (max-width:768px){.container{padding:0 10px;margin-top:15px}.stats-grid{grid-template-columns:1fr 1fr}.user-list-wrapper{overflow-x:auto;-webkit-overflow-scrolling:touch}table{min-width:900px}}</style></head><body><div class="container"><div id="stats" class="stats-grid"></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><input type="hidden" id="csrf_token" name="csrf_token"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" placeholder="e.g., 10"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="ipLimit">IP Limit</label><input type="number" id="ipLimit" value="2" placeholder="e.g., 2"></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group" style="grid-column:1/-1;align-items:flex-start;margin-top:10px"><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="user-list-wrapper"><table><thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>IP Limit</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm" class="form-grid"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div><div class="form-group"><label for="editExpiryTime">Expiry Time (Your Local Time)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required></div><div class="form-group"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" placeholder="e.g., 10"><select id="editDataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="editIpLimit">IP Limit</label><input type="number" id="editIpLimit" placeholder="e.g., 2"></div><div class="form-group" style="grid-column:1/-1"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group form-check" style="grid-column:1/-1"><input type="checkbox" id="resetTraffic"><label for="resetTraffic">Reset Traffic Usage</label></div><div class="modal-footer" style="grid-column:1/-1"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>document.addEventListener("DOMContentLoaded",()=>{const e=document.body.getAttribute("data-admin-path"),t=`${e}/api`,n=document.getElementById("csrf_token").value,o={"Content-Type":"application/json","X-CSRF-Token":n},a={get:e=>fetch(`${t}${e}`).then(s),post:(e,a)=>fetch(`${t}${e}`,{method:"POST",headers:o,body:JSON.stringify(a)}).then(s),put:(e,a)=>fetch(`${t}${e}`,{method:"PUT",headers:o,body:JSON.stringify(a)}).then(s),delete:e=>fetch(`${t}${e}`,{method:"DELETE",headers:o}).then(s)};async function s(e){if(403===e.status)throw r("Session expired or invalid. Please refresh and log in again.",!0),new Error("Forbidden: Invalid session or CSRF token.");if(!e.ok){const t=await e.json().catch(()=>({error:"An unknown error occurred."}));throw new Error(t.error||`Request failed with status ${e.status}`)}return 204===e.status?null:e.json()}function r(e,t=!1){const n=document.getElementById("toast");n.textContent=e,n.style.backgroundColor=t?"var(--danger)":"var(--success)",n.classList.add("show"),setTimeout(()=>{n.classList.remove("show")},3e3)}const i=e=>e.toString().padStart(2,"0"),d=(e,t)=>{if(!e||!t)return{utcDate:"",utcTime:""};const n=new Date(`${e}T${t}`);return isNaN(n)?{utcDate:"",utcTime:""}:{utcDate:`${n.getUTCFullYear()}-${i(n.getUTCMonth()+1)}-${i(n.getUTCDate())}`,utcTime:`${i(n.getUTCHours())}:${i(n.getUTCMinutes())}:${i(n.getUTCSeconds())}`}},l=(e,t)=>{if(!e||!t)return{localDate:"",localTime:""};const n=new Date(`${e}T${t}Z`);return isNaN(n)?{localDate:"",localTime:""}:{localDate:`${n.getFullYear()}-${i(n.getMonth()+1)}-${i(n.getDate())}`,localTime:`${i(n.getHours())}:${i(n.getMinutes())}:${i(n.getSeconds())}`}};function c(e){if(e<=0)return"0 Bytes";const t=Math.floor(Math.log(e)/Math.log(1024));return`${parseFloat((e/Math.pow(1024,t)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][t]}`}function u(e){document.getElementById("stats").innerHTML=`\n                    <div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">${e.totalUsers}</p></div>\n                    <div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">${e.activeUsers}</p></div>\n                    <div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">${e.expiredUsers}</p></div>\n                    <div class="stat-card"><h3 class="stat-title">Total Traffic</h3><p class="stat-value">${c(e.totalTraffic)}</p></div>\n                `}function m(e){const t=document.getElementById("userList");t.innerHTML=0===e.length?'<tr><td colspan="8" style="text-align:center;">No users found.</td></tr>':e.map(e=>{const t=new Date(`${e.expiration_date}T${e.expiration_time}Z`),n=t<new Date,o=e.data_limit>0?`${c(e.data_usage)} / ${c(e.data_limit)}`:`${c(e.data_usage)} / &infin;`,a=e.data_limit>0?Math.min(100,e.data_usage/e.data_limit*100):0;return`\n                        <tr data-uuid="${e.uuid}">\n                            <td title="${e.uuid}">${e.uuid.substring(0,8)}...</td>\n                            <td>${new Date(e.created_at).toLocaleString()}</td>\n                            <td>${t.toLocaleString()}</td>\n                            <td><span class="status-badge ${n?"status-expired":"status-active"}">${n?"Expired":"Active"}</span></td>\n                            <td>\n                                ${o}\n                                <div class="traffic-bar"><div class="traffic-bar-inner" style="width: ${a}%;"></div></div>\n                            </td>\n                            <td>${e.ip_limit>0?e.ip_limit:"Unlimited"}</td>\n                            <td>${e.notes||"-"}</td>\n                            <td class="actions-cell">\n                                <button class="btn btn-secondary btn-edit">Edit</button>\n                                <button class="btn btn-danger btn-delete">Delete</button>\n                            </td>\n                        </tr>\n                    `}).join("")}async function p(){try{const[e,t]=await Promise.all([a.get("/stats"),a.get("/users")]);window.allUsers=t,u(e),m(t)}catch(e){r(e.message,!0)}}const f=(e,t)=>{const n=parseFloat(document.getElementById(e).value),o=document.getElementById(t).value;if(isNaN(n)||n<=0)return 0;return Math.round(n*("GB"===o?1073741824:1048576))},h=(e,t,n)=>{const o=document.getElementById(t),a=document.getElementById(n);if(e<=0)return o.value="",void(a.value="GB");const s=e>=1073741824,r=s?"GB":"MB",i=s?1073741824:1048576;o.value=parseFloat((e/i).toFixed(2)),a.value=r};document.getElementById("createUserForm").addEventListener("submit",async e=>{e.preventDefault();const{utcDate:t,utcTime:n}=d(document.getElementById("expiryDate").value,document.getElementById("expiryTime").value),o={uuid:document.getElementById("uuid").value,exp_date:t,exp_time:n,data_limit:f("dataLimitValue","dataLimitUnit"),ip_limit:parseInt(document.getElementById("ipLimit").value,10)||0,notes:document.getElementById("notes").value};try{await a.post("/users",o),r("User created successfully!"),e.target.reset(),document.getElementById("uuid").value=crypto.randomUUID(),g(),p()}catch(t){r(t.message,!0)}});const b=document.getElementById("editModal");document.getElementById("userList").addEventListener("click",e=>{const t=e.target.closest("button");if(!t)return;const n=e.target.closest("tr").dataset.uuid;if(t.classList.contains("btn-edit")){const e=window.allUsers.find(e=>e.uuid===n);if(!e)return;const{localDate:t,localTime:o}=l(e.expiration_date,e.expiration_time);document.getElementById("editUuid").value=e.uuid,document.getElementById("editExpiryDate").value=t,document.getElementById("editExpiryTime").value=o,h(e.data_limit,"editDataLimitValue","editDataLimitUnit"),document.getElementById("editIpLimit").value=e.ip_limit,document.getElementById("editNotes").value=e.notes||"",document.getElementById("resetTraffic").checked=!1,b.classList.add("show")}else t.classList.contains("btn-delete")&&confirm(`Are you sure you want to delete user ${n.substring(0,8)}...?`)&&a.delete(`/users/${n}`).then(()=>{r("User deleted successfully!"),p()}).catch(e=>r(e.message,!0))}),document.getElementById("editUserForm").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("editUuid").value,{utcDate:n,utcTime:o}=l(document.getElementById("editExpiryDate").value,document.getElementById("editExpiryTime").value),s={exp_date:n,exp_time:o,data_limit:f("editDataLimitValue","editDataLimitUnit"),ip_limit:parseInt(document.getElementById("editIpLimit").value,10)||0,notes:document.getElementById("editNotes").value,reset_traffic:document.getElementById("resetTraffic").checked};try{await a.put(`/users/${t}`,s),r("User updated successfully!"),b.classList.remove("show"),p()}catch(t){r(t.message,!0)}});const y=()=>b.classList.remove("show");document.getElementById("modalCloseBtn").addEventListener("click",y),document.getElementById("modalCancelBtn").addEventListener("click",y),b.addEventListener("click",e=>{e.target===b&&y()}),document.addEventListener("keydown",e=>{"Escape"===e.key&&y()}),document.getElementById("generateUUID").addEventListener("click",()=>document.getElementById("uuid").value=crypto.randomUUID()),document.getElementById("unlimitedBtn").addEventListener("click",()=>{document.getElementById("dataLimitValue").value=""}),document.getElementById("editUnlimitedBtn").addEventListener("click",()=>{document.getElementById("editDataLimitValue").value=""});const g=()=>{const e=new Date;e.setMonth(e.getMonth()+1),document.getElementById("expiryDate").value=`${e.getFullYear()}-${i(e.getMonth()+1)}-${i(e.getDate())}`,document.getElementById("expiryTime").value=`${i(e.getHours())}:${i(e.getMinutes())}:${i(e.getSeconds())}`};document.getElementById("uuid").value=crypto.randomUUID(),g(),p()});</script></body></html>`;

async function checkAdminAuth(request, env) {
    const adminPath = Config.fromEnv(env).adminPath;
    const cookieHeader = request.headers.get('Cookie');
    const sessionToken = cookieHeader?.match(/auth_token=([^;]+)/)?.[1];
    
    if (!sessionToken) {
        return { isAdmin: false, errorResponse: null, csrfToken: null };
    }

    const storedSession = await env.USER_KV.get(`admin_session:${sessionToken}`, 'json');
    if (!storedSession) {
        const headers = new Headers({ 'Set-Cookie': `auth_token=; Path=${adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
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

async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const cfg = Config.fromEnv(env);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured. Please set ADMIN_KEY secret.', { status: 503 });
    }

    if (pathname.startsWith(`${cfg.adminPath}/api/`)) {
        const { isAdmin, errorResponse } = await checkAdminAuth(request, env);
        if (errorResponse) return errorResponse;
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });

        if (pathname.endsWith('/stats') && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT expiration_date, expiration_time, data_usage FROM users").all();
                const now = new Date();
                const stats = {
                    totalUsers: results.length,
                    activeUsers: results.filter(u => !isExpired(u.expiration_date, u.expiration_time)).length,
                    expiredUsers: results.filter(u => isExpired(u.expiration_date, u.expiration_time)).length,
                    totalTraffic: results.reduce((sum, u) => sum + (u.data_usage || 0), 0)
                };
                return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }
        
        if (pathname.endsWith('/users') && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
        }

        if (pathname.endsWith('/users') && request.method === 'POST') {
            try {
                const { uuid, exp_date, exp_time, notes, data_limit, ip_limit } = await request.json();
                if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) throw new Error('Invalid or missing fields.');
                
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, data_limit, ip_limit) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(uuid, exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, ip_limit >= 0 ? ip_limit : 2).run();
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            } catch (e) {
                const errorMsg = e.message.includes('UNIQUE constraint failed') ? 'UUID already exists.' : e.message;
                return new Response(JSON.stringify({ error: errorMsg }), { status: 400, headers: jsonHeader });
            }
        }

        const userRouteMatch = pathname.match(new RegExp(`^${cfg.adminPath}/api/users/([a-f0-9-]+)$`));
        if (userRouteMatch) {
            const uuid = userRouteMatch[1];
            if (request.method === 'PUT') {
                 try {
                    const { exp_date, exp_time, notes, data_limit, ip_limit, reset_traffic } = await request.json();
                     if (!exp_date || !exp_time) throw new Error('Invalid date/time fields.');

                    const sql = `UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ?, ip_limit = ? ${reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?`;
                    await env.DB.prepare(sql).bind(exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, ip_limit >= 0 ? ip_limit : 2, uuid).run();
                    await env.USER_KV.delete(`user:${uuid}`);
                    return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
                } catch (e) {
                    return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: jsonHeader });
                }
            }
            if (request.method === 'DELETE') {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete(`user:${uuid}`);
                await env.USER_KV.delete(`conn_ips:${uuid}`);
                return new Response(null, { status: 204 });
            }
        }
        return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
    }

    if (pathname === cfg.adminPath) {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const sessionToken = crypto.randomUUID();
                const csrfToken = crypto.randomUUID();
                await env.USER_KV.put(`admin_session:${sessionToken}`, JSON.stringify({ csrfToken }), { expirationTtl: 86400 });
                const headers = new Headers({
                    'Location': cfg.adminPath,
                    'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=${cfg.adminPath}; Max-Age=86400; SameSite=Strict`
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
                const panelWithContext = adminPanelHTML
                    .replace('<input type="hidden" id="csrf_token" name="csrf_token">', `<input type="hidden" id="csrf_token" name="csrf_token" value="${csrfToken}">`)
                    .replace('<body>', `<body data-admin-path="${cfg.adminPath}">`);
                return new Response(panelWithContext, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            } else {
                return new Response(adminLoginHTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        return new Response('Method Not Allowed', { status: 405 });
    }

    return null; 
}


// --- Core VLESS & Subscription Logic ---

async function ProtocolOverWSHandler(request, config, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    let remoteSocketWrapper = { value: null };
    let udpWriter = null;
    let activeUser = null;
    let usageDown = 0;
    let usageUp = 0;

    const flushUsage = () => {
        if (activeUser?.uuid) {
            const total = usageDown + usageUp;
            if (total > 0) {
                ctx.waitUntil(updateUserUsage(env, activeUser.uuid, total));
            }
        }
    };

    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                usageDown += chunk.byteLength;

                if (udpWriter) {
                    return udpWriter.write(chunk);
                }

                if (remoteSocketWrapper.value) {
                    const writer = remoteSocketWrapper.value.writable.getWriter();
                    return writer.write(chunk).then(() => writer.releaseLock());
                }

                const { user, hasError, message, addressType, addressRemote, portRemote, rawDataIndex, isUDP } = await processVlessHeader(chunk, env);
                
                if (hasError) {
                    return controller.error(new Error(message));
                }
                
                activeUser = user;

                if (isExpired(user.expiration_date, user.expiration_time)) {
                    return controller.error(new Error('User expired.'));
                }
                
                if (!hasRemainingData(user)) {
                    return controller.error(new Error('Data limit reached.'));
                }
                
                const clientIP = request.headers.get('CF-Connecting-IP');
                if (user.ip_limit > 0) {
                    const key = `conn_ips:${user.uuid}`;
                    let activeIPs = (await env.USER_KV.get(key, 'json')) || [];
                    activeIPs = activeIPs.filter(entry => entry.exp > Date.now());
                    
                    if (activeIPs.length >= user.ip_limit && !activeIPs.some(e => e.ip === clientIP)) {
                        return controller.error(new Error(`IP limit of ${user.ip_limit} reached.`));
                    }
                    if (!activeIPs.some(e => e.ip === clientIP)) {
                        activeIPs.push({ ip: clientIP, exp: Date.now() + 65000 }); // 65s TTL
                        ctx.waitUntil(env.USER_KV.put(key, JSON.stringify(activeIPs), { expirationTtl: 120 }));
                    }
                }
                
                const vlessResponseHeader = new Uint8Array([CONST.VLESS_VERSION, 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                if (isUDP) {
                    if (portRemote !== 53) {
                        return controller.error(new Error('UDP proxy supports only DNS (port 53).'));
                    }
                    udpWriter = await createDnsPipeline(webSocket, vlessResponseHeader, (bytes) => usageUp += bytes);
                    return udpWriter.write(rawClientData);
                }

                return HandleTCPOutBound(
                    remoteSocketWrapper, addressType, addressRemote, portRemote, rawClientData, webSocket,
                    vlessResponseHeader, config, (bytes) => usageUp += bytes
                );
            },
            close() {
                console.log('Client WebSocket stream closed.');
                flushUsage();
            },
            abort(err) {
                console.error('Client WebSocket stream aborted:', err);
                flushUsage();
            },
        }))
        .catch(err => {
            console.error('VLESS pipeline failed:', err.stack || err);
            safeCloseWebSocket(webSocket);
            remoteSocketWrapper.value?.close();
            flushUsage();
        });
        
    return new Response(null, { status: 101, webSocket: client });
}


/**
 * Processes the VLESS header from the client.
 * This is the fully corrected and robust version.
 */
async function processVlessHeader(vlessBuffer, env) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true, message: 'Invalid VLESS header: insufficient length.' };
    }
    
    // The incoming chunk is a Uint8Array, so we access its underlying ArrayBuffer for the DataView.
    const view = new DataView(vlessBuffer.buffer);
    
    if (view.getUint8(0) !== CONST.VLESS_VERSION) {
        return { hasError: true, message: 'Invalid VLESS version.' };
    }

    const uuid = unsafeStringify(vlessBuffer.slice(1, 17));
    const user = await getUserData(env, uuid);
    if (!user) {
        return { hasError: true, message: 'User not found.' };
    }

    const optLen = view.getUint8(17);
    const command = view.getUint8(18 + optLen);
    if (command !== 1 && command !== 2) { // 1 = TCP, 2 = UDP
        return { hasError: true, message: `Unsupported command: ${command}.` };
    }

    const portIndex = 18 + optLen + 1;
    if (vlessBuffer.byteLength < portIndex + 2) {
        return { hasError: true, message: 'Invalid VLESS header: length too short for port.' };
    }
    const port = view.getUint16(portIndex);
    
    const addrTypeIndex = portIndex + 2;
    const addrType = view.getUint8(addrTypeIndex);
    
    let addressRemote, rawDataIndex;

    switch (addrType) {
        case 1: // IPv4
            const ipv4Index = addrTypeIndex + 1;
            if (vlessBuffer.byteLength < ipv4Index + 4) return { hasError: true, message: 'Invalid VLESS header: insufficient length for IPv4.' };
            addressRemote = vlessBuffer.slice(ipv4Index, ipv4Index + 4).join('.');
            rawDataIndex = ipv4Index + 4;
            break;
        case 2: // Domain
            const domainLenIndex = addrTypeIndex + 1;
            if (vlessBuffer.byteLength < domainLenIndex + 1) return { hasError: true, message: 'Invalid VLESS header: insufficient length for domain length.' };
            const domainLen = view.getUint8(domainLenIndex);
            const domainIndex = domainLenIndex + 1;
            if (vlessBuffer.byteLength < domainIndex + domainLen) return { hasError: true, message: 'Invalid VLESS header: insufficient length for domain name.' };
            addressRemote = new TextDecoder().decode(vlessBuffer.slice(domainIndex, domainIndex + domainLen));
            rawDataIndex = domainIndex + domainLen;
            break;
        case 3: // IPv6
            const ipv6Index = addrTypeIndex + 1;
            if (vlessBuffer.byteLength < ipv6Index + 16) return { hasError: true, message: 'Invalid VLESS header: insufficient length for IPv6.' };
            const ipv6 = Array.from({length: 8}, (_, i) => view.getUint16(ipv6Index + i * 2).toString(16)).join(':');
            addressRemote = `[${ipv6}]`;
            rawDataIndex = ipv6Index + 16;
            break;
        default: 
            return { hasError: true, message: `Invalid address type: ${addrType}.` };
    }

    if (!addressRemote) {
        return { hasError: true, message: 'Failed to parse address.' };
    }

    return { 
        user, hasError: false, addressType, addressRemote, portRemote: port, rawDataIndex, isUDP: command === 2,
    };
}

// --- Network Handlers (UDP, SOCKS5, TCP) ---

async function createDnsPipeline(webSocket, vlessResponseHeader, countUp) {
  let headerSent = false;
  const transform = new TransformStream({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength;) {
        const view = new DataView(chunk.slice(offset, offset + 2).buffer);
        const len = view.getUint16(0);
        const data = chunk.slice(offset + 2, offset + 2 + len);
        offset += 2 + len;
        controller.enqueue(data);
      }
    },
  });

  transform.readable.pipeTo(new WritableStream({
    async write(chunk) {
      try {
        const resp = await fetch('https://1.1.1.1/dns-query', {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: chunk,
        });
        const answer = await resp.arrayBuffer();
        countUp(answer.byteLength);
        const len = answer.byteLength;
        const lenBuf = new Uint8Array([(len >> 8) & 0xff, len & 0xff]);
        const payload = headerSent ?
          await new Blob([lenBuf, answer]).arrayBuffer() :
          await new Blob([vlessResponseHeader, lenBuf, answer]).arrayBuffer();
        webSocket.send(payload);
        headerSent = true;
      } catch (err) {
        console.error('DNS query failed:', err);
      }
    },
  })).catch((err) => console.error('DNS transform error', err));

  return transform.writable.getWriter();
}

async function HandleTCPOutBound(remoteSocketWrapper, addressType, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, config, countUp) {
  async function connectOut(address, port, viaSocks) {
      if (viaSocks && config.socks5.enabled && config.socks5.address) {
          const parsed = socks5AddressParser(config.socks5.address);
          return socks5Connect(addressType, address, port, parsed);
      }
      return connect({ hostname: address, port });
  }

  try {
      const tcpSocket = await connectOut(addressRemote, portRemote, false);
      remoteSocketWrapper.value = tcpSocket;
      return RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, countUp);
  } catch (err) {
      console.error(`Direct connection to ${addressRemote}:${portRemote} failed:`, err.message);
      if (config.socks5.enabled && config.socks5.address) {
          console.log('Retrying with SOCKS5 proxy...');
          try {
            const retrySocket = await connectOut(addressRemote, portRemote, true);
            remoteSocketWrapper.value = retrySocket;
            return RemoteSocketToWS(retrySocket, webSocket, protocolResponseHeader, countUp);
          } catch (err2) {
             console.error('SOCKS5 fallback connection failed:', err2.message);
             safeCloseWebSocket(webSocket);
          }
      } else {
          safeCloseWebSocket(webSocket);
      }
  }
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, countUp) {
  let headerSent = false;
  await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (webSocket.readyState !== CONST.WS_READY_STATE.OPEN) return;
        countUp(chunk.byteLength);
        const payload = headerSent || !protocolResponseHeader ? chunk : await new Blob([protocolResponseHeader, chunk]).arrayBuffer();
        webSocket.send(payload);
        headerSent = true;
      },
      close() {
        console.log('Remote readable closed');
      },
  })).catch(err => {
      console.error('RemoteSocketToWS pipe error:', err.message);
      safeCloseWebSocket(webSocket);
  });
}

function socks5AddressParser(address) {
  if (!address) throw new Error('Empty SOCKS5 address.');
  try {
    const [authPart, hostPart] = address.includes('@') ? address.split('@') : [null, address];
    const [hostname, portStr] = hostPart.split(':');
    const port = parseInt(portStr, 10);
    if (!hostname || Number.isNaN(port)) throw new Error('Invalid host or port.');
    let username, password;
    if (authPart) {
      [username, password] = authPart.split(':', 2);
    }
    return { username, password, hostname, port };
  } catch(e) {
    throw new Error('Invalid SOCKS5 address format. Expected [user:pass@]host:port');
  }
}

async function socks5Connect(addressType, addressRemote, portRemote, parsedSocks5Addr) {
  const { username, password, hostname, port } = parsedSocks5Addr;
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();

  await writer.write(new Uint8Array([5, (username && password) ? 2 : 1, 0, 2]));
  let res = (await reader.read()).value;
  if (!res || res[0] !== 5 || res[1] === 0xff) throw new Error('SOCKS5 greeting rejected.');

  if (res[1] === 2) {
    if (!username || !password) throw new Error('SOCKS5 credentials missing for auth.');
    const authReq = new Uint8Array([ 1, username.length, ...encoder.encode(username), password.length, ...encoder.encode(password) ]);
    await writer.write(authReq);
    res = (await reader.read()).value;
    if (!res || res[1] !== 0x00) throw new Error('SOCKS5 authentication failed.');
  }

  let DSTADDR;
  if (addressType === 1) { // IPv4
    DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]);
  } else if (addressType === 2) { // Domain
    DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]);
  } else if (addressType === 3) { // IPv6
    const parts = addressRemote.replace(/\[|\]/g, '').split(':').flatMap(p => p === '' ? ['0000', '0000'] : p);
    const bytes = new Uint8Array(16);
    let byteIndex = 0;
    for (const part of parts) {
        const val = parseInt(part, 16);
        bytes[byteIndex++] = val >> 8;
        bytes[byteIndex++] = val & 0xff;
    }
    DSTADDR = new Uint8Array([4, ...bytes]);
  } else {
    throw new Error('Unsupported address type for SOCKS5.');
  }

  const request = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
  await writer.write(request);
  res = (await reader.read()).value;
  if (!res || res[1] !== 0x00) throw new Error(`SOCKS5 connect failed with code ${res[1]}`);

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}


// --- Subscription and Config Page ---

function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: {
    tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} },
    tcp: { path: () => generateRandomPath(12, 'ed=2048'), security: 'none', fp: 'chrome', extra: {} },
  },
  sb: {
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: CONST.ED_PARAMS },
    tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: CONST.ED_PARAMS },
  },
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
  const preset = CORE_PRESETS[core][proto];
  return createVlessLink({
    userID, address, port, host: hostName, path: preset.path(), security: preset.security,
    sni: preset.security === 'tls' ? hostName : undefined, fp: preset.fp, alpn: preset.alpn,
    extra: preset.extra, name: `${tag}-${proto.toUpperCase()}`,
  });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function fetchSmartIpPool(env) {
  const sources = [
    'https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json',
    'https://raw.githubusercontent.com/barry-far/V2ray-Configs/main/All_Configs_Sub.json' // Alternative source
  ];
  if (env.SMART_IP_SOURCE) sources.unshift(env.SMART_IP_SOURCE);

  for (const url of sources) {
    try {
      const res = await fetch(url, { cf: { cacheTtl: 3600 } });
      if (!res.ok) continue;
      const json = await res.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].map((item) => item.ip || item).filter(Boolean);
      if (ips.length) return ips;
    } catch (err) {
      console.warn(`Smart IP source fetch failed (${url}):`, err.message);
    }
  }
  return [];
}

async function handleIpSubscription(core, userID, hostName, env) {
  const mainDomains = [ hostName, 'www.speedtest.net', 'sky.rethinkdns.com', 'cdnjs.com' ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
  const links = [];
  const isPagesDeployment = hostName.endsWith('.pages.dev');

  mainDomains.forEach((domain, i) => {
    links.push(buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i+1}` }));
    if (!isPagesDeployment) links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: domain, port: pick(httpPorts), tag: `D${i+1}` }));
  });

  const smartIPs = await fetchSmartIpPool(env);
  smartIPs.slice(0, 40).forEach((ip, i) => {
    const formatted = ip.includes(':') ? `[${ip}]` : ip;
    links.push(buildLink({ core, proto: 'tls', userID, hostName, address: formatted, port: pick(httpsPorts), tag: `IP${i+1}` }));
    if (!isPagesDeployment) links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: formatted, port: pick(httpPorts), tag: `IP${i+1}` }));
  });

  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

async function handleScamalyticsLookup(request, cfg) {
    const url = new URL(request.url);
    const ip = url.searchParams.get('ip');
    if (!ip) return new Response(JSON.stringify({ error: 'Missing ip parameter' }), { status: 400, headers: { 'Content-Type': 'application/json' }});

    const { apiKey, baseUrl } = cfg.scamalytics;
    if (!apiKey) return new Response(JSON.stringify({ error: 'Scamalytics API not configured on server.' }), { status: 500, headers: { 'Content-Type': 'application/json' }});

    const lookupUrl = `${baseUrl}?key=${apiKey}&ip=${encodeURIComponent(ip)}`;
    try {
        const res = await fetch(lookupUrl, { cf: { cacheTtl: 86400 } }); // Cache results for a day
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }});
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

function bytesToReadablePage(bytes = 0) {
  if (bytes <= 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / (1024 ** i)).toFixed(2))} ${units[i]}`;
}

function handleConfigPage(userID, hostName, cfg, userData) {
  const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
  const dataUsage = Number(data_usage || 0);
  const dataLimit = Number(data_limit || 0);
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;
  const singleXrayConfig = buildLink({ core: 'xray', proto: 'tls', userID, hostName, address: hostName, port: 443, tag: `${hostName}-Xray` });
  
  const clientUrls = {
    v2rayng: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    streisand: `streisand://import/${btoa(subXrayUrl)}`,
    clash: `clash://install-config?url=${encodeURIComponent(`https://sub.bonds.id/sub2clash?url=${subSbUrl}`)}`
  };
  
  const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;
  const hasLimit = dataLimit > 0;
  const pct = hasLimit ? Math.min(100, (dataUsage / dataLimit) * 100) : 0;

  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>VLESS Configuration</title><link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/main/assets/favicon.png" type="image/png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fira+Code&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet"><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Roboto',-apple-system,BlinkMacSystemFont,sans-serif;background:#121212;color:#e0e0e0;padding:16px}.container{max-width:900px;margin:0 auto;display:grid;gap:20px}.card{background:#1e1e1e;border-radius:12px;padding:20px;border:1px solid #333}.header{text-align:center}.header h1{font-size:1.8rem;margin-bottom:6px}.header p{color:#b0b0b0;font-size:.9rem}.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}.info-title{font-size:1.1em;margin-bottom:14px;color:#bb86fc;border-bottom:1px solid #333;padding-bottom:10px}.info-relative-time{text-align:center;font-size:1.4em;font-weight:700;margin-bottom:16px}.info-time-grid{display:grid;gap:8px;font-size:.9em;color:#b0b0b0}.info-time-grid strong{color:#e0e0e0;min-width:120px;display:inline-block}.data-usage-text{text-align:center;font-size:1.6em;font-weight:700;margin-bottom:16px}.traffic-bar-container{height:10px;background:#2f2f2f;border-radius:5px;overflow:hidden}.traffic-bar{height:100%;background:linear-gradient(90deg,#03dac6,#bb86fc);transition:width .5s ease-in-out}.network-info-grid{display:grid;gap:10px;font-size:.9em}.network-info-grid strong{color:#b0b0b0;margin-right:8px;display:inline-block;min-width:110px}.skeleton{display:inline-block;width:120px;height:1em;background:linear-gradient(90deg,#2a2a2a 25%,#333 50%,#2a2a2a 75%);background-size:200% 100%;animation:loading 1.5s infinite;border-radius:4px;vertical-align:middle}.country-flag{width:20px;margin-right:8px;border-radius:3px;vertical-align:middle}.badge{padding:4px 8px;border-radius:12px;font-size:.8em;font-weight:500;display:inline-block;text-transform:capitalize}.badge-neutral{background:rgba(136,136,136,.2);color:#aaa}.badge-yes{background:rgba(3,218,198,.2);color:#03dac6}.badge-warning{background:rgba(250,204,21,.2);color:#facc15}.badge-no{background:rgba(207,102,121,.2);color:#cf6679}.config-title{display:flex;justify-content:space-between;align-items:center;font-size:1.2em;margin-bottom:16px}.button{padding:8px 14px;border-radius:8px;font-size:.9em;font-weight:500;border:1px solid #444;background:#2a2a2a;color:#fff;text-decoration:none;cursor:pointer;transition:background .2s,transform .1s}.button:hover{background:#3a3a3a}.button:active{transform:scale(.98)}.copy-btn.copied{background:#03dac6;color:#121212;font-weight:700}.client-buttons{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.qr-container{display:none;margin-top:16px;background:#fff;padding:16px;border-radius:12px;text-align:center;max-width:288px;margin:16px auto 0}.footer{text-align:center;color:#777;font-size:.8em;margin-top:10px;grid-column:1/-1}@keyframes loading{0%{background-position:200% 0}100%{background-position:-200% 0}}@keyframes spin{100%{transform:rotate(360deg)}}</style></head><body data-proxy-ip="${cfg.proxyAddress}"><div class="container"><div class="card header"><h1>VLESS Configuration</h1><p>Your secure connection is ready. Import into your client.</p></div><div class="grid-2"><div class="card"><h3 class="info-title">📅 Expiration</h3><div id="expiration-relative" class="info-relative-time"><span class="skeleton" style="width:180px;height:1.2em"></span></div><div id="expiration-display" data-utc-time="${utcTimestamp}" class="info-time-grid"><div><strong>Local:</strong><span id="local-time"><span class="skeleton"></span></span></div><div><strong>Tehran:</strong><span id="tehran-time"><span class="skeleton"></span></span></div><div><strong>UTC:</strong><span id="utc-time"><span class="skeleton"></span></span></div></div></div><div class="card"><h3 class="info-title">📊 Data Usage</h3><div class="data-usage-text" id="data-usage-display" data-usage="${dataUsage}" data-limit="${dataLimit}">${bytesToReadablePage(dataUsage)} / ${hasLimit?bytesToReadablePage(dataLimit):"&infin;"}</div><div class="traffic-bar-container"><div class="traffic-bar" style="width:${pct}%"></div></div></div></div><div class="grid-2"><div class="card"><h3 class="info-title">🌍 Proxy Server Info</h3><div class="network-info-grid"><div><strong>Host:</strong><span id="proxy-host">${cfg.proxyAddress}</span></div><div><strong>IP:</strong><span id="proxy-ip"><span class="skeleton"></span></span></div><div><strong>Location:</strong><span id="proxy-location"><span class="skeleton"></span></span></div><div><strong>ISP:</strong><span id="proxy-isp"><span class="skeleton"></span></span></div></div></div><div class="card"><h3 class="info-title">📍 Your Connection Info <button id="refresh-ip-info" class="button" style="float:right;padding:4px 8px;font-size:0.8em;">Refresh</button></h3><div class="network-info-grid"><div><strong>IP:</strong><span id="client-ip"><span class="skeleton"></span></span></div><div><strong>Location:</strong><span id="client-location"><span class="skeleton"></span></span></div><div><strong>ISP:</strong><span id="client-isp"><span class="skeleton"></span></span></div><div><strong>Risk:</strong><span id="client-proxy"><span class="skeleton"></span></span></div></div></div></div><div class="card"><h2 class="config-title"><span>Subscriptions</span></h2><div class="client-buttons"><button class="button copy-btn" data-clipboard-text="${subXrayUrl}">Copy Xray/V2ray Link</button><button class="button copy-btn" data-clipboard-text="${subSbUrl}">Copy Sing-Box Link</button><button class="button" data-qr-target="sub" data-qr-url="${subXrayUrl}">Show QR Code</button></div><div id="qr-sub-container" class="qr-container"><div id="qr-sub"></div></div></div><div class="card"><h2 class="config-title"><span>One-Click Import</span></h2><div class="client-buttons"><a href="${clientUrls.v2rayng}" class="button">Import to V2rayNG</a><a href="${clientUrls.streisand}" class="button">Import to Streisand (iOS)</a><a href="${clientUrls.clash}" class="button">Import to Clash</a></div></div><div class="footer"><p>© ${new Date().getFullYear()} - All Rights Reserved.</p></div></div><script>function copyToClipboard(t,e){const n=t.textContent;navigator.clipboard.writeText(e).then(()=>{t.textContent="Copied!",t.classList.add("copied"),setTimeout(()=>{t.textContent=n,t.classList.remove("copied")},1500)}).catch(t=>console.error("Copy failed:",t))}function toggleQR(t,e){const n=document.getElementById(\`qr-\${t}-container\`),o=document.getElementById(\`qr-\${t}\`);if(!n||!o)return;"block"===n.style.display?(n.style.display="none",o.innerHTML=""):(n.style.display="block",o.innerHTML="",new QRCode(o,{text:e,width:256,height:256,colorDark:"#121212",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.H}))}async function fetchClientPublicIP(){try{const t=await fetch("https://api.ipify.org?format=json"),e=await t.json();return e.ip}catch(t){return console.error("Client IP fetch failed:",t),null}}async function fetchScamalyticsInfo(t){if(!t)return null;try{const e=await fetch(\`/scamalytics-lookup?ip=\${encodeURIComponent(t)}\`);return e.ok?e.json():(console.error("Scamalytics worker error:",await e.text()),null)}catch(t){return console.error("Scamalytics fetch failed:",t),null}}async function fetchIpGeo(t){if(!t)return null;try{const e=await fetch(\`https://ip-api.io/json/\${t}\`);return e.ok?e.json():(console.error(\`ip-api.io error \${e.status}\`),null)}catch(t){return console.error("IP geo fetch failed:",t),null}}function populateGeo(t,e,n){const o=document.getElementById(\`\${t}-ip\`),a=document.getElementById(\`\${t}-location\`),r=document.getElementById(\`\${t}-isp\`);if(!e)return o&&(o.textContent="N/A"),a&&(a.textContent="N/A"),void(r&&(r.textContent="N/A"));o&&(o.textContent=e.ip||e.query||n||"N/A"),a&&(a.innerHTML=\`\${(e.country_code||"").toLowerCase()?'<img class="country-flag" src="https://flagcdn.com/w20/'+(e.country_code||"").toLowerCase()+'.png">':""}\${[e.city,e.country_name].filter(Boolean).join(", ")||"N/A"}\`),r&&(r.textContent=e.isp||"N/A")}function populateScamalytics(t){const e=document.getElementById("client-proxy");if(!e)return;if(!t||t.error){e.innerHTML='<span class="badge badge-neutral">Not Configured</span>';return}const n=t.scamalytics?.scamalytics_score,o=t.scamalytics?.scamalytics_risk;if(null==n||!o)e.innerHTML='<span class="badge badge-neutral">N/A</span>';else{let t="badge-neutral";"low"===o.toLowerCase()?t="badge-yes":"medium"===o.toLowerCase()?t="badge-warning":["high","very high"].includes(o.toLowerCase())&&(t="badge-no"),e.innerHTML=\`<span class="badge \${t}">\${n} – \${o}</span>\`}}function updateExpiration(){const t=document.getElementById("expiration-display"),e=document.getElementById("expiration-relative");if(!t?.dataset?.utcTime)return;const n=new Date(t.dataset.utcTime);if(isNaN(n.valueOf()))return;const o=new Date,a=Math.round((n-o)/1e3),r=new Intl.RelativeTimeFormat("en",{numeric:"auto"});let c;Math.abs(a)<60?c=r.format(a,"second"):Math.abs(a)<3600?c=r.format(Math.round(a/60),"minute"):Math.abs(a)<86400?c=r.format(Math.round(a/3600),"hour"):c=r.format(Math.round(a/86400),"day"),e&&(e.textContent=a<0?\`Expired \${c}\`:\`Expires \${c}\`,e.style.color=a<0?"#cf6679":"#03dac6"),document.getElementById("local-time").textContent=n.toLocaleString(),document.getElementById("tehran-time").textContent=n.toLocaleString("en-US",{timeZone:"Asia/Tehran",year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}),document.getElementById("utc-time").textContent=n.toISOString().replace("T"," ").slice(0,19)+" UTC"}async function loadNetworkInfo(){const t=document.body.getAttribute("data-proxy-ip")||"N/A";let e=t.split(":")[0]||t;if(!/^[0-9a-f:.]+$/.test(e))try{const t=await fetch(\`https://dns.google/resolve?name=\${encodeURIComponent(e)}&type=A\`);if(t.ok){const n=(await t.json()).Answer?.find(t=>1===t.type);n?.data&&(e=n.data)}}catch(t){console.warn("DNS resolution for proxy failed:",t)}const[n,o]=await Promise.all([fetchIpGeo(e),fetchClientPublicIP()]);populateGeo("proxy",n,t),o&&Promise.all([fetchScamalyticsInfo(o),fetchIpGeo(o)]).then(([t,e])=>{populateGeo("client",e,o),populateScamalytics(t)})}document.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll(".copy-btn").forEach(t=>{t.addEventListener("click",()=>copyToClipboard(t,t.dataset.clipboardText))}),document.querySelectorAll("[data-qr-target]").forEach(t=>{t.addEventListener("click",()=>toggleQR(t.dataset.qrTarget,t.dataset.qrUrl))}),document.getElementById("refresh-ip-info")?.addEventListener("click",()=>{document.querySelectorAll("#client-ip, #client-location, #client-isp, #client-proxy, #proxy-ip, #proxy-location, #proxy-isp").forEach(t=>{t.innerHTML='<span class="skeleton"></span>'}),loadNetworkInfo()}),updateExpiration(),setInterval(updateExpiration,3e4),loadNetworkInfo()});</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}


// --- Main Fetch Handler ---
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cfg = Config.fromEnv(env);

        // 1. Admin Panel Routing
        const adminResponse = await handleAdminRequest(request, env);
        if (adminResponse) {
            return adminResponse;
        }

        // 2. Scamalytics lookup endpoint
        if (url.pathname === '/scamalytics-lookup') {
            return handleScamalyticsLookup(request, cfg);
        }

        // 3. WebSocket/VLESS Protocol Handling
        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
             const requestConfig = {
                socks5: cfg.socks5,
             };
             return ProtocolOverWSHandler(request, requestConfig, env, ctx);
        }
        
        // 4. Subscription & Config Page Handling
        const handleSubscription = async (core) => {
            const uuid = url.pathname.slice(`/${core}/`.length).split('/')[0];
            const user = await getUserData(env, uuid);
            if (!user || isExpired(user.expiration_date, user.expiration_time) || !hasRemainingData(user)) {
                return new Response('Invalid, expired, or data limit reached user.', { status: 403 });
            }
            return handleIpSubscription(core, uuid, url.hostname, env);
        };

        if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
        if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData || isExpired(userData.expiration_date, userData.expiration_time)) {
                 return new Response('Invalid or expired user.', { status: 403 });
            }
            return handleConfigPage(path, url.hostname, cfg, userData);
        }
        
        // 5. Root Path Reverse Proxy (Optional)
        if (cfg.rootProxyURL && url.pathname === '/') {
             try {
                const upstream = new URL(cfg.rootProxyURL);
                const proxyRequest = new Request(upstream.href, request);
                proxyRequest.headers.set('Host', upstream.hostname);
                proxyRequest.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
                proxyRequest.headers.set('X-Forwarded-Proto', 'https');
                return fetch(proxyRequest);
            } catch (err) {
                console.error('Reverse proxy error:', err);
                return new Response(`Proxy upstream error: ${err.message}`, { status: 502 });
            }
        }
        
        return new Response(`Not Found. Admin panel is at ${cfg.adminPath}`, { status: 404 });
    },
};

// --- Low-level UUID & WebSocket Helpers ---

function safeCloseWebSocket(socket) {
  try { if (socket.readyState === CONST.WS_READY_STATE.OPEN || socket.readyState === CONST.WS_READY_STATE.CLOSING) socket.close(); } catch (error) { console.error('safeCloseWebSocket error:', error); }
}

function makeReadableWebSocketStream(ws, earlyDataHeader) {
    let readableStreamCancel = false;
    return new ReadableStream({
        start(controller) {
            ws.addEventListener('message', e => {
                if (readableStreamCancel) return;
                controller.enqueue(new Uint8Array(e.data));
            });
            ws.addEventListener('close', () => {
                if (readableStreamCancel) return;
                safeCloseWebSocket(ws);
                controller.close();
            });
            ws.addEventListener('error', err => controller.error(err));
            
            const earlyData = base64ToArrayBuffer(earlyDataHeader);
            if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            readableStreamCancel = true;
            safeCloseWebSocket(ws);
        },
    });
}

function base64ToArrayBuffer(base64) {
    if (!base64) return null;
    try {
        const binStr = atob(base64);
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binStr.charCodeAt(i);
        }
        return bytes;
    } catch (e) {
        return null;
    }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

function unsafeStringify(arr) {
  return ( byteToHex[arr[0]] + byteToHex[arr[1]] + byteToHex[arr[2]] + byteToHex[arr[3]] + '-' + byteToHex[arr[4]] + byteToHex[arr[5]] + '-' + byteToHex[arr[6]] + byteToHex[arr[7]] + '-' + byteToHex[arr[8]] + byteToHex[arr[9]] + '-' + byteToHex[arr[10]] + byteToHex[arr[11]] + byteToHex[arr[12]] + byteToHex[arr[13]] + byteToHex[arr[14]] + byteToHex[arr[15]] ).toLowerCase();
}
