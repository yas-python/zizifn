/**
 * Cloudflare Worker VLESS Proxy - Ultimate Merged Edition
 *
 * [Final Combined Script by Gemini - v3.2 (SyntaxError Fix)]
 *
 * This script intelligently merges:
 * 1.  ADVANCED FEATURES (from Script 2):
 * - Admin Panel with D1 database for users.
 * - User management: Expiration Date, Data Limit (GB/MB), and Data Usage tracking.
 * - Smart User Config Page with network info, data usage, and expiration.
 * - Secure Management API (API_TOKEN) for external bots.
 * - CSRF protection for the admin panel.
 * 2.  ROBUST CONNECTION LOGIC (from Script 1):
 * - SOCKS5 proxy support (standard and relay modes).
 * - Connection strategy: Attempts a DIRECT connection first.
 * - Fallback/Retry: If the direct connection fails or times out, it retries
 * using the configured SOCKS5 proxy (if enabled) OR the PROXYIP (if set).
 * 3.  TRAFFIC COUNTING (from Script 2):
 * - Accurately tracks both upstream and downstream data usage for all
 * protocols (TCP and UDP/DNS) and updates the D1 database.
 * - This logic is now integrated into Script 1's connection strategy.
 *
 * FIXES & IMPROVEMENTS (v3.2):
 * - [FIX] Corrected 'Uncaught SyntaxError: Unexpected identifier "$"' in 
 * `generateBeautifulConfigPage` by replacing all nested template literals with standard string concatenation.
 * - [FIX] Corrected a syntax error in `socks5Connect` for IPv6 address parsing 
 * (changed 'const-ellipsisIndex' to 'const ellipsisIndex').
 * - [IMPROVEMENT] Enhanced D1/KV binding checks and API error handling robustness.
 *
 * SETUP INSTRUCTIONS:
 * 1.  Create D1 Database, bind as DB.
 * 2.  Run this SQL command in your D1 DB:
 * CREATE TABLE IF NOT EXISTS users (
 * uuid TEXT PRIMARY KEY,
 * created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 * expiration_date TEXT NOT NULL,
 * expiration_time TEXT NOT NULL,
 * notes TEXT,
 * data_limit INTEGER DEFAULT 0,  -- Data limit in bytes
 * data_usage INTEGER DEFAULT 0   -- Data usage in bytes
 * );
 * 3.  Create KV Namespace, bind as USER_KV.
 * 4.  Set Secrets:
 * - ADMIN_KEY: Your admin panel password.
 * - API_TOKEN: (Optional) A secret token for the management API.
 * 5.  Set Variables:
 * - ADMIN_PATH: (Optional) Custom path for admin panel (default: /admin).
 * - UUID: (Optional) A default fallback UUID.
 * - PROXYIP: (Optional) A proxy IP for the *retry* attempt.
 * - SOCKS5: (Optional) SOCKS5 address (e.g., user:pass@host:port).
 * - SOCKS5_RELAY: (Optional) Set to 'true' to force all traffic via SOCKS5.
 * - SCAMALYTICS_USERNAME: (Optional) For config page risk scoring.
 * - SCAMALYTICS_API_KEY: (Optional) For config page risk scoring.
 * - ROOT_PROXY_URL: (Optional) A URL to proxy root path requests to.
 * 6.  [!!! CRITICAL FOR CONNECTION !!!] Add to your wrangler.toml file:
 * [compatibility_flags]
 * sockets = true
 *
 */

import { connect } from 'cloudflare:sockets';

// --- Configuration ---
const Config = {
  userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
  proxyIPs: [], // This is unused if PROXYIP env var is set
  
  // SOCKS5 default config (from Script 1)
  socks5: {
    enabled: false,
    relayMode: false,
    address: '',
  },

  fromEnv(env) {
    let selectedProxyIP = env.PROXYIP;
    if (!selectedProxyIP && this.proxyIPs.length > 0) {
      selectedProxyIP = this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    }
    selectedProxyIP = selectedProxyIP || '';
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');

    return {
      userID: env.UUID || this.userID,
      proxyIP: proxyHost,
      proxyPort: proxyPort,
      proxyAddress: selectedProxyIP,
      adminPath: env.ADMIN_PATH || '/admin',
      apiToken: env.API_TOKEN,
      rootProxyUrl: env.ROOT_PROXY_URL,
      scamalytics: {
        username: env.SCAMALYTICS_USERNAME,
        apiKey: env.SCAMALYTICS_API_KEY,
        baseUrl: 'https://api12.scamalytics.com/v3/',
      },
      // SOCKS5 config (from Script 1)
      socks5: {
        enabled: !!env.SOCKS5,
        relayMode: env.SOCKS5_RELAY === 'true' || this.socks5.relayMode,
        address: env.SOCKS5 || this.socks5.address,
        // parsedSocks5Address will be added in fetch()
      },
    };
  },
};

const CONST = {
  ED_PARAMS: { ed: 2560, eh: 'Sec-WebSocket-Protocol' },
  VLESS_PROTOCOL: 'vless',
  WS_READY_STATE_OPEN: 1,
  WS_READY_STATE_CLOSING: 2,
};

// --- Helper & Utility Functions (from Script 2) ---

/**
 * Validates if a string is a standard RFC4122 UUID.
 */
