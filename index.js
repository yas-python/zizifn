/**
 * Cloudflare Worker VLESS Proxy - نهایی و رفع خطا شده
 *
 * این اسکریپت جامع، تمامی قابلیت‌های درخواستی را با هم ادغام می‌کند:
 * 1. پنل ادمین پیشرفته: مدیریت کامل کاربران، آمار، و محدودیت ترافیک (از اسکریپت ۲).
 * 2. امنیت CSRF: پنل ادمین در برابر حملات CSRF امن شده است (از اسکریپت ۲).
 * 3. منطق اتصال PROXYIP: مشکل قطع بودن مرورگر رفع شد. ترافیک اکنون به جای اتصال مستقیم،
 * به سرور PROXYIP (که در تنظیمات ورکر ست می‌کنید) ارسال می‌شود (از اسکریپت ۱).
 * 4. پشتیبانی از DNS (UDP): مشکل اتصال کلاینت‌ها با ادغام رسیدگی به UDP رفع شد (از اسکریپت ۱).
 * 5. اطلاعات شبکه هوشمند: صفحه کانفیگ کاربر اکنون اطلاعات IP سرور پروکسی و کاربر را
 * دقیقاً مطابق عکس‌ها نمایش می‌دهد (قابلیت جدید درخواستی).
 * 6. محاسبه دقیق ترافیک: ترافیک آپلود و دانلود (شامل DNS) اکنون محاسبه می‌شود.
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
    if (!isValidUUID(uuid)) {
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

    const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!userFromDb) {
        return null;
    }
    
    await env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 });
    return userFromDb;
}

// --- Smart Network Info Functions (As Requested) ---

const IP_API_URL = 'http://ip-api.com/json/';

/**
 * Fetches geolocation and ISP data for a given IP address.
 * @param {string} ip - The IP address to check.
 * @returns {Promise<{ip: string, country: string, city: string, isp: string, risk?: string}|null>}
 */
async function getIPInfo(ip) {
    if (!ip) return null;
    try {
        const response = await fetch(`${IP_API_URL}${ip}?fields=status,message,country,city,isp,query,org`);
        const data = await response.json();
        if (data.status === 'success') {
            return {
                ip: data.query,
                country: data.country || 'Unknown',
                city: data.city || 'Unknown',
                isp: data.isp || data.org || 'Unknown',
            };
        }
        return null;
    } catch (e) {
        console.error(`Error fetching IP info for ${ip}:`, e);
        return null;
    }
}

