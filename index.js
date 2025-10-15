import { connect } from 'cloudflare:sockets';

// Custom log function for better debugging
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// Helper functions
function generateUUID() {
  return crypto.randomUUID();
}

async function checkExpiration(expDate, expTime) {
  if (!expDate || !expTime) return false;
  const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
  return expDatetimeUTC > new Date() && !isNaN(expDatetimeUTC);
}

function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}


async function getUserData(env, uuid) {
  let userData = await env.USER_KV.get(`user:${uuid}`);
  if (userData) {
    try {
      return JSON.parse(userData);
    } catch (e) {
      log(`Failed to parse user data from KV for UUID: ${uuid}`, 'error');
    }
  }

  const query = await env.DB.prepare("SELECT expiration_date, expiration_time, data_limit, used_traffic, notes FROM users WHERE uuid = ?")
    .bind(uuid)
    .first();

  if (!query) {
    return null;
  }

  userData = { exp_date: query.expiration_date, exp_time: query.expiration_time, data_limit: query.data_limit, used_traffic: query.used_traffic, notes: query.notes };
  await env.USER_KV.put(`user:${uuid}`, JSON.stringify(userData), { expirationTtl: 3600 });
  return userData;
}

async function updateUsedTraffic(env, uuid, additionalTraffic) {
  if (additionalTraffic <= 0) return;

  await env.DB.prepare("UPDATE users SET used_traffic = used_traffic + ? WHERE uuid = ?")
    .bind(additionalTraffic, uuid)
    .run();

  // Invalidate KV cache to force a fresh read from DB on next request
  await env.USER_KV.delete(`user:${uuid}`);
  log(`Updated traffic for ${uuid} by ${additionalTraffic} bytes. Invalidated KV cache.`);
}