function isValidUUID(uuid) {
  if (typeof uuid !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Checks if a user's expiration date and time are in the future.
 * @returns {boolean} True if the expiration is in the past (expired).
 */
function isExpired(expDate, expTime) {
  if (!expDate || !expTime) return true;
  // Ensure we have seconds for a valid ISO 8601 string
  const expTimeSeconds = expTime.includes(':') && expTime.split(':').length === 2 ? `${expTime}:00` : expTime;
  const cleanTime = expTimeSeconds.split('.')[0];
  const expDatetimeUTC = new Date(`${expDate}T${cleanTime}Z`);
  return expDatetimeUTC <= new Date();
}

/**
 * Formats bytes into a human-readable string (KB, MB, GB).
 */
function bytesToReadable(bytes) {
  if (bytes <= 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['Bytes', 'KB', 'MB', 'GB', 'TB'][i]}`;
}

/**
 * Retrieves user data, checking KV cache first, then falling back to D1.
 */
async function getUserData(env, uuid, ctx) {
  if (!isValidUUID(uuid)) {
    return null;
  }
  if (!env.DB || !env.USER_KV) {
    console.error("D1 or KV bindings are missing. Cannot fetch user data.");
    return null;
  }
  
  const cacheKey = `user:${uuid}`;
  
  try {
    const cachedData = await env.USER_KV.get(cacheKey, 'json');
    if (cachedData && cachedData.uuid) {
      return cachedData;
    }
  } catch (e) {
    console.error(`Failed to parse cached user data for ${uuid}`, e);
  }

  try {
    const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!userFromDb) {
      return null;
    }

    // Cache expired users longer (e.g., 1 day) to reduce D1 load on repeated checks
    const cacheExpiration = isExpired(userFromDb.expiration_date, userFromDb.expiration_time) ? 86400 : 600; 
    
    // Put to KV without blocking the main request
    if (ctx) {
      ctx.waitUntil(env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: cacheExpiration }));
    } else {
      await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: cacheExpiration });
    }
    
    return userFromDb;
  } catch (e) {
      console.error(`D1 query failed for user ${uuid}:`, e);
      return null;
  }
}

// --- Admin Panel & API (from Script 2) ---

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
        .input-group button:last-child, .input-group select:last-child, .input-group input:last-child { border-top-right-radius: 6px; border-bottom-right-radius: 6px; border-right: 1px solid var(--border); }
        .input-group input:last-child { border-radius: 6px; border-right: 1px solid var(--border); } /* Fix for UUID input */
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
        .btn-copy-uuid { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; margin-left: 4px; }
        .btn-copy-uuid:hover { color: var(--text-primary); }
        @media (max-width: 768px) {
            .container { padding: 0 10px; margin-top: 15px; }
            .stats-grid { grid-template-columns: 1fr 1fr; }
            .user-list-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }
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
                <input type="hidden" id="csrf_token" name="csrf_token">
                <div class="form-group" style="grid-column: 1 / -1;"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div>
                <div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div>
                <div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required></div>
                <div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" placeholder="e.g., 10" min="0"><select id="dataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div>
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
                <div class="form-group"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" placeholder="e.g., 10" min="0"><select id="editDataLimitUnit"><option value="GB">GB</option><option value="MB">MB</option></select><button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button></div></div>
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
            const API_BASE = window.location.pathname + (window.location.pathname.endsWith('/') ? '' : '/') + 'api';
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
                if (isNaN(dt)) return { utcDate: '', utcTime: '' };
                return { 
                    utcDate: \`\${dt.getUTCFullYear()}-\${pad(dt.getUTCMonth() + 1)}-\${pad(dt.getUTCDate())}\`, 
                    utcTime: \`\${pad(dt.getUTCHours())}:\${pad(dt.getUTCMinutes())}:\${pad(dt.getUTCSeconds())}\` 
                };
            };
            const utcToLocal = (d, t) => {
                if (!d || !t) return { localDate: '', localTime: '' };
                const dt = new Date(\`\${d}T\${t}Z\`);
                if (isNaN(dt)) return { localDate: '', localTime: '' };
                return { 
                    localDate: \`\${dt.getFullYear()}-\${pad(dt.getMonth() + 1)}-\${pad(dt.getDate())}\`, 
                    localTime: \`\${pad(dt.getHours())}:\${pad(dt.getMinutes())}:\${pad(dt.getSeconds())}\` 
                };
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
                            <td title="\${user.uuid}">\${user.uuid.substring(0, 8)}...<button class="btn-copy-uuid" title="Copy UUID">📋</button></td>
                            <td>\${new Date(user.created_at).toLocaleString()}</td>
                            <td>\${expiryUTC.toLocaleString()}</td>
                            <td><span class="status-badge \${isExpired ? 'status-expired' : 'status-active' }">\${isExpired ? 'Expired' : 'Active'}</span></td>
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
                } catch (error) { 
                    console.error('Failed to refresh data:', error);
                    showToast(error.message, true); 
                }
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
                const expiryDate = document.getElementById('expiryDate').value;
                const expiryTime = document.getElementById('expiryTime').value;
                const uuid = document.getElementById('uuid').value;

                if (!uuid || !expiryDate || !expiryTime) {
                    showToast('UUID, Expiry Date, and Expiry Time are all required.', true);
                    return;
                }
                
                const { utcDate, utcTime } = localToUTC(expiryDate, expiryTime);
                if (!utcDate) {
                    showToast('Invalid local date or time entered.', true);
                    return;
                }

                const userData = {
                    uuid: uuid,
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
                } catch (error) { 
                    showToast(error.message, true); 
                }
            });
            
            const editModal = document.getElementById('editModal');
            document.getElementById('userList').addEventListener('click', e => {
                const button = e.target.closest('button');
                if (!button) return;
                const row = e.target.closest('tr');
                if (!row) return;
                const uuid = row.dataset.uuid;

                if (button.classList.contains('btn-copy-uuid')) {
                    navigator.clipboard.writeText(uuid);
                    showToast('UUID copied to clipboard');
                } else if (button.classList.contains('btn-edit')) {
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
                
                if (!utcDate) {
                    showToast('Invalid local date or time entered.', true);
                    return;
                }

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

/**
 * Middleware to check admin authentication and CSRF token.
 */
async function checkAdminAuth(request, env, cfg) {
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

/**
 * Handles a robust catch for API endpoints.
 */
function handleApiError(e, context = '') {
  console.error(`API Error${context ? ` (${context})` : ''}:`, JSON.stringify(e, null, 2));
  let errorMsg = 'An unexpected error occurred. Check worker logs for details.';

  if (e instanceof Error) {
    errorMsg = e.message;
  } else if (typeof e === 'string') {
    errorMsg = e;
  } else if (typeof e === 'object' && e !== null && e.message) {
    errorMsg = String(e.message); 
    if (e.cause?.message) {
        errorMsg += `: ${e.cause.message}`;
    }
  }
  
  if (errorMsg.includes('UNIQUE constraint failed')) {
    errorMsg = 'UUID already exists in the database.';
  } else if (errorMsg.includes('not iterable')) {
    errorMsg = 'Database binding error: "(intermediate value) is not iterable". Please check worker logs.';
  } else if (errorMsg.includes('attempt to write a readonly database')) {
    errorMsg = 'Database is read-only. Check your D1 binding permissions.';
  }
  
  return new Response(JSON.stringify({ error: errorMsg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Handles all incoming requests to /admin/* routes.
 */
async function handleAdminRequest(request, env, cfg, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const jsonHeader = { 'Content-Type': 'application/json' };

  if (!env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Admin panel is not configured. Please set ADMIN_KEY secret.' }), { status: 503, headers: jsonHeader });
  }
  if (!env.DB || !env.USER_KV) {
    return new Response(JSON.stringify({ error: 'Admin panel is not fully configured. Please ensure D1 (DB) and KV (USER_KV) bindings are set.' }), { status: 503, headers: jsonHeader });
  }

  const cleanAdminPath = cfg.adminPath.endsWith('/') ? cfg.adminPath.slice(0, -1) : cfg.adminPath;
  const apiBasePath = `${cleanAdminPath}/api`;
  
  // --- API Routes (/admin/api/*) ---
  if (pathname.startsWith(apiBasePath)) {
    const { isAdmin, errorResponse } = await checkAdminAuth(request, env, cfg);
    if (errorResponse) return errorResponse;
    if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });

    const apiPath = pathname.substring(apiBasePath.length);

    // GET /admin/api/stats
    if (apiPath === '/stats' && request.method === 'GET') {
      try {
        const stats = await env.DB.prepare(
          "SELECT COUNT(*) as totalUsers, " +
          "SUM(CASE WHEN DATETIME(expiration_date || 'T' || expiration_time || 'Z') > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) as activeUsers, " +
          "SUM(CASE WHEN DATETIME(expiration_date || 'T' || expiration_time || 'Z') <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) as expiredUsers, " +
          "SUM(data_usage) as totalTraffic " +
          "FROM users"
        ).first();
        
        return new Response(JSON.stringify({
          totalUsers: stats?.totalUsers || 0,
          activeUsers: stats?.activeUsers || 0,
          expiredUsers: stats?.expiredUsers || 0,
          totalTraffic: stats?.totalTraffic || 0
        }), { status: 200, headers: jsonHeader });
      } catch (e) {
        return handleApiError(e, 'GET /stats');
      }
    }
    
    // GET /admin/api/users
    if (apiPath === '/users' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
        return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
      } catch (e) {
        return handleApiError(e, 'GET /users');
      }
    }

    // POST /admin/api/users
    if (apiPath === '/users' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { uuid, exp_date, exp_time } = body;
        const notes_to_bind = body.notes || null;
        // Ensure data_limit is a non-negative integer or default to 0
        const data_limit_to_bind = (typeof body.data_limit === 'number' && body.data_limit >= 0) ? Math.round(body.data_limit) : 0;

        if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) {
          throw new Error('Invalid or missing fields. (uuid, exp_date, exp_time are required and must be a valid UUID).');
        }

        await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, data_limit, data_usage) VALUES (?, ?, ?, ?, ?, 0)")
          .bind(uuid, exp_date, exp_time, notes_to_bind, data_limit_to_bind).run();
          
        // Invalidate KV cache for the new user immediately (though unlikely to exist)
        ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`));
          
        return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
      } catch (e) {
        return handleApiError(e, 'POST /users');
      }
    }

    const userRouteMatch = apiPath.match(/^\/users\/([a-f0-9-]+)$/);
    if (userRouteMatch) {
      const uuid = userRouteMatch[1];
      // PUT /admin/api/users/:uuid
      if (request.method === 'PUT') {
          try {
            const body = await request.json();
            const { exp_date, exp_time } = body;
            const notes_to_bind = body.notes || null;
            const data_limit_to_bind = (typeof body.data_limit === 'number' && body.data_limit >= 0) ? Math.round(body.data_limit) : 0;
            const reset_traffic = body.reset_traffic || false;

            if (!exp_date || !exp_time) throw new Error('Invalid date/time fields.');

            const sql = `UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ? ${reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?`;
            const result = await env.DB.prepare(sql).bind(exp_date, exp_time, notes_to_bind, data_limit_to_bind, uuid).run();
            
            if (result.changes === 0) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: jsonHeader });

            ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`)); 
            
            return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
        } catch (e) {
            return handleApiError(e, `PUT /users/${uuid}`);
        }
      }
      // DELETE /admin/api/users/:uuid
      if (request.method === 'DELETE') {
        try {
          const result = await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
          if (result.changes === 0) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: jsonHeader });
          ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`)); 
          return new Response(null, { status: 204 });
        } catch (e) {
          return handleApiError(e, `DELETE /users/${uuid}`);
        }
      }
    }
    return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
  }

  // --- Page Serving Routes (/admin) ---
  if (pathname === cfg.adminPath) {
    if (request.method === 'POST') {
      const cookieHeader = request.headers.get('Cookie');
      const loginCsrfToken = cookieHeader?.match(/login_csrf_token=([^;]+)/)?.[1];
      const formData = await request.formData();
      const formCsrfToken = formData.get('csrf_token');

      // Check CSRF token for login form
      if (!loginCsrfToken || !formCsrfToken || loginCsrfToken !== formCsrfToken) {
        const errorHtml = adminLoginHTML.replace('</form>', '</form><p class="error">Invalid session or request. Please try again.</p>');
        const headers = new Headers({ 'Content-Type': 'text/html;charset=utf-8' });
        // Clear old login CSRF token
        headers.append('Set-Cookie', `login_csrf_token=; Path=${cfg.adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        return new Response(errorHtml, { status: 403, headers });
      }

      if (formData.get('password') === env.ADMIN_KEY) {
        const sessionToken = crypto.randomUUID();
        const csrfToken = crypto.randomUUID();
        // Store session token and CSRF token (valid for 24 hours)
        ctx.waitUntil(env.USER_KV.put(`admin_session:${sessionToken}`, JSON.stringify({ csrfToken }), { expirationTtl: 86400 }));
        
        const headers = new Headers({
          'Location': cfg.adminPath,
          // Set new auth cookie
          'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=${cfg.adminPath}; Max-Age=86400; SameSite=Strict`
        });
        // Clear login CSRF token
        headers.append('Set-Cookie', `login_csrf_token=; Path=${cfg.adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        
        return new Response(null, { status: 302, headers });
      } else {
        const headers = new Headers({ 'Content-Type': 'text/html;charset=utf-8' });
        // Clear login CSRF token to force a fresh login attempt
        headers.append('Set-Cookie', `login_csrf_token=; Path=${cfg.adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        return new Response(adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers });
      }
    }
    
    if (request.method === 'GET') {
      const { isAdmin, csrfToken, errorResponse } = await checkAdminAuth(request, env, cfg);
      if (errorResponse) return errorResponse;
      
      if (isAdmin) {
        // Serve admin panel with current CSRF token embedded
        const panelWithCsrf = adminPanelHTML
          .replace(
            '<input type="hidden" id="csrf_token" name="csrf_token">',
            `<input type="hidden" id="csrf_token" name="csrf_token" value="${csrfToken}">`
          );
        return new Response(panelWithCsrf, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      } else {
        // Serve login page with a new login CSRF token
        const loginCsrfToken = crypto.randomUUID();
        const loginHtmlWithCsrf = adminLoginHTML.replace(
          '</form>',
          `<input type="hidden" name="csrf_token" value="${loginCsrfToken}"></form>`
        );
        const headers = new Headers({ 'Content-Type': 'text/html;charset=utf-8' });
        headers.append('Set-Cookie', `login_csrf_token=${loginCsrfToken}; HttpOnly; Secure; Path=${cfg.adminPath}; Max-Age=600; SameSite=Strict`);
        
        return new Response(loginHtmlWithCsrf, { headers });
      }
    }
    return new Response('Method Not Allowed', { status: 405 });
  }
  return new Response('Not found', { status: 404 });
}


