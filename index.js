/**
 * Ultimate Cloudflare Worker VLESS Proxy with Advanced Admin Panel
 *
 * This script combines robust VLESS proxying with a feature-rich, secure admin dashboard.
 * It integrates traffic tracking, data limits, and a smart user-facing subscription page
 * with dynamic network information, CSRF protection, and a variable admin path.
 *
 * Features:
 * - VLESS over WebSocket with precise Upstream/Downstream traffic tracking.
 * - Secure Admin Panel:
 * - Customizable Admin Path via `ADMIN_PATH` secret for enhanced security.
 * - Secure login with session management and CSRF protection on all actions.
 * - Full user management: Create, Edit (Expiry, Data Limit, Notes), Delete.
 * - Data limits (MB/GB/Unlimited) and traffic usage reset functionality.
 * - Dashboard with statistics: Total/Active/Expired Users, Total Traffic.
 * - Smart Subscription Page for Users:
 * - Smart Network Information Card: Displays Proxy Server (IP, Location, ISP) and User's Connection (IP, Location, ISP).
 * - Dynamic display of expiration date (Local, Tehran, UTC) and data usage with a progress bar.
 * - One-click import links for popular clients (V2rayNG, Shadowrocket, Stash, Clash Meta).
 * - High Performance & Reliability:
 * - Caches user data in KV for fast authentication.
 * - Persists all user data in a D1 database.
 * - Stable Connection Logic: Merges stable protocol handling with accurate traffic metering.
 *
 * --- SETUP INSTRUCTIONS ---
 * 1. Create a D1 Database and bind it to this worker as `DB`.
 * 2. Run the following command via Wrangler to initialize the database schema:
 * wrangler d1 execute DB --command="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0);"
 * 3. Create a KV Namespace and bind it as `USER_KV`.
 * 4. Set the following secrets in your worker's settings (Settings > Variables > Environment Variables > Edit variables):
 * - `ADMIN_KEY`: The password for accessing the admin panel.
 * - `ADMIN_PATH`: (Recommended for security) A secret path for your admin panel (e.g., 'my-secret-panel'). If not set, it defaults to 'admin'.
 * - `UUID`: (Optional) A default fallback UUID.
 * - `PROXYIP`: (Optional) A default proxy IP/domain for subscription links (e.g., 'your.domain.com:443').
 */

import { connect } from 'cloudflare:sockets';

// --- Helper & Utility Functions ---