async function fetchDashboardStats(env) {
  const now = new Date().toISOString().split('T')[0];
  const nowTime = new Date().toISOString().split('T')[1].slice(0, 8);

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

// --- Admin Panel Logic ---

const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#121212;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1e1e1e;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #333}h1{color:#fff;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#2c2c2c;border:1px solid #444;color:#fff;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px}input[type=password]:focus{outline:0;border-color:#007aff;box-shadow:0 0 0 2px rgba(0,122,255,.3)}button{background-color:#007aff;color:#fff;border:0;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#005ecb}.error{color:#ff3b30;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST" action="/admin"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;

function getAdminPanelScript() {
    document.addEventListener('DOMContentLoaded', () => {
        const API_BASE = '/admin/api';
        let allUsers = [];
        let currentUsers = [];
        const userList = document.getElementById('userList');
        const createUserForm = document.getElementById('createUserForm');
        const generateUUIDBtn = document.getElementById('generateUUID');
        const uuidInput = document.getElementById('uuid');
        const toast = document.getElementById('toast');
        const editModal = document.getElementById('editModal');
        const editUserForm = document.getElementById('editUserForm');
        const selectAllCheckbox = document.getElementById('selectAll');
        const deleteSelectedBtn = document.getElementById('deleteSelected');
        const searchInput = document.getElementById('searchInput');
        const statusFilter = document.getElementById('statusFilter');
        const dashboardStats = document.getElementById('dashboardStats');
        const pagination = document.getElementById('pagination');
        let currentPage = 1;
        const pageSize = 10;
        let searchDebounceTimer;
        let chartInstance = null;

        let csrfToken = "CSRF_TOKEN_PLACEHOLDER";

        function showToast(message, isError = false) {
            toast.textContent = message;
            toast.className = isError ? 'error' : 'success';
            toast.classList.add('show');
            setTimeout(() => { toast.classList.remove('show'); }, 3000);
        }

        const api = {
            get: (endpoint) => fetch(`${API_BASE}${endpoint}`, { credentials: 'include' }).then(handleResponse),
            post: (endpoint, body) => fetch(`${API_BASE}${endpoint}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) }).then(handleResponse),
            put: (endpoint, body) => fetch(`${API_BASE}${endpoint}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) }).then(handleResponse),
            delete: (endpoint) => fetch(`${API_BASE}${endpoint}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken } }).then(handleResponse),
        };
        
        async function handleResponse(response) {
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'An unknown error occurred.' }));
                throw new Error(errorData.error || `Request failed with status ${response.status}`);
            }
            return response.status === 204 ? null : response.json();
        }

        const pad = (num) => num.toString().padStart(2, '0');

        function localToUTC(dateStr, timeStr) {
            if (!dateStr || !timeStr) return { utcDate: '', utcTime: '' };
            const localDateTime = new Date(`${dateStr}T${timeStr}`);
            if (isNaN(localDateTime)) return { utcDate: '', utcTime: '' };
            return {
                utcDate: `${localDateTime.getUTCFullYear()}-${pad(localDateTime.getUTCMonth() + 1)}-${pad(localDateTime.getUTCDate())}`,
                utcTime: `${pad(localDateTime.getUTCHours())}:${pad(localDateTime.getUTCMinutes())}:${pad(localDateTime.getUTCSeconds())}`
            };
        }

        function utcToLocal(utcDateStr, utcTimeStr) {
            if (!utcDateStr || !utcTimeStr) return { localDate: '', localTime: '' };
            const utcDateTime = new Date(`${utcDateStr}T${utcTimeStr}Z`);
            if (isNaN(utcDateTime)) return { localDate: '', localTime: '' };
            return {
                localDate: `${utcDateTime.getFullYear()}-${pad(utcDateTime.getMonth() + 1)}-${pad(utcDateTime.getDate())}`,
                localTime: `${pad(utcDateTime.getHours())}:${pad(utcDateTime.getMinutes())}:${pad(utcDateTime.getSeconds())}`
            };
        }
        
        function addExpiryTime(dateInputId, timeInputId, amount, unit) {
            const dateInput = document.getElementById(dateInputId);
            const timeInput = document.getElementById(timeInputId);
            let date = new Date(`${dateInput.value}T${timeInput.value || '00:00:00'}`);
            if (isNaN(date.getTime())) date = new Date();
            if (unit === 'hour') date.setHours(date.getHours() + amount);
            else if (unit === 'day') date.setDate(date.getDate() + amount);
            else if (unit === 'month') date.setMonth(date.getMonth() + amount);
            dateInput.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
            timeInput.value = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        }
        
        document.body.addEventListener('click', (e) => {
            const timeTarget = e.target.closest('.time-quick-set-group button');
            if (timeTarget) {
                const group = timeTarget.closest('.time-quick-set-group');
                addExpiryTime(group.dataset.targetDate, group.dataset.targetTime, parseInt(timeTarget.dataset.amount, 10), timeTarget.dataset.unit);
                return;
            }
            const dataTarget = e.target.closest('.data-quick-set-group button');
            if (dataTarget) {
                const gb = parseInt(dataTarget.dataset.gb, 10);
                const form = dataTarget.closest('form');
                const valueInput = form.querySelector('input[type="number"][id*="DataLimitValue"]');
                const unitInput = form.querySelector('select[id*="DataLimitUnit"]');
                if (valueInput && unitInput) {
                    valueInput.value = gb;
                    unitInput.value = 'GB';
                }
            }
        });

        function isUserExpired(user) {
            const expiryUTC = new Date(`${user.expiration_date}T${user.expiration_time}Z`);
            const isTimeExpired = isNaN(expiryUTC) || expiryUTC < new Date();
            const isDataExpired = user.data_limit > 0 && user.used_traffic >= user.data_limit;
            return isTimeExpired || isDataExpired;
        }
        
        function formatExpiryDateTime(expDateStr, expTimeStr) {
            const expiryUTC = new Date(`${expDateStr}T${expTimeStr}Z`);
            if (isNaN(expiryUTC)) return { relative: 'Invalid Date', isExpired: true };
            const now = new Date();
            const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
            const diffSeconds = (expiryUTC.getTime() - now.getTime()) / 1000;
            let relativeTime = '';
            if (Math.abs(diffSeconds) < 60) relativeTime = rtf.format(Math.round(diffSeconds), 'second');
            else if (Math.abs(diffSeconds) < 3600) relativeTime = rtf.format(Math.round(diffSeconds / 60), 'minute');
            else if (Math.abs(diffSeconds) < 86400) relativeTime = rtf.format(Math.round(diffSeconds / 3600), 'hour');
            else relativeTime = rtf.format(Math.round(diffSeconds / 86400), 'day');
            return {
                local: expiryUTC.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
                tehran: expiryUTC.toLocaleString('en-US', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
                relative: relativeTime,
            };
        }

        function formatBytes(bytes, decimals = 2) {
            if (!bytes || bytes === 0) return '0 Bytes';
            const k = 1024;
            const dm = decimals < 0 ? 0 : decimals;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
        }

        function getDataLimitInBytes(value, unit) {
            const numValue = parseFloat(value) || 0;
            if (numValue === 0) return 0;
            const units = { 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3, 'TB': 1024 ** 4 };
            return numValue * (units[unit] || 0);
        }

        function setUnlimited(isEdit = false) {
            const prefix = isEdit ? 'edit' : '';
            document.getElementById(`${prefix}DataLimitValue`).value = 0;
            document.getElementById(`${prefix}DataLimitUnit`).value = 'GB';
        }

        function getDataLimitFromInputs(isEdit = false) {
            const prefix = isEdit ? 'edit' : '';
            return getDataLimitInBytes(document.getElementById(`${prefix}DataLimitValue`).value, document.getElementById(`${prefix}DataLimitUnit`).value);
        }

        function setDataLimitInputs(dataLimit, isEdit = false) {
            const prefix = isEdit ? 'edit' : '';
            const valueEl = document.getElementById(`${prefix}DataLimitValue`);
            const unitEl = document.getElementById(`${prefix}DataLimitUnit`);
            if (!dataLimit || dataLimit === 0) {
                valueEl.value = 0;
                unitEl.value = 'GB';
                return;
            }
            let unit = 'GB';
            let value = dataLimit;
            if (value >= 1024 ** 4) { value /= 1024 ** 4; unit = 'TB'; }
            else if (value >= 1024 ** 3) { value /= 1024 ** 3; unit = 'GB'; }
            else if (value >= 1024 ** 2) { value /= 1024 ** 2; unit = 'MB'; }
            else if (value >= 1024) { value /= 1024; unit = 'KB'; }
            valueEl.value = Number.isInteger(value) ? value : value.toFixed(2);
            unitEl.value = unit;
        }

        function renderDashboardStats(stats) {
            dashboardStats.innerHTML = `<div class="dashboard-stat"><h3>${stats.totalUsers}</h3><p>Total Users</p></div><div class="dashboard-stat"><h3>${stats.activeUsers}</h3><p>Active Users</p></div><div class="dashboard-stat"><h3>${stats.expiredUsers}</h3><p>Expired Users</p></div><div class="dashboard-stat"><h3>${formatBytes(stats.totalTraffic)}</h3><p>Total Traffic</p></div>`;
            const ctx = document.getElementById('statsChart').getContext('2d');
            const style = getComputedStyle(document.documentElement);
            if (chartInstance) chartInstance.destroy();
            chartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ['Users', 'Traffic'],
                    datasets: [
                        { label: 'Active', data: [stats.activeUsers, 0], backgroundColor: style.getPropertyValue('--success').trim(), stack: 'stack0' },
                        { label: 'Expired', data: [stats.expiredUsers, 0], backgroundColor: style.getPropertyValue('--expired').trim(), stack: 'stack0' },
                        { label: 'Total Traffic (GB)', data: [0, (stats.totalTraffic / (1024 ** 3)).toFixed(2)], backgroundColor: style.getPropertyValue('--accent').trim(), yAxisID: 'yTraffic', stack: 'stack1' }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: true }, title: { display: true, text: 'User and Traffic Overview' } },
                    scales: {
                        x: { stacked: true },
                        y: { type: 'linear', display: true, position: 'left', stacked: true, title: { display: true, text: 'User Count' }, beginAtZero: true },
                        yTraffic: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Traffic (GB)' }, grid: { drawOnChartArea: false }, beginAtZero: true }
                    }
                }
            });
        }

        function renderUsers() {
            const start = (currentPage - 1) * pageSize;
            const end = start + pageSize;
            const paginatedUsers = currentUsers.slice(start, end);
            userList.innerHTML = '';
            if (paginatedUsers.length === 0) {
                userList.innerHTML = '<tr><td colspan="9" style="text-align:center;">No users found.</td></tr>';
                return;
            }
            paginatedUsers.forEach(user => {
                const expiry = formatExpiryDateTime(user.expiration_date, user.expiration_time);
                const expired = isUserExpired(user);
                const dataLimit = user.data_limit || 0;
                const usedTraffic = user.used_traffic || 0;
                const trafficText = dataLimit === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
                const progressPercent = dataLimit === 0 ? 0 : Math.min((usedTraffic / dataLimit) * 100, 100);
                let progressClass = '';
                if (progressPercent > 90) progressClass = 'danger';
                else if (progressPercent > 70) progressClass = 'warning';
                const row = document.createElement('tr');
                row.dataset.uuid = user.uuid;
                row.innerHTML = `<td><input type="checkbox" class="userSelect" data-uuid="${user.uuid}"></td><td title="${user.uuid}">${user.uuid.substring(0, 8)}...</td><td>${new Date(user.created_at).toLocaleString()}</td><td title="${expiry.local}">${expiry.relative}</td><td title="${expiry.tehran}">Tehran</td><td><span class="status-badge ${expired ? 'status-expired' : 'status-active'}">${expired ? 'Expired' : 'Active'}</span></td><td><div class="progress-bar-container"><div class="progress-bar ${progressClass}" style="width: ${progressPercent}%"></div></div><div class="traffic-text">${trafficText}</div></td><td title="${user.notes || ''}">${(user.notes || '-').substring(0, 20)}</td><td><div class="actions-cell"><button class="btn btn-secondary btn-renew" data-uuid="${user.uuid}">Renew</button><button class="btn btn-secondary btn-edit" data-uuid="${user.uuid}">Edit</button><button class="btn btn-danger btn-delete" data-uuid="${user.uuid}">Delete</button></div></td>`;
                userList.appendChild(row);
            });
        }

        function updateView() {
            applyFilters();
            renderUsers();
            renderPagination();
        }

        async function fetchAndRenderAll() {
            try {
                userList.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 20px;">Loading users...</td></tr>';
                const [users, stats] = await Promise.all([api.get('/users'), api.get('/stats')]);
                allUsers = users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                currentPage = 1;
                updateView();
                renderDashboardStats(stats);
            } catch (error) {
                showToast(error.message, true);
                userList.innerHTML = `<tr><td colspan="9" style="text-align:center; color: var(--danger); padding: 20px;">Failed to load users: ${error.message}</td></tr>`;
            }
        }

        async function handleCreateUser(e) {
            e.preventDefault();
            const { utcDate, utcTime } = localToUTC(document.getElementById('expiryDate').value, document.getElementById('expiryTime').value);
            if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);
            const userData = { uuid: uuidInput.value, exp_date: utcDate, exp_time: utcTime, data_limit: getDataLimitFromInputs(), notes: document.getElementById('notes').value };
            try {
                await api.post('/users', userData);
                showToast('User created successfully!');
                createUserForm.reset();
                uuidInput.value = crypto.randomUUID();
                setDefaultExpiry();
                await fetchAndRenderAll();
            } catch (error) { showToast(error.message, true); }
        }

        async function handleDeleteUser(uuid) {
            if (confirm(`Delete user ${uuid}?`)) {
                try {
                    await api.delete(`/users/${uuid}`);
                    showToast('User deleted successfully!');
                    await fetchAndRenderAll();
                } catch (error) { showToast(error.message, true); }
            }
        }

        async function handleRenewUser(uuid) {
            if (confirm(`Renew user ${uuid} for 30 days?`)) {
                try {
                    await api.post(`/users/${uuid}/renew`, { days: 30 });
                    showToast('User renewed successfully!');
                    await fetchAndRenderAll();
                } catch (error) { showToast(error.message, true); }
            }
        }

        async function handleBulkDelete() {
            const selectedUuids = Array.from(document.querySelectorAll('.userSelect:checked')).map(cb => cb.dataset.uuid);
            if (selectedUuids.length === 0) return showToast('No users selected.', true);
            if (confirm(`Delete ${selectedUuids.length} selected users?`)) {
                try {
                    await api.post('/users/bulk-delete', { uuids: selectedUuids });
                    showToast('Selected users deleted successfully!');
                    await fetchAndRenderAll();
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
            setDataLimitInputs(user.data_limit, true);
            document.getElementById('editNotes').value = user.notes || '';
            document.getElementById('resetTraffic').checked = false;
            editModal.classList.add('show');
        }

        function closeEditModal() { editModal.classList.remove('show'); }

        async function handleEditUser(e) {
            e.preventDefault();
            const { utcDate, utcTime } = localToUTC(document.getElementById('editExpiryDate').value, document.getElementById('editExpiryTime').value);
            if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);
            const updatedData = { exp_date: utcDate, exp_time: utcTime, data_limit: getDataLimitFromInputs(true), notes: document.getElementById('editNotes').value, reset_traffic: document.getElementById('resetTraffic').checked };
            try {
                await api.put(`/users/${document.getElementById('editUuid').value}`, updatedData);
                showToast('User updated successfully!');
                closeEditModal();
                await fetchAndRenderAll();
            } catch (error) { showToast(error.message, true); }
        }

        function setDefaultExpiry() {
            const now = new Date();
            now.setMonth(now.getMonth() + 1);
            now.setHours(23, 59, 59, 999);
            document.getElementById('expiryDate').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            document.getElementById('expiryTime').value = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        }
        
        function applyFilters() {
            const searchTerm = searchInput.value.toLowerCase();
            const status = statusFilter.value;
            let filtered = allUsers;
            if (searchTerm) {
                filtered = filtered.filter(user => user.uuid.toLowerCase().includes(searchTerm) || (user.notes || '').toLowerCase().includes(searchTerm));
            }
            if (status !== 'all') {
                const checkExpired = status === 'expired';
                filtered = filtered.filter(user => isUserExpired(user) === checkExpired);
            }
            currentUsers = filtered;
        }

        function handleFilterChange() {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                currentPage = 1;
                updateView();
            }, 300);
        }

        function exportToCSV() {
            if (allUsers.length === 0) return showToast("No users to export.", true);
            const csv = ['UUID,Created At,Expiration Date,Expiration Time,Data Limit (Bytes),Used Traffic (Bytes),Notes', ...allUsers.map(u => [u.uuid, u.created_at, u.expiration_date, u.expiration_time, u.data_limit, u.used_traffic, `"${(u.notes || '').replace(/"/g, '""')}"`].join(','))].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'users_export.csv';
            link.click();
            URL.revokeObjectURL(link.href);
        }
        
        function renderPagination() {
            pagination.innerHTML = '';
            const totalPages = Math.ceil(currentUsers.length / pageSize);
            if (totalPages <= 1) return;
            const createBtn = (text, onClick, disabled) => {
                const btn = document.createElement('button');
                btn.classList.add('btn', 'btn-secondary');
                btn.textContent = text;
                btn.disabled = disabled;
                btn.onclick = onClick;
                return btn;
            };
            pagination.appendChild(createBtn('Previous', () => { currentPage--; updateView(); }, currentPage === 1));
            const pageInfo = document.createElement('span');
            pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
            pagination.appendChild(pageInfo);
            pagination.appendChild(createBtn('Next', () => { currentPage++; updateView(); }, currentPage === totalPages));
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
            else if (target.classList.contains('btn-renew')) handleRenewUser(uuid);
        });
        document.getElementById('selectAll').addEventListener('change', (e) => document.querySelectorAll('.userSelect').forEach(cb => cb.checked = e.target.checked));
        deleteSelectedBtn.addEventListener('click', handleBulkDelete);
        searchInput.addEventListener('input', handleFilterChange);
        statusFilter.addEventListener('change', handleFilterChange);
        document.getElementById('setUnlimitedCreate').addEventListener('click', () => setUnlimited(false));
        document.getElementById('setUnlimitedEdit').addEventListener('click', () => setUnlimited(true));
        document.getElementById('exportUsers').addEventListener('click', exportToCSV);

        setDefaultExpiry();
        uuidInput.value = crypto.randomUUID();
        fetchAndRenderAll();
        setInterval(fetchAndRenderAll, 60000); // Increased interval to 60s
    });
}