// --- NEW: Management API (from Script 2) ---

/**
 * Handles requests to the external management API.
 */
async function handleManagementAPI(request, env, cfg, ctx) {
  const jsonHeader = { 'Content-Type': 'application/json' };
  
  if (!cfg.apiToken || request.headers.get('Authorization') !== `Bearer ${cfg.apiToken}`) {
    return new Response(JSON.stringify({ error: 'Forbidden: Invalid API Token.' }), { status: 403, headers: jsonHeader });
  }
  if (!env.DB || !env.USER_KV) {
    return new Response(JSON.stringify({ error: 'Service is partially configured. Missing D1 (DB) or KV (USER_KV) bindings.' }), { status: 503, headers: jsonHeader });
  }
  
  const url = new URL(request.url);
  const userRouteMatch = url.pathname.match(/^\/api\/v1\/users\/([a-f0-9-]+)$/);

  // GET /api/v1/users
  if (url.pathname === '/api/v1/users' && request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare("SELECT * FROM users").all();
      return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
    } catch (e) {
      return handleApiError(e, 'GET /api/v1/users');
    }
  }

  // POST /api/v1/users
  if (url.pathname === '/api/v1/users' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { uuid, exp_date, exp_time } = body;

      if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) {
        throw new Error('Invalid or missing fields. (uuid, exp_date, exp_time are required and must be a valid UUID).');
      }

      const notes_to_bind = body.hasOwnProperty('notes') ? (body.notes || null) : null;
      let data_limit = 0;
      // Convert GB/MB limits to bytes. Priority: GB > MB > 0 (unlimited)
      if (typeof body.data_limit_gb === 'number' && body.data_limit_gb >= 0) {
        data_limit = Math.round(body.data_limit_gb * 1024 * 1024 * 1024);
      } else if (typeof body.data_limit_mb === 'number' && body.data_limit_mb >= 0) {
        data_limit = Math.round(body.data_limit_mb * 1024 * 1024);
      }
     
      await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, data_limit, data_usage) VALUES (?, ?, ?, ?, ?, 0)")
        .bind(uuid, exp_date, exp_time, notes_to_bind, data_limit).run();
        
      ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`)); // Invalidate cache

      const user = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
      return new Response(JSON.stringify(user), { status: 201, headers: jsonHeader });
    } catch (e) {
      return handleApiError(e, 'POST /api/v1/users');
    }
  }

  if (userRouteMatch) {
    const uuid = userRouteMatch[1];
    
    // GET /api/v1/users/:uuid
    if (request.method === 'GET') {
      try {
        const user = await getUserData(env, uuid, ctx);
        if (!user) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: jsonHeader });
        return new Response(JSON.stringify(user), { status: 200, headers: jsonHeader });
      } catch (e) {
        return handleApiError(e, `GET /api/v1/users/${uuid}`);
      }
    }
    
    // DELETE /api/v1/users/:uuid
    if (request.method === 'DELETE') {
      try {
        const result = await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
        if (result.changes === 0) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: jsonHeader });
        ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`));
        return new Response(null, { status: 204 });
      } catch (e) {
        return handleApiError(e, `DELETE /api/v1/users/${uuid}`);
      }
    }
    
    // PUT /api/v1/users/:uuid
    if (request.method === 'PUT') {
      try {
        const user = await getUserData(env, uuid, ctx); // Use cached getter first to get current state
        if (!user) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: jsonHeader });
        
        const body = await request.json();
        
        // Use existing values if not provided in the request
        const exp_date = body.exp_date || user.expiration_date;
        const exp_time = body.exp_time || user.expiration_time;
        const notes_to_bind = body.hasOwnProperty('notes') ? (body.notes || null) : user.notes;
        
        let data_limit = user.data_limit;
        // Check for new limits. Same logic as POST: GB > MB > current limit.
        if (typeof body.data_limit_gb === 'number' && body.data_limit_gb >= 0) {
          data_limit = Math.round(body.data_limit_gb * 1024 * 1024 * 1024);
        } else if (typeof body.data_limit_mb === 'number' && body.data_limit_mb >= 0) {
          data_limit = Math.round(body.data_limit_mb * 1024 * 1024);
        }
        
        const sql = `UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ? ${body.reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?`;
        const result = await env.DB.prepare(sql).bind(exp_date, exp_time, notes_to_bind, data_limit, uuid).run();
        
        if (result.changes === 0) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: jsonHeader });

        ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`)); // Invalidate cache
        
        const updatedUser = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
        return new Response(JSON.stringify(updatedUser), { status: 200, headers: jsonHeader });
      } catch (e) {
        return handleApiError(e, `PUT /api/v1/users/${uuid}`);
      }
    }
  }

  return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
}

// --- Core VLESS & Subscription Logic (Merged) ---

// UUID helper functions (from Script 1)
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return (
    byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' +
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' +
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' +
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' +
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  ).toLowerCase();
}
function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) throw new TypeError('Stringified UUID is invalid');
  return uuid;
}


// --- Subscription Generation (from Script 1 / 2) ---
function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
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

function makeName(tag, proto) { return `${tag}-${proto.toUpperCase()}`; }

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path, });
  if (security) params.set('security', security);
  if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp);
  if (alpn) params.set('alpn', alpn);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildLink({ core, proto, userID, hostName, address, port, tag }) {
  const p = CORE_PRESETS[core][proto];
  return createVlessLink({
    userID, address, port, host: hostName, path: p.path(), security: p.security,
    sni: p.security === 'tls' ? hostName : undefined, fp: p.fp, alpn: p.alpn, extra: p.extra, name: makeName(tag, proto),
  });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [
    hostName, 'creativecommons.org', 'www.speedtest.net',
    'sky.rethinkdns.com', 'cfip.1323123.xyz',
    'go.inmobi.com', 'www.visa.com',
    'cf.090227.xyz', 'cdnjs.com', 'zula.ir',
  ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
  let links = [];
  const isPagesDeployment = hostName.endsWith('.pages.dev');

  mainDomains.forEach((domain, i) => {
    links.push(
      buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i+1}` })
    );
    if (!isPagesDeployment) {
      links.push(
        buildLink({ core, proto: 'tcp', userID, hostName, address: domain, port: pick(httpPorts), tag: `D${i+1}` })
      );
    }
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json');
    if (r.ok) {
      const json = await r.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
      ips.forEach((ip, i) => {
        const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
        links.push( buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i+1}` }) );
        if (!isPagesDeployment) {
          links.push( buildLink({ core, proto: 'tcp', userID, hostName, address: formattedAddress, port: pick(httpPorts), tag: `IP${i+1}` }) );
        }
      });
    }
  } catch (e) { console.error('Fetch IP list failed', e); }

  return new Response(btoa(links.join('\n')), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}

// --- SOCKS5 Logic (from Script 1) ---

/**
 * Parses SOCKS5 address string.
 */
function socks5AddressParser(address) {
  try {
    const [authPart, hostPart] = address.includes('@') ? address.split('@') : [null, address];
    const [hostname, portStr] = hostPart.split(':');
    const port = parseInt(portStr, 10);
    if (!hostname || isNaN(port)) throw new Error();

    let username, password;
    if (authPart) {
      [username, password] = authPart.split(':');
      if (!username) throw new Error();
    }
    return { username, password, hostname, port };
  } catch {
    throw new Error('Invalid SOCKS5 address format. Expected [user:pass@]host:port');
  }
}

/**
 * Establishes a connection through a SOCKS5 proxy.
 */
async function socks5Connect(addressType, addressRemote, portRemote, log, parsedSocks5Addr) {
  const { username, password, hostname, port } = parsedSocks5Addr;
  log(`Connecting to SOCKS5 proxy at ${hostname}:${port}`);
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();

  // SOCKS5 greeting
  await writer.write(new Uint8Array([5, 2, 0, 2])); // SOCKS5, 2 auth methods (0: No auth, 2: User/Pass)
  let res = (await reader.read()).value;
  if (res[0] !== 0x05) throw new Error('SOCKS5 server connection failed (version).');
  if (res[1] === 0xff) throw new Error('SOCKS5 server requires an auth method we dont support.');

  if (res[1] === 0x02) {
    // Auth required
    log('SOCKS5 authentication required.');
    if (!username || !password) throw new Error('SOCKS5 auth credentials not provided.');
    const authRequest = new Uint8Array([
      1,
      username.length,
      ...encoder.encode(username),
      password.length,
      ...encoder.encode(password),
    ]);
    await writer.write(authRequest);
    res = (await reader.read()).value;
    if (res[0] !== 0x01 || res[1] !== 0x00) throw new Error('SOCKS5 authentication failed.');
    log('SOCKS5 authentication successful.');
  } else if (res[1] !== 0x00) {
      throw new Error(`SOCKS5 server selected unsupported auth method: ${res[1]}`);
  }

  let DSTADDR;
  switch (addressType) {
    case 1: // IPv4
      DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]);
      break;
    case 2: // Domain
      DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]);
      break;
    case 3: // IPv6
      const ipv6Parts = addressRemote.split(':');
      const ipv6Bytes = [];
      if (ipv6Parts.includes('')) {
          // *** FIX (v3.1): Corrected syntax error 'const-ellipsisIndex' to 'const ellipsisIndex' ***
          const ellipsisIndex = ipv6Parts.indexOf('');
          const partsBefore = ipv6Parts.slice(0, ellipsisIndex);
          const partsAfter = ipv6Parts.slice(ellipsisIndex + 1);
          
          partsBefore.forEach(part => {
              const hex = part.padStart(4, '0');
              ipv6Bytes.push(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16));
          });
          
          const missingParts = 8 - partsBefore.length - partsAfter.length;
          for (let i = 0; i < missingParts; i++) {
              ipv6Bytes.push(0, 0);
          }
          
          partsAfter.forEach(part => {
              const hex = part.padStart(4, '0');
              ipv6Bytes.push(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16));
          });
      } else {
          ipv6Parts.forEach(part => {
              const hex = part.padStart(4, '0');
              ipv6Bytes.push(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16));
          });
      }
      DSTADDR = new Uint8Array([4, ...ipv6Bytes]);
      break;
    default:
      throw new Error(`Invalid addressType for SOCKS5: ${addressType}`);
  }

  // SOCKS5 request
  const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
  await writer.write(socksRequest);
  res = (await reader.read()).value;
  if (res[1] !== 0x00) throw new Error(`SOCKS5 connection failed: status ${res[1]}`);
  log(`SOCKS5 tunnel established to ${addressRemote}:${portRemote}`);

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

// --- Main Fetch Handler ---

export default {
  async fetch(request, env, ctx) {
    const cfg = Config.fromEnv(env);
    const url = new URL(request.url);

    // --- 1. Admin Panel Routing ---
    if (url.pathname.startsWith(cfg.adminPath)) {
      return handleAdminRequest(request, env, cfg, ctx);
    }
    
    // --- 2. Management API Routing ---
    if (cfg.apiToken && url.pathname.startsWith('/api/v1/')) {
      return handleManagementAPI(request, env, cfg, ctx);
    }

    // --- 3. WebSocket/VLESS Protocol Handling ---
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      if (!env.DB || !env.USER_KV) {
          return new Response(JSON.stringify({ error: 'VLESS proxy is not fully configured. Missing D1 or KV bindings.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      // MERGE: Add parsed SOCKS5 address to cfg
      if (cfg.socks5.enabled) {
        try {
          cfg.socks5.parsedSocks5Address = socks5AddressParser(cfg.socks5.address);
        } catch (e) {
          console.error("Invalid SOCKS5 configuration:", e.message);
          return new Response(JSON.stringify({ error: 'Invalid SOCKS5 configuration. Check worker variables.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }
      
      return ProtocolOverWSHandler(request, env, ctx, cfg);
    }
    
    // --- 4. Network Info API (for config page) ---
    if (url.pathname === '/network-info') {
      return handleNetworkInfoRequest(request, env, cfg, ctx);
    }

    // --- 5. Subscription & Config Page Handling ---
    const handleSubscription = async (core) => {
      const uuid = url.pathname.slice(`/${core}/`.length);
      const userData = await getUserData(env, uuid, ctx);
      
      // Validation (Expiry & Data Limit) (from Script 2)
      if (!userData || isExpired(userData.expiration_date, userData.expiration_time)) {
        return new Response('Invalid or expired user', { status: 403 });
      }
      if (userData.data_limit > 0 && userData.data_usage >= userData.data_limit) {
        return new Response('Data limit reached', { status: 403 });
      }
      
      return handleIpSubscription(core, uuid, url.hostname);
    };

    if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
    if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

    // --- 6. Config Page handling (main route) ---
    const path = url.pathname.slice(1);
    if (isValidUUID(path)) {
      const userData = await getUserData(env, path, ctx);
      // Even if expired/limit reached, we show the config page but with warnings
      if (!userData) {
        return new Response('Invalid user ID', { status: 403 });
      }
      
      return handleConfigPage(path, url.hostname, cfg.proxyAddress, userData, request.headers.get('CF-Connecting-IP'), env, cfg, ctx);
    }

    // --- 7. Root Proxy ---
    if (cfg.rootProxyUrl) {
      try {
        const proxyUrl = new URL(cfg.rootProxyUrl);
        const targetUrl = new URL(request.url);
        targetUrl.hostname = proxyUrl.hostname;
        targetUrl.protocol = proxyUrl.protocol;
        targetUrl.port = proxyUrl.port;
        // The original request object should be used, but with the modified URL
        const newRequest = new Request(targetUrl.toString(), {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: 'follow'
        });
        // Override Host header to match the destination
        newRequest.headers.set('Host', proxyUrl.hostname);
        newRequest.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || 'unknown');
        newRequest.headers.set('X-Forwarded-Proto', 'https');
        
        const response = await fetch(newRequest);
        
        // Remove security headers that might block embedding or client use
        const mutableHeaders = new Headers(response.headers);
        mutableHeaders.delete('Content-Security-Policy');
        mutableHeaders.delete('X-Frame-Options');
        mutableHeaders.delete('X-XSS-Protection');
        
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: mutableHeaders });
      } catch (e) {
        return new Response(`Proxy error: ${e.message}`, { status: 502 });
      }
    }
    
    return new Response('Not found.', { status: 404 });
  },
};

// --- Merged Protocol Handler (Script 2 Core + Script 1 Logic) ---

/**
 * Handles the VLESS WebSocket connection, validates the user, and counts traffic.
 */
async function ProtocolOverWSHandler(request, env, ctx, cfg) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let address = '';
  let portWithRandomLog = '';
  let sessionUsage = 0;
  let userUUID = '';
  let udpStreamWriter = null;

  const log = (info, event) => console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  
  const updateUsageInDB = async () => {
    // Only update if we have a UUID and some data was transferred
    if (sessionUsage > 0 && userUUID) {
      const finalUsage = Math.round(sessionUsage); // Round to avoid floating point issues
      try {
        await env.DB.prepare("UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?")
          .bind(finalUsage, userUUID)
          .run();
        ctx.waitUntil(env.USER_KV.delete(`user:${userUUID}`));
        log(`Updated usage for ${userUUID} by ${finalUsage} bytes.`);
      } catch (err) {
        console.error(`Failed to update usage for ${userUUID}:`, err);
      }
    }
  };
  
  // Schedule the usage update when the WebSocket closes or errors
  ctx.waitUntil(new Promise(resolve => {
    const cleanup = () => {
      // updateUsageInDB is asynchronous, so we resolve the Promise after it completes
      updateUsageInDB().finally(resolve);
    };
    webSocket.addEventListener('close', cleanup, { once: true });
    webSocket.addEventListener('error', cleanup, { once: true });
  }));

  const createUsageCountingTransform = () => {
    return new TransformStream({
      transform(chunk, controller) {
        // Increment the usage counter for this session
        sessionUsage += chunk.byteLength;
        controller.enqueue(chunk);
      }
    });
  };
  // Downstream (client -> proxy): client sends VLESS header + data
  const usageCounterDownstream = createUsageCountingTransform(); 
  // Upstream (proxy -> client): proxy sends VLESS response header + data
  const usageCounterUpstream = createUsageCountingTransform();   

  const earlyDataHeader = request.headers.get(CONST.ED_PARAMS.eh) || '';
  const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = { value: null };

  // This is the main pipeline (client data flow)
  readableWebSocketStream
    .pipeThrough(usageCounterDownstream)
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          // If this is a follow-up UDP packet (DNS), route to the DNS handler
          if (udpStreamWriter) {
            return udpStreamWriter.write(chunk);
          }
          
          // If TCP tunnel is established, write to it
          if (remoteSocketWapper.value) {
            try {
                const writer = remoteSocketWapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
            } catch (e) {
                console.error("Error writing to remote socket:", e);
                controller.error(e);
            }
            return;
          }

          // If this is the *first* chunk, process the VLESS header
          const {
            user,
            hasError,
            message,
            addressType,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            ProtocolVersion = new Uint8Array([0, 0]),
            isUDP,
          } = await ProcessProtocolHeader(chunk, env, ctx);

          if (hasError) {
            controller.error(new Error(message));
            return;
          }
          if (!user) {
            controller.error(new Error('User not found.'));
            return;
          }
          
          userUUID = user.uuid;
          
          // Access Control Check (can be done here as a strict enforcement)
          if (isExpired(user.expiration_date, user.expiration_time)) {
            controller.error(new Error('User expired.'));
            return;
          }
          // The usage check here uses the current usage + what was just piped (downstream).
          if (user.data_limit > 0 && (user.data_usage + sessionUsage) >= user.data_limit) {
            controller.error(new Error('Data limit reached.'));
            return;
          }

          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}`;
          
          // VLESS response header (00 00 for success)
          const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isUDP) {
            // UDP is only for DNS over HTTPS (DoH) for simplicity/security
            if (portRemote === 53) {
              // Pass the usage update function to the DNS handler
              const updateUpstreamUsage = (bytes) => { sessionUsage += bytes; };
              const dnsPipeline = await createDnsPipeline(webSocket, vlessResponseHeader, log, updateUpstreamUsage);
              udpStreamWriter = dnsPipeline.write;
              await udpStreamWriter(rawClientData);
            } else {
              controller.error(new Error('UDP proxy only supports DNS (port 53) via DoH.'));
            }
            return;
          }

          // TCP connection
          HandleTCPOutBound(
            remoteSocketWapper,
            addressType,
            addressRemote,
            portRemote,
            rawClientData,
            webSocket,
            vlessResponseHeader,
            log,
            cfg, 
            usageCounterUpstream 
          );
        },
        close() {
          log('readableWebSocketStream closed');
        },
        abort(err) {
          log('readableWebSocketStream aborted', err);
        },
      }),
    )
    .catch(err => {
      console.error('Pipeline failed:', err.stack || err);
      // Close the WebSocket to terminate the connection gracefully
      safeCloseWebSocket(webSocket);
    });

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Processes the VLESS header from the client. (from Script 2)
 */
