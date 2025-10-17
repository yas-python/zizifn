/**
 * Ultimate Cloudflare Worker VLESS Proxy Script - v2.1 (Stealth Admin Edition)
 *
 * All features from v2.0 plus a dynamic, secret admin path for enhanced security.
 *
 * New Security Feature:
 * - Stealth Admin Path: The admin panel URL is no longer hardcoded as '/admin'.
 * It is now defined by a secret variable `ADMIN_PATH` for maximum security.
 * This prevents bots and attackers from finding your login page.
 *
 * Setup Instructions:
 * 1. D1 Binding: Bind a D1 database as `DB`.
 * 2. D1 Schema: Run the command:
 * wrangler d1 execute DB --command="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0);"
 * 3. KV Binding: Bind a KV namespace as `USER_KV`.
 * 4. Secrets:
 * - ADMIN_KEY: Password for the admin panel.
 * - ADMIN_PATH: Your secret path for the admin panel (e.g., 'mysecretpanel123'). DO NOT include slashes.
 * - API_TOKEN (Optional): Secure token for the management API.
 * - MAX_IPS_PER_USER (Optional): e.g., '2' to limit connections.
 */

import { connect } from 'cloudflare:sockets';

// --- Configuration & Constants ---

const RATE_LIMIT_CONFIG = {
    WINDOW_SECONDS: 600, // 10 minutes
    MAX_REQUESTS: 5,
};

const CONST = {
    WS_READY_STATE_OPEN: 1,
    WS_READY_STATE_CLOSING: 2,
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

async function getUserData(env, uuid) {
    if (!isValidUUID(uuid)) return null;
    const cacheKey = `user:${uuid}`;
    try {
        const cachedData = await env.USER_KV.get(cacheKey, 'json');
        if (cachedData && cachedData.uuid) return cachedData;
    } catch (e) {
        console.error(`Failed to parse cached user data for ${uuid}`, e);
    }
    const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!userFromDb) return null;
    await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 });
    return userFromDb;
}

// --- IP Geolocation/Intelligence Functions ---

async function getIPInfo(ip) {
    if (!ip) return null;
    try {
        const response = await fetch(`https://ipapi.co/${ip}/json/`);
        if (!response.ok) throw new Error(`ipapi.co failed with status ${response.status}`);
        const data = await response.json();
        if (data.error) return null;
        return {
            ip: data.ip,
            country: data.country_name || 'Unknown',
            city: data.city || 'Unknown',
            isp: data.org || 'Unknown',
        };
    } catch (e) {
        console.error(`Error fetching IP info for ${ip}:`, e);
        return null;
    }
}

