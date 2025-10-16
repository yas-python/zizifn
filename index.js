import { connect } from 'cloudflare:sockets';

// --- Configuration & Constants ---

const Config = {
    proxyIPs: [''], // Can be populated with default clean IPs if needed
    fromEnv(env) {
        const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
        return { proxyAddress: selectedProxyIP };
    },
};

const CONST = {
    VLESS_VERSION: new Uint8Array([0]),
    WS_READY_STATE_OPEN: 1,
    securityHeaders: {
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; img-src 'self' data: https://flagcdn.com; connect-src 'self' https://ip-api.io https://dns.google; object-src 'none'; base-uri 'self'; form-action 'self';",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
    }
};


// --- Core Helper Functions ---

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

function isValidUUID(uuid) {
    if (typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function isTimeValid(expDate, expTime) {
  if (!expDate || !expTime) return false;
  const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
  return expDatetimeUTC > new Date() && !isNaN(expDatetimeUTC);
}

function isUserValid(userData) {
    if (!userData) return false;
    const timeOK = isTimeValid(userData.expiration_date, userData.expiration_time);
    const trafficOK = (userData.data_limit === 0) || ((userData.used_traffic ?? 0) < userData.data_limit);
    return timeOK && trafficOK;
}

async function getUserData(env, uuid) {
  if (!isValidUUID(uuid)) return null;
  const cacheKey = `user:${uuid}`;
  
  try {
    let userData = await env.USER_KV.get(cacheKey, 'json');
    if (userData) {
        return userData;
    }
  } catch (e) {
      log(`KV parsing error for ${uuid}: ${e.message}`, 'warn');
  }

  try {
    const query = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!query) return null;

    const userData = {
        ...query,
        data_limit: Number(query.data_limit ?? 0),
        used_traffic: Number(query.used_traffic ?? 0)
    };
    
    const isStillValid = isUserValid(userData);
    const expirationTtl = isStillValid ? 3600 : 300; // Cache valid users for 1 hour, invalid for 5 minutes
    await env.USER_KV.put(cacheKey, JSON.stringify(userData), { expirationTtl });
    
    return userData;
  } catch (e) {
      log(`Database error fetching user ${uuid}: ${e.message}`, 'error');
      return null;
  }
}

async function updateUsedTraffic(env, uuid, additionalTraffic) {
  if (additionalTraffic <= 0 || !isValidUUID(uuid)) return;
  try {
    await env.DB.prepare("UPDATE users SET used_traffic = used_traffic + ? WHERE uuid = ?")
      .bind(additionalTraffic, uuid)
      .run();
    await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache after update
    log(`Updated traffic for ${uuid} by ${additionalTraffic} bytes.`);
  } catch (error) {
    log(`Failed to update traffic for ${uuid}: ${error.message}`, 'error');
  }
}

async function fetchDashboardStats(env) {
    const query = `
        SELECT
            COUNT(*) as totalUsers,
            SUM(CASE WHEN (expiration_date > date('now') OR (expiration_date = date('now') AND expiration_time > time('now'))) AND (data_limit = 0 OR used_traffic < data_limit) THEN 1 ELSE 0 END) as activeUsers,
            SUM(used_traffic) as totalTraffic
        FROM users
    `;
    const stats = await env.DB.prepare(query).first();
    const totalUsers = Number(stats.totalUsers ?? 0);
    const activeUsers = Number(stats.activeUsers ?? 0);
    return {
        totalUsers,
        activeUsers,
        expiredUsers: totalUsers - activeUsers,
        totalTraffic: Number(stats.totalTraffic ?? 0)
    };
}

async function cleanupExpiredUsers(env) {
    log('Starting scheduled cleanup of expired users...');
    try {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        const dateString = oneMonthAgo.toISOString().split('T')[0];
        
        const stmt = env.DB.prepare("DELETE FROM users WHERE expiration_date < ?");
        const { count } = await stmt.bind(dateString).run();
        
        if (count > 0) log(`Successfully pruned ${count} old expired users.`);
        else log('No old expired users to prune.');
    } catch (e) {
        log(`Scheduled cleanup failed: ${e.message}`, 'error');
    }
}


// --- Admin Panel Logic ---

const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#121212;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1e1e1e;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #333}h1{color:#fff;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#2c2c2c;border:1px solid #444;color:#fff;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px}input[type=password]:focus{outline:0;border-color:#007aff;box-shadow:0 0 0 2px rgba(0,122,255,.3)}button{background-color:#007aff;color:#fff;border:0;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#005ecb}.error{color:#ff3b30;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST" action="/admin"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;

function getAdminPanelScript(csrfToken) {
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
        const searchInput = document.getElementById('searchInput');
        const dashboardStats = document.getElementById('dashboardStats');
        const pagination = document.getElementById('pagination');
        let currentPage = 1;
        const pageSize = 10;
        let searchDebounceTimer;
        let chartInstance = null;

        function showToast(message, isError = false) {
            toast.textContent = message;
            toast.className = isError ? 'error' : 'success';
            toast.classList.add('show');
            setTimeout(() => { toast.classList.remove('show'); }, 5000); // Increased timeout for reading errors
        }

        const api = {
            get: (endpoint) => fetch(`${API_BASE}${endpoint}`, { credentials: 'include' }).then(handleResponse),
            post: (endpoint, body) => fetch(`${API_BASE}${endpoint}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) }).then(handleResponse),
            put: (endpoint, body) => fetch(`${API_BASE}${endpoint}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) }).then(handleResponse),
            delete: (endpoint) => fetch(`${API_BASE}${endpoint}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken } }).then(handleResponse),
        };

        // *** IMPROVEMENT: More robust error response handling ***
        async function handleResponse(response) {
            if (!response.ok) {
                try {
                    const errorData = await response.json();
                    console.error("API Error Response:", errorData); // Log full error object to console
                    const detailedError = errorData.error + (errorData.cause ? ` (Cause: ${errorData.cause})` : '');
                    throw new Error(detailedError);
                } catch (e) {
                    // This handles cases where response.json() fails (e.g., HTML error page from Cloudflare)
                    const textResponse = await response.text();
                    console.error("Non-JSON API Error Response:", textResponse);
                    throw new Error(`Request failed: Status ${response.status}. Server returned a non-JSON response.`);
                }
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

        function formatExpiryDateTime(expDateStr, expTimeStr) {
            const expiryUTC = new Date(`${expDateStr}T${expTimeStr}Z`);
            if (isNaN(expiryUTC)) return { local: 'Invalid Date', tehran: '', relative: '', isExpired: true };
            const now = new Date();
            const isExpired = expiryUTC < now;
            const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
            const diffSeconds = (expiryUTC.getTime() - now.getTime()) / 1000;
            let relativeTime = '';
            if (Math.abs(diffSeconds) < 3600) relativeTime = rtf.format(Math.round(diffSeconds / 60), 'minute');
            else if (Math.abs(diffSeconds) < 86400) relativeTime = rtf.format(Math.round(diffSeconds / 3600), 'hour');
            else relativeTime = rtf.format(Math.round(diffSeconds / 86400), 'day');
            return {
                local: expiryUTC.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
                tehran: expiryUTC.toLocaleString('en-US', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
                relative: relativeTime,
                isExpired: isExpired
            };
        }

        function formatBytes(bytes, decimals = 2) {
            if (bytes === null || typeof bytes === 'undefined' || bytes === 0) return '0 Bytes';
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
            return Math.round(numValue * (units[unit] || 0));
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
            else { value /= 1024; unit = 'KB'; }
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
                    plugins: { legend: { display: true, labels: { color: 'white' } }, title: { display: true, text: 'User and Traffic Overview', color: 'white' } },
                    scales: {
                        x: { stacked: true, ticks: { color: 'white' } },
                        y: { type: 'linear', display: true, position: 'left', stacked: true, title: { display: true, text: 'User Count', color: 'white' }, beginAtZero: true, ticks: { color: 'white' } },
                        yTraffic: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Traffic (GB)', color: 'white' }, grid: { drawOnChartArea: false }, beginAtZero: true, ticks: { color: 'white' } }
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
                renderPagination();
                return;
            }
            paginatedUsers.forEach(user => {
                const expiry = formatExpiryDateTime(user.expiration_date, user.expiration_time);
                const dataLimit = user.data_limit ?? 0;
                const usedTraffic = user.used_traffic ?? 0;
                const isExpiredByTime = expiry.isExpired;
                const isExpiredByTraffic = dataLimit > 0 && usedTraffic >= dataLimit;
                const isExpired = isExpiredByTime || isExpiredByTraffic;

                const trafficText = dataLimit === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
                const progressPercent = dataLimit === 0 ? 0 : Math.min((usedTraffic / dataLimit) * 100, 100);
                let progressClass = progressPercent > 90 ? 'danger' : progressPercent > 70 ? 'warning' : '';
                
                const row = document.createElement('tr');
                row.dataset.uuid = user.uuid;
                row.innerHTML = `<td><input type="checkbox" class="userSelect" data-uuid="${user.uuid}"></td><td title="${user.uuid}">${user.uuid.substring(0, 8)}...</td><td>${new Date(user.created_at).toLocaleString()}</td><td title="${expiry.local}">${expiry.relative}</td><td title="Local Time: ${expiry.local}">${expiry.tehran}</td><td><span class="status-badge ${isExpired ? 'status-expired' : 'status-active'}">${isExpired ? 'Expired' : 'Active'}</span></td><td><div class="progress-bar-container"><div class="progress-bar ${progressClass}" style="width: ${progressPercent}%"></div></div><div class="traffic-text">${trafficText}</div></td><td title="${user.notes || ''}">${(user.notes || '-').substring(0, 20)}</td><td><div class="actions-cell"><button class="btn btn-secondary btn-edit" data-uuid="${user.uuid}">Edit</button><button class="btn btn-danger btn-delete" data-uuid="${user.uuid}">Delete</button></div></td>`;
                userList.appendChild(row);
            });
            renderPagination();
        }

        async function fetchAndRenderAll() {
            try {
                const [users, stats] = await Promise.all([api.get('/users'), api.get('/stats')]);
                allUsers = users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                handleSearch(true); // This calls renderUsers and renderPagination
                renderDashboardStats(stats);
            } catch (error) {
                showToast(error.message, true);
            }
        }

        async function handleCreateUser(e) {
            e.preventDefault();
            const { utcDate, utcTime } = localToUTC(document.getElementById('expiryDate').value, document.getElementById('expiryTime').value);
            if (!utcDate || !utcTime) return showToast('Invalid date or time.', true);
            
            const userData = {
                uuid: uuidInput.value,
                expiration_date: utcDate,
                expiration_time: utcTime,
                data_limit: getDataLimitFromInputs(),
                notes: document.getElementById('notes').value
            };
            try {
                await api.post('/users', userData);
                showToast('User created successfully!');
                createUserForm.reset();
                uuidInput.value = crypto.randomUUID();
                setDefaultExpiry();
                await fetchAndRenderAll();
            } catch (error) {
                console.error("Create User Failed:", error); // Log for debugging
                showToast(error.message, true);
            }
        }

        async function handleDeleteUser(uuid) {
            if (confirm(`Delete user ${uuid}?`)) {
                try {
                    await api.delete(`/users/${uuid}`);
                    showToast('User deleted.');
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
                    showToast(`${selectedUuids.length} users deleted.`);
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
            if (!utcDate || !utcTime) return showToast('Invalid date or time.', true);
            
            const updatedData = {
                expiration_date: utcDate,
                expiration_time: utcTime,
                data_limit: getDataLimitFromInputs(true),
                notes: document.getElementById('editNotes').value,
                reset_traffic: document.getElementById('resetTraffic').checked
            };
            try {
                await api.put(`/users/${document.getElementById('editUuid').value}`, updatedData);
                showToast('User updated.');
                closeEditModal();
                await fetchAndRenderAll();
            } catch (error) { showToast(error.message, true); }
        }

        function setDefaultExpiry() {
            const now = new Date();
            now.setMonth(now.getMonth() + 1);
            document.getElementById('expiryDate').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            document.getElementById('expiryTime').value = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        }

        function handleSearch(immediate = false) {
            const applyFilter = () => {
                const searchTerm = searchInput.value.toLowerCase();
                currentUsers = searchTerm ? allUsers.filter(user => user.uuid.toLowerCase().includes(searchTerm) || (user.notes || '').toLowerCase().includes(searchTerm)) : [...allUsers];
                currentPage = 1;
                renderUsers();
            };
            clearTimeout(searchDebounceTimer);
            if (immediate) applyFilter();
            else searchDebounceTimer = setTimeout(applyFilter, 300);
        }

        function exportToCSV() {
            if (allUsers.length === 0) return showToast("No users to export.", true);
            const csv = ['UUID,CreatedAt,ExpirationDate,ExpirationTime,DataLimit_Bytes,UsedTraffic_Bytes,Notes', ...allUsers.map(u => [u.uuid, u.created_at, u.expiration_date, u.expiration_time, u.data_limit, u.used_traffic, `"${(u.notes || '').replace(/"/g, '""')}"`].join(','))].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `users_export_${new Date().toISOString()}.csv`;
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
                btn.innerHTML = text;
                btn.disabled = disabled;
                btn.onclick = onClick;
                return btn;
            };
            pagination.appendChild(createBtn('&laquo; Prev', () => { if(currentPage > 1) { currentPage--; renderUsers(); } }, currentPage === 1));
            pagination.appendChild(document.createElement('span')).textContent = `Page ${currentPage} of ${totalPages}`;
            pagination.appendChild(createBtn('Next &raquo;', () => { if(currentPage < totalPages) { currentPage++; renderUsers(); } }, currentPage === totalPages));
        }

        // Event Listeners
        generateUUIDBtn.addEventListener('click', () => uuidInput.value = crypto.randomUUID());
        document.getElementById('setUnlimitedCreate').addEventListener('click', () => setUnlimited(false));
        document.getElementById('setUnlimitedEdit').addEventListener('click', () => setUnlimited(true));
        document.getElementById('deleteSelected').addEventListener('click', handleBulkDelete);
        document.getElementById('exportUsers').addEventListener('click', exportToCSV);
        document.getElementById('selectAll').addEventListener('change', (e) => document.querySelectorAll('.userSelect').forEach(cb => cb.checked = e.target.checked));
        document.getElementById('modalCloseBtn').addEventListener('click', closeEditModal);
        document.getElementById('modalCancelBtn').addEventListener('click', closeEditModal);
        createUserForm.addEventListener('submit', handleCreateUser);
        editUserForm.addEventListener('submit', handleEditUser);
        editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
        searchInput.addEventListener('input', () => handleSearch(false));
        userList.addEventListener('click', (e) => {
            const target = e.target.closest('button');
            if (!target) return;
            const uuid = target.dataset.uuid;
            if (target.classList.contains('btn-edit')) openEditModal(uuid);
            else if (target.classList.contains('btn-delete')) handleDeleteUser(uuid);
        });

        // Initial Load
        setDefaultExpiry();
        uuidInput.value = crypto.randomUUID();
        fetchAndRenderAll();
        setInterval(fetchAndRenderAll, 60000); // Auto-refresh every 60 seconds
    });
}

