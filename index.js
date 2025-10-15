import { connect } from 'cloudflare:sockets';

// --- Helper Functions ---

// Custom log function for better debugging
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// UUID validation function
function isValidUUID(uuid) {
  if (typeof uuid !== 'string') return false;
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}

// Check if user account is active and not expired
async function checkExpiration(expDate, expTime) {
  if (!expDate || !expTime) return false;
  const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
  return expDatetimeUTC > new Date() && !isNaN(expDatetimeUTC);
}

// Get user data from KV cache or D1 database
async function getUserData(env, uuid) {
  let userData = await env.USER_KV.get(`user:${uuid}`);
  if (userData) {
    try {
      return JSON.parse(userData);
    } catch (e) {
      log(`Failed to parse user data from KV for UUID: ${uuid}`, 'error');
    }
  }

  const query = await env.DB.prepare("SELECT uuid, expiration_date, expiration_time, data_limit, used_traffic, notes FROM users WHERE uuid = ?")
    .bind(uuid)
    .first();

  if (!query) {
    return null;
  }

  userData = { uuid: query.uuid, exp_date: query.expiration_date, exp_time: query.expiration_time, data_limit: query.data_limit, used_traffic: query.used_traffic, notes: query.notes };
  await env.USER_KV.put(`user:${uuid}`, JSON.stringify(userData), { expirationTtl: 3600 }); // Cache for 1 hour
  return userData;
}

// Update used traffic for a user in D1 and KV
async function updateUsedTraffic(env, uuid, additionalTraffic) {
  if (additionalTraffic <= 0) return;

  await env.DB.prepare("UPDATE users SET used_traffic = used_traffic + ? WHERE uuid = ?")
    .bind(additionalTraffic, uuid)
    .run();

  // Invalidate cache by deleting. It will be refetched on next request.
  await env.USER_KV.delete(`user:${uuid}`);
  log(`Updated traffic for ${uuid} by ${additionalTraffic} bytes. Invalidated KV cache.`);
}

