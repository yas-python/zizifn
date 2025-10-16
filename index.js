/**
 * Cloudflare Worker VLESS - Ultimate Edition
 *
 * @version 3.0.0
 * @description This script combines a feature-rich admin panel with traffic management and
 * a beautiful, professional user configuration page. It leverages Cloudflare D1 for persistent
 * user data, KV for caching sessions, and provides a robust VLESS-over-WebSocket proxy.
 *
 * --- SETUP INSTRUCTIONS ---
 * 1. D1 Database: Create a D1 database and run the schema below.
 * [[d1_databases]]
 * binding = "DB"
 * database_name = "your-db-name"
 * database_id = "your-db-id"
 *
 * 2. D1 Table Schema (Execute this in your D1 console):
 * CREATE TABLE users (
 * uuid TEXT PRIMARY KEY,
 * expiration_date TEXT NOT NULL,
 * expiration_time TEXT NOT NULL,
 * data_limit INTEGER DEFAULT 0, -- Data limit in bytes, 0 for unlimited
 * used_traffic INTEGER DEFAULT 0, -- Used traffic in bytes
 * notes TEXT,
 * created_at TEXT DEFAULT CURRENT_TIMESTAMP
 * );
 *
 * 3. KV Namespace: Create a KV namespace for caching and session management.
 * [[kv_namespaces]]
 * binding = "USER_KV"
 * id = "your-kv-namespace-id"
 *
 * 4. Secrets (Set in Worker settings):
 * - ADMIN_KEY: A strong password for the admin panel.
 * - PROXYIP (Optional): A specific clean IP for proxying configs.
 * - ROOT_PROXY_URL (Optional): URL to reverse proxy on the root path.
 */

import { connect } from 'cloudflare:sockets';

// --- Configuration & Constants ---

const Config = {
    proxyIPs: [''], // Can be populated from env if needed
    fromEnv(env) {
        const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
        return { proxyAddress: selectedProxyIP };
    },
};

const CONST = {
    VLESS_VERSION: new Uint8Array([0]),
    WS_READY_STATE_OPEN: 1,
    // Added for enhanced security on all HTML responses
    securityHeaders: {
        'Content-Security-Policy': "default-src 'self' https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com https://flagcdn.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self';",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
    }
};

// --- Core Helper Functions ---

/**
 * Custom log function for better debugging and monitoring.
 * @param {string} message The log message.
 * @param {string} [level='info'] The log level ('info', 'warn', 'error').
 */
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

/**
 * Validates if a string is a standard RFC4122 UUID.
 * @param {string} uuid The string to validate.
 * @returns {boolean} True if the string is a valid UUID.
 */