async function getProxyIPInfo(env) {
    const cacheKey = 'proxy_ip_info';
    let cachedInfo = await env.USER_KV.get(cacheKey, 'json');
    if (cachedInfo) return cachedInfo;

    try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
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

// --- Admin Panel & API ---

function getAdminLoginHTML(adminPath) {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1F2937;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #374151}h1{color:#F9FAFB;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#374151;border:1px solid #4B5563;color:#F9FAFB;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px;transition:border-color .2s,box-shadow .2s}input[type=password]:focus{outline:none;border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}button{background-color:#3B82F6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#2563EB}.error{color:#EF4444;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST" action="/${adminPath}"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;
}

function getAdminPanelHTML(adminPath) {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>:root{--bg-main:#0c0a09;--bg-card:#1c1917;--bg-input:#292524;--border:#44403c;--text-primary:#f5f5f4;--text-secondary:#a8a29e;--accent:#fb923c;--accent-hover:#f97316;--danger:#ef4444;--danger-hover:#dc2626;--success:#4ade80;--expired:#facc15;--btn-secondary-bg:#57534e;--btn-secondary-hover:#78716c}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1280px;margin:30px auto;padding:0 20px}.card{background-color:var(--bg-card);border-radius:12px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3)}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}.stat-card{background-color:var(--bg-card);border-radius:12px;padding:20px;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}.stat-card:hover{transform:translateY(-5px);box-shadow:0 8px 16px rgba(0,0,0,.4)}.stat-title{font-size:14px;color:var(--text-secondary);margin:0 0 10px}.stat-value{font-size:28px;font-weight:600;margin:0}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.input-group{display:flex}input,select{width:100%;box-sizing:border-box;background-color:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s,box-shadow .2s}input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(251,146,60,.3)}.btn{padding:10px 16px;border:none;border-radius:6px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.97)}.btn-primary{background-color:var(--accent);color:var(--bg-main)}.btn-primary:hover{background-color:var(--accent-hover)}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:var(--btn-secondary-hover)}.input-group button{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input,.input-group select{border-radius:0;border-right:none}.input-group input:first-child{border-top-left-radius:6px;border-bottom-left-radius:6px}.input-group button:last-child{border-top-right-radius:6px;border-bottom-right-radius:6px;border-right:1px solid var(--border)}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase}.status-badge{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:rgba(74,222,128,.2);color:var(--success)}.status-expired{background-color:rgba(250,204,21,.2);color:var(--expired)}.actions-cell{display:flex;gap:8px;justify-content:flex-start}#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:var(--bg-card);color:#fff;padding:15px 25px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:all .3s}#toast.show{display:block;opacity:1;transform:translate(-50%,-10px)}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;width:90%;max-width:550px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:15px;margin-bottom:20px;border-bottom:1px solid var(--border)}.modal-header h2{margin:0;font-size:20px}.modal-close-btn{background:0 0;border:none;color:var(--text-secondary);font-size:24px;cursor:pointer}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.traffic-bar{width:100%;background-color:var(--bg-input);border-radius:4px;height:6px;overflow:hidden;margin-top:4px}.traffic-bar-inner{height:100%;background-color:var(--accent);border-radius:4px;transition:width .5s}.form-check{display:flex;align-items:center;margin-top:10px}.form-check input{width:auto;margin-right:8px}.pagination{display:flex;justify-content:center;align-items:center;margin-top:20px;gap:6px}.pagination button{background-color:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);border-radius:6px;padding:8px 14px;cursor:pointer;transition:background-color .2s}.pagination button:hover:not(:disabled){background-color:var(--btn-secondary-bg)}.pagination button:disabled{opacity:.5;cursor:not-allowed}.pagination span{padding:0 8px;font-weight:600}@media (max-width:768px){.container{padding:0 10px;margin-top:15px}.stats-grid{grid-template-columns:1fr 1fr}.user-list-wrapper{overflow-x:auto;-webkit-overflow-scrolling:touch}table{min-width:800px}}</style></head><body><div class="container"><div id="stats" class="stats-grid"></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><input type="hidden" id="csrf_token" name="csrf_token"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" placeholder="e.g., 10"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group" style="grid-column:1/-1;align-items:flex-start;margin-top:10px"><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="user-list-wrapper"><table><thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div><div id="pagination-controls" class="pagination"></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm" class="form-grid"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div><div class="form-group"><label for="editExpiryTime">Expiry Time (Your Local Time)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required></div><div class="form-group"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" placeholder="e.g., 10"><select id="editDataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group form-check" style="grid-column:1/-1"><input type="checkbox" id="resetTraffic"><label for="resetTraffic">Reset Traffic Usage</label></div><div class="modal-footer" style="grid-column:1/-1"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>document.addEventListener("DOMContentLoaded",()=>{const adminPath='${adminPath}';const e= \`/\${adminPath}/api\`,t=document.getElementById("csrf_token").value,n={get:t=>fetch(`${e}${t}`).then(o),post:(n,s)=>fetch(`${e}${n}`,{method:"POST",headers:{...a},body:JSON.stringify(s)}).then(o),put:(n,s)=>fetch(`${e}${n}`,{method:"PUT",headers:{...a},body:JSON.stringify(s)}).then(o),delete:t=>fetch(`${e}${t}`,{method:"DELETE",headers:{...a}}).then(o)},a={"Content-Type":"application/json","X-CSRF-Token":t};let s;async function o(e){if(403===e.status)throw i("Session expired or invalid. Please refresh the page.",!0),new Error("Forbidden: Invalid session or CSRF token.");if(!e.ok){const t=await e.json().catch(()=>({error:"An unknown error occurred."}));throw new Error(t.error||`Request failed with status ${e.status}`)}return 204===e.status?null:e.json()}function i(e,t=!1){const n=document.getElementById("toast");n.textContent=e,n.style.backgroundColor=t?"var(--danger)":"var(--success)",n.classList.add("show"),setTimeout(()=>{n.classList.remove("show")},3e3)}const r=e=>e.toString().padStart(2,"0"),d=(e,t)=>{if(!e||!t)return{utcDate:"",utcTime:""};const n=new Date(`${e}T${t}`);return{utcDate:`${n.getUTCFullYear()}-${r(n.getUTCMonth()+1)}-${r(n.getUTCDate())}`,utcTime:`${r(n.getUTCHours())}:${r(n.getUTCMinutes())}:${r(n.getUTCSeconds())}`}},l=(e,t)=>{if(!e||!t)return{localDate:"",localTime:""};const n=new Date(`${e}T${t}Z`);return{localDate:`${n.getFullYear()}-${r(n.getMonth()+1)}-${r(n.getDate())}`,localTime:`${r(n.getHours())}:${r(n.getMinutes())}:${r(n.getSeconds())}`}};function c(e){if(0===e)return"0 Bytes";const t=Math.floor(Math.log(e)/Math.log(1024));return`${parseFloat((e/Math.pow(1024,t)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][t]}`}function u(e){document.getElementById("stats").innerHTML=\`<div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">\${e.totalUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">\${e.activeUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">\${e.expiredUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Total Traffic Used</h3><p class="stat-value">\${c(e.totalTraffic)}</p></div>\`}async function p(e=1){try{const{users:t,totalPages:a,currentPage:o}=await n.get(\`/users?page=\${e}&limit=20\`);s=t,g(t),function(e,t){const s=document.getElementById("pagination-controls");if(e<=1)return void(s.innerHTML="");let a=\`<button id="prevPage" \${1===t?"disabled":""} data-page="\${t-1}">&#171; Prev</button> <span>Page \${t} of \${e}</span> <button id="nextPage" \${t>=e?"disabled":""} data-page="\${t+1}">Next &#187;</button>\`;s.innerHTML=a}(a,o)}catch(e){i(e.message,!0)}}function g(e){document.getElementById("userList").innerHTML=0===e.length?'<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>':e.map(e=>{const t=new Date(\`\${e.expiration_date}T\${e.expiration_time}Z\`),n=t<new Date,a=e.data_limit>0?\`\${c(e.data_usage)} / \${c(e.data_limit)}\`:\`\${c(e.data_usage)} / &infin;\`,s=e.data_limit>0?Math.min(100,e.data_usage/e.data_limit*100):0;return\`
                        <tr data-uuid="\${e.uuid}">
                            <td title="\${e.uuid}">\${e.uuid.substring(0,8)}...</td>
                            <td>\${new Date(e.created_at).toLocaleString()}</td>
                            <td>\${t.toLocaleString()}</td>
                            <td><span class="status-badge \${n?"status-expired":"status-active"}">\${n?"Expired":"Active"}</span></td>
                            <td>
                                \${a}
                                <div class="traffic-bar"><div class="traffic-bar-inner" style="width: \${s}%;"></div></div>
                            </td>
                            <td>\${e.notes||"-"}</td>
                            <td class="actions-cell">
                                <button class="btn btn-secondary btn-edit">Edit</button>
                                <button class="btn btn-danger btn-delete">Delete</button>
                            </td>
                        </tr>\`}).join("")}async function h(){try{const e=await n.get("/stats");u(e)}catch(e){i(e.message,!0)}}async function m(){await Promise.all([h(),p()])}const y=(e,t)=>{const n=parseFloat(document.getElementById(e).value),a=document.getElementById(t).value;if(isNaN(n)||n<=0)return 0;const s="GB"===a?1073741824:1048576;return Math.round(n*s)},f=(e,t,n)=>{const a=document.getElementById(t),s=document.getElementById(n);if(e<=0)return a.value="",void(s.value="GB");const o=e>=1073741824,i=o?"GB":"MB",r=o?1073741824:1048576;a.value=parseFloat((e/r).toFixed(2)),s.value=i};document.getElementById("createUserForm").addEventListener("submit",async e=>{e.preventDefault();const t=d(document.getElementById("expiryDate").value,document.getElementById("expiryTime").value),a={uuid:document.getElementById("uuid").value,exp_date:t.utcDate,exp_time:t.utcTime,data_limit:y("dataLimitValue","dataLimitUnit"),notes:document.getElementById("notes").value};try{await n.post("/users",a),i("User created successfully!"),e.target.reset(),document.getElementById("uuid").value=crypto.randomUUID(),b(),m()}catch(e){i(e.message,!0)}});const v=document.getElementById("editModal");document.getElementById("userList").addEventListener("click",e=>{const t=e.target.closest("button");if(!t)return;const a=e.target.closest("tr").dataset.uuid;if(t.classList.contains("btn-edit")){const e=s.find(e=>e.uuid===a);if(!e)return;const{localDate:t,localTime:n}=l(e.expiration_date,e.expiration_time);document.getElementById("editUuid").value=e.uuid,document.getElementById("editExpiryDate").value=t,document.getElementById("editExpiryTime").value=n,f(e.data_limit,"editDataLimitValue","editDataLimitUnit"),document.getElementById("editNotes").value=e.notes||"",document.getElementById("resetTraffic").checked=!1,v.classList.add("show")}else t.classList.contains("btn-delete")&&confirm(\`Are you sure you want to delete user \${a.substring(0,8)}...?\`)&&n.delete(\`/users/\${a}\`).then(()=>{i("User deleted successfully!"),m()}).catch(e=>i(e.message,!0))}),document.getElementById("editUserForm").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("editUuid").value,a=d(document.getElementById("editExpiryDate").value,document.getElementById("editExpiryTime").value),s={exp_date:a.utcDate,exp_time:a.utcTime,data_limit:y("editDataLimitValue","editDataLimitUnit"),notes:document.getElementById("editNotes").value,reset_traffic:document.getElementById("resetTraffic").checked};try{await n.put(\`/users/\${t}\`,s),i("User updated successfully!"),v.classList.remove("show"),m()}catch(e){i(e.message,!0)}});document.getElementById("pagination-controls").addEventListener("click",e=>{const t=e.target.closest("button");t&&!t.disabled&&p(parseInt(t.dataset.page))});const w=()=>v.classList.remove("show");document.getElementById("modalCloseBtn").addEventListener("click",w),document.getElementById("modalCancelBtn").addEventListener("click",w),v.addEventListener("click",e=>{e.target===v&&w()}),document.addEventListener("keydown",e=>{"Escape"===e.key&&w()}),document.getElementById("generateUUID").addEventListener("click",()=>document.getElementById("uuid").value=crypto.randomUUID()),document.getElementById("unlimitedBtn").addEventListener("click",()=>{document.getElementById("dataLimitValue").value=""}),document.getElementById("editUnlimitedBtn").addEventListener("click",()=>{document.getElementById("editDataLimitValue").value=""});const b=()=>{const e=new Date;e.setMonth(e.getMonth()+1),document.getElementById("expiryDate").value=\`\${e.getFullYear()}-\${r(e.getMonth()+1)}-\${r(e.getDate())}\`,document.getElementById("expiryTime").value=\`\${r(e.getHours())}:\${r(e.getMinutes())}:\${r(e.getSeconds())}\`};document.getElementById("uuid").value=crypto.randomUUID(),b(),m()});</script></body></html>`;
}

// --- Security: Rate Limiting ---
async function handleRateLimiting(request, env) {
    const ip = request.headers.get('CF-Connecting-IP');
    const key = `rate_limit:${ip}`;
    const attempts = (await env.USER_KV.get(key, 'json')) || { count: 0, expiry: 0 };

    if (attempts.expiry > Date.now()) {
        attempts.count++;
    } else {
        attempts.count = 1;
    }
    attempts.expiry = Date.now() + RATE_LIMIT_CONFIG.WINDOW_SECONDS * 1000;

    if (attempts.count > RATE_LIMIT_CONFIG.MAX_REQUESTS) {
        return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    await env.USER_KV.put(key, JSON.stringify(attempts), {
        expirationTtl: RATE_LIMIT_CONFIG.WINDOW_SECONDS,
    });

    return null; // No limit reached
}

// --- Admin Authentication & Routing ---
async function checkAdminAuth(request, env, adminPath) {
    // API Token Auth
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (env.API_TOKEN && token === env.API_TOKEN) {
            return { isAdmin: true, errorResponse: null, csrfToken: 'api_token' };
        }
    }

    // Cookie Session Auth
    const cookieHeader = request.headers.get('Cookie');
    const sessionToken = cookieHeader?.match(/auth_token=([^;]+)/)?.[1];
    if (!sessionToken) {
        return { isAdmin: false, errorResponse: null, csrfToken: null };
    }

    const storedSession = await env.USER_KV.get(`admin_session:${sessionToken}`, 'json');
    if (!storedSession) {
        const headers = new Headers({ 'Set-Cookie': `auth_token=; Path=/${adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
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

async function handleAdminRequest(request, env, adminPath) {
    const url = new URL(request.url);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };
	const basePath = `/${adminPath}`;

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured. Please set ADMIN_KEY secret.', { status: 503 });
    }

    if (pathname.startsWith(`${basePath}/api/`)) {
        const auth = await checkAdminAuth(request, env, adminPath);
        if (auth.errorResponse) return auth.errorResponse;
        if (!auth.isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
        
        const apiPath = pathname.substring(`${basePath}/api`.length);

        if (apiPath === '/stats' && request.method === 'GET') {
            const [total, active, traffic] = await env.DB.batch([
                env.DB.prepare("SELECT COUNT(*) as count FROM users"),
                env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE expiration_date || 'T' || expiration_time || 'Z' > ?").bind(new Date().toISOString()),
                env.DB.prepare("SELECT SUM(data_usage) as total FROM users")
            ]);
            
            const totalUsers = total[0].results[0].count;
            const activeUsers = active[0].results[0].count;
            const totalTraffic = traffic[0].results[0].total || 0;
            
            const stats = {
                totalUsers,
                activeUsers,
                expiredUsers: totalUsers - activeUsers,
                totalTraffic
            };
            return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
        }
        
        if (apiPath === '/users' && request.method === 'GET') {
            const page = parseInt(url.searchParams.get('page') || '1', 10);
            const limit = parseInt(url.searchParams.get('limit') || '20', 10);
            const offset = (page - 1) * limit;

            const [usersResult, totalResult] = await env.DB.batch([
                env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(limit, offset),
                env.DB.prepare("SELECT COUNT(*) as total FROM users")
            ]);

            const totalUsers = totalResult[0].results[0].total;
            const totalPages = Math.ceil(totalUsers / limit);

            return new Response(JSON.stringify({
                users: usersResult[0].results ?? [],
                totalPages: totalPages,
                currentPage: page
            }), { status: 200, headers: jsonHeader });
        }

        if (apiPath === '/users' && request.method === 'POST') {
            try {
                const { uuid, exp_date, exp_time, notes, data_limit } = await request.json();
                if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) throw new Error('Invalid or missing fields.');
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, data_limit) VALUES (?, ?, ?, ?, ?)")
                    .bind(uuid, exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0).run();
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            } catch (e) {
                const errorMsg = e.message.includes('UNIQUE constraint failed') ? 'UUID already exists.' : e.message;
                return new Response(JSON.stringify({ error: errorMsg }), { status: 400, headers: jsonHeader });
            }
        }

        const userRouteMatch = apiPath.match(/^\/users\/([a-f0-9-]+)$/);
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

    if (pathname === basePath) {
        if (request.method === 'POST') {
            const rateLimitResponse = await handleRateLimiting(request, env);
            if (rateLimitResponse) return rateLimitResponse;

            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const sessionToken = crypto.randomUUID();
                const csrfToken = crypto.randomUUID();
                await env.USER_KV.put(`admin_session:${sessionToken}`, JSON.stringify({ csrfToken }), { expirationTtl: 86400 });
                const headers = new Headers({
                    'Location': basePath,
                    'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=${basePath}; Max-Age=86400; SameSite=Strict`
                });
                return new Response(null, { status: 302, headers });
            } else {
                return new Response(getAdminLoginHTML(adminPath).replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        
        if (request.method === 'GET') {
            const { isAdmin, csrfToken, errorResponse } = await checkAdminAuth(request, env, adminPath);
            if (errorResponse) return errorResponse;
            if (isAdmin) {
                const panelHTML = getAdminPanelHTML(adminPath);
                const panelWithCsrf = panelHTML.replace(
                    '<input type="hidden" id="csrf_token" name="csrf_token">',
                    `<input type="hidden" id="csrf_token" name="csrf_token" value="${csrfToken}">`
                );
                return new Response(panelWithCsrf, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            } else {
                return new Response(getAdminLoginHTML(adminPath), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        return new Response('Method Not Allowed', { status: 405 });
    }
    return new Response('Not found', { status: 404 });
}

// --- Core VLESS & Subscription Logic ---

function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let result = '';
  for (let i = 0; i < length; i++) { result += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return `/${result}${query ? `?${query}` : ''}`;
}
const CORE_PRESETS = {
  xray: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1' },
  sb: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: { ed: 2560, eh: 'Sec-WebSocket-Protocol' } },
};
function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path });
  if (security) params.set('security', security); if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp); if (alpn) params.set('alpn', alpn);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}
function buildLink({ core, userID, hostName, address, port, tag }) {
  const p = CORE_PRESETS[core];
  return createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `${tag}-TLS` });
}