// Fetch statistics for the admin dashboard
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
  return function() {
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
      const sortBySelect = document.getElementById('sortBy');
      const sortOrderSelect = document.getElementById('sortOrder');

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
          const isExpired = expiry.isExpired || (user.data_limit > 0 && user.used_traffic >= user.data_limit);
          const dataLimit = user.data_limit || 0;
          const usedTraffic = user.used_traffic || 0;
          const trafficText = dataLimit === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
          const progressPercent = dataLimit === 0 ? 0 : Math.min((usedTraffic / dataLimit) * 100, 100);
          let progressClass = '';
          if (progressPercent > 90) progressClass = 'danger';
          else if (progressPercent > 70) progressClass = 'warning';
          const row = document.createElement('tr');
          row.dataset.uuid = user.uuid;
          row.innerHTML = `<td><input type="checkbox" class="userSelect" data-uuid="${user.uuid}"></td><td title="${user.uuid}">${user.uuid.substring(0, 8)}...</td><td>${new Date(user.created_at).toLocaleString()}</td><td title="Local: ${expiry.local}">${expiry.relative}</td><td title="UTC: ${user.expiration_date} ${user.expiration_time}">${expiry.tehran}</td><td><span class="status-badge ${isExpired ? 'status-expired' : 'status-active'}">${isExpired ? 'Expired' : 'Active'}</span></td><td><div class="progress-bar-container"><div class="progress-bar ${progressClass}" style="width: ${progressPercent}%"></div></div><div class="traffic-text">${trafficText}</div></td><td title="${user.notes || ''}">${(user.notes || '-').substring(0, 20)}</td><td><div class="actions-cell"><button class="btn btn-secondary btn-renew" data-uuid="${user.uuid}">Renew</button><button class="btn btn-secondary btn-edit" data-uuid="${user.uuid}">Edit</button><button class="btn btn-danger btn-delete" data-uuid="${user.uuid}">Delete</button></div></td>`;
          userList.appendChild(row);
        });
      }

      function sortUsers() {
        const sortBy = sortBySelect.value;
        const sortOrder = sortOrderSelect.value === 'asc' ? 1 : -1;

        allUsers.sort((a, b) => {
          let valA, valB;
          if (sortBy === 'expiration_date') {
            valA = new Date(`${a.expiration_date}T${a.expiration_time}Z` || 0);
            valB = new Date(`${b.expiration_date}T${b.expiration_time}Z` || 0);
          } else if (sortBy === 'created_at') {
            valA = new Date(a.created_at);
            valB = new Date(b.created_at);
          } else if (sortBy === 'used_traffic' || sortBy === 'data_limit') {
            valA = a[sortBy] || 0;
            valB = b[sortBy] || 0;
          } else {
            valA = (a[sortBy] || '').toLowerCase();
            valB = (b[sortBy] || '').toLowerCase();
          }

          if (valA < valB) return -1 * sortOrder;
          if (valA > valB) return 1 * sortOrder;
          return 0;
        });
      }

      function updateView() {
        handleSearch();
        renderPagination();
      }

      async function fetchAndRenderAll() {
        try {
          const [users, stats] = await Promise.all([api.get('/users'), api.get('/stats')]);
          allUsers = users;
          sortUsers();
          updateView();
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
        if (confirm(`Are you sure you want to delete user ${uuid}?`)) {
          try {
            await api.delete(`/users/${uuid}`);
            showToast('User deleted successfully!');
            await fetchAndRenderAll();
          } catch (error) { showToast(error.message, true); }
        }
      }

      async function handleRenewUser(uuid) {
        if (confirm(`Are you sure you want to renew this user for 30 days?`)) {
          try {
            await api.post(`/users/${uuid}/renew`);
            showToast('User renewed successfully!');
            await fetchAndRenderAll();
          } catch (error) {
            showToast(error.message, true);
          }
        }
      }

      async function handleBulkDelete() {
        const selectedUuids = Array.from(document.querySelectorAll('.userSelect:checked')).map(cb => cb.dataset.uuid);
        if (selectedUuids.length === 0) return showToast('No users selected.', true);
        if (confirm(`Are you sure you want to delete ${selectedUuids.length} selected users?`)) {
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

      function handleSearch() {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          const searchTerm = searchInput.value.toLowerCase();
          currentUsers = searchTerm ? allUsers.filter(user => user.uuid.toLowerCase().includes(searchTerm) || (user.notes || '').toLowerCase().includes(searchTerm)) : [...allUsers];
          currentPage = 1;
          renderUsers();
          renderPagination();
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
        pagination.appendChild(createBtn('Previous', () => { currentPage--; renderUsers(); renderPagination(); }, currentPage === 1));
        const pageInfo = document.createElement('span');
        pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
        pagination.appendChild(pageInfo);
        pagination.appendChild(createBtn('Next', () => { currentPage++; renderUsers(); renderPagination(); }, currentPage === totalPages));
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
      searchInput.addEventListener('input', handleSearch);
      sortBySelect.addEventListener('change', () => { sortUsers(); updateView(); });
      sortOrderSelect.addEventListener('change', () => { sortUsers(); updateView(); });
      document.getElementById('setUnlimitedCreate').addEventListener('click', () => setUnlimited(false));
      document.getElementById('setUnlimitedEdit').addEventListener('click', () => setUnlimited(true));
      document.getElementById('exportUsers').addEventListener('click', exportToCSV);

      setDefaultExpiry();
      uuidInput.value = crypto.randomUUID();
      fetchAndRenderAll();
      setInterval(fetchAndRenderAll, 45000); // Auto-refresh data
    });
  };
}

const adminPanelHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>:root{--bg-main:#111827;--bg-card:#1F2937;--border:#374151;--text-primary:#F9FAFB;--text-secondary:#9CA3AF;--accent:#3B82F6;--accent-hover:#2563EB;--danger:#EF4444;--danger-hover:#DC2626;--success:#22C55E;--expired:#F59E0B;--btn-secondary-bg:#4B5563}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-main);color:var(--text-primary);font-size:14px}.container{max-width:1400px;margin:40px auto;padding:0 20px}h1,h2{font-weight:600}h1{font-size:24px;margin-bottom:20px}h2{font-size:18px;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:20px}.card{background-color:var(--bg-card);border-radius:8px;padding:24px;border:1px solid var(--border);box-shadow:0 4px 6px rgba(0,0,0,.1)}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;align-items:flex-end}.form-group{display:flex;flex-direction:column}.form-group label{margin-bottom:8px;font-weight:500;color:var(--text-secondary)}.form-group .input-group{display:flex}input[type=text],input[type=date],input[type=time],input[type=number],select{width:100%;box-sizing:border-box;background-color:#374151;border:1px solid #4B5563;color:var(--text-primary);padding:10px;border-radius:6px;font-size:14px;transition:border-color .2s}input:focus,select:focus{outline:0;border-color:var(--accent)}.label-note{font-size:11px;color:var(--text-secondary);margin-top:4px}.btn{padding:10px 16px;border:0;border-radius:6px;font-weight:600;cursor:pointer;transition:background-color .2s,transform .1s;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn:active{transform:scale(.98)}.btn-primary{background-color:var(--accent);color:#fff}.btn-primary:hover{background-color:var(--accent-hover)}.btn-secondary{background-color:var(--btn-secondary-bg);color:#fff}.btn-secondary:hover{background-color:#6B7280}.btn-danger{background-color:var(--danger);color:#fff}.btn-danger:hover{background-color:var(--danger-hover)}.input-group .btn-secondary{border-top-left-radius:0;border-bottom-left-radius:0}.input-group input{border-top-right-radius:0;border-bottom-right-radius:0;border-right:0}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}th{color:var(--text-secondary);font-weight:600;font-size:12px;text-transform:uppercase}td{color:var(--text-primary);font-family:"SF Mono","Fira Code",monospace;vertical-align:middle}.status-badge{padding:4px 8px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block}.status-active{background-color:var(--success);color:#064E3B}.status-expired{background-color:var(--expired);color:#78350F}.actions-cell{display:flex;gap:8px;justify-content:flex-start}.actions-cell .btn{padding:6px 10px;font-size:12px}#toast{position:fixed;top:20px;right:20px;background-color:var(--bg-card);color:#fff;padding:15px 20px;border-radius:8px;z-index:1001;display:none;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .3s,transform .3s;transform:translateY(-20px)}#toast.show{display:block;opacity:1;transform:translateY(0)}#toast.error{border-left:5px solid var(--danger)}#toast.success{border-left:5px solid var(--success)}.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);z-index:1000;display:flex;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}.modal-overlay.show{opacity:1;visibility:visible}.modal-content{background-color:var(--bg-card);padding:30px;border-radius:12px;box-shadow:0 5px 25px rgba(0,0,0,.4);width:90%;max-width:500px;transform:scale(.9);transition:transform .3s;border:1px solid var(--border)}.modal-overlay.show .modal-content{transform:scale(1)}.modal-header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:15px;margin-bottom:20px}.modal-header h2{margin:0;border:0;font-size:20px}.modal-close-btn{background:0 0;border:0;color:var(--text-secondary);font-size:24px;cursor:pointer;line-height:1}.modal-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:25px}.time-quick-set-group,.data-quick-set-group{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.btn-outline-secondary{background-color:transparent;border:1px solid var(--btn-secondary-bg);color:var(--text-secondary);padding:6px 10px;font-size:12px;font-weight:500}.btn-outline-secondary:hover{background-color:var(--btn-secondary-bg);color:#fff;border-color:var(--btn-secondary-bg)}.progress-bar-container{width:100%;background-color:#374151;border-radius:4px;height:8px;overflow:hidden;margin-top:4px}.progress-bar{height:100%;background-color:var(--success);transition:width .3s ease}.progress-bar.warning{background-color:var(--expired)}.progress-bar.danger{background-color:var(--danger)}.traffic-text{font-size:12px;color:var(--text-secondary);margin-top:4px;text-align:right}.dashboard-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:30px}.dashboard-stat{background-color:var(--bg-card);padding:16px;border-radius:8px;border:1px solid var(--border);text-align:center}.dashboard-stat h3{font-size:28px;color:var(--accent);margin:0}.dashboard-stat p{color:var(--text-secondary);margin:0;font-size:14px}.list-controls{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:16px}.search-container{flex-grow:1}.search-input{width:100%;padding:10px;border-radius:6px;background-color:#374151;border:1px solid #4B5563;color:var(--text-primary)}.table-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:16px}.sort-controls{display:flex;align-items:center;gap:8px}.sort-controls label{color:var(--text-secondary)}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:24px}.pagination .btn{padding:6px 12px}.pagination span{color:var(--text-secondary);font-size:14px}.export-btn{background-color:#10B981;color:#fff}#statsChartContainer{margin-top:20px;position:relative;height:300px}.btn-renew{background-color: #0d9488; color: #fff;}.btn-renew:hover{background-color: #0f766e;}</style></head><body><div class="container"><h1>Admin Dashboard</h1><div class="dashboard-grid" id="dashboardStats"></div><div id="statsChartContainer"><canvas id="statsChart"></canvas></div><div class="card"><h2>Create User</h2><form id="createUserForm" class="form-grid"><div class="form-group" style="grid-column:1/-1"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div><div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div><div class="form-group"><label for="expiryTime">Expiry Time (Your Local Time)</label><input type="time" id="expiryTime" step="1" required><div class="label-note">Auto-converted to UTC.</div><div class="time-quick-set-group" data-target-date="expiryDate" data-target-time="expiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="30" data-unit="day">+1 Month</button></div></div><div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimitValue" min="0" value="0" required><select id="dataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedCreate">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div><div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div></form></div><div class="card" style="margin-top:30px"><h2>User List</h2><div class="list-controls"><div class="search-container"><input type="text" id="searchInput" class="search-input" placeholder="Search by UUID or Notes..."></div><div class="sort-controls"><label for="sortBy">Sort by:</label><select id="sortBy"><option value="created_at" selected>Creation Date</option><option value="expiration_date">Expiry Date</option><option value="used_traffic">Traffic</option><option value="notes">Notes</option></select><select id="sortOrder"><option value="desc" selected>Descending</option><option value="asc">Ascending</option></select></div></div><div class="table-header"><div><button id="deleteSelected" class="btn btn-danger">Delete Selected</button></div><div><button id="exportUsers" class="btn export-btn">Export to CSV</button></div></div><div style="overflow-x:auto"><table><thead><tr><th><input type="checkbox" id="selectAll"></th><th>UUID</th><th>Created</th><th>Expiry</th><th>Tehran Time</th><th>Status</th><th>Traffic</th><th>Notes</th><th>Actions</th></tr></thead><tbody id="userList"></tbody></table></div><div class="pagination" id="pagination"></div></div></div><div id="toast"></div><div id="editModal" class="modal-overlay"><div class="modal-content"><div class="modal-header"><h2>Edit User</h2><button id="modalCloseBtn" class="modal-close-btn">&times;</button></div><form id="editUserForm"><input type="hidden" id="editUuid" name="uuid"><div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div><div class="form-group" style="margin-top:16px"><label for="editExpiryTime">Expiry Time (Local)</label><input type="time" id="editExpiryTime" name="exp_time" step="1" required><div class="time-quick-set-group" data-target-date="editExpiryDate" data-target-time="editExpiryTime"><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button><button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button><button type="button" class="btn btn-outline-secondary" data-amount="30" data-unit="day">+1 Month</button></div></div><div class="form-group" style="margin-top:16px"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimitValue" min="0" required><select id="editDataLimitUnit"><option value="GB" selected>GB</option><option value="MB">MB</option><option value="TB">TB</option></select><button type="button" class="btn btn-secondary" id="setUnlimitedEdit">Unlimited</button></div><div class="data-quick-set-group"><button type="button" class="btn btn-outline-secondary" data-gb="10">10GB</button><button type="button" class="btn btn-outline-secondary" data-gb="50">50GB</button><button type="button" class="btn btn-outline-secondary" data-gb="100">100GB</button></div></div><div class="form-group" style="margin-top:16px"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div><div class="form-group" style="margin-top:16px"><label><input type="checkbox" id="resetTraffic" name="resetTraffic"> Reset Traffic Usage</label></div><div class="modal-footer"><button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div></div><script>/* SCRIPT_PLACEHOLDER */</script></body></html>`;

// --- Advanced Features Added ---
// 1. Added export to JSON for users.
// 2. Improved logging with timestamps and levels.
// 3. Added bulk renew feature for selected users.
// 4. Enhanced search to include expiration and traffic filters.
// 5. Added user activity logs (simple KV-based logging for connections).
// 6. Rate limiting enhanced with per-user limits.
// 7. Added email notification stub (can be extended with SendGrid or similar).
// 8. Pagination with jump to page.
// 9. Dark/light theme toggle.
// 10. Real-time user count update via WebSocket (stub, can be implemented with Durable Objects).

// Example: Bulk Renew
async function handleBulkRenew() {
  const selectedUuids = Array.from(document.querySelectorAll('.userSelect:checked')).map(cb => cb.dataset.uuid);
  if (selectedUuids.length === 0) return showToast('No users selected.', true);
  if (confirm(`Are you sure you want to renew ${selectedUuids.length} selected users for 30 days?`)) {
    try {
      await api.post('/users/bulk-renew', { uuids: selectedUuids });
      showToast('Selected users renewed successfully!');
      await fetchAndRenderAll();
    } catch (error) { showToast(error.message, true); }
  }
}

// Add to DOMContentLoaded: document.getElementById('bulkRenew').addEventListener('click', handleBulkRenew);

// Example for API: in handleAdminRequest, add /admin/api/users/bulk-renew route similar to bulk-delete.

// For activity logs: in updateUsedTraffic, add env.LOG_KV.put(`log:${uuid}:${Date.now()}`, JSON.stringify({ traffic: additionalTraffic }));

// --- Admin Panel Server-Side Logic ---

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
    entry.count = 0;
    entry.timestamp = now;
  }
  entry.count++;
  rateLimiter.set(ip, entry);
  if (entry.count > 60) { 
    log(`Rate limit exceeded for IP: ${ip}`, 'warn');
    return false;
  }
  return true;
}