const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>:root{--bg-main:#111827;--bg-card:#1F2937;--border:#374151;--text-primary:#F9FAFB;--text-secondary:#9CA3AF;--accent:#3B82F6;--accent-hover:#2563EB;--danger:#EF4444;--danger-hover:#DC2626;--success:#22C55E;--expired:#F59E0B;--btn-secondary-bg:#4B5563}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1200px;margin:40px auto;padding:0 20px}h1,h2{font-weight:600}h1{font-size:24px;margin-bottom:20px}h2{font-size:18px;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:20px}.card{background-color:var(--bg-card);border-radius:8px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 6px rgba(0,0,0,.1)}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}.form-group label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.form-group .input-group{display:flex}input[type=text],input[type=date],input[type=time],input[type=number],select{width:100%;box-sizing:border-box;background-color:#374151;border:1px solid #4B5563;color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s}input:focus,select:focus{outline:0;border-color:var(--accent)}.label-note{font-size:11px;color:var(--text-secondary);margin-top:4px}.btn{padding:10px 16px;border:0;border-radius:6px;font-weight:600;cursor:pointer;transition:background-color .2s,transform .1s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.98)}.btn-primary{background-color:var(--accent);color:#fff}.btn-primary:hover{background-color:var(--accent-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:#6B7280}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.btn-renew{background-color:#10B981;color:#fff}.btn-renew:hover{background-color:#059669}.input-group .btn{border-radius:0 6px 6px 0}.input-group input, .input-group select{border-right:0}.input-group *:first-child{border-radius:6px 0 0 6px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase;white-space:nowrap}td{color:var(--text-primary);font-family:"SF Mono","Fira Code",monospace;vertical-align:middle}.status-badge{padding:4px 8px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:var(--success);color:#064E3B}.status-expired{background-color:var(--expired);color:#78350F}.actions-cell .btn{padding:6px 10px;font-size:12px}#toast{position:fixed;top:20px;right:20px;background-color:var(--bg-card);color:#fff;padding:15px 20px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .3s,transform .3s;transform:translateY(-20px)}#toast.show{display:block;opacity:1;transform:translateY(0)}#toast.error{border-left:5px solid var(--danger)}#toast.success{border-left:5px solid var(--success)}.actions-cell{display:flex;gap:8px;justify-content:flex-start;flex-wrap:wrap}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;box-shadow:0 5px 25px rgba(0,0,0,.4);width:90%;max-width:500px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:15px;margin-bottom:20px}.modal-header h2{margin:0;border:0;font-size:20px}.modal-close-btn{background:0 0;border:0;color:var(--text-secondary);font-size:24px;cursor:pointer;line-height:1}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.time-quick-set-group,.data-quick-set-group{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.btn-outline-secondary{background-color:transparent;border:1px solid var(--btn-secondary-bg);color:var(--text-secondary);padding:6px 10px;font-size:12px;font-weight:500}.btn-outline-secondary:hover{background-color:var(--btn-secondary-bg);color:#fff;border-color:var(--btn-secondary-bg)}.progress-bar-container{width:100%;background-color:#374151;border-radius:4px;height:8px;overflow:hidden;margin-top:4px}.progress-bar{height:100%;background-color:var(--success);transition:width .3s ease}.progress-bar.warning{background-color:var(--expired)}.progress-bar.danger{background-color:var(--danger)}.traffic-text{font-size:12px;color:var(--text-secondary);margin-top:4px;text-align:right}.dashboard-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:30px}.dashboard-stat{background-color:var(--bg-card);padding:16px;border-radius:8px;border:1px solid var(--border);text-align:center}.dashboard-stat h3{font-size:28px;color:var(--accent);margin:0}.dashboard-stat p{color:var(--text-secondary);margin:0;font-size:14px}.filter-container{display:flex;gap:16px;margin-bottom:16px}.filter-container > *{flex:1}.table-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:24px}.pagination .btn{padding:6px 12px}.pagination span{color:var(--text-secondary);font-size:14px}#statsChartContainer{margin-top:20px;position:relative;height:300px}</style></head><body><div class="container"><h1>Admin Dashboard</h1><div class="dashboard-grid" id="dashboardStats"></div><div id="statsChartContainer"><canvas id="statsChart"></canvas></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required><div class="label-note">Auto-converted to UTC.</div><div class="time-quick-set-group" data-target-date="expiryDate" data-target-time="expiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="30" data-unit="day">+1 Month</button></div></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" min="0" value="0" required><select id="dataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedCreate">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="filter-container"><input type="text" id="searchInput" placeholder="Search by UUID or Notes..."><select id="statusFilter"><option value="all">All Statuses</option><option value="active">Active</option><option value="expired">Expired</option></select></div><div class="table-header"><button id="deleteSelected" class="btn btn-danger">Delete Selected</button><button id="exportUsers" class="btn btn-renew">Export to CSV</button></div><div style="overflow-x:auto"><table><thead><tr><th><input type="checkbox" id="selectAll"></th><th>UUID</th><th>Created</th><th>Expiry</th><th>Tehran Time</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div><div class="pagination" id="pagination"></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div><div class="form-group" style="margin-top:16px"><label for="editExpiryTime">Expiry Time (Local)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required><div class="time-quick-set-group" data-target-date="editExpiryDate" data-target-time="editExpiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="30" data-unit="day">+1 Month</button></div></div><div class="form-group" style="margin-top:16px"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" min="0" required><select id="editDataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedEdit">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group" style="margin-top:16px"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group" style="margin-top:16px"><label><input type="checkbox" id="resetTraffic" name="resetTraffic"> Reset Traffic Usage</label></div><div class="modal-footer"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>/* SCRIPT_PLACEHOLDER */</script></body></html>`;

async function isAdmin(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return false;
    const token = cookieHeader.match(/auth_token=([^;]+)/)?.[1];
    if (!token) return false;
    const storedToken = await env.USER_KV.get('admin_session_token');
    return storedToken && storedToken === token;
}

const rateLimiter = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const entry = rateLimiter.get(ip) || { count: 0, timestamp: now };
    if (now - entry.timestamp > 60000) {
        rateLimiter.delete(ip); // Clean up old entries
        entry.count = 0;
        entry.timestamp = now;
    }
    entry.count++;
    rateLimiter.set(ip, entry);
    if (entry.count > 100) { // Limit to 100 req/min
        log(`Rate limit exceeded for IP: ${ip}`, 'warn');
        return false;
    }
    return true;
}