function isValidUUID(uuid) {
    if (typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function isUserInvalid(user) {
    if (!user) return true;
    // Check expiration
    const expDate = new Date(`${user.expiration_date}T${user.expiration_time}Z`);
    if (expDate <= new Date()) return true;
    // Check data limit
    if (user.data_limit > 0 && user.data_usage >= user.data_limit) return true;
    return false;
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

// --- Smart Network Information Functions ---

async function getIPInfo(ip) {
    if (!ip) return { ip: 'N/A', location: 'N/A', isp: 'N/A', risk: 'N/A' };
    try {
        // Using a reliable and free geolocation API
        const response = await fetch(`https://ipinfo.io/${ip}/json`);
        if (!response.ok) throw new Error(`ipinfo.io status: ${response.status}`);
        const data = await response.json();
        return {
            ip: data.ip || 'N/A',
            location: `${data.city || ''}, ${data.country || ''}`.replace(/^,|,$/g, '').trim() || 'N/A',
            isp: data.org || 'N/A',
            risk: 'Low' // Placeholder, real risk score requires a paid API like Scamalytics
        };
    } catch (e) {
        console.error(`Error fetching IP info for ${ip}:`, e);
        return { ip, location: 'Error', isp: 'Error', risk: 'Unknown' };
    }
}

async function getProxyIPInfo(env, proxyAddress) {
    const cacheKey = 'proxy_ip_info';
    let cachedInfo = await env.USER_KV.get(cacheKey, 'json');
    if (cachedInfo) return cachedInfo;

    try {
        let ipToLookup = proxyAddress.split(':')[0];
        // If it's a domain, resolve it to an IP first
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipToLookup) && !ipToLookup.includes(':')) {
            const dnsResponse = await fetch(`https://dns.google/resolve?name=${ipToLookup}&type=A`);
            const dnsData = await dnsResponse.json();
            if (dnsData.Answer && dnsData.Answer.length > 0) {
                ipToLookup = dnsData.Answer[0].data;
            }
        }
        
        const ipInfo = await getIPInfo(ipToLookup);
        ipInfo.host = proxyAddress; // Add the original host to the info object
        await env.USER_KV.put(cacheKey, JSON.stringify(ipInfo), { expirationTtl: 3600 });
        return ipInfo;
    } catch (e) {
        console.error('Failed to determine proxy IP info:', e);
        return { host: proxyAddress, ip: 'N/A', location: 'N/A', isp: 'N/A' };
    }
}


// --- Admin Panel & API ---
// Note: The HTML/JS for the admin panel is very long, so it's kept as a constant here.
// This is the advanced panel from Script 2, which is already integrated with traffic management.

const adminLoginHTML = (adminPath) => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login</title>
    <style>
        body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .login-container { background-color: #1F2937; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); text-align: center; width: 320px; border: 1px solid #374151; }
        h1 { color: #F9FAFB; margin-bottom: 24px; font-weight: 500; }
        form { display: flex; flex-direction: column; }
        input[type="password"] { background-color: #374151; border: 1px solid #4B5563; color: #F9FAFB; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 16px; transition: border-color 0.2s, box-shadow 0.2s; }
        input[type="password"]:focus { outline: none; border-color: #3B82F6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3); }
        button { background-color: #3B82F6; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; }
        button:hover { background-color: #2563EB; }
        .error { color: #EF4444; margin-top: 15px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>Admin Login</h1>
        <form method="POST" action="/${adminPath}">
            <input type="password" name="password" placeholder="••••••••••••••" required>
            <button type="submit">Login</button>
        </form>
        </div>
</body>
</html>`;

const adminPanelHTML = (adminPath, csrfToken) => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard</title>
    <style>
        :root {
            --bg-main: #0c0a09; --bg-card: #1c1917; --bg-input: #292524; --border: #44403c;
            --text-primary: #f5f5f4; --text-secondary: #a8a29e; --accent: #fb923c; --accent-hover: #f97316;
            --danger: #ef4444; --danger-hover: #dc2626; --success: #4ade80; --expired: #facc15;
            --btn-secondary-bg: #57534e; --btn-secondary-hover: #78716c;
        }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: var(--bg-main); color: var(--text-primary); font-size: 14px; }
        .container { max-width: 1280px; margin: 30px auto; padding: 0 20px; }
        .card { background-color: var(--bg-card); border-radius: 12px; padding: 24px; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background-color: var(--bg-card); border-radius: 12px; padding: 20px; border: 1px solid var(--border); transition: transform 0.2s, box-shadow 0.2s; }
        .stat-card:hover { transform: translateY(-5px); box-shadow: 0 8px 16px rgba(0,0,0,0.4); }
        .stat-title { font-size: 14px; color: var(--text-secondary); margin: 0 0 10px 0; }
        .stat-value { font-size: 28px; font-weight: 600; margin: 0; }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; align-items: flex-end; }
        .form-group { display: flex; flex-direction: column; }
        label { margin-bottom: 8px; font-weight: 500; color: var(--text-secondary); }
        .input-group { display: flex; }
        input, select {
            width: 100%; box-sizing: border-box; background-color: var(--bg-input); border: 1px solid var(--border);
            color: var(--text-primary); padding: 10px; border-radius: 6px; font-size: 14px; transition: border-color 0.2s, box-shadow 0.2s;
        }
        input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(251, 146, 60, 0.3); }
        .btn { padding: 10px 16px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        .btn:active { transform: scale(0.97); }
        .btn-primary { background-color: var(--accent); color: var(--bg-main); }
        .btn-primary:hover { background-color: var(--accent-hover); }
        .btn-danger { background-color: var(--danger); color: white; }
        .btn-danger:hover { background-color: var(--danger-hover); }
        .btn-secondary { background-color: var(--btn-secondary-bg); color: white; }
        .btn-secondary:hover { background-color: var(--btn-secondary-hover); }
        .input-group button { border-top-left-radius: 0; border-bottom-left-radius: 0; }
        .input-group input, .input-group select { border-radius: 0; border-right: none; }
        .input-group input:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
        .input-group button:last-child { border-top-right-radius: 6px; border-bottom-right-radius: 6px; border-right: 1px solid var(--border); }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
        th { color: var(--text-secondary); font-weight: 600; font-size: 12px; text-transform: uppercase; }
        .status-badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; display: inline-block; }
        .status-active { background-color: rgba(74, 222, 128, 0.2); color: var(--success); }
        .status-expired { background-color: rgba(250, 204, 21, 0.2); color: var(--expired); }
        .actions-cell { display: flex; gap: 8px; justify-content: flex-start; }
        #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background-color: var(--bg-card); color: white; padding: 15px 25px; border-radius: 8px; z-index: 1001; display: none; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0; transition: all 0.3s; }
        #toast.show { display: block; opacity: 1; transform: translate(-50%, -10px); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
        .modal-overlay.show { opacity: 1; visibility: visible; }
        .modal-content { background-color: var(--bg-card); padding: 30px; border-radius: 12px; width: 90%; max-width: 550px; transform: scale(0.9); transition: transform 0.3s; border: 1px solid var(--border); }
        .modal-overlay.show .modal-content { transform: scale(1); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
        .modal-header h2 { margin: 0; font-size: 20px; }
        .modal-close-btn { background: none; border: none; color: var(--text-secondary); font-size: 24px; cursor: pointer; }
        .modal-footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 25px; }
        .traffic-bar { width: 100%; background-color: var(--bg-input); border-radius: 4px; height: 6px; overflow: hidden; margin-top: 4px; }
        .traffic-bar-inner { height: 100%; background-color: var(--accent); border-radius: 4px; transition: width 0.5s; }
        .form-check { display: flex; align-items: center; margin-top: 10px; }
        .form-check input { width: auto; margin-right: 8px; }
        .user-list-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        @media (max-width: 768px) {
            .container { padding: 0 10px; margin-top: 15px; }
            .stats-grid { grid-template-columns: 1fr 1fr; }
            table { min-width: 800px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="stats" class="stats-grid"></div>
        <div class="card">
            <h2>Create User</h2>
            <form id="createUserForm" class="form-grid">
                <input type="hidden" id="csrf_token" name="csrf_token" value="${csrfToken}">
                <div class="form-group" style="grid-column: 1 / -1;"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div>
                <div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div>
                <div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div>
                <div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" placeholder="e.g., 10"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div>
                <div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div>
                <div class="form-group" style="grid-column: 1 / -1; align-items: flex-start; margin-top: 10px;"><button type="submit" class="btn btn-primary">Create User</button></div>
            </form>
        </div>
        <div class="card" style="margin-top: 30px;">
            <h2>User List</h2>
            <div class="user-list-wrapper">
                 <table>
                    <thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead>
                    <tbody id="userList"></tbody>
                </table>
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
                <div class="form-group"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" placeholder="e.g., 10"><select id="editDataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div>
                <div class="form-group"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div>
                <div class="form-group form-check" style="grid-column: 1 / -1;"><input type="checkbox" id="resetTraffic"><label for="resetTraffic">Reset Traffic Usage</label></div>
                <div class="modal-footer" style="grid-column: 1 / -1;">
                    <button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button>
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const API_BASE = '/${adminPath}/api';
            const csrfToken = document.getElementById('csrf_token').value;
            const apiHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
            
            const api = {
                get: (endpoint) => fetch(\`\${API_BASE}\${endpoint}\`).then(handleResponse),
                post: (endpoint, body) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'POST', headers: apiHeaders, body: JSON.stringify(body) }).then(handleResponse),
                put: (endpoint, body) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'PUT', headers: apiHeaders, body: JSON.stringify(body) }).then(handleResponse),
                delete: (endpoint) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'DELETE', headers: apiHeaders }).then(handleResponse),
            };
            
            async function handleResponse(response) {
                if (response.status === 403) {
                    showToast('Session expired or invalid. Please refresh the page.', true);
                    throw new Error('Forbidden: Invalid session or CSRF token.');
                }
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: 'An unknown error occurred.' }));
                    throw new Error(errorData.error || \`Request failed with status \${response.status}\`);
                }
                return response.status === 204 ? null : response.json();
            }

            function showToast(message, isError = false) {
                const toast = document.getElementById('toast');
                toast.textContent = message;
                toast.style.backgroundColor = isError ? 'var(--danger)' : 'var(--success)';
                toast.classList.add('show');
                setTimeout(() => { toast.classList.remove('show'); }, 3000);
            }

            const pad = num => num.toString().padStart(2, '0');
            const localToUTC = (d, t) => {
                if (!d || !t) return { utcDate: '', utcTime: '' };
                const dt = new Date(\`\${d}T\${t}\`);
                return { utcDate: \`\${dt.getUTCFullYear()}-\${pad(dt.getUTCMonth() + 1)}-\${pad(dt.getUTCDate())}\`, utcTime: \`\${pad(dt.getUTCHours())}:\${pad(dt.getUTCMinutes())}:\${pad(dt.getUTCSeconds())}\` };
            };
            const utcToLocal = (d, t) => {
                if (!d || !t) return { localDate: '', localTime: '' };
                const dt = new Date(\`\${d}T\${t}Z\`);
                return { localDate: \`\${dt.getFullYear()}-\${pad(dt.getMonth() + 1)}-\${pad(dt.getDate())}\`, localTime: \`\${pad(dt.getHours())}:\${pad(dt.getMinutes())}:\${pad(dt.getSeconds())}\` };
            };
            
            function bytesToReadable(bytes) {
                if (bytes === 0) return '0 Bytes';
                const i = Math.floor(Math.log(bytes) / Math.log(1024));
                return \`\${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} \${['Bytes', 'KB', 'MB', 'GB', 'TB'][i]}\`;
            }

            function renderStats(stats) {
                const statsContainer = document.getElementById('stats');
                statsContainer.innerHTML = \`
                    <div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">\${stats.totalUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">\${stats.activeUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">\${stats.expiredUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Total Traffic Used</h3><p class="stat-value">\${bytesToReadable(stats.totalTraffic)}</p></div>
                \`;
            }
            
            function renderUsers(users) {
                const userList = document.getElementById('userList');
                userList.innerHTML = users.length === 0 ? '<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>' : users.map(user => {
                    const expiryUTC = new Date(\`\${user.expiration_date}T\${user.expiration_time}Z\`);
                    const isExpired = expiryUTC < new Date();
                    const trafficUsage = user.data_limit > 0 ? \`\${bytesToReadable(user.data_usage)} / \${bytesToReadable(user.data_limit)}\` : \`\${bytesToReadable(user.data_usage)} / &infin;\`;
                    const trafficPercent = user.data_limit > 0 ? Math.min(100, (user.data_usage / user.data_limit * 100)) : 0;
                    
                    return \`
                        <tr data-uuid="\${user.uuid}">
                            <td title="\${user.uuid}">\${user.uuid.substring(0, 8)}...</td>
                            <td>\${new Date(user.created_at).toLocaleString()}</td>
                            <td>\${expiryUTC.toLocaleString()}</td>
                            <td><span class="status-badge \${isExpired ? 'status-expired' : 'status-active'}">\${isExpired ? 'Expired' : 'Active'}</span></td>
                            <td>
                                \${trafficUsage}
                                <div class="traffic-bar"><div class="traffic-bar-inner" style="width: \${trafficPercent}%;"></div></div>
                            </td>
                            <td>\${user.notes || '-'}</td>
                            <td class="actions-cell">
                                <button class="btn btn-secondary btn-edit">Edit</button>
                                <button class="btn btn-danger btn-delete">Delete</button>
                            </td>
                        </tr>
                    \`;
                }).join('');
            }

            async function refreshData() {
                try {
                    const [stats, users] = await Promise.all([api.get('/stats'), api.get('/users')]);
                    window.allUsers = users; 
                    renderStats(stats);
                    renderUsers(users);
                } catch (error) { showToast(error.message, true); }
            }

            const getLimitInBytes = (valueId, unitId) => {
                const value = parseFloat(document.getElementById(valueId).value);
                const unit = document.getElementById(unitId).value;
                if (isNaN(value) || value <= 0) return 0; // 0 for unlimited
                const multiplier = unit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024;
                return Math.round(value * multiplier);
            };

            const setLimitFromBytes = (bytes, valueId, unitId) => {
                const valueEl = document.getElementById(valueId);
                const unitEl = document.getElementById(unitId);
                if (bytes <= 0) { valueEl.value = ''; unitEl.value = 'GB'; return; }
                const isGB = bytes >= 1024 * 1024 * 1024;
                const unit = isGB ? 'GB' : 'MB';
                const divisor = isGB ? 1024 * 1024 * 1024 : 1024 * 1024;
                valueEl.value = parseFloat((bytes / divisor).toFixed(2));
                unitEl.value = unit;
            };
            
            document.getElementById('createUserForm').addEventListener('submit', async e => {
                e.preventDefault();
                const { utcDate, utcTime } = localToUTC(document.getElementById('expiryDate').value, document.getElementById('expiryTime').value);
                const userData = {
                    uuid: document.getElementById('uuid').value,
                    exp_date: utcDate,
                    exp_time: utcTime,
                    data_limit: getLimitInBytes('dataLimitValue', 'dataLimitUnit'),
                    notes: document.getElementById('notes').value
                };
                try {
                    await api.post('/users', userData);
                    showToast('User created successfully!');
                    e.target.reset();
                    document.getElementById('uuid').value = crypto.randomUUID();
                    setDefaultExpiry();
                    refreshData();
                } catch (error) { showToast(error.message, true); }
            });
            
            const editModal = document.getElementById('editModal');
            document.getElementById('userList').addEventListener('click', e => {
                const button = e.target.closest('button');
                if (!button) return;
                const uuid = e.target.closest('tr').dataset.uuid;
                if (button.classList.contains('btn-edit')) {
                    const user = window.allUsers.find(u => u.uuid === uuid);
                    if (!user) return;
                    const { localDate, localTime } = utcToLocal(user.expiration_date, user.expiration_time);
                    document.getElementById('editUuid').value = user.uuid;
                    document.getElementById('editExpiryDate').value = localDate;
                    document.getElementById('editExpiryTime').value = localTime;
                    setLimitFromBytes(user.data_limit, 'editDataLimitValue', 'editDataLimitUnit');
                    document.getElementById('editNotes').value = user.notes || '';
                    document.getElementById('resetTraffic').checked = false;
                    editModal.classList.add('show');
                } else if (button.classList.contains('btn-delete')) {
                    if (confirm(\`Are you sure you want to delete user \${uuid.substring(0,8)}...?\`)) {
                        api.delete(\`/users/\${uuid}\`).then(() => {
                            showToast('User deleted successfully!');
                            refreshData();
                        }).catch(err => showToast(err.message, true));
                    }
                }
            });

            document.getElementById('editUserForm').addEventListener('submit', async e => {
                e.preventDefault();
                const uuid = document.getElementById('editUuid').value;
                const { utcDate, utcTime } = localToUTC(document.getElementById('editExpiryDate').value, document.getElementById('editExpiryTime').value);
                const updatedData = {
                    exp_date: utcDate,
                    exp_time: utcTime,
                    data_limit: getLimitInBytes('editDataLimitValue', 'editDataLimitUnit'),
                    notes: document.getElementById('editNotes').value,
                    reset_traffic: document.getElementById('resetTraffic').checked,
                };
                try {
                    await api.put(\`/users/\${uuid}\`, updatedData);
                    showToast('User updated successfully!');
                    editModal.classList.remove('show');
                    refreshData();
                } catch (error) { showToast(error.message, true); }
            });

            const closeModal = () => editModal.classList.remove('show');
            document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
            document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
            editModal.addEventListener('click', e => { if (e.target === editModal) closeModal(); });
            document.addEventListener('keydown', e => { if (e.key === "Escape") closeModal(); });

            document.getElementById('generateUUID').addEventListener('click', () => document.getElementById('uuid').value = crypto.randomUUID());
            document.getElementById('unlimitedBtn').addEventListener('click', () => { document.getElementById('dataLimitValue').value = ''; });
            document.getElementById('editUnlimitedBtn').addEventListener('click', () => { document.getElementById('editDataLimitValue').value = ''; });

            const setDefaultExpiry = () => {
                const now = new Date();
                now.setMonth(now.getMonth() + 1);
                document.getElementById('expiryDate').value = \`\${now.getFullYear()}-\${pad(now.getMonth() + 1)}-\${pad(now.getDate())}\`;
                document.getElementById('expiryTime').value = \`\${pad(now.getHours())}:\${pad(now.getMinutes())}:\${pad(now.getSeconds())}\`;
            };
            
            document.getElementById('uuid').value = crypto.randomUUID();
            setDefaultExpiry();
            refreshData();
        });
    </script>
</body>
</html>`;

async function checkAdminAuth(request, env, adminPath) {
    const cookieHeader = request.headers.get('Cookie');
    const sessionToken = cookieHeader?.match(/auth_token=([^;]+)/)?.[1];
    if (!sessionToken) {
        return { isAdmin: false, errorResponse: null, csrfToken: null };
    }
    const storedSession = await env.USER_KV.get(`admin_session:${sessionToken}`, 'json');
    if (!storedSession) {
        const headers = new Headers({ 'Set-Cookie': `auth_token=; Path=/${adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
        return { isAdmin: false, errorResponse: new Response(JSON.stringify({ error: 'Session expired' }), { status: 401, headers }), csrfToken: null };
    }
    const { csrfToken } = storedSession;
    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
        const requestCsrfToken = request.headers.get('X-CSRF-Token');
        if (!requestCsrfToken || requestCsrfToken !== csrfToken) {
            const errorResponse = new Response(JSON.stringify({ error: 'Invalid CSRF token.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
            return { isAdmin: false, errorResponse, csrfToken: null };
        }
    }
    return { isAdmin: true, errorResponse: null, csrfToken };
}

async function handleAdminRequest(request, env, adminPath) {
    const url = new URL(request.url);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured. Please set ADMIN_KEY secret.', { status: 503 });
    }

    if (pathname.startsWith(`/${adminPath}/api/`)) {
        const { isAdmin, errorResponse } = await checkAdminAuth(request, env, adminPath);
        if (errorResponse) return errorResponse;
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
        
        const apiPath = pathname.substring(`/${adminPath}/api`.length);
        
        if (apiPath === '/stats' && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT expiration_date, expiration_time, data_usage FROM users").all();
            const now = new Date();
            const stats = results.reduce((acc, u) => {
                acc.totalUsers++;
                const isExpired = new Date(`${u.expiration_date}T${u.expiration_time}Z`) <= now;
                isExpired ? acc.expiredUsers++ : acc.activeUsers++;
                acc.totalTraffic += (u.data_usage || 0);
                return acc;
            }, { totalUsers: 0, activeUsers: 0, expiredUsers: 0, totalTraffic: 0 });
            return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
        }
        
        if (apiPath === '/users' && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
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

    if (pathname === `/${adminPath}`) {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const sessionToken = crypto.randomUUID();
                const csrfToken = crypto.randomUUID();
                await env.USER_KV.put(`admin_session:${sessionToken}`, JSON.stringify({ csrfToken }), { expirationTtl: 86400 });
                const headers = new Headers({
                    'Location': `/${adminPath}`,
                    'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=/${adminPath}; Max-Age=86400; SameSite=Strict`
                });
                return new Response(null, { status: 302, headers });
            } else {
                return new Response(adminLoginHTML(adminPath).replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        if (request.method === 'GET') {
            const { isAdmin, csrfToken, errorResponse } = await checkAdminAuth(request, env, adminPath);
            if (errorResponse) return errorResponse;
            if (isAdmin) {
                return new Response(adminPanelHTML(adminPath, csrfToken), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            } else {
                return new Response(adminLoginHTML(adminPath), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
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
    const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');
    return {
      userID: env.UUID || this.userID,
      proxyAddress: selectedProxyIP,
    };
  },
};

const CONST = {
    ED_PARAMS: { ed: 2560 },
    WS_READY_STATE_OPEN: 1,
    WS_READY_STATE_CLOSING: 2,
};

function generateRandomPath(length = 12, query = '') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: { tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} } },
  sb:   { tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: CONST.ED_PARAMS } },
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

function buildLink({ core, userID, hostName, address, port, tag }) {
    const p = CORE_PRESETS[core]['tls'];
    return createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `${tag}-TLS` });
}

async function handleIpSubscription(core, userID, hostName) {
    const mainDomains = [ hostName, 'www.speedtest.net', 'www.visa.com', 'cdnjs.com' ];
    const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    let links = [];
    mainDomains.forEach((domain, i) => links.push(buildLink({ core, userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i+1}` })));
    try {
        const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
        if (r.ok) {
            const json = await r.json();
            const ips = [...(json.ipv4 || []), ...(json.ipv6 || [])].slice(0, 20).map(x => x.ip);
            ips.forEach((ip, i) => {
                const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
                links.push(buildLink({ core, userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i+1}` }));
            });
        }
    } catch (e) { console.error('Fetch IP list failed', e); }
    return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const adminPath = env.ADMIN_PATH || 'admin';

        if (url.pathname.startsWith(`/${adminPath}`)) {
            return handleAdminRequest(request, env, adminPath);
        }

        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
            return ProtocolOverWSHandler(request, env, ctx);
        }

        const handleSubscription = async (core) => {
            const uuid = url.pathname.slice(`/${core}/`.length);
            const userData = await getUserData(env, uuid);
            if (isUserInvalid(userData)) return new Response('Invalid or expired user', { status: 403 });
            return handleIpSubscription(core, uuid, url.hostname);
        };
        if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
        if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData) return new Response('User not found', { status: 404 });
            
            const cfg = Config.fromEnv(env);
            const userIP = request.headers.get('CF-Connecting-IP');
            const [userIPInfo, proxyIPInfo] = await Promise.all([
                getIPInfo(userIP),
                getProxyIPInfo(env, cfg.proxyAddress),
            ]);
            
            return handleConfigPage(path, url.hostname, userData, userIPInfo, proxyIPInfo);
        }

        return new Response('Not found.', { status: 404 });
    },
};