const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>:root{--bg-main:#111827;--bg-card:#1F2937;--border:#374151;--text-primary:#F9FAFB;--text-secondary:#9CA3AF;--accent:#3B82F6;--accent-hover:#2563EB;--danger:#EF4444;--danger-hover:#DC2626;--success:#22C55E;--expired:#F59E0B;--btn-secondary-bg:#4B5563}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1200px;margin:40px auto;padding:0 20px}h1,h2{font-weight:600}h1{font-size:24px;margin-bottom:20px}h2{font-size:18px;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:20px}.card{background-color:var(--bg-card);border-radius:8px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 6px rgba(0,0,0,.1)}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}.form-group label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.form-group .input-group{display:flex}input[type=text],input[type=date],input[type=time],input[type=number],select{width:100%;box-sizing:border-box;background-color:#374151;border:1px solid #4B5563;color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s}input:focus{outline:0;border-color:var(--accent)}.label-note{font-size:11px;color:var(--text-secondary);margin-top:4px}.btn{padding:10px 16px;border:0;border-radius:6px;font-weight:600;cursor:pointer;transition:background-color .2s,transform .1s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.98)}.btn-primary{background-color:var(--accent);color:#fff}.btn-primary:hover{background-color:var(--accent-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:#6B7280}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.input-group .btn-secondary{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input, .input-group select{border-radius: 0; border-right: 0}.input-group input:first-child, .input-group select:first-child{border-top-left-radius: 6px; border-bottom-left-radius: 6px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase;white-space:nowrap}td{color:var(--text-primary);font-family:"SF Mono","Fira Code",monospace;vertical-align:middle}.status-badge{padding:4px 8px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:var(--success);color:#064E3B}.status-expired{background-color:var(--expired);color:#78350F}.actions-cell .btn{padding:6px 10px;font-size:12px}#toast{position:fixed;top:20px;right:20px;background-color:var(--bg-card);color:#fff;padding:15px 20px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .3s,transform .3s;transform:translateY(-20px)}#toast.show{display:block;opacity:1;transform:translateY(0)}#toast.error{border-left:5px solid var(--danger)}#toast.success{border-left:5px solid var(--success)}.actions-cell{display:flex;gap:8px;justify-content:flex-start}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;box-shadow:0 5px 25px rgba(0,0,0,.4);width:90%;max-width:500px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:15px;margin-bottom:20px}.modal-header h2{margin:0;border:0;font-size:20px}.modal-close-btn{background:0 0;border:0;color:var(--text-secondary);font-size:24px;cursor:pointer;line-height:1}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.time-quick-set-group,.data-quick-set-group{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.btn-outline-secondary{background-color:transparent;border:1px solid var(--btn-secondary-bg);color:var(--text-secondary);padding:6px 10px;font-size:12px;font-weight:500}.btn-outline-secondary:hover{background-color:var(--btn-secondary-bg);color:#fff;border-color:var(--btn-secondary-bg)}.progress-bar-container{width:100%;background-color:#374151;border-radius:4px;height:8px;overflow:hidden;margin-top:4px}.progress-bar{height:100%;background-color:var(--success);transition:width .3s ease}.progress-bar.warning{background-color:var(--expired)}.progress-bar.danger{background-color:var(--danger)}.traffic-text{font-size:12px;color:var(--text-secondary);margin-top:4px;text-align:right}.dashboard-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:30px}.dashboard-stat{background-color:var(--bg-card);padding:16px;border-radius:8px;border:1px solid var(--border);text-align:center}.dashboard-stat h3{font-size:28px;color:var(--accent);margin:0}.dashboard-stat p{color:var(--text-secondary);margin:0;font-size:14px}.search-container{margin-bottom:16px}.search-input{width:100%;padding:10px;border-radius:6px;background-color:#374151;border:1px solid #4B5563;color:var(--text-primary)}.table-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:24px}.pagination .btn{padding:6px 12px}.pagination span{color:var(--text-secondary);font-size:14px}.export-btn{background-color:#10B981;color:#fff}#statsChartContainer{margin-top:20px;position:relative;height:300px}</style></head><body><div class="container"><h1>Admin Dashboard</h1><div class="dashboard-grid" id="dashboardStats"></div><div id="statsChartContainer"><canvas id="statsChart"></canvas></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required><div class="label-note">Auto-converted to UTC.</div><div class="time-quick-set-group" data-target-date="expiryDate" data-target-time="expiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button></div></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" min="0" value="0" required><select id="dataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option><option value="KB">KB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedCreate">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="search-container"><input type="text" id="searchInput" class="search-input" placeholder="Search by UUID or Notes..."></div><div class="table-header"><button id="deleteSelected" class="btn btn-danger">Delete Selected</button><button id="exportUsers" class="btn export-btn">Export to CSV</button></div><div style="overflow-x:auto"><table><thead><tr><th><input type="checkbox" id="selectAll"></th><th>UUID</th><th>Created</th><th>Expiry</th><th>Tehran Time</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div><div class="pagination" id="pagination"></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="expiration_date" required></div><div class="form-group" style="margin-top:16px"><label for="editExpiryTime">Expiry Time (Local)</label><input type="time" id="editExpiryTime" name="expiration_time" step="1" required><div class="time-quick-set-group" data-target-date="editExpiryDate" data-target-time="editExpiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button></div></div><div class="form-group" style="margin-top:16px"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" min="0" required><select id="editDataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option><option value="KB">KB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedEdit">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group" style="margin-top:16px"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group" style="margin-top:16px"><label><input type="checkbox" id="resetTraffic" name="resetTraffic"> Reset Traffic Usage</label></div><div class="modal-footer"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>/* SCRIPT_PLACEHOLDER */</script></body></html>`;

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
    if (now - entry.timestamp > 60000) { // Reset every minute
        rateLimiter.set(ip, { count: 1, timestamp: now });
        return true;
    }
    entry.count++;
    rateLimiter.set(ip, entry);
    if (entry.count > 200) { // Limit to 200 requests per minute per IP
        log(`Rate limit exceeded for IP: ${ip}`, 'warn');
        return false;
    }
    return true;
}