async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self';";
    const jsonHeader = { 'Content-Type': 'application/json' };
    const htmlHeader = { 'Content-Type': 'text/html;charset=utf-8', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload', 'Content-Security-Policy': csp };
    const ip = request.headers.get('CF-Connecting-IP');
    
    if (!checkRateLimit(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: jsonHeader });
    }

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured.', { status: 503 });
    }
    
    // API routes
    if (pathname.startsWith('/admin/api/')) {
        if (!(await isAdmin(request, env))) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
        }

        // CSRF and Origin check for non-GET requests
        if (request.method !== 'GET') {
            const receivedCsrfToken = request.headers.get('X-CSRF-Token');
            const storedCsrfToken = await env.USER_KV.get('csrf_token');
            if (!receivedCsrfToken || !storedCsrfToken || receivedCsrfToken !== storedCsrfToken) {
                return new Response(JSON.stringify({ error: 'Invalid CSRF token' }), { status: 403, headers: jsonHeader });
            }
            const origin = request.headers.get('Origin');
            if (!origin || new URL(origin).hostname !== url.hostname) {
                return new Response(JSON.stringify({ error: 'Invalid Origin' }), { status: 403, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/stats' && request.method === 'GET') {
            try {
                return new Response(JSON.stringify(await fetchDashboardStats(env)), { status: 200, headers: jsonHeader });
            } catch (e) {
                log(e.message, 'error');
                return new Response(JSON.stringify({ error: "Failed to fetch stats" }), { status: 500, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/users' && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, data_limit, used_traffic, notes FROM users ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
            } catch (e) {
                log(e.message, 'error');
                return new Response(JSON.stringify({ error: "Failed to fetch users" }), { status: 500, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/users' && request.method === 'POST') {
            try {
                const { uuid, exp_date: expDate, exp_time: expTime, data_limit, notes } = await request.json();
                if (!uuid || !isValidUUID(uuid) || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid or missing fields. Use a valid UUID, YYYY-MM-DD, and HH:MM:SS.');
                }
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, data_limit, used_traffic, notes) VALUES (?, ?, ?, ?, 0, ?)")
                    .bind(uuid, expDate, expTime, data_limit || 0, notes || null).run();
                await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            } catch (error) {
                log(error.message, 'error');
                return new Response(JSON.stringify({ error: error.message.includes('UNIQUE') ? 'A user with this UUID already exists.' : error.message }), { status: 400, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/users/bulk-delete' && request.method === 'POST') {
            try {
                const { uuids } = await request.json();
                if (!Array.isArray(uuids) || uuids.length === 0) throw new Error('UUIDs array is required.');
                await env.DB.batch(uuids.map(uuid => env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid)));
                await Promise.all(uuids.map(uuid => env.USER_KV.delete(`user:${uuid}`)));
                return new Response(JSON.stringify({ success: true, count: uuids.length }), { status: 200, headers: jsonHeader });
            } catch (error) {
                log(error.message, 'error');
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }

        const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)(\/renew)?$/);

        if (userRouteMatch && userRouteMatch[2] === '/renew' && request.method === 'POST') {
            const uuid = userRouteMatch[1];
            try {
                const { days } = await request.json();
                if (!Number.isInteger(days) || days <= 0) throw new Error('Invalid number of days.');
                
                const currentUser = await env.DB.prepare("SELECT expiration_date, expiration_time FROM users WHERE uuid = ?").bind(uuid).first();
                if (!currentUser) throw new Error('User not found.');
                
                const currentExpiry = new Date(`${currentUser.expiration_date}T${currentUser.expiration_time}Z`);
                const baseDate = currentExpiry > new Date() ? currentExpiry : new Date(); // Renew from now if expired, otherwise from expiry date
                baseDate.setDate(baseDate.getDate() + days);
                
                const newExpDate = baseDate.toISOString().slice(0, 10);
                const newExpTime = baseDate.toISOString().slice(11, 19);

                await env.DB.prepare("UPDATE users SET expiration_date = ?, expiration_time = ? WHERE uuid = ?").bind(newExpDate, newExpTime, uuid).run();
                await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
                return new Response(JSON.stringify({ success: true, new_expiry_date: newExpDate, new_expiry_time: newExpTime }), { status: 200, headers: jsonHeader });

            } catch (error) {
                 log(error.message, 'error');
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }
        
        if (userRouteMatch && !userRouteMatch[2] && request.method === 'PUT') {
            const uuid = userRouteMatch[1];
            try {
                const { exp_date: expDate, exp_time: expTime, data_limit, notes, reset_traffic } = await request.json();
                if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid date/time fields.');
                }
                
                let query, params;
                if (reset_traffic) {
                    query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ?, used_traffic = 0 WHERE uuid = ?";
                    params = [expDate, expTime, data_limit ?? 0, notes || null, uuid];
                } else {
                    query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ? WHERE uuid = ?";
                    params = [expDate, expTime, data_limit ?? 0, notes || null, uuid];
                }
                await env.DB.prepare(query).bind(...params).run();

                await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
                return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
            } catch (error) {
                log(error.message, 'error');
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }

        if (userRouteMatch && !userRouteMatch[2] && request.method === 'DELETE') {
            const uuid = userRouteMatch[1];
            try {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete(`user:${uuid}`);
                return new Response(null, { status: 204 });
            } catch (error) {
                log(error.message, 'error');
                return new Response(JSON.stringify({ error: "Failed to delete user" }), { status: 500, headers: jsonHeader });
            }
        }

        return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
    }

    // Admin panel login/dashboard
    if (pathname === '/admin') {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const sessionToken = crypto.randomUUID();
                const csrfToken = crypto.randomUUID();
                await Promise.all([
                    env.USER_KV.put('admin_session_token', sessionToken, { expirationTtl: 86400 }),
                    env.USER_KV.put('csrf_token', csrfToken, { expirationTtl: 86400 })
                ]);
                return new Response(null, { status: 302, headers: { 'Location': '/admin', 'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=/; Max-Age=86400; SameSite=Strict` } });
            } else {
                return new Response(adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: htmlHeader });
            }
        }
        if (request.method === 'GET') {
            if (await isAdmin(request, env)) {
                const csrfToken = await env.USER_KV.get('csrf_token') || crypto.randomUUID();
                const scriptString = getAdminPanelScript.toString().replace('"CSRF_TOKEN_PLACEHOLDER"', `"${csrfToken}"`);
                const finalAdminPanelHTML = adminPanelHTML.replace('/* SCRIPT_PLACEHOLDER */', `(${scriptString})()`);
                return new Response(finalAdminPanelHTML, { headers: htmlHeader });
            } else {
                return new Response(adminLoginHTML, { headers: htmlHeader });
            }
        }
        return new Response('Method Not Allowed', { status: 405 });
    }
    return new Response('Not found', { status: 404 });
}

// --- VLESS Proxy Logic & Main Router ---

const Config = {
    proxyIPs: [''],
    fromEnv(env) {
        const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
        return { proxyAddress: selectedProxyIP };
    },
};

const CONST = {
    VLESS_VERSION: new Uint8Array([0]),
    WS_READY_STATE_OPEN: 1,
};

function generateRandomPath(length = 12, query = '') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
    xray: {
        tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} },
        tcp: { path: () => generateRandomPath(12, 'ed=2048'), security: 'none', fp: 'chrome', extra: {} },
    },
    sb: {
        tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: { ed: 2560 } },
        tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: { ed: 2560 } },
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

function buildLink({ core, proto, userID, hostName, address, port, tag }) {
    const p = CORE_PRESETS[core][proto];
    return createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: p.security === 'tls' ? hostName : undefined, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `${tag}-${proto.toUpperCase()}` });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function handleIpSubscription(core, userID, hostName) {
    const mainDomains = [hostName, 'creativecommons.org', 'www.speedtest.net', 'sky.rethinkdns.com', 'cfip.1323123.xyz', 'go.inmobi.com', 'zula.ir'];
    const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
    const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
    let links = [];
    const isPagesDeployment = hostName.endsWith('.pages.dev');

    mainDomains.forEach((domain, i) => {
        links.push(buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i + 1}` }));
        if (!isPagesDeployment) links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: domain, port: pick(httpPorts), tag: `D${i + 1}` }));
    });

    try {
        const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
        if (r.ok) {
            const json = await r.json();
            const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
            ips.forEach((ip, i) => {
                const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
                links.push(buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i + 1}` }));
                if (!isPagesDeployment) links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: formattedAddress, port: pick(httpPorts), tag: `IP${i + 1}` }));
            });
        }
    } catch (e) { console.error('Fetch IP list failed', e); }

    return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/admin')) {
            return handleAdminRequest(request, env);
        }

        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
            return await vlessOverWSHandler(request, env, ctx);
        }

        const handleSubscription = async (core) => {
            const uuid = url.pathname.slice(`/${core}/`.length);
            if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
            const userData = await getUserData(env, uuid);
            if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time)) || (userData.data_limit > 0 && userData.used_traffic >= userData.data_limit)) {
                return new Response('Invalid or expired user or traffic limit reached', { status: 403 });
            }
            return handleIpSubscription(core, uuid, url.hostname);
        };

        if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
        if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

        const path = url.pathname.slice(1);
        if (isValidUUID(path)) {
            const userData = await getUserData(env, path);
            if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time)) || (userData.data_limit > 0 && userData.used_traffic >= userData.data_limit)) {
                return new Response('Invalid or expired user or traffic limit reached', { status: 403 });
            }
            const cfg = Config.fromEnv(env);
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
                ['Content-Security-Policy', 'Content-Security-Policy-Report-Only', 'X-Frame-Options'].forEach(h => mutableHeaders.delete(h));
                return new Response(response.body, { status: response.status, statusText: response.statusText, headers: mutableHeaders });
            } catch (e) {
                log(`Reverse Proxy Error: ${e.message}`, 'error');
                return new Response(`Proxy configuration error: ${e.message}`, { status: 502 });
            }
        }

        return new Response('Not found', { status: 404 });
    },
};

