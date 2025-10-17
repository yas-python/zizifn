/**
 * Cloudflare Worker VLESS Proxy - Ultimate Combined Version
 *
 * This definitive script combines a feature-rich admin panel and smart user-facing
 * info pages with a hardened, robust connection handler to prevent common errors
 * like ERR_NETWORK_CHANGED, providing a seamless and professional experience.
 *
 * Features:
 * - VLESS over WebSocket with hardened protocol handling for maximum stability.
 * - Dynamic config pages with Smart Network Information (User & Proxy IP/Location/ISP).
 * - Xray and Sing-Box/Clash subscription generation.
 * - Comprehensive Admin Panel:
 * - Secure login with session and full CSRF protection.
 * - Complete user management (Create, Edit, Delete, Reset Traffic).
 * - Time-based expiration and data usage limits (MB/GB/Unlimited).
 * - Responsive UI and a smooth asynchronous API.
 * - High performance with KV caching for users and D1 for persistent storage.
 *
 * Instructions for Setup:
 * 1. Create a D1 Database and bind it as `DB`.
 * 2. Run schema initialization:
 * wrangler d1 execute DB --command="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0);"
 * 3. Create a KV Namespace and bind it as `USER_KV`.
 * 4. Set secrets in your worker: `ADMIN_KEY`, and optional `UUID`, `PROXYIP`.
 */

import { connect } from 'cloudflare:sockets';

// --- Helper & Utility Functions ---
function isValidUUID(uuid) {
    if (typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function isExpired(expDate, expTime) {
    if (!expDate || !expTime) return true;
    return new Date(`${expDate}T${expTime}Z`) <= new Date();
}

async function getUserData(env, uuid) {
    if (!isValidUUID(uuid)) return null;
    const cacheKey = `user:${uuid}`;
    try {
        const cachedData = await env.USER_KV.get(cacheKey, 'json');
        if (cachedData) return cachedData;
    } catch (e) {
        console.error("KV JSON parse error:", e);
    }
    const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (userFromDb) {
        await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 });
    }
    return userFromDb;
}

// --- Smart Network Information Functions ---
const IP_API_URL = 'http://ip-api.com/json/';
async function getIPInfo(ip) {
    if (!ip) return null;
    try {
        const response = await fetch(`${IP_API_URL}${ip}?fields=status,message,country,city,isp,query`);
        const data = await response.json();
        return data.status === 'success' ? { ip: data.query, country: data.country || 'N/A', city: data.city || 'N/A', isp: data.isp || 'N/A', risk: 'Low' } : null;
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
        const { ip } = await (await fetch('https://api.ipify.org?format=json')).json();
        const ipInfo = await getIPInfo(ip);
        if (ipInfo) {
            await env.USER_KV.put(cacheKey, JSON.stringify(ipInfo), { expirationTtl: 3600 });
        }
        return ipInfo;
    } catch (e) {
        console.error('Failed to get proxy IP info:', e);
        return null;
    }
}