async function handleIpSubscription(core, userID, hostName, env) {
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  let links = [];

  let ips = await env.USER_KV.get("CLEAN_IPS", "json");
  if (!ips || !Array.isArray(ips) || ips.length === 0) {
    ips = ['www.speedtest.net', 'cloudflare.com', 'discord.com', hostName];
  }

  ips.forEach((ip, i) => {
    const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
    links.push(buildLink({ core, userID, hostName, address: formattedAddress, port: httpsPorts[Math.floor(Math.random() * httpsPorts.length)], tag: `IP${i+1}` }));
  });

  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

// --- Main Fetch Handler ---

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const adminPath = env.ADMIN_PATH || 'admin'; // Fallback to 'admin' if not set
        
        if (url.pathname.startsWith(`/${adminPath}`)) {
            return handleAdminRequest(request, env, adminPath);
        }
        
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader?.toLowerCase() === 'websocket') {
             return ProtocolOverWSHandler(request, env, ctx);
        }
        
        if (url.pathname.startsWith('/api/network-info')) {
            const userIP = request.headers.get('CF-Connecting-IP');
            const [userIPInfo, proxyIPInfo] = await Promise.all([ getIPInfo(userIP), getProxyIPInfo(env) ]);
            return new Response(JSON.stringify({ user: userIPInfo, proxy: proxyIPInfo }), { headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }});
        }
        
        const handleSubscription = async (core) => {
            const uuid = url.pathname.slice(`/${core}/`.length);
            const userData = await getUserData(env, uuid);
            if (!userData || isExpired(userData.expiration_date, userData.expiration_time) || (userData.data_limit > 0 && userData.data_usage >= userData.data_limit)) {
                return new Response('Invalid, expired, or data limit reached', { status: 403 });
            }
            return handleIpSubscription(core, uuid, url.hostname, env);
        };
        if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
        if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData) return new Response('User not found', { status: 403 });
            
            const userIP = request.headers.get('CF-Connecting-IP');
            const [userIPInfo, proxyIPInfo] = await Promise.all([ getIPInfo(userIP), getProxyIPInfo(env) ]);
            
            return handleConfigPage(path, url.hostname, userData, userIPInfo, proxyIPInfo);
        }
        
        return new Response('Not Found', { status: 404 });
    },
};