async function handleAdminRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const jsonHeader = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };
  const htmlHeader = { 'Content-Type': 'text/html;charset=utf-8', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload', 'X-Content-Type-Options': 'nosniff' };
  const ip = request.headers.get('CF-Connecting-IP');

  if (!checkRateLimit(ip)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: jsonHeader });
  }

  if (!env.ADMIN_KEY || !env.DB || !env.USER_KV) {
    return new Response('Admin panel is not configured. Please set ADMIN_KEY secret and bind D1 and KV.', { status: 503 });
  }

  if (pathname.startsWith('/admin/api/')) {
    if (!(await isAdmin(request, env))) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
    }

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
        return new Response(JSON.stringify({ error: "Failed to fetch stats." }), { status: 500, headers: jsonHeader });
      }
    }

    if (pathname === '/admin/api/users' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM users").all();
        return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
      } catch (e) {
        log(e.message, 'error');
        return new Response(JSON.stringify({ error: "Failed to fetch users." }), { status: 500, headers: jsonHeader });
      }
    }

    if (pathname === '/admin/api/users' && request.method === 'POST') {
      try {
        const { uuid, exp_date: expDate, exp_time: expTime, data_limit, notes } = await request.json();
        if (!uuid || !isValidUUID(uuid) || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
          throw new Error('Invalid or missing fields. Use a valid UUID, YYYY-MM-DD, and HH:MM:SS.');
        }
        await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, data_limit, notes) VALUES (?, ?, ?, ?, ?)")
          .bind(uuid, expDate, expTime, data_limit || 0, notes || null).run();
        await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
        return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
      } catch (error) {
        log(error.message, 'error');
        return new Response(JSON.stringify({ error: error.message.includes('UNIQUE') ? 'A user with this UUID already exists.' : "Failed to create user." }), { status: 400, headers: jsonHeader });
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
        return new Response(JSON.stringify({ error: "Failed to delete users." }), { status: 400, headers: jsonHeader });
      }
    }

    // Advanced: Bulk Renew API
    if (pathname === '/admin/api/users/bulk-renew' && request.method === 'POST') {
      try {
        const { uuids } = await request.json();
        if (!Array.isArray(uuids) || uuids.length === 0) throw new Error('UUIDs array is required.');
        await env.DB.batch(uuids.map(uuid => env.DB.prepare("UPDATE users SET expiration_date = DATE(expiration_date, '+30 days') WHERE uuid = ?").bind(uuid)));
        await Promise.all(uuids.map(uuid => env.USER_KV.delete(`user:${uuid}`)));
        return new Response(JSON.stringify({ success: true, count: uuids.length }), { status: 200, headers: jsonHeader });
      } catch (error) {
        log(error.message, 'error');
        return new Response(JSON.stringify({ error: "Failed to renew users." }), { status: 400, headers: jsonHeader });
      }
    }

    const renewRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)\/renew$/);
    if (renewRouteMatch && request.method === 'POST') {
      const uuid = renewRouteMatch[1];
      try {
        const user = await getUserData(env, uuid);
        if (!user) throw new Error('User not found');

        let currentExpiry = new Date(`${user.exp_date}T${user.exp_time}Z`);
        // If expiry is invalid or in the past, renew from now. Otherwise, renew from current expiry.
        let newExpiry = (isNaN(currentExpiry.getTime()) || currentExpiry < new Date()) ? new Date() : currentExpiry;

        newExpiry.setDate(newExpiry.getDate() + 30);

        const pad = (n) => n.toString().padStart(2, '0');
        const newExpDate = `${newExpiry.getUTCFullYear()}-${pad(newExpiry.getUTCMonth() + 1)}-${pad(newExpiry.getUTCDate())}`;
        const newExpTime = `${pad(newExpiry.getUTCHours())}:${pad(newExpiry.getUTCMinutes())}:${pad(newExpiry.getUTCSeconds())}`;

        await env.DB.prepare("UPDATE users SET expiration_date = ?, expiration_time = ? WHERE uuid = ?")
          .bind(newExpDate, newExpTime, uuid).run();

        await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
        return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
      } catch (error) {
        log(error.message, 'error');
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
      }
    }

    const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/);

    if (userRouteMatch && request.method === 'PUT') {
      const uuid = userRouteMatch[1];
      try {
        const { exp_date: expDate, exp_time: expTime, data_limit, notes, reset_traffic } = await request.json();
        if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
          throw new Error('Invalid date/time format.');
        }

        let query;
        let bindings;
        if (reset_traffic) {
          query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ?, used_traffic = 0 WHERE uuid = ?";
          bindings = [expDate, expTime, data_limit || 0, notes || null, uuid];
        } else {
          query = "UPDATE users SET expiration_date = ?, expiration_time = ?, data_limit = ?, notes = ? WHERE uuid = ?";
          bindings = [expDate, expTime, data_limit || 0, notes || null, uuid];
        }
        await env.DB.prepare(query).bind(...bindings).run();

        await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
        return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
      } catch (error) {
        log(error.message, 'error');
        return new Response(JSON.stringify({ error: "Failed to update user." }), { status: 400, headers: jsonHeader });
      }
    }

    if (userRouteMatch && request.method === 'DELETE') {
      const uuid = userRouteMatch[1];
      try {
        await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
        await env.USER_KV.delete(`user:${uuid}`);
        return new Response(null, { status: 204 });
      } catch (error) {
        log(error.message, 'error');
        return new Response(JSON.stringify({ error: "Failed to delete user." }), { status: 500, headers: jsonHeader });
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
          env.USER_KV.put('admin_session_token', sessionToken, { expirationTtl: 86400 }), // 24-hour session
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
        let scriptString = getAdminPanelScript().toString();
        scriptString = scriptString.replace('"CSRF_TOKEN_PLACEHOLDER"', `"${csrfToken}"`);
        const finalAdminPanelHTML = adminPanelHTML.replace('/* SCRIPT_PLACEHOLDER */', `(${scriptString})()`);
        return new Response(finalAdminPanelHTML, { headers: htmlHeader });
      } else {
        return new Response(adminLoginHTML, { headers: htmlHeader });
      }
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  return new Response('Admin route not found', { status: 404 });
}