async function vlessOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const connectionState = { uuid: '', remoteSocket: null, incoming: 0, outgoing: 0 };
    let earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';

    const readableWebSocketStream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => {
                const data = event.data;
                connectionState.outgoing += data.byteLength;
                controller.enqueue(data);
            });
            webSocket.addEventListener('close', () => controller.close());
            webSocket.addEventListener('error', err => controller.error(err));
            if (earlyDataHeader) {
                const earlyData = base64ToArrayBuffer(earlyDataHeader);
                if (earlyData) {
                    connectionState.outgoing += earlyData.byteLength;
                    controller.enqueue(earlyData);
                }
            }
        }
    });

    readableWebSocketStream.pipeTo(
        new WritableStream({
            async write(chunk, controller) {
                if (connectionState.remoteSocket) {
                    const writer = connectionState.remoteSocket.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const { uuid, address, port, rawDataIndex, isUDP } = await processVlessHeader(chunk, env);
                connectionState.uuid = uuid;

                if (isUDP) {
                    if (port === 53) {
                        const dnsResponse = await fetch('https://1.1.1.1/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk.slice(rawDataIndex) });
                        const dnsResult = await dnsResponse.arrayBuffer();
                        const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
                        const responseBuffer = await new Blob([CONST.VLESS_VERSION, new Uint8Array([0]), udpSizeBuffer, dnsResult]).arrayBuffer();
                        connectionState.incoming += responseBuffer.byteLength;
                        webSocket.send(responseBuffer);
                    } else {
                        controller.error('UDP proxying is only supported for DNS on port 53.');
                    }
                    return;
                }

                const remoteSocket = await connect({ hostname: address, port });
                connectionState.remoteSocket = remoteSocket;

                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk.slice(rawDataIndex));
                writer.releaseLock();

                remoteSocket.readable.pipeTo(
                    new WritableStream({
                        start: () => {
                            const vlessResponse = new Uint8Array([CONST.VLESS_VERSION[0], 0]);
                            connectionState.incoming += vlessResponse.byteLength;
                            webSocket.send(vlessResponse);
                        },
                        write: chunk => {
                            connectionState.incoming += chunk.byteLength;
                            webSocket.send(chunk);
                        }
                    })
                ).catch(err => log(`Remote socket pipe failed: ${err}`, 'error'));
            }
        })
    ).catch(err => {
        log(`Main pipeline failed: ${err.message}`, 'error');
        safeCloseWebSocket(webSocket);
    }).finally(() => {
        if (connectionState.uuid) {
            const totalTraffic = connectionState.incoming + connectionState.outgoing;
            if (totalTraffic > 0) ctx.waitUntil(updateUsedTraffic(env, connectionState.uuid, totalTraffic));
        }
        log(`Connection closed. In: ${connectionState.incoming}, Out: ${connectionState.outgoing}`);
    });

    return new Response(null, { status: 101, webSocket: client });
}