async function ProcessProtocolHeader(protocolBuffer, env, ctx) {
  if (protocolBuffer.byteLength < 17) return { hasError: true, message: 'invalid data: buffer too short for UUID' };
  const dataView = new DataView(protocolBuffer.buffer);
  const version = dataView.getUint8(0);
  
  let uuid;
  try {
    uuid = stringify(new Uint8Array(protocolBuffer.slice(1, 17)));
  } catch (e) {
    return { hasError: true, message: 'invalid UUID format' };
  }
  
  const userData = await getUserData(env, uuid, ctx);
  if (!userData) {
    return { hasError: true, message: 'invalid user' };
  }
  
  const payloadStart = 17;
  if (protocolBuffer.byteLength < payloadStart + 1) return { hasError: true, message: 'invalid data length (payload start)' };
  
  const optLength = dataView.getUint8(payloadStart);
  
  const commandIndex = payloadStart + 1 + optLength;
  if (protocolBuffer.byteLength < commandIndex + 1) return { hasError: true, message: 'invalid data length (command)' };
  const command = dataView.getUint8(commandIndex);
  if (command !== 1 && command !== 2) return { hasError: true, message: `command ${command} is not supported (only TCP=1, UDP=2)` };

  const portIndex = commandIndex + 1;
  if (protocolBuffer.byteLength < portIndex + 2) return { hasError: true, message: 'invalid data length (port)' };
  const portRemote = dataView.getUint16(portIndex, false); // VLESS ports are Network Byte Order (Big-endian)

  const addressTypeIndex = portIndex + 2;
  if (protocolBuffer.byteLength < addressTypeIndex + 1) return { hasError: true, message: 'invalid data length (address type)' };
  const addressType = dataView.getUint8(addressTypeIndex);
  
  let addressValue, addressLength, addressValueIndex;

  switch (addressType) {
    case 1: // IPv4 (4 bytes)
      addressLength = 4;
      addressValueIndex = addressTypeIndex + 1;
      if (protocolBuffer.byteLength < addressValueIndex + addressLength) return { hasError: true, message: 'invalid data length (ipv4)' };
      addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain (1 byte for length + domain)
      addressLength = dataView.getUint8(addressTypeIndex + 1);
      addressValueIndex = addressTypeIndex + 2;
      if (protocolBuffer.byteLength < addressValueIndex + addressLength) return { hasError: true, message: 'invalid data length (domain)' };
      addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6 (16 bytes)
      addressLength = 16;
      addressValueIndex = addressTypeIndex + 1;
      if (protocolBuffer.byteLength < addressValueIndex + addressLength) return { hasError: true, message: 'invalid data length (ipv6)' };
      // Format 16 bytes into standard IPv6 notation
      addressValue = Array.from({ length: 8 }, (_, i) => dataView.getUint16(addressValueIndex + i * 2, false).toString(16)).join(':');
      break;
    default:
      return { hasError: true, message: `invalid addressType: ${addressType}` };
  }

  const rawDataIndex = addressValueIndex + addressLength;
  if (protocolBuffer.byteLength < rawDataIndex) return { hasError: true, message: 'invalid data length (raw data)' };

  return {
    user: userData, 
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex,
    ProtocolVersion: new Uint8Array([version]),
    isUDP: command === 2,
  };
}


