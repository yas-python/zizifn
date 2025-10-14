import { connect } from 'cloudflare:sockets';

// Helper functions (updated for robustness)
/**
 * Generates a standard RFC4122 version 4 UUID.
 * @returns {string} A new UUID.
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Checks if the expiration date and time are in the future.
 * Treats the stored time as UTC to prevent timezone ambiguity.
 * @param {string} expDate - The expiration date in 'YYYY-MM-DD' format.
 * @param {string} expTime - The expiration time in 'HH:MM:SS' format.
 * @returns {boolean} - True if the expiration is in the future, otherwise false.
 */
async function checkExpiration(expDate, expTime) {
  if (!expDate || !expTime) return false;
  const expDatetimeUTC = new Date(expDate + 'T' + expTime + 'Z');
  return expDatetimeUTC > new Date() && !isNaN(expDatetimeUTC);
}

/**
 * Retrieves user data from KV cache or falls back to D1 database.
 * @param {object} env - The worker environment object.
 * @param {string} uuid - The user's UUID.
 * @returns {Promise<object|null>} - The user data or null if not found.
 */
async function getUserData(env, uuid) {
  let userData = await env.USER_KV.get('user:' + uuid);
  if (userData) {
    try {
      return JSON.parse(userData);
    } catch (e) {
      console.error('Failed to parse user data from KV for UUID: ' + uuid, e);
    }
  }

  const query = await env.DB.prepare("SELECT expiration_date, expiration_time, data_limit, used_traffic, notes FROM users WHERE uuid = ?")
    .bind(uuid)
    .first();

  if (!query) {
    return null;
  }

  userData = { exp_date: query.expiration_date, exp_time: query.expiration_time, data_limit: query.data_limit, used_traffic: query.used_traffic, notes: query.notes };
  await env.USER_KV.put('user:' + uuid, JSON.stringify(userData), { expirationTtl: 3600 });
  return userData;
}

/**
 * Updates the used traffic for a user in D1 and KV.
 * @param {object} env - The worker environment object.
 * @param {string} uuid - The user's UUID.
 * @param {number} additionalTraffic - The additional traffic in bytes to add.
 */
async function updateUsedTraffic(env, uuid, additionalTraffic) {
  if (additionalTraffic <= 0) return;

  const stmt = await env.DB.prepare("UPDATE users SET used_traffic = used_traffic + ? WHERE uuid = ?")
    .bind(additionalTraffic, uuid)
    .run();

  // Update KV cache
  const userData = await getUserData(env, uuid); // Refresh from DB
  if (userData) {
    await env.USER_KV.put('user:' + uuid, JSON.stringify(userData), { expirationTtl: 3600 });
  }
}

/**
 * Fetches dashboard stats from D1.
 * @param {object} env - The worker environment object.
 * @returns {Promise<object>} - Stats object.
 */
async function fetchDashboardStats(env) {
  const now = new Date().toISOString().split('T')[0]; // Current UTC date
  const nowTime = new Date().toISOString().split('T')[1].slice(0, 8); // Current UTC time

  const totalUsers = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
  const expiredUsers = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE (expiration_date < ? OR (expiration_date = ? AND expiration_time < ?)) OR (data_limit > 0 AND used_traffic >= data_limit)").bind(now, now, nowTime).first();
  const totalTraffic = await env.DB.prepare("SELECT SUM(used_traffic) as total FROM users").first();

  return {
    totalUsers: totalUsers.count,
    activeUsers: totalUsers.count - expiredUsers.count,
    expiredUsers: expiredUsers.count,
    totalTraffic: totalTraffic.total || 0
  };
}

// --- Admin Security & Panel ---

// HTML for the Admin Login Page (unchanged)
const adminLoginHTML = '<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>Admin Login</title>\n    <style>\n        body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #121212; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }\n        .login-container { background-color: #1e1e1e; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); text-align: center; width: 320px; border: 1px solid #333; }\n        h1 { color: #ffffff; margin-bottom: 24px; font-weight: 500; }\n        form { display: flex; flex-direction: column; }\n        input[type="password"] { background-color: #2c2c2c; border: 1px solid #444; color: #ffffff; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 16px; }\n        input[type="password"]:focus { outline: none; border-color: #007aff; box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.3); }\n        button { background-color: #007aff; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; }\n        button:hover { background-color: #005ecb; }\n        .error { color: #ff3b30; margin-top: 15px; font-size: 14px; }\n    </style>\n</head>\n<body>\n    <div class="login-container">\n        <h1>Admin Login</h1>\n        <form method="POST" action="/admin">\n            <input type="password" name="password" placeholder="••••••••••••••" required>\n            <button type="submit">Login</button>\n        </form>\n        </div>\n</body>\n</html>';