// --- VLESS Protocol Handler with Traffic Tracking ---

async function ProtocolOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let address = '';
    let portWithRandomLog = '';
    let sessionUsage = 0;
    let userUUID = '';

    const log = (info, event) => console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');

    const updateUsageInDB = async () => {
        if (sessionUsage > 0 && userUUID) {
            try {
                await env.DB.prepare("UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?")
                    .bind(Math.round(sessionUsage), userUUID).run();
                await env.USER_KV.delete(`user:${userUUID}`);
                log(`Updated usage for ${userUUID} by ${sessionUsage} bytes.`);
            } catch (err) { console.error(`Failed to update usage for ${userUUID}:`, err); }
            sessionUsage = 0;
        }
    };

    const createUsageCountingStream = () => new TransformStream({
        transform(chunk, controller) {
            sessionUsage += chunk.byteLength;
            controller.enqueue(chunk);
        }
    });
    const usageCounterDownstream = createUsageCountingStream();
    const usageCounterUpstream = createUsageCountingStream();

    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
    const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);
    let remoteSocketWapper = { value: null };

    readableWebSocketStream
        .pipeThrough(usageCounterDownstream)
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
                if (isUserInvalid(user)) { controller.error(new Error('User is invalid, expired, or has reached data limit.')); return; }

                address = addressRemote;
                portWithRandomLog = `${portRemote}--${Math.random()}`;
                const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                HandleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, usageCounterUpstream);
            },
            close() { log('readableWebSocketStream closed'); ctx.waitUntil(updateUsageInDB()); },
            abort(err) { log('readableWebSocketStream aborted', err); ctx.waitUntil(updateUsageInDB()); },
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
        case 3: addressLength = 16; addressValueIndex = portIndex + 3; const arr = new Uint16Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength).buffer); addressValue = Array.from(arr).map(x => x.toString(16).padStart(4, '0')).join(':'); break;
        default: return { hasError: true, message: `invalid addressType: ${addressType}` };
    }
    return { user, hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, ProtocolVersion: new Uint8Array([version]) };
}

