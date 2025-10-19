/**
 * Ultimate VLESS Proxy Worker Script for Cloudflare (Merged & Fully Fixed)
 *
 * @version 6.0.0 - Connection Logic Corrected
 * @author Gemini-Enhanced (Original by multiple authors, merged and fixed by Google AI)
 *
 * This script provides a comprehensive VLESS proxy solution on Cloudflare Workers
 * with a full-featured admin panel, user management, and dynamic configuration generation.
 *
 * CORRECTION HIGHLIGHT:
 * - Fixed the critical bug in the main fetch handler that incorrectly validated the WebSocket path.
 *   The original logic checked for a UUID in the connection path, causing all connections using
 *   the generated random-path configs to fail.
 * - The corrected logic now properly accepts any WebSocket upgrade and defers UUID authentication
 *   to the VLESS protocol handler (`ProtocolOverWSHandler`), which reads the UUID from the
 *   initial data packet. This aligns with the VLESS standard and fixes the connectivity issue.
 *
 * All features are preserved and now fully functional:
 * - Full Admin Panel with user CRUD, data limits, and IP limits.
 * - Smart User Config Page with live network info and Scamalytics integration.
 * - UDP Proxying (DNS) and SOCKS5 Outbound support.
 * - Accurate upstream/downstream traffic accounting.
 *
 * Setup Instructions:
 * 1. Create a D1 Database and bind it as `DB`.
 * 2. Run DB initialization command in your terminal:
 *    `wrangler d1 execute DB --command="CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 2);"`
 * 3. Create a KV Namespace and bind it as `USER_KV`.
 * 4. Set Secrets in your Worker's settings:
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
        
        let parsedSocks5Address = null;
        let enableSocks = Boolean(env.SOCKS5);
        let socks5Relay = env.SOCKS5_RELAY === 'true';

        if (enableSocks) {
            try {
                parsedSocks5Address = socks5AddressParser(env.SOCKS5);
            } catch (e) {
                console.error('Invalid SOCKS5 address format:', e.message);
                enableSocks = false; // Disable if parsing fails
            }
        }


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
            enableSocks,
            socks5Relay,
            parsedSocks5Address,
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

    // Cache for 1 hour
    await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 });
    return userFromDb;
}

async function updateUserUsage(env, uuid, bytes) {
  if (!uuid || bytes <= 0) return;
  await env.DB.prepare(`UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?`)
    .bind(Math.round(bytes), uuid)
    .run();
  // Invalidate cache immediately after update
  await env.USER_KV.delete(`user:${uuid}`);
}

function safeCloseWebSocket(webSocket) {
  if (webSocket && webSocket.readyState === CONST.WS_READY_STATE.OPEN) {
    try {
      webSocket.close(1000, 'Normal Closure');
    } catch (error) {
      console.log('Error closing WebSocket:', error.message);
    }
  }
}

function unsafeStringify(arr) {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
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
        #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background-color: var(--bg-card); color: white; padding: 15px 25px; border-radius: 8px; z-index: 1001; display: none; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); opacity: 0; transition: all 0.3s; }
        #toast.show { display: block; opacity: 1; transform: translate(-50%, -10px); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
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
            const csrfTokenEl = document.getElementById('csrf_token');
            const csrfToken = csrfTokenEl ? csrfTokenEl.value : '';
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
    const adminPath = Config.fromEnv(env).adminPath;
    const cookieHeader = request.headers.get('Cookie');
    const sessionToken = cookieHeader?.match(/auth_token=([^;]+)/)?.[1];
    
    if (!sessionToken) {
        return { isAdmin: false, errorResponse: null, csrfToken: null };
    }

    const storedSession = await env.USER_KV.get(`admin_session:${sessionToken}`, 'json');
    if (!storedSession) {
        // Clear expired cookie
        const headers = new Headers({ 'Set-Cookie': `auth_token=; Path=${adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
        return { isAdmin: false, errorResponse: new Response(null, { status: 403, headers }), csrfToken: null };
    }
    // Session is valid, refresh expiration for 1 day
    await env.USER_KV.put(`admin_session:${sessionToken}`, JSON.stringify(storedSession), { expirationTtl: 86400 });

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
                // Session valid for 1 day (86400 seconds)
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


// --- Core VLESS & Subscription Logic ---

function makeReadableWebSocketStream(webSocket, earlyDataHeader, log) {
    let readableStream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => {
                if (event.data) {
                    controller.enqueue(event.data);
                }
            });

            webSocket.addEventListener('close', () => {
                safeCloseWebSocket(webSocket);
                controller.close();
            });

            webSocket.addEventListener('error', err => {
                log('websocket closed due to error:', err);
                controller.error(err);
            });

            // Handle early data
            if (earlyDataHeader) {
                const earlyData = earlyDataHeader.substring(CONST.ED_PARAMS.eh.length + 1);
                if (earlyData) {
                    const decodedData = atob(earlyData);
                    const buffer = new Uint8Array(decodedData.length);
                    for (let i = 0; i < decodedData.length; i++) {
                        buffer[i] = decodedData.charCodeAt(i);
                    }
                    controller.enqueue(buffer.buffer);
                }
            }
        },
    });

    return readableStream;
}

async function ProtocolOverWSHandler(request, config, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyDataHeader = request.headers.get(CONST.ED_PARAMS.eh) || '';
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
            log(`User ${activeUser.uuid} exceeded data cap mid-session (Downstream).`);
            safeCloseWebSocket(webSocket);
            remoteSocketWrapper.value?.close?.();
        }
    };
    const incrementUp = (bytes) => {
        usageUp += bytes;
        if (activeUser && activeUser.data_limit > 0 && (initialUsage + usageDown + usageUp) >= activeUser.data_limit) {
            log(`User ${activeUser.uuid} exceeded data cap mid-session (Upstream).`);
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
    
    // Set up cleanup on timeout
    ctx.waitUntil(new Promise(resolve => {
        webSocket.addEventListener('close', () => {
            flushUsage().then(resolve);
        });
        webSocket.addEventListener('error', () => {
            flushUsage().then(resolve);
        });
        // Fallback cleanup: 10 minutes after start
        setTimeout(() => {
            if (webSocket.readyState === CONST.WS_READY_STATE.OPEN) {
                 safeCloseWebSocket(webSocket);
            }
            flushUsage().then(resolve);
        }, 10 * 60 * 1000); 
    }));


    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                incrementDown(chunk.byteLength); // Count downstream traffic

                if (udpWriter) {
                    // UDP Tunnel already established
                    await udpWriter.write(chunk);
                    return;
                }

                if (remoteSocketWrapper.value) {
                    // TCP Tunnel already established
                    const writer = remoteSocketWrapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                // --- VLESS Header Processing ---
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
                    activeIPs = activeIPs.filter(entry => entry.exp > Date.now());
                    
                    if (activeIPs.length >= user.ip_limit && !activeIPs.some(e => e.ip === clientIP)) {
                        controller.error(new Error(`IP limit of ${user.ip_limit} reached. Blocking IP ${clientIP}`));
                        return;
                    }
                    if (!activeIPs.some(e => e.ip === clientIP)) {
                        activeIPs.push({ ip: clientIP, exp: Date.now() + 65000 }); 
                        ctx.waitUntil(env.USER_KV.put(key, JSON.stringify(activeIPs), { expirationTtl: 120 }));
                    }
                }
                // --- End Validation ---
                
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
    const port = view.getUint16(portIndex, false); // Big-endian
    
    const addrType = view.getUint8(portIndex + 2);
    let address, rawDataIndex;
    
    const addressStart = portIndex + 3;
    const decoder = new TextDecoder();

    switch (addrType) {
        case 1: // IPv4 (4 bytes)
            address = new Uint8Array(vlessBuffer.slice(addressStart, addressStart + 4)).join('.');
            rawDataIndex = addressStart + 4;
            break;
        case 2: // Domain (1 byte length + domain)
            const domainLen = view.getUint8(addressStart);
            address = decoder.decode(vlessBuffer.slice(addressStart + 1, addressStart + 1 + domainLen));
            rawDataIndex = addressStart + 1 + domainLen;
            break;
        case 3: // IPv6 (16 bytes)
            const ipv6 = Array.from({length: 8}, (_, i) => view.getUint16(addressStart + i * 2, false).toString(16).padStart(4, '0')).join(':');
            address = `[${ipv6}]`;
            rawDataIndex = addressStart + 16;
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

// --- Network Handlers (TCP, UDP, SOCKS5) ---

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
  const isTargetingProxy = config.proxyIP && (addressRemote === config.proxyIP || addressRemote === `[${config.proxyIP}]` || addressRemote === config.proxyAddress);

  async function connectAndWrite(address, port, isSocks = false) {
    let tcpSocket;
    if (config.socks5Relay) {
      tcpSocket = await socks5Connect(addressType, address, port, log, config.parsedSocks5Address);
    } else if (isSocks) {
      tcpSocket = await socks5Connect(addressType, address, port, log, config.parsedSocks5Address);
    } else {
      tcpSocket = connect({ hostname: address, port: port });
    }
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}${isSocks ? ' via SOCKS5' : ''}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    if (config.socks5Relay) {
        log('SOCKS5 Relay is active. No retry logic available after initial SOCKS5 connection failed.');
        throw new Error('SOCKS5 Relay failed');
    }

    let nextAddress = addressRemote;
    let nextPort = portRemote;
    let isSocksAttempt = false;

    if (config.enableSocks) {
        log('Retrying via SOCKS5 Outbound Proxy...');
        isSocksAttempt = true;
    } 
    else if (config.proxyIP && !isTargetingProxy) {
        log(`Retrying via PROXYIP: ${config.proxyAddress}...`);
        nextAddress = config.proxyIP;
        nextPort = config.proxyPort;
    } else {
        log('No suitable retry path found.');
        throw new Error('No retry path');
    }

    const tcpSocket = await connectAndWrite(nextAddress, nextPort, isSocksAttempt);
    tcpSocket.closed
      .catch(error => {
        console.log('retry tcpSocket closed error', error);
      })
      .finally(() => {
        safeCloseWebSocket(webSocket);
      });
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, countUp);
  }

  try {
      const tcpSocket = await connectAndWrite(addressRemote, portRemote, config.enableSocks && config.socks5Relay);
      RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, retry, log, countUp);
  } catch (err) {
      log('Initial connection failed. Attempting retry...', err.message);
      try {
        await retry();
      } catch (retryError) {
        log('All connection attempts failed:', retryError.message);
        safeCloseWebSocket(webSocket);
      }
  }
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log, countUp) {
  let hasIncomingData = false;
  let isRetryable = true;
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState !== CONST.WS_READY_STATE.OPEN) {
            isRetryable = false;
            throw new Error('WebSocket is not open');
          }
          
          countUp(chunk.byteLength);
          hasIncomingData = true;
          isRetryable = false;
          
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
    if (isRetryable && !hasIncomingData && retry) {
      log('No incoming data received on initial attempt, trying fallback...');
    } else {
        safeCloseWebSocket(webSocket);
    }
  }
  
  if (isRetryable && !hasIncomingData && retry) {
    log('No incoming data from direct connection, triggering retry()');
    retry();
  } else if (!isRetryable) {
      safeCloseWebSocket(webSocket);
  }
}

async function socks5Connect(addressType, addressRemote, portRemote, log, parsedSocks5Addr) {
  if (!parsedSocks5Addr) throw new Error('SOCKS5 proxy not configured correctly.');

  const { username, password, hostname, port } = parsedSocks5Addr;
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();

  const authMethods = (username && password) ? [0x00, 0x02] : [0x00];
  await writer.write(new Uint8Array([0x05, authMethods.length, ...authMethods]));
  let res = (await reader.read()).value;
  if (!res || res.byteLength < 2 || res[0] !== 0x05 || res[1] === 0xff) throw new Error('SOCKS5 server connection failed (Greeting).');

  if (res[1] === 0x02) {
    if (!username || !password) throw new Error('SOCKS5 auth credentials not provided.');
    const authRequest = new Uint8Array([
      0x01,
      username.length,
      ...encoder.encode(username),
      password.length,
      ...encoder.encode(password),
    ]);
    await writer.write(authRequest);
    res = (await reader.read()).value;
    if (!res || res.byteLength < 2 || res[0] !== 0x01 || res[1] !== 0x00) throw new Error('SOCKS5 authentication failed.');
  }

  let DSTADDR;
  let dstPortBytes = new Uint8Array([portRemote >> 8, portRemote & 0xff]);
  
  switch (addressType) {
    case 1: // IPv4
      DSTADDR = new Uint8Array([0x01, ...addressRemote.split('.').map(Number)]);
      break;
    case 2: // Domain
      DSTADDR = new Uint8Array([0x03, addressRemote.length, ...encoder.encode(addressRemote)]);
      break;
    case 3: // IPv6
      const ipv6 = addressRemote.replace('[', '').replace(']', '');
      const parts = ipv6.split(':').map(part => {
          const hex = part.padStart(4, '0');
          return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16)];
      }).flat();
      DSTADDR = new Uint8Array([0x04, ...parts]);
      break;
    default:
      throw new Error(`Invalid addressType for SOCKS5: ${addressType}`);
  }

  const socksRequest = new Uint8Array([0x05, 0x01, 0x00, ...DSTADDR, ...dstPortBytes]);
  await writer.write(socksRequest);
  res = (await reader.read()).value;
  if (!res || res.byteLength < 10 || res[1] !== 0x00) throw new Error(`Failed to open SOCKS5 connection: code ${res ? res[1] : 'unknown'}`);

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

    let username = null, password = null;
    if (authPart) {
      [username, password] = authPart.split(':');
      if (!username) throw new Error();
    }
    return { username, password, hostname, port };
  } catch {
    throw new Error('Invalid SOCKS5 address format. Expected [user:pass@]host:port');
  }
}

async function createDnsPipeline(webSocket, vlessResponseHeader, log, countUp) {
  let headerSent = false;
  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        const buffer = chunk instanceof ArrayBuffer ? chunk : chunk.buffer;
        const view = new DataView(buffer);
        
        let offset = 0;
        while (offset < buffer.byteLength) {
          if (offset + 2 > buffer.byteLength) {
            log('Incomplete UDP length prefix in chunk.');
            break;
          }
          const len = view.getUint16(offset, false);
          offset += 2;
          
          if (offset + len > buffer.byteLength) {
            log('Incomplete UDP packet data in chunk.');
            break;
          }
          
          const data = buffer.slice(offset, offset + len);
          controller.enqueue(data);
          offset += len;
        }
      } catch (e) {
        log('Error in DNS transform:', e);
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
        
        if (!resp.ok) {
           throw new Error(`DNS-over-HTTPS failed with status ${resp.status}`);
        }
        
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
      }
    },
    abort(reason) { log('DNS query pipeline aborted:', reason); }
  })).catch((err) => log('DNS transform pipeline failed', err));

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
  const finalAddress = address.startsWith('[') ? address.slice(1, -1) : address;

  return createVlessLink({
    userID,
    address: finalAddress,
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
      const cacheKey = `smart_ips:${new URL(url).hostname}`;
      const cached = await env.USER_KV.get(cacheKey, 'json');
      if (cached && cached.length > 0) return cached;

      const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!res.ok) continue;
      const json = await res.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].map((item) => item.ip || item).filter(Boolean);
      
      if (ips.length) {
          await env.USER_KV.put(cacheKey, JSON.stringify(ips), { expirationTtl: 3600 });
          return ips;
      }
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
      port: pick(httpsPorts), tag: `D${i + 1}-TLS`,
    }));
    
    if (!isPagesDeployment) {
      links.push(buildLink({
        core, proto: 'tcp', userID, hostName, address: domain,
        port: pick(httpPorts), tag: `D${i + 1}-TCP`,
      }));
    }
  });

  const smartIPs = await fetchSmartIpPool(env);
  smartIPs.slice(0, 40).forEach((ip, index) => {
    const formatted = ip.includes(':') ? `[${ip}]` : ip;
    links.push(buildLink({
      core, proto: 'tls', userID, hostName, address: formatted,
      port: pick(httpsPorts), tag: `IP${index + 1}-TLS`,
    }));
    if (!isPagesDeployment) {
      links.push(buildLink({
        core, proto: 'tcp', userID, hostName, address: formatted,
        port: pick(httpPorts), tag: `IP${index + 1}-TCP`,
      }));
    }
  });

  return new Response(btoa(links.join('
')), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}

async function handleScamalyticsLookup(request, cfg, env) {
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

    const lookupUrl = `${baseUrl}?key=${apiKey}&ip=${encodeURIComponent(ip)}&database=dbip`;
    try {
        const cacheKey = `scam_ip:${ip}`;
        let data = await env.USER_KV.get(cacheKey, 'json');
        
        if (!data) {
            const res = await fetch(lookupUrl);
            if (!res.ok) throw new Error(`Scamalytics HTTP error! status: ${res.status}`);
            data = await res.json();
            await env.USER_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
        }

        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }
}

function bytesToReadable(bytes = 0) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / (1024 ** i)).toFixed(2))} ${units[i]}`;
}


// --- Config Page HTML/CSS/JS ---

const configPageCSS = `
*{
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
:root {
  --background-primary: #2a2421; --background-secondary: #35302c; --background-tertiary: #413b35;
  --border-color: #5a4f45; --border-color-hover: #766a5f; --text-primary: #e5dfd6; --text-secondary: #b3a89d;
  --text-accent: #ffffff; --accent-primary: #be9b7b; --accent-secondary: #d4b595; --accent-tertiary: #8d6e5c;
  --accent-primary-darker: #8a6f56; --button-text-primary: #2a2421; --button-text-secondary: var(--text-primary);
  --shadow-color: rgba(0, 0, 0, 0.35); --shadow-color-accent: rgba(190, 155, 123, 0.4);
  --border-radius: 12px; --transition-speed: 0.2s; --transition-speed-fast: 0.1s; --transition-speed-medium: 0.3s; --transition-speed-long: 0.6s;
  --status-success: #70b570; --status-error: #e05d44; --status-warning: #e0bc44; --status-info: #4f90c4;
  --serif: "Aldine 401 BT Web", "Times New Roman", Times, Georgia, ui-serif, serif;
  --sans-serif: "Styrene B LC", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "Noto Color Emoji", sans-serif;
  --mono-serif: "Fira Code", Cantarell, "Courier Prime", monospace;
}
body {
  font-family: var(--sans-serif); 
  font-size: 16px; 
  font-weight: 400; 
  font-style: normal;
  background-color: var(--background-primary); 
  color: var(--text-primary);
  padding: 3rem; 
  line-height: 1.5; 
  -webkit-font-smoothing: antialiased; 
  -moz-osx-font-smoothing: grayscale;
}
@keyframes rgb-animation {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
.info-card.rainbow {
  position: relative;
  padding: 3px;
  background: var(--background-secondary);
  border-radius: var(--border-radius);
  overflow: hidden;
  z-index: 1;
}
.info-card.rainbow::before {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: conic-gradient(
    #ff0000, #ff00ff, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000
  );
  animation: rgb-animation 4s linear infinite;
  z-index: -1;
}
.info-card.rainbow .info-card-content {
  background: var(--background-secondary);
  padding: 20px;
  border-radius: calc(var(--border-radius) - 3px);
}
.info-title {
  font-family: var(--serif);
  font-size: 1.6rem;
  font-weight: 400;
  text-align: center;
  color: var(--accent-secondary);
  margin: 0 0 12px 0;
}
.info-relative-time {
  text-align: center;
  font-size: 1.1rem;
  font-weight: 500;
  margin-bottom: 12px;
  padding: 4px 8px;
  border-radius: 6px;
}
.info-relative-time.active {
  color: var(--status-success);
  background-color: rgba(112, 181, 112, 0.1);
}
.info-relative-time.expired {
  color: var(--status-error);
  background-color: rgba(224, 93, 68, 0.1);
}
#expiration-display { 
  font-size: 0.9em; 
  text-align: center; 
  color: var(--text-secondary); 
}
#expiration-display span { 
  display: block; 
  margin-top: 8px; 
  font-size: 0.9em; 
  line-height: 1.6; 
}
#expiration-display strong { 
  color: var(--text-primary); 
  font-weight: 500; 
}
.container {
  max-width: 800px; 
  margin: 20px auto; 
  padding: 0 12px; 
  border-radius: var(--border-radius);
  box-shadow: 0 6px 15px rgba(0, 0, 0, 0.2), 0 0 25px 8px var(--shadow-color-accent);
  transition: box-shadow var(--transition-speed-medium) ease;
  background-color: var(--background-primary);
}
.container:hover { 
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25), 0 0 35px 10px var(--shadow-color-accent); 
}
.header { 
  text-align: center; 
  margin-bottom: 30px; 
  padding-top: 30px; 
}
.header h1 { 
  font-family: var(--serif); 
  font-weight: 400; 
  font-size: 1.8rem; 
  color: var(--text-accent); 
  margin-top: 0px; 
  margin-bottom: 2px; 
}
.header p { 
  color: var(--text-secondary); 
  font-size: 0.8rem; 
  font-weight: 400; 
}
.network-info-wrapper {
  margin-bottom: 24px;
}
.network-info-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}
.network-info-header h2 {
    font-family: var(--serif);
    font-weight: 400;
    font-size: 1.4rem;
    color: var(--accent-secondary);
}
.network-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
}
.network-card {
    background: var(--background-secondary);
    border-radius: var(--border-radius);
    padding: 15px;
    border: 1px solid var(--border-color);
}
.network-title {
    font-size: 1.1rem;
    font-weight: 500;
    color: var(--text-primary);
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color);
}
.network-info-grid > div {
    display: flex;
    justify-content: space-between;
    font-size: 0.9rem;
    line-height: 1.8;
    color: var(--text-secondary);
}
.network-info-grid > div strong {
    color: var(--text-primary);
    font-weight: 500;
}
.network-info-grid > div span {
    text-align: right;
    max-width: 60%;
}
.config-card {
  background: var(--background-secondary); 
  border-radius: var(--border-radius); 
  padding: 20px; 
  margin-bottom: 24px; 
  border: 1px solid var(--border-color);
  transition: border-color var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
}
.config-card:hover { 
  border-color: var(--border-color-hover); 
  box-shadow: 0 4px 8px var(--shadow-color); 
}
.config-title {
  font-family: var(--serif); 
  font-size: 1.6rem; 
  font-weight: 400; 
  color: var(--accent-secondary);
  margin-bottom: 16px; 
  padding-bottom: 13px; 
  border-bottom: 1px solid var(--border-color);
  display: flex; 
  align-items: center; 
  justify-content: space-between;
}
.button {
  display: inline-flex; 
  align-items: center; 
  justify-content: center; 
  gap: 8px;
  padding: 8px 16px; 
  border-radius: 6px; 
  font-size: 15px; 
  font-weight: 500;
  cursor: pointer; 
  border: 1px solid var(--border-color); 
  background-color: var(--background-tertiary);
  color: var(--button-text-secondary);
  transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
  text-decoration: none; 
  overflow: hidden; 
  position: relative;
}
.button::before {
  content: ''; 
  position: absolute; 
  top: 0; 
  left: 0; 
  width: 100%; 
  height: 100%;
  background: linear-gradient(120deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transform: translateX(-100%); 
  transition: transform 0.6s ease; 
  z-index: 1;
}
.button:hover::before { 
  transform: translateX(100%); 
}
.button:hover {
  background-color: #4d453e; 
  border-color: var(--border-color-hover); 
  transform: translateY(-2px); 
  box-shadow: 0 4px 8px var(--shadow-color);
}
.button:active { 
  transform: translateY(0px) scale(0.98); 
  box-shadow: none; 
}
.config-content {
  position: relative; 
  background: var(--background-tertiary); 
  border-radius: var(--border-radius);
  padding: 16px; 
  margin-bottom: 20px; 
  border: 1px solid var(--border-color);
}
.config-content pre {
  overflow-x: auto; 
  font-family: var(--mono-serif); 
  font-size: 12px; 
  color: var(--text-primary);
  margin: 0; 
  white-space: pre-wrap; 
  word-break: break-all;
}
.client-buttons { 
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.client-btn {
  background-color: var(--accent-primary);
  color: var(--button-text-primary);
  border: 1px solid var(--accent-primary-darker);
  font-size: 14px;
  padding: 10px 15px;
  text-align: center;
}
.client-btn:hover {
    background-color: var(--accent-secondary);
    border-color: var(--accent-primary);
    transform: translateY(-2px);
}
.client-btn:active {
    transform: translateY(0px) scale(0.98);
}
.qr-container { 
  margin-top: 20px; 
  text-align: center; 
  display: none; 
}
.qr-container.show { 
  display: block; 
}
#qr-xray, #qr-singbox { 
  display: inline-block; 
  padding: 10px; 
  background: white; 
  border-radius: 8px; 
  box-shadow: 0 0 10px rgba(0,0,0,0.5); 
}
.top-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    margin-bottom: 24px;
}
.info-card {
    background: var(--background-secondary);
    border-radius: var(--border-radius);
    padding: 0px; 
    border: 1px solid var(--border-color);
}
.data-usage-text {
    font-family: var(--mono-serif);
    font-size: 1.4rem;
    text-align: center;
    margin-bottom: 10px;
    color: var(--text-accent);
}
.traffic-bar-container {
    height: 10px;
    background-color: var(--background-tertiary);
    border-radius: 5px;
    overflow: hidden;
    margin: 0 10px;
    border: 1px solid var(--border-color);
}
.traffic-bar {
    height: 100%;
    background-color: var(--accent-primary);
    transition: width 0.5s ease;
}
.footer {
    text-align: center;
    padding: 20px 0 10px;
    font-size: 0.8rem;
    color: var(--text-secondary);
}
.footer p:first-child { margin-bottom: 5px; }
@media (max-width: 768px) {
    body { padding: 1rem; }
    .top-grid, .network-grid {
        grid-template-columns: 1fr;
    }
    .config-content pre {
        font-size: 10px;
    }
    .client-buttons {
        grid-template-columns: 1fr;
    }
}
/* Network Info Badges */
.badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
}
.badge-yes { background-color: rgba(112, 181, 112, 0.2); color: var(--status-success); }
.badge-no { background-color: rgba(224, 93, 68, 0.2); color: var(--status-error); }
.badge-warning { background-color: rgba(224, 188, 68, 0.2); color: var(--status-warning); }
.badge-neutral { background-color: rgba(179, 168, 157, 0.2); color: var(--text-secondary); }
.country-flag {
    margin-right: 5px;
    border-radius: 2px;
    vertical-align: middle;
}
/* Skeleton Loading */
.skeleton {
    display: inline-block;
    height: 1em;
    width: 80px;
    background-color: var(--background-tertiary);
    border-radius: 4px;
    animation: pulse 1.5s infinite ease-in-out;
}
@keyframes pulse {
    0% { opacity: 0.4; }
    50% { opacity: 0.8; }
    100% { opacity: 0.4; }
}
.network-info-grid .skeleton {
    float: right;
    margin-top: 0.3em;
}
`;


const configPageJS = `
function bytesToReadable(bytes = 0) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return \`\${parseFloat((bytes / (1024 ** i)).toFixed(2))} \${units[i]}\`;
}

function updateIpApiIoDisplay(geo, prefix, originalHost) {
  const hostElement = document.getElementById(\`\${prefix}-host\`);
  if (hostElement) hostElement.textContent = originalHost || "N/A";
  
  const elements = {
    ip: document.getElementById(\`\${prefix}-ip\`),
    location: document.getElementById(\`\${prefix}-location\`),
    isp: document.getElementById(\`\${prefix}-isp\`)
  };
  
  if (!geo || geo.status === 'fail') {
    Object.values(elements).forEach(el => { if(el) el.innerHTML = "N/A"; });
    return;
  }
  
  if (elements.ip) elements.ip.textContent = geo.query || geo.ip || "N/A";
  
  if (elements.location) {
    const city = geo.city || '';
    const countryName = geo.country || '';
    const countryCode = geo.countryCode ? geo.countryCode.toLowerCase() : '';
    let flagElementHtml = countryCode ? \`<img src="https://flagcdn.com/w20/\${countryCode}.png" srcset="https://flagcdn.com/w40/\${countryCode}.png 2x" alt="\${geo.countryCode}" class="country-flag"> \` : '';
    let textPart = [city, countryName].filter(Boolean).join(', ');
    elements.location.innerHTML = (flagElementHtml || textPart) ? \`\${flagElementHtml}\${textPart}\`.trim() : "N/A";
  }
  
  if (elements.isp) elements.isp.textContent = geo.isp || geo.org || geo.as || 'N/A';
}

function updateScamalyticsClientDisplay(data) {
  const prefix = 'client';
  const elements = {
    ip: document.getElementById(\`\${prefix}-ip\`),
    location: document.getElementById(\`\${prefix}-location\`),
    isp: document.getElementById(\`\${prefix}-isp\`),
    proxy: document.getElementById(\`\${prefix}-proxy\`)
  };
  
  if (!data || !data.scamalytics || data.scamalytics.status !== 'ok') {
    const errorMsg = (data && data.scamalytics && data.scamalytics.error) || 'Data Unavailable';
    Object.values(elements).forEach(el => { 
        if(el && el.id !== 'client-proxy') el.innerHTML = "N/A"; 
        else if (el) el.innerHTML = \`<span class="badge badge-neutral">\${errorMsg}</span>\`;
    });
    console.warn(\`Client data loading failed: \${errorMsg}\`);
    return;
  }
  
  const sa = data.scamalytics;
  const dbip = data.external_datasources?.dbip;
  
  if (elements.ip) elements.ip.textContent = sa.ip || "N/A";
  
  if (elements.location) {
    const city = dbip?.ip_city || '';
    const countryName = dbip?.ip_country_name || '';
    const countryCode = dbip?.ip_country_code ? dbip.ip_country_code.toLowerCase() : '';
    let locationString = 'N/A';
    let flagElementHtml = countryCode ? \`<img src="https://flagcdn.com/w20/\${countryCode}.png" srcset="https://flagcdn.com/w40/\${countryCode}.png 2x" alt="\${dbip.ip_country_code}" class="country-flag"> \` : '';
    let textPart = [city, countryName].filter(Boolean).join(', ');
    if (flagElementHtml || textPart) locationString = \`\${flagElementHtml}\${textPart}\`.trim();
    elements.location.innerHTML = locationString || "N/A";
  }
  
  if (elements.isp) elements.isp.textContent = sa.scamalytics_isp || dbip?.isp_name || "N/A";
  
  if (elements.proxy) {
    const score = sa.scamalytics_score;
    const risk = sa.scamalytics_risk;
    let riskText = "Unknown";
    let badgeClass = "badge-neutral";
    
    if (risk && score !== undefined) {
        riskText = \`\${score} - \${risk.charAt(0).toUpperCase() + risk.slice(1)}\`;
        switch (risk.toLowerCase()) {
            case "low": badgeClass = "badge-yes"; break;
            case "medium": badgeClass = "badge-warning"; break;
            case "high": case "very high": badgeClass = "badge-no"; break;
            default: badgeClass = "badge-neutral";
        }
    }
    elements.proxy.innerHTML = \`<span class="badge \${badgeClass}">\${riskText}</span>\`;
  }
}

async function fetchIpApiIoInfo(ip) {
  try {
    const response = await fetch(\`https://ip-api.io/json/\${ip}\`);
    if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
    return await response.json();
  } catch (error) {
    console.error('IP API Error (ip-api.io):', error);
    return null;
  }
}

async function fetchClientPublicIP() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
    return (await response.json()).ip;
  } catch (error) {
    console.error('Error fetching client IP:', error);
    return null;
  }
}

async function fetchScamalyticsClientInfo(clientIp) {
  if (!clientIp) return null;
  try {
    const response = await fetch(\`/scamalytics-lookup?ip=\${encodeURIComponent(clientIp)}\`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown Worker Error' }));
      throw new Error(errorData.error || \`Worker request failed! status: \${response.status}\`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching from Scamalytics via Worker:', error);
    return { scamalytics: { status: 'error', error: error.message } };
  }
}

function displayExpirationTimes() {
  const expElement = document.getElementById('expiration-display');
  const relativeElement = document.getElementById('expiration-relative');

  if (!expElement || !expElement.dataset.utcTime) {
      if (expElement) expElement.textContent = 'Expiration time not available.';
      if (relativeElement) relativeElement.style.display = 'none';
      return;
  }

  const utcTimestamp = expElement.dataset.utcTime;
  if (!utcTimestamp) return;

  const utcDate = new Date(utcTimestamp);
  if (isNaN(utcDate.getTime())) {
      expElement.textContent = 'Invalid expiration time format.';
      if (relativeElement) relativeElement.style.display = 'none';
      return;
  }
  
  const now = new Date();
  const diffSeconds = (utcDate.getTime() - now.getTime()) / 1000;
  const isExpired = diffSeconds < 0;

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let relativeTimeStr = 'just now';

  if (Math.abs(diffSeconds) >= 86400) {
      relativeTimeStr = rtf.format(Math.round(diffSeconds / 86400), 'day');
  } else if (Math.abs(diffSeconds) >= 3600) {
      relativeTimeStr = rtf.format(Math.round(diffSeconds / 3600), 'hour');
  } else if (Math.abs(diffSeconds) >= 60) {
      relativeTimeStr = rtf.format(Math.round(diffSeconds / 60), 'minute');
  } else {
      relativeTimeStr = rtf.format(Math.round(diffSeconds), 'second');
  }

  if (relativeElement) {
      relativeElement.textContent = isExpired ? \`Expired \${relativeTimeStr}\` : \`Expires \${relativeTimeStr}\`;
      relativeElement.classList.remove('active', 'expired');
      relativeElement.classList.add(isExpired ? 'expired' : 'active');
      relativeElement.style.display = 'block';
  }

  const commonOptions = {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true
  };

  const localTimeStr = utcDate.toLocaleString(undefined, { ...commonOptions, timeZoneName: 'short' });
  const tehranTimeStr = utcDate.toLocaleString('en-US', { ...commonOptions, timeZone: 'Asia/Tehran', timeZoneName: 'short' });
  const utcTimeStr = utcDate.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

  expElement.innerHTML = \`
    <span><strong>Your Local Time:</strong> \${localTimeStr}</span>
    <span><strong>Tehran Time:</strong> \${tehranTimeStr}</span>
    <span><strong>Universal Time:</strong> \${utcTimeStr}</span>
  \`;
}


async function loadNetworkInfo() {
  const proxyIpWithPort = document.body.getAttribute('data-proxy-ip') || "N/A";
  const proxyDomainOrIp = proxyIpWithPort.split(':')[0];
  const skeleton = '<span class="skeleton"></span>';
  
  const placeholders = ['proxy-host', 'proxy-ip', 'proxy-location', 'proxy-isp', 'client-ip', 'client-location', 'client-isp', 'client-proxy'];
  placeholders.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = id === 'proxy-host' ? proxyIpWithPort : skeleton;
  });

  try {
    if (proxyDomainOrIp && proxyDomainOrIp !== "N/A") {
      let resolvedProxyIp = proxyDomainOrIp;
      if (!/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(proxyDomainOrIp) && !/^[0-9a-fA-F:]+$/.test(proxyDomainOrIp)) {
        try {
          const dnsRes = await fetch(\`https://dns.google/resolve?name=\${encodeURIComponent(proxyDomainOrIp)}&type=A\`);
          if (dnsRes.ok) {
              const dnsData = await dnsRes.json();
              const ipAnswer = dnsData.Answer?.find(a => a.type === 1);
              if (ipAnswer) resolvedProxyIp = ipAnswer.data;
          }
        } catch (e) { console.error('DNS resolution for proxy failed:', e); }
      }
      const proxyGeoData = await fetchIpApiIoInfo(resolvedProxyIp);
      updateIpApiIoDisplay(proxyGeoData, 'proxy', proxyIpWithPort);
    } else {
      updateIpApiIoDisplay(null, 'proxy', proxyIpWithPort);
    }

    const clientIp = await fetchClientPublicIP();
    if (clientIp) {
      document.getElementById('client-ip').textContent = clientIp;
      const scamalyticsData = await fetchScamalyticsClientInfo(clientIp);
      updateScamalyticsClientDisplay(scamalyticsData);
    } else {
      updateScamalyticsClientDisplay(null);
    }
  } catch (error) {
    console.error('Overall network info loading failed:', error);
    updateIpApiIoDisplay(null, 'proxy', proxyIpWithPort);
    updateScamalyticsClientDisplay(null);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  displayExpirationTimes();
  loadNetworkInfo();
  
  document.getElementById('refresh-ip-info').addEventListener('click', loadNetworkInfo);

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const textToCopy = btn.getAttribute('data-clipboard-text');
      try {
        await navigator.clipboard.writeText(textToCopy);
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = originalText; }, 1500);
      } catch (err) {
        console.error('Failed to copy text:', err);
        alert('Failed to copy text. Please copy manually.');
      }
    });
  });

  document.querySelectorAll('[data-qr-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-qr-target');
      const url = btn.getAttribute('data-qr-url');
      const container = document.getElementById(\`qr-\${target}-container\`);
      const qrDiv = document.getElementById(\`qr-\${target}\`);

      const isVisible = container.classList.contains('show');
      document.querySelectorAll('.qr-container').forEach(c => c.classList.remove('show'));
      
      if (!isVisible) {
        qrDiv.innerHTML = '';
        new QRCode(qrDiv, {
          text: url,
          width: 200,
          height: 200,
          colorDark : "#000000",
          colorLight : "#ffffff",
          correctLevel : QRCode.CorrectLevel.H
        });
        container.classList.add('show');
      }
    });
  });
});
`;