async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };
    const htmlHeader = { 'Content-Type': 'text/html;charset=utf-8', ...CONST.securityHeaders };
    const ip = request.headers.get('CF-Connecting-IP');
    
    if (!checkRateLimit(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: jsonHeader });
    }

    if (!env.ADMIN_KEY) {
        log('Admin panel is not configured. ADMIN_KEY secret is missing.', 'error');
        return new Response('Admin panel is not configured.', { status: 503 });
    }

    if (pathname.startsWith('/admin/api/')) {
        if (!(await isAdmin(request, env))) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
        }

        if (request.method !== 'GET') {
            const receivedCsrfToken = request.headers.get('X-CSRF-Token');
            const storedCsrfToken = await env.USER_KV.get('csrf_token');
            if (!storedCsrfToken || receivedCsrfToken !== storedCsrfToken) {
                return new Response(JSON.stringify({ error: 'Invalid CSRF token' }), { status: 403, headers: jsonHeader });
            }
        }
        
        try {
            if (pathname === '/admin/api/stats' && request.method === 'GET') {
                return new Response(JSON.stringify(await fetchDashboardStats(env)), { status: 200, headers: jsonHeader });
            }

            if (pathname === '/admin/api/users') {
                if (request.method === 'GET') {
                    const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
                    return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
                }
                if (request.method === 'POST') {
                    const userData = await request.json();
                    console.log("Received data for user creation:", JSON.stringify(userData)); // Enhanced logging

                    const { uuid, expiration_date, expiration_time, data_limit, notes } = userData;
                    if (!isValidUUID(uuid) || !expiration_date || !expiration_time || data_limit === undefined) {
                         throw new Error('Server validation failed: Invalid or missing fields.');
                    }
                    
                    await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, data_limit, notes) VALUES (?, ?, ?, ?, ?)")
                        .bind(
                            String(uuid),
                            String(expiration_date),
                            String(expiration_time),
                            Number(data_limit ?? 0), // *** IMPROVEMENT: Explicit type casting for safety ***
                            notes ? String(notes) : null
                        ).run();
                        
                    return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
                }
            }

            if (pathname === '/admin/api/users/bulk-delete' && request.method === 'POST') {
                 const { uuids } = await request.json();
                 if (!Array.isArray(uuids) || uuids.length === 0) throw new Error('UUIDs array is required.');
                 const validUuids = uuids.filter(isValidUUID);
                 await env.DB.batch(validUuids.map(uuid => env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid)));
                 await Promise.all(validUuids.map(uuid => env.USER_KV.delete(`user:${uuid}`)));
                 return new Response(JSON.stringify({ success: true, count: validUuids.length }), { status: 200, headers: jsonHeader });
            }
            
            const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/);
            if (userRouteMatch) {
                const uuid = userRouteMatch[1];
                if (!isValidUUID(uuid)) return new Response(JSON.stringify({ error: 'Invalid UUID format' }), { status: 400, headers: jsonHeader });
                
                if (request.method === 'PUT') {
                    const { expiration_date, expiration_time, data_limit, notes, reset_traffic } = await request.json();
                    if (!expiration_date || !expiration_time || data_limit === undefined) throw new Error('Invalid or missing fields.');
                    
                    let query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ?" + (reset_traffic ? ", used_traffic = 0" : "") + " WHERE uuid = ?";
                    await env.DB.prepare(query).bind(
                        String(expiration_date), 
                        String(expiration_time), 
                        Number(data_limit ?? 0), // Explicit type casting
                        notes ? String(notes) : null, 
                        uuid
                    ).run();
                    
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

        // *** IMPROVEMENT: Greatly enhanced error catching and reporting ***
        } catch (error) {
            console.error(`Admin API Error Stack: ${error.stack}`); // Log the full error stack
            const errorMessage = error.message.includes('UNIQUE') ? 'A user with this UUID already exists.' : `Server Error: ${error.message}`;
            const errorCause = error.cause ? String(error.cause) : 'No additional cause information.';
            console.error(`Error Cause: ${errorCause}`); // D1 errors often have useful info in 'cause'
            return new Response(JSON.stringify({ error: errorMessage, cause: errorCause }), { status: 400, headers: jsonHeader });
        }
    }

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
                return new Response(null, { status: 302, headers: { 'Location': '/admin', 'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict` } });
            }
            return new Response(adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: htmlHeader });
        }
        if (request.method === 'GET') {
            if (await isAdmin(request, env)) {
                const csrfToken = await env.USER_KV.get('csrf_token') || crypto.randomUUID();
                const scriptString = `(${getAdminPanelScript.toString()})("${csrfToken}");`;
                const finalAdminPanelHTML = adminPanelHTML.replace('/* SCRIPT_PLACEHOLDER */', scriptString);
                return new Response(finalAdminPanelHTML, { headers: htmlHeader });
            }
            return new Response(adminLoginHTML, { headers: htmlHeader });
        }
        return new Response('Method Not Allowed', { status: 405 });
    }
    return new Response('Admin route not found.', { status: 404 });
}