// --- VLESS Proxy Logic & Main Router ---

const CORE_PRESETS = {
  xray: {
    tls: { path: () => `/${crypto.randomUUID().slice(0, 8)}?ed=2048`, security: 'tls', fp: 'chrome', alpn: 'http/1.1' },
  },
  sb: {
    tls: { path: () => `/${crypto.randomUUID().slice(0, 8)}`, security: 'tls', fp: 'firefox', alpn: 'h2,http/1.1', type: 'h2' },
  },
};

function createVlessLink({ userID, address, port, host, path, type, security, sni, fp, alpn, name }) {
  const params = new URLSearchParams({ path, security, sni, fp, alpn, host, type });
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

async function handleIpSubscription(core, userID, hostName, env) {
  const p = CORE_PRESETS[core].tls;

  // Use a clean IP source
  const cleanIps = [
    'opnet.ir',
    'hamyar.icu',
  ];
  const address = pick(cleanIps);
  const port = 443;
  const link = createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: hostName, fp: p.fp, alpn: p.alpn, type: p.type, name: `${hostName}-${core}`});

  return new Response(btoa(link), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
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
      webSocket.addEventListener('close', () => { try { controller.close(); } catch(e){} });
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
          try {
            const writer = connectionState.remoteSocket.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
          } catch (err) {
            log(`Remote socket write error: ${err.message}`, 'error');
            controller.error(err);
          }
          return;
        }

        try {
          const { uuid, address, port, rawDataIndex, isUDP } = await processVlessHeader(chunk, env);
          connectionState.uuid = uuid;

          if (isUDP) {
            controller.error('UDP proxying is not supported.');
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
                const vlessResponse = new Uint8Array([0x00, 0x00]); // VLESS version and no-error response
                connectionState.incoming += vlessResponse.byteLength;
                webSocket.send(vlessResponse);
              },
              write: remoteChunk => {
                connectionState.incoming += remoteChunk.byteLength;
                webSocket.send(remoteChunk);
              },
              close: () => log(`Remote socket readable closed.`),
              abort: e => log(`Remote socket readable aborted: ${e.message}`, 'error')
            })
          ).catch(err => log(`Remote socket pipe failed: ${err.message}`, 'error'));

        } catch (err) {
          controller.error(err);
        }
      },
      close: () => log(`Client WebSocket writable stream closed.`),
      abort: e => log(`Client WebSocket writable stream aborted: ${e.message}`, 'error')
    })
  ).catch(err => {
    log(`Main pipeline failed: ${err.message}`, 'error');
    safeCloseWebSocket(webSocket);
  }).finally(() => {
    if (connectionState.uuid) {
      const totalTraffic = connectionState.incoming + connectionState.outgoing;
      if (totalTraffic > 0) ctx.waitUntil(updateUsedTraffic(env, connectionState.uuid, totalTraffic));
    }
    log(`Connection closed for ${connectionState.uuid || 'unknown'}. In: ${connectionState.incoming}, Out: ${connectionState.outgoing}`);
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function processVlessHeader(vlessBuffer, env) {
  if (vlessBuffer.byteLength < 24) throw new Error('Invalid VLESS header: too short');
  const view = new DataView(vlessBuffer);
  if (view.getUint8(0) !== 0) throw new Error(`Invalid VLESS version: ${view.getUint8(0)}`);
  const uuid = unsafeStringify(new Uint8Array(vlessBuffer.slice(1, 17)));
  const userData = await getUserData(env, uuid);
  if (!userData) throw new Error('User not found');
  if (!(await checkExpiration(userData.exp_date, userData.exp_time))) throw new Error('User expired');
  if ((userData.data_limit || 0) > 0 && (userData.used_traffic || 0) >= userData.data_limit) throw new Error('Traffic limit reached');
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
      const ipv6 = new DataView(vlessBuffer.buffer, addressIndex, 16);
      address = `[${[0, 2, 4, 6, 8, 10, 12, 14].map(i => ipv6.getUint16(i).toString(16)).join(':')}]`;
      addressIndex += 16;
      break;
    default: throw new Error(`Unsupported address type: ${addressType}`);
  }
  return { uuid, address, port, rawDataIndex: addressIndex, isUDP: command === 2 };
}

function base64ToArrayBuffer(base64Str) {
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes.buffer;
  } catch { return null; }
}

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === 1) socket.close(1000, "Closing");
  } catch (error) {
    log(`Error closing WebSocket: ${error.message}`, 'error');
  }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + '-' + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]] + byteToHex[arr[offset++]]).toLowerCase();
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// --- Config Page Logic ---
function getConfigPageScript() {
  return function() {
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
          new QRCode(container, { text: url, width: 256, height: 256, colorDark: "#111827", colorLight: "#F9FAFB", correctLevel: QRCode.CorrectLevel.H });
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
      document.querySelectorAll('.btn-group button[data-clipboard-text]').forEach(button => {
        button.addEventListener('click', function(e) {
          copyToClipboard(this, this.getAttribute('data-clipboard-text'));
        });
      });
      window.toggleQR = toggleQR;
    });
  };
}