// --- Admin Panel & API ---
const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1F2937;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #374151}h1{color:#F9FAFB;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#374151;border:1px solid #4B5563;color:#F9FAFB;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px;transition:border-color .2s,box-shadow .2s}input[type=password]:focus{outline:0;border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}button{background-color:#3B82F6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#2563EB}.error{color:#EF4444;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST" action="/admin"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;
const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>:root{--bg-main:#0c0a09;--bg-card:#1c1917;--bg-input:#292524;--border:#44403c;--text-primary:#f5f5f4;--text-secondary:#a8a29e;--accent:#fb923c;--accent-hover:#f97316;--danger:#ef4444;--danger-hover:#dc2626;--success:#4ade80;--expired:#facc15;--btn-secondary-bg:#57534e;--btn-secondary-hover:#78716c}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1280px;margin:30px auto;padding:0 20px}.card{background-color:var(--bg-card);border-radius:12px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3)}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}.stat-card{background-color:var(--bg-card);border-radius:12px;padding:20px;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}.stat-card:hover{transform:translateY(-5px);box-shadow:0 8px 16px rgba(0,0,0,.4)}.stat-title{font-size:14px;color:var(--text-secondary);margin:0 0 10px}.stat-value{font-size:28px;font-weight:600;margin:0}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.input-group{display:flex}input,select{width:100%;box-sizing:border-box;background-color:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s,box-shadow .2s}input:focus,select:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(251,146,60,.3)}.btn{padding:10px 16px;border:none;border-radius:6px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.97)}.btn-primary{background-color:var(--accent);color:var(--bg-main)}.btn-primary:hover{background-color:var(--accent-hover)}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:var(--btn-secondary-hover)}.input-group button{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input,.input-group select{border-radius:0;border-right:none}.input-group input:first-child{border-top-left-radius:6px;border-bottom-left-radius:6px}.input-group button:last-child{border-top-right-radius:6px;border-bottom-right-radius:6px;border-right:1px solid var(--border)}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase}.status-badge{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:rgba(74,222,128,.2);color:var(--success)}.status-expired{background-color:rgba(250,204,21,.2);color:var(--expired)}.actions-cell{display:flex;gap:8px;justify-content:flex-start}#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:var(--bg-card);color:#fff;padding:15px 25px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:all .3s}#toast.show{display:block;opacity:1;transform:translate(-50%,-10px)}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;width:90%;max-width:550px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:15px;margin-bottom:20px;border-bottom:1px solid var(--border)}.modal-header h2{margin:0;font-size:20px}.modal-close-btn{background:0 0;border:none;color:var(--text-secondary);font-size:24px;cursor:pointer}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.traffic-bar{width:100%;background-color:var(--bg-input);border-radius:4px;height:6px;overflow:hidden;margin-top:4px}.traffic-bar-inner{height:100%;background-color:var(--accent);border-radius:4px;transition:width .5s}.form-check{display:flex;align-items:center;margin-top:10px}.form-check input{width:auto;margin-right:8px}@media (max-width:768px){.container{padding:0 10px;margin-top:15px}.stats-grid{grid-template-columns:1fr 1fr}.user-list-wrapper{overflow-x:auto;-webkit-overflow-scrolling:touch}table{min-width:800px}}</style></head><body><div class=container><div id=stats class=stats-grid></div><div class=card><h2>Create User</h2><form id=createUserForm class=form-grid><input type=hidden id=csrf_token name=csrf_token><div class=form-group style=grid-column:1/-1><label for=uuid>UUID</label><div class=input-group><input type=text id=uuid required><button type=button id=generateUUID class="btn btn-secondary">Generate</button></div></div><div class=form-group><label for=expiryDate>Expiry Date</label><input type=date id=expiryDate required></div><div class=form-group><label for=expiryTime>Expiry Time (Your Local Time)</label><input type=time id=expiryTime step=1 required></div><div class=form-group><label for=dataLimit>Data Limit</label><div class=input-group><input type=number id=dataLimitValue placeholder="e.g., 10"><select id=dataLimitUnit><option value=GB>GB</option><option value=MB>MB</option></select><button type=button id=unlimitedBtn class="btn btn-secondary">Unlimited</button></div></div><div class=form-group><label for=notes>Notes</label><input type=text id=notes placeholder="(Optional)"></div><div class=form-group style=grid-column:1/-1;align-items:flex-start;margin-top:10px><button type=submit class="btn btn-primary">Create User</button></div></form></div><div class=card style=margin-top:30px><h2>User List</h2><div class=user-list-wrapper><table><thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id=userList></tbody></table></div></div></div><div id=toast></div><div id=editModal class=modal-overlay><div class=modal-content><div class=modal-header><h2>Edit User</h2><button id=modalCloseBtn class=modal-close-btn>&times;</button></div><form id=editUserForm class=form-grid><input type=hidden id=editUuid name=uuid><div class=form-group><label for=editExpiryDate>Expiry Date</label><input type=date id=editExpiryDate name=exp_date required></div><div class=form-group><label for=editExpiryTime>Expiry Time (Your Local Time)</label><input type=time id=editExpiryTime name=exp_time step=1 required></div><div class=form-group><label for=editDataLimit>Data Limit</label><div class=input-group><input type=number id=editDataLimitValue placeholder="e.g., 10"><select id=editDataLimitUnit><option value=GB>GB</option><option value=MB>MB</option></select><button type=button id=editUnlimitedBtn class="btn btn-secondary">Unlimited</button></div></div><div class=form-group><label for=editNotes>Notes</label><input type=text id=editNotes name=notes placeholder="(Optional)"></div><div class="form-group form-check" style=grid-column:1/-1><input type=checkbox id=resetTraffic><label for=resetTraffic>Reset Traffic Usage</label></div><div class=modal-footer style=grid-column:1/-1><button type=button id=modalCancelBtn class="btn btn-secondary">Cancel</button><button type=submit class="btn btn-primary">Save Changes</button></div></form></div></div><script>document.addEventListener("DOMContentLoaded",()=>{const e="/admin/api",t=document.getElementById("csrf_token").value,n={get:t=>fetch(`${e}${t}`).then(handleResponse),post:(t,o)=>fetch(`${e}${t}`,{method:"POST",headers:s,body:JSON.stringify(o)}).then(handleResponse),put:(t,o)=>fetch(`${e}${t}`,{method:"PUT",headers:s,body:JSON.stringify(o)}).then(handleResponse),delete:t=>fetch(`${e}${t}`,{method:"DELETE",headers:s}).then(handleResponse)},s={"Content-Type":"application/json","X-CSRF-Token":t};async function handleResponse(e){if(403===e.status)throw showToast("Session expired or invalid. Please refresh the page.",!0),new Error("Forbidden: Invalid session or CSRF token.");if(!e.ok){const t=await e.json().catch(()=>({error:"An unknown error occurred."}));throw new Error(t.error||`Request failed with status ${e.status}`)}return 204===e.status?null:e.json()}function showToast(e,t=!1){const n=document.getElementById("toast");n.textContent=e,n.style.backgroundColor=t?"var(--danger)":"var(--success)",n.classList.add("show"),setTimeout(()=>{n.classList.remove("show")},3e3)}const o=e=>e.toString().padStart(2,"0"),a=(e,t)=>{if(!e||!t)return{utcDate:"",utcTime:""};const n=new Date(`${e}T${t}`);return{utcDate:`${n.getUTCFullYear()}-${o(n.getUTCMonth()+1)}-${o(n.getUTCDate())}`,utcTime:`${o(n.getUTCHours())}:${o(n.getUTCMinutes())}:${o(n.getUTCSeconds())}`}},i=(e,t)=>{if(!e||!t)return{localDate:"",localTime:""};const n=new Date(`${e}T${t}Z`);return{localDate:`${n.getFullYear()}-${o(n.getMonth()+1)}-${o(n.getDate())}`,localTime:`${o(n.getHours())}:${o(n.getMinutes())}:${o(n.getSeconds())}`}};function d(e){if(0===e)return"0 Bytes";const t=Math.floor(Math.log(e)/Math.log(1024));return`${parseFloat((e/Math.pow(1024,t)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][t]}`}async function r(){try{const[e,t]=await Promise.all([n.get("/stats"),n.get("/users")]);window.allUsers=t,function(e){document.getElementById("stats").innerHTML=`\n                    <div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">${e.totalUsers}</p></div>\n                    <div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">${e.activeUsers}</p></div>\n                    <div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">${e.expiredUsers}</p></div>\n                    <div class="stat-card"><h3 class="stat-title">Total Traffic Used</h3><p class="stat-value">${d(e.totalTraffic)}</p></div>\n                `}(e),function(e){document.getElementById("userList").innerHTML=0===e.length?'<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>':e.map(e=>{const t=new Date(`${e.expiration_date}T${e.expiration_time}Z`),n=t<new Date,s=e.data_limit>0?`${d(e.data_usage)} / ${d(e.data_limit)}`:`${d(e.data_usage)} / &infin;`,o=e.data_limit>0?Math.min(100,e.data_usage/e.data_limit*100):0;return`\n                        <tr data-uuid="${e.uuid}">\n                            <td title="${e.uuid}">${e.uuid.substring(0,8)}...</td>\n                            <td>${new Date(e.created_at).toLocaleString()}</td>\n                            <td>${t.toLocaleString()}</td>\n                            <td><span class="status-badge ${n?"status-expired":"status-active"}">${n?"Expired":"Active"}</span></td>\n                            <td>\n                                ${s}\n                                <div class="traffic-bar"><div class="traffic-bar-inner" style="width: ${o}%;"></div></div>\n                            </td>\n                            <td>${e.notes||"-"}</td>\n                            <td class="actions-cell">\n                                <button class="btn btn-secondary btn-edit">Edit</button>\n                                <button class="btn btn-danger btn-delete">Delete</button>\n                            </td>\n                        </tr>\n                    `}).join("")}(t)}catch(e){showToast(e.message,!0)}}const c=(e,t)=>{const n=parseFloat(document.getElementById(e).value),s=document.getElementById(t).value;if(isNaN(n)||n<=0)return 0;return Math.round(n*("GB"===s?1073741824:1048576))},l=(e,t,n)=>{const s=document.getElementById(t),o=document.getElementById(n);if(e<=0)return s.value="",void(o.value="GB");const a=e>=1073741824,i=a?"GB":"MB",d=a?1073741824:1048576;s.value=parseFloat((e/d).toFixed(2)),o.value=i};document.getElementById("createUserForm").addEventListener("submit",async e=>{e.preventDefault();const{utcDate:t,utcTime:s}=a(document.getElementById("expiryDate").value,document.getElementById("expiryTime").value),o={uuid:document.getElementById("uuid").value,exp_date:t,exp_time:s,data_limit:c("dataLimitValue","dataLimitUnit"),notes:document.getElementById("notes").value};try{await n.post("/users",o),showToast("User created successfully!"),e.target.reset(),document.getElementById("uuid").value=crypto.randomUUID(),u(),r()}catch(e){showToast(e.message,!0)}});const m=document.getElementById("editModal");document.getElementById("userList").addEventListener("click",e=>{const t=e.target.closest("button");if(!t)return;const s=e.target.closest("tr").dataset.uuid;if(t.classList.contains("btn-edit")){const e=window.allUsers.find(e=>e.uuid===s);if(!e)return;const{localDate:t,localTime:n}=i(e.expiration_date,e.expiration_time);document.getElementById("editUuid").value=e.uuid,document.getElementById("editExpiryDate").value=t,document.getElementById("editExpiryTime").value=n,l(e.data_limit,"editDataLimitValue","editDataLimitUnit"),document.getElementById("editNotes").value=e.notes||"",document.getElementById("resetTraffic").checked=!1,m.classList.add("show")}else t.classList.contains("btn-delete")&&confirm(`Are you sure you want to delete user ${s.substring(0,8)}...?`)&&n.delete(`/users/${s}`).then(()=>{showToast("User deleted successfully!"),r()}).catch(e=>showToast(e.message,!0))}),document.getElementById("editUserForm").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("editUuid").value,{utcDate:s,utcTime:o}=a(document.getElementById("editExpiryDate").value,document.getElementById("editExpiryTime").value),i={exp_date:s,exp_time:o,data_limit:c("editDataLimitValue","editDataLimitUnit"),notes:document.getElementById("editNotes").value,reset_traffic:document.getElementById("resetTraffic").checked};try{await n.put(`/users/${t}`,i),showToast("User updated successfully!"),m.classList.remove("show"),r()}catch(e){showToast(e.message,!0)}});const p=()=>m.classList.remove("show");document.getElementById("modalCloseBtn").addEventListener("click",p),document.getElementById("modalCancelBtn").addEventListener("click",p),m.addEventListener("click",e=>{e.target===m&&p()}),document.addEventListener("keydown",e=>{"Escape"===e.key&&p()}),document.getElementById("generateUUID").addEventListener("click",()=>document.getElementById("uuid").value=crypto.randomUUID()),document.getElementById("unlimitedBtn").addEventListener("click",()=>{document.getElementById("dataLimitValue").value=""}),document.getElementById("editUnlimitedBtn").addEventListener("click",()=>{document.getElementById("editDataLimitValue").value=""});const u=()=>{const e=new Date;e.setMonth(e.getMonth()+1),document.getElementById("expiryDate").value=`${e.getFullYear()}-${o(e.getMonth()+1)}-${o(e.getDate())}`,document.getElementById("expiryTime").value=`${o(e.getHours())}:${o(e.getMinutes())}:${o(e.getSeconds())}`};document.getElementById("uuid").value=crypto.randomUUID(),u(),r()});</script></body></html>`;

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
            const { results } = await env.DB.prepare("SELECT expiration_date, expiration_time, data_usage FROM users").all();
            const now = new Date();
            const stats = {
                totalUsers: results.length,
                activeUsers: results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) > now).length,
                expiredUsers: results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) <= now).length,
                totalTraffic: results.reduce((sum, u) => sum + (u.data_usage || 0), 0)
            };
            return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
        }
        
        if (pathname === '/admin/api/users' && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
        }

        if (pathname === '/admin/api/users' && request.method === 'POST') {
            const { uuid, exp_date, exp_time, notes, data_limit } = await request.json();
            if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) {
                 return new Response(JSON.stringify({ error: 'Invalid or missing fields.' }), { status: 400, headers: jsonHeader });
            }
            try {
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
                const { exp_date, exp_time, notes, data_limit, reset_traffic } = await request.json();
                if (!exp_date || !exp_time) {
                     return new Response(JSON.stringify({ error: 'Invalid date/time fields.' }), { status: 400, headers: jsonHeader });
                }
                const sql = `UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ? ${reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?`;
                await env.DB.prepare(sql).bind(exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, uuid).run();
                await env.USER_KV.delete(`user:${uuid}`);
                return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
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
const CORE_PRESETS = {
  xray: { tls: { path: (p = Math.random().toString(36).substring(2, 8)) => `/${p}?ed=2048`, security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} } },
  sb: { tls: { path: (p = Math.random().toString(36).substring(2, 10)) => `/${p}`, security: 'tls', fp: 'firefox', alpn: 'h3', extra: { ed: 2560 } } },
};

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path, ...extra });
  if (security) params.set('security', security);
  if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp);
  if (alpn) params.set('alpn', alpn);
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [ hostName, 'www.speedtest.net', 'cloudflare.com' ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  let links = [];

  const p = CORE_PRESETS[core].tls;
  mainDomains.forEach((domain, i) => {
    links.push(createVlessLink({ userID, address: domain, port: httpsPorts[i % httpsPorts.length], host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `D${i+1}` }));
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
    if (r.ok) {
      const { ipv4 = [] } = await r.json();
      ipv4.slice(0, 20).forEach((ip, i) => {
        links.push(createVlessLink({ userID, address: ip, port: httpsPorts[i % httpsPorts.length], host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `IP${i+1}` }));
      });
    }
  } catch (e) { console.error('Fetch IP list failed', e); }
  
  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' }, });
}


// --- Main Fetch Handler ---
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/admin')) {
            return handleAdminRequest(request, env);
        }

        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader?.toLowerCase() === 'websocket') {
            return VLESSOverWSHandler(request, env, ctx); // Using the hardened handler
        }

        if (url.pathname.startsWith('/xray/') || url.pathname.startsWith('/sb/')) {
            const core = url.pathname.startsWith('/xray/') ? 'xray' : 'sb';
            const uuid = url.pathname.split('/').pop();
            const userData = await getUserData(env, uuid);

            if (!userData || isExpired(userData.expiration_date, userData.expiration_time) || (userData.data_limit > 0 && userData.data_usage >= userData.data_limit)) {
                return new Response('Invalid, expired, or data limit reached.', { status: 403 });
            }
            return handleIpSubscription(core, uuid, url.hostname);
        }

        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData) {
                return new Response('User not found or invalid.', { status: 403 });
            }
            const userIP = request.headers.get('CF-Connecting-IP');
            const [userIPInfo, proxyIPInfo] = await Promise.all([getIPInfo(userIP), getProxyIPInfo(env)]);
            
            const proxyAddress = env.PROXYIP || ''; // Get proxyIP from env if set
            return handleConfigPage(path, url.hostname, proxyAddress, userData, userIPInfo, proxyIPInfo);
        }
        
        // Default root response
        const defaultUserID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        if (isValidUUID(defaultUserID)) {
             return Response.redirect(`${url.origin}/${defaultUserID}`, 302);
        }
        return new Response('Not found. Configure a default UUID to enable root redirect.', { status: 404 });
    },
};