/**
 * MERGED HandleTCPOutBound
 * This is the connection logic from Script 1 (direct-first, then proxy/socks retry)
 * ...but adapted to accept cfg and usageCounterUpstream from Script 2.
 */
async function HandleTCPOutBound(
  remoteSocket,
  addressType,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  protocolResponseHeader,
  log,
  cfg, // This now contains PROXYIP and SOCKS5 info
  usageCounterUpstream // This is for traffic counting
) {
  
  // This is Script 1's connectAndWrite, using cfg instead of config
  async function connectAndWrite(address, port, socks = false) {
    let tcpSocket;
    if (cfg.socks5.relayMode && cfg.socks5.enabled) {
      log(`SOCKS5 Relay: connecting to ${address}:${port}`);
      // Use socks5Connect for all traffic in relay mode
      tcpSocket = await socks5Connect(addressType, address, port, log, cfg.socks5.parsedSocks5Address);
    } else {
      tcpSocket = socks && cfg.socks5.enabled
        ? await socks5Connect(addressType, address, port, log, cfg.socks5.parsedSocks5Address)
        : connect({ hostname: address, port: port });
    }
    
    // Store the socket for subsequent writes in the WritableStream
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port} (SOCKS: ${socks || cfg.socks5.relayMode})`);
    
    // Write the initial client data
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  // Define the retry function which tries SOCKS5 or PROXYIP
  async function retry() {
    log('Retrying connection...');
    let tcpSocket;
    
    try {
        if (cfg.socks5.enabled && !cfg.socks5.relayMode) {
            // Try SOCKS5 first (non-relay mode)
            tcpSocket = await connectAndWrite(addressRemote, portRemote, true); 
        } else if (cfg.proxyIP) {
            // Fallback to PROXYIP if SOCKS5 is not enabled (and not in relay mode)
             tcpSocket = await connectAndWrite( 
                cfg.proxyIP,
                cfg.proxyPort || portRemote,
                false,
            );
        } else {
             throw new Error('No proxy or fallback IP configured for retry.');
        }

        // Close WebSocket if the TCP socket itself closes
        tcpSocket.closed
            .catch(error => { console.log('retry tcpSocket closed error', error); })
            .finally(() => { safeCloseWebSocket(webSocket); });
        
        // Pipe remote response back to the WebSocket
        RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, usageCounterUpstream);
        
    } catch (e2) {
        log(`Retry connection failed: ${e2.message}`);
        safeCloseWebSocket(webSocket);
    }
  }

  // --- Initial Attempt ---
  if (cfg.socks5.relayMode && cfg.socks5.enabled) {
    // If relay mode, skip direct and go straight to SOCKS5
    log(`SOCKS5 RELAY MODE: connecting to ${addressRemote}:${portRemote} via SOCKS5.`);
    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote, true);
        tcpSocket.closed
            .catch(error => { console.log('relay tcpSocket closed error', error); })
            .finally(() => { safeCloseWebSocket(webSocket); });

        RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, usageCounterUpstream);
    } catch (e) {
        log(`SOCKS5 RELAY failed: ${e.message}`);
        safeCloseWebSocket(webSocket);
    }
  } else {
    // Attempt direct connection first (or PROXYIP if set as primary)
    const primaryAddress = cfg.proxyIP || addressRemote;
    const primaryPort = cfg.proxyIP ? cfg.proxyPort : portRemote;

    log(`Attempting direct connection to ${primaryAddress}:${primaryPort}`);
    try {
        const tcpSocket = await connectAndWrite(primaryAddress, primaryPort, false);
        
        tcpSocket.closed
            .catch(error => { console.log('direct tcpSocket closed error', error); })
            .finally(() => { safeCloseWebSocket(webSocket); });
            
        // Pass the retry function only for the direct attempt
        RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, retry, log, usageCounterUpstream);
    
    } catch (e) {
        // If direct connection fails AND PROXYIP was not used (i.e., we tried the target), call retry()
        // OR if PROXYIP was used but failed, call retry() for SOCKS5
        if (!cfg.proxyIP || (cfg.proxyIP && cfg.socks5.enabled)) {
            log(`Direct connection failed: ${e.message}. Calling retry().`);
            retry(); 
        } else {
             // If we used PROXYIP and SOCKS5 is NOT enabled, we have no fallback.
             log(`Direct connection to PROXYIP failed and no SOCKS5 configured: ${e.message}`);
             safeCloseWebSocket(webSocket);
        }
    }
  }
}

/**
 * Creates a readable stream from a WebSocket. (from Script 1)
 */
function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
          // If we receive an ArrayBuffer, enqueue it
          if (event.data instanceof ArrayBuffer) {
              controller.enqueue(event.data);
          } else if (typeof event.data === 'string') {
               // Handle string messages if necessary (unlikely for VLESS)
              console.warn("Received unexpected string message on VLESS WebSocket:", event.data);
          } else {
               // Assuming Blob/other object type that needs conversion
               // For VLESS, it should typically be ArrayBuffer or Buffer
               console.warn("Received unexpected message type on VLESS WebSocket.");
          }
      });
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error');
        controller.error(err);
      });
      
      // Handle Early Data
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    pull(_controller) { },
    cancel(reason) {
      log(`ReadableStream was canceled, due to ${reason}`);
      safeCloseWebSocket(webSocketServer);
    },
  });
}

/**
 * Pipes data from the remote socket to the WebSocket. (from Script 2, supports traffic counting)
 */
async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log, usageCounterUpstream) {
  let hasIncomingData = false;
  try {
    // Pipe remote socket data -> usage counter -> WebSocket writable stream
    await remoteSocket.readable.pipeThrough(usageCounterUpstream).pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN)
            throw new Error('WebSocket is not open');
          hasIncomingData = true;
          
          // Prepend VLESS response header (00 00) only to the first chunk
          const dataToSend = protocolResponseHeader
            ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer()
            : chunk;
            
          webSocket.send(dataToSend);
          protocolResponseHeader = null; // Ensure header is only sent once
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
  }
  
  // This is Script 1's retry logic: if no data, try again (only applicable if a retry function was provided)
  if (!hasIncomingData && retry) {
    log('No incoming data received from primary connection, attempting retry.');
    retry();
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    // Correct Base64URL to Base64 conversion
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = new ArrayBuffer(binaryStr.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryStr.length; i++) {
      view[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: buffer, error: null };
  } catch (error) {
    console.error("Base64 decoding failed:", error);
    return { earlyData: null, error };
  }
}

function safeCloseWebSocket(socket) {
  try {
    if (
      socket.readyState === CONST.WS_READY_STATE_OPEN ||
      socket.readyState === CONST.WS_READY_STATE_CLOSING
    ) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error:', error);
  }
}

/**
 * Handles DNS (UDP port 53) requests using DNS over HTTPS (DoH). (from Script 2, supports traffic counting)
 */
async function createDnsPipeline(webSocket, vlessResponseHeader, log, updateUpstreamUsage) {
  let isHeaderSent = false;
  
  // Transform stream to extract individual DNS messages from the VLESS UDP stream format (2-byte length + data)
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof ArrayBuffer) && !(chunk instanceof Uint8Array)) {
         console.error("DNS Transform received invalid chunk type:", typeof chunk);
         return;
      }
      const buffer = new Uint8Array(chunk);
      for (let index = 0; index < buffer.byteLength;) {
        // Check if there are at least 2 bytes for the length header
        if (buffer.byteLength < index + 2) {
            console.warn("DNS transform: incomplete length header at end of chunk.");
            break;
        }
        
        const lengthView = new DataView(buffer.buffer, buffer.byteOffset + index, 2);
        const udpPacketLength = lengthView.getUint16(0, false); // Big-endian
        const dataStartIndex = index + 2;
        const dataEndIndex = dataStartIndex + udpPacketLength;
        
        // Check if the entire packet is in the current chunk
        if (buffer.byteLength < dataEndIndex) {
            console.warn("DNS transform: incomplete UDP packet data in chunk.");
            // In a real streaming scenario, this would require buffering. For Workers, 
            // VLESS chunks are usually large enough, but we stop to avoid boundary errors.
            break; 
        }
        
        const udpData = buffer.slice(dataStartIndex, dataEndIndex);
        index = dataEndIndex;
        controller.enqueue(udpData); // Enqueue the raw DNS message (without the 2-byte length)
      }
    },
  });

  // Writable stream to process the DNS messages via DoH
  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          try {
            // Use 1.1.1.1 as the DoH server
            const resp = await fetch('https://1.1.1.1/dns-query', {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: chunk, // The raw DNS message
            });
            
            if (!resp.ok) {
                throw new Error(`DoH server returned status ${resp.status}`);
            }
            
            const dnsQueryResult = await resp.arrayBuffer(); // The raw DNS response
            const udpSize = dnsQueryResult.byteLength;
            // Prepend the 2-byte length header for VLESS UDP format
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

            if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
              log(`DNS query successful, length: ${udpSize}`);
              
              // Prepend VLESS response header (00 00) only to the first response chunk
              const blob = isHeaderSent
                ? new Blob([udpSizeBuffer, dnsQueryResult])
                : new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]);

              const responseChunk = await blob.arrayBuffer();
              updateUpstreamUsage(responseChunk.byteLength); 
              webSocket.send(responseChunk);
              isHeaderSent = true;
            }
          } catch (error) {
            log('DNS query error: ' + error);
          }
        },
        abort(e) {
             log('DNS WritableStream aborted: ' + e);
        }
      }),
    )
    .catch(e => {
      log('DNS stream error: ' + e);
      safeCloseWebSocket(webSocket);
    });

  const writer = transformStream.writable.getWriter();
  return {
    write: (chunk) => writer.write(chunk),
  };
}


// --- Smart Config Page Generation (from Script 2) ---

async function getIPGeoInfo(ip) {
    if (!ip) return null;
    try {
        // Using ip-api.com for a free GeoIP lookup
        const response = await fetch(`https://ip-api.com/json/${ip}?fields=status,message,country,city,isp,query,as`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.status === 'success') {
            return {
                ip: data.query,
                country: data.country || 'Unknown',
                city: data.city || 'Unknown',
                isp: data.as || 'Unknown',
            };
        }
        return null;
    } catch (e) {
        console.error(`Error fetching IP info for ${ip}:`, e);
        return null;
    }
}