async function HandleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, log, usageCounterUpstream) {
    try {
        const tcpSocket = connect({ hostname: addressRemote, port: portRemote });
        remoteSocket.value = tcpSocket;
        log(`connected to ${addressRemote}:${portRemote}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, log, usageCounterUpstream);
    } catch (error) {
        console.error(`Failed to connect to ${addressRemote}:${portRemote}:`, error);
        safeCloseWebSocket(webSocket);
    }
}

function MakeReadableWebSocketStream(ws, earlyDataHeader, log) {
    return new ReadableStream({
        start(controller) {
            ws.addEventListener('message', e => controller.enqueue(e.data));
            ws.addEventListener('close', () => { safeCloseWebSocket(ws); controller.close(); });
            ws.addEventListener('error', err => { log('WebSocket error'); controller.error(err); });
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel(reason) { log(`ReadableStream canceled: ${reason}`); safeCloseWebSocket(ws); },
    });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, log, usageCounterUpstream) {
    try {
        await remoteSocket.readable
            .pipeThrough(usageCounterUpstream)
            .pipeTo(new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN) return;
                    const dataToSend = protocolResponseHeader ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer() : chunk;
                    webSocket.send(dataToSend);
                    protocolResponseHeader = null;
                },
                close() { log('Remote connection readable closed.'); },
                abort(reason) { console.error('Remote connection readable aborted:', reason); },
            }));
    } catch (error) {
        console.error('RemoteSocketToWS error:', error.stack || error);
        safeCloseWebSocket(webSocket);
    }
}

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
    try {
        if (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) { console.error('safeCloseWebSocket error:', error); }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr) {
    return (byteToHex[arr[0]] + byteToHex[arr[1]] + byteToHex[arr[2]] + byteToHex[arr[3]] + '-' + byteToHex[arr[4]] + byteToHex[arr[5]] + '-' + byteToHex[arr[6]] + byteToHex[arr[7]] + '-' + byteToHex[arr[8]] + byteToHex[arr[9]] + '-' + byteToHex[arr[10]] + byteToHex[arr[11]] + byteToHex[arr[12]] + byteToHex[arr[13]] + byteToHex[arr[14]] + byteToHex[arr[15]]).toLowerCase();
}


// --- Smart Subscription Page Generation ---

function handleConfigPage(userID, hostName, userData, userIPInfo, proxyIPInfo) {
    const html = generateBeautifulConfigPage(userID, hostName, userData, userIPInfo, proxyIPInfo);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, userData, userIPInfo, proxyIPInfo) {
    const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
    const subXrayUrl = `https://${hostName}/xray/${userID}`;
    const subSbUrl = `https://${hostName}/sb/${userID}`;
    const clientUrls = {
        universal: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
        shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
        stash: `stash://install-config?url=${encodeURIComponent(subXrayUrl)}`,
        clashMeta: `clash://install-config?url=${encodeURIComponent(subSbUrl)}`,
    };
    const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;
    const renderNetworkCard = (title, ipInfo, isProxy = false) => {
        const host = isProxy ? (ipInfo?.host || 'N/A') : 'N/A';
        const ip = ipInfo?.ip || 'N/A';
        const location = ipInfo?.location || 'N/A';
        const isp = ipInfo?.isp || 'N/A';
        const risk = ipInfo?.risk || 'N/A';
        return `
            <div class="network-card">
                <div class="ip-info-header"><h3>${title}</h3></div>
                <div class="ip-info-content">
                    ${isProxy ? `<div class="ip-info-item"><span class="label">Proxy Host</span><span class="value">${host}</span></div>` : ''}
                    <div class="ip-info-item"><span class="label">IP Address</span><span class="value">${ip}</span></div>
                    <div class="ip-info-item"><span class="label">Location</span><span class="value">${location}</span></div>
                    <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value">${isp}</span></div>
                    ${!isProxy ? `<div class="ip-info-item"><span class="label">Risk Score</span><span class="value">${risk}</span></div>` : ''}
                </div>
            </div>`;
    };
    const networkInfoBlock = `
        <div class="config-card">
            <div class="config-title"><span>Network Information</span><button class="button" onclick="location.reload()">Refresh</button></div>
            <div class="ip-info-grid">
                ${renderNetworkCard('Proxy Server', proxyIPInfo, true)}
                ${renderNetworkCard('Your Connection', userIPInfo, false)}
            </div>
        </div>`;
    const expirationBlock = `<div class="info-card rainbow-border"><div class="info-card-content"><h2 class="info-title">Expiration Date</h2><div id="expiration-relative" class="info-relative-time">--</div><div id="expiration-display" data-utc-time="${utcTimestamp}" class="info-time-grid"></div></div></div>`;
    const dataUsageBlock = `<div class="info-card"><div class="info-card-content"><h2 class="info-title">Data Usage</h2><div class="data-usage-text" id="data-usage-display" data-usage="${data_usage}" data-limit="${data_limit}">...</div><div class="traffic-bar-container"><div id="traffic-bar-inner" class="traffic-bar"></div></div></div></div>`;
    
    return `<!doctype html>
    <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>VLESS Configuration</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>${getPageCSS()}</style></head>
    <body><div class="container">
        <div class="header"><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></div>
        <div class="top-grid">${expirationBlock}${dataUsageBlock}</div>
        ${networkInfoBlock}
        <div class="config-card"><div class="config-title"><span>Xray Subscription</span><button class="button" onclick="copyToClipboard(this, '${subXrayUrl}')">Copy Link</button></div><div class="client-buttons"><a href="${clientUrls.universal}" class="client-btn">Universal Import (V2rayNG, etc.)</a><a href="${clientUrls.shadowrocket}" class="client-btn">Import to Shadowrocket</a><a href="${clientUrls.stash}" class="client-btn">Import to Stash (VLESS)</a><button class="client-btn" onclick="toggleQR('xray', '${subXrayUrl}')">Show QR Code</button></div><div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div></div>
        <div class="config-card"><div class="config-title"><span>Sing-Box / Clash Subscription</span><button class="button" onclick="copyToClipboard(this, '${subSbUrl}')">Copy Link</button></div><div class="client-buttons"><a href="${clientUrls.clashMeta}" class="client-btn">Import to Clash Meta / Stash</a><button class="client-btn" onclick="toggleQR('singbox', '${subSbUrl}')">Show QR Code</button></div><div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div></div>
    </div><script>${getPageScript()}</script></body></html>`;
}

function getPageCSS() { return `:root{--bg-main:#111827;--bg-card:#1F2937;--bg-inner:#374151;--border:#4B5563;--text-primary:#F9FAFB;--text-secondary:#9CA3AF;--accent:#818CF8;--accent-hover:#6366F1;--status-active:#34D399;--status-expired:#F87171}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);padding:20px}.container{max-width:800px;margin:auto}.header{text-align:center;margin-bottom:24px}.header h1{font-size:2em;margin-bottom:8px}.header p{color:var(--text-secondary)}.top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;margin-bottom:20px}.info-card{background:var(--bg-card);border-radius:12px;position:relative;overflow:hidden;border:1px solid var(--border)}.info-card.rainbow-border::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(from 180deg at 50% 50%,#F87171,#6366F1,#34D399,#F87171);animation:spin 4s linear infinite;z-index:1}.info-card-content{background:var(--bg-card);padding:20px;border-radius:10px;position:relative;z-index:2;margin:2px}.info-title{font-size:1.25em;text-align:center;margin:0 0 16px;font-weight:500}.info-relative-time{text-align:center;font-size:1.4em;font-weight:600;margin-bottom:16px}.status-active-text{color:var(--status-active)}.status-expired-text{color:var(--status-expired)}.info-time-grid{display:grid;gap:8px;font-size:.9em;color:var(--text-secondary)}.data-usage-text{font-size:1.4em;font-weight:600;text-align:center;color:var(--text-primary);margin-bottom:16px}.traffic-bar-container{height:8px;background-color:var(--bg-inner);border-radius:4px;overflow:hidden}.traffic-bar{height:100%;background:linear-gradient(90deg,var(--accent) 0%,var(--status-active) 100%);border-radius:4px;transition:width .5s ease-out}.config-card{background:var(--bg-card);border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid var(--border)}.config-title{display:flex;justify-content:space-between;align-items:center;font-size:1.4rem;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}.button,.client-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;border:1px solid var(--border);background-color:var(--bg-inner);color:var(--text-primary);text-decoration:none;transition:all .2s}.button:hover{background-color:#4B5563}.client-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.client-btn{width:100%;box-sizing:border-box;background-color:var(--accent);color:white;border:none}.client-btn:hover{background-color:var(--accent-hover)}.qr-container{display:none;margin-top:20px;background:white;padding:16px;border-radius:8px;max-width:288px;margin-left:auto;margin-right:auto}.ip-info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}.ip-info-header{border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:12px}.ip-info-header h3{margin:0;font-size:1.1em}.ip-info-item{display:flex;justify-content:space-between;font-size:.9em;padding:4px 0}.ip-info-item .label{color:var(--text-secondary)}.ip-info-item .value{color:var(--text-primary);font-weight:500;text-align:right}@keyframes spin{100%{transform:rotate(360deg)}}@media (max-width:768px){body{padding:10px}.top-grid{grid-template-columns:1fr}}`; }

function getPageScript() { return `function copyToClipboard(btn,text){const o=btn.textContent;navigator.clipboard.writeText(text).then(()=>{btn.textContent='Copied!';setTimeout(()=>{btn.textContent=o},1500)})}function toggleQR(id,url){const c=document.getElementById('qr-'+id+'-container'),q=document.getElementById('qr-'+id);if(c.style.display==='none'||c.style.display===''){c.style.display='block';if(!q.hasChildNodes()){new QRCode(q,{text:url,width:256,height:256})}}else{c.style.display='none'}}function displayExpirationTimes(){const e=document.getElementById('expiration-display'),r=document.getElementById('expiration-relative');if(!e?.dataset.utcTime)return;const t=new Date(e.dataset.utcTime);if(isNaN(t.getTime()))return;const n=(t.getTime()-new Date().getTime())/1000,i=n<0;if(i){r.textContent="Subscription Expired";r.className="info-relative-time status-expired-text"}else{const o=new Intl.RelativeTimeFormat('en',{numeric:'auto'});let a;if(Math.abs(n)<3600)a=o.format(Math.round(n/60),'minute');else if(Math.abs(n)<86400)a=o.format(Math.round(n/3600),'hour');else a=o.format(Math.round(n/86400),'day');r.textContent=\`Expires \${a}\`;r.className="info-relative-time status-active-text"}e.innerHTML=\`<div><strong>Your Local Time:</strong> <span>\${t.toLocaleString()}</span></div><div><strong>Tehran Time:</strong> <span>\${t.toLocaleString("en-US",{timeZone:"Asia/Tehran",hour12:!0,year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</span></div><div><strong>Universal Time:</strong> <span>\${t.toISOString().substring(0,19).replace("T"," ")} UTC</span></div>\`}function displayDataUsage(){const t=document.getElementById("data-usage-display"),e=parseInt(t.dataset.usage,10),a=parseInt(t.dataset.limit,10);const n=t=>{if(t<=0)return"0 Bytes";const e=Math.floor(Math.log(t)/Math.log(1024));return\`\${parseFloat((t/Math.pow(1024,e)).toFixed(2))} \${["Bytes","KB","MB","GB","TB"][e]}\`};const i=a>0?n(a):"&infin;";t.innerHTML=\`\${n(e)} / \${i}\`;const d=document.getElementById("traffic-bar-inner");if(d){const s=a>0?Math.min(100,e/a*100):0;d.style.width=\`\${s}%\`}}document.addEventListener('DOMContentLoaded',()=>{displayExpirationTimes();displayDataUsage();setInterval(displayExpirationTimes,6e4)});`; }