// --- IMPROVED ADMIN PANEL HTML with Dashboard Stats, Bulk Delete, and Search ---
const adminPanelHTML = '<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>Admin Dashboard</title>\n    <style>\n        :root {\n            --bg-main: #111827; --bg-card: #1F2937; --border: #374151; --text-primary: #F9FAFB;\n            --text-secondary: #9CA3AF; --accent: #3B82F6; --accent-hover: #2563EB; --danger: #EF4444;\n            --danger-hover: #DC2626; --success: #22C55E; --expired: #F59E0B; --btn-secondary-bg: #4B5563;\n        }\n        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: var(--bg-main); color: var(--text-primary); font-size: 14px; }\n        .container { max-width: 1200px; margin: 40px auto; padding: 0 20px; }\n        h1, h2 { font-weight: 600; }\n        h1 { font-size: 24px; margin-bottom: 20px; }\n        h2 { font-size: 18px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 20px; }\n        .card { background-color: var(--bg-card); border-radius: 8px; padding: 24px; border: 1px solid var(--border); box-shadow: 0 4px 6px rgba(0,0,0,0.1); }\n        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; align-items: flex-end; }\n        .form-group { display: flex; flex-direction: column; }\n        .form-group label { margin-bottom: 8px; font-weight: 500; color: var(--text-secondary); }\n        .form-group .input-group { display: flex; }\n        input[type="text"], input[type="date"], input[type="time"], input[type="number"], select {\n            width: 100%; box-sizing: border-box; background-color: #374151; border: 1px solid #4B5563; color: var(--text-primary);\n            padding: 10px; border-radius: 6px; font-size: 14px; transition: border-color 0.2s;\n        }\n        input:focus { outline: none; border-color: var(--accent); }\n        .label-note { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }\n        .btn {\n            padding: 10px 16px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;\n            transition: background-color 0.2s, transform 0.1s; display: inline-flex; align-items: center; justify-content: center; gap: 8px;\n        }\n        .btn:active { transform: scale(0.98); }\n        .btn-primary { background-color: var(--accent); color: white; }\n        .btn-primary:hover { background-color: var(--accent-hover); }\n        .btn-secondary { background-color: var(--btn-secondary-bg); color: white; }\n        .btn-secondary:hover { background-color: #6B7280; }\n        .btn-danger { background-color: var(--danger); color: white; }\n        .btn-danger:hover { background-color: var(--danger-hover); }\n        .input-group .btn-secondary { border-top-left-radius: 0; border-bottom-left-radius: 0; }\n        .input-group input { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none; }\n        table { width: 100%; border-collapse: collapse; margin-top: 20px; }\n        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n        th { color: var(--text-secondary); font-weight: 600; font-size: 12px; text-transform: uppercase; }\n        td { color: var(--text-primary); font-family: "SF Mono", "Fira Code", monospace; }\n        .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; display: inline-block; }\n        .status-active { background-color: var(--success); color: #064E3B; }\n        .status-expired { background-color: var(--expired); color: #78350F; }\n        .actions-cell .btn { padding: 6px 10px; font-size: 12px; }\n        #toast { position: fixed; top: 20px; right: 20px; background-color: var(--bg-card); color: white; padding: 15px 20px; border-radius: 8px; z-index: 1001; display: none; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s, transform 0.3s; transform: translateY(-20px); }\n        #toast.show { display: block; opacity: 1; transform: translateY(0); }\n        #toast.error { border-left: 5px solid var(--danger); }\n        #toast.success { border-left: 5px solid var(--success); }\n        .uuid-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\n        .btn-copy { background: transparent; border: none; color: var(--text-secondary); padding: 4px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }\n        .btn-copy:hover { background-color: #374151; color: var(--text-primary); }\n        .btn svg, .actions-cell .btn svg { width: 14px; height: 14px; }\n        .actions-cell { display: flex; gap: 8px; justify-content: center; }\n        .time-display { display: flex; flex-direction: column; }\n        .time-local { font-weight: 600; }\n        .time-utc, .time-relative { font-size: 11px; color: var(--text-secondary); }\n        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }\n        .modal-overlay.show { opacity: 1; visibility: visible; }\n        .modal-content { background-color: var(--bg-card); padding: 30px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.4); width: 90%; max-width: 500px; transform: scale(0.9); transition: transform 0.3s; border: 1px solid var(--border); }\n        .modal-overlay.show .modal-content { transform: scale(1); }\n        .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 20px; }\n        .modal-header h2 { margin: 0; border: none; font-size: 20px; }\n        .modal-close-btn { background: none; border: none; color: var(--text-secondary); font-size: 24px; cursor: pointer; line-height: 1; }\n        .modal-footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 25px; }\n        .time-quick-set-group { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; data-target-date="expiryDate" data-target-time="expiryTime"; }\n        .btn-outline-secondary {\n            background-color: transparent; border: 1px solid var(--btn-secondary-bg); color: var(--text-secondary);\n            padding: 6px 10px; font-size: 12px; font-weight: 500;\n        }\n        .btn-outline-secondary:hover { background-color: var(--btn-secondary-bg); color: white; border-color: var(--btn-secondary-bg); }\n        .progress-bar-container { width: 100%; background-color: #4B5563; border-radius: 4px; height: 8px; overflow: hidden; margin-top: 4px; }\n        .progress-bar { height: 100%; background-color: #22C55E; transition: width 0.3s ease; }\n        .progress-bar.warning { background-color: #F59E0B; }\n        .progress-bar.danger { background-color: #EF4444; }\n        .traffic-text { font-size: 12px; color: var(--text-secondary); margin-top: 4px; text-align: right; }\n        .dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 30px; }\n        .dashboard-stat { background-color: var(--bg-card); padding: 16px; border-radius: 8px; border: 1px solid var(--border); text-align: center; }\n        .dashboard-stat h3 { font-size: 28px; color: var(--accent); margin: 0; }\n        .dashboard-stat p { color: var(--text-secondary); margin: 0; font-size: 14px; }\n        .search-container { margin-bottom: 16px; }\n        .search-input { width: 100%; padding: 10px; border-radius: 6px; background-color: #374151; border: 1px solid #4B5563; color: var(--text-primary); }\n        .search-input:focus { border-color: var(--accent); }\n        .table-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }\n        .delete-selected-btn { background-color: var(--danger); color: white; }\n        .delete-selected-btn:hover { background-color: var(--danger-hover); }\n        @media (max-width: 768px) {\n            tr { border: 1px solid var(--border); border-radius: 8px; display: block; margin-bottom: 1rem; }\n            td { border: none; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }\n            .dashboard-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }\n            .dashboard-stat h3 { font-size: 24px; }\n            .dashboard-stat p { font-size: 12px; }\n        }\n    </style>\n</head>\n<body>\n    <div class="container">\n        <h1>Admin Dashboard</h1>\n        <div class="dashboard-grid" id="dashboardStats">\n            <!-- Stats will be loaded here -->\n        </div>\n        <div class="card">\n            <h2>Create User</h2>\n            <form id="createUserForm" class="form-grid">\n                <div class="form-group" style="grid-column: 1 / -1;"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div>\n                <div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div>\n                <div class="form-group">\n                    <label for="expiryTime">Expiry Time (Your Local Time)</label>\n                    <input type="time" id="expiryTime" step="1" required>\n                    <div class="label-note">Automatically converted to UTC on save.</div>\n                    <div class="time-quick-set-group" data-target-date="expiryDate" data-target-time="expiryTime">\n                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button>\n                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button>\n                        <button type="button" class="btn btn-outline-secondary" data-amount="7" data-unit="day">+1 Week</button>\n                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button>\n                    </div>\n                </div>\n                <div class="form-group">\n                    <label for="dataLimit">Data Limit</label>\n                    <div class="input-group">\n                        <input type="number" id="dataLimitValue" min="0" value="0" required>\n                        <select id="dataLimitUnit">\n                            <option value="KB">KB</option>\n                            <option value="MB">MB</option>\n                            <option value="GB" selected>GB</option>\n                            <option value="TB">TB</option>\n                        </select>\n                        <button type="button" class="btn btn-secondary" onclick="setUnlimited()">Unlimited</button>\n                    </div>\n                    <div class="label-note">0 or Unlimited for no limit.</div>\n                </div>\n                <div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div>\n                <div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div>\n            </form>\n        </div>\n        <div class="card" style="margin-top: 30px;">\n            <h2>User List</h2>\n            <div class="search-container">\n                <input type="text" id="searchInput" class="search-input" placeholder="Search by UUID or Notes...">\n            </div>\n            <div class="table-header">\n                <button id="deleteSelected" class="btn btn-danger delete-selected-btn">Delete Selected</button>\n            </div>\n            <div style="overflow-x: auto;">\n                 <table>\n                    <thead><tr><th><input type="checkbox" id="selectAll"></th><th>UUID</th><th>Created</th><th>Expiry (Admin Local)</th><th>Expiry (Tehran)</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead>\n                    <tbody id="userList"></tbody>\n                </table>\n            </div>\n        </div>\n    </div>\n    <div id="toast"></div>\n    <div id="editModal" class="modal-overlay">\n        <div class="modal-content">\n            <div class="modal-header">\n                <h2>Edit User</h2>\n                <button id="modalCloseBtn" class="modal-close-btn">&times;</button>\n            </div>\n            <form id="editUserForm">\n                <input type="hidden" id="editUuid" name="uuid">\n                <div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div>\n                <div class="form-group" style="margin-top: 16px;">\n                    <label for="editExpiryTime">Expiry Time (Your Local Time)</label>\n                    <input type="time" id="editExpiryTime" name="exp_time" step="1" required>\n                     <div class="label-note">Your current timezone is used for conversion.</div>\n                    <div class="time-quick-set-group" data-target-date="editExpiryDate" data-target-time="editExpiryTime">\n                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button>\n                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button>\n                        <button type="button" class="btn btn-outline-secondary" data-amount="7" data-unit="day">+1 Week</button>\n                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button>\n                    </div>\n                </div>\n                <div class="form-group" style="margin-top: 16px;">\n                    <label for="editDataLimit">Data Limit</label>\n                    <div class="input-group">\n                        <input type="number" id="editDataLimitValue" min="0" required>\n                        <select id="editDataLimitUnit">\n                            <option value="KB">KB</option>\n                            <option value="MB">MB</option>\n                            <option value="GB" selected>GB</option>\n                            <option value="TB">TB</option>\n                        </select>\n                        <button type="button" class="btn btn-secondary" onclick="setUnlimited(true)">Unlimited</button>\n                    </div>\n                    <div class="label-note">0 or Unlimited for no limit.</div>\n                </div>\n                <div class="form-group" style="margin-top: 16px;"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div>\n                <div class="form-group" style="margin-top: 16px;"><label><input type="checkbox" id="resetTraffic" name="resetTraffic"> Reset Traffic Usage</label></div>\n                <div class="modal-footer">\n                    <button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button>\n                    <button type="submit" class="btn btn-primary">Save Changes</button>\n                </div>\n            </form>\n        </div>\n    </div>\n\n    <script>\n        document.addEventListener(\'DOMContentLoaded\', () => {\n            const API_BASE = \'/admin/api\';\n            let allUsers = [];\n            const userList = document.getElementById(\'userList\');\n            const createUserForm = document.getElementById(\'createUserForm\');\n            const generateUUIDBtn = document.getElementById(\'generateUUID\');\n            const uuidInput = document.getElementById(\'uuid\');\n            const toast = document.getElementById(\'toast\');\n            const editModal = document.getElementById(\'editModal\');\n            const editUserForm = document.getElementById(\'editUserForm\');\n            const selectAllCheckbox = document.getElementById(\'selectAll\');\n            const deleteSelectedBtn = document.getElementById(\'deleteSelected\');\n            const searchInput = document.getElementById(\'searchInput\');\n            const dashboardStats = document.getElementById(\'dashboardStats\');\n\n            function showToast(message, isError = false) {\n                toast.textContent = message;\n                toast.className = isError ? \'error\' : \'success\';\n                toast.classList.add(\'show\');\n                setTimeout(() => { toast.classList.remove(\'show\'); }, 3000);\n            }\n\n            const api = {\n                get: (endpoint) => fetch(API_BASE + endpoint, { credentials: \'include\' }).then(handleResponse),\n                post: (endpoint, body) => fetch(API_BASE + endpoint, { method: \'POST\', credentials: \'include\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify(body) }).then(handleResponse),\n                put: (endpoint, body) => fetch(API_BASE + endpoint, { method: \'PUT\', credentials: \'include\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify(body) }).then(handleResponse),\n                delete: (endpoint) => fetch(API_BASE + endpoint, { method: \'DELETE\', credentials: \'include\' }).then(handleResponse),\n            };\n\n            async function handleResponse(response) {\n                if (!response.ok) {\n                    const errorData = await response.json().catch(() => ({ error: \'An unknown error occurred.\' }));\n                    throw new Error(errorData.error || \'Request failed with status \' + response.status);\n                }\n                return response.status === 204 ? null : response.json();\n            }\n\n            const pad = (num) => num.toString().padStart(2, \'0\');\n\n            function localToUTC(dateStr, timeStr) {\n                if (!dateStr || !timeStr) return { utcDate: \'\', utcTime: \'\' };\n                const timeParts = timeStr.split(\':\');\n                if (timeParts.length === 2) {\n                    timeStr += \':00\';\n                } else if (timeParts.length !== 3) {\n                    return { utcDate: \'\', utcTime: \'\' };\n                }\n                const localDateTime = new Date(dateStr + \'T\' + timeStr);\n                if (isNaN(localDateTime)) return { utcDate: \'\', utcTime: \'\' };\n\n                const year = localDateTime.getUTCFullYear();\n                const month = pad(localDateTime.getUTCMonth() + 1);\n                const day = pad(localDateTime.getUTCDate());\n                const hours = pad(localDateTime.getUTCHours());\n                const minutes = pad(localDateTime.getUTCMinutes());\n                const seconds = pad(localDateTime.getUTCSeconds());\n\n                return {\n                    utcDate: year + \'-\' + month + \'-\' + day,\n                    utcTime: hours + \':\' + minutes + \':\' + seconds\n                };\n            }\n\n            function utcToLocal(utcDateStr, utcTimeStr) {\n                if (!utcDateStr || !utcTimeStr) return { localDate: \'\', localTime: \'\' };\n                const timeParts = utcTimeStr.split(\':\');\n                if (timeParts.length === 2) {\n                    utcTimeStr += \':00\';\n                } else if (timeParts.length !== 3) {\n                    return { localDate: \'\', localTime: \'\' };\n                }\n                const utcDateTime = new Date(utcDateStr + \'T\' + utcTimeStr + \'Z\');\n                if (isNaN(utcDateTime)) return { localDate: \'\', localTime: \'\' };\n\n                const year = utcDateTime.getFullYear();\n                const month = pad(utcDateTime.getMonth() + 1);\n                const day = pad(utcDateTime.getDate());\n                const hours = pad(utcDateTime.getHours());\n                const minutes = pad(utcDateTime.getMinutes());\n                const seconds = pad(utcDateTime.getSeconds());\n\n                return {\n                    localDate: year + \'-\' + month + \'-\' + day,\n                    localTime: hours + \':\' + minutes + \':\' + seconds\n                };\n            }\n\n            function addExpiryTime(dateInputId, timeInputId, amount, unit) {\n                const dateInput = document.getElementById(dateInputId);\n                const timeInput = document.getElementById(timeInputId);\n\n                let date = new Date(dateInput.value + \'T\' + (timeInput.value || \'00:00:00\'));\n                if (isNaN(date.getTime())) {\n                    date = new Date();\n                }\n\n                if (unit === \'hour\') date.setHours(date.getHours() + amount);\n                else if (unit === \'day\') date.setDate(date.getDate() + amount);\n                else if (unit === \'month\') date.setMonth(date.getMonth() + amount);\n\n                const year = date.getFullYear();\n                const month = pad(date.getMonth() + 1);\n                const day = pad(date.getDate());\n                const hours = pad(date.getHours());\n                const minutes = pad(date.getMinutes());\n                const seconds = pad(date.getSeconds());\n\n                dateInput.value = year + \'-\' + month + \'-\' + day;\n                timeInput.value = hours + \':\' + minutes + \':\' + seconds;\n            }\n\n            document.body.addEventListener(\'click\', (e) => {\n                const target = e.target.closest(\'.time-quick-set-group button\');\n                if (!target) return;\n                const group = target.closest(\'.time-quick-set-group\');\n                addExpiryTime(\n                    group.dataset.targetDate,\n                    group.dataset.targetTime,\n                    parseInt(target.dataset.amount, 10),\n                    target.dataset.unit\n                );\n            });\n\n            function formatExpiryDateTime(expDateStr, expTimeStr) {\n                const expiryUTC = new Date(expDateStr + \'T\' + expTimeStr + \'Z\');\n                if (isNaN(expiryUTC)) return { local: \'Invalid Date\', utc: \'\', relative: \'\', tehran: \'\', isExpired: true };\n\n                const now = new Date();\n                const isExpired = expiryUTC < now;\n\n                const commonOptions = {\n                    year: \'numeric\', month: \'2-digit\', day: \'2-digit\',\n                    hour: \'2-digit\', minute: \'2-digit\', second: \'2-digit\', hour12: false, timeZoneName: \'short\'\n                };\n\n                const localTime = expiryUTC.toLocaleString(undefined, commonOptions);\n                const tehranTime = expiryUTC.toLocaleString(\'en-US\', { ...commonOptions, timeZone: \'Asia/Tehran\' });\n                const utcTime = expiryUTC.toISOString().replace(\'T\', \' \').substring(0, 19) + \' UTC\';\n\n                const rtf = new Intl.RelativeTimeFormat(\'en\', { numeric: \'auto\' });\n                const diffSeconds = (expiryUTC.getTime() - now.getTime()) / 1000;\n                let relativeTime = \'\';\n                if (Math.abs(diffSeconds) < 60) relativeTime = rtf.format(Math.round(diffSeconds), \'second\');\n                else if (Math.abs(diffSeconds) < 3600) relativeTime = rtf.format(Math.round(diffSeconds / 60), \'minute\');\n                else if (Math.abs(diffSeconds) < 86400) relativeTime = rtf.format(Math.round(diffSeconds / 3600), \'hour\');\n                else relativeTime = rtf.format(Math.round(diffSeconds / 86400), \'day\');\n\n                return { local: localTime, tehran: tehranTime, utc: utcTime, relative: relativeTime, isExpired };\n            }\n\n            function formatBytes(bytes, decimals = 2) {\n                if (bytes === 0) return \'0 Bytes\';\n                const k = 1024;\n                const dm = decimals < 0 ? 0 : decimals;\n                const sizes = [\'Bytes\', \'KB\', \'MB\', \'GB\', \'TB\'];\n                const i = Math.floor(Math.log(bytes) / Math.log(k));\n                return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + \' \' + sizes[i];\n            }\n\n            function getDataLimitInBytes(value, unit) {\n                const numValue = parseFloat(value) || 0;\n                switch (unit) {\n                    case \'KB\': return numValue * 1024;\n                    case \'MB\': return numValue * 1024 * 1024;\n                    case \'GB\': return numValue * 1024 * 1024 * 1024;\n                    case \'TB\': return numValue * 1024 * 1024 * 1024 * 1024;\n                    default: return 0;\n                }\n            }\n\n            function setUnlimited(isEdit = false) {\n                const prefix = isEdit ? \'edit\' : \'\';\n                document.getElementById(prefix + \'DataLimitValue\').value = 0;\n                document.getElementById(prefix + \'DataLimitUnit\').value = \'GB\';\n            }\n\n            function getDataLimitFromInputs(isEdit = false) {\n                const prefix = isEdit ? \'edit\' : \'\';\n                const value = document.getElementById(prefix + \'DataLimitValue\').value;\n                const unit = document.getElementById(prefix + \'DataLimitUnit\').value;\n                return getDataLimitInBytes(value, unit);\n            }\n\n            function setDataLimitInputs(dataLimit, isEdit = false) {\n                const prefix = isEdit ? \'edit\' : \'\';\n                if (dataLimit === 0) {\n                    document.getElementById(prefix + \'DataLimitValue\').value = 0;\n                    document.getElementById(prefix + \'DataLimitUnit\').value = \'GB\';\n                    return;\n                }\n                let unit = \'Bytes\';\n                let value = dataLimit;\n                if (value >= 1024 * 1024 * 1024 * 1024) {\n                    value /= 1024 * 1024 * 1024 * 1024;\n                    unit = \'TB\';\n                } else if (value >= 1024 * 1024 * 1024) {\n                    value /= 1024 * 1024 * 1024;\n                    unit = \'GB\';\n                } else if (value >= 1024 * 1024) {\n                    value /= 1024 * 1024;\n                    unit = \'MB\';\n                } else if (value >= 1024) {\n                    value /= 1024;\n                    unit = \'KB\';\n                }\n                document.getElementById(prefix + \'DataLimitValue\').value = value;\n                document.getElementById(prefix + \'DataLimitUnit\').value = unit;\n            }\n\n            function renderDashboardStats(stats) {\n                dashboardStats.innerHTML = \'<div class="dashboard-stat"><h3>\' + stats.totalUsers + \'</h3><p>Total Users</p></div><div class="dashboard-stat"><h3>\' + stats.activeUsers + \'</h3><p>Active Users</p></div><div class="dashboard-stat"><h3>\' + stats.expiredUsers + \'</h3><p>Expired Users</p></div><div class="dashboard-stat"><h3>\' + formatBytes(stats.totalTraffic) + \'</h3><p>Total Traffic Used</p></div>\';\n            }\n\n            function renderUsers(filteredUsers = allUsers) {\n                userList.innerHTML = \'\';\n                if (filteredUsers.length === 0) {\n                    userList.innerHTML = \'<tr><td colspan="9" style="text-align:center;">No users found.</td></tr>\';\n                } else {\n                    filteredUsers.forEach(user => {\n                        const expiry = formatExpiryDateTime(user.expiration_date, user.expiration_time);\n                        const isExpired = expiry.isExpired || (user.data_limit > 0 && user.used_traffic >= user.data_limit);\n                        const dataLimit = user.data_limit || 0;\n                        const usedTraffic = user.used_traffic || 0;\n                        const trafficText = dataLimit === 0 ? formatBytes(usedTraffic) + \' / Unlimited\' : formatBytes(usedTraffic) + \' / \' + formatBytes(dataLimit);\n                        const progressPercent = dataLimit === 0 ? 0 : (usedTraffic / dataLimit) * 100;\n                        let progressClass = \'\';\n                        if (progressPercent > 90) progressClass = \'danger\';\n                        else if (progressPercent > 70) progressClass = \'warning\';\n                        const progressBar = \'<div class="progress-bar-container"><div class="progress-bar \' + progressClass + \'" style="width: \' + progressPercent + \'%"></div></div><div class="traffic-text">\' + trafficText + \'</div>\';\n                        const row = document.createElement(\'tr\');\n                        row.innerHTML = \'<td><input type="checkbox" class="userSelect" data-uuid="\' + user.uuid + \'"></td><td><div class="uuid-cell" title="\' + user.uuid + \'">\' + user.uuid + \'</div></td><td>\' + new Date(user.created_at).toLocaleString() + \'</td><td><div class="time-display"><span class="time-local" title="Your Local Time">\' + expiry.local + \'</span><span class="time-utc" title="Coordinated Universal Time">\' + expiry.utc + \'</span><span class="time-relative">\' + expiry.relative + \'</span></div></td><td><div class="time-display"><span class="time-local" title="Tehran Time (GMT+03:30)">\' + expiry.tehran + \'</span><span class="time-utc">Asia/Tehran</span></div></td><td><span class="status-badge \' + (isExpired ? \'status-expired\' : \'status-active\') + \'">\' + (isExpired ? \'Expired\' : \'Active\') + \'</span></td><td>\' + progressBar + \'</td><td>\' + (user.notes || \'-\') + \'</td><td><div class="actions-cell"><button class="btn btn-secondary btn-edit" data-uuid="\' + user.uuid + \'">Edit</button><button class="btn btn-danger btn-delete" data-uuid="\' + user.uuid + \'">Delete</button></div></td>\';\n                        userList.appendChild(row);\n                    });\n                }\n            }\n\n            async function fetchAndRenderUsers() {\n                try {\n                    allUsers = await api.get(\'/users\');\n                    allUsers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));\n                    renderUsers();\n                } catch (error) { showToast(error.message, true); }\n            }\n\n            async function fetchAndRenderStats() {\n                try {\n                    const stats = await api.get(\'/stats\');\n                    renderDashboardStats(stats);\n                } catch (error) { showToast(error.message, true); }\n            }\n\n            async function handleCreateUser(e) {\n                e.preventDefault();\n                const localDate = document.getElementById(\'expiryDate\').value;\n                let localTime = document.getElementById(\'expiryTime\').value;\n\n                // Ensure seconds are included\n                if (localTime.split(\':\').length === 2) {\n                    localTime += \':00\';\n                }\n\n                const { utcDate, utcTime } = localToUTC(localDate, localTime);\n                if (!utcDate || !utcTime) return showToast(\'Invalid date or time entered.\', true);\n\n                const userData = {\n                    uuid: uuidInput.value,\n                    exp_date: utcDate,\n                    exp_time: utcTime,\n                    data_limit: getDataLimitFromInputs(),\n                    notes: document.getElementById(\'notes\').value\n                };\n\n                try {\n                    await api.post(\'/users\', userData);\n                    showToast(\'User created successfully!\');\n                    createUserForm.reset();\n                    uuidInput.value = crypto.randomUUID();\n                    setDefaultExpiry();\n                    await fetchAndRenderUsers();\n                    await fetchAndRenderStats();\n                } catch (error) { showToast(error.message, true); }\n            }\n\n            async function handleDeleteUser(uuid) {\n                if (confirm(\'Delete user \' + uuid + \'?\')) {\n                    try {\n                        await api.delete(\'/users/\' + uuid);\n                        showToast(\'User deleted successfully!\');\n                        await fetchAndRenderUsers();\n                        await fetchAndRenderStats();\n                    } catch (error) { showToast(error.message, true); }\n                }\n            }\n\n            async function handleBulkDelete() {\n                const selectedUuids = Array.from(document.querySelectorAll(\'.userSelect:checked\')).map(cb => cb.dataset.uuid);\n                if (selectedUuids.length === 0) return showToast(\'No users selected.\', true);\n                if (confirm(\'Delete \' + selectedUuids.length + \' selected users?\')) {\n                    try {\n                        await api.post(\'/users/bulk-delete\', { uuids: selectedUuids });\n                        showToast(\'Selected users deleted successfully!\');\n                        await fetchAndRenderUsers();\n                        await fetchAndRenderStats();\n                    } catch (error) { showToast(error.message, true); }\n                }\n            }\n\n            function openEditModal(uuid) {\n                const user = allUsers.find(u => u.uuid === uuid);\n                if (!user) return showToast(\'User not found.\', true);\n\n                const { localDate, localTime } = utcToLocal(user.expiration_date, user.expiration_time);\n\n                document.getElementById(\'editUuid\').value = user.uuid;\n                document.getElementById(\'editExpiryDate\').value = localDate;\n                let editTime = localTime;\n                if (editTime.split(\':\').length === 2) {\n                    editTime += \':00\';\n                }\n                document.getElementById(\'editExpiryTime\').value = editTime;\n                setDataLimitInputs(user.data_limit, true);\n                document.getElementById(\'editNotes\').value = user.notes || \'\';\n                document.getElementById(\'resetTraffic\').checked = false;\n                editModal.classList.add(\'show\');\n            }\n\n            function closeEditModal() { editModal.classList.remove(\'show\'); }\n\n            async function handleEditUser(e) {\n                e.preventDefault();\n                const localDate = document.getElementById(\'editExpiryDate\').value;\n                let localTime = document.getElementById(\'editExpiryTime\').value;\n\n                if (localTime.split(\':\').length === 2) {\n                    localTime += \':00\';\n                }\n\n                const { utcDate, utcTime } = localToUTC(localDate, localTime);\n                if (!utcDate || !utcTime) return showToast(\'Invalid date or time entered.\', true);\n\n                const updatedData = {\n                    exp_date: utcDate,\n                    exp_time: utcTime,\n                    data_limit: getDataLimitFromInputs(true),\n                    notes: document.getElementById(\'editNotes\').value,\n                    reset_traffic: document.getElementById(\'resetTraffic\').checked\n                };\n\n                try {\n                    await api.put(\'/users/\' + document.getElementById(\'editUuid\').value, updatedData);\n                    showToast(\'User updated successfully!\');\n                    closeEditModal();\n                    await fetchAndRenderUsers();\n                    await fetchAndRenderStats();\n                } catch (error) { showToast(error.message, true); }\n            }\n\n            function setDefaultExpiry() {\n                const now = new Date();\n                now.setDate(now.getDate() + 1); // Set expiry to 24 hours from now in LOCAL time\n\n                const year = now.getFullYear();\n                const month = pad(now.getMonth() + 1);\n                const day = pad(now.getDate());\n                const hours = pad(now.getHours());\n                const minutes = pad(now.getMinutes());\n                const seconds = pad(now.getSeconds());\n\n                document.getElementById(\'expiryDate\').value = year + \'-\' + month + \'-\' + day;\n                document.getElementById(\'expiryTime\').value = hours + \':\' + minutes + \':\' + seconds;\n            }\n\n            function handleSelectAll() {\n                const checkboxes = document.querySelectorAll(\'.userSelect\');\n                checkboxes.forEach(cb => cb.checked = selectAllCheckbox.checked);\n            }\n\n            function handleSearch() {\n                const searchTerm = searchInput.value.toLowerCase();\n                const filtered = allUsers.filter(user => \n                    user.uuid.toLowerCase().includes(searchTerm) || (user.notes || \'\').toLowerCase().includes(searchTerm)\n                );\n                renderUsers(filtered);\n            }\n\n            generateUUIDBtn.addEventListener(\'click\', () => uuidInput.value = crypto.randomUUID());\n            createUserForm.addEventListener(\'submit\', handleCreateUser);\n            editUserForm.addEventListener(\'submit\', handleEditUser);\n            editModal.addEventListener(\'click\', (e) => { if (e.target === editModal) closeEditModal(); });\n            document.getElementById(\'modalCloseBtn\').addEventListener(\'click\', closeEditModal);\n            document.getElementById(\'modalCancelBtn\').addEventListener(\'click\', closeEditModal);\n            userList.addEventListener(\'click\', (e) => {\n                const target = e.target.closest(\'button\');\n                if (!target) return;\n                const uuid = target.dataset.uuid;\n                if (target.classList.contains(\'btn-edit\')) openEditModal(uuid);\n                else if (target.classList.contains(\'btn-delete\')) handleDeleteUser(uuid);\n            });\n            selectAllCheckbox.addEventListener(\'change\', handleSelectAll);\n            deleteSelectedBtn.addEventListener(\'click\', handleBulkDelete);\n            searchInput.addEventListener(\'input\', handleSearch);\n\n            setDefaultExpiry();\n            uuidInput.value = crypto.randomUUID();\n            fetchAndRenderUsers();\n            fetchAndRenderStats();\n        });\n    </script>\n</body>\n</html>';