// --- User Config Page & VLESS Logic ---

function getPageCSS() {
  return `*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:#2a2421;color:#e5dfd6;padding:1rem;line-height:1.5}.container{max-width:800px;margin:20px auto}.header{text-align:center;margin-bottom:2rem}h1{font-family:serif;font-weight:400;font-size:1.8rem}p{color:#b3a89d;font-size:.9rem}.config-card{background:#35302c;border-radius:12px;padding:20px;margin-bottom:1.5rem;border:1px solid #5a4f45}.config-title{font-family:serif;font-size:1.6rem;color:#d4b595;margin-bottom:1rem;padding-bottom:.8rem;border-bottom:1px solid #5a4f45}.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:.6rem 1rem;border-radius:12px;font-size:1rem;font-weight:500;cursor:pointer;border:1px solid #5a4f45;background-color:#413b35;color:#e5dfd6;text-decoration:none}.button:hover{background-color:#4d453e}.client-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem}.button.copied{background-color:#70b570!important;color:#2a2421!important}.footer{text-align:center;margin-top:2rem;color:#b3a89d;font-size:.8rem}.ip-info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1.5rem}.ip-info-section{background-color:#413b35;border-radius:12px;padding:1rem;border:1px solid #5a4f45}.ip-info-header h3{font-family:serif;font-size:1.2rem;color:#d4b595;margin-bottom:.5rem}.ip-info-item{margin-top:.5rem}.label{font-size:.8rem;color:#b3a89d}.value{font-size:.9rem}.skeleton{display:inline-block;background:linear-gradient(90deg, #413b35 25%, #35302c 50%, #413b35 75%);background-size:200% 100%;animation:loading 1.5s infinite;border-radius:4px;height:1em;width:70%}.country-flag{width:1.2em;vertical-align:middle;margin-right:.5em}@keyframes loading{0%{background-position:200% 0}100%{background-position:-200% 0}}.status-card{text-align:center}.status-title{font-family:serif;font-size:1.6rem;color:#d4b595;margin-bottom:.8rem}.relative-time{font-size:1.1rem;font-weight:500;margin-bottom:.8rem}.relative-time.active{color:#70b570}.relative-time.expired{color:#e05d44}.time-details{font-size:.9rem;color:#b3a89d}.time-details span{display:block;margin-top:.5rem}.traffic-text{font-family:monospace;font-size:1rem;margin-top:1rem}.progress-container{width:100%;max-width:400px;margin: .8rem auto;background-color:#413b35;border-radius:6px;height:12px;overflow:hidden;border:1px solid #5a4f45}.progress-bar{height:100%;background-color:#70b570;transition:width .5s ease}.progress-bar.warning{background-color:#e0bc44}.progress-bar.danger{background-color:#e05d44}`;
}