async function processVlessHeader(vlessBuffer, env) {
    if (vlessBuffer.byteLength < 24) throw new Error('Invalid VLESS header: too short');
    const view = new DataView(vlessBuffer);
    if (view.getUint8(0) !== 0) throw new Error(`Invalid VLESS version: ${view.getUint8(0)}`);
    const uuid = unsafeStringify(new Uint8Array(vlessBuffer.slice(1, 17)));
    const userData = await getUserData(env, uuid);
    if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time))) throw new Error('User not found or expired');
    if ((userData.data_limit || 0) > 0 && (userData.used_traffic || 0) >= userData.data_limit) throw new Error('Traffic limit reached for user');
    const optLen = view.getUint8(17);
    const command = view.getUint8(18 + optLen);
    const port = view.getUint16(19 + optLen);
    let addressIndex = 21 + optLen;
    const addressType = view.getUint8(addressIndex++);
    let address = '';
    switch (addressType) {
        case 1:
            address = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 4)).join('.');
            addressIndex += 4;
            break;
        case 2:
            const domainLen = view.getUint8(addressIndex++);
            address = new TextDecoder().decode(vlessBuffer.slice(addressIndex, addressIndex + domainLen));
            addressIndex += domainLen;
            break;
        case 3:
            const ipv6Buffer = vlessBuffer.slice(addressIndex, addressIndex + 16);
            address = Array.from({ length: 8 }, (_, i) => new DataView(ipv6Buffer).getUint16(i * 2).toString(16)).join(':');
            addressIndex += 16;
            break;
        default: throw new Error(`Unsupported address type: ${addressType}`);
    }
    return { uuid, address, port, rawDataIndex: addressIndex, isUDP: command === 2 };
}