async function isAdmin(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return false;

    const token = cookieHeader.match(/auth_token=([^;]+)/)?.[1];
    if (!token) return false;

    const storedToken = await env.USER_KV.get('admin_session_token');

    return storedToken && storedToken === token;
}

/**
* --- Handles all incoming requests to /admin/* routes with API routing. ---
* @param {Request} request
* @param {object} env
* @returns {Promise<Response>}
*/
async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured.', { status: 503 });
    }

    // --- API Routes ---
    if (pathname.startsWith('/admin/api/')) {
        if (!(await isAdmin(request, env))) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
        }
        
        // --- ENHANCEMENT: Basic CSRF protection for mutating requests ---
        if (request.method !== 'GET') {
            const origin = request.headers.get('Origin');
            if (!origin || new URL(origin).hostname !== url.hostname) {
                return new Response(JSON.stringify({ error: 'Invalid Origin' }), { status: 403, headers: jsonHeader });
            }
        }

        // GET /admin/api/stats - Get dashboard stats
        if (pathname === '/admin/api/stats' && request.method === 'GET') {
            try {
                const stats = await fetchDashboardStats(env);
                return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }
        
        // GET /admin/api/users - List all users
        if (pathname === '/admin/api/users' && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, data_limit, used_traffic, notes FROM users ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }

        // POST /admin/api/users - Create a new user
        if (pathname === '/admin/api/users' && request.method === 'POST') {
             try {
                const { uuid, exp_date: expDate, exp_time: expTime, data_limit, notes } = await request.json();

                // Corrected and clarified validation logic
                if (!uuid || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid or missing fields. Use UUID, YYYY-MM-DD, and HH:MM:SS.');
                }
                 
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, data_limit, used_traffic, notes) VALUES (?, ?, ?, ?, 0, ?)")
                    .bind(uuid, expDate, expTime, data_limit || 0, notes || null).run();
                await env.USER_KV.put('user:' + uuid, JSON.stringify({ exp_date: expDate, exp_time: expTime, data_limit: data_limit || 0, used_traffic: 0 }));
                 
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            } catch (error) {
                 if (error.message?.includes('UNIQUE constraint failed')) {
                     return new Response(JSON.stringify({ error: 'A user with this UUID already exists.' }), { status: 409, headers: jsonHeader });
                 }
                 return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }
         
        // POST /admin/api/users/bulk-delete - Efficiently delete multiple users
        if (pathname === '/admin/api/users/bulk-delete' && request.method === 'POST') {
            try {
                const { uuids } = await request.json();
                if (!Array.isArray(uuids) || uuids.length === 0) {
                    throw new Error('Invalid request body: Expected an array of UUIDs.');
                }
                 
                const deleteUserStmt = env.DB.prepare("DELETE FROM users WHERE uuid = ?");
                const stmts = uuids.map(uuid => deleteUserStmt.bind(uuid));
                await env.DB.batch(stmts);

                // Delete from KV in parallel for speed
                await Promise.all(uuids.map(uuid => env.USER_KV.delete('user:' + uuid)));
                 
                return new Response(JSON.stringify({ success: true, count: uuids.length }), { status: 200, headers: jsonHeader });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }

        // Matcher for single-user routes
        const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/);

        // PUT /admin/api/users/:uuid - Update a single user
        if (userRouteMatch && request.method === 'PUT') {
            const uuid = userRouteMatch[1];
            try {
                const { exp_date: expDate, exp_time: expTime, data_limit, notes, reset_traffic } = await request.json();
                if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid date/time fields. Use YYYY-MM-DD and HH:MM:SS.');
                }
                 
                let query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ? WHERE uuid = ?";
                let binds = [expDate, expTime, data_limit || 0, notes || null, uuid];
                let usedTraffic = reset_traffic ? 0 : (await getUserData(env, uuid)).used_traffic;
                if (reset_traffic) {
                    query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ?, used_traffic = 0 WHERE uuid = ?";
                    binds = [expDate, expTime, data_limit || 0, notes || null, uuid];
                }
                await env.DB.prepare(query).bind(...binds).run();
                await env.USER_KV.put('user:' + uuid, JSON.stringify({ exp_date: expDate, exp_time: expTime, data_limit: data_limit || 0, used_traffic: usedTraffic }));
                 
                return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }
         
        // DELETE /admin/api/users/:uuid - Delete a single user
        if (userRouteMatch && request.method === 'DELETE') {
            const uuid = userRouteMatch[1];
             try {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete('user:' + uuid);
                return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonHeader });
            }
        }
         
        return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
    }

    // --- Page Serving Routes (/admin) ---
    if (pathname === '/admin') {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const token = crypto.randomUUID();
                await env.USER_KV.put('admin_session_token', token, { expirationTtl: 86400 }); // 24 hour session
                return new Response(null, {
                    status: 302,
                    headers: { 'Location': '/admin', 'Set-Cookie': 'auth_token=' + token + '; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict' },
                });
            } else {
                const loginPageWithError = adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>');
                return new Response(loginPageWithError, { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
         
        if (request.method === 'GET') {
            return new Response(await isAdmin(request, env) ? adminPanelHTML : adminLoginHTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
        }
         
        return new Response('Method Not Allowed', { status: 405 });
    }

    return new Response('Not found', { status: 404 });
}

// --- Original Code (Config, Handlers, etc.) --- (unchanged, just improved with traffic check)
const Config = {
  userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
  proxyIPs: ['nima.nscl.ir:443'],
  scamalytics: {
    username: 'revilseptember',
    apiKey: 'b2fc368184deb3d8ac914bd776b8215fe899dd8fef69fbaba77511acfbdeca0d',
    baseUrl: 'https://api12.scamalytics.com/v3/',
  },
  socks5: {
    enabled: false,
    relayMode: false,
    address: '',
  },
  fromEnv(env) {
    const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');
    return {
      userID: env.UUID || this.userID,
      proxyIP: proxyHost,
      proxyPort: proxyPort,
      proxyAddress: selectedProxyIP,
      scamalytics: {
        username: env.SCAMALYTICS_USERNAME || this.scamalytics.username,
        apiKey: env.SCAMALYTICS_API_KEY || this.scamalytics.apiKey,
        baseUrl: env.SCAMALYTICS_BASEURL || this.scamalytics.baseUrl,
      },
      socks5: {
        enabled: !!env.SOCKS5,
        relayMode: env.SOCKS5_RELAY === 'true' || this.socks5.relayMode,
        address: env.SOCKS5 || this.socks5.address,
      },
    };
  },
};

const CONST = {
  ED_PARAMS: { ed: 2560, eh: 'Sec-WebSocket-Protocol' },
  AT_SYMBOL: '@',
  VLESS_PROTOCOL: 'vless',
  WS_READY_STATE_OPEN: 1,
  WS_READY_STATE_CLOSING: 2,
};

function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return '/' + result + (query ? '?' + query : '');
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
  return tag + '-' + proto.toUpperCase();
}

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({
    type: 'ws',
    host,
    path,
  });
  if (security) params.set('security', security);
  if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp);
  if (alpn) params.set('alpn', alpn);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return 'vless://' + userID + '@' + address + ':' + port + '?' + params.toString() + '#' + encodeURIComponent(name);
}