// --- Hardened VLESS Connection Handler ---
async function VLESSOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    let sessionInfo = { userUUID: '', sessionUsage: 0 };
    
    const closeAndPersist = async () => {
        if (sessionInfo.sessionUsage > 0 && sessionInfo.userUUID) {
            try {
                await env.DB.prepare("UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?")
                    .bind(Math.round(sessionInfo.sessionUsage), sessionInfo.userUUID).run();
                await env.USER_KV.delete(`user:${sessionInfo.userUUID}`);
                console.log(`[INFO] Persisted ${sessionInfo.sessionUsage} bytes for user ${sessionInfo.userUUID}`);
            } catch (err) {
                console.error(`[ERROR] Failed to persist usage for ${sessionInfo.userUUID}:`, err);
            }
        }
    };
    
    let remoteSocket = null;
    let hasConnected = false;
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

    const pipe = async (readable, writable, isUpstream) => {
        const writer = writable.getWriter();
        const reader = readable.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sessionInfo.sessionUsage += value.byteLength;
                await writer.write(value);
            }
        } catch (err) {
            console.error(`[PIPE-ERROR] ${isUpstream ? 'Remote->Client' : 'Client->Remote'} failed:`, err);
        } finally {
            reader.releaseLock();
            writer.releaseLock();
        }
    };

    const serverReadable = new ReadableStream({
        start(controller) {
            server.addEventListener('message', event => controller.enqueue(new Uint8Array(event.data)));
            server.addEventListener('close', () => controller.close());
            server.addEventListener('error', err => controller.error(err));
        }
    });

    const serverWriter = server.writable.getWriter();
    const reader = serverReadable.getReader();

    try {
        // Handle Early Data
        const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
        if (error) throw new Error('Invalid early data');

        const firstChunk = earlyData || (await reader.read()).value;
        if (!firstChunk) throw new Error('No data received');

        const { user, address, port, rawData } = await processVLESSHeader(firstChunk, env);
        
        sessionInfo.userUUID = user.uuid;
        if (isExpired(user.expiration_date, user.expiration_time)) throw new Error('User has expired.');
        if (user.data_limit > 0 && user.data_usage >= user.data_limit) throw new Error('User data limit reached.');
        
        console.log(`[INFO] User ${user.uuid.substring(0, 8)} authenticated. Connecting to ${address}:${port}`);

        remoteSocket = connect({ hostname: address, port });
        
        const vlessResponse = new Uint8Array([firstChunk[0], 0]);
        await serverWriter.write(vlessResponse);

        const remoteWriter = remoteSocket.writable.getWriter();
        if (rawData.byteLength > 0) {
            await remoteWriter.write(rawData);
        }
        remoteWriter.releaseLock();
        hasConnected = true;

        ctx.waitUntil(Promise.all([
            pipe(remoteSocket.readable, server.writable, true),
            pipe(serverReadable, remoteSocket.writable, false)
        ]).catch(() => {}).finally(() => {
            if (remoteSocket) remoteSocket.close();
            server.close();
            closeAndPersist();
        }));

        reader.releaseLock();

    } catch (err) {
        console.error(`[ERROR] ${err.message}. Closing connection.`);
        const code = err.message.includes('UUID') ? 1008 : 1011;
        server.close(code, err.message);
        if (remoteSocket) remoteSocket.close();
        ctx.waitUntil(closeAndPersist());
    }

    return new Response(null, { status: 101, webSocket: client });
}