// --- VLESS Protocol Handler with Traffic Tracking & IP Limiting ---

async function ProtocolOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let sessionUsage = 0;
    let userUUID = '';

    const updateUsageInDB = async () => {
        if (sessionUsage > 0 && userUUID) {
            try {
                await env.DB.prepare("UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?").bind(Math.round(sessionUsage), userUUID).run();
                await env.USER_KV.delete(`user:${userUUID}`);
            } catch (err) { console.error(`Failed to update usage for ${userUUID}:`, err); }
        }
    };

    const usageCounter = new TransformStream({ transform(chunk, controller) { sessionUsage += chunk.byteLength; controller.enqueue(chunk); }});

    const readableWebSocketStream = MakeReadableWebSocketStream(webSocket);
    let remoteSocketWapper = { value: null };

    readableWebSocketStream
        .pipeThrough(usageCounter)
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                if (remoteSocketWapper.value) {
                    const writer = remoteSocketWapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const { user, hasError, message, addressRemote, portRemote, rawDataIndex, ProtocolVersion } = await ProcessProtocolHeader(chunk, env);
                if (hasError) { controller.error(new Error(message)); return; }
                
                userUUID = user.uuid;
                if (isExpired(user.expiration_date, user.expiration_time)) { controller.error(new Error('User expired.')); return; }
                if (user.data_limit > 0 && (user.data_usage + sessionUsage) >= user.data_limit) { controller.error(new Error('Data limit reached.')); return; }

                const maxIps = parseInt(env.MAX_IPS_PER_USER, 10);
                if (maxIps > 0) {
                    const userIp = request.headers.get('CF-Connecting-IP');
                    const ipKey = `user-ips:${userUUID}`;
                    const activeIps = new Set(await env.USER_KV.get(ipKey, 'json') || []);
                    if (!activeIps.has(userIp) && activeIps.size >= maxIps) {
                        controller.error(new Error('Simultaneous connection limit reached.'));
                        return;
                    }
                    activeIps.add(userIp);
                    ctx.waitUntil(env.USER_KV.put(ipKey, JSON.stringify([...activeIps]), { expirationTtl: 300 }));
                }

                const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);
                const tcpSocket = await connect({ hostname: addressRemote, port: portRemote });
                remoteSocketWapper.value = tcpSocket;
                const writer = tcpSocket.writable.getWriter();
                await writer.write(rawClientData);
                writer.releaseLock();
                RemoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, usageCounter);
            },
            close() { ctx.waitUntil(updateUsageInDB()); },
            abort(err) { console.error("WebSocket aborted:", err); ctx.waitUntil(updateUsageInDB()); },
        }))
        .catch(err => {
            console.error('WebSocket pipeline failed:', err.stack || err);
            safeCloseWebSocket(webSocket);
            ctx.waitUntil(updateUsageInDB());
        });
    return new Response(null, { status: 101, webSocket: client });
}