function base64ToArrayBuffer(base64Str) {
    try {
        const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        const buffer = new ArrayBuffer(binaryStr.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binaryStr.length; i++) view[i] = binaryStr.charCodeAt(i);
        return buffer;
    } catch { return null; }
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === CONST.WS_READY_STATE_OPEN) socket.close();
    } catch (error) {
        log(`Error closing WebSocket: ${error}`, 'error');
    }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]]).toLowerCase();
}

// Config Page Logic
function getConfigPageScript() {
    // This entire function is converted to a string and sent to the client.
    function copyToClipboard(button, text) {
        const originalHTML = button.innerHTML;
        navigator.clipboard.writeText(text).then(() => {
            button.innerHTML = `Copied!`;
            button.classList.add("copied");
            setTimeout(() => {
                button.innerHTML = originalHTML;
                button.classList.remove("copied");
            }, 1500);
        }).catch(err => console.error("Failed to copy: ", err));
    }

    function toggleQR(id, url) {
        const container = document.getElementById('qr-' + id + '-container');
        if (container.style.display === 'none' || !container.style.display) {
            container.style.display = 'block';
            if (!container.hasChildNodes()) {
                new QRCode(container, { text: url, width: 256, height: 256, colorDark: "#2a2421", colorLight: "#e5dfd6", correctLevel: QRCode.CorrectLevel.H });
            }
        } else {
            container.style.display = 'none';
        }
    }

    function displayExpirationTimes() {
        const expElement = document.getElementById('expiration-display');
        const relativeElement = document.getElementById('expiration-relative');
        if (!expElement || !expElement.dataset.utcTime) return;
        const utcDate = new Date(expElement.dataset.utcTime);
        if (isNaN(utcDate.getTime())) return;
        const now = new Date();
        const diffSeconds = (utcDate.getTime() - now.getTime()) / 1000;
        const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
        let relativeTimeStr;
        if (Math.abs(diffSeconds) < 3600) relativeTimeStr = rtf.format(Math.round(diffSeconds / 60), 'minute');
        else if (Math.abs(diffSeconds) < 86400) relativeTimeStr = rtf.format(Math.round(diffSeconds / 3600), 'hour');
        else relativeTimeStr = rtf.format(Math.round(diffSeconds / 86400), 'day');
        if (relativeElement) {
            relativeElement.textContent = diffSeconds < 0 ? `Expired ${relativeTimeStr}` : `Expires ${relativeTimeStr}`;
            relativeElement.classList.add(diffSeconds < 0 ? 'expired' : 'active');
        }
        expElement.innerHTML = `<span><strong>Local:</strong> ${utcDate.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})}</span><span><strong>Tehran:</strong> ${utcDate.toLocaleString('en-US', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' })}</span>`;
    }

    document.addEventListener('DOMContentLoaded', () => {
        displayExpirationTimes();
        document.querySelectorAll('.copy-buttons').forEach(button => button.addEventListener('click', function(e) {
            e.preventDefault();
            copyToClipboard(this, this.getAttribute('data-clipboard-text'));
        }));
        window.toggleQR = toggleQR;
    });
}

