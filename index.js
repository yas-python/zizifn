/**
 * Ultimate VLESS Proxy Worker Script for Cloudflare (Final Fix)
 *
 * @version 5.3.0 - Final Syntax Correction by Gemini
 * @author Gemini-Enhanced
 *
 * FIX: This version resolves the final 'Identifier has already been declared' syntax error.
 * All duplicate helper functions (like makeReadableWebSocketStream, base64ToArrayBuffer, etc.)
 * have been removed, resulting in a clean, syntactically correct, and deployable script.
 * All features from previous versions are preserved.
 *
 * Setup Instructions:
 * 1. D1 Database binding: `DB`
 * 2. KV Namespace binding: `USER_KV`
 * 3. Secrets: `ADMIN_KEY`, `PROXYIP` (critical), `UUID`, `SCAMALYTICS_API_KEY`, etc.
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
            proxyPort: parseInt(proxyPort, 10),
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

// --- Core Helper & Utility Functions ---

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
  if (limit <= 0) return true;
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
        console.error(`KV parse error for ${uuid}:`, e);
    }

    const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!userFromDb) return null;

    await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 });
    return userFromDb;
}

async function updateUserUsage(env, uuid, bytes) {
  if (!uuid || bytes <= 0) return;
  await env.DB.prepare(`UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?`)
    .bind(Math.round(bytes), uuid)
    .run();
  await env.USER_KV.delete(`user:${uuid}`);
}


// --- Admin Panel ---
const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1F2937;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #374151}h1{color:#F9FAFB;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#374151;border:1px solid #4B5563;color:#F9FAFB;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px;transition:border-color .2s,box-shadow .2s}input[type=password]:focus{outline:0;border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}button{background-color:#3B82F6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#2563EB}.error{color:#EF4444;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;
const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>:root{--bg-main:#0c0a09;--bg-card:#1c1917;--bg-input:#292524;--border:#44403c;--text-primary:#f5f5f4;--text-secondary:#a8a29e;--accent:#fb923c;--accent-hover:#f97316;--danger:#ef4444;--danger-hover:#dc2626;--success:#4ade80;--expired:#facc15;--btn-secondary-bg:#57534e;--btn-secondary-hover:#78716c}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1280px;margin:30px auto;padding:0 20px}.card{background-color:var(--bg-card);border-radius:12px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3)}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}.stat-card{background-color:var(--bg-card);border-radius:12px;padding:20px;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}.stat-card:hover{transform:translateY(-5px);box-shadow:0 8px 16px rgba(0,0,0,.4)}.stat-title{font-size:14px;color:var(--text-secondary);margin:0 0 10px}.stat-value{font-size:28px;font-weight:600;margin:0}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.input-group{display:flex}input,select{width:100%;box-sizing:border-box;background-color:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s,box-shadow .2s}input:focus,select:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(251,146,60,.3)}.btn{padding:10px 16px;border:none;border-radius:6px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.97)}.btn-primary{background-color:var(--accent);color:var(--bg-main)}.btn-primary:hover{background-color:var(--accent-hover)}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:var(--btn-secondary-hover)}.input-group button{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input,.input-group select{border-radius:0;border-right:none}.input-group input:first-child,.input-group select:first-child{border-top-left-radius:6px;border-bottom-left-radius:6px}.input-group button:last-child{border-top-right-radius:6px;border-bottom-right-radius:6px;border-right:1px solid var(--border)}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase}.status-badge{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:rgba(74,222,128,.2);color:var(--success)}.status-expired{background-color:rgba(250,204,21,.2);color:var(--expired)}.actions-cell{display:flex;gap:8px;justify-content:flex-start}#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:var(--bg-card);color:#fff;padding:15px 25px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:all .3s}#toast.show{display:block;opacity:1;transform:translate(-50%,-10px)}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;width:90%;max-width:550px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:15px;margin-bottom:20px;border-bottom:1px solid var(--border)}.modal-header h2{margin:0;font-size:20px}.modal-close-btn{background:0 0;border:none;color:var(--text-secondary);font-size:24px;cursor:pointer}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.traffic-bar{width:100%;background-color:var(--bg-input);border-radius:4px;height:6px;overflow:hidden;margin-top:4px}.traffic-bar-inner{height:100%;background-color:var(--accent);border-radius:4px;transition:width .5s}.form-check{display:flex;align-items:center;margin-top:10px}.form-check input{width:auto;margin-right:8px}@media (max-width:768px){.container{padding:0 10px;margin-top:15px}.stats-grid{grid-template-columns:1fr 1fr}.user-list-wrapper{overflow-x:auto;-webkit-overflow-scrolling:touch}table{min-width:900px}}</style></head><body><div class="container"><div id="stats" class="stats-grid"></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><input type="hidden" id="csrf_token" name="csrf_token"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" placeholder="e.g., 10"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="ipLimit">IP Limit</label><input type="number" id="ipLimit" value="2" placeholder="e.g., 2"></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group" style="grid-column:1/-1;align-items:flex-start;margin-top:10px"><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="user-list-wrapper"><table><thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>IP Limit</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm" class="form-grid"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div><div class="form-group"><label for="editExpiryTime">Expiry Time (Your Local Time)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required></div><div class="form-group"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" placeholder="e.g., 10"><select id="editDataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div><div class="form-group"><label for="editIpLimit">IP Limit</label><input type="number" id="editIpLimit" placeholder="e.g., 2"></div><div class="form-group" style="grid-column:1/-1"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group form-check" style="grid-column:1/-1"><input type="checkbox" id="resetTraffic"><label for="resetTraffic">Reset Traffic Usage</label></div><div class="modal-footer" style="grid-column:1/-1"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>document.addEventListener("DOMContentLoaded",()=>{const t=document.body.getAttribute("data-admin-path"),e=`${t}/api`,n=document.getElementById("csrf_token").value,o={"Content-Type":"application/json","X-CSRF-Token":n},i={get:t=>fetch(`${e}${t}`).then(s),post:(t,a)=>fetch(`${e}${t}`,{method:"POST",headers:o,body:JSON.stringify(a)}).then(s),put:(t,a)=>fetch(`${e}${t}`,{method:"PUT",headers:o,body:JSON.stringify(a)}).then(s),delete:t=>fetch(`${e}${t}`,{method:"DELETE",headers:o}).then(s)};async function s(t){if(403===t.status)throw a("Session expired or invalid. Please refresh and log in again.",!0),new Error("Forbidden: Invalid session or CSRF token.");if(!t.ok){const e=await t.json().catch(()=>({error:"An unknown error occurred."}));throw new Error(e.error||`Request failed with status ${t.status}`)}return 204===t.status?null:t.json()}function a(t,e=!1){const n=document.getElementById("toast");n.textContent=t,n.style.backgroundColor=e?"var(--danger)":"var(--success)",n.classList.add("show"),setTimeout(()=>{n.classList.remove("show")},3e3)}const r=t=>t.toString().padStart(2,"0"),d=(t,e)=>{if(!t||!e)return{utcDate:"",utcTime:""};const n=new Date(`${t}T${e}`);return isNaN(n)?{utcDate:"",utcTime:""}:{utcDate:`${n.getUTCFullYear()}-${r(n.getUTCFullMonth()+1)}-${r(n.getUTCDate())}`,utcTime:`${r(n.getUTCHours())}:${r(n.getUTCMinutes())}:${r(n.getUTCSeconds())}`}},l=(t,e)=>{if(!t||!e)return{localDate:"",localTime:""};const n=new Date(`${t}T${e}Z`);return isNaN(n)?{localDate:"",localTime:""}:{localDate:`${n.getFullYear()}-${r(n.getMonth()+1)}-${r(n.getDate())}`,localTime:`${r(n.getHours())}:${r(n.getMinutes())}:${r(n.getSeconds())}`}};function c(t){if(t<=0)return"0 Bytes";const e=Math.floor(Math.log(t)/Math.log(1024));return`${parseFloat((t/Math.pow(1024,e)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][e]}`}function u(t){document.getElementById("stats").innerHTML=`<div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">${t.totalUsers}</p></div><div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">${t.activeUsers}</p></div><div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">${t.expiredUsers}</p></div><div class="stat-card"><h3 class="stat-title">Total Traffic</h3><p class="stat-value">${c(t.totalTraffic)}</p></div>`}async function m(){try{const[t,e]=await Promise.all([i.get("/stats"),i.get("/users")]);window.allUsers=e,u(t),function(t){const e=document.getElementById("userList");e.innerHTML=0===t.length?'<tr><td colspan="8" style="text-align:center;">No users found.</td></tr>':t.map(t=>{const e=new Date(`${t.expiration_date}T${t.expiration_time}Z`),n=e<new Date,o=t.data_limit>0?`${c(t.data_usage)} / ${c(t.data_limit)}`:`${c(t.data_usage)} / &infin;`,i=t.data_limit>0?Math.min(100,t.data_usage/t.data_limit*100):0;return`\n                        <tr data-uuid="${t.uuid}">\n                            <td title="${t.uuid}">${t.uuid.substring(0,8)}...</td>\n                            <td>${new Date(t.created_at).toLocaleString()}</td>\n                            <td>${e.toLocaleString()}</td>\n                            <td><span class="status-badge ${n?"status-expired":"status-active"}">${n?"Expired":"Active"}</span></td>\n                            <td>\n                                ${o}\n                                <div class="traffic-bar"><div class="traffic-bar-inner" style="width: ${i}%;"></div></div>\n                            </td>\n                            <td>${t.ip_limit>0?t.ip_limit:"Unlimited"}</td>\n                            <td>${t.notes||"-"}</td>\n                            <td class="actions-cell">\n                                <button class="btn btn-secondary btn-edit">Edit</button>\n                                <button class="btn btn-danger btn-delete">Delete</button>\n                            </td>\n                        </tr>\n                    `}).join("")}(e)}catch(t){a(t.message,!0)}}const p=(t,e)=>{const n=parseFloat(document.getElementById(t).value),o=document.getElementById(e).value;if(isNaN(n)||n<=0)return 0;return Math.round(n*("GB"===o?1073741824:1048576))},f=(t,e,n)=>{const o=document.getElementById(e),i=document.getElementById(n);if(t<=0)return o.value="",void(i.value="GB");const s=t>=1073741824,a=s?"GB":"MB",r=s?1073741824:1048576;o.value=parseFloat((t/r).toFixed(2)),i.value=a};document.getElementById("createUserForm").addEventListener("submit",async t=>{t.preventDefault();const{utcDate:e,utcTime:n}=d(document.getElementById("expiryDate").value,document.getElementById("expiryTime").value),o={uuid:document.getElementById("uuid").value,exp_date:e,exp_time:n,data_limit:p("dataLimitValue","dataLimitUnit"),ip_limit:parseInt(document.getElementById("ipLimit").value,10)||0,notes:document.getElementById("notes").value};try{await i.post("/users",o),a("User created successfully!"),t.target.reset(),document.getElementById("uuid").value=crypto.randomUUID(),g(),m()}catch(t){a(t.message,!0)}});const h=document.getElementById("editModal");document.getElementById("userList").addEventListener("click",t=>{const e=t.target.closest("button");if(!e)return;const n=t.target.closest("tr").dataset.uuid;if(e.classList.contains("btn-edit")){const t=window.allUsers.find(t=>t.uuid===n);if(!t)return;const{localDate:e,localTime:o}=l(t.expiration_date,t.expiration_time);document.getElementById("editUuid").value=t.uuid,document.getElementById("editExpiryDate").value=e,document.getElementById("editExpiryTime").value=o,f(t.data_limit,"editDataLimitValue","editDataLimitUnit"),document.getElementById("editIpLimit").value=t.ip_limit,document.getElementById("editNotes").value=t.notes||"",document.getElementById("resetTraffic").checked=!1,h.classList.add("show")}else e.classList.contains("btn-delete")&&confirm(`Are you sure you want to delete user ${n.substring(0,8)}...?`)&&i.delete(`/users/${n}`).then(()=>{a("User deleted successfully!"),m()}).catch(t=>a(t.message,!0))}),document.getElementById("editUserForm").addEventListener("submit",async t=>{t.preventDefault();const e=document.getElementById("editUuid").value,{utcDate:n,utcTime:o}=d(document.getElementById("editExpiryDate").value,document.getElementById("editExpiryTime").value),s={exp_date:n,exp_time:o,data_limit:p("editDataLimitValue","editDataLimitUnit"),ip_limit:parseInt(document.getElementById("editIpLimit").value,10)||0,notes:document.getElementById("editNotes").value,reset_traffic:document.getElementById("resetTraffic").checked};try{await i.put(`/users/${e}`,s),a("User updated successfully!"),h.classList.remove("show"),m()}catch(t){a(t.message,!0)}});const b=()=>h.classList.remove("show");document.getElementById("modalCloseBtn").addEventListener("click",b),document.getElementById("modalCancelBtn").addEventListener("click",b),h.addEventListener("click",t=>{t.target===h&&b()}),document.addEventListener("keydown",t=>{"Escape"===t.key&&b()}),document.getElementById("generateUUID").addEventListener("click",()=>document.getElementById("uuid").value=crypto.randomUUID()),document.getElementById("unlimitedBtn").addEventListener("click",()=>{document.getElementById("dataLimitValue").value=""}),document.getElementById("editUnlimitedBtn").addEventListener("click",()=>{document.getElementById("editDataLimitValue").value=""});const g=()=>{const t=new Date;t.setMonth(t.getMonth()+1),document.getElementById("expiryDate").value=`${t.getFullYear()}-${r(t.getMonth()+1)}-${r(t.getDate())}`,document.getElementById("expiryTime").value=`${r(t.getHours())}:${r(t.getMinutes())}:${r(t.getSeconds())}`};document.getElementById("uuid").value=crypto.randomUUID(),g(),m()});</script></body></html>`;

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
                    activeUsers: results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) > now).length,
                    expiredUsers: results.length - results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) > now).length,
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

async function ProtocolOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
    const log = (info, event) => console.log(`[${request.headers.get('CF-Connecting-IP')}] ${info}`, event || '');
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    let remoteSocketWrapper = { value: null };
    let udpWriter = null;
    let activeUser = null;
    let initialUsage = 0;
    let usageDown = 0;
    let usageUp = 0;

    const incrementDown = (bytes) => {
        usageDown += bytes;
        if (activeUser && activeUser.data_limit > 0 && (initialUsage + usageDown + usageUp) >= activeUser.data_limit) {
            log(`User ${activeUser.uuid} exceeded data cap mid-session.`);
            safeCloseWebSocket(webSocket);
            remoteSocketWrapper.value?.close?.();
        }
    };
    const incrementUp = (bytes) => {
        usageUp += bytes;
        if (activeUser && activeUser.data_limit > 0 && (initialUsage + usageDown + usageUp) >= activeUser.data_limit) {
            log(`User ${activeUser.uuid} exceeded data cap mid-session.`);
            safeCloseWebSocket(webSocket);
            remoteSocketWrapper.value?.close?.();
        }
    };

    async function flushUsage() {
        if (activeUser?.uuid) {
            const total = usageDown + usageUp;
            if (total > 0) {
                await updateUserUsage(env, activeUser.uuid, total);
            }
        }
    }

    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                incrementDown(chunk.byteLength);

                if (udpWriter) {
                    return udpWriter.write(chunk);
                }

                if (remoteSocketWrapper.value) {
                    const writer = remoteSocketWrapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const { user, hasError, message, addressType, addressRemote, portRemote, rawDataIndex, isUDP } = await processVlessHeader(chunk, env);
                if (hasError) {
                    controller.error(new Error(message));
                    return;
                }
                
                activeUser = user;
                initialUsage = Number(user.data_usage || 0);
                
                if (isExpired(user.expiration_date, user.expiration_time)) {
                    controller.error(new Error('User expired.'));
                    return;
                }
                
                if (!hasRemainingData(user)) {
                    controller.error(new Error('Data limit reached.'));
                    return;
                }
                
                const clientIP = request.headers.get('CF-Connecting-IP');
                if (user.ip_limit > 0) {
                    const key = `conn_ips:${user.uuid}`;
                    let activeIPs = (await env.USER_KV.get(key, 'json')) || [];
                    activeIPs = activeIPs.filter(entry => entry.exp > Date.now());
                    
                    if (activeIPs.length >= user.ip_limit && !activeIPs.some(e => e.ip === clientIP)) {
                        controller.error(new Error(`IP limit of ${user.ip_limit} reached.`));
                        return;
                    }
                    if (!activeIPs.some(e => e.ip === clientIP)) {
                        activeIPs.push({ ip: clientIP, exp: Date.now() + 65000 });
                        ctx.waitUntil(env.USER_KV.put(key, JSON.stringify(activeIPs), { expirationTtl: 120 }));
                    }
                }
                
                const vlessResponseHeader = new Uint8Array([CONST.VLESS_VERSION, 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                if (isUDP) {
                    if (portRemote !== 53) {
                        controller.error(new Error('UDP proxy supports only DNS (port 53).'));
                        return;
                    }
                    udpWriter = await createDnsPipeline(webSocket, vlessResponseHeader, log, incrementUp);
                    await udpWriter.write(rawClientData);
                    return;
                }

                const cfg = Config.fromEnv(env);
                const requestConfig = {
                    proxyIP: cfg.proxyIP,
                    proxyPort: cfg.proxyPort,
                    socks5: cfg.socks5,
                    parsedSocks5Address: cfg.socks5.enabled ? socks5AddressParser(cfg.socks5.address) : {},
                };

                HandleTCPOutBound(
                    remoteSocketWrapper, addressType, addressRemote, portRemote,
                    rawClientData, webSocket, vlessResponseHeader, log, requestConfig, incrementUp 
                );
            },
            close() { log('Client WebSocket stream closed.'); ctx.waitUntil(flushUsage()); },
            abort(err) { log('Client WebSocket stream aborted:', err); ctx.waitUntil(flushUsage()); },
        }))
        .catch(err => {
            console.error('VLESS pipeline failed:', err.stack || err);
            safeCloseWebSocket(webSocket);
            ctx.waitUntil(flushUsage());
        });
    return new Response(null, { status: 101, webSocket: client });
}

async function processVlessHeader(vlessBuffer, env) {
    if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'invalid vless header' };
    
    const view = new DataView(vlessBuffer);
    if (view.getUint8(0) !== CONST.VLESS_VERSION) return { hasError: true, message: 'invalid vless version' };

    const uuid = unsafeStringify(new Uint8Array(vlessBuffer.slice(1, 17)));
    const user = await getUserData(env, uuid);
    if (!user) return { hasError: true, message: 'user not found' };

    const optLen = view.getUint8(17);
    const command = view.getUint8(18 + optLen);
    if (command !== 1 && command !== 2) {
        return { hasError: true, message: `unsupported command: ${command}`};
    }

    const portIndex = 19 + optLen;
    const port = view.getUint16(portIndex);
    
    const addrType = view.getUint8(portIndex + 2);
    let address, rawDataIndex;
    switch (addrType) {
        case 1:
            address = new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 7)).join('.');
            rawDataIndex = portIndex + 7;
            break;
        case 2:
            const domainLen = view.getUint8(portIndex + 3);
            address = new TextDecoder().decode(vlessBuffer.slice(portIndex + 4, portIndex + 4 + domainLen));
            rawDataIndex = portIndex + 4 + domainLen;
            break;
        case 3:
            const ipv6 = Array.from({length: 8}, (_, i) => view.getUint16(portIndex + 3 + i * 2).toString(16)).join(':');
            address = `[${ipv6}]`;
            rawDataIndex = portIndex + 19;
            break;
        default: return { hasError: true, message: `invalid address type: ${addrType}` };
    }

    return { user, hasError: false, addressType: addrType, addressRemote: address, portRemote: port, rawDataIndex, isUDP: command === 2 };
}

async function HandleTCPOutBound(remoteSocket, addressType, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, log, config, countUp) {
  
  async function connectAndWrite(address, port) {
    let tcpSocket = config.socks5.enabled
        ? await socks5Connect(addressType, address, port, log, config.parsedSocks5Address)
        : connect({ hostname: address, port: port });
    
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const tcpSocket = await connectAndWrite(config.proxyIP, config.proxyPort);
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, countUp);
  }

  try {
      const tcpSocket = await connectAndWrite(addressRemote, portRemote);
      RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, retry, log, countUp);
  } catch (err) {
      log(`Direct connection to ${addressRemote}:${portRemote} failed: ${err.message}. Retrying via proxyIP.`);
      retry();
  }
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log, countUp) {
  let hasIncomingData = false;
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState !== CONST.WS_READY_STATE.OPEN) throw new Error('WebSocket is not open');
          countUp(chunk.byteLength);
          hasIncomingData = true;
          const dataToSend = protocolResponseHeader ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer() : chunk;
          webSocket.send(dataToSend);
          protocolResponseHeader = null;
        },
        close() { log(`Remote readable closed. Had incoming data: ${hasIncomingData}`); },
        abort(reason) { console.error('Remote readable aborted:', reason); },
      }),
    );
  } catch (error) {
    console.error('RemoteSocketToWS error:', error.stack || error);
  } finally {
    safeCloseWebSocket(webSocket);
  }
  if (!hasIncomingData && retry) {
    log('No data from direct connection, triggering retry.');
    retry();
  }
}

async function socks5Connect(addressType, addressRemote, portRemote, log, parsedSocks5Addr) {
  const { username, password, hostname, port } = parsedSocks5Addr;
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();

  await writer.write(new Uint8Array([5, (username && password) ? 2 : 1, 0, 2]));
  let res = (await reader.read()).value;
  if (!res || res[0] !== 0x05 || res[1] === 0xff) throw new Error('SOCKS5 server connection failed.');

  if (res[1] === 0x02) {
    if (!username || !password) throw new Error('SOCKS5 auth credentials not provided.');
    const authRequest = new Uint8Array([ 1, username.length, ...encoder.encode(username), password.length, ...encoder.encode(password) ]);
    await writer.write(authRequest);
    res = (await reader.read()).value;
    if (res[0] !== 0x01 || res[1] !== 0x00) throw new Error('SOCKS5 authentication failed.');
  }

  let DSTADDR;
  switch (addressType) {
    case 1: DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]); break;
    case 2: DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]); break;
    case 3:
      const ipv6 = addressRemote.replace(/\[|\]/g, '');
      const parts = ipv6.split(':').map(part => part.padStart(4, '0')).flatMap(p => [parseInt(p.slice(0, 2), 16), parseInt(p.slice(2), 16)]);
      DSTADDR = new Uint8Array([4, ...parts]); break;
    default: throw new Error(`Invalid addressType for SOCKS5: ${addressType}`);
  }

  const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
  await writer.write(socksRequest);
  res = (await reader.read()).value;
  if (!res || res[1] !== 0x00) throw new Error(`SOCKS5 request failed with code ${res[1]}`);

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

function socks5AddressParser(address) {
  try {
    const [authPart, hostPart] = address.includes('@') ? address.split('@') : [null, address];
    const [hostname, portStr] = hostPart.split(':');
    const port = parseInt(portStr, 10);
    if (!hostname || isNaN(port)) throw new Error();
    let username, password;
    if (authPart) [username, password] = authPart.split(':');
    return { username, password, hostname, port };
  } catch {
    throw new Error('Invalid SOCKS5 address format. Expected [user:pass@]host:port');
  }
}

async function createDnsPipeline(webSocket, vlessResponseHeader, log, countUp) {
  let headerSent = false;
  const transform = new TransformStream({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength;) {
        const len = new DataView(chunk.slice(offset, offset + 2)).getUint16(0);
        controller.enqueue(new Uint8Array(chunk.slice(offset + 2, offset + 2 + len)));
        offset += 2 + len;
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
        const lenBuf = new Uint8Array([(answer.byteLength >> 8) & 0xff, answer.byteLength & 0xff]);
        const payload = headerSent ? await new Blob([lenBuf, answer]).arrayBuffer() : await new Blob([vlessResponseHeader, lenBuf, answer]).arrayBuffer();
        webSocket.send(payload);
        headerSent = true;
      } catch (err) { log('DNS query failed:', err); }
    },
  })).catch((err) => log('DNS transform error', err));

  return transform.writable.getWriter();
}

// --- Subscription and Config Page Generators ---
function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: {
    tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} },
  },
  sb: {
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: CONST.ED_PARAMS },
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

async function handleIpSubscription(core, userID, hostName, env) {
  const mainDomains = [ hostName, 'www.speedtest.net', 'sky.rethinkdns.com', 'cdnjs.com', 'zula.ir' ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const links = [];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const preset = CORE_PRESETS[core]['tls'];

  const build = (address, tag) => createVlessLink({
    userID, address, port: pick(httpsPorts), host: hostName, path: preset.path(),
    security: preset.security, sni: hostName, fp: preset.fp, alpn: preset.alpn, extra: preset.extra, name: tag,
  });

  mainDomains.forEach((domain, i) => links.push(build(domain, `D${i + 1}`)));

  try {
    const res = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
    if (res.ok) {
        const json = await res.json();
        const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].map(item => item.ip || item).filter(Boolean);
        ips.slice(0, 40).forEach((ip, i) => links.push(build(ip.includes(':') ? `[${ip}]` : ip, `IP${i + 1}`)));
    }
  } catch (err) { console.warn('Failed to fetch smart IPs:', err.message); }
  
  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

async function handleScamalyticsLookup(request, cfg) {
    const ip = new URL(request.url).searchParams.get('ip');
    if (!ip) return new Response(JSON.stringify({ error: 'Missing ip parameter' }), { status: 400 });
    if (!cfg.scamalytics.apiKey) return new Response(JSON.stringify({ error: 'Scamalytics API key not configured.' }), { status: 500 });
    
    try {
        const res = await fetch(`${cfg.scamalytics.baseUrl}?key=${cfg.scamalytics.apiKey}&ip=${encodeURIComponent(ip)}`);
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
}

function handleConfigPage(userID, hostName, cfg, userData) {
  const bytesToReadable = (bytes = 0) => {
    if (!bytes) return '0 Bytes';
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / (1024 ** i)).toFixed(2))} ${units[i]}`;
  };

  const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;
  const singleXrayConfig = createVlessLink({
    userID, address: hostName, port: 443, host: hostName, path: CORE_PRESETS.xray.tls.path(), ...CORE_PRESETS.xray.tls, name: `${hostName}-Xray`,
  });

  const clientUrls = {
    universalAndroid: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    karing: `karing://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
    stash: `stash://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    streisand: `streisand://import/${btoa(subXrayUrl)}`,
    clashMeta: `clash://install-config?url=${encodeURIComponent(`https://sub.bonds.id/sub/clash-meta?url=${subSbUrl}`)}`,
  };

  const hasLimit = Number(data_limit) > 0;
  const pct = hasLimit ? Math.min(100, (Number(data_usage) / Number(data_limit)) * 100) : 0;
  
  const configPageCSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#121212;color:#e0e0e0;padding:20px}.container{max-width:900px;margin:0 auto}.header{text-align:center;margin-bottom:24px}.header h1{font-size:2rem;margin-bottom:6px}.header p{color:#b0b0b0}.top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;margin-bottom:24px}.info-card{background:#1e1e1e;border-radius:12px;padding:3px;position:relative;overflow:hidden}.info-card.rainbow::before{content:"";position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(#cf6679,#6200ee,#03dac6,#cf6679);animation:spin 5s linear infinite;z-index:0}.info-card-content{position:relative;background:#1e1e1e;border-radius:10px;padding:20px;z-index:1}.info-title{text-align:center;font-size:1.2em;margin-bottom:14px;color:#fff}.info-relative-time{text-align:center;font-size:1.4em;font-weight:600;margin-bottom:16px}.info-time-grid{display:grid;gap:8px;font-size:.9em;color:#b0b0b0}.info-time-grid strong{color:#e0e0e0}.data-usage-text{text-align:center;font-size:1.6em;font-weight:600;margin-bottom:16px}.traffic-bar-container{height:8px;background:#2f2f2f;border-radius:4px;overflow:hidden}.traffic-bar{height:100%;background:linear-gradient(90deg,#fb923c,#4ade80)}.config-card{background:#1e1e1e;border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid #333}.config-title{display:flex;justify-content:space-between;align-items:center;font-size:1.2em;border-bottom:1px solid #333;padding-bottom:16px;margin-bottom:16px}.config-content pre{font-family:"Fira Code",monospace;font-size:.85em;white-space:pre-wrap;word-break:break-all;background:#272727;padding:12px;border-radius:8px}.button,.client-btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:8px;font-size:.9em;font-weight:600;border:1px solid #444;background:#2a2a2a;color:#fff;text-decoration:none;cursor:pointer;transition:background .2s,transform .2s}.button:hover,.client-btn:hover{background:#3a3a3a;transform:translateY(-1px)}.copy-btn.copied{background:#4ade80;color:#0b3d2c}.client-buttons{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}.qr-container{display:none;margin-top:16px;background:#fff;padding:16px;border-radius:12px;text-align:center}.footer{text-align:center;color:#777;margin:30px 0;font-size:.8em}.network-info-wrapper{background:#1e1e1e;border-radius:12px;border:1px solid #333;padding:24px;margin-bottom:24px}.network-info-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;border-bottom:1px solid #333;padding-bottom:16px}.network-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}.network-card{background:#212121;border:1px solid #444;border-radius:10px;padding:18px}.network-title{margin-bottom:12px;color:#03dac6;font-size:1.1em}.network-info-grid{display:grid;gap:10px;font-size:.9em}.network-info-grid strong{color:#b0b0b0;margin-right:8px;display:inline-block;min-width:120px}.skeleton{display:inline-block;width:100px;height:14px;background:linear-gradient(90deg,#2a2a2a 25%,#333 50%,#2a2a2a 75%);background-size:200% 100%;animation:loading 1.2s infinite;border-radius:4px}.country-flag{width:18px;height:auto;margin-right:6px;border-radius:3px;vertical-align:middle}.badge{padding:3px 8px;border-radius:6px;font-size:.85em;font-weight:600;display:inline-block}.badge-neutral{background:rgba(136,136,136,.2);color:#aaa}.badge-yes{background:rgba(74,222,128,.2);color:#4ade80}.badge-warning{background:rgba(250,204,21,.2);color:#facc15}.badge-no{background:rgba(239,68,68,.2);color:#ef4444}@keyframes loading{0%{background-position:200% 0}100%{background-position:-200% 0}}@keyframes spin{100%{transform:rotate(360deg)}}@media(max-width:768px){body{padding:12px}.top-grid,.network-grid{grid-template-columns:1fr}}`;
  const configPageJS = `function copyToClipboard(t,e){const o=t.textContent;navigator.clipboard.writeText(e).then(()=>{t.textContent="Copied!",t.classList.add("copied"),setTimeout(()=>{t.textContent=o,t.classList.remove("copied")},1200)}).catch(t=>console.error("Copy failed:",t))}function toggleQR(t,e){const o=document.getElementById(\`qr-${t}-container\`),n=document.getElementById(\`qr-${t}\`);o&&n&&("block"===o.style.display?(o.style.display="none"):(o.style.display="block",n.innerHTML="",new QRCode(n,{text:e,width:256,height:256,colorDark:"#121212",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.H})))}async function fetchClientPublicIP(){try{const t=await fetch("https://api.ipify.org?format=json");if(!t.ok)throw new Error(\`HTTP \${t.status}\`);return(await t.json()).ip}catch(t){return console.error("Client IP fetch failed:",t),null}}async function fetchScamalyticsInfo(t){if(!t)return null;try{const e=await fetch(\`/scamalytics-lookup?ip=\${encodeURIComponent(t)}\`);if(!e.ok){const t=await e.json().catch(()=>({}));return console.error("Scamalytics worker error:",t.error),{error:t.error||"Worker error"}}return e.json()}catch(t){return console.error("Scamalytics fetch failed:",t),null}}async function fetchIpGeo(t){if(!t)return null;try{const e=await fetch(\`https://ip-api.io/json/\${t}\`);if(!e.ok)throw new Error(\`ip-api.io error \${e.status}\`);return e.json()}catch(t){return console.error("IP geo fetch failed:",t),null}}function populateGeo(t,e,o){const n=document.getElementById(\`${t}-host\`);n&&o&&(n.textContent=o);const c=document.getElementById(\`${t}-ip\`),i=document.getElementById(\`${t}-location\`),l=document.getElementById(\`${t}-isp\`);if(e)c&&(c.textContent=e.ip||e.query||o||"N/A"),i&&(()=>{const t=e.city||e.ip_city||"",o=e.country||e.ip_country_name||"",n=(e.country_code||e.ip_country_code||"").toLowerCase(),c=n?\`<img class="country-flag" src="https://flagcdn.com/w20/\${n}.png" srcset="https://flagcdn.com/w40/\${n}.png 2x" alt="\${n.toUpperCase()}">\`:"",l=[t,o].filter(Boolean).join(", ")||"N/A";i.innerHTML=\`\${c}\${l}\`})(),l&&(l.textContent=e.isp||e.scamalytics_isp||e.isp_name||"N/A");else{c&&(c.textContent="N/A"),i&&(i.textContent="N/A"),l&&(l.textContent="N/A")}}function populateScamalytics(t){const e=document.getElementById("client-ip"),o=document.getElementById("client-location"),n=document.getElementById("client-location"),c=document.getElementById("client-isp"),i=document.getElementById("client-proxy");if(t&&t.error)return void(i&&i.innerHTML='<span class="badge badge-neutral">Not Configured</span>');if(t&&t.ip)e&&(e.textContent=t.ip),n&&(()=>{const e=t.external_datasources?.dbip?.ip_city||"",o=t.external_datasources?.dbip?.ip_country_name||"",c=(t.external_datasources?.dbip?.ip_country_code||"").toLowerCase(),i=c?\`<img class="country-flag" src="https://flagcdn.com/w20/\${c}.png" srcset="https://flagcdn.com/w40/\${c}.png 2x" alt="\${c.toUpperCase()}">\`:"",l=[e,o].filter(Boolean).join(", ")||"N/A";n.innerHTML=\`\${i}\${l}\`})(),c&&(c.textContent=t.scamalytics?.scamalytics_isp||t.external_datasources?.dbip?.isp_name||"N/A"),i&&(()=>{const e=t.scamalytics?.scamalytics_score,o=t.scamalytics?.scamalytics_risk;if(null==e||!o)return void(i.innerHTML='<span class="badge badge-neutral">N/A</span>');let t="badge-neutral";"low"===o.toLowerCase()&&(t="badge-yes"),"medium"===o.toLowerCase()&&(t="badge-warning"),["high","very high"].includes(o.toLowerCase())&&(t="badge-no"),i.innerHTML=\`<span class="badge \${t}">\${e} – \${o}</span>\`})();else e&&(e.textContent="N/A"),o&&(o.textContent="N/A"),c&&(c.textContent="N/A"),i&&(i.innerHTML='<span class="badge badge-neutral">N/A</span>')}function updateExpiration(){const t=document.getElementById("expiration-display"),e=document.getElementById("expiration-relative");if(!t?.dataset?.utcTime)return;const o=new Date(t.dataset.utcTime);if(Number.isNaN(o.valueOf()))return;const n=new Date,c=Math.round((o-n)/1e3),i=new Intl.RelativeTimeFormat("en",{numeric:"auto"});let l;l=Math.abs(c)<60?i.format(c,"second"):Math.abs(c)<3600?i.format(Math.round(c/60),"minute"):Math.abs(c)<86400?i.format(Math.round(c/3600),"hour"):i.format(Math.round(c/86400),"day"),e&&(e.textContent=c<0?\`Expired \${l}\`:\`Expires \${l}\`,e.style.color=c<0?"#CF6679":"#03DAC6"),document.getElementById("local-time").textContent=o.toLocaleString(),document.getElementById("tehran-time").textContent=o.toLocaleString("en-US",{timeZone:"Asia/Tehran",year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit"}),document.getElementById("utc-time").textContent=o.toISOString().replace("T"," ").slice(0,19)+" UTC"}async function loadNetworkInfo(){const t=document.body.getAttribute("data-proxy-ip")||"N/A",e=document.getElementById("proxy-host");e&&(e.textContent=t);let o=t.split(":")[0]||t;if(!/^[0-9a-f:.]+$/.test(o))try{const t=await fetch(\`https://dns.google/resolve?name=\${encodeURIComponent(o)}&type=A\`);if(t.ok){const e=(await t.json()).Answer?.find(t=>1===t.type);e?.data&&(o=e.data)}}catch(t){console.warn("DNS resolution failed:",t)}const[n,c]=await Promise.all([fetchIpGeo(o),fetchClientPublicIP()]);populateGeo("proxy",n,t),c?(await Promise.all([fetchScamalyticsInfo(c),fetchIpGeo(c)])).then(([t,e])=>{populateScamalytics(t),t&&t.error||populateGeo("client",e,c)}):(populateGeo("client",null,null),populateScamalytics(null))}document.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll(".copy-btn").forEach(t=>{t.addEventListener("click",()=>copyToClipboard(t,t.dataset.clipboardText))}),document.querySelectorAll("[data-qr-target]").forEach(t=>{t.addEventListener("click",()=>toggleQR(t.dataset.qrTarget,t.dataset.qrUrl))}),document.getElementById("refresh-ip-info")?.addEventListener("click",()=>{document.querySelectorAll("#proxy-ip,#proxy-location,#proxy-isp,#client-ip,#client-location,#client-isp,#client-proxy").forEach(t=>{t.innerHTML='<span class="skeleton"></span>'}),loadNetworkInfo()}),updateExpiration(),setInterval(updateExpiration,6e4),loadNetworkInfo()});`;
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>VLESS Proxy Configuration</title><link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png"><link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet"><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>${configPageCSS}</style></head><body data-proxy-ip="${cfg.proxyAddress}"><div class="container"><header class="header"><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></header><section class="network-info-wrapper"><div class="network-info-header"><h2>Network Information</h2><button class="button refresh-btn" id="refresh-ip-info">Refresh</button></div><div class="network-grid"><div class="network-card"><h3 class="network-title">Proxy Server</h3><div class="network-info-grid"><div><strong>Proxy Host</strong><span id="proxy-host"><span class="skeleton"></span></span></div><div><strong>IP Address</strong><span id="proxy-ip"><span class="skeleton"></span></span></div><div><strong>Location</strong><span id="proxy-location"><span class="skeleton"></span></span></div><div><strong>ISP Provider</strong><span id="proxy-isp"><span class="skeleton"></span></span></div></div></div><div class="network-card"><h3 class="network-title">Your Connection</h3><div class="network-info-grid"><div><strong>Your IP</strong><span id="client-ip"><span class="skeleton"></span></span></div><div><strong>Location</strong><span id="client-location"><span class="skeleton"></span></span></div><div><strong>ISP Provider</strong><span id="client-isp"><span class="skeleton"></span></span></div><div><strong>Risk Score</strong><span id="client-proxy"><span class="skeleton"></span></span></div></div></div></div></section><section class="top-grid"><div class="info-card rainbow"><div class="info-card-content"><h2 class="info-title">Expiration Date</h2><div id="expiration-relative" class="info-relative-time">Loading…</div><div id="expiration-display" data-utc-time="${expDate}T${expTime.split('.')[0]}Z" class="info-time-grid"><div><strong>Your Local:</strong><span id="local-time">--</span></div><div><strong>Tehran:</strong><span id="tehran-time">--</span></div><div><strong>Universal:</strong><span id="utc-time">--</span></div></div></div></div><div class="info-card"><div class="info-card-content"><h2 class="info-title">Data Usage</h2><div class="data-usage-text">${bytesToReadable(data_usage)} / ${hasLimit?bytesToReadable(data_limit):"&infin;"}</div><div class="traffic-bar-container"><div class="traffic-bar" style="width:${pct}%"></div></div></div></div></section><section class="config-card"><div class="config-title"><span>Single Xray Config</span></div><div class="config-content"><pre id="xray-config">${singleXrayConfig}</pre></div></section><section class="config-card"><div class="config-title"><span>Xray Subscription</span><button class="button copy-btn" data-clipboard-text="${subXrayUrl}">Copy Link</button></div><div class="client-buttons"><a href="${clientUrls.universalAndroid}" class="client-btn">Universal Import (V2rayNG, etc.)</a><a href="${clientUrls.karing}" class="client-btn">Import to Karing</a><a href="${clientUrls.shadowrocket}" class="client-btn">Import to Shadowrocket</a><a href="${clientUrls.stash}" class="client-btn">Import to Stash</a><a href="${clientUrls.streisand}" class="client-btn">Import to Streisand</a><button class="client-btn" data-qr-target="xray" data-qr-url="${subXrayUrl}">Show QR Code</button></div><div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div></section><section class="config-card"><div class="config-title"><span>Sing-Box / Clash Subscription</span><button class="button copy-btn" data-clipboard-text="${subSbUrl}">Copy Link</button></div><div class="client-buttons"><a href="${clientUrls.clashMeta}" class="client-btn">Import to Clash Meta / Stash</a><button class="client-btn" data-qr-target="singbox" data-qr-url="${subSbUrl}">Show QR Code</button></div><div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div></section><footer class="footer"><p>© ${new Date().getFullYear()} – All Rights Reserved</p></footer></div><script>${configPageJS}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}


// --- Main Fetch Handler ---
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cfg = Config.fromEnv(env);

        const adminResponse = await handleAdminRequest(request, env);
        if (adminResponse) {
            return adminResponse;
        }

        if (url.pathname === '/scamalytics-lookup') {
            return handleScamalyticsLookup(request, cfg);
        }

        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
             return ProtocolOverWSHandler(request, env, ctx);
        }
        
        const handleSubscription = async (core) => {
            const uuid = url.pathname.slice(`/${core}/`.length).split('/')[0];
            if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
            
            const user = await getUserData(env, uuid);
            if (!user || isExpired(user.expiration_date, user.expiration_time) || !hasRemainingData(user)) {
                return new Response('Invalid, expired, or data limit reached user', { status: 403 });
            }
            return handleIpSubscription(core, uuid, url.hostname, env);
        };

        if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
        if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData || isExpired(userData.expiration_date, userData.expiration_time)) {
                return new Response('Invalid or expired user', { status: 403 });
            }
            return handleConfigPage(path, url.hostname, cfg, userData);
        }
        
        if (cfg.rootProxyURL && url.pathname === '/') {
             try {
                const upstream = new URL(cfg.rootProxyURL);
                const proxyRequest = new Request(request);
                proxyRequest.headers.set('Host', upstream.hostname);
                
                const newUrl = new URL(request.url);
                newUrl.hostname = upstream.hostname;
                newUrl.port = upstream.port;
                newUrl.protocol = upstream.protocol;
                
                const response = await fetch(new Request(newUrl, proxyRequest));
                const headers = new Headers(response.headers);
                headers.delete('Content-Security-Policy');
                headers.delete('X-Frame-Options');
                return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
            } catch (err) {
                return new Response(`Proxy upstream error: ${err.message}`, { status: 502 });
            }
        }
        
        return new Response(`Not Found. Admin panel is at ${cfg.adminPath}`, { status: 404 });
    },
};

// --- WebSocket & UUID Helpers ---
function makeReadableWebSocketStream(ws, earlyData, log) {
    return new ReadableStream({
        start(controller) {
            ws.addEventListener('message', e => controller.enqueue(e.data));
            ws.addEventListener('close', () => { safeCloseWebSocket(ws); controller.close(); });
            ws.addEventListener('error', err => { log('WebSocket error:', err); controller.error(err); });
            const { earlyData: data, error } = base64ToArrayBuffer(earlyData);
            if (error) controller.error(error);
            else if (data) controller.enqueue(data);
        },
        cancel(reason) { log(`Stream canceled: ${reason}`); safeCloseWebSocket(ws); },
    });
}
function base64ToArrayBuffer(base64) {
    try {
        if (!base64) return { earlyData: null, error: null };
        const binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
        const buffer = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
        return { earlyData: buffer, error: null };
    } catch (error) { return { earlyData: null, error }; }
}
function safeCloseWebSocket(socket) {
  try { if (socket.readyState === 1 || socket.readyState === 2) socket.close(); } catch (error) { console.error('safeCloseWebSocket error:', error); }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return ( byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]] ).toLowerCase();
}