async function ProcessProtocolHeader(protocolBuffer, env) {
    if (protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
    const dataView = new DataView(protocolBuffer.buffer);
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
        case 3: addressLength = 16; addressValueIndex = portIndex + 3; addressValue = Array.from({ length: 8 }, (_, i) => dataView.getUint16(addressValueIndex + i * 2).toString(16)).join(':'); break;
        default: return { hasError: true, message: `invalid addressType: ${addressType}` };
    }
    return { user, hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, ProtocolVersion: new Uint8Array([version]) };
}

function MakeReadableWebSocketStream(webSocketServer) {
    let earlyDataApplied = false;
    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', e => controller.enqueue(e.data));
            webSocketServer.addEventListener('close', () => { safeCloseWebSocket(webSocketServer); controller.close(); });
            webSocketServer.addEventListener('error', err => { console.error('WebSocket error:', err); controller.error(err); });
            // The protocol is used for early data.
            const earlyData = base64ToArrayBuffer(webSocketServer.protocol);
            if (earlyData) controller.enqueue(earlyData);
        },
        cancel() { safeCloseWebSocket(webSocketServer); },
    });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, usageCounter) {
    try {
        await remoteSocket.readable
            .pipeThrough(usageCounter)
            .pipeTo(new WritableStream({
                start() {
                    if (protocolResponseHeader) {
                        webSocket.send(protocolResponseHeader);
                    }
                },
                async write(chunk) {
                    if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
                        webSocket.send(chunk);
                    }
                },
                close() {
                    // console.log("remoteSocket closed");
                },
                abort(err) {
                    console.error("remoteSocket aborted", err);
                },
            }));
    } catch (error) {
        console.error('RemoteSocketToWS error:', error.stack || error);
        safeCloseWebSocket(webSocket);
    }
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return null;
    try {
        const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        const buffer = new ArrayBuffer(binaryStr.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binaryStr.length; i++) {
            view[i] = binaryStr.charCodeAt(i);
        }
        return buffer;
    } catch (error) {
        console.error("Failed to decode base64:", error);
        return null;
    }
}