function handleConfigPage(userID, hostName, cfg, userData) {
  const expDate = userData.expiration_date;
  const expTime = userData.expiration_time;
  const dataUsage = Number(userData.data_usage || 0);
  const dataLimit = Number(userData.data_limit || 0);
  const hasLimit = dataLimit > 0;
  const pct = hasLimit ? Math.min(100, (dataUsage / dataLimit) * 100) : 0;
  const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;

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
<p>User ID: ${userID.substring(0, 8)}... | Host: ${hostName}</p>
</header>
<section class="network-info-wrapper">
<div class="network-info-header">
<h2>Network Information</h2>
<button class="button refresh-btn" id="refresh-ip-info">Refresh</button>
</div>
<div class="network-grid">
<div class="network-card">
<h3 class="network-title">Proxy Server (Cloudflare Edge)</h3>
<div class="network-info-grid">
<div><strong>Proxy Host</strong><span id="proxy-host">${cfg.proxyAddress}</span></div>
<div><strong>IP Address</strong><span id="proxy-ip"><span class="skeleton"></span></span></div>
<div><strong>Location</strong><span id="proxy-location"><span class="skeleton"></span></span></div>
<div><strong>ISP Provider</strong><span id="proxy-isp"><span class="skeleton"></span></span></div>
</div>
</div>
<div class="network-card">
<h3 class="network-title">Your Connection (Client)</h3>
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
<span><strong>Your Local Time:</strong><span id="local-time">--</span></span>
<span><strong>Tehran Time:</strong><span id="tehran-time">--</span></span>
<span><strong>Universal Time:</strong><span id="utc-time">--</span></span>
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
<button class="button copy-btn" data-clipboard-text="${singleXrayConfig}">Copy Config</button>
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
<p>© <span id="current-year">${new Date().getFullYear()}</span> - All Rights Reserved</p>
<p>Secure. Private. Fast.</p>
</footer>
</div>
<script>${configPageJS}</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}