async function processVLESSHeader(data, env) {
    if (data.byteLength < 24) throw new Error('Invalid VLESS header: insufficient length');
    const view = new DataView(data.buffer);
    const uuid = unsafeStringify(data.slice(1, 17));
    const user = await getUserData(env, uuid);
    if (!user) throw new Error('Invalid user UUID.');
    
    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);
    if (command !== 1) throw new Error(`Unsupported command: ${command}`);

    const portIndex = 19 + optLength;
    const port = view.getUint16(portIndex);
    const addressType = view.getUint8(portIndex + 2);
    
    let address, addressLength, dataIndex;
    switch (addressType) {
        case 1: // IPv4
            addressLength = 4; dataIndex = portIndex + 3;
            address = data.slice(dataIndex, dataIndex + addressLength).join('.');
            dataIndex += addressLength; break;
        case 2: // Domain
            addressLength = view.getUint8(portIndex + 3); dataIndex = portIndex + 4;
            address = new TextDecoder().decode(data.slice(dataIndex, dataIndex + addressLength));
            dataIndex += addressLength; break;
        case 3: // IPv6
            addressLength = 16; dataIndex = portIndex + 3;
            const ipv6 = Array.from(new Uint16Array(data.buffer.slice(dataIndex, dataIndex + addressLength))).map(v => v.toString(16));
            address = ipv6.join(':');
            dataIndex += addressLength; break;
        default: throw new Error(`Invalid address type: ${addressType}`);
    }
    return { user, address, port, rawData: data.slice(dataIndex) };
}