function safeCloseWebSocket(socket) {
  try { if (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING) { socket.close(); } } catch (error) { console.error('safeCloseWebSocket error:', error); }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return ( byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]] ).toLowerCase();
}

// --- Config Page Generation ---

function handleConfigPage(userID, hostName, userData, userIPInfo, proxyIPInfo) {
    const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
    return new Response(generateConfigPageHTML(userID, hostName, expDate, expTime, data_usage, data_limit, userIPInfo, proxyIPInfo), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateConfigPageHTML(userID, hostName, expDate, expTime, dataUsage, dataLimit, userIPInfo, proxyIPInfo) {
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
    
    let statusMessage = isUserExpired ? "Expired" : (dataLimitReached ? "Data limit reached" : "Active");
    let statusColorClass = isUserExpired || dataLimitReached ? "status-expired-text" : "status-active-text";

    const renderNetworkCard = (title, ipInfo) => {
        const ip = ipInfo?.ip || '...';
        const location = ipInfo ? `${ipInfo.city}, ${ipInfo.country}` : '...';
        const isp = ipInfo?.isp || '...';
        return `
            <div class="network-card">
                <h3 class="network-title">${title}</h3>
                <div class="network-info-grid">
                    <div><strong>IP:</strong> <span>${ip}</span></div>
                    <div><strong>Location:</strong> <span>${location}</span></div>
                    <div><strong>ISP:</strong> <span>${isp}</span></div>
                </div>
            </div>`;
    };

    const trafficPercent = hasDataLimit ? Math.min(100, (dataUsage / dataLimit * 100)) : 0;

    return `<!doctype html>
    <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>VLESS Configuration</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>:root{--bg-main:#121212;--bg-card:#1E1E1E;--bg-inner:#2f2f2f;--border-color:#333;--text-primary:#E0E0E0;--text-secondary:#B0B0B0;--accent:#6200EE;--accent-hover:#7F39FB;--status-active:#03DAC6;--status-expired:#CF6679;--network-bg:#212121;--network-border:#444}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background-color:var(--bg-main);color:var(--text-primary);padding:20px}.container{max-width:900px;margin:auto}.header{text-align:center;margin-bottom:24px}.header h1{font-size:2em;margin-bottom:8px}.header p{color:var(--text-secondary)}.top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;margin-bottom:20px}.info-card{background:var(--bg-card);border-radius:12px;position:relative;overflow:hidden;border:1px solid var(--border-color)}.info-card.rainbow-border::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(from 180deg at 50% 50%,#CF6679,#6200EE,#03DAC6,#CF6679);animation:spin 4s linear infinite;z-index:1}.info-card-content{background:var(--bg-card);padding:20px;border-radius:10px;position:relative;z-index:2;margin:2px}.info-title{font-size:1.25em;text-align:center;margin:0 0 16px;font-weight:500}.info-relative-time{text-align:center;font-size:1.4em;font-weight:600;margin-bottom:16px}.status-active-text{color:var(--status-active)}.status-expired-text{color:var(--status-expired)}.info-time-grid{display:grid;gap:8px;font-size:.9em;text-align:center;color:var(--text-secondary)}.data-usage-text{font-size:1.4em!important;font-weight:600;text-align:center;color:var(--text-primary);margin-bottom:16px}.traffic-bar-container{height:8px;background-color:var(--bg-inner);border-radius:4px;overflow:hidden}.traffic-bar{height:100%;background:linear-gradient(90deg,var(--accent) 0%,var(--status-active) 100%);border-radius:4px;transition:width .5s ease-out}.config-card{background:var(--bg-card);border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid var(--border-color)}.config-title{display:flex;justify-content:space-between;align-items:center;font-size:1.4rem;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)}.button,.client-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;border:1px solid var(--border-color);background-color:var(--bg-inner);color:var(--text-primary);text-decoration:none;transition:all .2s}.button:hover{background-color:#3f3f3f}.client-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.client-btn{width:100%;box-sizing:border-box;background-color:var(--accent);color:#fff;border:none}.client-btn:hover{background-color:var(--accent-hover)}.qr-container{display:none;margin-top:20px;background:#fff;padding:16px;border-radius:8px;max-width:288px;margin-left:auto;margin-right:auto}.network-info-wrapper{background:var(--bg-card);border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid var(--border-color)}.network-info-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)}.network-info-header h2{margin:0;font-size:1.4rem}.network-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}.network-card{background:var(--network-bg);border:1px solid var(--network-border);border-radius:8px;padding:16px}.network-title{font-size:1.1em;margin-top:0;margin-bottom:12px;border-bottom:1px solid var(--network-border);padding-bottom:8px;color:var(--status-active)}.network-info-grid{display:grid;gap:8px;font-size:.9em}.network-info-grid strong{color:var(--text-secondary);font-weight:400;display:inline-block;min-width:70px}.network-info-grid span{color:var(--text-primary);font-weight:500}.refresh-btn{background-color:var(--network-bg)}.refresh-btn:hover{background-color:#3f3f3f}@keyframes spin{100%{transform:rotate(360deg)}}@media (max-width:768px){body{padding:10px}.top-grid,.network-grid{grid-template-columns:1fr}.network-info-header{flex-direction:column;align-items:flex-start}.network-info-header button{margin-top:10px;width:100%}}</style></head>
    <body><div class="container">
        <div class="header"><h1>VLESS Configuration</h1><p>Status: <span class="${statusColorClass}">${statusMessage}</span></p></div>
        <div class="top-grid">
            <div class="info-card rainbow-border"><div class="info-card-content"><h2 class="info-title">Expiration Date</h2><div id="expiration-relative" class="info-relative-time ${statusColorClass}">--</div><div class="info-time-grid" id="expiration-display" data-utc-time="${utcTimestamp}"><div><strong>Local:</strong> <span id="local-time">--</span></div><div><strong>Tehran:</strong> <span id="tehran-time">--</span></div><div><strong>UTC:</strong> <span id="utc-time">--</span></div></div></div></div>
            <div class="info-card"><div class="info-card-content"><h2 class="info-title">Data Usage</h2><div class="data-usage-text" id="data-usage-display" data-usage="${dataUsage}" data-limit="${dataLimit}">...</div><div class="traffic-bar-container"><div class="traffic-bar" style="width:${trafficPercent}%"></div></div></div></div>
        </div>
        <div class="network-info-wrapper"><div class="network-info-header"><h2>Network Information</h2><button class="button refresh-btn" id="refresh-network">Refresh</button></div><div id="network-info-container" class="network-grid">${renderNetworkCard('Proxy Server', proxyIPInfo)}${renderNetworkCard('Your Connection', userIPInfo)}</div></div>
        <div class="config-card"><div class="config-title"><span>Xray Subscription</span><button class="button copy-btn" data-clipboard-text="${subXrayUrl}">Copy Link</button></div><div class="client-buttons"><a href="${clientUrls.universal}" class="client-btn">Universal Import (V2rayNG, etc.)</a><a href="${clientUrls.shadowrocket}" class="client-btn">Import to Shadowrocket</a><a href="${clientUrls.stash}" class="client-btn">Import to Stash (VLESS)</a><button class="client-btn" onclick="toggleQR('xray', '${subXrayUrl}')">Show QR Code</button></div><div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div></div>
        <div class="config-card"><div class="config-title"><span>Sing-Box / Clash Subscription</span><button class="button copy-btn" data-clipboard-text="${subSbUrl}">Copy Link</button></div><div class="client-buttons"><a href="${clientUrls.clashMeta}" class="client-btn">Import to Clash Meta / Stash</a><button class="client-btn" onclick="toggleQR('singbox', '${subSbUrl}')">Show QR Code</button></div><div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div></div>
    </div><script>
    function copyToClipboard(btn,text){const orig=btn.textContent;navigator.clipboard.writeText(text).then(()=>{btn.textContent='Copied!';setTimeout(()=>{btn.textContent=orig},1500)})}
    function toggleQR(id,url){const cont=document.getElementById('qr-'+id+'-container'),qr=document.getElementById('qr-'+id);if(cont.style.display==='none'||cont.style.display===''){cont.style.display='block';if(!qr.hasChildNodes()){new QRCode(qr,{text:url,width:256,height:256,colorDark:"#000",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.H})}}else{cont.style.display='none'}}
    function displayTimes(){const el=document.getElementById('expiration-display'),rel=document.getElementById('expiration-relative');if(!el?.dataset.utcTime)return;const d=new Date(el.dataset.utcTime);if(isNaN(d.getTime()))return;const diff=(d.getTime()-new Date().getTime())/1e3,exp=diff<0;if(!exp){const rtf=new Intl.RelativeTimeFormat('en',{numeric:'auto'});let t='';if(Math.abs(diff)<3600)t=rtf.format(Math.round(diff/60),'minute');else if(Math.abs(diff)<86400)t=rtf.format(Math.round(diff/3600),'hour');else t=rtf.format(Math.round(diff/86400),'day');rel.textContent=`Expires ${t}`}else{rel.textContent="Expired"}
    document.getElementById('local-time').textContent=d.toLocaleString();document.getElementById('tehran-time').textContent=d.toLocaleString('en-US',{timeZone:'Asia/Tehran',hour12:!0,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});document.getElementById('utc-time').textContent=`${d.toISOString().substring(0,19).replace('T',' ')} UTC`}
    function displayUsage(){const el=document.getElementById('data-usage-display'),u=parseInt(el.dataset.usage,10),l=parseInt(el.dataset.limit,10);const b=b=>{if(b<=0)return'0 Bytes';const i=Math.floor(Math.log(b)/Math.log(1024));return`${parseFloat((b/Math.pow(1024,i)).toFixed(2))} ${['B','KB','MB','GB','TB'][i]}`};const lt=l>0?b(l):'&infin;';el.innerHTML=`${b(u)} / ${lt}`}
    async function refreshNetwork(){const btn=document.getElementById('refresh-network');btn.disabled=!0,btn.textContent='Refreshing...';try{const res=await fetch('/api/network-info');if(!res.ok)throw new Error('Failed to fetch');const data=await res.json();const container=document.getElementById('network-info-container');const render= (t,d)=>{const ip=d?.ip||'...',loc=d?`${d.city}, ${d.country}`:'...',isp=d?.isp||'...';return \`<div class="network-card"><h3 class="network-title">\${t}</h3><div class="network-info-grid"><div><strong>IP:</strong> <span>\${ip}</span></div><div><strong>Location:</strong> <span>\${loc}</span></div><div><strong>ISP:</strong> <span>\${isp}</span></div></div></div>\`};container.innerHTML=render('Proxy Server',data.proxy)+render('Your Connection',data.user)}catch(e){console.error('Refresh failed',e)}finally{btn.disabled=!1,btn.textContent='Refresh'}}
    document.addEventListener('DOMContentLoaded',()=>{displayTimes();displayUsage();document.querySelectorAll('.copy-btn').forEach(b=>{b.addEventListener('click',()=>copyToClipboard(b,b.dataset.clipboardText))});document.getElementById('refresh-network').addEventListener('click',refreshNetwork);setInterval(displayTimes,6e4)})
    </script></body></html>`;
}