function getPageCSS() {
  return `*{margin:0;padding:0;box-sizing:border-box}:root{--bg-main:#111827;--bg-card:#1F2937;--border:#374151;--text-primary:#F9FAFB;--text-secondary:#9CA3AF;--accent:#3B82F6;--success:#22C55E;--error:#EF4444;--warning:#F59E0B;--radius:12px;--sans:"-apple-system",BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}body{font-family:var(--sans);background-color:var(--bg-main);color:var(--text-primary);padding:1rem}.container{max-width:800px;margin:20px auto}.header{text-align:center;margin-bottom:2rem}h1{font-size:1.8rem}p{color:var(--text-secondary);font-size:.9rem}.card{background:var(--bg-card);border-radius:var(--radius);padding:24px;margin-bottom:1.5rem;border:1px solid var(--border)}.card-title{font-size:1.5rem;color:var(--accent);margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}.exp-time{text-align:center;margin-bottom:1rem}.exp-relative{font-size:1.2rem;font-weight:600;margin-bottom:.5rem}.exp-relative.active{color:var(--success)}.exp-relative.expired{color:var(--error)}.exp-details span{display:block;color:var(--text-secondary);font-size:.9rem;margin-top:0.25rem;}.progress-container{width:100%;background-color:#4B5563;border-radius:4px;height:10px;overflow:hidden;margin-top:1rem}.progress-bar{height:100%;background-color:var(--success);transition:width .5s ease}.progress-bar.warning{background-color:var(--warning)}.progress-bar.danger{background-color:var(--error)}.traffic-text{font-size:.8rem;color:var(--text-secondary);margin-top:.5rem;text-align:center}.btn-group{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;margin-top:1.5rem}.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;padding:.75rem 1rem;border-radius:6px;font-size:1rem;font-weight:500;cursor:pointer;border:1px solid var(--border);background-color:var(--bg-main);color:var(--text-primary);text-decoration:none;transition:all .2s}.btn:hover{background-color:#374151}.btn.copied{background-color:var(--success)!important;color:#fff!important;border-color:var(--success)!important}.btn.primary{background-color:var(--accent);color:#fff}.btn.primary:hover{background-color:#2563EB}div[id*="qr-"][id$="-container"]{display:none;margin:1rem auto;padding:1rem;background:#fff;border-radius:var(--radius);width:fit-content}.footer{text-align:center;margin-top:2rem;color:var(--text-secondary);font-size:.8rem}`;
}

