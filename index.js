/**
 * Ultimate Cloudflare Worker VLESS Proxy
 *
 * This script combines a robust VLESS proxy with a feature-rich, secure admin panel.
 * It integrates smart network information, traffic limiting, usage tracking, CSRF protection,
 * and advanced subscription features into a single, high-performance worker.
 *
 * Features:
 * - VLESS over WebSocket with precise traffic tracking.
 * - Smart User Config Page: Displays Proxy & User network info (IP, Location, ISP, Risk Score).
 * - Advanced Admin Panel:
 * - Full user lifecycle management (Create, Read, Update, Delete).
 * - Time-based expiration with full timezone support.
 * - Data usage limits (MB/GB/Unlimited) and traffic reset functionality.
 * - Secure login with session management and CSRF protection.
 * - Dashboard with key statistics (Total/Active Users, Total Traffic).
 * - Export user data to CSV for external analysis.
 * - Advanced Subscription: Generates links for Xray, Sing-Box, and Clash clients using a pool of clean IPs.
 * - High Performance: Caches user data in KV for speed, with D1 for persistent storage.
 * - Fully Responsive UI for both admin and user pages.
 *
 * Setup Instructions:
 * 1. Create a D1 Database and bind it as `DB`.
 * 2. Run the D1 schema setup command:
 * wrangler d1 execute DB --command="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0);"
 * 3. Create a KV Namespace and bind it as `USER_KV`.
 * 4. Set secrets in your worker's settings:
 * - `ADMIN_KEY`: Password for the /admin panel.
 * - `UUID` (optional): A default UUID for the root path.
 * - `PROXYIP` (optional): A specific IP/domain for the proxy address field on the user page.
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

// --- Admin Panel & API ---

const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1F2937;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #374151}h1{color:#F9FAFB;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#374151;border:1px solid #4B5563;color:#F9FAFB;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px;transition:border-color .2s,box-shadow .2s}input[type=password]:focus{outline:0;border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}button{background-color:#3B82F6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#2563EB}.error{color:#EF4444;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST" action="/admin"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;

const adminPanelHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title>
    <style>
        :root{--bg-main:#0c0a09;--bg-card:#1c1917;--bg-input:#292524;--border:#44403c;--text-primary:#f5f5f4;--text-secondary:#a8a29e;--accent:#fb923c;--accent-hover:#f97316;--danger:#ef4444;--danger-hover:#dc2626;--success:#4ade80;--expired:#facc15;--btn-secondary-bg:#57534e;--btn-secondary-hover:#78716c}
        body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}
        .container{max-width:1280px;margin:30px auto;padding:0 20px}h1,h2{font-weight:600}h1{margin-bottom:20px;font-size:2rem}h2{font-size:1.5rem}
        .card{background-color:var(--bg-card);border-radius:12px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3)}
        .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}
        .stat-card{background-color:var(--bg-card);border-radius:12px;padding:20px;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}.stat-card:hover{transform:translateY(-5px);box-shadow:0 8px 16px rgba(0,0,0,.4)}
        .stat-title{font-size:14px;color:var(--text-secondary);margin:0 0 10px}.stat-value{font-size:28px;font-weight:600;margin:0}
        .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;align-items:flex-end}
        .form-group{display:flex;flex-direction:column}label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}
        .input-group{display:flex}input,select{width:100%;box-sizing:border-box;background-color:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s,box-shadow .2s}
        input:focus,select:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(251,146,60,.3)}
        .btn{padding:10px 16px;border:none;border-radius:6px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.97)}
        .btn-primary{background-color:var(--accent);color:var(--bg-main)}.btn-primary:hover{background-color:var(--accent-hover)}
        .btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}
        .btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:var(--btn-secondary-hover)}
        .input-group button{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input,.input-group select{border-radius:0;border-right:none}
        .input-group input:first-child{border-top-left-radius:6px;border-bottom-left-radius:6px}
        .input-group button:last-child,.input-group select:last-child{border-top-right-radius:6px;border-bottom-right-radius:6px;border-right:1px solid var(--border)}
        table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
        th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase}
        .status-badge{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:rgba(74,222,128,.2);color:var(--success)}.status-expired{background-color:rgba(250,204,21,.2);color:var(--expired)}
        .actions-cell{display:flex;gap:8px;justify-content:flex-start}
        .user-list-header{display:flex;justify-content:space-between;align-items:center}
        #toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:var(--bg-card);color:#fff;padding:15px 25px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:all .3s}#toast.show{display:block;opacity:1;transform:translate(-50%,-10px)}
        .modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}
        .modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;width:90%;max-width:550px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}
        .modal-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:15px;margin-bottom:20px;border-bottom:1px solid var(--border)}.modal-header h2{margin:0;font-size:20px}
        .modal-close-btn{background:0 0;border:none;color:var(--text-secondary);font-size:24px;cursor:pointer}
        .modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}
        .traffic-bar{width:100%;background-color:var(--bg-input);border-radius:4px;height:6px;overflow:hidden;margin-top:4px}.traffic-bar-inner{height:100%;background-color:var(--accent);border-radius:4px;transition:width .5s}
        .form-check{display:flex;align-items:center;margin-top:10px}.form-check input{width:auto;margin-right:8px}
        @media (max-width:768px){.container{padding:0 10px;margin-top:15px}.stats-grid{grid-template-columns:1fr 1fr}.user-list-wrapper{overflow-x:auto;-webkit-overflow-scrolling:touch}table{min-width:800px}}
    </style>
</head>
<body>
    <div class="container">
        <h1>Dashboard</h1>
        <div id="stats" class="stats-grid"></div>
        <div class="card">
            <h2>Create User</h2>
            <form id="createUserForm" class="form-grid">
                <input type="hidden" id="csrf_token" name="csrf_token">
                <div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div>
                <div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div>
                <div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div>
                <div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" min="0" placeholder="e.g., 10"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div>
                <div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div>
                <div class="form-group" style="grid-column:1/-1;align-items:flex-start;margin-top:10px"><button type="submit" class="btn btn-primary">Create User</button></div>
            </form>
        </div>
        <div class="card" style="margin-top:30px">
            <div class="user-list-header"><h2>User List</h2><button id="exportCsvBtn" class="btn btn-secondary">Export to CSV</button></div>
            <div class="user-list-wrapper">
                <table><thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table>
            </div>
        </div>
    </div>
    <div id="toast"></div>
    <div id="editModal" class="modal-overlay">
        <div class="modal-content">
            <div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div>
            <form id="editUserForm" class="form-grid">
                <input type="hidden" id="editUuid" name="uuid">
                <div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div>
                <div class="form-group"><label for="editExpiryTime">Expiry Time (Your Local Time)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required></div>
                <div class="form-group"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" min="0" placeholder="e.g., 10"><select id="editDataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div>
                <div class="form-group"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div>
                <div class="form-group form-check" style="grid-column:1/-1"><input type="checkbox" id="resetTraffic"><label for="resetTraffic">Reset Traffic Usage</label></div>
                <div class="modal-footer" style="grid-column:1/-1"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
            </form>
        </div>
    </div>
    <script>
    document.addEventListener('DOMContentLoaded',()=>{const e="/admin/api",t=document.getElementById("csrf_token").value,a={get:t=>fetch(`${e}${t}`).then(handleResponse),post:(t,a)=>fetch(`${e}${t}`,{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":document.getElementById("csrf_token").value},body:JSON.stringify(a)}).then(handleResponse),put:(t,a)=>fetch(`${e}${t}`,{method:"PUT",headers:{"Content-Type":"application/json","X-CSRF-Token":document.getElementById("csrf_token").value},body:JSON.stringify(a)}).then(handleResponse),delete:t=>fetch(`${e}${t}`,{method:"DELETE",headers:{"X-CSRF-Token":document.getElementById("csrf_token").value}}).then(handleResponse)};async function handleResponse(e){if(403===e.status)throw showToast("Session expired or invalid. Please refresh.",!0),new Error("Forbidden");if(!e.ok){const t=await e.json().catch(()=>({error:"An unknown error occurred."}));throw new Error(t.error||`Request failed with status ${e.status}`)}return 204===e.status?null:e.json()}function n(e,t=!1){const a=document.getElementById("toast");a.textContent=e,a.style.backgroundColor=t?"var(--danger)":"var(--success)",a.classList.add("show"),setTimeout(()=>{a.classList.remove("show")},3e3)}const s=e=>e.toString().padStart(2,"0"),o=(e,t)=>{if(!e||!t)return{utcDate:"",utcTime:""};const a=new Date(`${e}T${t}`);return{utcDate:`${a.getUTCFullYear()}-${s(a.getUTCMonth()+1)}-${s(a.getUTCDate())}`,utcTime:`${s(a.getUTCHours())}:${s(a.getUTCMinutes())}:${s(a.getUTCSeconds())}`}},i=(e,t)=>{if(!e||!t)return{localDate:"",localTime:""};const a=new Date(`${e}T${t}Z`);return{localDate:`${a.getFullYear()}-${s(a.getMonth()+1)}-${s(a.getDate())}`,localTime:`${s(a.getHours())}:${s(a.getMinutes())}:${s(a.getSeconds())}`}},d=e=>{if(0===e)return"0 Bytes";const t=Math.floor(Math.log(e)/Math.log(1024));return`${parseFloat((e/Math.pow(1024,t)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][t]}`};function c(e){document.getElementById("stats").innerHTML=`<div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">${e.totalUsers}</p></div><div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">${e.activeUsers}</p></div><div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">${e.expiredUsers}</p></div><div class="stat-card"><h3 class="stat-title">Total Traffic Used</h3><p class="stat-value">${d(e.totalTraffic)}</p></div>`}function l(e){const t=document.getElementById("userList");t.innerHTML=0===e.length?'<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>':e.map(e=>{const t=new Date(`${e.expiration_date}T${e.expiration_time}Z`),a=t<new Date,n=e.data_limit>0?`${d(e.data_usage)} / ${d(e.data_limit)}`:`${d(e.data_usage)} / &infin;`,s=e.data_limit>0?Math.min(100,e.data_usage/e.data_limit*100):0;return`<tr data-uuid="${e.uuid}"><td title="${e.uuid}">${e.uuid.substring(0,8)}...</td><td>${new Date(e.created_at).toLocaleString()}</td><td>${t.toLocaleString()}</td><td><span class="status-badge ${a?"status-expired":"status-active"}">${a?"Expired":"Active"}</span></td><td>${n}<div class="traffic-bar"><div class="traffic-bar-inner" style="width: ${s}%;"></div></div></td><td>${e.notes||"-"}</td><td class="actions-cell"><button class="btn btn-secondary btn-edit">Edit</button><button class="btn btn-danger btn-delete">Delete</button></td></tr>`}).join("")}async function r(){try{const[e,t]=await Promise.all([a.get("/stats"),a.get("/users")]);window.allUsers=t,c(e),l(t)}catch(e){n(e.message,!0)}}const u=(e,t)=>{const a=parseFloat(document.getElementById(e).value),n=document.getElementById(t).value;if(isNaN(a)||a<=0)return 0;return Math.round(a*("GB"===n?1073741824:1048576))},m=(e,t,a)=>{const n=document.getElementById(t),s=document.getElementById(a);if(e<=0)return n.value="",void(s.value="GB");const o=e>=1073741824,i=o?"GB":"MB",d=o?1073741824:1048576;n.value=parseFloat((e/d).toFixed(2)),s.value=i};document.getElementById("createUserForm").addEventListener("submit",async e=>{e.preventDefault();const{utcDate:t,utcTime:s}=o(document.getElementById("expiryDate").value,document.getElementById("expiryTime").value),i={uuid:document.getElementById("uuid").value,exp_date:t,exp_time:s,data_limit:u("dataLimitValue","dataLimitUnit"),notes:document.getElementById("notes").value};try{await a.post("/users",i),n("User created successfully!"),e.target.reset(),document.getElementById("uuid").value=crypto.randomUUID(),p(),r()}catch(e){n(e.message,!0)}});const g=document.getElementById("editModal");document.getElementById("userList").addEventListener("click",e=>{const t=e.target.closest("button");if(!t)return;const s=e.target.closest("tr").dataset.uuid;if(t.classList.contains("btn-edit")){const e=window.allUsers.find(e=>e.uuid===s);if(!e)return;const{localDate:t,localTime:a}=i(e.expiration_date,e.expiration_time);document.getElementById("editUuid").value=e.uuid,document.getElementById("editExpiryDate").value=t,document.getElementById("editExpiryTime").value=a,m(e.data_limit,"editDataLimitValue","editDataLimitUnit"),document.getElementById("editNotes").value=e.notes||"",document.getElementById("resetTraffic").checked=!1,g.classList.add("show")}else t.classList.contains("btn-delete")&&confirm(`Delete user ${s.substring(0,8)}...?`)&&a.delete(`/users/${s}`).then(()=>{n("User deleted successfully!"),r()}).catch(e=>n(e.message,!0))}),document.getElementById("editUserForm").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("editUuid").value,{utcDate:s,utcTime:i}=o(document.getElementById("editExpiryDate").value,document.getElementById("editExpiryTime").value),d={exp_date:s,exp_time:i,data_limit:u("editDataLimitValue","editDataLimitUnit"),notes:document.getElementById("editNotes").value,reset_traffic:document.getElementById("resetTraffic").checked};try{await a.put(`/users/${t}`,d),n("User updated successfully!"),g.classList.remove("show"),r()}catch(e){n(e.message,!0)}});const f=()=>g.classList.remove("show");document.getElementById("modalCloseBtn").addEventListener("click",f),document.getElementById("modalCancelBtn").addEventListener("click",f),g.addEventListener("click",e=>{e.target===g&&f()}),document.addEventListener("keydown",e=>{"Escape"===e.key&&f()}),document.getElementById("generateUUID").addEventListener("click",()=>document.getElementById("uuid").value=crypto.randomUUID()),document.getElementById("unlimitedBtn").addEventListener("click",()=>document.getElementById("dataLimitValue").value=""),document.getElementById("editUnlimitedBtn").addEventListener("click",()=>document.getElementById("editDataLimitValue").value=""),document.getElementById("exportCsvBtn").addEventListener("click",()=>{window.location.href="/admin/api/users/csv"});const p=()=>{const e=new Date;e.setMonth(e.getMonth()+1),document.getElementById("expiryDate").value=`${e.getFullYear()}-${s(e.getMonth()+1)}-${s(e.getDate())}`,document.getElementById("expiryTime").value=`${s(e.getHours())}:${s(e.getMinutes())}:${s(e.getSeconds())}`};document.getElementById("uuid").value=crypto.randomUUID(),p(),r()});
    </script>
</body>
</html>`;


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
        
        if (pathname === '/admin/api/users/csv' && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            const header = "uuid,created_at,expiration_date,expiration_time,notes,data_limit_bytes,data_usage_bytes\n";
            const csv = results.map(u => `"${u.uuid}","${u.created_at}","${u.expiration_date}","${u.expiration_time}","${u.notes || ''}","${u.data_limit}","${u.data_usage}"`).join("\n");
            return new Response(header + csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="users.csv"' } });
        }

        if (pathname === '/admin/api/users' && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
        }

        if (pathname === '/admin/api/users' && request.method === 'POST') {
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
                const headers = new Headers({ 'Location': '/admin', 'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict` });
                return new Response(null, { status: 302, headers });
            } else {
                return new Response(adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        if (request.method === 'GET') {
            const { isAdmin, csrfToken, errorResponse } = await checkAdminAuth(request, env);
            if (errorResponse) return errorResponse;
            if (isAdmin) {
                const panelWithCsrf = adminPanelHTML.replace('<input type="hidden" id="csrf_token" name="csrf_token">', `<input type="hidden" id="csrf_token" name="csrf_token" value="${csrfToken}">`);
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

const Config = {
  userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
  proxyIPs: [''],
  fromEnv(env) {
    const proxyAddress = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    return { userID: env.UUID || this.userID, proxyAddress };
  },
};
const CONST = { WS_READY_STATE_OPEN: 1, WS_READY_STATE_CLOSING: 2 };

function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let result = '';
  for (let i = 0; i < length; i++) { result += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: { tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'h2,http/1.1' } },
  sb: { tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h2,http/1.1' } },
};

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path, security, sni, fp, alpn });
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [ hostName, 'www.speedtest.net', 'www.visa.com', 'cdnjs.com' ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  let links = [];
  const p = CORE_PRESETS[core].tls;
  
  mainDomains.forEach((domain, i) => { 
    links.push(createVlessLink({ userID, address: domain, port: httpsPorts[i % httpsPorts.length], host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, name: `D${i+1}-TLS` }));
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
    if (r.ok) {
      const json = await r.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].sort(() => 0.5 - Math.random()).slice(0, 20).map(x => x.ip);
      ips.forEach((ip, i) => {
        const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
        links.push(createVlessLink({ userID, address: formattedAddress, port: httpsPorts[i % httpsPorts.length], host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, name: `IP${i+1}-TLS` }));
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

        if (url.pathname === '/scamalytics-lookup') {
            return handleScamalyticsLookup(request);
        }
        
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader?.toLowerCase() === 'websocket') {
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
            const cfg = Config.fromEnv(env);
            return handleConfigPage(path, url.hostname, cfg.proxyAddress, userData);
        }
        
        return new Response('Not found.', { status: 404 });
    },
};

// --- VLESS Protocol Handler with Traffic Tracking ---
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
                console.log(`Updated usage for ${userUUID} by ${sessionUsage} bytes.`);
            } catch (err) { console.error(`Failed to update usage for ${userUUID}:`, err); }
        }
    };

    const usageCounter = (isDownstream) => new TransformStream({
        transform(chunk, controller) {
            sessionUsage += chunk.byteLength;
            controller.enqueue(chunk);
        }
    });

    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
    const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader);
    let remoteSocketWrapper = { value: null };

    readableWebSocketStream
        .pipeThrough(usageCounter(true))
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                if (remoteSocketWrapper.value) {
                    const writer = remoteSocketWrapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }
                const { hasError, message, addressRemote, portRemote, rawDataIndex, protocolVersion, uuid } = await ProcessProtocolHeader(chunk, env);
                if (hasError) { controller.error(new Error(message)); return; }
                
                const user = await getUserData(env, uuid);
                if (!user || isExpired(user.expiration_date, user.expiration_time) || (user.data_limit > 0 && user.data_usage + sessionUsage >= user.data_limit)) {
                    controller.error(new Error('User validation failed.')); return;
                }
                userUUID = user.uuid;

                const vlessResponseHeader = new Uint8Array([protocolVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);
                HandleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, usageCounter(false));
            },
            close() { ctx.waitUntil(updateUsageInDB()); },
            abort(err) { console.error("WebSocket readable stream aborted:", err); ctx.waitUntil(updateUsageInDB()); },
        }))
        .catch(err => {
            console.error('WebSocket pipeline failed:', err.stack || err);
            safeCloseWebSocket(webSocket);
            ctx.waitUntil(updateUsageInDB());
        });
    return new Response(null, { status: 101, webSocket: client });
}

// THIS IS THE CORRECTED AND ROBUST PROTOCOL PARSER
async function ProcessProtocolHeader(protocolBuffer) {
  if (protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
  const dataView = new DataView(protocolBuffer);
  const version = dataView.getUint8(0);
  const uuid = unsafeStringify(new Uint8Array(protocolBuffer.slice(1, 17)));
  
  const optLength = dataView.getUint8(17);
  const command = dataView.getUint8(18 + optLength);
  if (command !== 1) return { hasError: true, message: `command ${command} is not supported` };

  const portIndex = 18 + optLength + 1;
  const portRemote = dataView.getUint16(portIndex);
  const addressType = dataView.getUint8(portIndex + 2);
  let addressValue, addressLength, addressValueIndex;

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4; addressValueIndex = portIndex + 3;
      addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain
      addressLength = dataView.getUint8(portIndex + 3); addressValueIndex = portIndex + 4;
      addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6
      addressLength = 16; addressValueIndex = portIndex + 3;
      addressValue = Array.from({ length: 8 }, (_, i) => dataView.getUint16(addressValueIndex + i * 2).toString(16)).join(':');
      break;
    default:
      return { hasError: true, message: `invalid addressType: ${addressType}` };
  }

  return { hasError: false, uuid, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, protocolVersion: new Uint8Array([version]) };
}

async function HandleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, usageCounterUpstream) {
    const tcpSocket = await connect({ hostname: addressRemote, port: portRemote });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, usageCounterUpstream);
}

function MakeReadableWebSocketStream(webSocketServer) {
    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', e => controller.enqueue(e.data));
            webSocketServer.addEventListener('close', () => { safeCloseWebSocket(webSocketServer); controller.close(); });
            webSocketServer.addEventListener('error', err => { console.error('WebSocket error:', err); controller.error(err); });
            const { earlyData, error } = base64ToArrayBuffer(new URL(webSocketServer.url).searchParams.get('ed'));
            if (error) controller.error(error); else if (earlyData) controller.enqueue(earlyData);
        },
        cancel() { safeCloseWebSocket(webSocketServer); },
    });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, usageCounterUpstream) {
    try {
        await remoteSocket.readable.pipeThrough(usageCounterUpstream).pipeTo(new WritableStream({
            async write(chunk) {
                if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN) return;
                const dataToSend = protocolResponseHeader ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer() : chunk;
                webSocket.send(dataToSend);
                protocolResponseHeader = null;
            },
            close() { console.log('Remote connection readable closed.'); },
            abort(reason) { console.error('Remote connection readable aborted:', reason); },
        }));
    } catch (error) { console.error('RemoteSocketToWS error:', error.stack || error); }
    finally { safeCloseWebSocket(webSocket); }
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
function safeCloseWebSocket(socket) {
  try { if (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING) socket.close(); }
  catch (error) { console.error('safeCloseWebSocket error:', error); }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr) {
  return ( byteToHex[arr[0]] + byteToHex[arr[1]] + byteToHex[arr[2]] + byteToHex[arr[3]] + '-' + byteToHex[arr[4]] + byteToHex[arr[5]] + '-' + byteToHex[arr[6]] + byteToHex[arr[7]] + '-' + byteToHex[arr[8]] + byteToHex[arr[9]] + '-' + byteToHex[arr[10]] + byteToHex[arr[11]] + byteToHex[arr[12]] + byteToHex[arr[13]] + byteToHex[arr[14]] + byteToHex[arr[15]] ).toLowerCase();
}

// --- Smart Config Page Generation ---
async function handleScamalyticsLookup(request) {
    const url = new URL(request.url);
    const ipToLookup = url.searchParams.get('ip');
    if (!ipToLookup) return new Response(JSON.stringify({ error: 'Missing IP parameter' }), { status: 400 });
    
    // Using a free and public IP info API as a Scamalytics substitute
    const apiUrl = `http://ip-api.com/json/${ipToLookup}?fields=status,message,country,countryCode,city,isp,query,proxy,hosting`;
    try {
        const apiResponse = await fetch(apiUrl);
        const data = await apiResponse.json();
        // Format the response to mimic the expected structure
        const formattedResponse = {
            scamalytics: {
                status: data.status,
                ip: data.query,
                score: (data.proxy || data.hosting) ? 50 : 5,
                risk: (data.proxy || data.hosting) ? 'High' : 'Low'
            },
            external_datasources: {
                dbip: {
                    ip_city: data.city,
                    ip_country_name: data.country,
                    ip_country_code: data.countryCode,
                    isp_name: data.isp
                }
            }
        };
        return new Response(JSON.stringify(formattedResponse), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.toString() }), { status: 500 });
    }
}

function handleConfigPage(userID, hostName, proxyAddress, userData) {
    const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
    const html = generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime, data_usage, data_limit);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime, dataUsage, dataLimit) {
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;

  const clientUrls = {
    universalAndroid: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
    stash: `stash://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    clashMeta: `clash://install-config?url=${encodeURIComponent(subSbUrl)}`,
  };
  const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;

  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VLESS Proxy Configuration</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>:root{--background-primary:#2a2421;--background-secondary:#35302c;--background-tertiary:#413b35;--border-color:#5a4f45;--text-primary:#e5dfd6;--text-secondary:#b3a89d;--accent-primary:#be9b7b;--status-success:#70b570;--status-error:#e05d44;--status-warning:#e0bc44;--status-info:#4f90c4;--serif:"Times New Roman",serif;--sans-serif:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{font-family:var(--sans-serif);background-color:var(--background-primary);color:var(--text-primary);padding:2rem;line-height:1.5}.container{max-width:800px;margin:20px auto;padding:0 12px}.header{text-align:center;margin-bottom:30px}.header h1{font-family:var(--serif);font-weight:400;font-size:2rem}.header p{color:var(--text-secondary);font-size:.9rem}.config-card{background:var(--background-secondary);border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid var(--border-color)}.config-title{font-family:var(--serif);font-size:1.6rem;font-weight:400;color:var(--accent-primary);margin-bottom:16px;padding-bottom:13px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between}.button,.client-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer;border:1px solid var(--border-color);background-color:var(--background-tertiary);color:var(--text-primary);text-decoration:none;transition:all .2s}.button:hover{background-color:#4d453e}.client-buttons-container{display:flex;flex-direction:column;gap:16px;margin-top:16px}.client-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.client-btn{width:100%}.qr-container{display:none;text-align:center;margin-top:20px;background:#fff;padding:10px;border-radius:8px;max-width:276px;margin-left:auto;margin-right:auto}#current-year{font-size:1em}.top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px;margin-bottom:24px}.info-card{position:relative;padding:2px;background:var(--background-secondary);border-radius:12px;overflow:hidden}.info-card.rainbow-border::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(#ff0000,#ff00ff,#0000ff,#00ffff,#00ff00,#ffff00,#ff0000);animation:rgb-spin 4s linear infinite;z-index:0}@keyframes rgb-spin{to{transform:rotate(1turn)}}.info-card-content{background:var(--background-secondary);padding:20px;border-radius:10px;position:relative;z-index:1}.info-title{text-align:center;margin:0 0 12px;font-family:var(--serif);font-size:1.5rem;color:var(--accent-primary)}.info-relative-time{text-align:center;font-size:1.2rem;font-weight:600;margin-bottom:12px}.info-relative-time.active{color:var(--status-success)}.info-relative-time.expired{color:var(--status-error)}#expiration-display{font-size:.9em;text-align:center;color:var(--text-secondary);display:grid;gap:8px}#expiration-display strong{color:var(--text-primary);font-weight:500}.data-usage-text{font-size:1.2em;font-weight:600;text-align:center;color:var(--text-primary);margin-bottom:12px}.traffic-bar-container{height:8px;background-color:var(--background-tertiary);border-radius:4px;overflow:hidden}.traffic-bar{height:100%;background:linear-gradient(90deg,var(--accent-primary),var(--status-success));border-radius:4px;transition:width .5s ease-out}.ip-info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:24px}.ip-info-section{background-color:var(--background-tertiary);border-radius:12px;padding:16px;border:1px solid var(--border-color)}.ip-info-header{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border-color);padding-bottom:10px;margin-bottom:10px}.ip-info-header h3{font-family:var(--serif);font-size:18px;font-weight:400;color:var(--accent-primary);margin:0}.ip-info-content{display:flex;flex-direction:column;gap:10px;font-size:14px}.ip-info-item .label{font-size:11px;color:var(--text-secondary);text-transform:uppercase}.ip-info-item .value{color:var(--text-primary);word-break:break-all}.badge{display:inline-block;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:500}.badge-yes{background-color:rgba(112,181,112,.15);color:var(--status-success)}.badge-no{background-color:rgba(224,93,68,.15);color:var(--status-error)}.badge-warning{background-color:rgba(224,188,68,.15);color:var(--status-warning)}.badge-neutral{background-color:rgba(79,144,196,.15);color:var(--status-info)}.skeleton{display:inline-block;background:linear-gradient(90deg,var(--background-tertiary) 25%,var(--background-secondary) 50%,var(--background-tertiary) 75%);background-size:200% 100%;animation:loading 1.5s infinite;border-radius:4px;height:16px;width:120px}@keyframes loading{0%{background-position:200% 0}100%{background-position:-200% 0}}.country-flag{width:18px;height:auto;margin-right:6px;vertical-align:middle;border-radius:2px}@media (max-width:768px){body{padding:1rem}.top-grid{grid-template-columns:1fr}}</style></head>
  <body data-proxy-ip="${proxyAddress}"><div class="container"><div class="header"><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></div>
  <div class="top-grid">
  <div class="info-card rainbow-border"><div class="info-card-content"><h2 class="info-title">Expiration Date</h2><div id="expiration-relative" class="info-relative-time">Loading...</div><div id="expiration-display" data-utc-time="${utcTimestamp}"><span><strong>Your Local Time:</strong> --</span><span><strong>Tehran Time:</strong> --</span><span><strong>Universal Time:</strong> --</span></div></div></div>
  <div class="info-card"><div class="info-card-content"><h2 class="info-title">Data Usage</h2><div id="data-usage-display" class="data-usage-text" data-usage="${dataUsage}" data-limit="${dataLimit}">Loading...</div><div class="traffic-bar-container"><div id="traffic-bar-inner" class="traffic-bar"></div></div></div></div>
  </div>
  <div class="config-card"><div class="config-title"><span>Network Information</span><button id="refresh-ip-info" class="button">Refresh</button></div><div class="ip-info-grid"><div class="ip-info-section"><div class="ip-info-header"><h3>Proxy Server</h3></div><div class="ip-info-content"><div class="ip-info-item"><span class="label">Proxy Host</span><span class="value" id="proxy-host"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">IP Address</span><span class="value" id="proxy-ip"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="proxy-isp"><span class="skeleton"></span></span></div></div></div><div class="ip-info-section"><div class="ip-info-header"><h3>Your Connection</h3></div><div class="ip-info-content"><div class="ip-info-item"><span class="label">Your IP</span><span class="value" id="client-ip"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="client-isp"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">Risk Score</span><span class="value" id="client-proxy"><span class="skeleton"></span></span></div></div></div></div></div>
  <div class="config-card"><div class="config-title"><span>Xray Subscription</span><button class="button copy-button" data-clipboard-text="${subXrayUrl}">Copy Link</button></div><div class="client-buttons-container"><div class="client-buttons"><a href="${clientUrls.universalAndroid}" class="client-btn">Universal Import (Android)</a><a href="${clientUrls.shadowrocket}" class="client-btn">Import to Shadowrocket (iOS)</a><a href="${clientUrls.stash}" class="client-btn">Import to Stash (iOS)</a><button class="client-btn" onclick="toggleQR('xray','${subXrayUrl}')">Show QR Code</button></div></div><div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div></div>
  <div class="config-card"><div class="config-title"><span>Sing-Box / Clash Subscription</span><button class="button copy-button" data-clipboard-text="${subSbUrl}">Copy Link</button></div><div class="client-buttons-container"><div class="client-buttons"><a href="${clientUrls.clashMeta}" class="client-btn">Import to Clash Meta / Stash</a><button class="client-btn" onclick="toggleQR('singbox','${subSbUrl}')">Show QR Code</button></div></div><div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div></div>
  </div><script>
  function copyToClipboard(t,e){const n=t.innerHTML;navigator.clipboard.writeText(e).then(()=>{t.innerHTML="Copied!",t.disabled=!0,setTimeout(()=>{t.innerHTML=n,t.disabled=!1},1200)})}function toggleQR(t,e){var n=document.getElementById("qr-"+t+"-container");"none"===n.style.display||""===n.style.display?(n.style.display="block",n.innerHTML||(new QRCode(n,{text:e,width:256,height:256,colorDark:"#2a2421",colorLight:"#e5dfd6",correctLevel:QRCode.CorrectLevel.H}))):n.style.display="none"}async function fetchClientPublicIP(){try{return(await(await fetch("https://1.1.1.1/cdn-cgi/trace")).text()).match(/ip=([\\w.:]+)/)[1]}catch(t){return console.error("Error fetching client IP:",t),null}}async function fetchScamalyticsClientInfo(t){if(!t)return null;try{const e=await fetch(`/scamalytics-lookup?ip=${encodeURIComponent(t)}`);if(!e.ok)throw new Error(`Worker request failed! status: ${e.status}`);const n=await e.json();if(n.scamalytics&&"error"===n.scamalytics.status)throw new Error(n.scamalytics.error||"Scamalytics API error");return n}catch(t){return console.error("Error fetching from Scamalytics:",t),null}}function updateDisplay(t,e,n=null){const o=document.getElementById(`${t}-host`);o&&n&&(o.textContent=n);const a=document.getElementById(`${t}-ip`),i=document.getElementById(`${t}-location`),l=document.getElementById(`${t}-isp`),c=document.getElementById(`${t}-proxy`);if(e){a&&(a.textContent=e.ip||"N/A");const n=e.external_datasources?.dbip;if(i&&n){const t=n.ip_city||"",e=n.ip_country_name||"",o=n.ip_country_code?n.ip_country_code.toLowerCase():"",a=`<img src="https://flagcdn.com/w20/${o}.png" srcset="https://flagcdn.com/w40/${o}.png 2x" alt="${n.ip_country_code}" class="country-flag">`,s=[t,e].filter(Boolean).join(", ");i.innerHTML=`${o?a:""}${s}`.trim()||"N/A"}if(l&&n&&(l.textContent=n.isp_name||"N/A"),c&&e.scamalytics){const t=e.scamalytics.score,n=e.scamalytics.risk;let o="Unknown",a="badge-neutral";n&&void 0!==t&&(o=`${t} - ${n.charAt(0).toUpperCase()+n.slice(1)}`,{low:"badge-yes",medium:"badge-warning",high:"badge-no","very high":"badge-no"}[n.toLowerCase()]),c.innerHTML=`<span class="badge ${a}">${o}</span>`}}else a&&(a.innerHTML="N/A"),i&&(i.innerHTML="N/A"),l&&(l.innerHTML="N/A"),c&&(c.innerHTML="N/A")}async function loadNetworkInfo(){const t=document.body.getAttribute("data-proxy-ip")||"N/A",e=t.split(":")[0];updateDisplay("proxy",null,t);try{let n=e;if(!/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(e)&&!/^[0-9a-fA-F:]+$/.test(e))try{const t=await fetch(`https://dns.google/resolve?name=${encodeURIComponent(e)}&type=A`);if(t.ok){const e=(await t.json()).Answer?.find(t=>1===t.type);e&&(n=e.data)}}catch(t){console.error("DNS resolution failed:",t)}const o=await fetchScamalyticsClientInfo(n);updateDisplay("proxy",o,t)}catch(t){console.error("Proxy info error",t)}const n=await fetchClientPublicIP();if(n){const t=await fetchScamalyticsClientInfo(n);updateDisplay("client",t)}}function displayTimes(){const t=document.getElementById("expiration-display"),e=document.getElementById("expiration-relative");if(!t?.dataset.utcTime)return;const n=new Date(t.dataset.utcTime);if(isNaN(n.getTime()))return;const o=(n.getTime()-Date.now())/1e3,a=o<0;if(e){if(a)e.textContent="Expired",e.className="info-relative-time expired";else{const t=new Intl.RelativeTimeFormat("en",{numeric:"auto"});let n;n=Math.abs(o)<3600?t.format(Math.round(o/60),"minute"):Math.abs(o)<86400?t.format(Math.round(o/3600),"hour"):t.format(Math.round(o/86400),"day"),e.textContent=`Expires ${n}`,e.className="info-relative-time active"}}t.innerHTML=`<span><strong>Your Local Time:</strong> ${n.toLocaleString()}</span><span><strong>Tehran Time:</strong> ${n.toLocaleString("en-US",{timeZone:"Asia/Tehran",year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</span><span><strong>Universal Time:</strong> ${n.toISOString().substring(0,19).replace("T"," ")} UTC</span>`}function displayUsage(){const t=document.getElementById("data-usage-display"),e=document.getElementById("traffic-bar-inner"),n=parseInt(t.dataset.usage,10),o=parseInt(t.dataset.limit,10),a=t=>{if(t<=0)return"0 Bytes";const e=Math.floor(Math.log(t)/Math.log(1024));return`${parseFloat((t/Math.pow(1024,e)).toFixed(2))} ${["Bytes","KB","MB","GB","TB"][e]}`};t.innerHTML=`${a(n)} / ${o>0?a(o):"&infin;"}`;const i=o>0?Math.min(100,n/o*100):0;e.style.width=`${i}%`}document.addEventListener("DOMContentLoaded",()=>{loadNetworkInfo(),displayTimes(),displayUsage(),document.getElementById("refresh-ip-info")?.addEventListener("click",function(){const t=this;t.disabled=!0,loadNetworkInfo().finally(()=>setTimeout(()=>{t.disabled=!1},1e3))}),document.querySelectorAll(".copy-button").forEach(t=>{t.addEventListener("click",function(e){e.preventDefault(),copyToClipboard(this,this.dataset.clipboardText)})})});
  </script></body></html>`;
}
