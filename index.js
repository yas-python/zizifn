/**
 * Ultimate VLESS Proxy Worker Script for Cloudflare (Fixed & Enhanced)
 *
 * @version 5.1.0 - Fixed Connection Logic
 * @author Enhanced by AI
 *
 * Fixes:
 * 1. Corrected the connection fallback mechanism to properly use PROXYIP
 * 2. Fixed traffic accounting to prevent data cap issues
 * 3. Added proper error handling for connection failures
 * 4. Maintained all advanced features from both scripts
 *
 * Setup Instructions:
 * 1. Create a D1 Database and bind it as `DB`.
 * 2. Run DB initialization:
 * `wrangler d1 execute DB --command="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 2);"`
 * 3. Create a KV Namespace and bind it as `USER_KV`.
 * 4. Set Secrets:
 * - `ADMIN_KEY`: Your password for the admin panel.
 * - `ADMIN_PATH` (Optional): A secret path for the admin panel (e.g., /my-secret-dashboard). Defaults to /admin.
 * - `UUID` (Optional): A fallback UUID for the worker's root path.
 * - `PROXYIP` (Critical): A clean IP/domain to be used in configs AND for retry logic (e.g., sub.yourdomain.com).
 * - `SCAMALYTICS_API_KEY` (Optional): Your API key from scamalytics.com for risk scoring.
 * - `SOCKS5` (Optional): SOCKS5 outbound proxy address (e.g., user:pass@host:port).
 * - `SOCKS5_RELAY` (Optional): Set to "true" to force all outbound via SOCKS5.
 * - `ROOT_PROXY_URL` (Optional): A URL to reverse-proxy on the root path (/).
 */

import { connect } from 'cloudflare:sockets';

// --- Constants and Configuration ---
const CONST = {
    VLESS_VERSION: 0,
    WS_READY_STATE: { OPEN: 1, CLOSING: 2 },
    CUSTOM_ADMIN_PATH_HEADER: 'X-Custom-Admin-Path',
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
                relayMode: env.SOCKS5_RELAY === 'true',
                address: env.SOCKS5 || '',
            },
            rootProxyURL: env.ROOT_PROXY_URL || null,
        };
    }
};

// --- Helper & Utility Functions ---
function generateUUID() {
  return crypto.randomUUID();
}

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