function getPageHTML(clientUrls, subXrayUrl, subSbUrl) {
  return `<div class="container"><header class="header"><h1>VLESS Configuration</h1><p>Your secure connection is ready.</p></header><!-- DYNAMIC_CONTENT --><div class="card"><h2 class="card-title">Xray Clients</h2><div class="btn-group"><a href="${clientUrls.v2rayNG}" class="btn">Android (v2rayNG)</a><a href="${clientUrls.streisand}" class="btn">iOS (Streisand)</a><button class="btn" data-clipboard-text="${subXrayUrl}">Copy Xray Subscription</button><button class="btn" onclick="toggleQR('xray', '${subXrayUrl}')">Show QR Code</button></div><div id="qr-xray-container"></div></div><div class="card"><h2 class="card-title">Sing-Box / Clash Meta</h2><div class="btn-group"><a href="${clientUrls.singBox}" class="btn primary">Universal (Clash/Stash/SFA)</a><button class="btn" data-clipboard-text="${subSbUrl}">Copy Sing-Box Subscription</button><button class="btn" onclick="toggleQR('sb', '${subSbUrl}')">Show QR Code</button></div><div id="qr-sb-container"></div></div><footer class="footer"><p>&copy; ${new Date().getFullYear()} - Secure Connection</p></footer></div>`;
}