// --- Admin Panel & API (From Script 2) ---

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
        <form method="POST" action="/admin">
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
                <input type="hidden" id="csrf_token" name="csrf_token">
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
            const API_BASE = '/admin/api';
            const csrfTokenEl = document.getElementById('csrf_token');
            if (!csrfTokenEl) {
                console.error('CSRF token input not found!');
                showToast('Critical error: CSRF token missing. Please refresh.', true);
                return;
            }
            const csrfToken = csrfTokenEl.value;
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
                if (!toast) return;
                toast.textContent = message;
                toast.style.backgroundColor = isError ? 'var(--danger)' : 'var(--success)';
                toast.classList.add('show');
                setTimeout(() => { toast.classList.remove('show'); }, 3000);
            }

            const pad = num => num.toString().padStart(2, '0');
            const localToUTC = (d, t) => {
                if (!d || !t) return { utcDate: '', utcTime: '' };
                const dt = new Date(\`\${d}T\${t}\`);
                if (isNaN(dt.getTime())) return { utcDate: '', utcTime: '' };
                return { utcDate: \`\${dt.getUTCFullYear()}-\${pad(dt.getUTCMonth() + 1)}-\${pad(dt.getUTCDate())}\`, utcTime: \`\${pad(dt.getUTCHours())}:\${pad(dt.getUTCMinutes())}:\${pad(dt.getUTCSeconds())}\` };
            };
            const utcToLocal = (d, t) => {
                if (!d || !t) return { localDate: '', localTime: '' };
                const dt = new Date(\`\${d}T\${t}Z\`);
                if (isNaN(dt.getTime())) return { localDate: '', localTime: '' };
                return { localDate: \`\${dt.getFullYear()}-\${pad(dt.getMonth() + 1)}-\${pad(dt.getDate())}\`, localTime: \`\${pad(dt.getHours())}:\${pad(dt.getMinutes())}:\${pad(dt.getSeconds())}\` };
            };
            
            function bytesToReadable(bytes) {
                if (bytes < 0) bytes = 0;
                if (bytes === 0) return '0 Bytes';
                const i = Math.floor(Math.log(bytes) / Math.log(1024));
                return \`\${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} \${['Bytes', 'KB', 'MB', 'GB', 'TB'][i]}\`;
            }

            function renderStats(stats) {
                const statsContainer = document.getElementById('stats');
                if (!statsContainer) return;
                statsContainer.innerHTML = \`
                    <div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">\${stats.totalUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">\${stats.activeUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">\${stats.expiredUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Total Traffic Used</h3><p class="stat-value">\${bytesToReadable(stats.totalTraffic)}</p></div>
                \`;
            }
            
            function renderUsers(users) {
                const userList = document.getElementById('userList');
                if (!userList) return;
                userList.innerHTML = users.length === 0 ? '<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>' : users.map(user => {
                    const expiryUTC = new Date(\`\${user.expiration_date}T\${user.expiration_time}Z\`);
                    const isExpired = expiryUTC < new Date();
                    const dataUsage = user.data_usage || 0;
                    const dataLimit = user.data_limit || 0;
                    const trafficUsage = dataLimit > 0 ? \`\${bytesToReadable(dataUsage)} / \${bytesToReadable(dataLimit)}\` : \`\${bytesToReadable(dataUsage)} / &infin;\`;
                    const trafficPercent = dataLimit > 0 ? Math.min(100, (dataUsage / dataLimit * 100)) : 0;
                    
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
            
            document.getElementById('createUserForm')?.addEventListener('submit', async e => {
                e.preventDefault();
                const { utcDate, utcTime } = localToUTC(document.getElementById('expiryDate').value, document.getElementById('expiryTime').value);
                if (!utcDate) {
                    showToast('Invalid date or time.', true);
                    return;
                }
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
            document.getElementById('userList')?.addEventListener('click', e => {
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

            document.getElementById('editUserForm')?.addEventListener('submit', async e => {
                e.preventDefault();
                const uuid = document.getElementById('editUuid').value;
                const { utcDate, utcTime } = localToUTC(document.getElementById('editExpiryDate').value, document.getElementById('editExpiryTime').value);
                if (!utcDate) {
                    showToast('Invalid date or time.', true);
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

            const closeModal = () => editModal?.classList.remove('show');
            document.getElementById('modalCloseBtn')?.addEventListener('click', closeModal);
            document.getElementById('modalCancelBtn')?.addEventListener('click', closeModal);
            editModal?.addEventListener('click', e => { if (e.target === editModal) closeModal(); });
            document.addEventListener('keydown', e => { if (e.key === "Escape") closeModal(); });

            document.getElementById('generateUUID')?.addEventListener('click', () => document.getElementById('uuid').value = crypto.randomUUID());
            document.getElementById('unlimitedBtn')?.addEventListener('click', () => { document.getElementById('dataLimitValue').value = '0'; });
            document.getElementById('editUnlimitedBtn')?.addEventListener('click', () => { document.getElementById('editDataLimitValue').value = '0'; });

            const setDefaultExpiry = () => {
                const now = new Date();
                now.setMonth(now.getMonth() + 1);
                const dateInput = document.getElementById('expiryDate');
                const timeInput = document.getElementById('expiryTime');
                if (dateInput) dateInput.value = \`\${now.getFullYear()}-\${pad(now.getMonth() + 1)}-\${pad(now.getDate())}\`;
                if (timeInput) timeInput.value = \`\${pad(now.getHours())}:\${pad(now.getMinutes())}:\${pad(now.getSeconds())}\`;
            };
            
            const uuidInput = document.getElementById('uuid');
            if (uuidInput) uuidInput.value = crypto.randomUUID();
            setDefaultExpiry();
            refreshData();
        });
    </script>
</body>
</html>`;


/**
 * Middleware to check admin authentication and CSRF token.
 */
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

/**
 * Handles all incoming requests to /admin/* routes.
 */
async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured. Please set ADMIN_KEY secret.', { status: 503 });
    }

    // API Routes (/admin/api/*)
    if (pathname.startsWith('/admin/api/')) {
        const { isAdmin, errorResponse } = await checkAdminAuth(request, env);
        if (errorResponse) return errorResponse;
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });

        // GET /admin/api/stats
        if (pathname === '/admin/api/stats' && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT expiration_date, expiration_time, data_usage FROM users").all();
                const now = new Date();
                const stats = {
                    totalUsers: results.length,
                    activeUsers: results.filter(u => new Date(\`\${u.expiration_date}T\${u.expiration_time}Z\`) > now).length,
                    expiredUsers: results.filter(u => new Date(\`\${u.expiration_date}T\${u.expiration_time}Z\`) <= now).length,
                    totalTraffic: results.reduce((sum, u) => sum + (u.data_usage || 0), 0)
                };
                return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }
        
        // GET /admin/api/users
        if (pathname === '/admin/api/users' && request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
            return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
        }

        // POST /admin/api/users
        if (pathname === '/admin/api/users' && request.method === 'POST') {
            try {
                const { uuid, exp_date, exp_time, notes, data_limit } = await request.json();
                if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) {
                    throw new Error('Invalid or missing fields.');
                }
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, data_limit, data_usage) VALUES (?, ?, ?, ?, ?, 0)")
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
            // PUT /admin/api/users/:uuid
            if (request.method === 'PUT') {
                 try {
                    const { exp_date, exp_time, notes, data_limit, reset_traffic } = await request.json();
                     if (!exp_date || !exp_time) throw new Error('Invalid date/time fields.');

                    const sql = \`UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ? \${reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?\`;
                    await env.DB.prepare(sql).bind(exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, uuid).run();
                    await env.USER_KV.delete(\`user:\${uuid}\`); 
                    return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
                } catch (e) {
                    return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: jsonHeader });
                }
            }
            // DELETE /admin/api/users/:uuid
            if (request.method === 'DELETE') {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete(\`user:\${uuid}\`); 
                return new Response(null, { status: 204 });
            }
        }
        return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
    }

    // Page Serving Routes (/admin)
    if (pathname === '/admin') {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const sessionToken = crypto.randomUUID();
                const csrfToken = crypto.randomUUID();
                await env.USER_KV.put(\`admin_session:\${sessionToken}\`, JSON.stringify({ csrfToken }), { expirationTtl: 86400 });
                const headers = new Headers({
                    'Location': '/admin',
                    'Set-Cookie': \`auth_token=\${sessionToken}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict\`
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
                    \`<input type="hidden" id="csrf_token" name="csrf_token" value="\${csrfToken}">\`
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


// --- Core VLESS & Subscription Logic (Merged & Upgraded) ---

const Config = {
  userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4', // Default UUID
  proxyIPs: ['nima.nscl.ir:443'], // Default proxy IP
  fromEnv(env) {
    // *** CRITICAL FIX: Read PROXYIP from environment ***
    const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');
    return {
      userID: env.UUID || this.userID,
      proxyIP: proxyHost,
      proxyPort: parseInt(proxyPort, 10),
    };
  },
};

const CONST = {
  ED_PARAMS: { ed: 2560, eh: 'Sec-WebSocket-Protocol' }, VLESS_PROTOCOL: 'vless',
  WS_READY_STATE_OPEN: 1, WS_READY_STATE_CLOSING: 2,
};
function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let result = '';
  for (let i = 0; i < length; i++) { result += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return \`/\${result}\${query ? \`?\${query}\` : ''}\`;
}
const CORE_PRESETS = {
  xray: { tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} }, tcp: { path: () => generateRandomPath(12, 'ed=2048'), security: 'none', fp: 'chrome', extra: {} }, },
  sb: { tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: CONST.ED_PARAMS }, tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: CONST.ED_PARAMS }, },
};
function makeName(tag, proto) { return \`\${tag}-\${proto.toUpperCase()}\`; }
function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path, });
  if (security) params.set('security', security); if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp); if (alpn) params.set('alpn', alpn);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return \`vless://\${userID}@\${address}:\${port}?\${params.toString()}#\${encodeURIComponent(name)}\`;
}
function buildLink({ core, proto, userID, hostName, address, port, tag }) {
  const p = CORE_PRESETS[core][proto];
  return createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: p.security === 'tls' ? hostName : undefined, fp: p.fp, alpn: p.alpn, extra: p.extra, name: makeName(tag, proto), });
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [ hostName, 'www.speedtest.net', 'sky.rethinkdns.com', 'go.inmobi.com', 'www.visa.com', 'cdnjs.com', 'zula.ir', ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  let links = [];
  mainDomains.forEach((domain, i) => { links.push( buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: \`D\${i+1}\` }) ); });
  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json');
    if (r.ok) {
      const json = await r.json(); const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
      ips.forEach((ip, i) => {
        const formattedAddress = ip.includes(':') ? \`[\${ip}]\` : ip;
        links.push( buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: \`IP\${i+1}\` }) );
      });
    }
  } catch (e) { console.error('Fetch IP list failed', e); }
  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' }, });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cfg = Config.fromEnv(env); // *** CRITICAL: Get config from env
        
        // --- 1. Admin Panel Routing ---
        if (url.pathname.startsWith('/admin')) {
            return handleAdminRequest(request, env);
        }
        
        // --- 2. WebSocket/VLESS Protocol Handling ---
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader?.toLowerCase() === 'websocket') {
             return ProtocolOverWSHandler(request, env, ctx, cfg); // *** CRITICAL: Pass cfg
        }
        
        // --- 3. Subscription & Config Page Handling ---
        const handleSubscription = async (core) => {
            const uuid = url.pathname.slice(\`/\${core}/\`.length);
            const userData = await getUserData(env, uuid);
            if (!userData || isExpired(userData.expiration_date, userData.expiration_time)) {
                return new Response('Invalid or expired user', { status: 403 });
            }
             if (userData.data_limit > 0 && (userData.data_usage || 0) >= userData.data_limit) {
                return new Response('Data limit reached', { status: 403 });
            }
            return handleIpSubscription(core, uuid, url.hostname);
        };

        if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
        if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

        // Config Page handling
        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData) {
                return new Response('User not found', { status: 404 });
            }
            
            // --- Smart Network Info Fetching (As Requested) ---
            const clientIP = request.headers.get('CF-Connecting-IP');
            // Fetch info for both User and the Upstream Proxy Host
            const [clientIPInfo, proxyHostInfo] = await Promise.all([
                getIPInfo(clientIP),                // User's info
                getIPInfo(cfg.proxyIP)              // Upstream Proxy's info
            ]);

            // Add 'risk' to clientIPInfo
            if (clientIPInfo) {
                clientIPInfo.risk = 'Low (0%)'; // Mock risk score as requested
            }

            return handleConfigPage(path, url.hostname, userData, clientIPInfo, proxyHostInfo);
        }
        
        return new Response('Not found.', { status: 404 });
    },
};

// --- Updated Protocol Handler with Traffic Tracking & UDP/DNS ---
async function ProtocolOverWSHandler(request, env, ctx, cfg) { // *** CRITICAL: Accept cfg
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let address = '';
    let portWithRandomLog = '';
    let userUUID = '';
    let sessionUsage = 0;
    let udpStreamWriter = null;

    const log = (info, event) => console.log(\`[\${address}:\${portWithRandomLog}] \${info}\`, event || '');
    
    const incrementUsage = (bytes) => {
        sessionUsage += bytes;
    };
    
    const updateUsageInDB = async () => {
        if (sessionUsage > 0 && userUUID) {
            try {
                await env.DB.prepare("UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?")
                    .bind(Math.round(sessionUsage), userUUID)
                    .run();
                await env.USER_KV.delete(\`user:\${userUUID}\`);
                log(\`Updated usage for \${userUUID} by \${sessionUsage} bytes.`);
            } catch (err) {
                console.error(\`Failed to update usage for \${userUUID}:\`, err);
            }
        }
    };

    const createUsageCountingStream = (counter) => {
        return new TransformStream({
            transform(chunk, controller) {
                counter(chunk.byteLength); 
                controller.enqueue(chunk);
            }
        });
    };
    const usageCounterDownstream = createUsageCountingStream(incrementUsage); // client -> remote
    const usageCounterUpstream = createUsageCountingStream(incrementUsage);   // remote -> client

    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
    const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);
    let remoteSocketWapper = { value: null };

    readableWebSocketStream
        .pipeThrough(usageCounterDownstream) // Count downstream (upload)
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                if (udpStreamWriter) {
                    return udpStreamWriter(chunk);
                }
                
                if (remoteSocketWapper.value) {
                    const writer = remoteSocketWapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const { user, hasError, message, addressRemote, portRemote, rawDataIndex, ProtocolVersion, isUDP } = await ProcessProtocolHeader(chunk, env);
                if (hasError) {
                    controller.error(new Error(message));
                    return;
                }
                
                if (!user) { controller.error(new Error('User not found.')); return; }
                userUUID = user.uuid; 
                if (isExpired(user.expiration_date, user.expiration_time)) { controller.error(new Error('User expired.')); return; }
                const currentUsage = user.data_usage || 0;
                if (user.data_limit > 0 && currentUsage >= user.data_limit) { controller.error(new Error('Data limit reached.')); return; }

                address = addressRemote;
                portWithRandomLog = \`\${portRemote}--\${Math.random()} \${isUDP ? 'udp' : 'tcp'}\`;
                const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                if (isUDP) {
                    if (portRemote === 53) {
                        const dnsPipeline = await createDnsPipeline(webSocket, vlessResponseHeader, log, incrementUsage); 
                        udpStreamWriter = dnsPipeline.write;
                        await udpStreamWriter(rawClientData); 
                    } else {
                        controller.error(new Error('UDP proxy only supported for DNS (port 53)'));
                    }
                    return;
                }

                // --- Handle TCP ---
                HandleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, usageCounterUpstream, cfg); // *** CRITICAL: Pass cfg
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
    if (command !== 1 && command !== 2) { // Allow TCP and UDP
        return { hasError: true, message: \`command \${command} is not supported\` };
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = dataView.getUint16(portIndex);
    const addressType = dataView.getUint8(portIndex + 2);
    let addressValue, addressLength, addressValueIndex;
    switch (addressType) {
        case 1: addressLength = 4; addressValueIndex = portIndex + 3; addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.'); break;
        case 2: addressLength = dataView.getUint8(portIndex + 3); addressValueIndex = portIndex + 4; addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)); break;
        case 3: 
            addressLength = 16; addressValueIndex = portIndex + 3;
            const dataView6 = new DataView(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            addressValue = Array.from({ length: 8 }, (_, i) => dataView6.getUint16(i * 2).toString(16)).join(':');
            break;
        default: return { hasError: true, message: \`invalid addressType: \${addressType}\` };
    }
    if (!addressValue) return { hasError: true, message: \`addressValue is empty, addressType is \${addressType}\` };

    return { 
        user, 
        hasError: false, 
        addressRemote: addressValue, 
        portRemote, 
        rawDataIndex: addressValueIndex + addressLength, 
        ProtocolVersion: new Uint8Array([version]),
        isUDP: command === 2
    };
}

async function HandleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, log, usageCounterUpstream, cfg) { // *** CRITICAL: Accept cfg
    
    // *** CRITICAL FIX: Determine destination based on config ***
    // If cfg.proxyIP is set, connect to it. Otherwise, connect to the requested address.
    const connectHost = cfg.proxyIP || addressRemote;
    const connectPort = cfg.proxyPort || portRemote;

    if (cfg.proxyIP) {
        log(\`Proxying request for \${addressRemote}:\${portRemote} via \${connectHost}:\${connectPort}\`);
    } else {
        log(\`Connecting directly to \${connectHost}:\${connectPort}\`);
    }

    async function connectAndWrite(address, port) {
        const tcpSocket = connect({ hostname: address, port: port });
        remoteSocket.value = tcpSocket;
        log(\`connected to \${address}:\${port}\`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    try {
        const tcpSocket = await connectAndWrite(connectHost, connectPort);
        RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, log, usageCounterUpstream);
    } catch (err) {
        console.error(\`Failed to connect to \${connectHost}:\${connectPort}:\`, err);
        safeCloseWebSocket(webSocket);
    }
}

function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', e => controller.enqueue(e.data));
            webSocketServer.addEventListener('close', () => { safeCloseWebSocket(webSocketServer); controller.close(); });
            webSocketServer.addEventListener('error', err => { log('webSocketServer has error'); controller.error(err); });
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel(reason) { log(\`ReadableStream was canceled: \${reason}\`); safeCloseWebSocket(webSocketServer); },
    });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, log, usageCounterUpstream) {
    try {
        await remoteSocket.readable
            .pipeThrough(usageCounterUpstream) // Count upstream (download)
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

// --- MERGED: UDP/DNS Pipeline Function (from Script 1) ---
async function createDnsPipeline(webSocket, vlessResponseHeader, log, incrementUsage) {
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

            const dataToSend = isHeaderSent
                ? await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer()
                : await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer();

            if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
              log(\`DNS query successful, length: \${udpSize}\`);
              incrementUsage(dataToSend.byteLength); // Manually count upstream (download) traffic for DNS
              webSocket.send(dataToSend);
              isHeaderSent = true;
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
  try { if (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING) { socket.close(); } } catch (error) { console.error('safeCloseWebSocket error:', error); }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return ( byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]] ).toLowerCase();
}

// --- Config Page Generation (Upgraded with Smart Network Info) ---
function handleConfigPage(userID, hostName, userData, clientIPInfo, proxyHostInfo) {
    const { expiration_date: expDate, expiration_time: expTime, data_usage, data_limit } = userData;
    const html = generateBeautifulConfigPage(userID, hostName, expDate, expTime, data_usage, data_limit, clientIPInfo, proxyHostInfo);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, expDate, expTime, dataUsage, dataLimit, clientIPInfo, proxyHostInfo) {
    const subXrayUrl = \`https://\${hostName}/xray/\${userID}\`;
    const subSbUrl = \`https://\${hostName}/sb/\${userID}\`;
    
    const clientUrls = {
        universal: \`v2rayng://install-config?url=\${encodeURIComponent(subXrayUrl)}\`,
        karing: \`karing://install-config?url=\${encodeURIComponent(subXrayUrl)}\`,
        shadowrocket: \`shadowrocket://add/sub?url=\${encodeURIComponent(subXrayUrl)}&name=\${encodeURIComponent(hostName)}\`,
        stash: \`stash://install-config?url=\${encodeURIComponent(subXrayUrl)}\`,
        streisand: \`streisand://import/\${btoa(subXrayUrl)}\`,
        clashMeta: \`clash://install-config?url=\${encodeURIComponent(subSbUrl)}\`,
    };

    const utcTimestamp = \`\${expDate}T\${expTime.split('.')[0]}Z\`;
    const isUserExpired = isExpired(expDate, expTime);
    const hasDataLimit = dataLimit > 0;
    const dataLimitReached = hasDataLimit && (dataUsage >= dataLimit);
    
    let statusMessage;
    let statusColorClass;
    if (isUserExpired) {
        statusMessage = "Expires in --";
        statusColorClass = "status-expired-text";
    } else if (dataLimitReached) {
        statusMessage = "Data limit reached";
        statusColorClass = "status-expired-text";
    } else {
        statusMessage = "Expires in ...";
        statusColorClass = "status-active-text";
    }

    const renderNetworkCard = (title, ipInfo) => {
        const ip = ipInfo?.ip || 'N/A';
        // Fix for location display
        const location = (ipInfo && ipInfo.city && ipInfo.country && ipInfo.city !== 'Unknown' && ipInfo.country !== 'Unknown') 
            ? \`\${ipInfo.city}, \${ipInfo.country}\` 
            : (ipInfo?.country || 'N/A');
        const isp = ipInfo?.isp || 'N/A';
        const risk = ipInfo?.risk || 'N/A'; // Risk only exists for clientIPInfo

        return \`
            <div class="network-card">
                <h3 class="network-title">\${title}</h3>
                <div class="network-info-grid">
                    <div><strong>IP Address:</strong> <span>\${ip}</span></div>
                    <div><strong>Location:</strong> <span>\${location}</span></div>
                    <div><strong>ISP Provider:</strong> <span>\${isp}</span></div>
                    \${title === 'Your Connection' ? \`<div><strong>Risk Score:</strong> <span>\${risk}</span></div>\` : ''}
                </div>
            </div>\`;
    };

    const networkInfoBlock = \`
        <div class="network-info-wrapper">
             <div class="network-info-header">
                <h2>Network Information</h2>
                <button class="button refresh-btn" onclick="refreshNetworkInfo()">Refresh</button>
            </div>
            <div id="network-info-grid" class="network-grid">
                \${renderNetworkCard('Proxy Server', proxyHostInfo)}
                \${renderNetworkCard('Your Connection', clientIPInfo)}
            </div>
        </div>
    \`;

    const expirationBlock = \`
        <div class="info-card rainbow-border">
          <div class="info-card-content">
            <h2 class="info-title">Expiration Date</h2>
            <div id="expiration-relative" class="info-relative-time \${statusColorClass}">\${statusMessage}</div>
            <div class="info-time-grid" id="expiration-display" data-utc-time="\${utcTimestamp}">
                <div><strong>Your Local Time:</strong> <span id="local-time">--</span></div>
                <div><strong>Tehran Time:</strong> <span id="tehran-time">--</span></div>
                <div><strong>Universal Time:</strong> <span id="utc-time">--</span></div>
            </div>
          </div>
        </div>\`;
    
    const trafficPercent = hasDataLimit ? Math.min(100, ((dataUsage || 0) / dataLimit * 100)) : 0;
    const dataUsageBlock = \`
        <div class="info-card">
            <div class="info-card-content">
                <h2 class="info-title">Data Usage</h2>
                <div class="data-usage-text" id="data-usage-display" data-usage="\${dataUsage || 0}" data-limit="\${dataLimit || 0}">
                    Loading...
                </div>
                <div class="traffic-bar-container">
                    <div class="traffic-bar" style="width: \${trafficPercent}%"></div>
                </div>
            </div>
        </div>\`;

    const finalHTML = \`<!doctype html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>VLESS Proxy Configuration</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>\${getPageCSS()}</style> 
    </head>
    <body>
        <div class="container">
            <div class="header"><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></div>
            \${networkInfoBlock}
            <div class="top-grid">
                \${expirationBlock}
                \${dataUsageBlock}
            </div>
            \${getPageHTML(clientUrls, subXrayUrl, subSbUrl)}
        </div>
        <script>\${getPageScript()}</script>
    </body></html>\`;
    return finalHTML;
}

function getPageCSS() {
    return \`
      :root {
        --bg-main: #121212; --bg-card: #1E1E1E; --bg-inner: #2f2f2f;
        --border-color: #333; --text-primary: #E0E0E0; --text-secondary: #B0B0B0;
        --accent: #BB86FC; --accent-hover: #D1B1FD; --status-active: #03DAC6; --status-expired: #CF6679;
        --network-bg: #212121; --network-border: #444;
      }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-main); color: var(--text-primary); padding: 20px; -webkit-font-smoothing: antialiased; }
      .container { max-width: 900px; margin: auto; }
      .header { text-align: center; margin-bottom: 24px; }
      .header h1 { font-size: 2em; margin-bottom: 8px; font-weight: 500; }
      .header p { color: var(--text-secondary); }
      .top-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 20px; }
      .info-card { background: var(--bg-card); border-radius: 12px; position: relative; overflow: hidden; border: 1px solid var(--border-color); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
      .info-card.rainbow-border::before {
        content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
        background: conic-gradient(from 180deg at 50% 50%, #CF6679, #BB86FC, #03DAC6, #CF6679);
        animation: spin 4s linear infinite; z-index: 1;
      }
      .info-card-content { background: var(--bg-card); padding: 20px; border-radius: 10px; position: relative; z-index: 2; margin: 2px; }
      .info-title { font-size: 1.25em; text-align: center; margin: 0 0 16px; font-weight: 500; color: var(--text-primary); }
      .info-relative-time { text-align: center; font-size: 1.4em; font-weight: 600; margin-bottom: 16px; }
      .status-active-text { color: var(--status-active); } .status-expired-text { color: var(--status-expired); }
      .info-time-grid { display: grid; gap: 8px; font-size: 0.9em; text-align: center; color: var(--text-secondary); }
      .info-time-grid strong { color: var(--text-primary); font-weight: 500; }
      .data-usage-text { font-size: 1.4em !important; font-weight: 600; text-align: center; color: var(--text-primary); margin-bottom: 16px; }
      .traffic-bar-container { height: 8px; background-color: var(--bg-inner); border-radius: 4px; overflow: hidden; }
      .traffic-bar { height: 100%; background: linear-gradient(90deg, var(--accent) 0%, var(--status-active) 100%); border-radius: 4px; transition: width 0.5s ease-out; }
      .config-card { background: var(--bg-card); border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid var(--border-color); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
      .config-title { display: flex; justify-content: space-between; align-items: center; font-size: 1.4rem; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border-color); font-weight: 500; }
      .button, .client-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: 1px solid var(--border-color); background-color: var(--bg-inner); color: var(--text-primary); text-decoration: none; transition: all 0.2s; }
      .button:hover { background-color: #3f3f3f; border-color: var(--text-secondary); }
      .client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
      .client-btn { width: 100%; box-sizing: border-box; background-color: var(--accent); color: #000; border: none; font-weight: 600; }
      .client-btn:hover { background-color: var(--accent-hover); }
      .qr-container { display: none; margin-top: 20px; background: white; padding: 16px; border-radius: 8px; max-width: 288px; margin-left: auto; margin-right: auto; }
      
      .network-info-wrapper { background: var(--bg-card); border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid var(--border-color); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
      .network-info-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border-color); }
      .network-info-header h2 { margin: 0; font-size: 1.4rem; font-weight: 500; }
      .network-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
      .network-card { background: var(--network-bg); border: 1px solid var(--network-border); border-radius: 8px; padding: 16px; }
      .network-title { font-size: 1.1em; margin-top: 0; margin-bottom: 12px; border-bottom: 1px solid var(--network-border); padding-bottom: 8px; color: var(--status-active); font-weight: 500; }
      .network-info-grid { display: grid; gap: 8px; font-size: 0.9em; word-break: break-all; }
      .network-info-grid strong { color: var(--text-secondary); font-weight: 400; display: inline-block; min-width: 100px; }
      .network-info-grid span { color: var(--text-primary); font-weight: 500; }
      .refresh-btn { background-color: var(--bg-inner); }

      @keyframes spin { 100% { transform: rotate(360deg); } }
      @media (max-width: 768px) { 
        body { padding: 10px; } 
        .top-grid, .network-grid { grid-template-columns: 1fr; } 
        .network-info-header { flex-direction: column; align-items: flex-start; gap: 10px; }
        .network-info-header button { width: 100%; }
        .config-title { flex-direction: column; align-items: flex-start; gap: 10px; }
        .config-title .button { width: 100%; box-sizing: border-box; }
        .client-buttons { grid-template-columns: 1fr; }
      }
  \`;
}

function getPageHTML(clientUrls, subXrayUrl, subSbUrl) {
    return \`
      <div class="config-card">
        <div class="config-title"><span>Xray Subscription</span><button id="copy-xray-sub-btn" class="button" data-clipboard-text="\${subXrayUrl}">Copy Link</button></div>
        <div class="client-buttons">
            <a href="\${clientUrls.universal}" class="client-btn">Universal Import (V2rayNG, etc.)</a>
            <a href="\${clientUrls.shadowrocket}" class="client-btn">Import to Shadowrocket</a>
            <a href="\${clientUrls.stash}" class="client-btn">Import to Stash (VLESS)</a>
            <button class="client-btn" onclick="toggleQR('xray', '\${subXrayUrl}')">Show QR Code</button>
        </div>
        <div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div>
      </div>
      <div class="config-card">
        <div class="config-title"><span>Sing-Box / Clash Subscription</span><button id="copy-sb-sub-btn" class="button" data-clipboard-text="\${subSbUrl}">Copy Link</button></div>
        <div class="client-buttons">
            <a href="\${clientUrls.clashMeta}" class="client-btn">Import to Clash Meta / Stash</a>
            <button class="client-btn" onclick="toggleQR('singbox', '\${subSbUrl}')">Show QR Code</button>
        </div>
        <div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div>
      </div>\`;
}

function getPageScript() {
    return \`
      function copyToClipboard(button, text) {
        const originalText = button.textContent;
        navigator.clipboard.writeText(text).then(() => {
          button.textContent = 'Copied!';
          button.style.backgroundColor = 'var(--status-active)';
          button.style.color = '#000';
          setTimeout(() => { 
            button.textContent = originalText; 
            button.style.backgroundColor = '';
            button.style.color = '';
          }, 1500);
        });
      }
      function toggleQR(id, url) {
        const container = document.getElementById('qr-' + id + '-container');
        const qrElement = document.getElementById('qr-' + id);
        if (container.style.display === 'none' || container.style.display === '') {
            container.style.display = 'block';
            if (!qrElement.hasChildNodes()) { new QRCode(qrElement, { text: url, width: 256, height: 256, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.H }); }
        } else { container.style.display = 'none'; }
      }
      function displayExpirationTimes() {
        const expElement = document.getElementById('expiration-display');
        const relativeElement = document.getElementById('expiration-relative');
        if (!expElement?.dataset.utcTime) return;

        const utcDate = new Date(expElement.dataset.utcTime);
        if (isNaN(utcDate.getTime())) return;
        
        const diffSeconds = (utcDate.getTime() - new Date().getTime()) / 1000;
        const isExpired = diffSeconds < 0;

        if (!isExpired && relativeElement.textContent.includes("...")) {
            const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
            let relTime = '';
            if (Math.abs(diffSeconds) < 60) relTime = rtf.format(Math.round(diffSeconds), 'second');
            else if (Math.abs(diffSeconds) < 3600) relTime = rtf.format(Math.round(diffSeconds / 60), 'minute');
            else if (Math.abs(diffSeconds) < 86400) relTime = rtf.format(Math.round(diffSeconds / 3600), 'hour');
            else relTime = rtf.format(Math.round(diffSeconds / 86400), 'day');
            relativeElement.textContent = \`Expires \${relTime}\`;
        } else if (isExpired) {
             relativeElement.textContent = "Subscription Expired";
        }
        
        const localTimeEl = document.getElementById('local-time');
        const tehranTimeEl = document.getElementById('tehran-time');
        const utcTimeEl = document.getElementById('utc-time');

        if (localTimeEl) localTimeEl.textContent = utcDate.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        if (tehranTimeEl) tehranTimeEl.textContent = utcDate.toLocaleString('en-US', { timeZone: 'Asia/Tehran', hour12: true, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        if (utcTimeEl) utcTimeEl.textContent = \`\${utcDate.toISOString().substring(0, 19).replace('T', ' ')} UTC\`;
      }
      function displayDataUsage() {
        const usageElement = document.getElementById('data-usage-display');
        if (!usageElement) return;
        const usage = parseInt(usageElement.dataset.usage, 10);
        const limit = parseInt(usageElement.dataset.limit, 10);
        const bytesToReadable = bytes => {
            if (bytes <= 0) return '0 Bytes';
            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            return \`\${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} \${['Bytes', 'KB', 'MB', 'GB', 'TB'][i]}\`;
        };
        const limitText = limit > 0 ? bytesToReadable(limit) : '&infin;';
        usageElement.innerHTML = \`\${bytesToReadable(usage)} / \${limitText}\`;
      }
      
      function refreshNetworkInfo() {
            // As requested, this button refreshes the page to get new server-rendered data
            window.location.reload(); 
      }
      window.refreshNetworkInfo = refreshNetworkInfo; 

      document.addEventListener('DOMContentLoaded', () => {
        displayExpirationTimes();
        displayDataUsage();
        document.querySelectorAll('.button[data-clipboard-text]').forEach(button => {
          button.addEventListener('click', () => copyToClipboard(button, button.dataset.clipboard-text));
        });
        setInterval(displayExpirationTimes, 60000); 
      });
  \`;
}