function isValidUUID(uuid) {
    if (typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

/**
 * Checks if a user's subscription is active based on their expiration date and time.
 * @param {string} expDate Expiration date in 'YYYY-MM-DD' format.
 * @param {string} expTime Expiration time in 'HH:MM:SS' format.
 * @returns {boolean} True if the subscription is not expired.
 */
function isTimeValid(expDate, expTime) {
  if (!expDate || !expTime) return false;
  const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
  return expDatetimeUTC > new Date() && !isNaN(expDatetimeUTC);
}

/**
 * A comprehensive check to see if a user is active and ready for connection.
 * @param {object | null} userData The user's data object.
 * @returns {boolean} True if user exists and is valid (time & data limit).
 */
function isUserValid(userData) {
    if (!userData) return false;
    const timeOK = isTimeValid(userData.exp_date, userData.exp_time);
    const trafficOK = (userData.data_limit === 0) || ((userData.used_traffic || 0) < userData.data_limit);
    return timeOK && trafficOK;
}


/**
 * Fetches user data, using KV as a cache for performance.
 * @param {object} env The worker environment.
 * @param {string} uuid The user's UUID.
 * @returns {Promise<object|null>} The user data object or null if not found.
 */
async function getUserData(env, uuid) {
  if (!isValidUUID(uuid)) return null;

  const cacheKey = `user:${uuid}`;
  let userData = await env.USER_KV.get(cacheKey, 'json');
  if (userData) {
      return userData;
  }

  try {
    const query = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
    if (!query) {
      return null;
    }
    // Ensure numeric fields are numbers
    query.data_limit = Number(query.data_limit || 0);
    query.used_traffic = Number(query.used_traffic || 0);

    // Cache for 1 hour for active users, 5 mins for expired ones to reduce DB load
    const isStillValid = isUserValid(query);
    const expirationTtl = isStillValid ? 3600 : 300;
    await env.USER_KV.put(cacheKey, JSON.stringify(query), { expirationTtl });
    return query;
  } catch (e) {
      log(`Database error fetching user ${uuid}: ${e.message}`, 'error');
      return null;
  }
}

/**
 * Updates a user's traffic usage in D1 and invalidates the KV cache.
 * @param {object} env The worker environment.
 * @param {string} uuid The user's UUID.
 * @param {number} additionalTraffic The amount of traffic to add in bytes.
 */
async function updateUsedTraffic(env, uuid, additionalTraffic) {
  if (additionalTraffic <= 0 || !isValidUUID(uuid)) return;
  try {
    await env.DB.prepare("UPDATE users SET used_traffic = used_traffic + ? WHERE uuid = ?")
      .bind(additionalTraffic, uuid)
      .run();
    await env.USER_KV.delete(`user:${uuid}`);
    log(`Updated traffic for ${uuid} by ${additionalTraffic} bytes.`);
  } catch (error) {
    log(`Failed to update traffic for ${uuid}: ${error.message}`, 'error');
  }
}

/**
 * Fetches statistics for the admin dashboard.
 * @param {object} env The worker environment.
 * @returns {Promise<object>} An object containing dashboard stats.
 */
async function fetchDashboardStats(env) {
    // This query is more efficient as it calculates active/expired in one go.
    const query = `
        SELECT
            COUNT(*) as totalUsers,
            SUM(CASE WHEN (expiration_date > date('now') OR (expiration_date = date('now') AND expiration_time > time('now'))) AND (data_limit = 0 OR used_traffic < data_limit) THEN 1 ELSE 0 END) as activeUsers,
            SUM(used_traffic) as totalTraffic
        FROM users
    `;
    const stats = await env.DB.prepare(query).first();

    return {
        totalUsers: Number(stats.totalUsers || 0),
        activeUsers: Number(stats.activeUsers || 0),
        expiredUsers: Number(stats.totalUsers || 0) - Number(stats.activeUsers || 0),
        totalTraffic: Number(stats.totalTraffic || 0)
    };
}


/**
 * Scheduled task to clean up old, expired users from the database.
 * @param {object} env The worker environment.
 */
async function cleanupExpiredUsers(env) {
    log('Starting scheduled cleanup of expired users...');
    try {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        const dateString = oneMonthAgo.toISOString().split('T')[0];

        const stmt = env.DB.prepare("DELETE FROM users WHERE expiration_date < ?");
        const { count } = await stmt.bind(dateString).run();

        if (count > 0) {
            log(`Successfully pruned ${count} old expired users.`);
        } else {
            log('No old expired users to prune.');
        }
    } catch (e) {
        log(`Scheduled cleanup failed: ${e.message}`, 'error');
    }
}


// --- Admin Panel Logic (From Script 2, Enhanced) ---

const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#121212;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1e1e1e;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #333}h1{color:#fff;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#2c2c2c;border:1px solid #444;color:#fff;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px}input[type=password]:focus{outline:0;border-color:#007aff;box-shadow:0 0 0 2px rgba(0,122,255,.3)}button{background-color:#007aff;color:#fff;border:0;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#005ecb}.error{color:#ff3b30;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST" action="/admin"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;

function getAdminPanelScript() {
    // This function will be stringified and injected into the admin panel HTML.
    // All code must be self-contained within this function.
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
        const dashboardStats = document.getElementById('dashboardStats');
        const pagination = document.getElementById('pagination');
        let currentPage = 1;
        const pageSize = 10;
        let searchDebounceTimer;
        let chartInstance = null;
        let csrfToken = "CSRF_TOKEN_PLACEHOLDER"; // This will be replaced by the server

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

        function formatExpiryDateTime(expDateStr, expTimeStr) {
            const expiryUTC = new Date(`${expDateStr}T${expTimeStr}Z`);
            if (isNaN(expiryUTC)) return { local: 'Invalid Date', utc: '', relative: '', tehran: '', isExpired: true };
            const now = new Date();
            const isExpired = expiryUTC < now;
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
                isExpired: isExpired
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
                const isExpiredByTime = expiry.isExpired;
                const dataLimit = user.data_limit || 0;
                const usedTraffic = user.used_traffic || 0;
                const isExpiredByData = dataLimit > 0 && usedTraffic >= dataLimit;
                const isExpired = isExpiredByTime || isExpiredByData;

                const trafficText = dataLimit === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
                const progressPercent = dataLimit === 0 ? 0 : Math.min((usedTraffic / dataLimit) * 100, 100);
                let progressClass = '';
                if (progressPercent > 90) progressClass = 'danger';
                else if (progressPercent > 70) progressClass = 'warning';
                
                const row = document.createElement('tr');
                row.dataset.uuid = user.uuid;
                row.innerHTML = `<td><input type="checkbox" class="userSelect" data-uuid="${user.uuid}"></td><td title="${user.uuid}">${user.uuid.substring(0, 8)}...</td><td>${new Date(user.created_at).toLocaleString()}</td><td title="${expiry.local}">${expiry.relative}</td><td title="Local Time: ${expiry.local}">${expiry.tehran}</td><td><span class="status-badge ${isExpired ? 'status-expired' : 'status-active'}">${isExpired ? 'Expired' : 'Active'}</span></td><td><div class="progress-bar-container"><div class="progress-bar ${progressClass}" style="width: ${progressPercent}%"></div></div><div class="traffic-text">${trafficText}</div></td><td title="${user.notes || ''}">${(user.notes || '-').substring(0, 20)}</td><td><div class="actions-cell"><button class="btn btn-secondary btn-edit" data-uuid="${user.uuid}">Edit</button><button class="btn btn-danger btn-delete" data-uuid="${user.uuid}">Delete</button></div></td>`;
                userList.appendChild(row);
            });
        }

        function updateView() {
            renderUsers();
            renderPagination();
        }

        async function fetchAndRenderAll() {
            try {
                const [users, stats] = await Promise.all([api.get('/users'), api.get('/stats')]);
                allUsers = users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                currentUsers = allUsers;
                currentPage = 1;
                handleSearch(true); // Apply current search term if any
                renderDashboardStats(stats);
            } catch (error) {
                showToast(error.message, true);
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

        function handleSearch(immediate = false) {
            const applyFilter = () => {
                const searchTerm = searchInput.value.toLowerCase();
                currentUsers = searchTerm ? allUsers.filter(user => user.uuid.toLowerCase().includes(searchTerm) || (user.notes || '').toLowerCase().includes(searchTerm)) : allUsers;
                currentPage = 1;
                updateView();
            };

            clearTimeout(searchDebounceTimer);
            if (immediate) {
                applyFilter();
            } else {
                searchDebounceTimer = setTimeout(applyFilter, 300);
            }
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

        // Event Listeners
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
        document.getElementById('selectAll').addEventListener('change', (e) => document.querySelectorAll('.userSelect').forEach(cb => cb.checked = e.target.checked));
        deleteSelectedBtn.addEventListener('click', handleBulkDelete);
        searchInput.addEventListener('input', () => handleSearch(false));
        document.getElementById('setUnlimitedCreate').addEventListener('click', () => setUnlimited(false));
        document.getElementById('setUnlimitedEdit').addEventListener('click', () => setUnlimited(true));
        document.getElementById('exportUsers').addEventListener('click', exportToCSV);

        // Initial Load
        setDefaultExpiry();
        uuidInput.value = crypto.randomUUID();
        fetchAndRenderAll();
        setInterval(fetchAndRenderAll, 60000); // Auto-refresh every 60 seconds
    });
}

const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>:root{--bg-main:#111827;--bg-card:#1F2937;--border:#374151;--text-primary:#F9FAFB;--text-secondary:#9CA3AF;--accent:#3B82F6;--accent-hover:#2563EB;--danger:#EF4444;--danger-hover:#DC2626;--success:#22C55E;--expired:#F59E0B;--btn-secondary-bg:#4B5563}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1200px;margin:40px auto;padding:0 20px}h1,h2{font-weight:600}h1{font-size:24px;margin-bottom:20px}h2{font-size:18px;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:20px}.card{background-color:var(--bg-card);border-radius:8px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 6px rgba(0,0,0,.1)}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}.form-group label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.form-group .input-group{display:flex}input[type=text],input[type=date],input[type=time],input[type=number],select{width:100%;box-sizing:border-box;background-color:#374151;border:1px solid #4B5563;color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s}input:focus{outline:0;border-color:var(--accent)}.label-note{font-size:11px;color:var(--text-secondary);margin-top:4px}.btn{padding:10px 16px;border:0;border-radius:6px;font-weight:600;cursor:pointer;transition:background-color .2s,transform .1s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.98)}.btn-primary{background-color:var(--accent);color:#fff}.btn-primary:hover{background-color:var(--accent-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:#6B7280}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.input-group .btn-secondary{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input{border-top-right-radius:0;border-bottom-right-radius:0;border-right:0}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase;white-space:nowrap}td{color:var(--text-primary);font-family:"SF Mono","Fira Code",monospace;vertical-align:middle}.status-badge{padding:4px 8px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:var(--success);color:#064E3B}.status-expired{background-color:var(--expired);color:#78350F}.actions-cell .btn{padding:6px 10px;font-size:12px}#toast{position:fixed;top:20px;right:20px;background-color:var(--bg-card);color:#fff;padding:15px 20px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .3s,transform .3s;transform:translateY(-20px)}#toast.show{display:block;opacity:1;transform:translateY(0)}#toast.error{border-left:5px solid var(--danger)}#toast.success{border-left:5px solid var(--success)}.actions-cell{display:flex;gap:8px;justify-content:flex-start}.time-display{display:flex;flex-direction:column;gap:2px}.time-local{font-weight:600}.time-utc,.time-relative{font-size:11px;color:var(--text-secondary)}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;box-shadow:0 5px 25px rgba(0,0,0,.4);width:90%;max-width:500px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:15px;margin-bottom:20px}.modal-header h2{margin:0;border:0;font-size:20px}.modal-close-btn{background:0 0;border:0;color:var(--text-secondary);font-size:24px;cursor:pointer;line-height:1}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.time-quick-set-group,.data-quick-set-group{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.btn-outline-secondary{background-color:transparent;border:1px solid var(--btn-secondary-bg);color:var(--text-secondary);padding:6px 10px;font-size:12px;font-weight:500}.btn-outline-secondary:hover{background-color:var(--btn-secondary-bg);color:#fff;border-color:var(--btn-secondary-bg)}.progress-bar-container{width:100%;background-color:#374151;border-radius:4px;height:8px;overflow:hidden;margin-top:4px}.progress-bar{height:100%;background-color:var(--success);transition:width .3s ease}.progress-bar.warning{background-color:var(--expired)}.progress-bar.danger{background-color:var(--danger)}.traffic-text{font-size:12px;color:var(--text-secondary);margin-top:4px;text-align:right}.dashboard-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:30px}.dashboard-stat{background-color:var(--bg-card);padding:16px;border-radius:8px;border:1px solid var(--border);text-align:center}.dashboard-stat h3{font-size:28px;color:var(--accent);margin:0}.dashboard-stat p{color:var(--text-secondary);margin:0;font-size:14px}.search-container{margin-bottom:16px}.search-input{width:100%;padding:10px;border-radius:6px;background-color:#374151;border:1px solid #4B5563;color:var(--text-primary)}.table-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:24px}.pagination .btn{padding:6px 12px}.pagination span{color:var(--text-secondary);font-size:14px}.export-btn{background-color:#10B981;color:#fff}#statsChartContainer{margin-top:20px;position:relative;height:300px}</style></head><body><div class="container"><h1>Admin Dashboard</h1><div class="dashboard-grid" id="dashboardStats"></div><div id="statsChartContainer"><canvas id="statsChart"></canvas></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required><div class="label-note">Auto-converted to UTC.</div><div class="time-quick-set-group" data-target-date="expiryDate" data-target-time="expiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button></div></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" min="0" value="0" required><select id="dataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedCreate">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="search-container"><input type="text" id="searchInput" class="search-input" placeholder="Search by UUID or Notes..."></div><div class="table-header"><button id="deleteSelected" class="btn btn-danger">Delete Selected</button><button id="exportUsers" class="btn export-btn">Export to CSV</button></div><div style="overflow-x:auto"><table><thead><tr><th><input type="checkbox" id="selectAll"></th><th>UUID</th><th>Created</th><th>Expiry</th><th>Tehran Time</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div><div class="pagination" id="pagination"></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div><div class="form-group" style="margin-top:16px"><label for="editExpiryTime">Expiry Time (Local)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required><div class="time-quick-set-group" data-target-date="editExpiryDate" data-target-time="editExpiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button></div></div><div class="form-group" style="margin-top:16px"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" min="0" required><select id="editDataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedEdit">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group" style="margin-top:16px"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group" style="margin-top:16px"><label><input type="checkbox" id="resetTraffic" name="resetTraffic"> Reset Traffic Usage</label></div><div class="modal-footer"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>/* SCRIPT_PLACEHOLDER */</script></body></html>`;

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
    if (now - entry.timestamp > 60000) { // 1 minute window
        entry.count = 0;
        entry.timestamp = now;
    }
    entry.count++;
    rateLimiter.set(ip, entry);
    if (entry.count > 200) { // 200 req/min limit
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
            const origin = request.headers.get('Origin');
            if (!origin || new URL(origin).hostname !== url.hostname) {
                return new Response(JSON.stringify({ error: 'Invalid Origin' }), { status: 403, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/stats' && request.method === 'GET') {
            try {
                const stats = await fetchDashboardStats(env);
                return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
            } catch (e) {
                log(`Error fetching stats: ${e.message}`, 'error');
                return new Response(JSON.stringify({ error: 'Failed to fetch dashboard stats.' }), { status: 500, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/users' && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, data_limit, used_traffic, notes FROM users ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
            } catch (e) {
                log(`Error fetching users: ${e.message}`, 'error');
                return new Response(JSON.stringify({ error: 'Failed to fetch users.' }), { status: 500, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/users' && request.method === 'POST') {
            try {
                const { uuid, exp_date: expDate, exp_time: expTime, data_limit, notes } = await request.json();
                if (!isValidUUID(uuid) || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid or missing fields. Use a valid UUID, YYYY-MM-DD, and HH:MM:SS.');
                }
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, data_limit, used_traffic, notes) VALUES (?, ?, ?, ?, 0, ?)")
                    .bind(uuid, expDate, expTime, data_limit || 0, notes || null).run();
                await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            } catch (error) {
                log(`Error creating user: ${error.message}`, 'error');
                const errorMessage = error.message.includes('UNIQUE') ? 'A user with this UUID already exists.' : error.message;
                return new Response(JSON.stringify({ error: errorMessage }), { status: 400, headers: jsonHeader });
            }
        }

        if (pathname === '/admin/api/users/bulk-delete' && request.method === 'POST') {
            try {
                const { uuids } = await request.json();
                if (!Array.isArray(uuids) || uuids.length === 0) throw new Error('UUIDs array is required.');
                const validUuids = uuids.filter(isValidUUID);
                await env.DB.batch(validUuids.map(uuid => env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid)));
                await Promise.all(validUuids.map(uuid => env.USER_KV.delete(`user:${uuid}`)));
                return new Response(JSON.stringify({ success: true, count: validUuids.length }), { status: 200, headers: jsonHeader });
            } catch (error) {
                log(`Error bulk deleting users: ${error.message}`, 'error');
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }

        const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/);

        if (userRouteMatch && request.method === 'PUT') {
            const uuid = userRouteMatch[1];
            if (!isValidUUID(uuid)) return new Response(JSON.stringify({ error: 'Invalid UUID format' }), { status: 400, headers: jsonHeader });
            try {
                const { exp_date: expDate, exp_time: expTime, data_limit, notes, reset_traffic } = await request.json();
                if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid date/time fields.');
                }
                
                let query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ?";
                const params = [expDate, expTime, data_limit ?? 0, notes || null];

                if (reset_traffic) {
                    query += ", used_traffic = 0";
                }
                query += " WHERE uuid = ?";
                params.push(uuid);

                await env.DB.prepare(query).bind(...params).run();
                await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
                return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
            } catch (error) {
                log(`Error updating user ${uuid}: ${error.message}`, 'error');
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }

        if (userRouteMatch && request.method === 'DELETE') {
            const uuid = userRouteMatch[1];
             if (!isValidUUID(uuid)) return new Response(JSON.stringify({ error: 'Invalid UUID format' }), { status: 400, headers: jsonHeader });
            try {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete(`user:${uuid}`);
                return new Response(null, { status: 204 });
            } catch (error) {
                log(`Error deleting user ${uuid}: ${error.message}`, 'error');
                return new Response(JSON.stringify({ error: 'Failed to delete user.' }), { status: 500, headers: jsonHeader });
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
                await Promise.all([
                    env.USER_KV.put('admin_session_token', sessionToken, { expirationTtl: 86400 }), // 24 hours
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
    return new Response('Admin route not found.', { status: 404 });
}


// --- User Config Page Logic (From Script 1, Enhanced with Traffic Data) ---

function getPageCSS() {
  return `
      * { margin: 0; padding: 0; box-sizing: border-box; }
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
        --border-radius: 12px; --transition-speed-medium: 0.3s;
        --status-success: #70b570; --status-error: #e05d44; --status-warning: #e0bc44; --status-info: #4f90c4;
        --serif: "Aldine 401 BT Web", "Times New Roman", Times, Georgia, ui-serif, serif;
        --sans-serif: "Styrene B LC", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "Noto Color Emoji", sans-serif;
        --mono-serif: "Fira Code", Cantarell, "Courier Prime", monospace;
      }
      body {
        font-family: var(--sans-serif); font-size: 16px; background-color: var(--background-primary);
        color: var(--text-primary); padding: 3rem; line-height: 1.5;
      }
      .container { max-width: 800px; margin: 20px auto; }
      .header { text-align: center; margin-bottom: 30px; }
      .header h1 { font-family: var(--serif); font-weight: 400; font-size: 1.8rem; margin-bottom: 2px; }
      .header p { color: var(--text-secondary); font-size: 0.8rem; }
      .config-card { background: var(--background-secondary); border-radius: var(--border-radius); padding: 20px; margin-bottom: 24px; border: 1px solid var(--border-color); }
      .config-title { font-family: var(--serif); font-size: 1.6rem; color: var(--accent-secondary); margin-bottom: 16px; padding-bottom: 13px; border-bottom: 1px solid var(--border-color); }
      .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border-radius: var(--border-radius); font-size: 15px; font-weight: 500; cursor: pointer; border: 1px solid var(--border-color); background-color: var(--background-tertiary); color: var(--button-text-secondary); text-decoration: none; }
      .button:hover { background-color: #4d453e; }
      .copy-buttons { gap: 4px; font-size: 13px; }
      .client-buttons-container { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }
      .client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
      .client-btn { width: 100%; background-color: var(--accent-primary); color: var(--background-tertiary); border-color: var(--accent-primary-darker); }
      .client-btn:hover { background-color: var(--accent-secondary); color: var(--button-text-primary); }
      .button.copied { background-color: var(--status-success) !important; color: var(--background-tertiary) !important; }
      .footer { text-align: center; margin-top: 40px; color: var(--text-secondary); font-size: 12px; }
      .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 24px; }
      .ip-info-section { background-color: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; border: 1px solid var(--border-color); }
      .ip-info-header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; margin-bottom: 10px;}
      .ip-info-header h3 { font-family: var(--serif); font-size: 18px; color: var(--accent-secondary); margin: 0; }
      .ip-info-item { display: flex; flex-direction: column; gap: 2px; }
      .ip-info-item .label { font-size: 11px; color: var(--text-secondary); }
      .ip-info-item .value { font-size: 14px; }
      .skeleton { display: block; background: linear-gradient(90deg, var(--background-tertiary) 25%, var(--background-secondary) 50%, var(--background-tertiary) 75%); background-size: 200% 100%; animation: loading 1.5s infinite; border-radius: 4px; height: 16px; }
      @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      .country-flag { display: inline-block; width: 18px; vertical-align: middle; margin-right: 6px; }
      .expiration-card, .traffic-card { padding: 20px; text-align: center; }
      .expiration-title, .traffic-title { font-family: var(--serif); font-size: 1.6rem; color: var(--accent-secondary); margin-bottom: 12px; }
      .expiration-relative-time { font-size: 1.1rem; font-weight: 500; margin-bottom: 12px; }
      .expiration-relative-time.active { color: var(--status-success); }
      .expiration-relative-time.expired { color: var(--status-error); }
      #expiration-display { font-size: 0.9em; color: var(--text-secondary); }
      #expiration-display span { display: block; margin-top: 8px; }
      .traffic-text { font-family: var(--mono-serif); font-size: 1rem; color: var(--text-primary); margin-bottom: 12px; }
      .progress-container { width: 100%; max-width: 400px; margin: 0 auto; background-color: var(--background-tertiary); border-radius: 6px; height: 12px; overflow: hidden; border: 1px solid var(--border-color); }
      .progress-bar { height: 100%; background-color: var(--status-success); transition: width 0.5s ease; }
      .progress-bar.warning { background-color: var(--status-warning); }
      .progress-bar.danger { background-color: var(--status-error); }
      @media (max-width: 768px) { body { padding: 20px; } }
  `;
}

function getPageHTML(clientUrls, subXrayUrl, subSbUrl) {
  return `
    <div class="container">
      <div class="header">
        <h1>VLESS Proxy Configuration</h1>
        <p>Copy the configuration or import directly into your client</p>
      </div>
      
      <div id="dynamic-content"></div>

      <div class="config-card">
        <div class="config-title">Network Information</div>
        <div class="ip-info-grid">
          <div class="ip-info-section">
            <div class="ip-info-header"><h3>Proxy Server</h3></div>
            <div class="ip-info-item"><span class="label">Host</span><span class="value" id="proxy-host"><span class="skeleton" style="width: 150px"></span></span></div>
            <div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton" style="width: 100px"></span></span></div>
          </div>
          <div class="ip-info-section">
            <div class="ip-info-header"><h3>Your Connection</h3></div>
            <div class="ip-info-item"><span class="label">IP</span><span class="value" id="client-ip"><span class="skeleton" style="width: 110px"></span></span></div>
            <div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton" style="width: 90px"></span></span></div>
          </div>
        </div>
      </div>

      <div class="config-card">
        <div class="config-title">Xray Subscription</div>
        <div class="client-buttons-container">
            <div class="client-buttons">
                <a href="${clientUrls.universalAndroid}" class="button client-btn">Universal Import (Android)</a>
                <a href="${clientUrls.shadowrocket}" class="button client-btn">Import to Shadowrocket (iOS)</a>
                <a href="${clientUrls.stash}" class="button client-btn">Import to Stash (iOS)</a>
                <button class="button copy-buttons" data-clipboard-text="${subXrayUrl}">Copy Link</button>
            </div>
        </div>
      </div>

      <div class="config-card">
        <div class="config-title">Sing-Box / Clash Subscription</div>
        <div class="client-buttons-container">
            <div class="client-buttons">
                <a href="${clientUrls.clashMeta}" class="button client-btn">Import to Clash Meta / Stash</a>
                <button class="button copy-buttons" data-clipboard-text="${subSbUrl}">Copy Link</button>
            </div>
        </div>
      </div>
      <div class="footer"><p>© ${new Date().getFullYear()} - Secure. Private. Fast.</p></div>
    </div>
  `;
}

function getPageScript() {
  return `
      function copyToClipboard(button, text) {
        navigator.clipboard.writeText(text).then(() => {
          const originalHTML = button.innerHTML;
          button.innerHTML = 'Copied!';
          button.classList.add("copied");
          setTimeout(() => {
            button.innerHTML = originalHTML;
            button.classList.remove("copied");
          }, 1500);
        }).catch(err => console.error("Failed to copy: ", err));
      }

      async function fetchIpApiIoInfo(ip) {
        try {
          const response = await fetch('https://ip-api.io/json/' + ip);
          if (!response.ok) return null;
          return await response.json();
        } catch (error) { return null; }
      }

      function updateIpDisplay(data, prefix, host = null) {
          if (host) document.getElementById(prefix + '-host').textContent = host;
          if (!data) return;
          const locationEl = document.getElementById(prefix + '-location');
          const ipEl = document.getElementById(prefix + '-ip');
          
          if (ipEl) ipEl.textContent = data.ip || "N/A";
          
          let locationString = [data.city, data.country_name].filter(Boolean).join(', ');
          if (data.country_code) {
              locationString = \`<img src="https://flagcdn.com/w20/\${data.country_code.toLowerCase()}.png" class="country-flag"> \${locationString}\`;
          }
          locationEl.innerHTML = locationString || "N/A";
      }

      async function loadNetworkInfo() {
          const proxyHost = document.body.getAttribute('data-proxy-ip');
          const [proxyDomain, ] = proxyHost.split(':');
          
          // Fetch proxy info (no IP resolution, rely on geo from domain)
          const proxyGeo = await fetchIpApiIoInfo(proxyDomain);
          updateIpDisplay(proxyGeo, 'proxy', proxyHost);
          
          // Fetch client info
          const clientGeo = await fetchIpApiIoInfo('');
          updateIpDisplay(clientGeo, 'client');
      }
      
      function displayExpirationTimes() {
        const expElement = document.getElementById('expiration-display');
        const relativeElement = document.getElementById('expiration-relative');
        if (!expElement || !expElement.dataset.utcTime) return;

        const utcDate = new Date(expElement.dataset.utcTime);
        if (isNaN(utcDate.getTime())) return;
        
        const now = new Date();
        const diffSeconds = (utcDate.getTime() - now.getTime()) / 1000;
        const isExpired = diffSeconds < 0;
        const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
        let relativeTimeStr = '';

        if (Math.abs(diffSeconds) < 3600) relativeTimeStr = rtf.format(Math.round(diffSeconds / 60), 'minute');
        else if (Math.abs(diffSeconds) < 86400) relativeTimeStr = rtf.format(Math.round(diffSeconds / 3600), 'hour');
        else relativeTimeStr = rtf.format(Math.round(diffSeconds / 86400), 'day');
        
        if (relativeElement) {
            relativeElement.textContent = isExpired ? \`Expired \${relativeTimeStr}\` : \`Expires \${relativeTimeStr}\`;
            relativeElement.classList.add(isExpired ? 'expired' : 'active');
        }

        expElement.innerHTML = \`
          <span><strong>Your Local:</strong> \${utcDate.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})}</span>
          <span><strong>Tehran:</strong> \${utcDate.toLocaleString('en-US', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' })}</span>
        \`;
      }

      document.addEventListener('DOMContentLoaded', () => {
        loadNetworkInfo();
        displayExpirationTimes();
        document.querySelectorAll('.copy-buttons').forEach(button => {
          button.addEventListener('click', function(e) {
            e.preventDefault();
            copyToClipboard(this, this.getAttribute('data-clipboard-text'));
          });
        });
      });
  `;
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime, dataLimit, usedTraffic) {
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

    const formatBytes = (bytes) => {
        if (!bytes || bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
    };

    const trafficPercent = dataLimit > 0 ? Math.min((usedTraffic / dataLimit) * 100, 100) : 0;
    const trafficText = dataLimit === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
    let progressBarClass = 'progress-bar';
    if (trafficPercent > 90) progressBarClass += ' danger';
    else if (trafficPercent > 70) progressBarClass += ' warning';
    
    const dynamicContent = `
        <div class="config-card">
            <div class="expiration-card">
              <h2 class="expiration-title">Subscription Status</h2>
              <div id="expiration-relative" class="expiration-relative-time"></div>
              <div id="expiration-display" data-utc-time="${utcTimestamp}">Loading...</div>
            </div>
            <div class="traffic-card">
              <h2 class="traffic-title">Data Usage</h2>
              <div class="traffic-text">${trafficText}</div>
              <div class="progress-container">
                <div class="${progressBarClass}" style="width: ${trafficPercent.toFixed(2)}%"></div>
              </div>
            </div>
        </div>
    `;
    
    const baseHtml = getPageHTML(clientUrls, subXrayUrl, subSbUrl);
    const finalHtmlWithContent = baseHtml.replace('<div id="dynamic-content"></div>', dynamicContent);

    return `<!doctype html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>VLESS Proxy Configuration</title>
      <link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png">
      <style>${getPageCSS()}</style> 
    </head>
    <body data-proxy-ip="${proxyAddress}">
      ${finalHtmlWithContent}
      <script>${getPageScript()}</script>
    </body>
    </html>`;
}

// --- VLESS Subscription & Core Logic ---

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
    let links = [];
    
    mainDomains.forEach((domain, i) => {
        links.push(buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i + 1}` }));
    });

    try {
        const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json', { headers: { 'User-Agent': 'Cloudflare-Worker' } });
        if (r.ok) {
            const json = await r.json();
            const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
            ips.forEach((ip, i) => {
                const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
                links.push(buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i + 1}` }));
            });
        }
    } catch (e) { console.error('Fetch IP list failed', e); }

    return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

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

                try {
                    const { uuid, address, port, rawDataIndex, isUDP } = await processVlessHeader(chunk, env);
                    connectionState.uuid = uuid;

                    if (isUDP) {
                        controller.error('UDP proxying is not supported in this version.');
                        return;
                    }
                    
                    const remoteSocket = await connect({ hostname: address, port });
                    connectionState.remoteSocket = remoteSocket;

                    const writer = remoteSocket.writable.getWriter();
                    await writer.write(chunk.slice(rawDataIndex));
                    writer.releaseLock();

                    let vlessResponseSent = false;
                    remoteSocket.readable.pipeTo(
                        new WritableStream({
                            write: chunk => {
                                if (!vlessResponseSent) {
                                    const vlessResponse = new Uint8Array([CONST.VLESS_VERSION[0], 0]);
                                    const combinedChunk = new Uint8Array(vlessResponse.length + chunk.length);
                                    combinedChunk.set(vlessResponse);
                                    combinedChunk.set(chunk, vlessResponse.length);
                                    connectionState.incoming += combinedChunk.byteLength;
                                    webSocket.send(combinedChunk);
                                    vlessResponseSent = true;
                                } else {
                                    connectionState.incoming += chunk.byteLength;
                                    webSocket.send(chunk);
                                }
                            },
                            close: () => log(`Remote socket readable stream closed for ${uuid}.`),
                            abort: (e) => log(`Remote socket readable stream aborted for ${uuid}: ${e}`, 'error'),
                        })
                    ).catch(err => log(`Remote socket pipe failed: ${err}`, 'error'));
                } catch (err) {
                    log(`VLESS processing error: ${err.message}`, 'error');
                    controller.error(err.message);
                }
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
        if (connectionState.remoteSocket) {
            connectionState.remoteSocket.close();
        }
        log(`Connection closed. UUID: ${connectionState.uuid || 'N/A'}. In: ${connectionState.incoming}, Out: ${connectionState.outgoing}`);
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
        throw new Error('User is invalid, expired, or has reached their data limit');
    }

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
        if (socket.readyState === CONST.WS_READY_STATE_OPEN) socket.close(1000, "Closing connection");
    } catch (error) {
        log(`Error closing WebSocket: ${error}`, 'error');
    }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]]).toLowerCase();
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
                    return new Response('Invalid or expired user, or traffic limit reached', { status: 403 });
                }
                return handleIpSubscription(core, uuid, url.hostname);
            };

            if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
            if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

            const path = url.pathname.slice(1);
            if (isValidUUID(path)) {
                const userData = await getUserData(env, path);
                if (!isUserValid(userData)) {
                    return new Response('Invalid or expired user, or traffic limit reached', { status: 403 });
                }
                const cfg = Config.fromEnv(env);
                const html = generateBeautifulConfigPage(path, url.hostname, cfg.proxyAddress, userData.exp_date, userData.exp_time, userData.data_limit, userData.used_traffic);
                return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CONST.securityHeaders } });
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
                    return fetch(newRequest);
                } catch (e) {
                    log(`Reverse Proxy Error: ${e.message}`, 'error');
                    return new Response(`Proxy configuration error: ${e.message}`, { status: 502 });
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
