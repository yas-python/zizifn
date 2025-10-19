/**
 * Ultimate VLESS Proxy Worker Script (Version 7.0 - Stabilized)
 *
 * This script provides a comprehensive solution for a VLESS proxy on Cloudflare Workers,
 * integrating advanced features with robust connection logic.
 *
 * Features:
 * - Full-featured Admin Panel: CRUD user management, statistics dashboard.
 * - D1 Database Integration: Persists user data (UUID, limits, usage).
 * - KV Namespace Caching: Caches user data and admin sessions for performance.
 * - Per-User Limits:
 * - Expiration Date & Time
 * - Data Usage Limit (GB/MB)
 * - Concurrent IP Limit
 * - Critical Connection Logic: Implements the "retry-via-PROXYIP" mechanism to
 * bypass ISP blocks and ensure reliable connections.
 * - Smart Subscription: Generates subscription links (/xray/ & /sb/) with a
 * pool of clean IPs and domains.
 * - Full-featured User Config Page: Displays live network info (IP, ASN),
 * data usage, expiration, and subscription links for the end-user.
 * - Root Path Reverse Proxy: Proxies a specified URL at the root (/) path.
 *
 * --- [ CRITICAL SETUP INSTRUCTIONS ] ---
 *
 * 1.  CREATE D1 DATABASE:
 * - Go to Workers & Pages -> D1 -> Create database.
 * - Name it `DB` (or any name you prefer).
 *
 * 2.  INITIALIZE DATABASE TABLE:
 * - After creating `DB`, select it, go to "Console", and run this *exact* command:
 * `CREATE TABLE IF NOT EXISTS users (uuid TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TEXT NOT NULL, expiration_time TEXT NOT NULL, notes TEXT, data_limit INTEGER DEFAULT 0, data_usage INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 2);`
 *
 * 3.  CREATE KV NAMESPACE:
 * - Go to Workers & Pages -> KV -> Create namespace.
 * - Name it `USER_KV` (or any name you prefer).
 *
 * 4.  BIND SERVICES TO WORKER:
 * - Go to your Worker -> Settings -> Bindings.
 * - Add D1 Database Binding:
 * - Variable name: `DB`
 * - D1 Database: Select the `DB` you created.
 * - Add KV Namespace Binding:
 * - Variable name: `USER_KV`
 * - KV Namespace: Select the `USER_KV` you created.
 *
 * 5.  SET ENVIRONMENT VARIABLES (SECRETS):
 * - Go to your Worker -> Settings -> Variables -> "Edit variables".
 * - Add these secrets:
 * - `ADMIN_KEY`: (Required) Your password for the /admin panel.
 * - `PROXYIP`: (CRITICAL) A clean Cloudflare IP. Example: `104.20.12.34`
 * - `UUID`: (Optional) A fallback UUID.
 * - `ADMIN_PATH`: (Optional) A secret admin path. Defaults to `/admin`.
 *
 * 6.  SAVE AND DEPLOY.
 */

import { connect } from 'cloudflare:sockets';

// --- Constants and Configuration ---
const CONST = {
    VLESS_VERSION: 0,
    WS_READY_STATE: { OPEN: 1, CLOSING: 2 },
};