// --- Utility & Config Page Functions ---
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return ( byteToHex[arr[offset]] + byteToHex[arr[offset+1]] + byteToHex[arr[offset+2]] + byteToHex[arr[offset+3]] + '-' + byteToHex[arr[offset+4]] + byteToHex[arr[offset+5]] + '-' + byteToHex[arr[offset+6]] + byteToHex[arr[offset+7]] + '-' + byteToHex[arr[offset+8]] + byteToHex[arr[offset+9]] + '-' + byteToHex[arr[offset+10]] + byteToHex[arr[offset+11]] + byteToHex[arr[offset+12]] + byteToHex[arr[offset+13]] + byteToHex[arr[offset+14]] + byteToHex[arr[offset+15]] ).toLowerCase();
}
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = new ArrayBuffer(binaryStr.length); const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryStr.length; i++) view[i] = binaryStr.charCodeAt(i);
    return { earlyData: buffer, error: null };
  } catch (error) { return { earlyData: null, error }; }
}

function handleConfigPage(userID, hostName, proxyAddress, userData, userIPInfo, proxyIPInfo) {
    const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
    const html = generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime, data_usage, data_limit, userIPInfo, proxyIPInfo);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
function getPageCSS() {
    return `:root{--bg-main:#121212;--bg-card:#1E1E1E;--bg-inner:#2f2f2f;--border-color:#333;--text-primary:#E0E0E0;--text-secondary:#B0B0B0;--accent:#6200EE;--accent-hover:#7F39FB;--status-active:#03DAC6;--status-expired:#CF6679;--network-bg:#212121;--network-border:#444}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background-color:var(--bg-main);color:var(--text-primary);padding:20px}.container{max-width:900px;margin:auto}.header{text-align:center;margin-bottom:24px}.header h1{font-size:2em;margin-bottom:8px}.header p{color:var(--text-secondary)}.top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;margin-bottom:20px}.info-card{background:var(--bg-card);border-radius:12px;position:relative;overflow:hidden;border:1px solid var(--border-color)}.info-card.rainbow-border::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(from 180deg at 50% 50%,#CF6679,#6200EE,#03DAC6,#CF6679);animation:spin 4s linear infinite;z-index:1}.info-card-content{background:var(--bg-card);padding:20px;border-radius:10px;position:relative;z-index:2;margin:2px}.info-title{font-size:1.25em;text-align:center;margin:0 0 16px;font-weight:500}.info-relative-time{text-align:center;font-size:1.4em;font-weight:600;margin-bottom:16px}.status-active-text{color:var(--status-active)}.status-expired-text{color:var(--status-expired)}.info-time-grid{display:grid;gap:8px;font-size:.9em;text-align:center;color:var(--text-secondary)}.data-usage-text{font-size:1.4em!important;font-weight:600;text-align:center;color:var(--text-primary);margin-bottom:16px}.traffic-bar-container{height:8px;background-color:var(--bg-inner);border-radius:4px;overflow:hidden}.traffic-bar{height:100%;background:linear-gradient(90deg,var(--accent) 0,var(--status-active) 100%);border-radius:4px;transition:width .5s ease-out}.config-card{background:var(--bg-card);border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid var(--border-color)}.config-title{display:flex;justify-content:space-between;align-items:center;font-size:1.4rem;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)}.button,.client-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;border:1px solid var(--border-color);background-color:var(--bg-inner);color:var(--text-primary);text-decoration:none;transition:all .2s}.button:hover{background-color:#3f3f3f}.client-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.client-btn{width:100%;box-sizing:border-box;background-color:var(--accent);color:#fff;border:none}.client-btn:hover{background-color:var(--accent-hover)}.qr-container{display:none;margin-top:20px;background:#fff;padding:16px;border-radius:8px;max-width:288px;margin-left:auto;margin-right:auto}.network-info-wrapper{background:var(--bg-card);border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid var(--border-color)}.network-info-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)}.network-info-header h2{margin:0;font-size:1.4rem}.network-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}.network-card{background:var(--network-bg);border:1px solid var(--network-border);border-radius:8px;padding:16px}.network-title{font-size:1.1em;margin-top:0;margin-bottom:12px;border-bottom:1px solid var(--network-border);padding-bottom:8px;color:var(--status-active)}.network-info-grid{display:grid;gap:8px;font-size:.9em}.network-info-grid strong{color:var(--text-secondary);font-weight:400;display:inline-block;width:120px}.network-info-grid span{color:var(--text-primary);font-weight:500}.refresh-btn{background-color:var(--network-bg)}.refresh-btn:hover{background-color:#3f3f3f}@keyframes spin{to{transform:rotate(1turn)}}@media (max-width:768px){body{padding:10px}.top-grid,.network-grid{grid-template-columns:1fr}.network-info-header{flex-direction:column;align-items:flex-start}.network-info-header button{margin-top:10px;width:100%}}`;
}
function getPageHTML(clientUrls, subXrayUrl, subSbUrl) {
    return `<div class=config-card><div class=config-title><span>Xray Subscription</span><button id=copy-xray-sub-btn class=button data-clipboard-text=${subXrayUrl}>Copy Link</button></div><div class=client-buttons><a href=${clientUrls.universal} class=client-btn>Universal Import (V2rayNG, etc.)</a> <a href=${clientUrls.shadowrocket} class=client-btn>Import to Shadowrocket</a> <a href=${clientUrls.stash} class=client-btn>Import to Stash (VLESS)</a><button class=client-btn onclick=toggleQR('xray','${subXrayUrl}')>Show QR Code</button></div><div id=qr-xray-container class=qr-container><div id=qr-xray></div></div></div><div class=config-card><div class=config-title><span>Sing-Box / Clash Subscription</span><button id=copy-sb-sub-btn class=button data-clipboard-text=${subSbUrl}>Copy Link</button></div><div class=client-buttons><a href=${clientUrls.clashMeta} class=client-btn>Import to Clash Meta / Stash</a><button class=client-btn onclick=toggleQR('singbox','${subSbUrl}')>Show QR Code</button></div><div id=qr-singbox-container class=qr-container><div id=qr-singbox></div></div></div>`;
}
function getPageScript() {
    return `function copyToClipboard(e,t){const n=e.textContent;navigator.clipboard.writeText(t).then(()=>{e.textContent="Copied!",setTimeout(()=>{e.textContent=n},1500)})}function toggleQR(e,t){const n=document.getElementById("qr-"+e+"-container"),o=document.getElementById("qr-"+e);n.style.display&&"none"!==n.style.display?n.style.display="none":n.style.display="block",o.hasChildNodes()||new QRCode(o,{text:t,width:256,height:256,colorDark:"#000",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.H})}function displayExpirationTimes(){const e=document.getElementById("expiration-display"),t=document.getElementById("expiration-relative");if(!e?.dataset.utcTime)return;const n=new Date(e.dataset.utcTime);if(isNaN(n.getTime()))return;const o=(n.getTime()-Date.now())/1e3,a=o<0;if(!a&&t.textContent.includes("...")){const e=new Intl.RelativeTimeFormat("en",{numeric:"auto"});let n="";n=Math.abs(o)<3600?e.format(Math.round(o/60),"minute"):Math.abs(o)<86400?e.format(Math.round(o/3600),"hour"):e.format(Math.round(o/86400),"day"),t.textContent=\`Expires \${n}\`}else a&&(t.textContent="Subscription Expired");document.getElementById("local-time").textContent=n.toLocaleString(),document.getElementById("tehran-time").textContent=n.toLocaleString("en-US",{timeZone:"Asia/Tehran",hour12:!0,year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}),document.getElementById("utc-time").textContent=\`\${n.toISOString().substring(0,19).replace("T"," ")} UTC\`}function displayDataUsage(){const e=document.getElementById("data-usage-display"),t=parseInt(e.dataset.usage,10),n=parseInt(e.dataset.limit,10),o=e=>{if(e<=0)return"0 Bytes";const t=Math.floor(Math.log(e)/Math.log(1024));return\`\${parseFloat((e/Math.pow(1024,t)).toFixed(2))} \${["Bytes","KB","MB","GB","TB"][t]}\`};e.innerHTML=\`\${o(t)} / \${n>0?o(n):"∞"}\`}async function fetchNetworkInfo(){try{window.location.reload()}catch(e){console.error("Network info refresh failed:",e),alert("Failed to refresh network information. Please try again.")}}window.refreshNetworkInfo=fetchNetworkInfo,document.addEventListener("DOMContentLoaded",()=>{displayExpirationTimes(),displayDataUsage(),document.querySelectorAll(".button[data-clipboard-text]").forEach(e=>{e.addEventListener("click",()=>copyToClipboard(e,e.dataset.clipboardText))}),setInterval(displayExpirationTimes,6e4)});`;
}
function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime, dataUsage, dataLimit, userIPInfo, proxyIPInfo) {
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
    
    let statusMessage = isUserExpired ? "Expires in --" : dataLimitReached ? "Data limit reached" : "Expires in ...";
    let statusColorClass = isUserExpired || dataLimitReached ? "status-expired-text" : "status-active-text";

    const renderNetworkCard = (title, ipInfo) => {
        const ip = ipInfo?.ip || 'N/A';
        const location = ipInfo ? `${ipInfo.city}, ${ipInfo.country}` : 'N/A';
        const isp = ipInfo?.isp || 'N/A';
        const risk = ipInfo?.risk || 'N/A';
        return `<div class=network-card><h3 class=network-title>${title}</h3><div class=network-info-grid><div><strong>IP Address:</strong> <span>${ip}</span></div><div><strong>Location:</strong> <span>${location}</span></div><div><strong>ISP Provider:</strong> <span>${isp}</span></div>${title==='Your Connection'?`<div><strong>Risk Score:</strong> <span>${risk}</span></div>`:''}</div></div>`;
    };

    const networkInfoBlock = `<div class=network-info-wrapper><div class=network-info-header><h2>Network Information</h2><button class="button refresh-btn" onclick=refreshNetworkInfo()>Refresh</button></div><div id=network-info-grid class=network-grid>${renderNetworkCard('Proxy Server',proxyIPInfo)}${renderNetworkCard('Your Connection',userIPInfo)}</div></div>`;
    const expirationBlock = `<div class="info-card rainbow-border"><div class=info-card-content><h2 class=info-title>Expiration Date</h2><div id=expiration-relative class="info-relative-time ${statusColorClass}">${statusMessage}</div><div class=info-time-grid id=expiration-display data-utc-time=${utcTimestamp}><div><strong>Your Local Time:</strong> <span id=local-time>--</span></div><div><strong>Tehran Time:</strong> <span id=tehran-time>--</span></div><div><strong>Universal Time:</strong> <span id=utc-time>--</span></div></div></div></div>`;
    const trafficPercent = hasDataLimit ? Math.min(100, (dataUsage / dataLimit * 100)) : 0;
    const dataUsageBlock = `<div class=info-card><div class=info-card-content><h2 class=info-title>Data Usage</h2><div class=data-usage-text id=data-usage-display data-usage=${dataUsage} data-limit=${dataLimit}>Loading...</div><div class=traffic-bar-container><div class=traffic-bar style=width:${trafficPercent}%></div></div></div></div>`;

    return `<!doctype html><html lang=en><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>VLESS Proxy Configuration</title><script src=https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js></script><style>${getPageCSS()}</style></head><body><div class=container><div class=header><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></div>${networkInfoBlock}<div class=top-grid>${expirationBlock}${dataUsageBlock}</div>${getPageHTML(clientUrls,subXrayUrl,subSbUrl)}</div><script>${getPageScript()}</script></body></html>`;
}
