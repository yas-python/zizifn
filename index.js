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
  const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
  return expDatetimeUTC > new Date() && !isNaN(expDatetimeUTC);
}

/**
* Retrieves user data from KV cache or falls back to D1 database.
* @param {object} env - The worker environment object.
* @param {string} uuid - The user's UUID.
* @returns {Promise<object|null>} - The user data or null if not found.
*/
async function getUserData(env, uuid) {
  let userData = await env.USER_KV.get(`user:${uuid}`);
  if (userData) {
    try {
      return JSON.parse(userData);
    } catch (e) {
      console.error(`Failed to parse user data from KV for UUID: ${uuid}`, e);
    }
  }

  const query = await env.DB.prepare("SELECT expiration_date, expiration_time FROM users WHERE uuid = ?")
    .bind(uuid)
    .first();

  if (!query) {
    return null;
  }

  userData = { exp_date: query.expiration_date, exp_time: query.expiration_time };
  await env.USER_KV.put(`user:${uuid}`, JSON.stringify(userData), { expirationTtl: 3600 });
  return userData;
}

// --- Admin Security & Panel ---

// HTML for the Admin Login Page
const adminLoginHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login</title>
    <style>
        body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #121212; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .login-container { background-color: #1e1e1e; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); text-align: center; width: 320px; border: 1px solid #333; }
        h1 { color: #ffffff; margin-bottom: 24px; font-weight: 500; }
        form { display: flex; flex-direction: column; }
        input[type="password"] { background-color: #2c2c2c; border: 1px solid #444; color: #ffffff; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 16px; }
        input[type="password"]:focus { outline: none; border-color: #007aff; box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.3); }
        button { background-color: #007aff; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; }
        button:hover { background-color: #005ecb; }
        .error { color: #ff3b30; margin-top: 15px; font-size: 14px; }
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

// --- FINAL, COMPLETE, AND TIMEZONE-SMART ADMIN PANEL HTML ---
const adminPanelHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard</title>
    <style>
        :root {
            --bg-main: #111827; --bg-card: #1F2937; --border: #374151; --text-primary: #F9FAFB;
            --text-secondary: #9CA3AF; --accent: #3B82F6; --accent-hover: #2563EB; --danger: #EF4444;
            --danger-hover: #DC2626; --success: #22C55E; --expired: #F59E0B; --btn-secondary-bg: #4B5563;
        }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: var(--bg-main); color: var(--text-primary); font-size: 14px; }
        .container { max-width: 1200px; margin: 40px auto; padding: 0 20px; }
        h1, h2 { font-weight: 600; }
        h1 { font-size: 24px; margin-bottom: 20px; }
        h2 { font-size: 18px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 20px; }
        .card { background-color: var(--bg-card); border-radius: 8px; padding: 24px; border: 1px solid var(--border); box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; align-items: flex-end; }
        .form-group { display: flex; flex-direction: column; }
        .form-group label { margin-bottom: 8px; font-weight: 500; color: var(--text-secondary); }
        .form-group .input-group { display: flex; }
        input[type="text"], input[type="date"], input[type="time"] {
            width: 100%; box-sizing: border-box; background-color: #374151; border: 1px solid #4B5563; color: var(--text-primary);
            padding: 10px; border-radius: 6px; font-size: 14px; transition: border-color 0.2s;
        }
        input:focus { outline: none; border-color: var(--accent); }
        .label-note { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
        .btn {
            padding: 10px 16px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;
            transition: background-color 0.2s, transform 0.1s; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        }
        .btn:active { transform: scale(0.98); }
        .btn-primary { background-color: var(--accent); color: white; }
        .btn-primary:hover { background-color: var(--accent-hover); }
        .btn-secondary { background-color: var(--btn-secondary-bg); color: white; }
        .btn-secondary:hover { background-color: #6B7280; }
        .btn-danger { background-color: var(--danger); color: white; }
        .btn-danger:hover { background-color: var(--danger-hover); }
        .input-group .btn-secondary { border-top-left-radius: 0; border-bottom-left-radius: 0; }
        .input-group input { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        th { color: var(--text-secondary); font-weight: 600; font-size: 12px; text-transform: uppercase; }
        td { color: var(--text-primary); font-family: "SF Mono", "Fira Code", monospace; }
        .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; display: inline-block; }
        .status-active { background-color: var(--success); color: #064E3B; }
        .status-expired { background-color: var(--expired); color: #78350F; }
        .actions-cell .btn { padding: 6px 10px; font-size: 12px; }
        #toast { position: fixed; top: 20px; right: 20px; background-color: var(--bg-card); color: white; padding: 15px 20px; border-radius: 8px; z-index: 1001; display: none; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s, transform 0.3s; transform: translateY(-20px); }
        #toast.show { display: block; opacity: 1; transform: translateY(0); }
        #toast.error { border-left: 5px solid var(--danger); }
        #toast.success { border-left: 5px solid var(--success); }
        .uuid-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .btn-copy { background: transparent; border: none; color: var(--text-secondary); padding: 4px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .btn-copy:hover { background-color: #374151; color: var(--text-primary); }
        .btn svg, .actions-cell .btn svg { width: 14px; height: 14px; }
        .actions-cell { display: flex; gap: 8px; justify-content: center; }
        .time-display { display: flex; flex-direction: column; }
        .time-local { font-weight: 600; }
        .time-utc, .time-relative { font-size: 11px; color: var(--text-secondary); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
        .modal-overlay.show { opacity: 1; visibility: visible; }
        .modal-content { background-color: var(--bg-card); padding: 30px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.4); width: 90%; max-width: 500px; transform: scale(0.9); transition: transform 0.3s; border: 1px solid var(--border); }
        .modal-overlay.show .modal-content { transform: scale(1); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 20px; }
        .modal-header h2 { margin: 0; border: none; font-size: 20px; }
        .modal-close-btn { background: none; border: none; color: var(--text-secondary); font-size: 24px; cursor: pointer; line-height: 1; }
        .modal-footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 25px; }
        .time-quick-set-group { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .btn-outline-secondary {
            background-color: transparent; border: 1px solid var(--btn-secondary-bg); color: var(--text-secondary);
            padding: 6px 10px; font-size: 12px; font-weight: 500;
        }
        .btn-outline-secondary:hover { background-color: var(--btn-secondary-bg); color: white; border-color: var(--btn-secondary-bg); }
        @media (max-width: 768px) {
            tr { border: 1px solid var(--border); border-radius: 8px; display: block; margin-bottom: 1rem; }
            td { border: none; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Admin Dashboard</h1>
        <div class="card">
            <h2>Create User</h2>
            <form id="createUserForm" class="form-grid">
                <div class="form-group" style="grid-column: 1 / -1;"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div>
                <div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div>
                <div class="form-group">
                    <label for="expiryTime">Expiry Time (Your Local Time)</label>
                    <input type="time" id="expiryTime" step="1" required>
                    <div class="label-note">Automatically converted to UTC on save.</div>
                    <div class="time-quick-set-group" data-target-date="expiryDate" data-target-time="expiryTime">
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="7" data-unit="day">+1 Week</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button>
                    </div>
                </div>
                <div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div>
                <div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div>
            </form>
        </div>
        <div class="card" style="margin-top: 30px;">
            <h2>User List</h2>
            <div style="overflow-x: auto;">
                 <table>
                    <thead><tr><th>UUID</th><th>Created</th><th>Expiry (Admin Local)</th><th>Expiry (Tehran)</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
                    <tbody id="userList"></tbody>
                </table>
            </div>
        </div>
    </div>
    <div id="toast"></div>
    <div id="editModal" class="modal-overlay">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Edit User</h2>
                <button id="modalCloseBtn" class="modal-close-btn">&times;</button>
            </div>
            <form id="editUserForm">
                <input type="hidden" id="editUuid" name="uuid">
                <div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div>
                <div class="form-group" style="margin-top: 16px;">
                    <label for="editExpiryTime">Expiry Time (Your Local Time)</label>
                    <input type="time" id="editExpiryTime" name="exp_time" step="1" required>
                     <div class="label-note">Your current timezone is used for conversion.</div>
                    <div class="time-quick-set-group" data-target-date="editExpiryDate" data-target-time="editExpiryTime">
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="7" data-unit="day">+1 Week</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button>
                    </div>
                </div>
                <div class="form-group" style="margin-top: 16px;"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div>
                <div class="modal-footer">
                    <button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button>
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const API_BASE = '/admin/api';
            let allUsers = [];
            const userList = document.getElementById('userList');
            const createUserForm = document.getElementById('createUserForm');
            const generateUUIDBtn = document.getElementById('generateUUID');
            const uuidInput = document.getElementById('uuid');
            const toast = document.getElementById('toast');
            const editModal = document.getElementById('editModal');
            const editUserForm = document.getElementById('editUserForm');

            function showToast(message, isError = false) {
                toast.textContent = message;
                toast.className = isError ? 'error' : 'success';
                toast.classList.add('show');
                setTimeout(() => { toast.classList.remove('show'); }, 3000);
            }

            const api = {
                get: (endpoint) => fetch(\`\${API_BASE}\${endpoint}\`, { credentials: 'include' }).then(handleResponse),
                post: (endpoint, body) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) }).then(handleResponse),
                put: (endpoint, body) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'PUT', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) }).then(handleResponse),
                delete: (endpoint) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'DELETE', credentials: 'include' }).then(handleResponse),
            };

            async function handleResponse(response) {
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: 'An unknown error occurred.' }));
                    throw new Error(errorData.error || \`Request failed with status \${response.status}\`);
                }
                return response.status === 204 ? null : response.json();
            }

            const pad = (num) => num.toString().padStart(2, '0');

            function localToUTC(dateStr, timeStr) {
                if (!dateStr || !timeStr) return { utcDate: '', utcTime: '' };
                const localDateTime = new Date(\`\${dateStr}T\${timeStr}\`);
                if (isNaN(localDateTime)) return { utcDate: '', utcTime: '' };

                const year = localDateTime.getUTCFullYear();
                const month = pad(localDateTime.getUTCMonth() + 1);
                const day = pad(localDateTime.getUTCDate());
                const hours = pad(localDateTime.getUTCHours());
                const minutes = pad(localDateTime.getUTCMinutes());
                const seconds = pad(localDateTime.getUTCSeconds());

                return {
                    utcDate: \`\${year}-\${month}-\${day}\`,
                    utcTime: \`\${hours}:\${minutes}:\${seconds}\`
                };
            }

            function utcToLocal(utcDateStr, utcTimeStr) {
                if (!utcDateStr || !utcTimeStr) return { localDate: '', localTime: '' };
                const utcDateTime = new Date(\`\${utcDateStr}T\${utcTimeStr}Z\`);
                if (isNaN(utcDateTime)) return { localDate: '', localTime: '' };

                const year = utcDateTime.getFullYear();
                const month = pad(utcDateTime.getMonth() + 1);
                const day = pad(utcDateTime.getDate());
                const hours = pad(utcDateTime.getHours());
                const minutes = pad(utcDateTime.getMinutes());
                const seconds = pad(utcDateTime.getSeconds());

                return {
                    localDate: \`\${year}-\${month}-\${day}\`,
                    localTime: \`\${hours}:\${minutes}:\${seconds}\`
                };
            }

            function addExpiryTime(dateInputId, timeInputId, amount, unit) {
                const dateInput = document.getElementById(dateInputId);
                const timeInput = document.getElementById(timeInputId);

                let date = new Date(\`\${dateInput.value}T\${timeInput.value || '00:00:00'}\`);
                if (isNaN(date.getTime())) {
                    date = new Date();
                }

                if (unit === 'hour') date.setHours(date.getHours() + amount);
                else if (unit === 'day') date.setDate(date.getDate() + amount);
                else if (unit === 'month') date.setMonth(date.getMonth() + amount);

                const year = date.getFullYear();
                const month = pad(date.getMonth() + 1);
                const day = pad(date.getDate());
                const hours = pad(date.getHours());
                const minutes = pad(date.getMinutes());
                const seconds = pad(date.getSeconds());

                dateInput.value = \`\${year}-\${month}-\${day}\`;
                timeInput.value = \`\${hours}:\${minutes}:\${seconds}\`;
            }

            document.body.addEventListener('click', (e) => {
                const target = e.target.closest('.time-quick-set-group button');
                if (!target) return;
                const group = target.closest('.time-quick-set-group');
                addExpiryTime(
                    group.dataset.targetDate,
                    group.dataset.targetTime,
                    parseInt(target.dataset.amount, 10),
                    target.dataset.unit
                );
            });

            function formatExpiryDateTime(expDateStr, expTimeStr) {
                const expiryUTC = new Date(\`\${expDateStr}T\${expTimeStr}Z\`);
                if (isNaN(expiryUTC)) return { local: 'Invalid Date', utc: '', relative: '', tehran: '', isExpired: true };

                const now = new Date();
                const isExpired = expiryUTC < now;

                const commonOptions = {
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short'
                };

                const localTime = expiryUTC.toLocaleString(undefined, commonOptions);
                const tehranTime = expiryUTC.toLocaleString('en-US', { ...commonOptions, timeZone: 'Asia/Tehran' });
                const utcTime = expiryUTC.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

                const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
                const diffSeconds = (expiryUTC.getTime() - now.getTime()) / 1000;
                let relativeTime = '';
                if (Math.abs(diffSeconds) < 60) relativeTime = rtf.format(Math.round(diffSeconds), 'second');
                else if (Math.abs(diffSeconds) < 3600) relativeTime = rtf.format(Math.round(diffSeconds / 60), 'minute');
                else if (Math.abs(diffSeconds) < 86400) relativeTime = rtf.format(Math.round(diffSeconds / 3600), 'hour');
                else relativeTime = rtf.format(Math.round(diffSeconds / 86400), 'day');

                return { local: localTime, tehran: tehranTime, utc: utcTime, relative: relativeTime, isExpired };
            }

            function renderUsers() {
                userList.innerHTML = '';
                if (allUsers.length === 0) {
                    userList.innerHTML = '<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>';
                } else {
                    allUsers.forEach(user => {
                        const expiry = formatExpiryDateTime(user.expiration_date, user.expiration_time);
                        const row = document.createElement('tr');
                        row.innerHTML = \`
                            <td><div class="uuid-cell" title="\${user.uuid}">\${user.uuid}</div></td>
                            <td>\${new Date(user.created_at).toLocaleString()}</td>
                            <td>
                                <div class="time-display">
                                    <span class="time-local" title="Your Local Time">\${expiry.local}</span>
                                    <span class="time-utc" title="Coordinated Universal Time">\${expiry.utc}</span>
                                    <span class="time-relative">\${expiry.relative}</span>
                                </div>
                            </td>
                             <td>
                                <div class="time-display">
                                    <span class="time-local" title="Tehran Time (GMT+03:30)">\${expiry.tehran}</span>
                                    <span class="time-utc">Asia/Tehran</span>
                                </div>
                            </td>
                            <td><span class="status-badge \${expiry.isExpired ? 'status-expired' : 'status-active'}">\${expiry.isExpired ? 'Expired' : 'Active'}</span></td>
                            <td>\${user.notes || '-'}</td>
                            <td>
                                <div class="actions-cell">
                                    <button class="btn btn-secondary btn-edit" data-uuid="\${user.uuid}">Edit</button>
                                    <button class="btn btn-danger btn-delete" data-uuid="\${user.uuid}">Delete</button>
                                </div>
                            </td>
                        \`;
                        userList.appendChild(row);
                    });
                }
            }

            async function fetchAndRenderUsers() {
                try {
                    allUsers = await api.get('/users');
                    allUsers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                    renderUsers();
                } catch (error) { showToast(error.message, true); }
            }

            async function handleCreateUser(e) {
                e.preventDefault();
                const localDate = document.getElementById('expiryDate').value;
                const localTime = document.getElementById('expiryTime').value;

                const { utcDate, utcTime } = localToUTC(localDate, localTime);
                if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);

                const userData = {
                    uuid: uuidInput.value,
                    exp_date: utcDate,
                    exp_time: utcTime,
                    notes: document.getElementById('notes').value
                };

                try {
                    await api.post('/users', userData);
                    showToast('User created successfully!');
                    createUserForm.reset();
                    uuidInput.value = crypto.randomUUID();
                    setDefaultExpiry();
                    await fetchAndRenderUsers();
                } catch (error) { showToast(error.message, true); }
            }

            async function handleDeleteUser(uuid) {
                if (confirm(\`Delete user \${uuid}?\`)) {
                    try {
                        await api.delete(\`/users/\${uuid}\`);
                        showToast('User deleted successfully!');
                        await fetchAndRenderUsers();
                    } catch (error) { showToast(error.message, true); }
                }
            }

            function openEditModal(uuid) {
                const user = allUsers.find(u => u.uuid === uuid);
                if (!user) return showToast('User not found.', true);

                const { localDate, localTime } = utcToLocal(user.expiration_date, user.expiration_time);

                document.getElementById('editUuid').value = user.uuid;
                document.getElementById('editExpiryDate').value = localDate;
                document.getElementById('editExpiryTime').value = localTime;
                document.getElementById('editNotes').value = user.notes || '';
                editModal.classList.add('show');
            }

            function closeEditModal() { editModal.classList.remove('show'); }

            async function handleEditUser(e) {
                e.preventDefault();
                const localDate = document.getElementById('editExpiryDate').value;
                const localTime = document.getElementById('editExpiryTime').value;

                const { utcDate, utcTime } = localToUTC(localDate, localTime);
                if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);

                const updatedData = {
                    exp_date: utcDate,
                    exp_time: utcTime,
                    notes: document.getElementById('editNotes').value
                };

                try {
                    await api.put(\`/users/\${document.getElementById('editUuid').value}\`, updatedData);
                    showToast('User updated successfully!');
                    closeEditModal();
                    await fetchAndRenderUsers();
                } catch (error) { showToast(error.message, true); }
            }

            function setDefaultExpiry() {
                const now = new Date();
                now.setDate(now.getDate() + 1); // Set expiry to 24 hours from now in LOCAL time

                const year = now.getFullYear();
                const month = pad(now.getMonth() + 1);
                const day = pad(now.getDate());
                const hours = pad(now.getHours());
                const minutes = pad(now.getMinutes());
                const seconds = pad(now.getSeconds());

                document.getElementById('expiryDate').value = \`\${year}-\${month}-\${day}\`;
                document.getElementById('expiryTime').value = \`\${hours}:\${minutes}:\${seconds}\`;
            }

            generateUUIDBtn.addEventListener('click', () => uuidInput.value = crypto.randomUUID());
            createUserForm.addEventListener('submit', handleCreateUser);
            editUserForm.addEventListener('submit', handleEditUser);
            editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
            document.getElementById('modalCloseBtn').addEventListener('click', closeEditModal);
            document.getElementById('modalCancelBtn').addEventListener('click', closeEditModal);
            userList.addEventListener('click', (e) => {
                const target = e.target.closest('button');
                if (!target) return;
                const uuid = target.dataset.uuid;
                if (target.classList.contains('btn-edit')) openEditModal(uuid);
                else if (target.classList.contains('btn-delete')) handleDeleteUser(uuid);
            });

            setDefaultExpiry();
            uuidInput.value = crypto.randomUUID();
            fetchAndRenderUsers();
        });
    </script>
</body>
</html>`;

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
        
        // GET /admin/api/users - List all users
        if (pathname === '/admin/api/users' && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, notes FROM users ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }

        // POST /admin/api/users - Create a new user
        if (pathname === '/admin/api/users' && request.method === 'POST') {
             try {
                const { uuid, exp_date: expDate, exp_time: expTime, notes } = await request.json();

                // Corrected and clarified validation logic
                if (!uuid || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid or missing fields. Use UUID, YYYY-MM-DD, and HH:MM:SS.');
                }
                 
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes) VALUES (?, ?, ?, ?)")
                    .bind(uuid, expDate, expTime, notes || null).run();
                await env.USER_KV.put(`user:${uuid}`, JSON.stringify({ exp_date: expDate, exp_time: expTime }));
                 
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
                await Promise.all(uuids.map(uuid => env.USER_KV.delete(`user:${uuid}`)));
                 
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
                const { exp_date: expDate, exp_time: expTime, notes } = await request.json();
                if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid date/time fields. Use YYYY-MM-DD and HH:MM:SS.');
                }
                 
                await env.DB.prepare("UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ? WHERE uuid = ?")
                    .bind(expDate, expTime, notes || null, uuid).run();
                await env.USER_KV.put(`user:${uuid}`, JSON.stringify({ exp_date: expDate, exp_time: expTime }));
                 
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
                await env.USER_KV.delete(`user:${uuid}`);
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
                    headers: { 'Location': '/admin', 'Set-Cookie': `auth_token=${token}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict` },
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


// --- Original Code (Config, Handlers, etc.) ---
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
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
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
        links.push(
          buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i+1}` })
        );

        if (!isPagesDeployment) {
          links.push(
            buildLink({ core, proto: 'tcp', userID, hostName, address: formattedAddress, port: pick(httpPorts), tag: `IP${i+1}` })
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
      const uuid = url.pathname.slice(`/${core}/`.length);
      if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
      const userData = await getUserData(env, uuid);
      if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time))) {
        return new Response('Invalid or expired user', { status: 403 });
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
      if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time))) {
        return new Response('Invalid or expired user', { status: 403 });
      }
      return handleConfigPage(path, url.hostname, cfg.proxyAddress, userData.exp_date, userData.exp_time);
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
        console.error(`Reverse Proxy Error: ${e.message}`);
        return new Response(`Proxy configuration error or upstream server is down. Please check the ROOT_PROXY_URL variable. Error: ${e.message}`, { status: 502 });
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
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = { value: null };
  let isDns = false;

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
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
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}` ;

          if (hasError) {
            controller.error(message);
            return;
          }

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
        },
        abort(err) {
          log('readableWebSocketStream aborted', err);
        },
      }),
    )
    .catch(err => {
      console.error('Pipeline failed:', err.stack || err);
    });

  return new Response(null, { status: 101, webSocket: client });
}

async function ProcessProtocolHeader(protocolBuffer, env) {
  if (protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };

  const dataView = new DataView(protocolBuffer);
  const version = dataView.getUint8(0);
  const slicedBufferString = stringify(new Uint8Array(protocolBuffer.slice(1, 17)));

  const userData = await getUserData(env, slicedBufferString);

  if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time))) {
    return { hasError: true, message: 'invalid or expired user' };
  }

  const optLength = dataView.getUint8(17);
  const command = dataView.getUint8(18 + optLength);
  if (command !== 1 && command !== 2) return { hasError: true, message: `command ${command} is not supported` };

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
      return { hasError: true, message: `invalid addressType: ${addressType}` };
  }

  if (!addressValue) return { hasError: true, message: `addressValue is empty, addressType is ${addressType}` };

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
    log(`connected to ${address}:${port}`);
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
      log(`ReadableStream was canceled, due to ${reason}`);
      safeCloseWebSocket(webSocketServer);
    },
  });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log) {
  let hasIncomingData = false;
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
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
              log(`DNS query successful, length: ${udpSize}`);
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
      throw new Error(`Invalid addressType for SOCKS5: ${addressType}`);
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

  const scamalyticsUrl = `${baseUrl}${username}/?key=${apiKey}&ip=${ipToLookup}`;
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

function handleConfigPage(userID, hostName, proxyAddress, expDate, expTime) {
  const html = generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate = '', expTime = '') {
  const singleXrayConfig = buildLink({
    core: 'xray', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Xray`,
  });

  const singleSingboxConfig = buildLink({
    core: 'sb', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Singbox`,
  });

  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;

  const clientUrls = {
    universalAndroid: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    karing: `karing://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
    stash: `stash://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    streisand: `streisand://import/${btoa(subXrayUrl)}`,
    clashMeta: `clash://install-config?url=${encodeURIComponent(`https://revil-sub.pages.dev/sub/clash-meta?url=${subSbUrl}&remote_config=&udp=false&ss_uot=false&show_host=false&forced_ws0rtt=true`)}`,
  };

  let expirationBlock = '';
  if (expDate && expTime) {
      const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;
      expirationBlock = `
        <div class="expiration-card">
          <div class="expiration-card-content">
            <h2 class="expiration-title">Expiration Date</h2>
            <div id="expiration-relative" class="expiration-relative-time"></div>
            <hr class="expiration-divider">
            <div id="expiration-display" data-utc-time="${utcTimestamp}">Loading expiration time...</div>
          </div>
        </div>
      `;
  } else {
      expirationBlock = `
        <div class="expiration-card">
          <div class="expiration-card-content">
            <h2 class="expiration-title">Expiration Date</h2>
            <hr class="expiration-divider">
            <div id="expiration-display">No expiration date set.</div>
          </div>
        </div>
      `;
  }

  const finalHTML = `<!doctype html>
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
    <style>${getPageCSS()}</style> 
  </head>
  <body data-proxy-ip="${proxyAddress}">
    ${getPageHTML(singleXrayConfig, singleSingboxConfig, clientUrls, subXrayUrl, subSbUrl).replace(
        '', 
        expirationBlock
    )}
    <script>${getPageScript()}</script>
  </body>
  </html>`;

  return finalHTML;
}

function getPageCSS() {
  return `
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      @font-face {
      font-family: "Aldine 401 BT Web";
      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/Aldine401_Mersedeh.woff2") format("woff2");
      font-weight: 400; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: "Styrene B LC";
      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Regular.woff2") format("woff2");
      font-weight: 400; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: "Styrene B LC";
      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Medium.woff2") format("woff2");
      font-weight: 500; font-style: normal; font-display: swap;
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
        font-family: var(--sans-serif); font-size: 16px; font-weight: 400; font-style: normal;
        background-color: var(--background-primary); color: var(--text-primary);
        padding: 3rem; line-height: 1.5; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
      }
      
      @keyframes rgb-animation {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .expiration-card {
        position: relative;
        padding: 3px;
        background: var(--background-secondary);
        border-radius: var(--border-radius);
        margin-bottom: 24px;
        overflow: hidden;
        z-index: 1;
      }
      .expiration-card::before {
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
      .expiration-card-content {
        background: var(--background-secondary);
        padding: 20px;
        border-radius: calc(var(--border-radius) - 3px);
      }
      .expiration-title {
        font-family: var(--serif);
        font-size: 1.6rem;
        font-weight: 400;
        text-align: center;
        color: var(--accent-secondary);
        margin: 0 0 12px 0;
      }
      .expiration-relative-time {
        text-align: center;
        font-size: 1.1rem;
        font-weight: 500;
        margin-bottom: 12px;
        padding: 4px 8px;
        border-radius: 6px;
      }
      .expiration-relative-time.active {
        color: var(--status-success);
        background-color: rgba(112, 181, 112, 0.1);
      }
      .expiration-relative-time.expired {
        color: var(--status-error);
        background-color: rgba(224, 93, 68, 0.1);
      }
      .expiration-divider {
        border: 0;
        height: 1px;
        background: var(--border-color);
        margin: 0 auto 16px;
        width: 80%;
      }
      #expiration-display { font-size: 0.9em; text-align: center; color: var(--text-secondary); }
      #expiration-display span { display: block; margin-top: 8px; font-size: 0.9em; line-height: 1.6; }
      #expiration-display strong { color: var(--text-primary); font-weight: 500; }

      .container {
        max-width: 800px; margin: 20px auto; padding: 0 12px; border-radius: var(--border-radius);
        box-shadow: 0 6px 15px rgba(0, 0, 0, 0.2), 0 0 25px 8px var(--shadow-color-accent);
        transition: box-shadow var(--transition-speed-medium) ease;
      }
      .container:hover { box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25), 0 0 35px 10px var(--shadow-color-accent); }
      .header { text-align: center; margin-bottom: 30px; padding-top: 30px; }
      .header h1 { font-family: var(--serif); font-weight: 400; font-size: 1.8rem; color: var(--text-accent); margin-top: 0px; margin-bottom: 2px; }
      .header p { color: var(--text-secondary); font-size: 0.6rem; font-weight: 400; }
      .config-card {
        background: var(--background-secondary); border-radius: var(--border-radius); padding: 20px; margin-bottom: 24px; border: 1px solid var(--border-color);
        transition: border-color var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
      }
      .config-card:hover { border-color: var(--border-color-hover); box-shadow: 0 4px 8px var(--shadow-color); }
      .config-title {
        font-family: var(--serif); font-size: 1.6rem; font-weight: 400; color: var(--accent-secondary);
        margin-bottom: 16px; padding-bottom: 13px; border-bottom: 1px solid var(--border-color);
        display: flex; align-items: center; justify-content: space-between;
      }
      .config-title .refresh-btn {
        position: relative; overflow: hidden; display: flex; align-items: center; gap: 4px;
        font-family: var(--serif); font-size: 12px; padding: 6px 12px; border-radius: 6px;
        color: var(--accent-secondary); background-color: var(--background-tertiary); border: 1px solid var(--border-color);
        cursor: pointer;
        transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, color var(--transition-speed) ease, transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
      }
      .config-title .refresh-btn::before {
        content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        background: linear-gradient(120deg, transparent, rgba(255, 255, 255, 0.2), transparent);
        transform: translateX(-100%); transition: transform var(--transition-speed-long) ease; z-index: 1;
      }
      .config-title .refresh-btn:hover {
        letter-spacing: 0.5px; font-weight: 600; background-color: #4d453e; color: var(--accent-primary);
        border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color);
      }
      .config-title .refresh-btn:hover::before { transform: translateX(100%); }
      .config-title .refresh-btn:active { transform: translateY(0px) scale(0.98); box-shadow: none; }
      .refresh-icon { width: 12px; height: 12px; stroke: currentColor; }
      .config-content {
        position: relative; background: var(--background-tertiary); border-radius: var(--border-radius);
        padding: 16px; margin-bottom: 20px; border: 1px solid var(--border-color);
      }
      .config-content pre {
        overflow-x: auto; font-family: var(--mono-serif); font-size: 7px; color: var(--text-primary);
        margin: 0; white-space: pre-wrap; word-break: break-all;
      }
      .button {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        padding: 8px 16px; border-radius: var(--border-radius); font-size: 15px; font-weight: 500;
        cursor: pointer; border: 1px solid var(--border-color); background-color: var(--background-tertiary);
        color: var(--button-text-secondary);
        transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, color var(--transition-speed) ease, transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation; text-decoration: none; overflow: hidden; z-index: 1;
      }
      .button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
      .button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; transition: opacity var(--transition-speed) ease; }
      .copy-buttons {
        position: relative; display: flex; gap: 4px; overflow: hidden; align-self: center;
        font-family: var(--serif); font-size: 13px; padding: 6px 12px; border-radius: 6px;
        color: var(--accent-secondary); border: 1px solid var(--border-color);
        transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, color var(--transition-speed) ease, transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
      }
      .copy-buttons::before, .client-btn::before {
        content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        background: linear-gradient(120deg, transparent, rgba(255, 255, 255, 0.2), transparent);
        transform: translateX(-100%); transition: transform var(--transition-speed-long) ease; z-index: -1;
      }
      .copy-buttons:hover::before, .client-btn:hover::before { transform: translateX(100%); }
      .copy-buttons:hover {
        background-color: #4d453e; letter-spacing: 0.5px; font-weight: 600;
        border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color);
      }
      .copy-buttons:active { transform: translateY(0px) scale(0.98); box-shadow: none; }
      .copy-icon { width: 12px; height: 12px; stroke: currentColor; }
      .client-buttons-container { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }
      .client-buttons-container h3 { font-family: var(--serif); font-size: 14px; color: var(--text-secondary); margin: 8px 0 -8px 0; font-weight: 400; text-align: center; }
      .client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
      .client-btn {
        width: 100%; background-color: var(--accent-primary); color: var(--background-tertiary);
        border-radius: 6px; border-color: var(--accent-primary-darker); position: relative; overflow: hidden;
        transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
      }
      .client-btn::after {
        content: ''; position: absolute; bottom: -5px; left: 0; width: 100%; height: 5px;
        background: linear-gradient(90deg, var(--accent-tertiary), var(--accent-secondary));
        opacity: 0; transition: all 0.3s ease; z-index: 0;
      }
      .client-btn:hover {
        text-transform: uppercase; letter-spacing: 0.3px; transform: translateY(-3px);
        background-color: var(--accent-secondary); color: var(--button-text-primary);
        box-shadow: 0 5px 15px rgba(190, 155, 123, 0.5); border-color: var(--accent-secondary);
      }
      .client-btn:hover::after { opacity: 1; bottom: 0; }
      .client-btn:active { transform: translateY(0) scale(0.98); box-shadow: 0 2px 3px rgba(0, 0, 0, 0.2); background-color: var(--accent-primary-darker); }
      .client-btn .client-icon { position: relative; z-index: 2; transition: transform 0.3s ease; }
      .client-btn:hover .client-icon { transform: rotate(15deg) scale(1.1); }
      .client-btn .button-text { position: relative; z-index: 2; transition: letter-spacing 0.3s ease; }
      .client-btn:hover .button-text { letter-spacing: 0.5px; }
    .client-icon { width: 18px; height: 18px; border-radius: 6px; background-color: var(--background-secondary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .client-icon svg { width: 14px; height: 14px; fill: var(--accent-secondary); }
    .button.copied { background-color: var(--accent-secondary) !important; color: var(--background-tertiary) !important; }
    .button.error { background-color: #c74a3b !important; color: var(--text-accent) !important; }
    .footer { text-align: center; margin-top: 20px; margin-bottom: 40px; color: var(--text-secondary); font-size: 8px; }
    .footer p { margin-bottom: 0px; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--background-primary); border-radius: 4px; }
    ::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; border: 2px solid var(--background-primary); }
    ::-webkit-scrollbar-thumb:hover { background: var(--border-color-hover); }
    * { scrollbar-width: thin; scrollbar-color: var(--border-color) var(--background-primary); }
    .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 24px; }
    .ip-info-section { background-color: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 20px; }
    .ip-info-header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; }
    .ip-info-header svg { width: 20px; height: 20px; stroke: var(--accent-secondary); }
    .ip-info-header h3 { font-family: var(--serif); font-size: 18px; font-weight: 400; color: var(--accent-secondary); margin: 0; }
    .ip-info-content { display: flex; flex-direction: column; gap: 10px; }
    .ip-info-item { display: flex; flex-direction: column; gap: 2px; }
    .ip-info-item .label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
    .ip-info-item .value { font-size: 14px; color: var(--text-primary); word-break: break-all; line-height: 1.4; }
    .badge { display: inline-flex; align-items: center; justify-content: center; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-yes { background-color: rgba(112, 181, 112, 0.15); color: var(--status-success); border: 1px solid rgba(112, 181, 112, 0.3); }
    .badge-no { background-color: rgba(224, 93, 68, 0.15); color: var(--status-error); border: 1px solid rgba(224, 93, 68, 0.3); }
    .badge-neutral { background-color: rgba(79, 144, 196, 0.15); color: var(--status-info); border: 1px solid rgba(79, 144, 196, 0.3); }
    .badge-warning { background-color: rgba(224, 188, 68, 0.15); color: var(--status-warning); border: 1px solid rgba(224, 188, 68, 0.3); }
    .skeleton { display: block; background: linear-gradient(90deg, var(--background-tertiary) 25%, var(--background-secondary) 50%, var(--background-tertiary) 75%); background-size: 200% 100%; animation: loading 1.5s infinite; border-radius: 4px; height: 16px; }
    @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .country-flag { display: inline-block; width: 18px; height: auto; max-height: 14px; margin-right: 6px; vertical-align: middle; border-radius: 2px; }
    @media (max-width: 768px) {
      body { padding: 20px; } .container { padding: 0 14px; width: min(100%, 768px); }
      .ip-info-grid { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 18px; }
      .header h1 { font-size: 1.8rem; } .header p { font-size: 0.7rem }
      .ip-info-section { padding: 14px; gap: 18px; } .ip-info-header h3 { font-size: 16px; }
      .ip-info-header { gap: 8px; } .ip-info-content { gap: 8px; }
      .ip-info-item .label { font-size: 11px; } .ip-info-item .value { font-size: 13px; }
      .config-card { padding: 16px; } .config-title { font-size: 18px; }
      .config-title .refresh-btn { font-size: 11px; } .config-content pre { font-size: 12px; }
      .client-buttons { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
      .button { font-size: 12px; } .copy-buttons { font-size: 11px; }
    }
    @media (max-width: 480px) {
      body { padding: 16px; } .container { padding: 0 12px; width: min(100%, 390px); }
      .header h1 { font-size: 20px; } .header p { font-size: 8px; }
      .ip-info-section { padding: 14px; gap: 16px; }
      .ip-info-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
      .ip-info-header h3 { font-size: 14px; } .ip-info-header { gap: 6px; } .ip-info-content { gap: 6px; }
      .ip-info-header svg { width: 18px; height: 18px; } .ip-info-item .label { font-size: 9px; }
      .ip-info-item .value { font-size: 11px; } .badge { padding: 2px 6px; font-size: 10px; border-radius: 10px; }
      .config-card { padding: 10px; } .config-title { font-size: 16px; }
      .config-title .refresh-btn { font-size: 10px; } .config-content { padding: 12px; }
      .config-content pre { font-size: 10px; }
      .client-buttons { grid-template-columns: repeat(auto-fill, minmax(100%, 1fr)); }
      .button { padding: 4px 8px; font-size: 11px; } .copy-buttons { font-size: 10px; } .footer { font-size: 10px; }
      }
    @media (max-width: 359px) {
          body { padding: 12px; font-size: 14px; } .container { max-width: 100%; padding: 8px; }
          .header h1 { font-size: 16px; } .header p { font-size: 6px; }
          .ip-info-section { padding: 12px; gap: 12px; }
          .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
          .ip-info-header h3 { font-size: 13px; } .ip-info-header { gap: 4px; } .ip-info-content { gap: 4px; }
          .ip-info-header svg { width: 16px; height: 16px; } .ip-info-item .label { font-size: 8px; }
  .ip-info-item .value { font-size: 10px; } .badge { padding: 1px 4px; font-size: 9px; border-radius: 8px; }
          .config-card { padding: 8px; } .config-title { font-size: 13px; } .config-title .refresh-btn { font-size: 9px; }
          .config-content { padding: 8px; } .config-content pre { font-size: 8px; }
  .client-buttons { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
          .button { padding: 3px 6px; font-size: 10px; } .copy-buttons { font-size: 9px; } .footer { font-size: 7px; }
        }
     
        @media (min-width: 360px) { .container { max-width: 95%; } }
        @media (min-width: 480px) { .container { max-width: 90%; } }
        @media (min-width: 640px) { .container { max-width: 600px; } }
        @media (min-width: 768px) { .container { max-width: 720px; } }
        @media (min-width: 1024px) { .container { max-width: 800px; } }
  `;
}

function getPageHTML(singleXrayConfig, singleSingboxConfig, clientUrls, subXrayUrl, subSbUrl) {
  return `
    <div class="container">
      <div class="header">
        <h1>VLESS Proxy Configuration</h1>
        <p>Copy the configuration or import directly into your client</p>
      </div>

      <div class="config-card">
        <div class="config-title">
          <span>Network Information</span>
          <button id="refresh-ip-info" class="refresh-btn" aria-label="Refresh IP information">
            <svg class="refresh-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            Refresh
          </button>
        </div>
        <div class="ip-info-grid">
          <div class="ip-info-section">
            <div class="ip-info-header">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15.5 2H8.6c-.4 0-.8.2-1.1.5-.3.3-.5.7-.5 1.1v16.8c0 .4.2.8.5 1.1.3.3.7.5 1.1.5h6.9c.4 0 .8-.2 1.1-.5.3-.3.5-.7.5-1.1V3.6c0-.4-.2-.8-.5-1.1-.3-.3-.7-.5-1.1-.5z" />
                <circle cx="12" cy="18" r="1" />
              </svg>
              <h3>Proxy Server</h3>
            </div>
            <div class="ip-info-content">
              <div class="ip-info-item"><span class="label">Proxy Host</span><span class="value" id="proxy-host"><span class="skeleton" style="width: 150px"></span></span></div>
              <div class="ip-info-item"><span class="label">IP Address</span><span class="value" id="proxy-ip"><span class="skeleton" style="width: 120px"></span></span></div>
              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton" style="width: 100px"></span></span></div>
              <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="proxy-isp"><span class="skeleton" style="width: 140px"></span></span></div>
            </div>
          </div>
          <div class="ip-info-section">
            <div class="ip-info-header">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
              </svg>
              <h3>Your Connection</h3>
            </div>
            <div class="ip-info-content">
              <div class="ip-info-item"><span class="label">Your IP</span><span class="value" id="client-ip"><span class="skeleton" style="width: 110px"></span></span></div>
              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton" style="width: 90px"></span></span></div>
              <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="client-isp"><span class="skeleton" style="width: 130px"></span></span></div>
              <div class="ip-info-item"><span class="label">Risk Score</span><span class="value" id="client-proxy"><span class="skeleton" style="width: 100px"></span></span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="config-card">
        <div class="config-title">
          <span>Xray Subscription</span>
          <button id="copy-xray-sub-btn" class="button copy-buttons" data-clipboard-text="${subXrayUrl}">
             <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
             Copy Link
          </button>
        </div>
        <div class="config-content" style="display:none;"><pre id="xray-config">${singleXrayConfig}</pre></div>
        <div class="client-buttons-container">
            <h3>Android</h3>
            <div class="client-buttons">
                <a href="${clientUrls.universalAndroid}" class="button client-btn">
                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M4.3,17.4 L19.7,17.4 L19.7,6.6 L4.3,6.6 L4.3,17.4 Z M3,4 L21,4 C22.1,4 23,4.9 23,6 L23,18 C23,19.1 22.1,20 21,20 L3,20 C1.9,20 1,19.1 1,18 L1,6 C1,4.9 1.9,4 3,4 L3,4 Z"/></svg></span>
                    <span class="button-text">Universal Import (V2rayNG, etc.)</span>
                </a>
                 <a href="${clientUrls.karing}" class="button client-btn">
                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2L4 5v6c0 5.5 3.5 10.7 8 12.3 4.5-1.6 8-6.8 8-12.3V5l-8-3z" /></svg></span>
                    <span class="button-text">Import to Karing</span>
                </a>
            </div>
            <h3>iOS</h3>
            <div class="client-buttons">
                <a href="${clientUrls.shadowrocket}" class="button client-btn">
                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12,2 C6.48,2 2,6.48 2,12 C2,17.52 6.48,22 12,22 C17.52,22 22,17.52 22,12 C22,6.48 17.52,2 12,2 Z M16.29,15.71 L12,11.41 L7.71,15.71 L6.29,14.29 L10.59,10 L6.29,5.71 L7.71,4.29 L12,8.59 L16.29,4.29 L17.71,5.71 L13.41,10 L17.71,14.29 L16.29,15.71 Z"/></svg></span>
                    <span class="button-text">Import to Shadowrocket</span>
                </a>
                <a href="${clientUrls.stash}" class="button client-btn">
                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12,2 L2,7 L12,12 L22,7 L12,2 Z M2,17 L12,22 L22,17 L12,12 L2,17 Z M2,12 L12,17 L22,12 L12,7 L2,12 Z"/></svg></span>
                    <span class="button-text">Import to Stash</span>
                </a>
                <a href="${clientUrls.streisand}" class="button client-btn">
                    <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M19,3 H5 C3.9,3 3,3.9 3,5 v14 c0,1.1 0.9,2 2,2 h14 c1.1,0 2-0.9 2-2 V5 C21,3.9 20.1,3 19,3 Z M12,11.5 c-0.83,0 -1.5,-0.67 -1.5,-1.5 s0.67,-1.5 1.5,-1.5 s1.5,0.67 1.5,1.5 S12.83,11.5 12,11.5 Z"/></svg></span>
                    <span class="button-text">Import to Streisand</span>
                </a>
            </div>
            <h3>Desktop / Other</h3>
            <div class="client-buttons">
              <button class="button client-btn" onclick="toggleQR('xray', '${subXrayUrl}')">
                <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zm0 10h6v6H4zm10-10h6v6h-6zm0 10h6v6h-6zm-4-3h2v2h-2zm0-4h2v2h-2zm-4 0h2v2H6zm-2-2h2v2H4zm12 0h2v2h-2zM9 6h2v2H9zm4 0h2v2h-2zm2 5h2v2h-2zM9 13h2v2H9zm-2 2h2v2H7zm-2-2h2v2H5z"/></svg></span>
                <span class="button-text">Show QR Code</span>
              </button>
            </div>
            <div id="qr-xray-container" style="display:none; text-align:center; margin-top: 10px; background: white; padding: 10px; border-radius: 8px; max-width: 276px; margin-left: auto; margin-right: auto;"><div id="qr-xray"></div></div>
        </div>
      </div>

      <div class="config-card">
        <div class="config-title">
          <span>Sing-Box / Clash Subscription</span>
          <button id="copy-sb-sub-btn" class="button copy-buttons" data-clipboard-text="${subSbUrl}">
            <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy Link
          </button>
        </div>
        <div class="config-content" style="display:none;"><pre id="singbox-config">${singleSingboxConfig}</pre></div>
        <div class="client-buttons-container">
            <h3>Android / Windows / macOS</h3>
            <div class="client-buttons">
                <a href="${clientUrls.clashMeta}" class="button client-btn">
                  <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" /></svg></span>
                  <span class="button-text">Import to Clash Meta / Stash</span>
                </a>
            </div>
            <h3>Desktop / Other</h3>
             <div class="client-buttons">
              <button class="button client-btn" onclick="toggleQR('singbox', '${subSbUrl}')">
                <span class="client-icon"><svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zm0 10h6v6H4zm10-10h6v6h-6zm0 10h6v6h-6zm-4-3h2v2h-2zm0-4h2v2h-2zm-4 0h2v2H6zm-2-2h2v2H4zm12 0h2v2h-2zM9 6h2v2H9zm4 0h2v2h-2zm2 5h2v2h-2zM9 13h2v2H9zm-2 2h2v2H7zm-2-2h2v2H5z"/></svg></span>
                <span class="button-text">Show QR Code</span>
              </button>
            </div>
            <div id="qr-singbox-container" style="display:none; text-align:center; margin-top: 10px; background: white; padding: 10px; border-radius: 8px; max-width: 276px; margin-left: auto; margin-right: auto;"><div id="qr-singbox"></div></div>
        </div>
      </div>

      <div class="footer">
        <p>© <span id="current-year">${new Date().getFullYear()}</span> REvil - All Rights Reserved</p>
        <p>Secure. Private. Fast.</p>
      </div>
    </div>
  `;
}

function getPageScript() {
  return `
      function copyToClipboard(button, text) {
        const originalHTML = button.innerHTML;
        navigator.clipboard.writeText(text).then(() => {
          button.innerHTML = \`<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Copied!\`;
          button.classList.add("copied");
          button.disabled = true;
          setTimeout(() => {
            button.innerHTML = originalHTML;
            button.classList.remove("copied");
            button.disabled = false;
          }, 1200);
        }).catch(err => {
          console.error("Failed to copy text: ", err);
        });
      }

      function toggleQR(id, url) {
        var container = document.getElementById('qr-' + id + '-container');
        if (container.style.display === 'none' || container.style.display === '') {
            container.style.display = 'block';
            if (!url) {
                console.error("Subscription URL for QR code is missing.");
                container.innerHTML = "<p style='color:red; padding: 10px;'>Error: Subscription URL not provided.</p>";
                return;
            }
            var qrElement = document.getElementById('qr-' + id);
            qrElement.innerHTML = ''; 
            if (!qrElement.hasChildNodes()) {
                new QRCode(qrElement, {
                    text: url,
                    width: 256,
                    height: 256,
                    colorDark: "#2a2421",
                    colorLight: "#e5dfd6",
                    correctLevel: QRCode.CorrectLevel.H
                });
            }
        } else {
            container.style.display = 'none';
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
            const errorText = await response.text();
            throw new Error(\`Worker request failed! status: \${response.status}, details: \${errorText}\`);
          }
          const data = await response.json();
          if (data.scamalytics && data.scamalytics.status === 'error') {
              throw new Error(data.scamalytics.error || 'Scamalytics API error via Worker');
          }
          return data;
        } catch (error) {
          console.error('Error fetching from Scamalytics via Worker:', error);
          return null;
        }
      }

      function updateScamalyticsClientDisplay(data) {
        const prefix = 'client';
        if (!data  || !data.scamalytics  || data.scamalytics.status !== 'ok') {
          showError(prefix, (data && data.scamalytics && data.scamalytics.error) || 'Could not load client data from Scamalytics');
          return;
        }
        const sa = data.scamalytics;
        const dbip = data.external_datasources?.dbip;
        const elements = {
          ip: document.getElementById(\`\${prefix}-ip\`), location: document.getElementById(\`\${prefix}-location\`),
          isp: document.getElementById(\`\${prefix}-isp\`), proxy: document.getElementById(\`\${prefix}-proxy\`)
        };
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
        if (elements.isp) elements.isp.textContent = sa.scamalytics_isp  || dbip?.isp_name  || "N/A";
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
              }
          }
          elements.proxy.innerHTML = \`<span class="badge \${badgeClass}">\${riskText}</span>\`;
        }
      }

      function updateIpApiIoDisplay(geo, prefix, originalHost) {
        const hostElement = document.getElementById(\`\${prefix}-host\`);
        if (hostElement) hostElement.textContent = originalHost || "N/A";
        const elements = {
          ip: document.getElementById(\`\${prefix}-ip\`), location: document.getElementById(\`\${prefix}-location\`),
          isp: document.getElementById(\`\${prefix}-isp\`)
        };
        if (!geo) {
          Object.values(elements).forEach(el => { if(el) el.innerHTML = "N/A"; });
          return;
        }
        if (elements.ip) elements.ip.textContent = geo.ip || "N/A";
        if (elements.location) {
          const city = geo.city || '';
          const countryName = geo.country_name || '';
          const countryCode = geo.country_code ? geo.country_code.toLowerCase() : '';
          let flagElementHtml = countryCode ? \`<img src="https://flagcdn.com/w20/\${countryCode}.png" srcset="https://flagcdn.com/w40/\${countryCode}.png 2x" alt="\${geo.country_code}" class="country-flag"> \` : '';
          let textPart = [city, countryName].filter(Boolean).join(', ');
          elements.location.innerHTML = (flagElementHtml || textPart) ? \`\${flagElementHtml}\${textPart}\`.trim() : "N/A";
        }
        if (elements.isp) elements.isp.textContent = geo.isp  || geo.organisation  || geo.as_name  || geo.as  || 'N/A';
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

      function showError(prefix, message = "Could not load data", originalHostForProxy = null) {
        const errorMessage = "N/A";
        const elements = (prefix === 'proxy') 
          ? ['host', 'ip', 'location', 'isp']
          : ['ip', 'location', 'isp', 'proxy'];
         
        elements.forEach(key => {
          const el = document.getElementById(\`\${prefix}-\${key}\`);
          if (!el) return;
          if (key === 'host' && prefix === 'proxy') el.textContent = originalHostForProxy || errorMessage;
          else if (key === 'proxy' && prefix === 'client') el.innerHTML = \`<span class="badge badge-neutral">N/A</span>\`;
          else el.innerHTML = errorMessage;
        });
        console.warn(\`\${prefix} data loading failed: \${message}\`);
      }

      async function loadNetworkInfo() {
        try {
          const proxyIpWithPort = document.body.getAttribute('data-proxy-ip') || "N/A";
          const proxyDomainOrIp = proxyIpWithPort.split(':')[0];
          const proxyHostEl = document.getElementById('proxy-host');
          if(proxyHostEl) proxyHostEl.textContent = proxyIpWithPort;

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
            showError('proxy', 'Proxy Host not available', proxyIpWithPort);
          }

          const clientIp = await fetchClientPublicIP();
          if (clientIp) {
            const clientIpElement = document.getElementById('client-ip');
            if(clientIpElement) clientIpElement.textContent = clientIp;
            const scamalyticsData = await fetchScamalyticsClientInfo(clientIp);
            updateScamalyticsClientDisplay(scamalyticsData);
          } else {
            showError('client', 'Could not determine your IP address.');
          }
        } catch (error) {
          console.error('Overall network info loading failed:', error);
          showError('proxy', \`Error: \${error.message}\`, document.body.getAttribute('data-proxy-ip') || "N/A");
          showError('client', \`Error: \${error.message}\`);
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

        const utcDate = new Date(expElement.dataset.utcTime);
        if (isNaN(utcDate.getTime())) {
            expElement.textContent = 'Invalid expiration time format.';
            if (relativeElement) relativeElement.style.display = 'none';
            return;
        }
         
        // --- START: Relative Time Calculation ---
        const now = new Date();
        const diffSeconds = (utcDate.getTime() - now.getTime()) / 1000;
        const isExpired = diffSeconds < 0;

        const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
        let relativeTimeStr = '';

        if (Math.abs(diffSeconds) < 60) {
            relativeTimeStr = rtf.format(Math.round(diffSeconds), 'second');
        } else if (Math.abs(diffSeconds) < 3600) {
            relativeTimeStr = rtf.format(Math.round(diffSeconds / 60), 'minute');
        } else if (Math.abs(diffSeconds) < 86400) {
            relativeTimeStr = rtf.format(Math.round(diffSeconds / 3600), 'hour');
        } else {
            relativeTimeStr = rtf.format(Math.round(diffSeconds / 86400), 'day');
        }

        if (relativeElement) {
            relativeElement.textContent = isExpired ? \`Expired \${relativeTimeStr}\` : \`Expires \${relativeTimeStr}\`;
            relativeElement.classList.add(isExpired ? 'expired' : 'active');
        }
        // --- END: Relative Time Calculation ---

        const commonOptions = {
            year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: true, timeZoneName: 'short'
        };

        const localTimeStr = utcDate.toLocaleString(undefined, commonOptions);
        const tehranTimeStr = utcDate.toLocaleString('en-US', { ...commonOptions, timeZone: 'Asia/Tehran' });
        const utcTimeStr = utcDate.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

        expElement.innerHTML = \`
          <span><strong>Your Local Time:</strong> \${localTimeStr}</span>
          <span><strong>Tehran Time:</strong> \${tehranTimeStr}</span>
          <span><strong>Universal Time:</strong> \${utcTimeStr}</span>
        \`;
      }

      document.addEventListener('DOMContentLoaded', () => {
        loadNetworkInfo();
        displayExpirationTimes();

        document.querySelectorAll('.copy-buttons').forEach(button => {
          button.addEventListener('click', function(e) {
            e.preventDefault();
            const textToCopy = this.getAttribute('data-clipboard-text');
            if (textToCopy) {
              copyToClipboard(this, textToCopy);
            }
          });
        });
        
        document.getElementById('refresh-ip-info')?.addEventListener('click', function() {
            const button = this;
            const icon = button.querySelector('.refresh-icon');
            button.disabled = true;
            if (icon) icon.style.animation = 'spin 1s linear infinite';
    
            const resetToSkeleton = (prefix) => {
              const elementsToReset = ['ip', 'location', 'isp'];
              if (prefix === 'proxy') elementsToReset.push('host');
              if (prefix === 'client') elementsToReset.push('proxy');
              elementsToReset.forEach(key => {
                const element = document.getElementById(\`\${prefix}-\${key}\`);
                if (element) element.innerHTML = \`<span class="skeleton" style="width: 120px;"></span>\`;
              });
            };
    
            resetToSkeleton('proxy');
            resetToSkeleton('client');
            loadNetworkInfo().finally(() => setTimeout(() => {
              button.disabled = false; if (icon) icon.style.animation = '';
            }, 1000));
        });
      });

      const style = document.createElement('style');
      style.textContent = \`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }\`;
      document.head.appendChild(style);
  `;
}