function getPageHTML(clientUrls, subXrayUrl, subSbUrl) {
  return `<div class="container"><div class="header"><h1>VLESS Configuration</h1><p>Your secure connection is ready.</p></div><div id="dynamic-content"></div><div class="config-card"><h2 class="config-title">Network Information</h2><div class="ip-info-grid"><div class="ip-info-section"><div class="ip-info-header"><h3>Proxy Server</h3></div><div class="ip-info-item"><span class="label">Host: </span><span class="value" id="proxy-host"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">Location: </span><span class="value" id="proxy-location"><span class="skeleton"></span></span></div></div><div class="ip-info-section"><div class="ip-info-header"><h3>Your Connection</h3></div><div class="ip-info-item"><span class="label">IP: </span><span class="value" id="client-ip"><span class="skeleton"></span></span></div><div class="ip-info-item"><span class="label">Location: </span><span class="value" id="client-location"><span class="skeleton"></span></span></div></div></div></div><div class="config-card"><h2 class="config-title">Subscription Links</h2><div class="client-buttons"><a href="${clientUrls.universalAndroid}" class="button">Android (v2rayNG)</a><a href="${clientUrls.shadowrocket}" class="button">iOS (Shadowrocket)</a><a href="${clientUrls.clashMeta}" class="button">Clash Meta / Stash</a><button class="button" onclick="copyToClipboard(this, '${subXrayUrl}')">Copy Xray/v2fly Link</button><button class="button" onclick="copyToClipboard(this, '${subSbUrl}')">Copy Sing-Box Link</button></div></div><div class="footer"><p>© ${new Date().getFullYear()} - Secure. Private. Fast.</p></div></div>`;
}