function buildLink({ core, proto, userID, hostName, address, port, tag }) {
  const p = CORE_PRESETS[core][proto];
  return createVlessLink({
    userID,
    address,
    port,
    host: hostName,
    path: p.path(),
    security: p.security,
    sni: p.security === 'tls' ? hostName : undefined,
    fp: p.fp,
    alpn: p.alpn,
    extra: p.extra,
    name: makeName(tag, proto),
  });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [
    hostName, 'creativecommons.org', 'www.speedtest.net',
    'sky.rethinkdns.com', 'cfip.1323123.xyz', 'cfip.xxxxxxxx.tk',
    'go.inmobi.com', 'singapore.com', 'www.visa.com',
    'cf.090227.xyz', 'cdnjs.com', 'zula.ir',
  ];

  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];

  let links = [];

  const isPagesDeployment = hostName.endsWith('.pages.dev');

  mainDomains.forEach((domain, i) => {
    links.push(
      buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: 'D' + (i+1) })
    );

    if (!isPagesDeployment) {
      links.push(
        buildLink({ core, proto: 'tcp', userID, hostName, address: domain, port: pick(httpPorts), tag: 'D' + (i+1) })
      );
    }
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json');
    if (r.ok) {
      const json = await r.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
      ips.forEach((ip, i) => {
        const formattedAddress = ip.includes(':') ? '[' + ip + ']' : ip;
        links.push(
          buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: 'IP' + (i+1) })
        );

        if (!isPagesDeployment) {
          links.push(
            buildLink({ core, proto: 'tcp', userID, hostName, address: formattedAddress, port: pick(httpPorts), tag: 'IP' + (i+1) })
          );
        }
      });
    }
  } catch (e) { console.error('Fetch IP list failed', e); }

  return new Response(btoa(links.join('\n')), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const cfg = Config.fromEnv(env);
    const url = new URL(request.url);

    if (url.pathname.startsWith('/admin')) {
      return handleAdminRequest(request, env);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      const requestConfig = {
        userID: cfg.userID,
        proxyIP: cfg.proxyIP,
        proxyPort: cfg.proxyPort,
        socks5Address: cfg.socks5.address,
        socks5Relay: cfg.socks5.relayMode,
        enableSocks: cfg.socks5.enabled,
        parsedSocks5Address: cfg.socks5.enabled ? socks5AddressParser(cfg.socks5.address) : {},
      };
      return await ProtocolOverWSHandler(request, requestConfig, env);
    }

    if (url.pathname === '/scamalytics-lookup') {
        return handleScamalyticsLookup(request, cfg);
    }

    const handleSubscription = async (core) => {
      const uuid = url.pathname.slice('/' + core + '/'.length);
      if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
      const userData = await getUserData(env, uuid);
      if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time)) || (userData.data_limit > 0 && userData.used_traffic >= userData.data_limit)) {
        return new Response('Invalid or expired user or traffic limit reached', { status: 403 });
      }
      return handleIpSubscription(core, uuid, url.hostname);
    };

    if (url.pathname.startsWith('/xray/')) {
      return handleSubscription('xray');
    }

    if (url.pathname.startsWith('/sb/')) {
      return handleSubscription('sb');
    }

    const path = url.pathname.slice(1);
    if (isValidUUID(path)) {
      const userData = await getUserData(env, path);
      if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time)) || (userData.data_limit > 0 && userData.used_traffic >= userData.data_limit)) {
        return new Response('Invalid or expired user or traffic limit reached', { status: 403 });
      }
      return handleConfigPage(path, url.hostname, cfg.proxyAddress, userData.exp_date, userData.exp_time, userData.data_limit, userData.used_traffic);
    }
     
    if (env.ROOT_PROXY_URL) {
      try {
        const proxyUrl = new URL(env.ROOT_PROXY_URL);
        const targetUrl = new URL(request.url);

        targetUrl.hostname = proxyUrl.hostname;
        targetUrl.protocol = proxyUrl.protocol;
        targetUrl.port = proxyUrl.port;
         
        const newRequest = new Request(targetUrl, request);
         
        newRequest.headers.set('Host', proxyUrl.hostname);
        newRequest.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP'));
        newRequest.headers.set('X-Forwarded-Proto', 'https');
         
        const response = await fetch(newRequest);
         
        const mutableHeaders = new Headers(response.headers);
        mutableHeaders.delete('Content-Security-Policy');
        mutableHeaders.delete('Content-Security-Policy-Report-Only');
        mutableHeaders.delete('X-Frame-Options');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: mutableHeaders
        });

      } catch (e) {
        console.error('Reverse Proxy Error: ' + e.message);
        return new Response('Proxy configuration error or upstream server is down. Please check the ROOT_PROXY_URL variable. Error: ' + e.message, { status: 502 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

async function ProtocolOverWSHandler(request, config, env) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = '';
  let portWithRandomLog = '';
  let udpStreamWriter = null;
  let incomingTraffic = 0;
  let outgoingTraffic = 0;
  let uuid = '';
  const log = (info, event) => {
    console.log('[' + address + ':' + portWithRandomLog + '] ' + info, event || '');
  };
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = { value: null };
  let isDns = false;

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          outgoingTraffic += chunk.byteLength;
          if (udpStreamWriter) {
            return udpStreamWriter.write(chunk);
          }

          if (remoteSocketWapper.value) {
            const writer = remoteSocketWapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          const {
            hasError,
            message,
            addressType,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            ProtocolVersion = new Uint8Array([0, 0]),
            isUDP,
          } = await ProcessProtocolHeader(chunk, env);

          address = addressRemote;
          portWithRandomLog = portRemote + '--' + Math.random() + ' ' + (isUDP ? 'udp' : 'tcp');

          if (hasError) {
            controller.error(message);
            return;
          }

          uuid = stringify(new Uint8Array(chunk.slice(1, 17))); // Extract UUID from buffer

          const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isUDP) {
            if (portRemote === 53) {
              const dnsPipeline = await createDnsPipeline(webSocket, vlessResponseHeader, log);
              udpStreamWriter = dnsPipeline.write;
              await udpStreamWriter(rawClientData);
            } else {
              controller.error('UDP proxy only for DNS (port 53)');
            }
            return;
          }

          HandleTCPOutBound(
            remoteSocketWapper,
            addressType,
            addressRemote,
            portRemote,
            rawClientData,
            webSocket,
            vlessResponseHeader,
            log,
            config,
          );
        },
        close() {
          log('readableWebSocketStream closed');
          if (uuid) updateUsedTraffic(env, uuid, incomingTraffic + outgoingTraffic);
        },
        abort(err) {
          log('readableWebSocketStream aborted', err);
          if (uuid) updateUsedTraffic(env, uuid, incomingTraffic + outgoingTraffic);
        },
      }),
    )
    .catch(err => {
      console.error('Pipeline failed:', err.stack || err);
      if (uuid) updateUsedTraffic(env, uuid, incomingTraffic + outgoingTraffic);
    });

  return new Response(null, { status: 101, webSocket: client });
}