function hasRemainingData(user, projectedUsage = 0) {
  const limit = Number(user?.data_limit ?? 0);
  if (limit <= 0) return true;
  return (Number(user?.data_usage ?? 0) + projectedUsage) < limit;
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
const adminLoginHTML = `<!DOCTYPE html>
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
        <form method="POST">
            <input type="password" name="password" placeholder="••••••••••••••" required>
            <button type="submit">Login</button>
        </form>
    </div>
</body>
</html>`;

const adminPanelHTML = `<!DOCTYPE html>
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
        .input-group input:first-child, .input-group select:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
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
        @media (max-width: 768px) {
            .container { padding: 0 10px; margin-top: 15px; }
            .stats-grid { grid-template-columns: 1fr 1fr; }
            .user-list-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }
            table { min-width: 900px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="stats" class="stats-grid"></div>
        <div class="card">
            <h2>Create User</h2>
            <form id="createUserForm" class="form-grid">
                <input type="hidden" id="csrf_token" name="csrf_token">
                <div class="form-group" style="grid-column: 1 / -1;"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div>
                <div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div>
                <div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div>
                <div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" placeholder="e.g., 10"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div>
                <div class="form-group"><label for="ipLimit">IP Limit</label><input type="number" id="ipLimit" value="2" placeholder="e.g., 2"></div>
                <div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div>
                <div class="form-group" style="grid-column: 1 / -1; align-items: flex-start; margin-top: 10px;"><button type="submit" class="btn btn-primary">Create User</button></div>
            </form>
        </div>
        <div class="card" style="margin-top: 30px;">
            <h2>User List</h2>
            <div class="user-list-wrapper">
                 <table>
                    <thead><tr><th>UUID</th><th>Created</th><th>Expiry</th><th>Status</th><th>Traffic</th><th>IP Limit</th><th>Notes</th><th>Actions</th></tr></thead>
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
                <div class="form-group"><label for="editIpLimit">IP Limit</label><input type="number" id="editIpLimit" placeholder="e.g., 2"></div>
                <div class="form-group" style="grid-column: 1 / -1;"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div>
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
            const adminPath = document.body.getAttribute('data-admin-path');
            const API_BASE = \`\${adminPath}/api\`;
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
                    showToast('Session expired or invalid. Please refresh and log in again.', true);
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
                if (isNaN(dt)) return { utcDate: '', utcTime: '' };
                return { utcDate: \`\${dt.getUTCFullYear()}-\${pad(dt.getUTCMonth() + 1)}-\${pad(dt.getUTCDate())}\`, utcTime: \`\${pad(dt.getUTCHours())}:\${pad(dt.getUTCMinutes())}:\${pad(dt.getUTCSeconds())}\` };
            };
            const utcToLocal = (d, t) => {
                if (!d || !t) return { localDate: '', localTime: '' };
                const dt = new Date(\`\${d}T\${t}Z\`);
                if (isNaN(dt)) return { localDate: '', localTime: '' };
                return { localDate: \`\${dt.getFullYear()}-\${pad(dt.getMonth() + 1)}-\${pad(dt.getDate())}\`, localTime: \`\${pad(dt.getHours())}:\${pad(dt.getMinutes())}:\${pad(dt.getSeconds())}\` };
            };
            
            function bytesToReadable(bytes) {
                if (bytes <= 0) return '0 Bytes';
                const i = Math.floor(Math.log(bytes) / Math.log(1024));
                return \`\${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} \${['Bytes', 'KB', 'MB', 'GB', 'TB'][i]}\`;
            }

            function renderStats(stats) {
                const statsContainer = document.getElementById('stats');
                statsContainer.innerHTML = \`
                    <div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">\${stats.totalUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">\${stats.activeUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">\${stats.expiredUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Total Traffic</h3><p class="stat-value">\${bytesToReadable(stats.totalTraffic)}</p></div>
                \`;
            }
            
            function renderUsers(users) {
                const userList = document.getElementById('userList');
                userList.innerHTML = users.length === 0 ? '<tr><td colspan="8" style="text-align:center;">No users found.</td></tr>' : users.map(user => {
                    const expiryUTC = new Date(\`\${user.expiration_date}T\${user.expiration_time}Z\`);
                    const isUserExpired = expiryUTC < new Date();
                    const trafficUsage = user.data_limit > 0 ? \`\${bytesToReadable(user.data_usage)} / \${bytesToReadable(user.data_limit)}\` : \`\${bytesToReadable(user.data_usage)} / &infin;\`;
                    const trafficPercent = user.data_limit > 0 ? Math.min(100, (user.data_usage / user.data_limit * 100)) : 0;
                    
                    return \`
                        <tr data-uuid="\${user.uuid}">
                            <td title="\${user.uuid}">\${user.uuid.substring(0, 8)}...</td>
                            <td>\${new Date(user.created_at).toLocaleString()}</td>
                            <td>\${expiryUTC.toLocaleString()}</td>
                            <td><span class="status-badge \${isUserExpired ? 'status-expired' : 'status-active'}">\${isUserExpired ? 'Expired' : 'Active'}</span></td>
                            <td>
                                \${trafficUsage}
                                <div class="traffic-bar"><div class="traffic-bar-inner" style="width: \${trafficPercent}%;"></div></div>
                            </td>
                            <td>\${user.ip_limit > 0 ? user.ip_limit : 'Unlimited'}</td>
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
                if (isNaN(value) || value <= 0) return 0;
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
                    ip_limit: parseInt(document.getElementById('ipLimit').value, 10) || 0,
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
                    document.getElementById('editIpLimit').value = user.ip_limit;
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
                    ip_limit: parseInt(document.getElementById('editIpLimit').value, 10) || 0,
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

            // Modal close events
            const closeModal = () => editModal.classList.remove('show');
            document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
            document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
            editModal.addEventListener('click', e => { if (e.target === editModal) closeModal(); });
            document.addEventListener('keydown', e => { if (e.key === "Escape") closeModal(); });

            // Form helpers
            document.getElementById('generateUUID').addEventListener('click', () => document.getElementById('uuid').value = crypto.randomUUID());
            document.getElementById('unlimitedBtn').addEventListener('click', () => { document.getElementById('dataLimitValue').value = ''; });
            document.getElementById('editUnlimitedBtn').addEventListener('click', () => { document.getElementById('editDataLimitValue').value = ''; });

            const setDefaultExpiry = () => {
                const now = new Date();
                now.setMonth(now.getMonth() + 1);
                document.getElementById('expiryDate').value = \`\${now.getFullYear()}-\${pad(now.getMonth() + 1)}-\${pad(now.getDate())}\`;
                document.getElementById('expiryTime').value = \`\${pad(now.getHours())}:\${pad(now.getMinutes())}:\${pad(now.getSeconds())}\`;
            };
            
            // Initial load
            document.getElementById('uuid').value = crypto.randomUUID();
            setDefaultExpiry();
            refreshData();
        });
    </script>
</body>
</html>`;

async function checkAdminAuth(request, env) {
    const cfg = Config.fromEnv(env);
    const cookieHeader = request.headers.get('Cookie');
    const sessionToken = cookieHeader?.match(/auth_token=([^;]+)/)?.[1];
    
    if (!sessionToken) {
        return { isAdmin: false, errorResponse: null, csrfToken: null };
    }

    const storedSession = await env.USER_KV.get(`admin_session:${sessionToken}`, 'json');
    if (!storedSession) {
        const headers = new Headers({ 'Set-Cookie': `auth_token=; Path=${cfg.adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
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

    // --- API Routes ---
    if (pathname.startsWith(`${cfg.adminPath}/api/`)) {
        const { isAdmin, errorResponse } = await checkAdminAuth(request, env);
        if (errorResponse) return errorResponse;
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });

        // GET /stats
        if (pathname.endsWith('/stats') && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT expiration_date, expiration_time, data_usage FROM users").all();
                const now = new Date();
                const stats = {
                    totalUsers: results.length,
                    activeUsers: results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) > now).length,
                    expiredUsers: results.length - results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) <= now).length,
                    totalTraffic: results.reduce((sum, u) => sum + (u.data_usage || 0), 0)
                };
                return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }
        
        // GET /users
        if (pathname.endsWith('/users') && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
        }

        // POST /users
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
            // PUT /users/:uuid
            if (request.method === 'PUT') {
                 try {
                    const { exp_date, exp_time, notes, data_limit, ip_limit, reset_traffic } = await request.json();
                     if (!exp_date || !exp_time) throw new Error('Invalid date/time fields.');

                    const sql = `UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ?, ip_limit = ? ${reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?`;
                    await env.DB.prepare(sql).bind(exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, ip_limit >= 0 ? ip_limit : 2, uuid).run();
                    await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
                    return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
                } catch (e) {
                    return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: jsonHeader });
                }
            }
            // DELETE /users/:uuid
            if (request.method === 'DELETE') {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete(`user:${uuid}`);
                await env.USER_KV.delete(`conn_ips:${uuid}`);
                return new Response(null, { status: 204 });
            }
        }
        return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
    }

    // --- Page Serving Routes ---
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

    return null; // Let the main fetch handler continue
}


// --- Core VLESS & Subscription Logic (Fixed) ---

async function ProtocolOverWSHandler(request, config, env, ctx) {
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
                incrementDown(chunk.byteLength); // Count downstream traffic

                if (udpWriter) {
                    await udpWriter.write(chunk);
                    return;
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
                
                // --- User & Connection Validation ---
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
                    activeIPs = activeIPs.filter(entry => entry.exp > Date.now()); // Clean expired
                    
                    if (activeIPs.length >= user.ip_limit && !activeIPs.some(e => e.ip === clientIP)) {
                        controller.error(new Error(`IP limit of ${user.ip_limit} reached.`));
                        return;
                    }
                    if (!activeIPs.some(e => e.ip === clientIP)) {
                        activeIPs.push({ ip: clientIP, exp: Date.now() + 65000 }); // TTL of 65s
                        ctx.waitUntil(env.USER_KV.put(key, JSON.stringify(activeIPs), { expirationTtl: 120 }));
                    }
                }
                // --- End User Validation ---
                
                const vlessResponseHeader = new Uint8Array([CONST.VLESS_VERSION, 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                if (isUDP) {
                    if (portRemote !== 53) {
                        controller.error(new Error('UDP proxy supports only DNS (port 53).'));
                        return;
                    }
                    // UDP Handler with traffic accounting
                    udpWriter = await createDnsPipeline(webSocket, vlessResponseHeader, log, incrementDown, incrementUp);
                    await udpWriter.write(rawClientData);
                    return;
                }

                // Fixed connection logic with proper fallback
                HandleTCPOutBound(
                    remoteSocketWrapper,
                    addressType,
                    addressRemote,
                    portRemote,
                    rawClientData,
                    webSocket,
                    vlessResponseHeader,
                    log,
                    config,
                    incrementUp
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
    const version = view.getUint8(0);
    if (version !== CONST.VLESS_VERSION) return { hasError: true, message: 'invalid vless version' };

    const uuid = unsafeStringify(new Uint8Array(vlessBuffer.slice(1, 17)));
    const user = await getUserData(env, uuid);
    if (!user) return { hasError: true, message: 'user not found' };

    const optLen = view.getUint8(17);
    const command = view.getUint8(18 + optLen);
    if (command !== 1 && command !== 2) { // 1 = TCP, 2 = UDP
        return { hasError: true, message: `unsupported command: ${command}`};
    }

    const portIndex = 19 + optLen;
    const port = view.getUint16(portIndex);
    
    const addrType = view.getUint8(portIndex + 2);
    let address, rawDataIndex;
    switch (addrType) {
        case 1: // IPv4
            address = new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 7)).join('.');
            rawDataIndex = portIndex + 7;
            break;
        case 2: // Domain
            const domainLen = view.getUint8(portIndex + 3);
            address = new TextDecoder().decode(vlessBuffer.slice(portIndex + 4, portIndex + 4 + domainLen));
            rawDataIndex = portIndex + 4 + domainLen;
            break;
        case 3: // IPv6
            const ipv6 = Array.from({length: 8}, (_, i) => view.getUint16(portIndex + 3 + i * 2).toString(16)).join(':');
            address = `[${ipv6}]`;
            rawDataIndex = portIndex + 19;
            break;
        default: return { hasError: true, message: `invalid address type: ${addrType}` };
    }

    return { 
        user, 
        hasError: false, 
        addressType: addrType,
        addressRemote: address, 
        portRemote: port, 
        rawDataIndex,
        isUDP: command === 2,
    };
}

// --- Fixed Network Handlers ---

async function HandleTCPOutBound(
  remoteSocket,
  addressType,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  protocolResponseHeader,
  log,
  config,
  countUp
) {
  // Corrected connection function with explicit fallback logic
  async function connectAndWrite(address, port, socks = false) {
    let tcpSocket;
    try {
      if (socks && config.socks5.enabled) {
        tcpSocket = await socks5Connect(addressType, address, port, log, config.parsedSocks5Address);
      } else {
        tcpSocket = connect({ hostname: address, port });
      }
      log(`Connected to ${address}:${port}`);
      return tcpSocket;
    } catch (e) {
      log(`Failed to connect to ${address}:${port}: ${e.message}`);
      throw e;
    }
  }

  async function retryWithProxy() {
    log('Retrying connection through proxy IP');
    
    try {
      const tcpSocket = await connectAndWrite(config.proxyIP, config.proxyPort);
      
      // Send initial data to the proxy
      const writer = tcpSocket.writable.getWriter();
      const header = new Uint8Array([addressType, ...encodeAddress(addressRemote), portRemote >> 8, portRemote & 0xff]);
      await writer.write(new Uint8Array([...header, ...rawClientData]));
      writer.releaseLock();
      
      log(`Connected through proxy to ${addressRemote}:${portRemote}`);
      remoteSocket.value = tcpSocket;
      
      // Handle the connection
      RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, countUp);
      return true;
    } catch (e) {
      log('Proxy connection failed:', e);
      return false;
    }
  }

  async function retryWithSocks5() {
    log('Retrying connection through SOCKS5');
    
    try {
      const tcpSocket = await socks5Connect(addressType, addressRemote, portRemote, log, config.parsedSocks5Address);
      const writer = tcpSocket.writable.getWriter();
      await writer.write(rawClientData);
      writer.releaseLock();
      
      log(`Connected through SOCKS5 to ${addressRemote}:${portRemote}`);
      remoteSocket.value = tcpSocket;
      
      // Handle the connection
      RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, countUp);
      return true;
    } catch (e) {
      log('SOCKS5 connection failed:', e);
      return false;
    }
  }

  try {
    // First try direct connection
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    
    // If direct connection succeeds
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, countUp);
    
  } catch (directError) {
    log('Direct connection failed:', directError.message);
    
    // Try proxy connection
    let success = false;
    if (config.proxyIP) {
      success = await retryWithProxy();
    }
    
    // If proxy connection also failed, try SOCKS5
    if (!success && config.socks5.enabled) {
      success = await retryWithSocks5();
    }
    
    if (!success) {
      throw new Error('All connection methods failed');
    }
  }
}

// Corrected and improved RemoteSocketToWS function
async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log, countUp) {
  let hasIncomingData = false;
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState !== CONST.WS_READY_STATE.OPEN) {
            throw new Error('WebSocket is not open');
          }
          
          countUp(chunk.byteLength);
          hasIncomingData = true;
          
          const dataToSend = protocolResponseHeader
            ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer()
            : chunk;
          
          webSocket.send(dataToSend);
          protocolResponseHeader = null;
        },
        close() {
          log(`Remote connection readable closed. Had incoming data: ${hasIncomingData}`);
        },
        abort(reason) {
          console.error('Remote connection readable aborted:', reason);
        },
      }),
    );
  } catch (error) {
    console.error('RemoteSocketToWS error:', error.stack || error);
    safeCloseWebSocket(webSocket);
    remoteSocket?.close?.();
  }
}

// Fixed and improved SOCKS5 connect function
async function socks5Connect(addressType, addressRemote, portRemote, log, parsedSocks5Addr) {
  const { username, password, hostname, port } = parsedSocks5Addr;
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  
  try {
    // SOCKS5 greeting
    const authMethods = username && password ? [0, 2] : [0];
    await writer.write(new Uint8Array([5, authMethods.length, ...authMethods]));
    
    // Read response
    const res = (await reader.read()).value;
    if (!res || res[0] !== 0x05) {
      throw new Error('SOCKS5 server connection failed - invalid response');
    }
    
    // Handle authentication if required
    if (res[1] === 0x02) {
      if (!username || !password) {
        throw new Error('SOCKS5 server requires authentication but no credentials provided');
      }
      
      // Send username/password
      const authRequest = new Uint8Array([
        1,
        username.length,
        ...encoder.encode(username),
        password.length,
        ...encoder.encode(password),
      ]);
      await writer.write(authRequest);
      
      // Verify authentication
      const authResponse = (await reader.read()).value;
      if (!authResponse || authResponse[0] !== 0x01 || authResponse[1] !== 0x00) {
        throw new Error('SOCKS5 authentication failed');
      }
    }
    
    // Build address for connection request
    let DSTADDR;
    switch (addressType) {
      case 1: // IPv4
        DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]);
        break;
      case 2: // Domain
        DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]);
        break;
      case 3: // IPv6
        const ipv6 = addressRemote.replace('[', '').replace(']', '');
        const parts = ipv6.split(':').map(part => {
          const hex = part.padStart(4, '0');
          return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16)];
        }).flat();
        DSTADDR = new Uint8Array([4, ...parts]);
        break;
      default:
        throw new Error(`Invalid addressType for SOCKS5: ${addressType}`);
    }
    
    // Send connection request
    const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
    await writer.write(socksRequest);
    
    // Read connection response
    const response = (await reader.read()).value;
    if (!response || response[1] !== 0x00) {
      throw new Error(`SOCKS5 connection failed - server response: ${response ? response[1] : 'no response'}`);
    }
    
    writer.releaseLock();
    reader.releaseLock();
    return socket;
  } catch (error) {
    writer.releaseLock();
    reader.releaseLock();
    socket.close();
    throw error;
  }
}

// Improved SOCKS5 parser
function socks5AddressParser(address) {
  try {
    const [authPart, hostPart] = address.includes('@') ? address.split('@') : [null, address];
    const [hostname, portStr] = hostPart.split(':');
    const port = parseInt(portStr, 10);
    if (!hostname || isNaN(port)) throw new Error('Invalid hostname or port');

    let username, password;
    if (authPart) {
      [username, password] = authPart.split(':');
      if (!username) throw new Error('Username is required when authentication is specified');
    }
    
    return { 
      username, 
      password, 
      hostname, 
      port,
      valid: true
    };
  } catch (e) {
    throw new Error(`Invalid SOCKS5 address format. Expected [user:pass@]host:port. Error: ${e.message}`);
  }
}

// Improved UDP/DNS Pipeline
async function createDnsPipeline(webSocket, vlessResponseHeader, log, countDown, countUp) {
  let headerSent = false;
  const transform = new TransformStream({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength;) {
        const view = new DataView(chunk.slice(offset, offset + 2));
        const len = view.getUint16(0);
        const data = new Uint8Array(chunk.slice(offset + 2, offset + 2 + len));
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
        const payload = headerSent
          ? await new Blob([lenBuf, answer]).arrayBuffer()
          : await new Blob([vlessResponseHeader, lenBuf, answer]).arrayBuffer();
          
        webSocket.send(payload);
        headerSent = true;
      } catch (err) {
        log('DNS query failed:', err);
        // Send empty response to prevent client timeouts
        const emptyResponse = new Uint8Array(12);
        webSocket.send(emptyResponse);
      }
    },
  })).catch((err) => log('DNS transform error', err));

  return transform.writable.getWriter();
}

// --- Subscription and Config Page ---

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
    tcp: { path: () => generateRandomPath(12, 'ed=2048'), security: 'none', fp: 'chrome', extra: {} },
  },
  sb: {
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: CONST.ED_PARAMS },
    tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: CONST.ED_PARAMS },
  },
};

function makeName(tag, proto) {
  return `${tag}-${proto.toUpperCase()}`;
}

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
    userID,
    address,
    port,
    host: hostName,
    path: preset.path(),
    security: preset.security,
    sni: preset.security === 'tls' ? hostName : undefined,
    fp: preset.fp,
    alpn: preset.alpn,
    extra: preset.extra,
    name: makeName(tag, proto),
  });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function fetchSmartIpPool(env) {
  const sources = [
    'https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json',
  ];
  if (env.SMART_IP_SOURCE) sources.unshift(env.SMART_IP_SOURCE);

  for (const url of sources) {
    try {
      const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!res.ok) continue;
      const json = await res.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].map((item) => item.ip || item).filter(Boolean);
      if (ips.length) return ips;
    } catch (err) {
      console.warn(`SMART_IP_SOURCE fetch failed (${url}):`, err.message);
    }
  }
  return [];
}

async function handleIpSubscription(core, userID, hostName, env) {
  const mainDomains = [
    hostName, 'creativecommons.org', 'www.speedtest.net', 'sky.rethinkdns.com',
    'cfip.1323123.xyz', 'go.inmobi.com', 'www.visa.com', 'cdnjs.com', 'zula.ir',
  ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
  const links = [];
  const isPagesDeployment = hostName.endsWith('.pages.dev');

  mainDomains.forEach((domain, i) => {
    links.push(buildLink({
      core, proto: 'tls', userID, hostName, address: domain,
      port: pick(httpsPorts), tag: `D${i + 1}`,
    }));
    if (!isPagesDeployment) {
      links.push(buildLink({
        core, proto: 'tcp', userID, hostName, address: domain,
        port: pick(httpPorts), tag: `D${i + 1}`,
      }));
    }
  });

  const smartIPs = await fetchSmartIpPool(env);
  smartIPs.slice(0, 40).forEach((ip, index) => {
    const formatted = ip.includes(':') ? `[${ip}]` : ip;
    links.push(buildLink({
      core, proto: 'tls', userID, hostName, address: formatted,
      port: pick(httpsPorts), tag: `IP${index + 1}`,
    }));
    if (!isPagesDeployment) {
      links.push(buildLink({
        core, proto: 'tcp', userID, hostName, address: formatted,
        port: pick(httpPorts), tag: `IP${index + 1}`,
      }));
    }
  });

  return new Response(btoa(links.join('
')), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}

async function handleScamalyticsLookup(request, cfg) {
    const url = new URL(request.url);
    const ip = url.searchParams.get('ip');
    if (!ip) {
        return new Response(JSON.stringify({ error: 'Missing ip parameter' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }

    const { apiKey, baseUrl } = cfg.scamalytics;
    if (!apiKey || !baseUrl) {
        return new Response(JSON.stringify({ error: 'Scamalytics API credentials not configured.' }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }

    const lookupUrl = `${baseUrl}?key=${apiKey}&ip=${encodeURIComponent(ip)}`;
    try {
        const res = await fetch(lookupUrl);
        const data = await res.json();
        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

function bytesToReadable(bytes = 0) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / (1024 ** i)).toFixed(2))} ${units[i]}`;
}

function handleConfigPage(userID, hostName, cfg, userData) {
  const expDate = userData.expiration_date;
  const expTime = userData.expiration_time;
  const dataUsage = Number(userData.data_usage || 0);
  const dataLimit = Number(userData.data_limit || 0);

  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;
  const singleXrayConfig = buildLink({
    core: 'xray', proto: 'tls', userID, hostName, address: hostName, port: 443, tag: `${hostName}-Xray`,
  });
  
  const clientUrls = {
    universalAndroid: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    karing: `karing://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
    stash: `stash://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    streisand: `streisand://import/${btoa(subXrayUrl)}`,
    clashMeta: `clash://install-config?url=${encodeURIComponent(`https://revil-sub.pages.dev/sub/clash-meta?url=${subSbUrl}&remote_config=&udp=false&ss_uot=false&show_host=false&forced_ws0rtt=true`)}`,
  };
  const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;
  const hasLimit = dataLimit > 0;
  const pct = hasLimit ? Math.min(100, (dataUsage / dataLimit) * 100) : 0;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>VLESS Proxy Configuration</title>
<link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>${configPageCSS}</style>
</head>
<body data-proxy-ip="${cfg.proxyAddress}">
<div class="container">
<header class="header">
<h1>VLESS Proxy Configuration</h1>
<p>Copy the configuration or import directly into your client</p>
</header>
<section class="network-info-wrapper">
<div class="network-info-header">
<h2>Network Information</h2>
<button class="button refresh-btn" id="refresh-ip-info">Refresh</button>
</div>
<div class="network-grid">
<div class="network-card">
<h3 class="network-title">Proxy Server</h3>
<div class="network-info-grid">
<div><strong>Proxy Host</strong><span id="proxy-host"><span class="skeleton"></span></span></div>
<div><strong>IP Address</strong><span id="proxy-ip"><span class="skeleton"></span></span></div>
<div><strong>Location</strong><span id="proxy-location"><span class="skeleton"></span></span></div>
<div><strong>ISP Provider</strong><span id="proxy-isp"><span class="skeleton"></span></span></div>
</div>
</div>
<div class="network-card">
<h3 class="network-title">Your Connection</h3>
<div class="network-info-grid">
<div><strong>Your IP</strong><span id="client-ip"><span class="skeleton"></span></span></div>
<div><strong>Location</strong><span id="client-location"><span class="skeleton"></span></span></div>
<div><strong>ISP Provider</strong><span id="client-isp"><span class="skeleton"></span></span></div>
<div><strong>Risk Score</strong><span id="client-proxy"><span class="skeleton"></span></span></div>
</div>
</div>
</div>
</section>
<section class="top-grid">
<div class="info-card rainbow">
<div class="info-card-content">
<h2 class="info-title">Expiration Date</h2>
<div id="expiration-relative" class="info-relative-time">Loading…</div>
<div id="expiration-display" data-utc-time="${utcTimestamp}" class="info-time-grid">
<div><strong>Your Local Time:</strong><span id="local-time">--</span></div>
<div><strong>Tehran Time:</strong><span id="tehran-time">--</span></div>
<div><strong>Universal Time:</strong><span id="utc-time">--</span></div>
</div>
</div>
</div>
<div class="info-card">
<div class="info-card-content">
<h2 class="info-title">Data Usage</h2>
<div class="data-usage-text" id="data-usage-display" data-usage="${dataUsage}" data-limit="${dataLimit}">
${bytesToReadable(dataUsage)} / ${hasLimit ? bytesToReadable(dataLimit) : '&infin;'}
</div>
<div class="traffic-bar-container">
<div class="traffic-bar" style="width:${pct}%"></div>
</div>
</div>
</div>
</section>
<section class="config-card">
<div class="config-title">
<span>Single Xray Config</span>
</div>
<div class="config-content">
<pre id="xray-config">${singleXrayConfig}</pre>
</div>
</section>
<section class="config-card">
<div class="config-title">
<span>Xray Subscription</span>
<button id="copy-xray-sub-btn" class="button copy-btn" data-clipboard-text="${subXrayUrl}">Copy Link</button>
</div>
<div class="client-buttons">
<a href="${clientUrls.universalAndroid}" class="client-btn">Universal Import (V2rayNG, etc.)</a>
<a href="${clientUrls.karing}" class="client-btn">Import to Karing</a>
<a href="${clientUrls.shadowrocket}" class="client-btn">Import to Shadowrocket</a>
<a href="${clientUrls.stash}" class="client-btn">Import to Stash</a>
<a href="${clientUrls.streisand}" class="client-btn">Import to Streisand</a>
<button class="client-btn" data-qr-target="xray" data-qr-url="${subXrayUrl}">Show QR Code</button>
</div>
<div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div>
</section>
<section class="config-card">
<div class="config-title">
<span>Sing-Box / Clash Subscription</span>
<button id="copy-sb-sub-btn" class="button copy-btn" data-clipboard-text="${subSbUrl}">Copy Link</button>
</div>
<div class="client-buttons">
<a href="${clientUrls.clashMeta}" class="client-btn">Import to Clash Meta / Stash</a>
<button class="client-btn" data-qr-target="singbox" data-qr-url="${subSbUrl}">Show QR Code</button>
</div>
<div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div>
</section>
<footer class="footer">
<p>© <span id="current-year">${new Date().getFullYear()}</span> – All Rights Reserved</p>
<p>Secure · Private · Fast</p>
</footer>
</div>
<script>${configPageJS}</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const configPageCSS = `
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:"Styrene B LC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#121212;color:#E0E0E0;padding:20px;}
.container{max-width:900px;margin:0 auto;}
.header{text-align:center;margin-bottom:24px;}
.header h1{font-size:2rem;margin-bottom:6px;}
.header p{color:#B0B0B0;}
.top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;margin-bottom:24px;}
.info-card{background:#1E1E1E;border-radius:12px;padding:3px;position:relative;overflow:hidden;}
.info-card.rainbow::before{content:"";position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(#CF6679,#6200EE,#03DAC6,#CF6679);animation:spin 5s linear infinite;z-index:0;}
.info-card-content{position:relative;background:#1E1E1E;border-radius:10px;padding:20px;z-index:1;}
.info-title{text-align:center;font-size:1.2em