// --- Main Fetch Handler (FIXED & COMPLETED) ---

const worker = {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const hostName = url.hostname;
        const cfg = Config.fromEnv(env);
        const { pathname } = url;

        // Route 1: Admin Panel
        if (pathname.startsWith(cfg.adminPath)) {
            const adminResponse = await handleAdminRequest(request, env);
            if (adminResponse) return adminResponse;
        }

        // Route 2: Internal API for Config Page
        if (pathname === '/scamalytics-lookup') {
            return handleScamalyticsLookup(request, cfg, env);
        }
        
        // Route 3: VLESS over WebSocket Protocol
        // This is the main fix. The worker now accepts any WebSocket upgrade request
        // and lets the protocol handler (`ProtocolOverWSHandler`) authenticate the user
        // from the VLESS header, instead of incorrectly checking the path.
        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
            return ProtocolOverWSHandler(request, cfg, env, ctx);
        }
        
        // Route 4: Subscription Links
        const subMatch = pathname.match(/^\/(xray|sb)\/([a-f0-9-]+)$/);
        if (subMatch) {
            const core = subMatch[1];
            const userID = subMatch[2];
            const user = await getUserData(env, userID);
            
            if (!user) {
                return new Response("User not found", { status: 404 });
            }
            if (isExpired(user.expiration_date, user.expiration_time) || !hasRemainingData(user)) {
                return new Response("Forbidden (Expired or Data Limit)", { status: 403 });
            }

            return handleIpSubscription(core, userID, hostName, env);
        }

        // Route 5: Config/Welcome Page
        if (pathname.match(/^\/[a-f0-9-]{36}$/i) || pathname === '/') {
            const pathUserID = pathname.replace(/\//g, '');
            const targetUserID = isValidUUID(pathUserID) ? pathUserID : cfg.userID;
            
            const userData = await getUserData(env, targetUserID);
            
            if (!userData) {
                return new Response("User ID not found or default UUID is missing.", { status: 404 });
            }
            return handleConfigPage(targetUserID, hostName, cfg, userData);
        }

        // Route 6: Root Reverse Proxy (if configured)
        if (cfg.rootProxyURL) {
            try {
                const proxyUrl = new URL(cfg.rootProxyURL);
                const newRequest = new Request(request);
                newRequest.headers.set('Host', proxyUrl.host);
                return fetch(proxyUrl.toString(), newRequest);
            } catch (e) {
                return new Response(`Root proxy configuration error: ${e.message}`, { status: 500 });
            }
        }
        
        // Fallback: Not Found
        return new Response(`Route Not Found for ${pathname}`, { status: 404 });
    }
};

export default worker;