async function ProcessProtocolHeader(protocolBuffer, env) {
  if (protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };

  const dataView = new DataView(protocolBuffer);
  const version = dataView.getUint8(0);
  const slicedBufferString = stringify(new Uint8Array(protocolBuffer.slice(1, 17)));

  const userData = await getUserData(env, slicedBufferString);

  if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time)) || (userData.data_limit > 0 && userData.used_traffic >= userData.data_limit)) {
    return { hasError: true, message: 'invalid or expired user or traffic limit reached' };
  }

  const optLength = dataView.getUint8(17);
  const command = dataView.getUint8(18 + optLength);
  if (command !== 1 && command !== 2) return { hasError: true, message: 'command ' + command + ' is not supported' };

  const portIndex = 18 + optLength + 1;
  const portRemote = dataView.getUint16(portIndex);
  const addressType = dataView.getUint8(portIndex + 2);
  let addressValue, addressLength, addressValueIndex;

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValueIndex = portIndex + 3;
      addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain
      addressLength = dataView.getUint8(portIndex + 3);
      addressValueIndex = portIndex + 4;
      addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6
      addressLength = 16;
      addressValueIndex = portIndex + 3;
      addressValue = Array.from({ length: 8 }, (_, i) => dataView.getUint16(addressValueIndex + i * 2).toString(16)).join(':');
      break;
    default:
      return { hasError: true, message: 'invalid addressType: ' + addressType };
  }

  if (!addressValue) return { hasError: true, message: 'addressValue is empty, addressType is ' + addressType };

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    ProtocolVersion: new Uint8Array([version]),
    isUDP: command === 2,
  };
}

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
) {
  async function connectAndWrite(address, port, socks = false) {
    let tcpSocket;
    if (config.socks5Relay) {
      tcpSocket = await socks5Connect(addressType, address, port, log, config.parsedSocks5Address);
    } else {
      tcpSocket = socks
        ? await socks5Connect(addressType, address, port, log, config.parsedSocks5Address)
        : connect({ hostname: address, port: port });
    }
    remoteSocket.value = tcpSocket;
    log('connected to ' + address + ':' + port);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const tcpSocket = config.enableSocks
      ? await connectAndWrite(addressRemote, portRemote, true)
      : await connectAndWrite(
          config.proxyIP || addressRemote,
          config.proxyPort || portRemote,
          false,
        );

    tcpSocket.closed
      .catch(error => {
        console.log('retry tcpSocket closed error', error);
      })
      .finally(() => {
        safeCloseWebSocket(webSocket);
      });
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, retry, log);
}

function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => controller.enqueue(event.data));
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error');
        controller.error(err);
      });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    pull(_controller) { },
    cancel(reason) {
      log('ReadableStream was canceled, due to ' + reason);
      safeCloseWebSocket(webSocketServer);
    },
  });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log) {
  let hasIncomingData = false;
  let incomingTraffic = 0;
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          incomingTraffic += chunk.byteLength;
          if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN)
            throw new Error('WebSocket is not open');
          hasIncomingData = true;
          const dataToSend = protocolResponseHeader
            ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer()
            : chunk;
          webSocket.send(dataToSend);
          protocolResponseHeader = null;
        },
        close() {
          log('Remote connection readable closed. Had incoming data: ' + hasIncomingData);
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
  if (!hasIncomingData && retry) {
    log('No incoming data, retrying');
    retry();
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = new ArrayBuffer(binaryStr.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryStr.length; i++) {
      view[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: buffer, error: null };
  } catch (error) {
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

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

function unsafeStringify(arr, offset = 0) {
  return (
    byteToHex[arr[offset]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) throw new TypeError('Stringified UUID is invalid');
  return uuid;
}

async function createDnsPipeline(webSocket, vlessResponseHeader, log) {
  let isHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          try {
            const resp = await fetch('https://1.1.1.1/dns-query', {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: chunk,
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

            if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
              log('DNS query successful, length: ' + udpSize);
              if (isHeaderSent) {
                webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
              } else {
                webSocket.send(
                  await new Blob([
                    vlessResponseHeader,
                    udpSizeBuffer,
                    dnsQueryResult,
                  ]).arrayBuffer(),
                );
                isHeaderSent = true;
              }
            }
          } catch (error) {
            log('DNS query error: ' + error);
          }
        },
      }),
    )
    .catch(e => {
      log('DNS stream error: ' + e);
    });

  const writer = transformStream.writable.getWriter();
  return {
    write: (chunk) => writer.write(chunk),
  };
}

async function socks5Connect(addressType, addressRemote, portRemote, log, parsedSocks5Addr) {
  const { username, password, hostname, port } = parsedSocks5Addr;
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();

  await writer.write(new Uint8Array([5, 2, 0, 2])); // SOCKS5 greeting
  let res = (await reader.read()).value;
  if (res[0] !== 0x05 || res[1] === 0xff) throw new Error('SOCKS5 server connection failed.');

  if (res[1] === 0x02) {
    // Auth required
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
  }

  let DSTADDR;
  switch (addressType) {
    case 1:
      DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]);
      break;
    case 2:
      DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]);
      break;
    case 3:
      DSTADDR = new Uint8Array([
        4,
        ...addressRemote
          .split(':')
          .flatMap((x) => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)]),
      ]);
      break;
    default:
      throw new Error('Invalid addressType for SOCKS5: ' + addressType);
  }

  const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
  await writer.write(socksRequest);
  res = (await reader.read()).value;
  if (res[1] !== 0x00) throw new Error('Failed to open SOCKS5 connection.');

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
    if (authPart) {
      [username, password] = authPart.split(':');
      if (!username) throw new Error();
    }
    return { username, password, hostname, port };
  } catch {
    throw new Error('Invalid SOCKS5 address format. Expected [user:pass@]host:port');
  }
}

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