async function getIPRiskScore(ip, cfg) {
    if (!cfg.scamalytics.username || !cfg.scamalytics.apiKey) {
        return "N/A (Not Configured)";
    }
    if (!ip) return "N/A";
    
    try {
        const url = `${cfg.scamalytics.baseUrl}${cfg.scamalytics.username}/?key=${cfg.scamalytics.apiKey}&ip=${ip}`;
        const response = await fetch(url);
        if (!response.ok) return "N/A (API Error)";
        const data = await response.json();
        
        if (data.status === 'ok' && data.score !== undefined) {
            const riskText = data.risk.charAt(0).toUpperCase() + data.risk.slice(1);
            return `${data.score}% - ${riskText}`;
        }
        return `Error: ${data.error_message || 'API error'}`;
    } catch (e) {
        return "N/A (Fetch Error)";
    }
}

async function handleNetworkInfoRequest(request, env, cfg, ctx) {
    const userIP = request.headers.get('CF-Connecting-IP');

    let proxyIPInfo = await env.USER_KV?.get('proxy_ip_info', 'json');
    
    if (!proxyIPInfo) {
        let determinedIP = cfg.proxyIP; // Use configured proxy IP first
        
        // If no proxy IP is configured, try to determine the worker's public IP
        if (!determinedIP) {
             try {
                const ipResponse = await fetch('https://api.ipify.org?format=json');
                if (ipResponse.ok) {
                    const { ip } = await ipResponse.json();
                    determinedIP = ip;
                }
            } catch (e2) {
                 console.error('Failed to determine proxy IP info (fallback):', e2);
            }
        }
        
        proxyIPInfo = await getIPGeoInfo(determinedIP);
        
        // Cache the result for 1 hour
        if (proxyIPInfo && env.USER_KV) {
            ctx.waitUntil(env.USER_KV.put('proxy_ip_info', JSON.stringify(proxyIPInfo), { expirationTtl: 3600 }));
        }
    }

    const [userGeoInfo, userRiskScore] = await Promise.all([
        getIPGeoInfo(userIP),
        getIPRiskScore(userIP, cfg)
    ]);

    const userInfo = userGeoInfo || {};
    userInfo.risk = userRiskScore;

    return new Response(JSON.stringify({ proxy: proxyIPInfo, user: userInfo }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

async function handleConfigPage(userID, hostName, proxyAddress, userData, userIP, env, cfg, ctx) {
    const { expiration_date, expiration_time, data_usage, data_limit } = userData;
    const html = generateBeautifulConfigPage(userID, hostName, expiration_date, expiration_time, data_usage, data_limit); 
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// [FIXED] This function now uses standard string concatenation (+) inside the
// inline <script> block to avoid nested template literal syntax errors.
function generateBeautifulConfigPage(userID, hostName, expDate, expTime, dataUsage, dataLimit) {
    // Generate subscription links
    const subXrayUrl = `https://${hostName}/xray/${userID}`;
    const subSbUrl = `https://${hostName}/sb/${userID}`;
    const clashMetaUrl = `clash://install-config?url=${encodeURIComponent(subSbUrl)}`;
    
    // Process expiration time for display
    const expTimeSeconds = expTime.includes(':') && expTime.split(':').length === 2 ? `${expTime}:00` : expTime;
    const utcTimestamp = `${expDate}T${expTimeSeconds.split('.')[0]}Z`;

    const isUserExpired = isExpired(expDate, expTime);
    const hasDataLimit = dataLimit > 0;
    const dataLimitReached = hasDataLimit && (dataUsage >= dataLimit);
    
    let statusMessage = "Checking...";
    let statusColorClass = "status-active-text";
    
    if (isUserExpired) {
        statusMessage = "Subscription Expired";
        statusColorClass = "status-expired-text";
    } else if (dataLimitReached) {
        statusMessage = "Data Limit Reached";
        statusColorClass = "status-expired-text";
    }

    const trafficPercent = hasDataLimit ? Math.min(100, (dataUsage / dataLimit * 100)) : 0;

    // Use a single, large string for the HTML content.
    // NOTE: All template literals within the <script> block MUST be replaced with string concatenation.
    const html = '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
        '<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
        '<title>VLESS Proxy Configuration</title>' +
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>' +
        '<style>' +
            ':root {' +
                '--bg-main: #121212; --bg-card: #1E1E1E; --bg-inner: #2f2f2f; --border-color: #333;' +
                '--text-primary: #E0E0E0; --text-secondary: #B0B0B0; --accent: #BB86FC; --accent-hover: #D1C4E9;' +
                '--status-active: #03DAC6; --status-expired: #CF6679; --network-bg: #212121; --network-border: #444;' +
            '}' +
            'body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-main); color: var(--text-primary); padding: 20px; }' +
            '.container { max-width: 900px; margin: auto; }' +
            '.header { text-align: center; margin-bottom: 24px; }' +
            '.header h1 { font-size: 2em; margin-bottom: 8px; }' +
            '.header p { color: var(--text-secondary); }' +
            '.info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 20px; }' +
            '.info-card { background: var(--bg-card); border-radius: 12px; position: relative; overflow: hidden; border: 1px solid var(--border-color); }' +
            '.info-card.rainbow-border::before {' +
                "content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;" +
                'background: conic-gradient(from 180deg at 50% 50%, #CF6679, #BB86FC, #03DAC6, #CF6679);' +
                'animation: spin 4s linear infinite; z-index: 1;' +
            '}' +
            '.info-card-content { background: var(--bg-card); padding: 20px; border-radius: 10px; position: relative; z-index: 2; margin: 2px; }' +
            '.info-title { font-size: 1.25em; text-align: center; margin: 0 0 16px; font-weight: 500; }' +
            '.info-relative-time { text-align: center; font-size: 1.4em; font-weight: 600; margin-bottom: 16px; }' +
            '.status-active-text { color: var(--status-active); } .status-expired-text { color: var(--status-expired); }' +
            '.info-time-grid { display: grid; gap: 8px; font-size: 0.9em; text-align: center; color: var(--text-secondary); }' +
            '.data-usage-text { font-size: 1.4em !important; font-weight: 600; text-align: center; color: var(--text-primary); margin-bottom: 16px; }' +
            '.traffic-bar-container { height: 8px; background-color: var(--bg-inner); border-radius: 4px; overflow: hidden; }' +
            '.traffic-bar { height: 100%; background: linear-gradient(90deg, var(--accent) 0%, var(--status-active) 100%); border-radius: 4px; transition: width 0.5s ease-out; }' +
            '.network-info-wrapper { background: var(--bg-card); border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid var(--border-color); }' +
            '.network-info-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border-color); }' +
            '.network-info-header h2 { margin: 0; font-size: 1.4rem; }' +
            '.network-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }' +
            '.network-card { background: var(--network-bg); border: 1px solid var(--network-border); border-radius: 8px; padding: 16px; }' +
            '.network-title { font-size: 1.1em; margin-top: 0; margin-bottom: 12px; border-bottom: 1px solid var(--network-border); padding-bottom: 8px; color: var(--status-active); }' +
            '.network-info-grid { display: grid; gap: 8px; font-size: 0.9em; }' +
            '.network-info-grid strong { color: var(--text-secondary); font-weight: 400; display: inline-block; min-width: 90px; }' +
            '.network-info-grid span { color: var(--text-primary); font-weight: 500; }' +
            '.skeleton { display: inline-block; width: 120px; height: 1em; background-color: var(--bg-inner); border-radius: 4px; animation: loading 1.5s infinite linear; }' +
            '.config-card { background: var(--bg-card); border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid var(--border-color); }' +
            '.config-title { display: flex; justify-content: space-between; align-items: center; font-size: 1.4rem; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border-color); }' +
            '.button, .client-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: 1px solid var(--border-color); background-color: var(--bg-inner); color: var(--text-primary); text-decoration: none; transition: all 0.2s; }' +
            '.button:hover { background-color: #3f3f3f; }' +
            '.client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }' +
            '.client-btn { width: 100%; box-sizing: border-box; background-color: var(--accent); color: #121212; border: none; }' +
            '.client-btn:hover { background-color: var(--accent-hover); }' +
            '.qr-container { display: none; margin-top: 20px; background: white; padding: 16px; border-radius: 8px; max-width: 288px; margin-left: auto; margin-right: auto; }' +
            '@keyframes spin { 100% { transform: rotate(360deg); } }' +
            '@keyframes loading { 0% { background-color: #2f2f2f; } 50% { background-color: #3f3f3f; } 100% { background-color: #2f2f2f; } }' +
            '@media (max-width: 768px) { ' +
                'body { padding: 10px; } ' +
                '.info-grid, .network-grid { grid-template-columns: 1fr; } ' +
                '.network-info-header { flex-direction: column; align-items: flex-start; gap: 10px; }' +
                '.network-info-header button { width: 100%; }' +
            '}' +
        '</style>' +
    '</head>' +
    '<body>' +
        '<div class="container">' +
            '<div class="header"><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></div>' +
            '<div class="network-info-wrapper">' +
                '<div class="network-info-header">' +
                    '<h2>Network Information</h2>' +
                    '<button class="button" id="refresh-network-btn">Refresh</button>' +
                '</div>' +
                '<div id="network-info-grid" class="network-grid">' +
                    '<div class="network-card">' +
                        '<h3 class="network-title">Proxy Server</h3>' +
                        '<div class="network-info-grid">' +
                            '<div><strong>IP Address:</strong> <span id="proxy-ip"><span class="skeleton"></span></span></div>' +
                            '<div><strong>Location:</strong> <span id="proxy-location"><span class="skeleton"></span></span></div>' +
                            '<div><strong>ISP:</strong> <span id="proxy-isp"><span class="skeleton"></span></span></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="network-card">' +
                        '<h3 class="network-title">Your Connection</h3>' +
                        '<div class="network-info-grid">' +
                            '<div><strong>IP Address:</strong> <span id="user-ip"><span class="skeleton"></span></span></div>' +
                            '<div><strong>Location:</strong> <span id="user-location"><span class="skeleton"></span></span></div>' +
                            '<div><strong>ISP:</strong> <span id="user-isp"><span class="skeleton"></span></span></div>' +
                            '<div><strong>Risk Score:</strong> <span id="user-risk"><span class="skeleton"></span></span></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="info-grid">' +
                '<div class="info-card rainbow-border">' +
                    '<div class="info-card-content">' +
                        '<h2 class="info-title">Expiration Date</h2>' +
                        '<div id="expiration-relative" class="info-relative-time ' + statusColorClass + '">' + statusMessage + '</div>' +
                        '<div class="info-time-grid" id="expiration-display" data-utc-time="' + utcTimestamp + '">' +
                            '<div><strong>Your Local Time:</strong> <span id="local-time">--</span></div>' +
                            '<div><strong>Tehran Time:</strong> <span id="tehran-time">--</span></div>' +
                            '<div><strong>Universal Time:</strong> <span id="utc-time">--</span></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="info-card">' +
                    '<div class="info-card-content">' +
                        '<h2 class="info-title">Data Usage</h2>' +
                        '<div class="data-usage-text" id="data-usage-display" data-usage="' + dataUsage + '" data-limit="' + dataLimit + '">' +
                            'Loading...' +
                        '</div>' +
                        '<div class="traffic-bar-container">' +
                            '<div class="traffic-bar" id="traffic-bar-inner" style="width: ' + trafficPercent + '%"></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="config-card">' +
                '<div class="config-title"><span>Xray Subscription</span><button id="copy-xray-sub-btn" class="button" data-clipboard-text="' + subXrayUrl + '">Copy Link</button></div>' +
                '<div class="client-buttons">' +
                    '<a href="v2rayng://install-config?url=' + encodeURIComponent(subXrayUrl) + '" class="client-btn">V2rayNG / Universal</a>' +
                    '<a href="shadowrocket://add/sub?url=' + encodeURIComponent(subXrayUrl) + '&name=' + encodeURIComponent(hostName) + '" class="client-btn">Shadowrocket</a>' +
                    '<a href="stash://install-config?url=' + encodeURIComponent(subXrayUrl) + '" class="client-btn">Stash (VLESS)</a>' +
                    '<button class="client-btn" onclick="toggleQR(\'xray\', \'' + subXrayUrl + '\')">Show QR Code</button>' +
                '</div>' +
                '<div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div>' +
            '</div>' +
            '<div class="config-card">' +
                '<div class="config-title"><span>Sing-Box / Clash Subscription</span><button id="copy-sb-sub-btn" class="button" data-clipboard-text="' + subSbUrl + '">Copy Link</button></div>' +
                '<div class="client-buttons">' +
                    '<a href="' + clashMetaUrl + '" class="client-btn">Clash Meta / Stash (Sing-Box)</a>' +
                    '<button class="client-btn" onclick="toggleQR(\'singbox\', \'' + subSbUrl + '\')">Show QR Code</button>' +
                '</div>' +
                '<div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div>' +
            '</div>' +
        '</div>' +
        '<script>' +
            'function copyToClipboard(button, text) {' +
                'const originalText = button.textContent;' +
                'navigator.clipboard.writeText(text).then(() => {' +
                    'button.textContent = \'Copied!\';' +
                    'setTimeout(() => { button.textContent = originalText; }, 1500);' +
                '});' +
            '}' +
            'function toggleQR(id, url) {' +
                'const container = document.getElementById(\'qr-\' + id + \'-container\');' +
                'const qrElement = document.getElementById(\'qr-\' + id);' +
                'if (container.style.display === \'none\' || container.style.display === \'\') {' +
                    'container.style.display = \'block\';' +
                    'if (!qrElement.hasChildNodes()) { new QRCode(qrElement, { text: url, width: 256, height: 256, colorDark: "#E0E0E0", colorLight: "#1E1E1E", correctLevel: QRCode.CorrectLevel.H }); }' +
                '} else { container.style.display = \'none\'; }' +
            '}' +
            'function displayExpirationTimes() {' +
                'const expElement = document.getElementById(\'expiration-display\');' +
                'const relativeElement = document.getElementById(\'expiration-relative\');' +
                'if (!expElement?.dataset.utcTime) return;' +
                'const utcDate = new Date(expElement.dataset.utcTime);' +
                'if (isNaN(utcDate.getTime())) return;' +
                'const diffSeconds = (utcDate.getTime() - new Date().getTime()) / 1000;' +
                'const isExpired = diffSeconds < 0;' +
                'if (relativeElement.textContent === "Checking...") {' +
                    'if (isExpired) {' +
                        'relativeElement.textContent = "Subscription Expired";' +
                        'relativeElement.className = "info-relative-time status-expired-text";' +
                    '} else {' +
                        'const rtf = new Intl.RelativeTimeFormat(\'en\', { numeric: \'auto\' });' +
                        'let relTime = \'\';' +
                        'if (Math.abs(diffSeconds) < 3600) relTime = rtf.format(Math.round(diffSeconds / 60), \'minute\');' +
                        'else if (Math.abs(diffSeconds) < 86400) relTime = rtf.format(Math.round(diffSeconds / 3600), \'hour\');' +
                        'else relTime = rtf.format(Math.round(diffSeconds / 86400), \'day\');' +
                        'relativeElement.textContent = \'Expires \' + relTime;' + // FIX: String concatenation
                        'relativeElement.className = "info-relative-time status-active-text";' +
                    '}' +
                '}' +
                'document.getElementById(\'local-time\').textContent = utcDate.toLocaleString(undefined, { timeZoneName: \'short\' });' +
                'document.getElementById(\'tehran-time\').textContent = utcDate.toLocaleString(\'en-US\', { timeZone: \'Asia/Tehran\', hour12: true, year: \'numeric\', month: \'short\', day: \'numeric\', hour: \'numeric\', minute: \'2-digit\' });' +
                'document.getElementById(\'utc-time\').textContent = utcDate.toISOString().substring(0, 19).replace(\'T\', \' \') + \' UTC\';' + // FIX: String concatenation
            '}' +
            'function displayDataUsage() {' +
                'const usageElement = document.getElementById(\'data-usage-display\');' +
                'const usage = parseInt(usageElement.dataset.usage, 10);' +
                'const limit = parseInt(usageElement.dataset.limit, 10);' +
                'const bytesToReadable = bytes => {' +
                    'if (bytes <= 0) return \'0 Bytes\';' +
                    'const i = Math.floor(Math.log(bytes) / Math.log(1024));' +
                    'return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + \' \' + [\'Bytes\', \'KB\', \'MB\', \'GB\', \'TB\'][i];' + // FIX: String concatenation
                '};' +
                'const limitText = limit > 0 ? bytesToReadable(limit) : \'&infin;\';' +
                'usageElement.innerHTML = bytesToReadable(usage) + \' / \' + limitText;' + // FIX: String concatenation
                'if (limit > 0 && usage >= limit) {' +
                     'document.getElementById(\'traffic-bar-inner\').style.backgroundColor = \'var(--status-expired)\';' +
                     'const relativeElement = document.getElementById(\'expiration-relative\');' +
                     'relativeElement.textContent = "Data Limit Reached";' +
                     'relativeElement.className = "info-relative-time status-expired-text";' +
                '}' +
            '}' +
            'async function fetchNetworkInfo() {' +
                'try {' +
                    'const response = await fetch(\'/network-info\');' +
                    'const data = await response.json();' +
                    'document.getElementById(\'proxy-ip\').textContent = data.proxy?.ip || \'N/A\';' +
                    'document.getElementById(\'proxy-location\').textContent = (data.proxy?.city || \'\') + ((data.proxy?.city && data.proxy?.country) ? \', \' : \'\') + (data.proxy?.country || \'N/A\');' + // FIX: String concatenation
                    'document.getElementById(\'proxy-isp\').textContent = data.proxy?.isp || \'N/A\';' +
                    'document.getElementById(\'user-ip\').textContent = data.user?.ip || \'N/A\';' +
                    'document.getElementById(\'user-location\').textContent = (data.user?.city || \'\') + ((data.user?.city && data.user?.country) ? \', \' : \'\') + (data.user?.country || \'N/A\');' + // FIX: String concatenation
                    'document.getElementById(\'user-isp\').textContent = data.user?.isp || \'N/A\';' +
                    'document.getElementById(\'user-risk\').textContent = data.user?.risk || \'N/A\';' +
                '} catch (error) {' +
                    'console.error(\'Network info refresh failed:\', error);' +
                    'document.getElementById(\'proxy-ip\').textContent = \'Error\';' +
                    'document.getElementById(\'user-ip\').textContent = \'Error\';' +
                '}' +
            '}' +
            'document.addEventListener(\'DOMContentLoaded\', () => {' +
                'displayExpirationTimes();' +
                'displayDataUsage();' +
                'fetchNetworkInfo();' +
                'document.getElementById(\'refresh-network-btn\').addEventListener(\'click\', () => {' +
                    'document.querySelectorAll(\'.network-info-grid span:not([id$="-risk"])\').forEach(el => el.innerHTML = \'<span class="skeleton"></span>\');' +
                    'document.getElementById(\'user-risk\').innerHTML = \'<span class="skeleton"></span>\';' +
                    'fetchNetworkInfo();' +
                '});' +
                'document.querySelectorAll(\'.button[data-clipboard-text]\').forEach(button => {' +
                    'button.addEventListener(\'click\', () => copyToClipboard(button, button.dataset.clipboardText));' +
                '});' +
                'setInterval(displayExpirationTimes, 60000);' +
            '});' +
        '</script>' +
    '</body></html>';
    return html;
}