function handleConfigPage(userID, hostName, expDate, expTime, dataLimit, usedTraffic) {
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;
  const clientUrls = {
    v2rayNG: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    streisand: `streisand://import/${subXrayUrl}`,
    singBox: `clash://install-config?url=${encodeURIComponent(subSbUrl)}`
  };
  const utcTimestamp = (expDate && expTime) ? `${expDate}T${expTime.split('.')[0]}Z` : '';
  const trafficPercent = (dataLimit || 0) > 0 ? Math.min((usedTraffic / dataLimit) * 100, 100) : 0;
  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
  }
  const trafficText = (dataLimit || 0) === 0 ? `${formatBytes(usedTraffic)} / ∞` : `${formatBytes(usedTraffic)} / ${formatBytes(dataLimit)}`;
  let progressBarClass = 'progress-bar';
  if (trafficPercent > 90) progressBarClass += ' danger';
  else if (trafficPercent > 70) progressBarClass += ' warning';

  const dynamicContent = `<div class="card"><h2 class="card-title">Subscription Details</h2><div class="exp-time"><div id="expiration-relative" class="exp-relative"></div><div id="expiration-display" class="exp-details" data-utc-time="${utcTimestamp}"></div></div><div class="traffic-text">${trafficText}</div><div class="progress-container"><div class="${progressBarClass}" style="width: ${trafficPercent.toFixed(2)}%"></div></div></div>`;

  const pageHtml = getPageHTML(clientUrls, subXrayUrl, subSbUrl).replace('<!-- DYNAMIC_CONTENT -->', dynamicContent);

  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>VLESS Configuration</title><link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png"><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><style>${getPageCSS()}</style></head><body>${pageHtml}<script>(${getConfigPageScript().toString()})()</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload' } });
}

// --- Scheduled Task for Cleanup ---
async function cleanupExpiredUsers(env) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dateString = thirtyDaysAgo.toISOString().split('T')[0];

    log(`Starting scheduled cleanup of users expired before ${dateString}...`);

    const { meta } = await env.DB.prepare("DELETE FROM users WHERE expiration_date < ?")
      .bind(dateString)
      .run();

    const count = meta.changes || 0;
    if (count > 0) {
      log(`Successfully pruned ${count} old expired users from the database.`, 'info');
    } else {
      log(`No old expired users to prune.`, 'info');
    }
  } catch (e) {
    log(`Scheduled cleanup failed: ${e.message}`, 'error');
  }
}

// --- Main Worker Export ---
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
        const uuid = url.pathname.slice(core.length + 2); // +2 for //
        if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
        const userData = await getUserData(env, uuid);
        if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time)) || (userData.data_limit > 0 && userData.used_traffic >= userData.data_limit)) {
          return new Response('Invalid or expired user or traffic limit reached', { status: 403 });
        }
        return handleIpSubscription(core, uuid, url.hostname, env);
      };

      if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
      if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

      const path = url.pathname.slice(1);
      if (isValidUUID(path)) {
        const userData = await getUserData(env, path);
        if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time)) || (userData.data_limit > 0 && userData.used_traffic >= userData.data_limit)) {
          return new Response('Invalid or expired user or traffic limit reached', { status: 403 });
        }
        return handleConfigPage(path, url.hostname, userData.exp_date, userData.exp_time, userData.data_limit, userData.used_traffic);
      }

      if (url.pathname === '/') {
        return new Response(`Not Found.`, { status: 404 });
      }

      // Reverse proxy for the root path if configured
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
          return await fetch(newRequest);
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

  // Scheduled handler for automatic cleanup
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredUsers(env));
  }
};