async function handleScamalyticsLookup(request, config) {
  const url = new URL(request.url);
  const ipToLookup = url.searchParams.get('ip');
  if (!ipToLookup) {
    return new Response(JSON.stringify({ error: 'Missing IP parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { username, apiKey, baseUrl } = config.scamalytics;
  if (!username || !apiKey) {
    return new Response(JSON.stringify({ error: 'Scamalytics API credentials not configured.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const scamalyticsUrl = baseUrl + username + '/?key=' + apiKey + '&ip=' + ipToLookup;
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    const scamalyticsResponse = await fetch(scamalyticsUrl);
    const responseBody = await scamalyticsResponse.json();
    return new Response(JSON.stringify(responseBody), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.toString() }), {
      status: 500,
      headers,
    });
  }
}

function handleConfigPage(userID, hostName, proxyAddress, expDate, expTime, dataLimit = 0, usedTraffic = 0) {
  const html = generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime, dataLimit, usedTraffic);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate = '', expTime = '', dataLimit = 0, usedTraffic = 0) {
  const singleXrayConfig = buildLink({
    core: 'xray', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: hostName + '-Xray',
  });

  const singleSingboxConfig = buildLink({
    core: 'sb', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: hostName + '-Singbox',
  });

  const subXrayUrl = 'https://' + hostName + '/xray/' + userID;
  const subSbUrl = 'https://' + hostName + '/sb/' + userID;

  const clientUrls = {
    universalAndroid: 'v2rayng://install-config?url=' + encodeURIComponent(subXrayUrl),
    karing: 'karing://install-config?url=' + encodeURIComponent(subXrayUrl),
    shadowrocket: 'shadowrocket://add/sub?url=' + encodeURIComponent(subXrayUrl) + '&name=' + encodeURIComponent(hostName),
    stash: 'stash://install-config?url=' + encodeURIComponent(subXrayUrl),
    streisand: 'streisand://import/' + btoa(subXrayUrl),
    clashMeta: 'clash://install-config?url=' + encodeURIComponent('https://revil-sub.pages.dev/sub/clash-meta?url=' + subSbUrl + '&remote_config=&udp=false&ss_uot=false&show_host=false&forced_ws0rtt=true'),
  };

  let expirationBlock = '';
  if (expDate && expTime) {
      const utcTimestamp = expDate + 'T' + expTime.split('.')[0] + 'Z';
      expirationBlock = '\n        <div class="expiration-card">\n          <div class="expiration-card-content">\n            <h2 class="expiration-title">Expiration Date</h2>\n            <div id="expiration-relative" class="expiration-relative-time"></div>\n            <hr class="expiration-divider">\n            <div id="expiration-display" data-utc-time="' + utcTimestamp + '">Loading expiration time...</div>\n          </div>\n        </div>\n      ';
  } else {
      expirationBlock = '\n        <div class="expiration-card">\n          <div class="expiration-card-content">\n            <h2 class="expiration-title">Expiration Date</h2>\n            <hr class="expiration-divider">\n            <div id="expiration-display">No expiration date set.</div>\n          </div>\n        </div>\n      ';
  }

  let trafficBlock = '';
  const trafficText = dataLimit === 0 ? formatBytes(usedTraffic) + ' / Unlimited' : formatBytes(usedTraffic) + ' / ' + formatBytes(dataLimit);
  const progressPercent = dataLimit === 0 ? 0 : (usedTraffic / dataLimit) * 100;
  let progressClass = '';
  if (progressPercent > 90) progressClass = 'danger';
  else if (progressPercent > 70) progressClass = 'warning';
  trafficBlock = '\n    <div class="expiration-card">\n      <div class="expiration-card-content">\n        <h2 class="expiration-title">Data Usage</h2>\n        <hr class="expiration-divider">\n        <div class="progress-bar-container"><div class="progress-bar ' + progressClass + '" style="width: ' + progressPercent + '%"></div></div>\n        <div class="traffic-text">' + trafficText + '</div>\n      </div>\n    </div>\n  ';

  const finalHTML = '<!doctype html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>VLESS Proxy Configuration</title>\n    <link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png">\n    <link rel="preconnect" href="https://fonts.googleapis.com">\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet">\n    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>\n    <style>' + getPageCSS() + '</style> \n  </head>\n  <body data-proxy-ip="' + proxyAddress + '">\n    ' + getPageHTML(singleXrayConfig, singleSingboxConfig, clientUrls, subXrayUrl, subSbUrl).replace(
        '', 
        expirationBlock + trafficBlock
    ) + '\n    <script>' + getPageScript() + '</script>\n  </body>\n</html>';

  return finalHTML;
}

function getPageCSS() {
  return '\n      * {\n        margin: 0;\n        padding: 0;\n        box-sizing: border-box;\n      }\n      @font-face {\n      font-family: "Aldine 401 BT Web";\n      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/Aldine401_Mersedeh.woff2") format("woff2");\n      font-weight: 400; font-style: normal; font-display: swap;\n    }\n    @font-face {\n      font-family: "Styrene B LC";\n      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Regular.woff2") format("woff2");\n      font-weight: 400; font-style: normal; font-display: swap;\n    }\n    @font-face {\n      font-family: "Styrene B LC";\n      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Medium.woff2") format("woff2");\n      font-weight: 500; font-style: normal; font-display: swap;\n    }\n      :root {\n        --background-primary: #2a2421; --background-secondary: #35302c; --background-tertiary: #413b35;\n        --border-color: #5a4f45; --border-color-hover: #766a5f; --text-primary: #e5dfd6; --text-secondary: #b3a89d;\n        --text-accent: #ffffff; --accent-primary: #be9b7b; --accent-secondary: #d4b595; --accent-tertiary: #8d6e5c;\n        --accent-primary-darker: #8a6f56; --button-text-primary: #2a2421; --button-text-secondary: var(--text-primary);\n        --shadow-color: rgba(0, 0, 0, 0.35); --shadow-color-accent: rgba(190, 155, 123, 0.4);\n        --border-radius: 12px; --transition-speed: 0.2s; --transition-speed-fast: 0.1s; --transition-speed-medium: 0.3s; --transition-speed-long: 0.6s;\n        --status-success: #70b570; --status-error: #e05d44; --status-warning: #e0bc44; --status-info: #4f90c4;\n        --serif: "Aldine 401 BT Web", "Times New Roman", Times, Georgia, ui-serif, serif;\n      --sans-serif: "Styrene B LC", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "Noto Color Emoji", sans-serif;\n      --mono-serif: "Fira Code", Cantarell, "Courier Prime", monospace;\n    }\n      body {\n        font-family: var(--sans-serif); font-size: 16px; font-weight: 400; font-style: normal;\n        background-color: var(--background-primary); color: var(--text-primary);\n        padding: 3rem; line-height: 1.5; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;\n      }\n      \n      @keyframes rgb-animation {\n        0% { transform: rotate(0deg); }\n        100% { transform: rotate(360deg); }\n      }\n      .expiration-card {\n        position: relative;\n        padding: 3px;\n        background: var(--background-secondary);\n        border-radius: var(--border-radius);\n        margin-bottom: 24px;\n        overflow: hidden;\n        z-index: 1;\n      }\n      .expiration-card::before {\n        content: \'\';\n        position: absolute;\n        top: -50%;\n        left: -50%;\n        width: 200%;\n        height: 200%;\n        background: conic-gradient(\n          #ff0000, #ff00ff, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000\n        );\n        animation: rgb-animation 4s linear infinite;\n        z-index: -1;\n      }\n      .expiration-card-content {\n        background: var(--background-secondary);\n        padding: 20px;\n        border-radius: calc(var(--border-radius) - 3px);\n      }\n      .expiration-title {\n        font-family: var(--serif);\n        font-size: 1.6rem;\n        font-weight: 400;\n        text-align: center;\n        color: var(--accent-secondary);\n        margin: 0 0 12px 0;\n      }\n      .expiration-relative-time {\n        text-align: center;\n        font-size: 1.1rem;\n        font-weight: 500;\n        margin-bottom: 12px;\n        padding: 4px 8px;\n        border-radius: 6px;\n      }\n      .expiration-relative-time.active {\n        color: var(--status-success);\n        background-color: rgba(112, 181, 112, 0.1);\n      }\n      .expiration-relative-time.expired {\n        color: var(--status-error);\n        background-color: rgba(224, 93, 68, 0.1);\n      }\n      .expiration-divider {\n        border: 0;\n        height: 1px;\n        background: var(--border-color);\n        margin: 0 auto 16px;\n        width: 80%;\n      }\n      #expiration-display { font-size: 0.9em; text-align: center; color: var(--text-secondary); }\n      #expiration-display span { display: block; margin-top: 8px; font-size: 0.9em; line-height: 1.6; }\n      #expiration-display strong { color: var(--text-primary); font-weight: 500; }\n      .progress-bar-container { width: 100%; background-color: #4B5563; border-radius: 4px; height: 8px; overflow: hidden; margin-top: 4px; }\n      .progress-bar { height: 100%; background-color: #22C55E; transition: width 0.3s ease; }\n      .progress-bar.warning { background-color: #F59E0B; }\n      .progress-bar.danger { background-color: #EF4444; }\n      .traffic-text { font-size: 12px; color: var(--text-secondary); margin-top: 4px; text-align: center; }\n\n      .container {\n        max-width: 800px; margin: 20px auto; padding: 0 12px; border-radius: var(--border-radius);\n        box-shadow: 0 6px 15px rgba(0, 0, 0, 0.2), 0 0 25px 8px var(--shadow-color-accent);\n        transition: box-shadow var(--transition-speed-medium) ease;\n      }\n      .container:hover { box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25), 0 0 35px 10px var(--shadow-color-accent); }\n      .header { text-align: center; margin-bottom: 30px; padding-top: 30px; }\n      .header h1 { font-family: var(--serif); font-weight: 400; font-size: 1.8rem; color: var(--text-accent); margin-top: 0px; margin-bottom: 2px; }\n      .header p { color: var(--text-secondary); font-size: 0.6rem; font-weight: 400; }\n      .config-card {\n        background: var(--background-secondary); border-radius: var(--border-radius); padding: 20px; margin-bottom: 24px; border: 1px solid var(--border-color);\n        transition: border-color var(--transition-speed) ease, box-shadow var(--transition-speed) ease;\n      }\n      .config-card:hover { border-color: var(--border-color-hover); box-shadow: 0 4px 8px var(--shadow-color); }\n      .config-title {\n        font-family: var(--serif); font-size: 1.6rem; font-weight: 400; color: var(--accent-secondary);\n        margin-bottom: 16px; padding-bottom: 13px; border-bottom: 1px solid var(--border-color);\n        display: flex; align-items: center; justify-content: space-between;\n      }\n      .config-title .refresh-btn {\n        position: relative; overflow: hidden; display: flex; align-items: center; gap: 4px;\n        font-family: var(--serif); font-size: 12px; padding: 6px 12px; border-radius: 6px;\n        color: var(--accent-secondary); background-color: var(--background-tertiary); border: 1px solid var(--border-color);\n        cursor: pointer;\n        transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, color var(--transition-speed) ease, transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;\n      }\n      .config-title .refresh-btn::before {\n        content: \'\'; position: absolute; top: 0; left: 0; width: 100%; height: 100%;\n        background: linear-gradient(120deg, transparent, rgba(255, 255, 255, 0.2), transparent);\n        transform: translateX(-100%); transition: transform var(--transition-speed-long) ease; z-index: 1;\n      }\n      .config-title .refresh-btn:hover {\n        letter-spacing: 0.5px; font-weight: 600; background-color: #4d453e; color: var(--accent-primary);\n        border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color);\n      }\n      .config-title .refresh-btn:hover::before { transform: translateX(100%); }\n      .config-title .refresh-btn:active { transform: translateY(0px) scale(0.98); box-shadow: none; }\n      .refresh-icon { width: 12px; height: 12px; stroke: currentColor; }\n      .config-content {\n        position: relative; background: var(--background-tertiary); border-radius: var(--border-radius);\n        padding: 16px; margin-bottom: 20px; border: 1px solid var(--border-color);\n      }\n      .config-content pre {\n        overflow-x: auto; font-family: var(--mono-serif); font-size: 7px; color: var(--text-primary);\n        margin: 0; white-space: pre-wrap; word-break: break-all;\n      }\n      .button {\n        display: inline-flex; align-items: center; justify-content: center; gap: 8px;\n        padding: 8px 16px; border-radius: var(--border-radius); font-size: 15px; font-weight: 500;\n        cursor: pointer; border: 1px solid var(--border-color); background-color: var(--background-tertiary);\n        color: var(--button-text-secondary);\n        transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, color var(--transition-speed) ease, transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;\n        -webkit-tap-highlight-color: transparent; touch-action: manipulation; text-decoration: none; overflow: hidden; z-index: 1;\n      }\n      .button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }\n      .button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; transition: opacity var(--transition-speed) ease; }\n      .copy-buttons {\n        position: relative; display: flex; gap: 4px; overflow: hidden; align-self: center;\n        font-family: var(--serif); font-size: 13px; padding: 6px 12px; border-radius: 6px;\n        color: var(--accent-secondary); border: 1px solid var(--border-color);\n        transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, color var(--transition-speed) ease, transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;\n      }\n      .copy-buttons::before, .client-btn::before {\n        content: \'\'; position: absolute; top: 0; left: 0; width: 100%; height: 100%;\n        background: linear-gradient(120deg, transparent, rgba(255, 255, 255, 0.2), transparent);\n        transform: translateX(-100%); transition: transform var(--transition-speed-long) ease; z-index: -1;\n      }\n      .copy-buttons:hover::before, .client-btn:hover::before { transform: translateX(100%); }\n      .copy-buttons:hover {\n        background-color: #4d453e; letter-spacing: 0.5px; font-weight: 600;\n        border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color);\n      }\n      .copy-buttons:active { transform: translateY(0px) scale(0.98); box-shadow: none; }\n      .copy-icon { width: 12px; height: 12px; stroke: currentColor; }\n      .client-buttons-container { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }\n      .client-buttons-container h3 { font-family: var(--serif); font-size: 14px; color: var(--text-secondary); margin: 8px 0 -8px 0; font-weight: 400; text-align: center; }\n      .client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }\n      .client-btn {\n        width: 100%; background-color: var(--accent-primary); color: var(--background-tertiary);\n        border-radius: 6px; border-color: var(--accent-primary-darker); position: relative; overflow: hidden;\n        transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);\n      }\n      .client-btn::after {\n        content: \'\'; position: absolute; bottom: -5px; left: 0; width: 100%; height: 5px;\n        background: linear-gradient(90deg, var(--accent-tertiary), var(--accent-secondary));\n        opacity: 0; transition: all 0.3s ease; z-index: 0;\n      }\n      .client-btn:hover {\n        text-transform: uppercase; letter-spacing: 0.3px; transform: translateY(-3px);\n        background-color: var(--accent-secondary); color: var(--button-text-primary);\n        box-shadow: 0 5px 15px rgba(190, 155, 123, 0.5); border-color: var(--accent-secondary);\n      }\n      .client-btn:hover::after { opacity: 1; bottom: 0; }\n      .client-btn:active { transform: translateY(0) scale(0.98); box-shadow: 0 2px 3px rgba(0, 0, 0, 0.2); background-color: var(--accent-primary-darker); }\n      .client-btn .client-icon { position: relative; z-index: 2; transition: transform 0.3s ease; }\n      .client-btn:hover .client-icon { transform: rotate(15deg) scale(1.1); }\n      .client-btn .button-text { position: relative; z-index: 2; transition: letter-spacing 0.3s ease; }\n      .client-btn:hover .button-text { letter-spacing: 0.5px; }\n    .client-icon { width: 18px; height: 18px; border-radius: 6px; background-color: var(--background-secondary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }\n    .client-icon svg { width: 14px; height: 14px; fill: var(--accent-secondary); }\n    .button.copied { background-color: var(--accent-secondary) !important; color: var(--background-tertiary) !important; }\n    .button.error { background-color: #c74a3b !important; color: var(--text-accent) !important; }\n    .footer { text-align: center; margin-top: 20px; margin-bottom: 40px; color: var(--text-secondary); font-size: 8px; }\n    .footer p { margin-bottom: 0px; }\n    ::-webkit-scrollbar { width: 8px; height: 8px; }\n    ::-webkit-scrollbar-track { background: var(--background-primary); border-radius: 4px; }\n    ::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; border: 2px solid var(--background-primary); }\n    ::-webkit-scrollbar-thumb:hover { background: var(--border-color-hover); }\n    * { scrollbar-width: thin; scrollbar-color: var(--border-color) var(--background-primary); }\n    .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 24px; }\n    .ip-info-section { background-color: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 20px; }\n    .ip-info-header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; }\n    .ip-info-header svg { width: 20px; height: 20px; stroke: var(--accent-secondary); }\n    .ip-info-header h3 { font-family: var(--serif); font-size: 18px; font-weight: 400; color: var(--accent-secondary); margin: 0; }\n    .ip-info-content { display: flex; flex-direction: column; gap: 10px; }\n    .ip-info-item { display: flex; flex-direction: column; gap: 2px; }\n    .ip-info-item .label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }\n    .ip-info-item .value { font-size: 14px; color: var(--text-primary); word-break: break-all; line-height: 1.4; }\n    .badge { display: inline-flex; align-items: center; justify-content: center; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }\n    .badge-yes { background-color: rgba(112, 181, 112, 0.15); color: var(--status-success); border: 1px solid rgba(112, 181, 112, 0.3); }\n    .badge-no { background-color: rgba(224, 93, 68, 0.15); color: var(--status-error); border: 1px solid rgba(224, 93, 68, 0.3); }\n    .badge-neutral { background-color: rgba(79, 144, 196, 0.15); color: var(--status-info); border: 1px solid rgba(79, 144, 196, 0.3); }\n    .badge-warning { background-color: rgba(224, 188, 68, 0.15); color: var(--status-warning); border: 1px solid rgba(224, 188, 68, 0.3); }\n    .skeleton { display: block; background: linear-gradient(90deg, var(--background-tertiary) 25%, var(--background-secondary) 50%, var(--background-tertiary) 75%); background-size: 200% 100%; animation: loading 1.5s infinite; border-radius: 4px; height: 16px; }\n    @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }\n    .country-flag { display: inline-block; width: 18px; height: auto; max-height: 14px; margin-right: 6px; vertical-align: middle; border-radius: 2px; }\n    @media (max-width: 768px) {\n      body { padding: 20px; } .container { padding: 0 14px; width: min(100%, 768px); }\n      .ip-info-grid { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 18px; }\n      .header h1 { font-size: 1.8rem; } .header p { font-size: 0.7rem }\n      .ip-info-section { padding: 14px; gap: 18px; } .ip-info-header h3 { font-size: 16px; }\n      .ip-info-header { gap: 8px; } .ip-info-content { gap: 8px; }\n      .ip-info-item .label { font-size: 11px; } .ip-info-item .value { font-size: 13px; }\n      .config-card { padding: 16px; } .config-title { font-size: 18px; }\n      .config-title .refresh-btn { font-size: 11px; } .config-content pre { font-size: 12px; }\n      .client-buttons { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }\n      .button { font-size: 12px; } .copy-buttons { font-size: 11px; }\n    }\n    @media (max-width: 480px) {\n      body { padding: 16px; } .container { padding: 0 12px; width: min(100%, 390px); }\n      .header h1 { font-size: 20px; } .header p { font-size: 8px; }\n      .ip-info-section { padding: 14px; gap: 16px; }\n      .ip-info-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }\n      .ip-info-header h3 { font-size: 14px; } .ip-info-header { gap: 6px; } .ip-info-content { gap: 6px; }\n      .ip-info-header svg { width: 18px; height: 18px; } .ip-info-item .label { font-size: 9px; }\n      .ip-info-item .value { font-size: 11px; } .badge { padding: 2px 6px; font-size: 10px; border-radius: 10px; }\n      .config-card { padding: 10px; } .config-title { font-size: 16px; }\n      .config-title .refresh-btn { font-size: 10px; } .config-content { padding: 12px; }\n      .config-content pre { font-size: 10px; }\n      .client-buttons { grid-template-columns: repeat(auto-fill, minmax(100%, 1fr)); }\n      .button { padding: 4px 8px; font-size: 11px; } .copy-buttons { font-size: 10px; } .footer { font-size: 10px; }\n      }\n    @media (max-width: 359px) {\n          body { padding: 12px; font-size: 14px; } .container { max-width: 100%; padding: 8px; }\n          .header h1 { font-size: 16px; } .header p { font-size: 6px; }\n          .ip-info-section { padding: 12px; gap: 12px; }\n          .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }\n          .ip-info-header h3 { font-size: 13px; } .ip-info-header { gap: 4px; } .ip-info-content { gap: 4px; }\n          .ip-info-header svg { width: 16px; height: 16px; } .ip-info-item .label { font-size: 8px; }\n  .ip-info-item .value { font-size: 10px; } .badge { padding: 1px 4px; font-size: 9px; border-radius: 8px; }\n          .config-card { padding: 8px; } .config-title { font-size: 13px; } .config-title .refresh-btn { font-size: 9px; }\n          .config-content { padding: 8px; } .config-content pre { font-size: 8px; }\n  .client-buttons { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }\n          .button { padding: 3px 6px; font-size: 10px; } .copy-buttons { font-size: 9px; } .footer { font-size: 7px; }\n        }\n     \n        @media (min-width: 360px) { .container { max-width: 95%; } }\n        @media (min-width: 480px) { .container { max-width: 90%; } }\n        @media (min-width: 640px) { .container { max-width: 600px; } }\n        @media (min-width: 768px) { .container { max-width: 720px; } }\n        @media (min-width: 1024px) { .container { max-width: 800px; } }\n  ';
}

function getPageHTML(singleXrayConfig, singleSingboxConfig, clientUrls, subXrayUrl, subSbUrl) {
  return '\n    <div class="container">\n      <div class="header">\n        <h1>VLESS Proxy Configuration</h1>\n        <p>Copy the configuration or import directly into your client</p>\n      </div>\n\n      <div class="config-card">\n        <div class="config-title">\n          <span>Network Information</span>\n          <button id="refresh-ip-info" class="refresh-btn" aria-label="Refresh IP information">\n            <svg class="refresh-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />\n            </svg>\n            Refresh\n          </button>\n        </div>\n        <div class="ip-info-grid">\n          <div class="ip-info-section">\n            <div class="ip-info-header">\n              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                <path d="M15.5 2H8.6c-.4 0-.8.2-1.1.5-.3.3-.5.7-.5 1.1v16.8c0 .4.2.8.5 1.1.3.3.7.5 1.1.5h6.9c.4 0 .8-.2 1.1-.5.3-.3.5-.7.5-1.1V3.6c0-.4-.2-.8-.5-1.1-.3-.3-.7-.5-1.1-.5z" />\n                <circle cx="12" cy="18" r="1" />\n              </svg>\n              <h3>Proxy Server</h3>\n            </div>\n            <div class="ip-info-content">\n              <div class="ip-info-item"><span class="label">Proxy Host</span><span class="value" id="proxy-host"><span class="skeleton" style="width: 150px"></span></span></div>\n              <div class="ip-info-item"><span class="label">IP Address</span><span class="value" id="proxy-ip"><span class="skeleton" style="width: 120px"></span></span></div>\n              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton" style="width: 100px"></span></span></div>\n              <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="proxy-isp"><span class="skeleton" style="width: 140px"></span></span></div>\n            </div>\n          </div>\n          <div class="ip-info-section">\n            <div class="ip-info-header">\n              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />\n              </svg>\n              <h3>Your Connection</h3>\n            </div>\n            <div class="ip-info-content">\n              <div class="ip-info-item"><span class="label">Your IP</span><span class="value" id="client-ip"><span class="skeleton" style="width: 110px"></span></span></div>\n              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton" style="width: 90px"></span></span></div>\n              <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="client-isp"><span class="skeleton" style="width: 130px"></span></span></div>\n              <div class="ip-info-item"><span class="label">Risk Score</span><span class="value" id="client-proxy"><span class="skeleton" style="width: 100px"></span></span></div>\n            </div>\n          </div>\n        </div>\n      </div>\n\n      <div class="config-card">\n        <div class="config-title">\n          <span>Xray Subscription</span>\n          <button id="copy-xray-sub-btn" class="button copy-buttons" data-clipboard-text="' + subXrayUrl + '">\n             <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>\n             Copy Link\n          </button>\n        </div>\n        <div class="config-content" style="display:none;"><pre id="xray-config">' + singleXrayConfig + '</pre></div>\n        <div class="client-buttons-container">\n            <h3>Android</h3>\n            <div class="client-buttons">\n                <a href="' + clientUrls.universalAndroid + '" class="button client-btn">\n                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M4.3,17.4 L19.7,17.4 L19.7,6.6 L4.3,6.6 L4.3,17.4 Z M3,4 L21,4 C22.1,4 23,4.9 23,6 L23,18 C23,19.1 22.1,20 21,20 L3,20 C1.9,20 1,19.1 1,18 L1,6 C1,4.9 1.9,4 3,4 L3,4 Z"/></svg></span>\n                    <span class="button-text">Universal Import (V2rayNG, etc.)</span>\n                </a>\n                 <a href="' + clientUrls.karing + '" class="button client-btn">\n                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2L4 5v6c0 5.5 3.5 10.7 8 12.3 4.5-1.6 8-6.8 8-12.3V5l-8-3z" /></svg></span>\n                    <span class="button-text">Import to Karing</span>\n                </a>\n            </div>\n            <h3>iOS</h3>\n            <div class="client-buttons">\n                <a href="' + clientUrls.shadowrocket + '" class="button client-btn">\n                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12,2 C6.48,2 2,6.48 2,12 C2,17.52 6.48,22 12,22 C17.52,22 22,17.52 22,12 C22,6.48 17.52,2 12,2 Z M16.29,15.71 L12,11.41 L7.71,15.71 L6.29,14.29 L10.59,10 L6.29,5.71 L7.71,4.29 L12,8.59 L16.29,4.29 L17.71,5.71 L13.41,10 L17.71,14.29 L16.29,15.71 Z"/></svg></span>\n                    <span class="button-text">Import to Shadowrocket</span>\n                </a>\n                <a href="' + clientUrls.stash + '" class="button client-btn">\n                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12,2 L2,7 L12,12 L22,7 L12,2 Z M2,17 L12,22 L22,17 L12,12 L2,17 Z M2,12 L12,17 L22,12 L12,7 L2,12 Z"/></svg></span>\n                    <span class="button-text">Import to Stash</span>\n                </a>\n                <a href="' + clientUrls.streisand + '" class="button client-btn">\n                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M19,3 H5 C3.9,3 3,3.9 3,5 v14 c0,1.1 0.9,2 2,2 h14 c1.1,0 2-0.9 2-2 V5 C21,3.9 20.1,3 19,3 Z M12,11.5 c-0.83,0 -1.5,-0.67 -1.5,-1.5 s0.67,-1.5 1.5,-1.5 s1.5,0.67 1.5,1.5 S12.83,11.5 12,11.5 Z"/></svg></span>\n                    <span class="button-text">Import to Streisand</span>\n                </a>\n            </div>\n            <h3>Desktop / Other</h3>\n            <div class="client-buttons">\n              <button class="button client-btn" onclick="toggleQR(\'xray\', \'' + subXrayUrl + '\')">\n                <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zm0 10h6v6H4zm10-10h6v6h-6zm0 10h6v6h-6zm-4-3h2v2h-2zm0-4h2v2h-2zm-4 0h2v2H6zm-2-2h2v2H4zm12 0h2v2h-2zM9 6h2v2H9zm4 0h2v2h-2zm2 5h2v2h-2zM9 13h2v2H9zm-2 2h2v2H7zm-2-2h2v2H5z"/></svg></span>\n                <span class="button-text">Show QR Code</span>\n              </button>\n            </div>\n            <div id="qr-xray-container" style="display:none; text-align:center; margin-top: 10px; background: white; padding: 10px; border-radius: 8px; max-width: 276px; margin-left: auto; margin-right: auto;"><div id="qr-xray"></div></div>\n        </div>\n      </div>\n\n      <div class="config-card">\n        <div class="config-title">\n          <span>Sing-Box / Clash Subscription</span>\n          <button id="copy-sb-sub-btn" class="button copy-buttons" data-clipboard-text="' + subSbUrl + '">\n            <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>\n            Copy Link\n          </button>\n        </div>\n        <div class="config-content" style="display:none;"><pre id="singbox-config">' + singleSingboxConfig + '</pre></div>\n        <div class="client-buttons-container">\n            <h3>Android / Windows / macOS</h3>\n            <div class="client-buttons">\n                <a href="' + clientUrls.clashMeta + '" class="button client-btn">\n                  <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" /></svg></span>\n                  <span class="button-text">Import to Clash Meta / Stash</span>\n                </a>\n            </div>\n            <h3>Desktop / Other</h3>\n             <div class="client-buttons">\n              <button class="button client-btn" onclick="toggleQR(\'singbox\', \'' + subSbUrl + '\')">\n                <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zm0 10h6v6H4zm10-10h6v6h-6zm0 10h6v6h-6zm-4-3h2v2h-2zm0-4h2v2h-2zm-4 0h2v2H6zm-2-2h2v2H4zm12 0h2v2h-2zM9 6h2v2H9zm4 0h2v2h-2zm2 5h2v2h-2zM9 13h2v2H9zm-2 2h2v2H7zm-2-2h2v2H5z"/></svg></span>\n                <span class="button-text">Show QR Code</span>\n              </button>\n            </div>\n            <div id="qr-singbox-container" style="display:none; text-align:center; margin-top: 10px; background: white; padding: 10px; border-radius: 8px; max-width: 276px; margin-left: auto; margin-right: auto;"><div id="qr-singbox"></div></div>\n        </div>\n      </div>\n\n      <div class="footer">\n        <p>© <span id="current-year">' + new Date().getFullYear() + '</span> REvil - All Rights Reserved</p>\n        <p>Secure. Private. Fast.</p>\n      </div>\n    </div>\n  ';
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getPageScript() {
  return '\n      function copyToClipboard(button, text) {\n        const originalHTML = button.innerHTML;\n        navigator.clipboard.writeText(text).then(() => {\n          button.innerHTML = \'<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Copied!\';\n          button.classList.add("copied");\n          button.disabled = true;\n          setTimeout(() => {\n            button.innerHTML = originalHTML;\n            button.classList.remove("copied");\n            button.disabled = false;\n          }, 1200);\n        }).catch(err => {\n          console.error("Failed to copy text: ", err);\n        });\n      }\n\n      function toggleQR(id, url) {\n        var container = document.getElementById(\'qr-\' + id + \'-container\');\n        if (container.style.display === \'none\' || container.style.display === \'\') {\n            container.style.display = \'block\';\n            if (!url) {\n                console.error("Subscription URL for QR code is missing.");\n                container.innerHTML = "<p style=\'color:red; padding: 10px;\'>Error: Subscription URL not provided.</p>";\n                return;\n            }\n            var qrElement = document.getElementById(\'qr-\' + id);\n            qrElement.innerHTML = \'\'; \n            if (!qrElement.hasChildNodes()) {\n                new QRCode(qrElement, {\n                    text: url,\n                    width: 256,\n                    height: 256,\n                    colorDark: "#2a2421",\n                    colorLight: "#e5dfd6",\n                    correctLevel: QRCode.CorrectLevel.H\n                });\n            }\n        } else {\n            container.style.display = \'none\';\n        }\n      }\n\n      async function fetchClientPublicIP() {\n        try {\n          const response = await fetch(\'https://api.ipify.org?format=json\');\n          if (!response.ok) throw new Error(\'HTTP error! status: \' + response.status);\n          return (await response.json()).ip;\n        } catch (error) {\n          console.error(\'Error fetching client IP:\', error);\n          return null;\n        }\n      }\n\n      async function fetchScamalyticsClientInfo(clientIp) {\n        if (!clientIp) return null;\n        try {\n          const response = await fetch(\'/scamalytics-lookup?ip=\' + encodeURIComponent(clientIp));\n          if (!response.ok) {\n            const errorText = await response.text();\n            throw new Error(\'Worker request failed! status: \' + response.status + \', details: \' + errorText);\n          }\n          const data = await response.json();\n          if (data.scamalytics && data.scamalytics.status === \'error\') {\n              throw new Error(data.scamalytics.error || \'Scamalytics API error via Worker\');\n          }\n          return data;\n        } catch (error) {\n          console.error(\'Error fetching from Scamalytics via Worker:\', error);\n          return null;\n        }\n      }\n\n      function updateScamalyticsClientDisplay(data) {\n        const prefix = \'client\';\n        if (!data  || !data.scamalytics  || data.scamalytics.status !== \'ok\') {\n          showError(prefix, (data && data.scamalytics && data.scamalytics.error) || \'Could not load client data from Scamalytics\');\n          return;\n        }\n        const sa = data.scamalytics;\n        const dbip = data.external_datasources ? data.external_datasources.dbip : null;\n        const elements = {\n          ip: document.getElementById(prefix + \'-ip\'), location: document.getElementById(prefix + \'-location\'),\n          isp: document.getElementById(prefix + \'-isp\'), proxy: document.getElementById(prefix + \'-proxy\')\n        };\n        if (elements.ip) elements.ip.textContent = sa.ip || "N/A";\n        if (elements.location) {\n          const city = dbip ? dbip.ip_city : \'\';\n          const countryName = dbip ? dbip.ip_country_name : \'\';\n          const countryCode = dbip && dbip.ip_country_code ? dbip.ip_country_code.toLowerCase() : \'\';\n          let locationString = \'N/A\';\n          let flagElementHtml = countryCode ? \'<img src="https://flagcdn.com/w20/\' + countryCode + \'.png" srcset="https://flagcdn.com/w40/\' + countryCode + \'.png 2x" alt="\' + (dbip ? dbip.ip_country_code : \'\') + \'" class="country-flag"> \' : \'\';\n          let textPart = [city, countryName].filter(Boolean).join(\', \');\n          if (flagElementHtml || textPart) locationString = (flagElementHtml + textPart).trim();\n          elements.location.innerHTML = locationString || "N/A";\n        }\n        if (elements.isp) elements.isp.textContent = sa.scamalytics_isp  || (dbip ? dbip.isp_name : "")  || "N/A";\n        if (elements.proxy) {\n          const score = sa.scamalytics_score;\n          const risk = sa.scamalytics_risk;\n          let riskText = "Unknown";\n          let badgeClass = "badge-neutral";\n          if (risk && score !== undefined) {\n              riskText = score + \' - \' + risk.charAt(0).toUpperCase() + risk.slice(1);\n              switch (risk.toLowerCase()) {\n                  case "low": badgeClass = "badge-yes"; break;\n                  case "medium": badgeClass = "badge-warning"; break;\n                  case "high": case "very high": badgeClass = "badge-no"; break;\n              }\n          }\n          elements.proxy.innerHTML = \'<span class="badge \' + badgeClass + \'">\' + riskText + \'</span>\';\n        }\n      }\n\n      function showError(prefix, message, originalHostForProxy) {\n        if (typeof message === \'undefined\') message = "Could not load data";\n        if (typeof originalHostForProxy === \'undefined\') originalHostForProxy = null;\n        const errorMessage = "N/A";\n        const elements = (prefix === \'proxy\') \n          ? [\'host\', \'ip\', \'location\', \'isp\']\n          : [\'ip\', \'location\', \'isp\', \'proxy\'];\n         \n        elements.forEach(function(key) {\n          const el = document.getElementById(prefix + \'-\' + key);\n          if (!el) return;\n          if (key === \'host\' && prefix === \'proxy\') el.textContent = originalHostForProxy || errorMessage;\n          else if (key === \'proxy\' && prefix === \'client\') el.innerHTML = \'<span class="badge badge-neutral">N/A</span>\';\n          else el.innerHTML = errorMessage;\n        });\n        console.warn(prefix + \' data loading failed: \' + message);\n      }\n\n      async function fetchIpApiIoInfo(ip) {\n        try {\n          const response = await fetch(\'https://ip-api.io/json/\' + ip);\n          if (!response.ok) throw new Error(\'HTTP error! status: \' + response.status);\n          return await response.json();\n        } catch (error) {\n          console.error(\'IP API Error (ip-api.io):\', error);\n          return null;\n        }\n      }\n\n      function updateIpApiIoDisplay(geo, prefix, originalHost) {\n        const hostElement = document.getElementById(prefix + \'-host\');\n        if (hostElement) hostElement.textContent = originalHost || "N/A";\n        const elements = {\n          ip: document.getElementById(prefix + \'-ip\'), location: document.getElementById(prefix + \'-location\'),\n          isp: document.getElementById(prefix + \'-isp\')\n        };\n        if (!geo) {\n          Object.values(elements).forEach(function(el) { if(el) el.innerHTML = "N/A"; });\n          return;\n        }\n        if (elements.ip) elements.ip.textContent = geo.ip || "N/A";\n        if (elements.location) {\n          const city = geo.city || \'\';\n          const countryName = geo.country_name || \'\';\n          const countryCode = geo.country_code ? geo.country_code.toLowerCase() : \'\';\n          let flagElementHtml = countryCode ? \'<img src="https://flagcdn.com/w20/\' + countryCode + \'.png" srcset="https://flagcdn.com/w40/\' + countryCode + \'.png 2x" alt="\' + geo.country_code + \'" class="country-flag"> \' : \'\';\n          let textPart = [city, countryName].filter(Boolean).join(\', \');\n          elements.location.innerHTML = (flagElementHtml || textPart) ? (flagElementHtml + textPart).trim() : "N/A";\n        }\n        if (elements.isp) elements.isp.textContent = geo.isp  || geo.organisation  || geo.as_name  || geo.as  || \'N/A\';\n      }\n\n      async function loadNetworkInfo() {\n        try {\n          const proxyIpWithPort = document.body.getAttribute(\'data-proxy-ip\') || "N/A";\n          const proxyDomainOrIp = proxyIpWithPort.split(\':\')[0];\n          const proxyHostEl = document.getElementById(\'proxy-host\');\n          if(proxyHostEl) proxyHostEl.textContent = proxyIpWithPort;\n\n          if (proxyDomainOrIp && proxyDomainOrIp !== "N/A") {\n            let resolvedProxyIp = proxyDomainOrIp;\n            if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(proxyDomainOrIp) && !/^[0-9a-fA-F:]+$/.test(proxyDomainOrIp)) {\n              try {\n                const dnsRes = await fetch(\'https://dns.google/resolve?name=\' + encodeURIComponent(proxyDomainOrIp) + \'&type=A\');\n                if (dnsRes.ok) {\n                    const dnsData = await dnsRes.json();\n                    const ipAnswer = dnsData.Answer ? dnsData.Answer.find(function(a) { return a.type === 1; }) : null;\n                    if (ipAnswer) resolvedProxyIp = ipAnswer.data;\n                }\n              } catch (e) { console.error(\'DNS resolution for proxy failed:\', e); }\n            }\n            const proxyGeoData = await fetchIpApiIoInfo(resolvedProxyIp);\n            updateIpApiIoDisplay(proxyGeoData, \'proxy\', proxyIpWithPort);\n          } else {\n            showError(\'proxy\', \'Proxy Host not available\', proxyIpWithPort);\n          }\n\n          const clientIp = await fetchClientPublicIP();\n          if (clientIp) {\n            const clientIpElement = document.getElementById(\'client-ip\');\n            if(clientIpElement) clientIpElement.textContent = clientIp;\n            const scamalyticsData = await fetchScamalyticsClientInfo(clientIp);\n            updateScamalyticsClientDisplay(scamalyticsData);\n          } else {\n            showError(\'client\', \'Could not determine your IP address.\');\n          }\n        } catch (error) {\n          console.error(\'Overall network info loading failed:\', error);\n          showError(\'proxy\', \'Error: \' + error.message, document.body.getAttribute(\'data-proxy-ip\') || "N/A");\n          showError(\'client\', \'Error: \' + error.message);\n        }\n      }\n\n      function displayExpirationTimes() {\n        const expElement = document.getElementById(\'expiration-display\');\n        const relativeElement = document.getElementById(\'expiration-relative\');\n\n        if (!expElement || !expElement.dataset.utcTime) {\n            if (expElement) expElement.textContent = \'Expiration time not available.\';\n            if (relativeElement) relativeElement.style.display = \'none\';\n            return;\n        }\n\n        const utcDate = new Date(expElement.dataset.utcTime);\n        if (isNaN(utcDate.getTime())) {\n            expElement.textContent = \'Invalid expiration time format.\';\n            if (relativeElement) relativeElement.style.display = \'none\';\n            return;\n        }\n         \n        // --- START: Relative Time Calculation ---\n        const now = new Date();\n        const diffSeconds = (utcDate.getTime() - now.getTime()) / 1000;\n        const isExpired = diffSeconds < 0;\n\n        const rtf = new Intl.RelativeTimeFormat(\'en\', { numeric: \'auto\' });\n        let relativeTimeStr = \'\';\n\n        if (Math.abs(diffSeconds) < 60) {\n            relativeTimeStr = rtf.format(Math.round(diffSeconds), \'second\');\n        } else if (Math.abs(diffSeconds) < 3600) {\n            relativeTimeStr = rtf.format(Math.round(diffSeconds / 60), \'minute\');\n        } else if (Math.abs(diffSeconds) < 86400) {\n            relativeTimeStr = rtf.format(Math.round(diffSeconds / 3600), \'hour\');\n        } else {\n            relativeTimeStr = rtf.format(Math.round(diffSeconds / 86400), \'day\');\n        }\n\n        if (relativeElement) {\n            relativeElement.textContent = isExpired ? \'Expired \' + relativeTimeStr : \'Expires \' + relativeTimeStr;\n            relativeElement.classList.add(isExpired ? \'expired\' : \'active\');\n        }\n        // --- END: Relative Time Calculation ---\n\n        const commonOptions = {\n            year: \'numeric\', month: \'long\', day: \'numeric\',\n            hour: \'2-digit\', minute: \'2-digit\', second: \'2-digit\',\n            hour12: true, timeZoneName: \'short\'\n        };\n\n        const localTimeStr = utcDate.toLocaleString(undefined, commonOptions);\n        const tehranTimeStr = utcDate.toLocaleString(\'en-US\', { ...commonOptions, timeZone: \'Asia/Tehran\' });\n        const utcTimeStr = utcDate.toISOString().replace(\'T\', \' \').substring(0, 19) + \' UTC\';\n\n        expElement.innerHTML = \'<span><strong>Your Local Time:</strong> \' + localTimeStr + \'</span><span><strong>Tehran Time:</strong> \' + tehranTimeStr + \'</span><span><strong>Universal Time:</strong> \' + utcTimeStr + \'</span>\';\n      }\n\n      document.addEventListener(\'DOMContentLoaded\', () => {\n        loadNetworkInfo();\n        displayExpirationTimes();\n\n        document.querySelectorAll(\'.copy-buttons\').forEach(button => {\n          button.addEventListener(\'click\', function(e) {\n            e.preventDefault();\n            const textToCopy = this.getAttribute(\'data-clipboard-text\');\n            if (textToCopy) {\n              copyToClipboard(this, textToCopy);\n            }\n          });\n        });\n        \n        const refreshButton = document.getElementById(\'refresh-ip-info\');\n        if (refreshButton) {\n          refreshButton.addEventListener(\'click\', function() {\n            const button = this;\n            const icon = button.querySelector(\'.refresh-icon\');\n            button.disabled = true;\n            if (icon) icon.style.animation = \'spin 1s linear infinite\';\n    \n            const resetToSkeleton = (prefix) => {\n              const elementsToReset = [\'ip\', \'location\', \'isp\'];\n              if (prefix === \'proxy\') elementsToReset.push(\'host\');\n              if (prefix === \'client\') elementsToReset.push(\'proxy\');\n              elementsToReset.forEach(key => {\n                const element = document.getElementById(prefix + \'-\' + key);\n                if (element) element.innerHTML = \'<span class="skeleton" style="width: 120px;"></span>\';\n              });\n            };\n    \n            resetToSkeleton(\'proxy\');\n            resetToSkeleton(\'client\');\n            loadNetworkInfo().finally(() => setTimeout(() => {\n              button.disabled = false; if (icon) icon.style.animation = \'\';\n            }, 1000));\n          });\n        }\n      });\n\n      const style = document.createElement(\'style\');\n      style.textContent = \'@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }\';\n      document.head.appendChild(style);\n  ';
}