const Config = {
    defaultUserID: 'd342d11e-d424-4583-b36e-524ab1f0afa4', // Fallback UUID

    fromEnv(env) {
        const adminPath = (env.ADMIN_PATH || '/admin').replace(/^\//, '');
        const candidate = env.PROXYIP;

        if (!candidate) {
            console.warn("Warning: PROXYIP environment variable is not set. Connection reliability will be severely impacted. Please set it to a clean IP.");
        }

        const [proxyHost, proxyPort = '443'] = candidate ? candidate.split(':') : [null, '443'];

        return {
            userID: env.UUID || this.defaultUserID,
            adminPath: `/${adminPath}`,
            proxyIP: proxyHost,
            proxyPort,
            proxyAddress: candidate,
            scamalytics: {
                apiKey: env.SCAMALYTICS_API_KEY || null,
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
  if (limit <= 0) return true; // 0 or less means unlimited
  return (Number(user?.data_usage ?? 0) + projectedUsage) < limit;
}

function bytesToReadable(bytes = 0) {
    if (bytes <= 0) return '0 Bytes';
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / (1024 ** i)).toFixed(2))} ${units[i]}`;
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
  // This operation is "fire and forget" to not slow down the connection.
  await env.DB.prepare(`UPDATE users SET data_usage = data_usage + ? WHERE uuid = ?`)
    .bind(Math.round(bytes), uuid)
    .run();
  // Invalidate cache so next request gets fresh data
  await env.USER_KV.delete(`user:${uuid}`);
}


// --- Admin Panel ---
// This section is feature-complete and includes the advanced dashboard.
// All HTML/CSS/JS is correctly embedded within template literals (``) to avoid syntax errors.

const adminLoginHTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background-color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.login-container{background-color:#1F2937;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;width:320px;border:1px solid #374151}h1{color:#F9FAFB;margin-bottom:24px;font-weight:500}form{display:flex;flex-direction:column}input[type=password]{background-color:#374151;border:1px solid #4B5563;color:#F9FAFB;padding:12px;border-radius:8px;margin-bottom:20px;font-size:16px;transition:border-color .2s,box-shadow .2s}input[type=password]:focus{outline:0;border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}button{background-color:#3B82F6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background-color .2s}button:hover{background-color:#2563EB}.error{color:#EF4444;margin-top:15px;font-size:14px}</style></head><body><div class="login-container"><h1>Admin Login</h1><form method="POST"><input type="password" name="password" placeholder="••••••••••••••" required><button type="submit">Login</button></form></div></body></html>`;

const adminPanelHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admin Dashboard</title>
    <style>
        :root {
            --bg-main: #0c0a09;
            --bg-card: #1c1917;
            --bg-input: #292524;
            --border: #44403c;
            --text-primary: #f5f5f4;
            --text-secondary: #a8a29e;
            --accent: #fb923c;
            --accent-hover: #f97316;
            --danger: #ef4444;
            --danger-hover: #dc2626;
            --success: #4ade80;
            --expired: #facc15;
            --btn-secondary-bg: #57534e;
            --btn-secondary-hover: #78716c;
        }
        body {
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-main);
            color: var(--text-primary);
            font-size: 14px;
        }
        .container { max-width: 1280px; margin: 30px auto; padding: 0 20px; }
        .card { background-color: var(--bg-card); border-radius: 12px; padding: 24px; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background-color: var(--bg-card); border-radius: 12px; padding: 20px; border: 1px solid var(--border); transition: transform 0.2s, box-shadow 0.2s; }
        .stat-card:hover { transform: translateY(-5px); box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4); }
        .stat-title { font-size: 14px; color: var(--text-secondary); margin: 0 0 10px; }
        .stat-value { font-size: 28px; font-weight: 600; margin: 0; }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; align-items: flex-end; }
        .form-group { display: flex; flex-direction: column; }
        label { margin-bottom: 8px; font-weight: 500; color: var(--text-secondary); }
        .input-group { display: flex; }
        input, select { width: 100%; box-sizing: border-box; background-color: var(--bg-input); border: 1px solid var(--border); color: var(--text-primary); padding: 10px; border-radius: 6px; font-size: 14px; transition: border-color 0.2s, box-shadow 0.2s; }
        input:focus, select:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(251, 146, 60, 0.3); }
        .btn { padding: 10px 16px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        .btn:active { transform: scale(0.97); }
        .btn-primary { background-color: var(--accent); color: var(--bg-main); }
        .btn-primary:hover { background-color: var(--accent-hover); }
        .btn-danger { background-color: var(--danger); color: #fff; }
        .btn-danger:hover { background-color: var(--danger-hover); }
        .btn-secondary { background-color: var(--btn-secondary-bg); color: #fff; }
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
        #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background-color: var(--bg-card); color: #fff; padding: 15px 25px; border-radius: 8px; z-index: 1001; display: none; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); opacity: 0; transition: all 0.3s; }
        #toast.show { display: block; opacity: 1; transform: translate(-50%, -10px); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
        .modal-overlay.show { opacity: 1; visibility: visible; }
        .modal-content { background-color: var(--bg-card); padding: 30px; border-radius: 12px; width: 90%; max-width: 550px; transform: scale(0.9); transition: transform 0.3s; border: 1px solid var(--border); }
        .modal-overlay.show .modal-content { transform: scale(1); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
        .modal-header h2 { margin: 0; font-size: 20px; }
        .modal-close-btn { background: 0 0; border: none; color: var(--text-secondary); font-size: 24px; cursor: pointer; }
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
                <input type="hidden" id="csrf_token" name="csrf_token" />
                <div class="form-group" style="grid-column: 1 / -1">
                    <label for="uuid">UUID</label>
                    <div class="input-group">
                        <input type="text" id="uuid" required />
                        <button type="button" id="generateUUID" class="btn btn-secondary">Generate</button>
                    </div>
                </div>
                <div class="form-group">
                    <label for="expiryDate">Expiry Date</label>
                    <input type="date" id="expiryDate" required />
                </div>
                <div class="form-group">
                    <label for="expiryTime">Expiry Time (Your Local Time)</label>
                    <input type="time" id="expiryTime" step="1" required />
                </div>
                <div class="form-group">
                    <label for="dataLimit">Data Limit</label>
                    <div class="input-group">
                        <input type="number" id="dataLimitValue" placeholder="e.g., 10" />
                        <select id="dataLimitUnit">
                            <option value="GB">GB</option>
                            <option value="MB">MB</option>
                        </select>
                        <button type="button" id="unlimitedBtn" class="btn btn-secondary">Unlimited</button>
                    </div>
                </div>
                <div class="form-group">
                    <label for="ipLimit">IP Limit</label>
                    <input type="number" id="ipLimit" value="2" placeholder="e.g., 2" />
                </div>
                <div class="form-group">
                    <label for="notes">Notes</label>
                    <input type="text" id="notes" placeholder="(Optional)" />
                </div>
                <div class="form-group" style="grid-column: 1 / -1; align-items: flex-start; margin-top: 10px">
                    <button type="submit" class="btn btn-primary">Create User</button>
                </div>
            </form>
        </div>
        <div class="card" style="margin-top: 30px">
            <h2>User List</h2>
            <div class="user-list-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>UUID</th>
                            <th>Created</th>
                            <th>Expiry</th>
                            <th>Status</th>
                            <th>Traffic</th>
                            <th>IP Limit</th>
                            <th>Notes</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
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
            <form id="editUserForm" class="form-grid">
                <input type="hidden" id="editUuid" name="uuid" />
                <div class="form-group">
                    <label for="editExpiryDate">Expiry Date</label>
                    <input type="date" id="editExpiryDate" name="exp_date" required />
                </div>
                <div class="form-group">
                    <label for="editExpiryTime">Expiry Time (Your Local Time)</label>
                    <input type="time" id="editExpiryTime" name="exp_time" step="1" required />
                </div>
                <div class="form-group">
                    <label for="editDataLimit">Data Limit</label>
                    <div class="input-group">
                        <input type="number" id="editDataLimitValue" placeholder="e.g., 10" />
                        <select id="editDataLimitUnit">
                            <option value="GB">GB</option>
                            <option value="MB">MB</option>
                        </select>
                        <button type="button" id="editUnlimitedBtn" class="btn btn-secondary">Unlimited</button>
                    </div>
                </div>
                <div class="form-group">
                    <label for="editIpLimit">IP Limit</label>
                    <input type="number" id="editIpLimit" placeholder="e.g., 2" />
                </div>
                <div class="form-group" style="grid-column: 1 / -1">
                    <label for="editNotes">Notes</label>
                    <input type="text" id="editNotes" name="notes" placeholder="(Optional)" />
                </div>
                <div class="form-group form-check" style="grid-column: 1 / -1">
                    <input type="checkbox" id="resetTraffic" />
                    <label for="resetTraffic">Reset Traffic Usage</label>
                </div>
                <div class="modal-footer" style="grid-column: 1 / -1">
                    <button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button>
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                </div>
            </form>
        </div>
    </div>
    <script>
        document.addEventListener("DOMContentLoaded", () => {
            const adminPath = document.body.getAttribute("data-admin-path");
            const API_BASE = `${adminPath}/api`;
            const csrfToken = document.getElementById("csrf_token").value;
            const apiHeaders = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };

            const api = {
                get: (url) => fetch(`${API_BASE}${url}`).then(handleResponse),
                post: (url, data) => fetch(`${API_BASE}${url}`, { method: "POST", headers: apiHeaders, body: JSON.stringify(data) }).then(handleResponse),
                put: (url, data) => fetch(`${API_BASE}${url}`, { method: "PUT", headers: apiHeaders, body: JSON.stringify(data) }).then(handleResponse),
                delete: (url) => fetch(`${API_BASE}${url}`, { method: "DELETE", headers: apiHeaders }).then(handleResponse),
            };

            async function handleResponse(response) {
                if (response.status === 403) {
                    showToast("Session expired or invalid. Please refresh and log in again.", true);
                    throw new Error("Forbidden: Invalid session or CSRF token.");
                }
                if (!response.ok) {
                    const errData = await response.json().catch(() => ({ error: "An unknown error occurred." }));
                    throw new Error(errData.error || `Request failed with status ${response.status}`);
                }
                return response.status === 204 ? null : response.json();
            }

            function showToast(message, isError = false) {
                const toast = document.getElementById("toast");
                toast.textContent = message;
                toast.style.backgroundColor = isError ? "var(--danger)" : "var(--success)";
                toast.classList.add("show");
                setTimeout(() => { toast.classList.remove("show"); }, 3000);
            }

            const pad = (n) => n.toString().padStart(2, "0");

            const localToUTC = (localDate, localTime) => {
                if (!localDate || !localTime) return { utcDate: "", utcTime: "" };
                const date = new Date(`${localDate}T${localTime}`);
                if (isNaN(date)) return { utcDate: "", utcTime: "" };
                return {
                    utcDate: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
                    utcTime: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
                };
            };

            const utcToLocal = (utcDate, utcTime) => {
                if (!utcDate || !utcTime) return { localDate: "", localTime: "" };
                const date = new Date(`${utcDate}T${utcTime}Z`);
                if (isNaN(date)) return { localDate: "", localTime: "" };
                return {
                    localDate: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
                    localTime: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
                };
            };

            function bytesToReadable(bytes) {
                if (bytes <= 0) return "0 Bytes";
                const i = Math.floor(Math.log(bytes) / Math.log(1024));
                return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${["Bytes", "KB", "MB", "GB", "TB"][i]}`;
            }

            function renderStats(stats) {
                document.getElementById("stats").innerHTML = `
                    <div class="stat-card"><h3 class="stat-title">Total Users</h3><p class="stat-value">${stats.totalUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Active Users</h3><p class="stat-value">${stats.activeUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Expired Users</h3><p class="stat-value">${stats.expiredUsers}</p></div>
                    <div class="stat-card"><h3 class="stat-title">Total Traffic</h3><p class="stat-value">${bytesToReadable(stats.totalTraffic)}</p></div>
                `;
            }

            function renderUsers(users) {
                const userList = document.getElementById("userList");
                if (users.length === 0) {
                    userList.innerHTML = '<tr><td colspan="8" style="text-align:center;">No users found.</td></tr>';
                    return;
                }
                userList.innerHTML = users.map((user) => {
                        const expiry = new Date(`${user.expiration_date}T${user.expiration_time}Z`);
                        const isExpired = expiry < new Date();
                        const traffic = user.data_limit > 0 ? `${bytesToReadable(user.data_usage)} / ${bytesToReadable(user.data_limit)}` : `${bytesToReadable(user.data_usage)} / &infin;`;
                        const trafficPercent = user.data_limit > 0 ? Math.min(100, (user.data_usage / user.data_limit) * 100) : 0;
                        return `
                            <tr data-uuid="${user.uuid}">
                                <td title="${user.uuid}">${user.uuid.substring(0, 8)}...</td>
                                <td>${new Date(user.created_at).toLocaleString()}</td>
                                <td>${expiry.toLocaleString()}</td>
                                <td><span class="status-badge ${isExpired ? "status-expired" : "status-active"}">${isExpired ? "Expired" : "Active"}</span></td>
                                <td>
                                    ${traffic}
                                    <div class="traffic-bar"><div class="traffic-bar-inner" style="width: ${trafficPercent}%;"></div></div>
                                </td>
                                <td>${user.ip_limit > 0 ? user.ip_limit : "Unlimited"}</td>
                                <td>${user.notes || "-"}</td>
                                <td class="actions-cell">
                                    <button class="btn btn-secondary btn-edit">Edit</button>
                                    <button class="btn btn-danger btn-delete">Delete</button>
                                </td>
                            </tr>
                        `;
                    }).join("");
            }

            async function refreshData() {
                try {
                    const [stats, users] = await Promise.all([api.get("/stats"), api.get("/users")]);
                    window.allUsers = users; // Cache for edit modal
                    renderStats(stats);
                    renderUsers(users);
                } catch (err) {
                    showToast(err.message, true);
                }
            }

            const getLimitInBytes = (valueId, unitId) => {
                const value = parseFloat(document.getElementById(valueId).value);
                const unit = document.getElementById(unitId).value;
                if (isNaN(value) || value <= 0) return 0;
                return Math.round(value * (unit === "GB" ? 1024 * 1024 * 1024 : 1024 * 1024));
            };

            const setLimitFromBytes = (bytes, valueId, unitId) => {
                const valueEl = document.getElementById(valueId);
                const unitEl = document.getElementById(unitId);
                if (bytes <= 0) {
                    valueEl.value = "";
                    unitEl.value = "GB";
                    return;
                }
                const isGB = bytes >= 1024 * 1024 * 1024;
                const unit = isGB ? "GB" : "MB";
                const divisor = isGB ? 1024 * 1024 * 1024 : 1024 * 1024;
                valueEl.value = parseFloat((bytes / divisor).toFixed(2));
                unitEl.value = unit;
            };

            document.getElementById("createUserForm").addEventListener("submit", async (e) => {
                e.preventDefault();
                const { utcDate, utcTime } = localToUTC(document.getElementById("expiryDate").value, document.getElementById("expiryTime").value);
                const data = {
                    uuid: document.getElementById("uuid").value,
                    exp_date: utcDate,
                    exp_time: utcTime,
                    data_limit: getLimitInBytes("dataLimitValue", "dataLimitUnit"),
                    ip_limit: parseInt(document.getElementById("ipLimit").value, 10) || 0,
                    notes: document.getElementById("notes").value,
                };
                try {
                    await api.post("/users", data);
                    showToast("User created successfully!");
                    e.target.reset();
                    document.getElementById("uuid").value = crypto.randomUUID();
                    setDefaultExpiry();
                    refreshData();
                } catch (err) {
                    showToast(err.message, true);
                }
            });

            const editModal = document.getElementById("editModal");

            document.getElementById("userList").addEventListener("click", (e) => {
                const btn = e.target.closest("button");
                if (!btn) return;

                const uuid = e.target.closest("tr").dataset.uuid;

                if (btn.classList.contains("btn-edit")) {
                    const user = window.allUsers.find((u) => u.uuid === uuid);
                    if (!user) return;
                    const { localDate, localTime } = utcToLocal(user.expiration_date, user.expiration_time);
                    document.getElementById("editUuid").value = user.uuid;
                    document.getElementById("editExpiryDate").value = localDate;
                    document.getElementById("editExpiryTime").value = localTime;
                    setLimitFromBytes(user.data_limit, "editDataLimitValue", "editDataLimitUnit");
                    document.getElementById("editIpLimit").value = user.ip_limit;
                    document.getElementById("editNotes").value = user.notes || "";
                    document.getElementById("resetTraffic").checked = false;
                    editModal.classList.add("show");
                } else if (btn.classList.contains("btn-delete")) {
                    if (confirm(`Are you sure you want to delete user ${uuid.substring(0, 8)}...?`)) {
                        api.delete(`/users/${uuid}`).then(() => {
                            showToast("User deleted successfully!");
                            refreshData();
                        }).catch((err) => showToast(err.message, true));
                    }
                }
            });

            document.getElementById("editUserForm").addEventListener("submit", async (e) => {
                e.preventDefault();
                const uuid = document.getElementById("editUuid").value;
                const { utcDate, utcTime } = localToUTC(document.getElementById("editExpiryDate").value, document.getElementById("editExpiryTime").value);
                const data = {
                    exp_date: utcDate,
                    exp_time: utcTime,
                    data_limit: getLimitInBytes("editDataLimitValue", "editDataLimitUnit"),
                    ip_limit: parseInt(document.getElementById("editIpLimit").value, 10) || 0,
                    notes: document.getElementById("editNotes").value,
                    reset_traffic: document.getElementById("resetTraffic").checked,
                };

                try {
                    await api.put(`/users/${uuid}`, data);
                    showToast("User updated successfully!");
                    editModal.classList.remove("show");
                    refreshData();
                } catch (err) {
                    showToast(err.message, true);
                }
            });

            const closeModal = () => editModal.classList.remove("show");
            document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
            document.getElementById("modalCancelBtn").addEventListener("click", closeModal);
            editModal.addEventListener("click", (e) => {
                if (e.target === editModal) closeModal();
            });
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape") closeModal();
            });

            document.getElementById("generateUUID").addEventListener("click", () => {
                document.getElementById("uuid").value = crypto.randomUUID();
            });
            document.getElementById("unlimitedBtn").addEventListener("click", () => {
                document.getElementById("dataLimitValue").value = "";
            });
            document.getElementById("editUnlimitedBtn").addEventListener("click", () => {
                document.getElementById("editDataLimitValue").value = "";
            });

            const setDefaultExpiry = () => {
                const d = new Date();
                d.setMonth(d.getMonth() + 1);
                document.getElementById("expiryDate").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                document.getElementById("expiryTime").value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            };

            document.getElementById("uuid").value = crypto.randomUUID();
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
        const headers = new Headers({ 'Set-Cookie': `auth_token=; Path=${adminPath}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
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

    if (pathname.startsWith(`${cfg.adminPath}/api/`)) {
        const { isAdmin, errorResponse } = await checkAdminAuth(request, env);
        if (errorResponse) return errorResponse;
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });

        try {
            if (pathname.endsWith('/stats') && request.method === 'GET') {
                const { results } = await env.DB.prepare("SELECT expiration_date, expiration_time, data_usage FROM users").all();
                const now = new Date();
                const stats = {
                    totalUsers: results.length,
                    activeUsers: results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) > now).length,
                    expiredUsers: results.length - results.filter(u => new Date(`${u.expiration_date}T${u.expiration_time}Z`) <= now).length,
                    totalTraffic: results.reduce((sum, u) => sum + (u.data_usage || 0), 0)
                };
                return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeader });
            }
            
            if (pathname.endsWith('/users') && request.method === 'GET') {
                const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
            }
    
            if (pathname.endsWith('/users') && request.method === 'POST') {
                const { uuid, exp_date, exp_time, notes, data_limit, ip_limit } = await request.json();
                if (!uuid || !exp_date || !exp_time || !isValidUUID(uuid)) throw new Error('Invalid or missing fields.');
                
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, data_limit, ip_limit) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(uuid, exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, ip_limit >= 0 ? ip_limit : 2).run();
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            }
    
            const userRouteMatch = pathname.match(new RegExp(`^${cfg.adminPath}/api/users/([a-f0-9-]+)$`));
            if (userRouteMatch) {
                const uuid = userRouteMatch[1];
                if (request.method === 'PUT') {
                    const { exp_date, exp_time, notes, data_limit, ip_limit, reset_traffic } = await request.json();
                    if (!exp_date || !exp_time) throw new Error('Invalid date/time fields.');
    
                    const sql = `UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, data_limit = ?, ip_limit = ? ${reset_traffic ? ', data_usage = 0' : ''} WHERE uuid = ?`;
                    await env.DB.prepare(sql).bind(exp_date, exp_time, notes || null, data_limit >= 0 ? data_limit : 0, ip_limit >= 0 ? ip_limit : 2, uuid).run();
                    await env.USER_KV.delete(`user:${uuid}`); // Invalidate cache
                    return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
                }
                if (request.method === 'DELETE') {
                    await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                    await env.USER_KV.delete(`user:${uuid}`);
                    await env.USER_KV.delete(`conn_ips:${uuid}`);
                    return new Response(null, { status: 204 });
                }
            }
            return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
        
        } catch (err) {
            console.error('Admin API error:', err);
            return new Response(JSON.stringify({ error: err.message || 'An internal error occurred' }), { status: 400, headers: jsonHeader });
        }
    }

    if (pathname === cfg.adminPath) {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const sessionToken = crypto.randomUUID();
                const csrfToken = crypto.randomUUID();
                await env.USER_KV.put(`admin_session:${sessionToken}`, JSON.stringify({ csrfToken }), { expirationTtl: 86400 });
                return new Response(null, { status: 302, headers: {
                    'Location': cfg.adminPath,
                    'Set-Cookie': `auth_token=${sessionToken}; HttpOnly; Secure; Path=${cfg.adminPath}; Max-Age=86400; SameSite=Strict`
                }});
            } else {
                return new Response(adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
        
        const { isAdmin, csrfToken, errorResponse } = await checkAdminAuth(request, env);
        if (errorResponse) return errorResponse;
        
        if (isAdmin) {
            const panelWithContext = adminPanelHTML
                .replace('<input type="hidden" id="csrf_token" name="csrf_token" />', `<input type="hidden" id="csrf_token" name="csrf_token" value="${csrfToken}">`)
                .replace('<body>', `<body data-admin-path="${cfg.adminPath}">`);
            return new Response(panelWithContext, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
        } else {
            return new Response(adminLoginHTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
        }
    }

    return null;
}

// --- Core VLESS & Subscription Logic ---

async function ProtocolOverWSHandler(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
    const log = (info, event) => console.log(`[${request.headers.get('CF-Connecting-IP')}] ${info}`, event || '');
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
    const cfg = Config.fromEnv(env);

    let remoteSocketWrapper = { value: null };
    let activeUser = null;
    let initialUsage = 0;
    let usageDown = 0;
    let usageUp = 0;

    const incrementDown = (bytes) => { usageDown += bytes; };
    const incrementUp = (bytes) => { usageUp += bytes; };

    const checkAndTerminate = () => {
        if (activeUser && activeUser.data_limit > 0 && (initialUsage + usageDown + usageUp) >= activeUser.data_limit) {
            log(`User ${activeUser.uuid} exceeded data cap mid-session.`);
            safeCloseWebSocket(webSocket);
            remoteSocketWrapper.value?.close?.();
            return true;
        }
        return false;
    };
    
    ctx.waitUntil((async () => {
        await readableWebSocketStream.pipeTo(new WritableStream({
            async write(chunk, controller) {
                incrementDown(chunk.byteLength);
                if (checkAndTerminate()) return;

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

                if (isExpired(user.expiration_date, user.expiration_time) || !hasRemainingData(user)) {
                    controller.error(new Error('User expired or data limit reached.'));
                    return;
                }
                
                const clientIP = request.headers.get('CF-Connecting-IP');
                if (user.ip_limit > 0) {
                    const key = `conn_ips:${user.uuid}`;
                    let activeIPs = (await env.USER_KV.get(key, 'json')) || [];
                    activeIPs = activeIPs.filter(entry => entry.exp > Date.now());
                    
                    if (activeIPs.length >= user.ip_limit && !activeIPs.some(e => e.ip === clientIP)) {
                        controller.error(new Error(`IP limit of ${user.ip_limit} reached.`));
                        return;
                    }
                    if (!activeIPs.some(e => e.ip === clientIP)) {
                        activeIPs.push({ ip: clientIP, exp: Date.now() + 65000 }); // 65-second expiry
                        ctx.waitUntil(env.USER_KV.put(key, JSON.stringify(activeIPs), { expirationTtl: 120 }));
                    }
                }
                
                const vlessResponseHeader = new Uint8Array([CONST.VLESS_VERSION, 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                if (isUDP) {
                    // UDP is not supported in this simple TCP-based handler
                    controller.error(new Error('UDP proxying is not supported.'));
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
                    cfg,
                    incrementUp,
                    checkAndTerminate
                );
            },
            close() { log('Client WebSocket stream closed.'); },
            abort(err) { log('Client WebSocket stream aborted:', err); },
        }));
    })().catch(err => {
        console.error('VLESS pipeline failed:', err.stack || err);
        safeCloseWebSocket(webSocket);
    }).finally(() => {
        if (activeUser?.uuid) {
            const total = usageDown + usageUp;
            if (total > 0) {
                ctx.waitUntil(updateUserUsage(env, activeUser.uuid, total));
            }
        }
    }));
    
    return new Response(null, { status: 101, webSocket: client });
}

async function processVlessHeader(vlessBuffer, env) {
    if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'invalid vless header' };
    
    const view = new DataView(vlessBuffer);
    if (view.getUint8(0) !== CONST.VLESS_VERSION) return { hasError: true, message: 'invalid vless version' };

    const uuid = unsafeStringify(new Uint8Array(vlessBuffer.slice(1, 17)));
    const user = await getUserData(env, uuid);
    if (!user) return { hasError: true, message: 'user not found' };

    const optLen = view.getUint8(17);
    const command = view.getUint8(18 + optLen); // 1 = TCP, 2 = UDP
    if (command !== 1 && command !== 2) return { hasError: true, message: `unsupported command: ${command}`};

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

    return { user, hasError: false, addressType: addrType, addressRemote: address, portRemote: port, rawDataIndex, isUDP: command === 2 };
}

// THIS IS THE CRITICAL, CORRECTED CONNECTION FUNCTION
async function HandleTCPOutBound(remoteSocket, addressType, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, config, countUp, checkTerminate) {
  
    async function connectAndWrite(address, port) {
        const tcpSocket = await connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        log(`Connected to ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    // The retry function is the key. It connects to the PROXYIP instead of the original destination.
    async function retry() {
        // If PROXYIP is not set, this will fail, which is the expected behavior for a misconfiguration.
        if (!config.proxyIP) {
            log('Retry failed: PROXYIP is not configured.');
            safeCloseWebSocket(webSocket);
            return;
        }
        log(`Retrying connection via proxy: ${config.proxyIP}:${config.proxyPort}`);
        const tcpSocket = await connectAndWrite(config.proxyIP, config.proxyPort);
        
        tcpSocket.closed.catch(error => {
            log('Proxy connection closed with error:', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        });
        
        // After connecting to the proxy, we start piping data. The VLESS protocol ensures the proxy
        // knows the real destination (addressRemote).
        RemoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log, countUp, checkTerminate);
    }

    // First, try a direct connection. This will often be blocked by ISPs.
    try {
        log(`Attempting direct connection to ${addressRemote}:${portRemote}`);
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        RemoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log, countUp, checkTerminate);
    } catch (error) {
        log(`Direct connection to ${addressRemote}:${portRemote} failed: ${error.message}. Calling retry().`);
        // If the direct connection fails, we immediately call retry().
        await retry();
    }
}

async function RemoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log, countUp, checkTerminate) {
    let hasIncomingData = false;
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState !== CONST.WS_READY_STATE.OPEN) throw new Error('WebSocket is not open');
                    
                    countUp(chunk.byteLength); // Count upstream traffic
                    if (checkTerminate()) return; // Check data limit after counting
                    
                    hasIncomingData = true;
                    // Send VLESS response header (if not already sent) + remote data
                    const dataToSend = vlessResponseHeader ? await new Blob([vlessResponseHeader, chunk]).arrayBuffer() : chunk;
                    webSocket.send(dataToSend);
                    vlessResponseHeader = null; // Clear header after sending it once
                },
                close() {
                    log(`Remote connection readable closed. Had incoming data: ${hasIncomingData}`);
                },
                abort(reason) {
                    console.error('Remote connection readable aborted:', reason);
                },
            })
        );
    } catch (error) {
        console.error('RemoteSocketToWS pipe failed:', error.stack || error);
        safeCloseWebSocket(webSocket);
    }

    // If the first connection attempt (direct) had no data and then closed, it's a sign it was blocked.
    // The `retry` function is passed for this specific case.
    if (!hasIncomingData && retry) {
        log('Initial connection had no incoming data, triggering retry mechanism.');
        await retry();
    }
}


// --- Subscription and Config Page ---

const ed_2560_params = { ed: 2560, eh: 'Sec-WebSocket-Protocol' };

function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: { tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} } },
  sb: { tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: ed_2560_params } },
};

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path });
  if (security) params.set('security', security);
  if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp);
  if (alpn) params.set('alpn', alpn);
  Object.entries(extra).forEach(([k, v]) => params.set(k, v));
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function fetchSmartIpPool() {
  const url = 'https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json';
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600 } }); // Cache for 1 hour
    if (!res.ok) return [];
    const json = await res.json();
    return [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].map(item => item.ip).filter(Boolean);
  } catch (err) {
    console.warn(`Smart IP pool fetch failed:`, err.message);
    return [];
  }
}

async function handleIpSubscription(core, userID, hostName, env) {
  const mainDomains = [ hostName, 'creativecommons.org', 'www.speedtest.net', 'zula.ir' ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const links = [];
  const preset = CORE_PRESETS[core]['tls'];

  mainDomains.forEach((domain, i) => {
    links.push(createVlessLink({
      userID, address: domain, port: pick(httpsPorts), host: hostName,
      path: preset.path(), security: preset.security, sni: hostName, fp: preset.fp, alpn: preset.alpn, extra: preset.extra,
      name: `D${i + 1}-TLS`
    }));
  });

  const smartIPs = await fetchSmartIpPool();
  smartIPs.slice(0, 40).forEach((ip, i) => { // Limit to 40 IPs
    const formatted = ip.includes(':') ? `[${ip}]` : ip; // Format IPv6
    links.push(createVlessLink({
      userID, address: formatted, port: pick(httpsPorts), host: hostName,
      path: preset.path(), security: preset.security, sni: hostName, fp: preset.fp, alpn: preset.alpn, extra: preset.extra,
      name: `IP${i + 1}-TLS`
    }));
  });

  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

// This is the full-featured user config page
async function handleConfigPage(request, userID, hostName, cfg, userData) {
    
    async function fetchNetworkInfo(request, scamalyticsKey) {
        const ip = request.headers.get('CF-Connecting-IP');
        const asn = request.cf?.asn;
        const asOrganization = request.cf?.asOrganization;
        const country = request.cf?.country;
        let riskScore = 'N/A';

        if (scamalyticsKey) {
            try {
                // Use cf object to bypass cache for this specific API call
                const res = await fetch(`https://api.scamalytics.com/ip/${ip}?key=${scamalyticsKey}`, { cf: { cacheTtl: 0 } });
                const data = await res.json();
                if (data.score) {
                    riskScore = `${data.score} (${data.risk})`;
                }
            } catch (e) {
                console.error('Scamalytics fetch failed:', e);
            }
        }

        return { ip, asn, asOrganization, country, riskScore };
    }

    const netInfo = await fetchNetworkInfo(request, cfg.scamalytics.apiKey);
    
    const subXrayUrl = `https://${hostName}/xray/${userID}`;
    const subSbUrl = `https://${hostName}/sb/${userID}`;
    
    const utcTimestamp = `${userData.expiration_date}T${userData.expiration_time.split('.')[0]}Z`;
    const dataUsed = bytesToReadable(userData.data_usage);
    const dataLimit = userData.data_limit > 0 ? bytesToReadable(userData.data_limit) : 'Unlimited';
    const dataPercent = userData.data_limit > 0 ? Math.min(100, (userData.data_usage / userData.data_limit) * 100).toFixed(2) : 0;
    const status = isExpired(userData.expiration_date, userData.expiration_time) ? 'Expired' : 'Active';
    const statusClass = status === 'Active' ? 'status-active' : 'status-expired';

    // This HTML is correctly embedded in a template literal
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>User Configuration</title>
        <style>
            :root {
                --bg-main: #111827;
                --bg-card: #1F2937;
                --border: #374151;
                --text-primary: #F9FAFB;
                --text-secondary: #9CA3AF;
                --accent: #3B82F6;
                --accent-hover: #2563EB;
                --success: #10B981;
                --danger: #EF4444;
                --progress-bg: #374151;
            }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                background-color: var(--bg-main);
                color: var(--text-primary);
                margin: 0;
                padding: 20px;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                box-sizing: border-box;
            }
            .container {
                width: 100%;
                max-width: 700px;
                background-color: var(--bg-card);
                border-radius: 12px;
                border: 1px solid var(--border);
                box-shadow: 0 4px 20px rgba(0,0,0,.3);
                overflow: hidden;
            }
            header {
                padding: 24px;
                border-bottom: 1px solid var(--border);
            }
            header h1 {
                margin: 0;
                font-size: 24px;
            }
            header p {
                margin: 4px 0 0;
                color: var(--text-secondary);
                font-size: 14px;
                word-break: break-all;
            }
            .status-badge {
                display: inline-block;
                padding: 4px 12px;
                border-radius: 16px;
                font-size: 14px;
                font-weight: 600;
                margin-top: 16px;
            }
            .status-active { background-color: var(--success); color: #fff; }
            .status-expired { background-color: var(--danger); color: #fff; }
            
            .card-body { padding: 24px; }
            .info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
            }
            .info-item {
                background-color: var(--bg-main);
                padding: 16px;
                border-radius: 8px;
                border: 1px solid var(--border);
            }
            .info-item h3 {
                margin: 0 0 8px;
                font-size: 14px;
                color: var(--text-secondary);
                font-weight: 500;
            }
            .info-item p {
                margin: 0;
                font-size: 16px;
                font-weight: 600;
                word-wrap: break-word;
            }
            
            .traffic-info {
                margin-top: 20px;
            }
            .traffic-header {
                display: flex;
                justify-content: space-between;
                font-size: 14px;
                margin-bottom: 8px;
            }
            .traffic-header span:first-child { color: var(--text-secondary); }
            .progress-bar {
                width: 100%;
                height: 10px;
                background-color: var(--progress-bg);
                border-radius: 5px;
                overflow: hidden;
            }
            .progress-bar-inner {
                height: 100%;
                width: ${dataPercent}%;
                background-color: var(--accent);
                border-radius: 5px;
                transition: width 0.3s ease;
            }
            
            .section-title {
                font-size: 18px;
                font-weight: 600;
                margin: 24px 0 16px;
                padding-bottom: 8px;
                border-bottom: 1px solid var(--border);
            }
            
            .sub-links .info-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .sub-links p {
                font-size: 14px;
                font-weight: 400;
                color: var(--text-secondary);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-right: 16px;
            }
            .copy-btn {
                background-color: var(--accent);
                color: #fff;
                border: none;
                padding: 8px 16px;
                border-radius: 6px;
                font-weight: 600;
                cursor: pointer;
                transition: background-color 0.2s;
                flex-shrink: 0;
            }
            .copy-btn:hover { background-color: var(--accent-hover); }
            .copy-btn.copied { background-color: var(--success); }

            @media (max-width: 600px) {
                body { padding: 10px; }
                header { text-align: center; }
                .info-grid { grid-template-columns: 1fr; }
                .sub-links .info-item { flex-direction: column; align-items: flex-start; }
                .sub-links p { margin-right: 0; margin-bottom: 12px; }
                .copy-btn { width: 100%; justify-content: center; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <header>
                <h1>User Status</h1>
                <p>${userID}</p>
                <div class="status-badge ${statusClass}">${status}</div>
            </header>
            <div class="card-body">
                <div class="info-grid">
                    <div class="info-item">
                        <h3>Expires On</h3>
                        <p id="expiry-date" data-utc-time="${utcTimestamp}">Loading...</p>
                    </div>
                    <div class="info-item">
                        <h3>IP Address</h3>
                        <p>${netInfo.ip}</p>
                    </div>
                    <div class="info-item">
                        <h3>Network</h3>
                        <p>${netInfo.asOrganization} (ASN ${netInfo.asn})</p>
                    </div>
                    <div class="info-item">
                        <h3>Region</h3>
                        <p>${netInfo.country}</p>
                    </div>
                </div>

                <h3 class="section-title">Data Usage</h3>
                <div class="traffic-info">
                    <div class="traffic-header">
                        <span>${dataUsed} / ${dataLimit}</span>
                        <span>${dataPercent}%</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-bar-inner"></div>
                    </div>
                </div>

                <h3 class="section-title">Subscription Links</h3>
                <div class="info-grid sub-links">
                    <div class="info-item">
                        <p>${subXrayUrl}</p>
                        <button class="copy-btn" data-url="${subXrayUrl}">Copy XRay</button>
                    </div>
                    <div class="info-item">
                        <p>${subSbUrl}</p>
                        <button class="copy-btn" data-url="${subSbUrl}">Copy Sing-Box</button>
                    </div>
                </div>
            </div>
        </div>

        <script>
            // Convert UTC expiry date to local time
            try {
                const expEl = document.getElementById('expiry-date');
                const utcDate = new Date(expEl.dataset.utcTime);
                expEl.textContent = utcDate.toLocaleString();
            } catch (e) {
                expEl.textContent = 'Invalid Date';
            }

            // Copy button functionality
            document.querySelectorAll('.copy-btn').forEach(button => {
                button.addEventListener('click', () => {
                    const urlToCopy = button.dataset.url;
                    navigator.clipboard.writeText(urlToCopy).then(() => {
                        button.textContent = 'Copied!';
                        button.classList.add('copied');
                        setTimeout(() => {
                            button.textContent = button.dataset.url.includes('xray') ? 'Copy XRay' : 'Copy Sing-Box';
                            button.classList.remove('copied');
                        }, 2000);
                    }).catch(err => {
                        console.error('Failed to copy: ', err);
                        button.textContent = 'Failed';
                    });
                });
            });
        </script>
    </body>
    </html>
    `;
    
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}


// --- Main Fetch Handler ---
export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);
            const cfg = Config.fromEnv(env);
    
            // 1. Handle Admin Panel requests
            const adminResponse = await handleAdminRequest(request, env);
            if (adminResponse) return adminResponse;
            
            // 2. Handle WebSocket (VLESS) connections
            if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
                return ProtocolOverWSHandler(request, env, ctx);
            }

            // 3. Handle Subscription links
            const handleSubscription = async (core) => {
                const uuid = url.pathname.slice(`/${core}/`.length).split('/')[0];
                const user = await getUserData(env, uuid);
                if (!user || isExpired(user.expiration_date, user.expiration_time) || !hasRemainingData(user)) {
                    return new Response('Invalid, expired, or data limit reached user', { status: 403 });
                }
                return handleIpSubscription(core, uuid, url.hostname, env);
            };
            if (url.pathname.startsWith('/xray/')) return handleSubscription('xray');
            if (url.pathname.startsWith('/sb/')) return handleSubscription('sb');

            // 4. Handle User Config Page
            const path = url.pathname.slice(1);
            if (isValidUUID(path)) {
                const userData = await getUserData(env, path);
                if (!userData) {
                    return new Response('User not found', { status: 404 });
                }
                if (isExpired(userData.expiration_date, userData.expiration_time) || !hasRemainingData(userData)) {
                    return new Response('User expired or data limit reached', { status: 403 });
                }
                return handleConfigPage(request, path, url.hostname, cfg, userData);
            }
            
            // 5. Handle Root Path Reverse Proxy
            if (cfg.rootProxyURL && url.pathname === '/') {
                try {
                    const upstream = new URL(cfg.rootProxyURL);
                    const proxyRequest = new Request(upstream.href, request);
                    proxyRequest.headers.set('Host', upstream.hostname);
                    return fetch(proxyRequest);
                } catch (err) {
                    return new Response(`Proxy upstream error: ${err.message}`, { status: 502 });
                }
            }
            
            // 6. Fallback
            return new Response(`Not Found. Admin panel may be at ${cfg.adminPath}`, { status: 404 });
        
        } catch (err) {
            console.error('Main fetch handler error:', err.stack || err);
            return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
        }
    },
};

// --- UUID & WebSocket Helpers ---
// These are optimized helper functions

function makeReadableWebSocketStream(ws, earlyDataHeader, log) {
    return new ReadableStream({
        start(controller) {
            ws.addEventListener('message', e => controller.enqueue(e.data));
            ws.addEventListener('close', () => { safeCloseWebSocket(ws); controller.close(); });
            ws.addEventListener('error', err => { log('WebSocket error:', err); controller.error(err); });
            
            // Process early data if it exists
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel(reason) { log(`WebSocket stream canceled: ${reason}`); safeCloseWebSocket(ws); },
    });
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = new ArrayBuffer(binaryStr.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryStr.length; i++) view[i] = binaryStr.charCodeAt(i);
    return { earlyData: buffer, error: null };
  } catch (error) { return { earlyData: null, error }; }
}

function safeCloseWebSocket(socket) {
  try { 
      if (socket.readyState === CONST.WS_READY_STATE.OPEN || socket.readyState === CONST.WS_READY_STATE.CLOSING) {
          socket.close(); 
      }
  } catch (error) { 
      console.error('safeCloseWebSocket error:', error); 
  }
}

// Fast UUID stringify function
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