function getPageCSS() {
    return `*{margin:0;padding:0;box-sizing:border-box}:root{--bg-main:#1d1d1d;--bg-card:#2b2b2b;--border:#444;--text-primary:#f0f0f0;--text-secondary:#a0a0a0;--accent:#00aaff;--success:#44cc44;--error:#ff4444;--warning:#ffaa00;--radius:12px;--sans:"-apple-system",BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}body{font-family:var(--sans);background-color:var(--bg-main);color:var(--text-primary);padding:1rem}.container{max-width:800px;margin:20px auto}.header{text-align:center;margin-bottom:2rem}h1{font-size:1.8rem}p{color:var(--text-secondary);font-size:.9rem}.card{background:var(--bg-card);border-radius:var(--radius);padding:24px;margin-bottom:1.5rem;border:1px solid var(--border)}.card-title{font-size:1.5rem;color:var(--accent);margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}.exp-time{text-align:center;margin-bottom:1rem}.exp-relative{font-size:1.2rem;font-weight:600;margin-bottom:.5rem}.exp-relative.active{color:var(--success)}.exp-relative.expired{color:var(--error)}.exp-details span{display:block;color:var(--text-secondary);font-size:.9rem}.progress-container{width:100%;background-color:#4B5563;border-radius:4px;height:10px;overflow:hidden;margin-top:1rem}.progress-bar{height:100%;background-color:var(--success);transition:width .5s ease}.progress-bar.warning{background-color:var(--warning)}.progress-bar.danger{background-color:var(--error)}.traffic-text{font-size:.8rem;color:var(--text-secondary);margin-top:.5rem;text-align:center}.btn-group{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;margin-top:1.5rem}.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;padding:.75rem 1rem;border-radius:6px;font-size:1rem;font-weight:500;cursor:pointer;border:1px solid var(--border);background-color:var(--bg-main);color:var(--text-primary);text-decoration:none;transition:background-color .2s}.btn:hover{background-color:#3a3a3a}.btn.primary{background-color:var(--accent);color:var(--bg-main)}.btn.primary:hover{background-color:#0088cc}.btn.copied{background-color:var(--success);color:var(--bg-main);}.qr-container{display:none;margin:1rem auto;padding:1rem;background:#fff;border-radius:var(--radius);width:fit-content}.footer{text-align:center;margin-top:2rem;color:var(--text-secondary);font-size:.8rem}`;
}

function getPageHTML(clientUrls, subXrayUrl, subSbUrl) {
    return `<div class="container"><header class="header"><h1>VLESS Configuration</h1><p>Your secure connection is ready.</p></header><div class="card"><h2 class="card-title">Xray Clients</h2><div class="btn-group"><a href="${clientUrls.universalAndroid}" class="btn">Android (v2rayNG)</a><a href="${clientUrls.shadowrocket}" class="btn">iOS (Shadowrocket)</a><a href="${clientUrls.stash}" class="btn">iOS (Stash)</a><a href="${clientUrls.streisand}" class="btn">iOS (Streisand)</a><button class="btn copy-buttons" data-clipboard-text="${subXrayUrl}">Copy Subscription Link</button><button class="btn" onclick="toggleQR('xray', '${subXrayUrl}')">Show QR Code</button></div><div id="qr-xray-container" class="qr-container"></div></div><div class="card"><h2 class="card-title">Sing-Box / Clash Clients</h2><div class="btn-group"><a href="${clientUrls.clashMeta}" class="btn primary">Universal (Clash / Stash)</a><button class="btn copy-buttons" data-clipboard-text="${subSbUrl}">Copy Subscription Link</button><button class="btn" onclick="toggleQR('sb', '${subSbUrl}')">Show QR Code</button></div><div id="qr-sb-container" class="qr-container"></div></div><footer class="footer"><p>&copy; ${new Date().getFullYear()} - Secure Connection</p></footer></div>`;
}

function handleConfigPage(userID, hostName, proxyAddress, expDate, expTime, dataLimit, usedTraffic) {
    const subXrayUrl = `https://${hostName}/xray/${userID}`;
    const subSbUrl = `https://${hostName}/sb/${userID}`;
    const clientUrls = {
        universalAndroid: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
        shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
        stash: `stash://install-config?url=${encodeURIComponent(subXrayUrl)}`,
        streisand: `streisand://import/${btoa(subXrayUrl)}`,
        clashMeta: `clash://install-config?url=${encodeURIComponent(`https://sub.bonds.dev/sub/clash?url=${subSbUrl}`)}`,
    };
    const utcTimestamp = (expDate && expTime) ? `${expDate}T${expTime.split('.')[0]}Z` : '';
    const trafficPercent = (dataLimit || 0) > 0 ? Math.min((usedTraffic / dataLimit) * 100, 100) : 0;
    const formatBytes = (bytes) => {
        if (!bytes) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
    }
    const trafficText = (dataLimit || 0) === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
    let progressBarClass = 'progress-bar';
    if (trafficPercent > 90) progressBarClass += ' danger';
    else if (trafficPercent > 70) progressBarClass += ' warning';
    
    const dynamicContent = `<div class="card"><h2 class="card-title">Subscription Details</h2><div class="exp-time"><div id="expiration-relative" class="exp-relative"></div><div id="expiration-display" class="exp-details" data-utc-time="${utcTimestamp}"></div></div><div class="traffic-text">${trafficText}</div><div class="progress-container"><div class="${progressBarClass}" style="width: ${trafficPercent.toFixed(2)}%"></div></div></div>`;
    
    const pageHtml = getPageHTML(clientUrls, subXrayUrl, subSbUrl).replace('', dynamicContent);
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://raw.githubusercontent.com;";
    const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>VLESS Configuration</title><link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png"><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>${getPageCSS()}</style></head><body>${pageHtml}<script>(${getConfigPageScript.toString()})()</script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload', 'Content-Security-Policy': csp } });
}