function getPageScript() {
  return `function copyToClipboard(button,text){navigator.clipboard.writeText(text).then(()=>{const t=button.innerHTML;button.innerHTML="Copied!",button.classList.add("copied"),setTimeout(()=>{button.innerHTML=t,button.classList.remove("copied")},1500)}).catch(t=>console.error("Failed to copy: ",t))}async function fetchIpInfo(t){try{const o=await fetch("https://ip-api.io/json/"+(t||""));return o.ok?await o.json():null}catch(t){return null}}function updateIpDisplay(t,o,n=null){n&&(document.getElementById(o+"-host").textContent=n);if(!t){document.getElementById(o+"-ip").textContent="N/A";document.getElementById(o+"-location").textContent="N/A";return}document.getElementById(o+"-ip").textContent=t.ip||"N/A";const e=document.getElementById(o+"-location");let l=[t.city,t.country_name].filter(Boolean).join(", ");t.country_code&&(l=\`<img src="https://flagcdn.com/w20/\${t.country_code.toLowerCase()}.png" class="country-flag"> \${l}\`),e.innerHTML=l||"N/A"}function displayExpiration(){const t=document.getElementById("expiration-display"),o=document.getElementById("expiration-relative");if(t&&t.dataset.utcTime){const n=new Date(t.dataset.utcTime);if(!isNaN(n.getTime())){const e=(n.getTime()-(new Date).getTime())/1e3,i=e<0;let a="";a=new Intl.RelativeTimeFormat("en",{numeric:"auto"}),a=Math.abs(e)<3600?a.format(Math.round(e/60),"minute"):Math.abs(e)<86400?a.format(Math.round(e/3600),"hour"):a.format(Math.round(e/86400),"day"),o&&(o.textContent=i?\`Expired \${a}\`:\`Expires \${a}\`,o.classList.add(i?"expired":"active")),t.innerHTML=\`<span><strong>Local:</strong> \${n.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"})}</span><span><strong>Tehran:</strong> \${n.toLocaleString("en-US",{timeZone:"Asia/Tehran",dateStyle:"medium",timeStyle:"short"})}</span>\`}}}document.addEventListener("DOMContentLoaded",async()=>{const t=document.body.getAttribute("data-proxy-ip"),[o]=t.split(":");updateIpDisplay(await fetchIpInfo(o),"proxy",t),updateIpDisplay(await fetchIpInfo(),"client"),displayExpiration()});`;
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime, dataLimit, usedTraffic) {
    const subXrayUrl = `https://${hostName}/xray/${userID}`;
    const subSbUrl = `https://${hostName}/sb/${userID}`;
    const clientUrls = {
        universalAndroid: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
        shadowrocket: `shadowrocket://add/sub?url=${encodeURIComponent(subXrayUrl)}&name=${encodeURIComponent(hostName)}`,
        clashMeta: `clash://install-config?url=${encodeURIComponent(`https://sub.bonds.dev/sub/clash?url=${encodeURIComponent(subSbUrl)}`)}`,
    };

    const utcTimestamp = (expDate && expTime) ? `${expDate}T${expTime.split('.')[0]}Z` : '';

    const formatBytes = (bytes) => {
        if (bytes === null || typeof bytes === 'undefined' || bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
    };

    const trafficPercent = dataLimit > 0 ? Math.min((usedTraffic / dataLimit) * 100, 100) : 0;
    const trafficText = dataLimit === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
    let progressBarClass = trafficPercent > 90 ? 'danger' : trafficPercent > 70 ? 'warning' : '';
    
    const dynamicContent = `<div class="config-card status-card"><h2 class="status-title">Subscription Status</h2><div id="expiration-relative" class="relative-time"></div><div id="expiration-display" class="time-details" data-utc-time="${utcTimestamp}"></div><div class="traffic-text">${trafficText}</div><div class="progress-container"><div class="progress-bar ${progressBarClass}" style="width: ${trafficPercent.toFixed(2)}%"></div></div></div>`;
    
    const baseHtml = getPageHTML(clientUrls, subXrayUrl, subSbUrl);
    const finalHtmlWithContent = baseHtml.replace('<div id="dynamic-content"></div>', dynamicContent);

    return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>VLESS Proxy Configuration</title><link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png"><style>${getPageCSS()}</style></head><body data-proxy-ip="${proxyAddress}">${finalHtmlWithContent}<script>${getPageScript()}</script></body></html>`;
}

function generateRandomPath(length = 12, query = '') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
    xray: { tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1' } },
    sb: { tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: { ed: 2560 } } },
};

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
    const params = new URLSearchParams({ type: 'ws', host, path, security, sni, fp, alpn });
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildLink({ core, userID, hostName, address, port, tag }) {
    const p = CORE_PRESETS[core].tls;
    return createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `${tag}-TLS` });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function handleIpSubscription(core, userID, hostName) {
    const mainDomains = [hostName, 'creativecommons.org', 'www.speedtest.net'];
    const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
    let links = mainDomains.map((domain, i) => buildLink({ core, userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i + 1}` }));
    try {
        const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
        if (r.ok) {
            const { ipv4 = [] } = await r.json();
            links.push(...ipv4.slice(0, 10).map((ip, i) => buildLink({ core, userID, hostName, address: ip.ip, port: pick(httpsPorts), tag: `IP${i + 1}` })));
        }
    } catch (e) { console.error('Fetch IP list failed', e); }
    return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

async function vlessOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let connectionState = { uuid: '', remoteSocket: null, incoming: 0, outgoing: 0, closed: false };
    
    function closeConnection() {
        if (connectionState.closed) return;
        connectionState.closed = true;
        if (connectionState.uuid && (connectionState.incoming > 0 || connectionState.outgoing > 0)) {
            ctx.waitUntil(updateUsedTraffic(env, connectionState.uuid, connectionState.incoming + connectionState.outgoing));
        }
        if (connectionState.remoteSocket) {
            try { connectionState.remoteSocket.close(); } catch(e) {}
        }
        safeCloseWebSocket(webSocket);
    }
    
    const earlyData = base64ToArrayBuffer(request.headers.get('Sec-WebSocket-Protocol') || '');

    const readableWebSocketStream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => {
                const data = event.data;
                connectionState.outgoing += data.byteLength;
                controller.enqueue(data);
            });
            webSocket.addEventListener('close', () => {
                closeConnection();
                try { controller.close(); } catch(e){}
            });
            webSocket.addEventListener('error', err => {
                log(`WebSocket error: ${err.message}`, 'error');
                controller.error(err);
            });
            if (earlyData) {
                connectionState.outgoing += earlyData.byteLength;
                controller.enqueue(earlyData);
            }
        }
    });

    readableWebSocketStream.pipeTo(
        new WritableStream({
            async write(chunk, controller) {
                if (connectionState.remoteSocket) {
                    try {
                        const writer = connectionState.remoteSocket.writable.getWriter();
                        await writer.write(chunk);
                        writer.releaseLock();
                        return;
                    } catch (err) {
                        log(`Error writing to remote socket: ${err.message}`, 'error');
                        controller.error(err);
                        closeConnection();
                    }
                }

                try {
                    const { uuid, address, port, rawDataIndex } = await processVlessHeader(chunk, env);
                    connectionState.uuid = uuid;
                    
                    const remoteSocket = await connect({ hostname: address, port });
                    connectionState.remoteSocket = remoteSocket;

                    const writer = remoteSocket.writable.getWriter();
                    await writer.write(chunk.slice(rawDataIndex));
                    writer.releaseLock();

                    let vlessResponseSent = false;
                    remoteSocket.readable.pipeTo(
                        new WritableStream({
                            write: data => {
                                if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN) return;
                                if (!vlessResponseSent) {
                                    const vlessResponse = new Uint8Array([0, 0]);
                                    const combinedChunk = new Uint8Array(vlessResponse.length + data.length);
                                    combinedChunk.set(vlessResponse);
                                    combinedChunk.set(data, vlessResponse.length);
                                    connectionState.incoming += combinedChunk.byteLength;
                                    webSocket.send(combinedChunk);
                                    vlessResponseSent = true;
                                } else {
                                    connectionState.incoming += data.byteLength;
                                    webSocket.send(data);
                                }
                            },
                            close: () => log(`Remote socket readable closed for ${uuid}`),
                            abort: (err) => log(`Remote socket readable aborted for ${uuid}: ${err.message}`, 'error')
                        })
                    ).catch(err => {
                        log(`Remote socket pipe failed for ${uuid}: ${err.message}`, 'error');
                        closeConnection();
                    });
                } catch(err) {
                    log(`VLESS processing error: ${err.message}`, 'error');
                    controller.error(err);
                    closeConnection();
                }
            },
            abort: (err) => {
                log(`Main pipeline aborted: ${err.message}`, 'error');
                closeConnection();
            },
            close: () => {
                log('Main pipeline closed.');
                closeConnection();
            }
        })
    ).catch(err => {
        log(`Unhandled pipeline failure: ${err.message}`, 'error');
        closeConnection();
    });

    return new Response(null, { status: 101, webSocket: client });
}


async function processVlessHeader(vlessBuffer, env) {
    if (vlessBuffer.byteLength < 24) throw new Error('Invalid VLESS header: too short');
    const view = new DataView(vlessBuffer);
    if (view.getUint8(0) !== 0) throw new Error(`Invalid VLESS version: ${view.getUint8(0)}`);
    const uuid = unsafeStringify(new Uint8Array(vlessBuffer.slice(1, 17)));
    
    const userData = await getUserData(env, uuid);
    if (!isUserValid(userData)) {
        throw new Error(`User validation failed for ${uuid}. User might be expired or over traffic limit.`);
    }

    const optLen = view.getUint8(17);
    const command = view.getUint8(18 + optLen);
    if(command === 2) throw new Error('UDP is not supported.');
    if(command !== 1) throw new Error(`Unsupported command: ${command}`);

    const port = view.getUint16(19 + optLen);
    let addressIndex = 21 + optLen;
    const addressType = view.getUint8(addressIndex++);
    let address = '';
    
    if (addressType === 1) {
        address = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 4)).join('.');
        addressIndex += 4;
    } else if (addressType === 2) {
        const domainLen = view.getUint8(addressIndex++);
        address = new TextDecoder().decode(vlessBuffer.slice(addressIndex, addressIndex + domainLen));
        addressIndex += domainLen;
    } else if (addressType === 3) {
        const ipv6 = new DataView(vlessBuffer.buffer, vlessBuffer.byteOffset + addressIndex, 16);
        address = Array.from({ length: 8 }, (_, i) => ipv6.getUint16(i * 2).toString(16)).join(':');
        addressIndex += 16;
    } else {
        throw new Error(`Unsupported address type: ${addressType}`);
    }

    return { uuid, address, port, rawDataIndex: addressIndex };
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return null;
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
        if (socket.readyState === CONST.WS_READY_STATE_OPEN) socket.close(1000, "Closing");
    } catch (error) {
        log(`Error closing WebSocket: ${error}`, 'warn');
    }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr) {
    return (byteToHex[arr[0]]+byteToHex[arr[1]]+byteToHex[arr[2]]+byteToHex[arr[3]]+'-'+byteToHex[arr[4]]+byteToHex[arr[5]]+'-'+byteToHex[arr[6]]+byteToHex[arr[7]]+'-'+byteToHex[arr[8]]+byteToHex[arr[9]]+'-'+byteToHex[arr[10]]+byteToHex[arr[11]]+byteToHex[arr[12]]+byteToHex[arr[13]]+byteToHex[arr[14]]+byteToHex[arr[15]]).toLowerCase();
}

// --- Main Router ---

export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);

            if (url.pathname.startsWith('/admin')) {
                return handleAdminRequest(request, env);
            }

            if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
                return await vlessOverWSHandler(request, env, ctx);
            }

            const handleSubscription = async (core) => {
                const uuid = url.pathname.slice(`/${core}/`.length);
                const userData = await getUserData(env, uuid);
                if (!isUserValid(userData)) {
                    return new Response('Invalid or expired user', { status: 403 });
                }
                return handleIpSubscription(core, uuid, url.hostname);
            };

            if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
            if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

            const path = url.pathname.slice(1);
            if (isValidUUID(path)) {
                const userData = await getUserData(env, path);
                if (!isUserValid(userData)) {
                    return new Response('Invalid or expired user', { status: 403 });
                }
                const html = generateBeautifulConfigPage(path, url.hostname, Config.fromEnv(env).proxyAddress, userData.expiration_date, userData.expiration_time, userData.data_limit, userData.used_traffic);
                return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CONST.securityHeaders } });
            }

            if (env.ROOT_PROXY_URL && url.pathname === '/') {
                try {
                    const proxyUrl = new URL(env.ROOT_PROXY_URL);
                    let newRequest = new Request(proxyUrl, request);
                    newRequest.headers.set('Host', proxyUrl.hostname);
                    return fetch(newRequest);
                } catch (e) {
                    return new Response(`ROOT_PROXY_URL is not a valid URL: ${e.message}`, { status: 500 });
                }
            }

            return new Response('Not Found', { status: 404 });
        } catch (err) {
            log(`Global fetch error: ${err.stack}`, 'error');
            return new Response('Internal Server Error', { status: 500 });
        }
    },
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(cleanupExpiredUsers(env));
    },
};
