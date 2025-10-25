/**
 * Ultimate VLESS Proxy Worker - Complete Production Edition
 * *** FIX v3 (Connection Logic): ***
 * - HandleTCPOutBound  PROXYIP
 * - ERR_CONNECTION_CLOSED SSL/TLS
 * Setup Requirements:
 * 1. D1 Database (bind as DB)
 * 2. KV Namespace (bind as USER_KV)
 * 3. Run SQL in D1 console:
 * CREATE TABLE IF NOT EXISTS users (
 * uuid TEXT PRIMARY KEY,
 * created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 * expiration_date TEXT NOT NULL,
 * expiration_time TEXT NOT NULL,
 * notes TEXT,
 * traffic_limit INTEGER DEFAULT 0,
 * traffic_used INTEGER DEFAULT 0
 * );
 * 4. Set Secrets in Cloudflare: ADMIN_KEY
 * 5. Set Variables (optional): UUID, PROXYIP, SOCKS5, ROOT_PROXY_URL
 */

import { connect } from 'cloudflare:sockets';

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

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
  VLESS_PROTOCOL: 'vless',
  WS_READY_STATE_OPEN: 1,
  WS_READY_STATE_CLOSING: 2,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
  const expTimeSeconds = expTime.includes(':') && expTime.split(':').length === 2 ? `${expTime}:00` : expTime;
  const cleanTime = expTimeSeconds.split('.')[0];
  const expDatetimeUTC = new Date(`${expDate}T${cleanTime}Z`);
  return expDatetimeUTC <= new Date() || isNaN(expDatetimeUTC);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getUserData(env, uuid, ctx) {
  if (!isValidUUID(uuid)) return null;
  if (!env.DB || !env.USER_KV) {
    console.error("D1 or KV bindings missing");
    return null;
  }
  
  const cacheKey = `user:${uuid}`;
  
  try {
    const cachedData = await env.USER_KV.get(cacheKey, 'json');
    if (cachedData && cachedData.uuid) return cachedData;
  } catch (e) {
    console.error(`Failed to parse cached data for ${uuid}`, e);
  }

  const userFromDb = await env.DB.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
  if (!userFromDb) return null;
  
  const cachePromise = env.USER_KV.put(cacheKey, JSON.stringify(userFromDb), { expirationTtl: 3600 });
  
  if (ctx) {
    ctx.waitUntil(cachePromise);
  } else {
    await cachePromise;
  }
  
  return userFromDb;
}

async function updateUsage(env, uuid, bytes, ctx) {
  if (bytes <= 0 || !uuid) return;
  
  try {
    const usage = Math.round(bytes);
    const updatePromise = env.DB.prepare("UPDATE users SET traffic_used = traffic_used + ? WHERE uuid = ?")
      .bind(usage, uuid)
      .run();
    
    const deletePromise = env.USER_KV.delete(`user:${uuid}`);
    
    if (ctx) {
      ctx.waitUntil(Promise.all([updatePromise, deletePromise]));
    } else {
      await Promise.all([updatePromise, deletePromise]);
    }
  } catch (err) {
    console.error(`Failed to update usage for ${uuid}:`, err);
  }
}

// ============================================================================
// UUID STRINGIFY FUNCTIONS
// ============================================================================

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

function unsafeStringify(arr, offset = 0) {
  return (
    byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' +
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' +
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' +
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' +
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + 
    byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) throw new TypeError('Stringified UUID is invalid');
  return uuid;
}

// ============================================================================
// SUBSCRIPTION GENERATION
// ============================================================================

function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `/${result}${query ? '?' + query : ''}`;
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
    links.push(buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i+1}` }));
    if (!isPagesDeployment) {
      links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: domain, port: pick(httpPorts), tag: `D${i+1}` }));
    }
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json');
    if (r.ok) {
      const json = await r.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
      ips.forEach((ip, i) => {
        const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
        links.push(buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i+1}` }));
        if (!isPagesDeployment) {
          links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: formattedAddress, port: pick(httpPorts), tag: `IP${i+1}` }));
        }
      });
    }
  } catch (e) {
    console.error('Fetch IP list failed', e);
  }

  return new Response(btoa(links.join('\n')), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}

// ============================================================================
// ADMIN PANEL HTML (Complete and Optimized)
// ============================================================================

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
            <input type="password" name="password" placeholder="Enter admin password" required>
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
        .dashboard-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .stat-card { background: #1F2937; padding: 16px; border-radius: 8px; text-align: center; border: 1px solid var(--border); }
        .stat-value { font-size: 24px; font-weight: 600; color: var(--accent); }
        .stat-label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; margin-top: 4px; }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; align-items: flex-end; }
        .form-group { display: flex; flex-direction: column; }
        .form-group label { margin-bottom: 8px; font-weight: 500; color: var(--text-secondary); }
        .form-group .input-group { display: flex; }
        input[type="text"], input[type="date"], input[type="time"], input[type="number"], select {
            width: 100%; box-sizing: border-box; background-color: #374151; border: 1px solid #4B5563; color: var(--text-primary);
            padding: 10px; border-radius: 6px; font-size: 14px; transition: border-color 0.2s;
        }
        input:focus, select:focus { outline: none; border-color: var(--accent); }
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
        .input-group select { border-top-left-radius: 0; border-bottom-left-radius: 0; }
        .search-input { width: 100%; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        th { color: var(--text-secondary); font-weight: 600; font-size: 12px; text-transform: uppercase; }
        td { color: var(--text-primary); font-family: "SF Mono", "Fira Code", monospace; font-size: 13px; }
        .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; display: inline-block; }
        .status-active { background-color: var(--success); color: #064E3B; }
        .status-expired { background-color: var(--expired); color: #78350F; }
        .actions-cell .btn { padding: 6px 10px; font-size: 12px; }
        #toast { position: fixed; top: 20px; right: 20px; background-color: var(--bg-card); color: white; padding: 15px 20px; border-radius: 8px; z-index: 1001; display: none; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s, transform 0.3s; transform: translateY(-20px); }
        #toast.show { display: block; opacity: 1; transform: translateY(0); }
        #toast.error { border-left: 5px solid var(--danger); }
        #toast.success { border-left: 5px solid var(--success); }
        .uuid-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .actions-cell { display: flex; gap: 8px; justify-content: center; }
        .time-display { display: flex; flex-direction: column; }
        .time-local { font-weight: 600; }
        .time-utc, .time-relative { font-size: 11px; color: var(--text-secondary); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
        .modal-overlay.show { opacity: 1; visibility: visible; }
        .modal-content { background-color: var(--bg-card); padding: 30px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.4); width: 90%; max-width: 500px; transform: scale(0.9); transition: transform 0.3s; border: 1px solid var(--border); max-height: 90vh; overflow-y: auto; }
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
        .checkbox { width: 16px; height: 16px; margin-right: 10px; cursor: pointer; }
        .select-all { cursor: pointer; }
        @media (max-width: 768px) {
            .dashboard-stats { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
            table { font-size: 12px; }
            th, td { padding: 8px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Admin Dashboard</h1>
        <div class="dashboard-stats">
            <div class="stat-card">
                <div class="stat-value" id="total-users">0</div>
                <div class="stat-label">Total Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="active-users">0</div>
                <div class="stat-label">Active Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="expired-users">0</div>
                <div class="stat-label">Expired Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="total-traffic">0 KB</div>
                <div class="stat-label">Total Traffic Used</div>
            </div>
        </div>
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
                <div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="Optional notes"></div>
                <div class="form-group"><label for="dataLimit">Data Limit</label><div class="input-group"><input type="number" id="dataLimit" min="0" step="0.01" placeholder="0"><select id="dataUnit"><option>KB</option><option>MB</option><option>GB</option><option>TB</option><option value="unlimited" selected>Unlimited</option></select></div></div>
                <div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div>
            </form>
        </div>
        <div class="card" style="margin-top: 30px;">
            <h2>User List</h2>
            <input type="text" id="searchInput" class="search-input" placeholder="Search by UUID or Notes...">
            <button id="deleteSelected" class="btn btn-danger" style="margin-bottom: 16px;">Delete Selected</button>
            <div style="overflow-x: auto;">
                 <table>
                    <thead><tr><th><input type="checkbox" id="selectAll" class="select-all checkbox"></th><th>UUID</th><th>Created</th><th>Expiry (Admin Local)</th><th>Expiry (Tehran)</th><th>Status</th><th>Notes</th><th>Data Limit</th><th>Usage</th><th>Actions</th></tr></thead>
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
                <div class="form-group" style="margin-top: 16px;"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="Optional notes"></div>
                <div class="form-group" style="margin-top: 16px;"><label for="editDataLimit">Data Limit</label><div class="input-group"><input type="number" id="editDataLimit" min="0" step="0.01"><select id="editDataUnit"><option>KB</option><option>MB</option><option>GB</option><option>TB</option><option value="unlimited">Unlimited</option></select></div></div>
                <div class="form-group" style="margin-top: 16px;"><label><input type="checkbox" id="resetTraffic" name="reset_traffic"> Reset Traffic Usage</label></div>
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
            const searchInput = document.getElementById('searchInput');
            const selectAll = document.getElementById('selectAll');
            const deleteSelected = document.getElementById('deleteSelected');

            function formatBytes(bytes) {
              if (bytes === 0) return '0 Bytes';
              const k = 1024;
              const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
              const i = Math.floor(Math.log(bytes) / Math.log(k));
              return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            }

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

            async function fetchStats() {
              try {
                const stats = await api.get('/stats');
                document.getElementById('total-users').textContent = stats.total_users;
                document.getElementById('active-users').textContent = stats.active_users;
                document.getElementById('expired-users').textContent = stats.expired_users;
                document.getElementById('total-traffic').textContent = formatBytes(stats.total_traffic);
              } catch (error) { showToast(error.message, true); }
            }

            function renderUsers(usersToRender = allUsers) {
                userList.innerHTML = '';
                if (usersToRender.length === 0) {
                    userList.innerHTML = '<tr><td colspan="10" style="text-align:center;">No users found.</td></tr>';
                } else {
                    usersToRender.forEach(user => {
                        const expiry = formatExpiryDateTime(user.expiration_date, user.expiration_time);
                        const row = document.createElement('tr');
                        row.innerHTML = \`
                            <td><input type="checkbox" class="user-checkbox checkbox" data-uuid="\${user.uuid}"></td>
                            <td><div class="uuid-cell" title="\${user.uuid}">\${user.uuid.substring(0, 8)}...</div></td>
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
                            <td>\${user.traffic_limit ? formatBytes(user.traffic_limit) : 'Unlimited'}</td>
                            <td>\${formatBytes(user.traffic_used || 0)}</td>
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
                    fetchStats();
                } catch (error) { showToast(error.message, true); }
            }

            async function handleCreateUser(e) {
                e.preventDefault();
                const localDate = document.getElementById('expiryDate').value;
                const localTime = document.getElementById('expiryTime').value;

                const { utcDate, utcTime } = localToUTC(localDate, localTime);
                if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);

                const dataLimit = document.getElementById('dataLimit').value;
                const dataUnit = document.getElementById('dataUnit').value;
                let trafficLimit = null;
                
                if (dataUnit !== 'unlimited' && dataLimit) {
                    const multipliers = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
                    trafficLimit = parseFloat(dataLimit) * (multipliers[dataUnit] || 1);
                }

                const userData = {
                    uuid: uuidInput.value,
                    exp_date: utcDate,
                    exp_time: utcTime,
                    notes: document.getElementById('notes').value,
                    traffic_limit: trafficLimit
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

            async function handleBulkDelete() {
                const selected = Array.from(document.querySelectorAll('.user-checkbox:checked')).map(cb => cb.dataset.uuid);
                if (selected.length === 0) return showToast('No users selected.', true);
                if (confirm(\`Delete \${selected.length} selected users?\`)) {
                    try {
                        await api.post('/users/bulk-delete', { uuids: selected });
                        showToast('Selected users deleted successfully!');
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

                const editDataLimit = document.getElementById('editDataLimit');
                const editDataUnit = document.getElementById('editDataUnit');
                if (user.traffic_limit === null || user.traffic_limit === 0) {
                  editDataUnit.value = 'unlimited';
                  editDataLimit.value = '';
                } else {
                  let bytes = user.traffic_limit;
                  let unit = 'KB';
                  let value = bytes / 1024;
                  
                  if (value >= 1024) { value = value / 1024; unit = 'MB'; }
                  if (value >= 1024) { value = value / 1024; unit = 'GB'; }
                  if (value >= 1024) { value = value / 1024; unit = 'TB'; }
                  
                  editDataLimit.value = value.toFixed(2);
                  editDataUnit.value = unit;
                }
                document.getElementById('resetTraffic').checked = false;

                editModal.classList.add('show');
            }

            function closeEditModal() { editModal.classList.remove('show'); }

            async function handleEditUser(e) {
                e.preventDefault();
                const localDate = document.getElementById('editExpiryDate').value;
                const localTime = document.getElementById('editExpiryTime').value;

                const { utcDate, utcTime } = localToUTC(localDate, localTime);
                if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);

                const dataLimit = document.getElementById('editDataLimit').value;
                const dataUnit = document.getElementById('editDataUnit').value;
                let trafficLimit = null;
                
                if (dataUnit !== 'unlimited' && dataLimit) {
                    const multipliers = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
                    trafficLimit = parseFloat(dataLimit) * (multipliers[dataUnit] || 1);
                }

                const updatedData = {
                    exp_date: utcDate,
                    exp_time: utcTime,
                    notes: document.getElementById('editNotes').value,
                    traffic_limit: trafficLimit,
                    reset_traffic: document.getElementById('resetTraffic').checked
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
                now.setDate(now.getDate() + 1);

                const year = now.getFullYear();
                const month = pad(now.getMonth() + 1);
                const day = pad(now.getDate());
                const hours = pad(now.getHours());
                const minutes = pad(now.getMinutes());
                const seconds = pad(now.getSeconds());

                document.getElementById('expiryDate').value = \`\${year}-\${month}-\${day}\`;
                document.getElementById('expiryTime').value = \`\${hours}:\${minutes}:\${seconds}\`;
            }

            function filterUsers() {
              const searchTerm = searchInput.value.toLowerCase();
              const filtered = allUsers.filter(user => 
                user.uuid.toLowerCase().includes(searchTerm) || 
                (user.notes && user.notes.toLowerCase().includes(searchTerm))
              );
              renderUsers(filtered);
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
            searchInput.addEventListener('input', filterUsers);
            selectAll.addEventListener('change', (e) => {
              document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = e.target.checked);
            });
            deleteSelected.addEventListener('click', handleBulkDelete);

            setDefaultExpiry();
            uuidInput.value = crypto.randomUUID();
            fetchAndRenderUsers();
        });
    </script>
</body>
</html>`;

// ============================================================================
// ADMIN AUTHENTICATION & API HANDLERS
// ============================================================================

async function isAdmin(request, env) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return false;

  const token = cookieHeader.match(/auth_token=([^;]+)/)?.[1];
  if (!token) return false;

  const storedToken = await env.USER_KV.get('admin_session_token');
  return storedToken && storedToken === token;
}

async function handleAdminRequest(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const jsonHeader = { 'Content-Type': 'application/json' };

  if (!env.ADMIN_KEY) {
    return new Response('Admin panel is not configured.', { status: 503 });
  }

  if (pathname.startsWith('/admin/api/')) {
    if (!(await isAdmin(request, env))) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
    }

    if (request.method !== 'GET') {
      const origin = request.headers.get('Origin');
      if (!origin || new URL(origin).hostname !== url.hostname) {
        return new Response(JSON.stringify({ error: 'Invalid Origin' }), { status: 403, headers: jsonHeader });
      }
    }

    if (pathname === '/admin/api/stats' && request.method === 'GET') {
      try {
        const totalUsers = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first('count');
        const expiredQuery = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE datetime(expiration_date || 'T' || expiration_time || 'Z') < datetime('now')").first();
        const expiredUsers = expiredQuery?.count || 0;
        const activeUsers = totalUsers - expiredUsers;
        const totalTrafficQuery = await env.DB.prepare("SELECT SUM(traffic_used) as sum FROM users").first();
        const totalTraffic = totalTrafficQuery?.sum || 0;
        return new Response(JSON.stringify({ 
          total_users: totalUsers, 
          active_users: activeUsers, 
          expired_users: expiredUsers, 
          total_traffic: totalTraffic 
        }), { status: 200, headers: jsonHeader });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
      }
    }

    if (pathname === '/admin/api/users' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, notes, traffic_limit, traffic_used FROM users ORDER BY created_at DESC").all();
        return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
      }
    }

    if (pathname === '/admin/api/users' && request.method === 'POST') {
      try {
        const { uuid, exp_date: expDate, exp_time: expTime, notes, traffic_limit } = await request.json();

        if (!uuid || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
          throw new Error('Invalid or missing fields. Use UUID, YYYY-MM-DD, and HH:MM:SS.');
        }

        await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes, traffic_limit, traffic_used) VALUES (?, ?, ?, ?, ?, 0)")
          .bind(uuid, expDate, expTime, notes || null, traffic_limit).run();
        
        ctx.waitUntil(env.USER_KV.put(`user:${uuid}`, JSON.stringify({ 
          uuid,
          expiration_date: expDate, 
          expiration_time: expTime, 
          notes: notes || null,
          traffic_limit: traffic_limit, 
          traffic_used: 0 
        })));

        return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
      } catch (error) {
        if (error.message?.includes('UNIQUE constraint failed')) {
          return new Response(JSON.stringify({ error: 'A user with this UUID already exists.' }), { status: 409, headers: jsonHeader });
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
      }
    }

    if (pathname === '/admin/api/users/bulk-delete' && request.method === 'POST') {
      try {
        const { uuids } = await request.json();
        if (!Array.isArray(uuids) || uuids.length === 0) {
          throw new Error('Invalid request body: Expected an array of UUIDs.');
        }

        const deleteUserStmt = env.DB.prepare("DELETE FROM users WHERE uuid = ?");
        const stmts = uuids.map(uuid => deleteUserStmt.bind(uuid));
        await env.DB.batch(stmts);

        ctx.waitUntil(Promise.all(uuids.map(uuid => env.USER_KV.delete(`user:${uuid}`))));

        return new Response(JSON.stringify({ success: true, count: uuids.length }), { status: 200, headers: jsonHeader });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
      }
    }

    const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/);

    if (userRouteMatch && request.method === 'PUT') {
      const uuid = userRouteMatch[1];
      try {
        const { exp_date: expDate, exp_time: expTime, notes, traffic_limit, reset_traffic } = await request.json();
        if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
          throw new Error('Invalid date/time fields. Use YYYY-MM-DD and HH:MM:SS.');
        }

        let query = "UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ?, traffic_limit = ?";
        let binds = [expDate, expTime, notes || null, traffic_limit];
        
        if (reset_traffic) {
          query += ", traffic_used = 0";
        }
        
        query += " WHERE uuid = ?";
        binds.push(uuid);

        await env.DB.prepare(query).bind(...binds).run();
        
        ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`));

        return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
      }
    }

    if (userRouteMatch && request.method === 'DELETE') {
      const uuid = userRouteMatch[1];
      try {
        await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
        ctx.waitUntil(env.USER_KV.delete(`user:${uuid}`));
        return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonHeader });
      }
    }

    return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
  }

  if (pathname === '/admin') {
    if (request.method === 'POST') {
      const formData = await request.formData();
      if (formData.get('password') === env.ADMIN_KEY) {
        const token = crypto.randomUUID();
        ctx.waitUntil(env.USER_KV.put('admin_session_token', token, { expirationTtl: 86400 }));
        return new Response(null, {
          status: 302,
          headers: { 
            'Location': '/admin', 
            'Set-Cookie': `auth_token=${token}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict` 
          },
        });
      } else {
        const loginPageWithError = adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>');
        return new Response(loginPageWithError, { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      }
    }

    if (request.method === 'GET') {
      return new Response(await isAdmin(request, env) ? adminPanelHTML : adminLoginHTML, { 
        headers: { 'Content-Type': 'text/html;charset=utf-8' } 
      });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }

  return new Response('Not found', { status: 404 });
}

// ============================================================================
// VLESS PROTOCOL HANDLERS
// ============================================================================

async function ProtocolOverWSHandler(request, config, env, ctx) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let address = '';
  let portWithRandomLog = '';
  let sessionUsage = 0;
  let userUUID = '';
  let udpStreamWriter = null;

  const log = (info, event) => console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');

  const deferredUsageUpdate = () => {
    if (sessionUsage > 0 && userUUID) {
      const usageToUpdate = sessionUsage;
      const uuidToUpdate = userUUID;
      
      sessionUsage = 0;
      
      ctx.waitUntil(
        updateUsage(env, uuidToUpdate, usageToUpdate, ctx)
          .catch(err => console.error(`Deferred usage update failed for ${uuidToUpdate}:`, err))
      );
    }
  };

  const updateInterval = setInterval(deferredUsageUpdate, 10000);

  const finalCleanup = () => {
    clearInterval(updateInterval);
    deferredUsageUpdate(); // Final update
  };

  webSocket.addEventListener('close', finalCleanup, { once: true });
  webSocket.addEventListener('error', finalCleanup, { once: true });

  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWrapper = { value: null };

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          sessionUsage += chunk.byteLength;

          if (udpStreamWriter) {
            return udpStreamWriter.write(chunk);
          }

          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

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
            controller.error(new Error('User not found'));
            return;
          }

          userUUID = user.uuid;

          if (isExpired(user.expiration_date, user.expiration_time)) {
            controller.error(new Error('User expired'));
            return;
          }

          if (user.traffic_limit && user.traffic_limit > 0) {
            const totalUsage = (user.traffic_used || 0) + sessionUsage;
            if (totalUsage >= user.traffic_limit) {
              controller.error(new Error('Data limit reached'));
              return;
            }
          }

          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}`;
          const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isUDP) {
            if (portRemote === 53) {
              const dnsPipeline = await createDnsPipeline(webSocket, vlessResponseHeader, log, (bytes) => {
                sessionUsage += bytes; // Count DNS response traffic
              });
              udpStreamWriter = dnsPipeline.write;
              await udpStreamWriter(rawClientData);
            } else {
              controller.error(new Error('UDP proxy only for DNS (port 53)'));
            }
            return;
          }

          // *****************************************************************
          // *** BEGIN CRITICAL FIX ***
          // HandleTCPOutBound فراخوانی می‌شود
          // *****************************************************************
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
            (bytes) => { sessionUsage += bytes; }
          );
          // *****************************************************************
          // *** END CRITICAL FIX ***
          // *****************************************************************
        },
        close() {
          log('readableWebSocketStream closed');
          finalCleanup();
        },
        abort(err) {
          log('readableWebSocketStream aborted', err);
          finalCleanup();
        },
      }),
    )
    .catch(err => {
      console.error('Pipeline failed:', err.stack || err);
      safeCloseWebSocket(webSocket);
      finalCleanup();
    });

  return new Response(null, { status: 101, webSocket: client });
}

async function ProcessProtocolHeader(protocolBuffer, env, ctx) {
  if (protocolBuffer.byteLength < 17) {
    return { hasError: true, message: 'invalid data' };
  }
  
  const dataView = new DataView(protocolBuffer.buffer || protocolBuffer);
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
  if (protocolBuffer.byteLength < payloadStart + 1) {
    return { hasError: true, message: 'invalid data length' };
  }

  const optLength = dataView.getUint8(payloadStart);
  const commandIndex = payloadStart + 1 + optLength;
  
  if (protocolBuffer.byteLength < commandIndex + 1) {
    return { hasError: true, message: 'invalid data length (command)' };
  }
  
  const command = dataView.getUint8(commandIndex);
  if (command !== 1 && command !== 2) {
    return { hasError: true, message: `command ${command} is not supported` };
  }

  const portIndex = commandIndex + 1;
  if (protocolBuffer.byteLength < portIndex + 2) {
    return { hasError: true, message: 'invalid data length (port)' };
  }
  
  const portRemote = dataView.getUint16(portIndex, false); // false = Big Endian (Network Order)

  const addressTypeIndex = portIndex + 2;
  if (protocolBuffer.byteLength < addressTypeIndex + 1) {
    return { hasError: true, message: 'invalid data length (address type)' };
  }
  
  const addressType = dataView.getUint8(addressTypeIndex);

  let addressValue, addressLength, addressValueIndex;

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValueIndex = addressTypeIndex + 1;
      if (protocolBuffer.byteLength < addressValueIndex + addressLength) {
        return { hasError: true, message: 'invalid data length (ipv4)' };
      }
      addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
      
    case 2: // Domain
      if (protocolBuffer.byteLength < addressTypeIndex + 2) {
        return { hasError: true, message: 'invalid data length (domain length)' };
      }
      addressLength = dataView.getUint8(addressTypeIndex + 1);
      addressValueIndex = addressTypeIndex + 2;
      if (protocolBuffer.byteLength < addressValueIndex + addressLength) {
        return { hasError: true, message: 'invalid data length (domain)' };
      }
      addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
      
    case 3: // IPv6
      addressLength = 16;
      addressValueIndex = addressTypeIndex + 1;
      if (protocolBuffer.byteLength < addressValueIndex + addressLength) {
        return { hasError: true, message: 'invalid data length (ipv6)' };
      }
      addressValue = Array.from({ length: 8 }, (_, i) => 
        dataView.getUint16(addressValueIndex + i * 2, false).toString(16) // false = Big Endian
      ).join(':');
      break;
      
    default:
      return { hasError: true, message: `invalid addressType: ${addressType}` };
  }

  const rawDataIndex = addressValueIndex + addressLength;
  if (protocolBuffer.byteLength < rawDataIndex) {
    return { hasError: true, message: 'invalid data length (raw data)' };
  }

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

// ============================================================================
// *** REPLACEMENT HandleTCPOutBound FUNCTION (FIXED) ***
// این تابع اصلاح شده است تا همیشه از PROXYIP (مانند اسکریپت اول) استفاده کند.
// ============================================================================
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
  trafficCallback
) {
  // این تابع کمکی برای اتصال است
  async function connectAndWrite(address, port, useSocks = false) {
    let tcpSocket;
    
    if (useSocks || config.socks5Relay) {
      log(`Connecting to ${address}:${port} via SOCKS5...`);
      tcpSocket = await socks5Connect(addressType, address, port, log, config.parsedSocks5Address);
    } else {
      log(`Connecting to ${address}:${port}...`);
      tcpSocket = connect({ hostname: address, port: port });
    }
    
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    
    return tcpSocket;
  }

  try {
    // --- START MODIFICATION (شروع اصلاح) ---
    // منطق قبلی (اتصال مستقیم، سپس تلاش مجدد با PROXYIP) باعث خطا می‌شد.
    // منطق جدید (مشابه اسکریپت اول شما) همیشه از PROXYIP (اگر SOCKS5 فعال نباشد) استفاده می‌کند.

    let tcpSocket;

    if (config.enableSocks) {
      // اگر SOCKS5 فعال است، باید مستقیماً به مقصد (از طریق پراکسی SOCKS5) وصل شود
      log(`Attempting initial connection to ${addressRemote}:${portRemote} via SOCKS5...`);
      tcpSocket = await connectAndWrite(addressRemote, portRemote, true);
    } else {
      // اگر SOCKS5 فعال نیست، از PROXYIP استفاده کن (مانند اسکریپت اول)
      const connectHost = config.proxyIP || addressRemote;
      const connectPort = config.proxyIP ? (config.proxyPort || 443) : portRemote;
      
      log(`Attempting connection to ${addressRemote}:${portRemote} via ${config.proxyIP ? 'PROXYIP' : 'direct'}: ${connectHost}:${connectPort}`);
      tcpSocket = await connectAndWrite(connectHost, connectPort, false);
    }
    // --- END MODIFICATION (پایان اصلاح) ---

    tcpSocket.closed
      .catch(error => console.log('tcpSocket closed error', error))
      .finally(() => safeCloseWebSocket(webSocket));
      
    // دیگر نیازی به تابع 'retry' نیست چون از ابتدا بهترین روش را انتخاب کردیم
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log, trafficCallback);
    
  } catch (e) {
    // اگر اتصال اولیه (که اکنون شامل PROXYIP است) شکست بخورد، سوکت را می‌بندیم
    log(`Initial connection failed: ${e.message}. Closing socket.`);
    safeCloseWebSocket(webSocket);
  }
}
// ============================================================================
// *** END OF REPLACEMENT FUNCTION ***
// ============================================================================


function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        controller.enqueue(event.data);
      });
      
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        controller.close();
      });
      
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error');
        controller.error(err);
      });
      
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    pull(_controller) { },
    cancel(reason) {
      log(`ReadableStream was canceled, due to ${reason}`);
      safeCloseWebSocket(webSocketServer);
    },
  });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log, trafficCallback) {
  let hasIncomingData = false;
  
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN) {
            throw new Error('WebSocket is not open');
          }
          
          hasIncomingData = true;
          
          if (trafficCallback) {
            trafficCallback(chunk.byteLength);
          }
          
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
  
  // اگر 'retry' null باشد، این کد اجرا نمی‌شود، که اکنون همینطور است
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

async function createDnsPipeline(webSocket, vlessResponseHeader, log, trafficCallback) {
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
              
              const blob = isHeaderSent
                ? new Blob([udpSizeBuffer, dnsQueryResult])
                : new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]);

              const responseChunk = await blob.arrayBuffer();
              
              if (trafficCallback) {
                trafficCallback(responseChunk.byteLength);
              }
              
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

  // SOCKS5 greeting
  await writer.write(new Uint8Array([5, 2, 0, 2]));
  let res = (await reader.read()).value;
  
  if (res[0] !== 0x05 || res[1] === 0xff) {
    throw new Error('SOCKS5 server connection failed');
  }

  // Authentication if required
  if (res[1] === 0x02) {
    if (!username || !password) {
      throw new Error('SOCKS5 auth credentials not provided');
    }
    
    const authRequest = new Uint8Array([
      1,
      username.length,
      ...encoder.encode(username),
      password.length,
      ...encoder.encode(password),
    ]);
    
    await writer.write(authRequest);
    res = (await reader.read()).value;
    
    if (res[0] !== 0x01 || res[1] !== 0x00) {
      throw new Error('SOCKS5 authentication failed');
    }
  }

  // Build destination address
  let DSTADDR;
  switch (addressType) {
    case 1: // IPv4
      DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]);
      break;
      
    case 2: // Domain
      DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]);
      break;
      
    case 3: // IPv6
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

  // Connect request
  const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
  await writer.write(socksRequest);
  res = (await reader.read()).value;
  
  if (res[1] !== 0x00) {
    throw new Error('Failed to open SOCKS5 connection');
  }

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

function socks5AddressParser(address) {
  try {
    const [authPart, hostPart] = address.includes('@') ? address.split('@') : [null, address];
    const [hostname, portStr] = hostPart.split(':');
    const port = parseInt(portStr, 10);
    
    if (!hostname || isNaN(port)) {
      throw new Error();
    }

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

// ============================================================================
// SCAMALYTICS LOOKUP
// ============================================================================

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
    return new Response(JSON.stringify({ error: 'Scamalytics API credentials not configured' }), {
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

// ============================================================================
// USER CONFIG PAGE (Beautiful Design from Script 1)
// ============================================================================

function handleConfigPage(userID, hostName, proxyAddress, userData) {
  const html = generateBeautifulConfigPage(
    userID,
    hostName,
    proxyAddress,
    userData.expiration_date,
    userData.expiration_time,
    userData.traffic_limit,
    userData.traffic_used
  );
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate = '', expTime = '', trafficLimit = null, trafficUsed = 0) {
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
    const expTimeSeconds = expTime.includes(':') && expTime.split(':').length === 2 ? `${expTime}:00` : expTime;
    const utcTimestamp = `${expDate}T${expTimeSeconds.split('.')[0]}Z`;
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
          <div id="expiration-display">No expiration date set</div>
        </div>
      </div>
    `;
  }

  let usageBlock = '';
  if (trafficLimit !== null && trafficLimit > 0) {
    const usedPct = Math.min(((trafficUsed / trafficLimit) * 100), 100).toFixed(2);
    const progressColor = usedPct > 90 ? 'linear-gradient(90deg, #e05d44, #ef4444)' : 
                         usedPct > 70 ? 'linear-gradient(90deg, #e0bc44, #f59e0b)' : 
                         'linear-gradient(90deg, #70b570, #22c55e)';
    usageBlock = `
      <div class="expiration-card usage-card">
        <div class="expiration-card-content">
          <h2 class="expiration-title">Data Usage</h2>
          <div class="expiration-relative-time">${formatBytes(trafficUsed)} / ${formatBytes(trafficLimit)}</div>
          <hr class="expiration-divider">
          <div class="usage-progress"><div style="width: ${usedPct}%; background: ${progressColor};"></div></div>
        </div>
      </div>
    `;
  } else {
    usageBlock = `
      <div class="expiration-card usage-card">
        <div class="expiration-card-content">
          <h2 class="expiration-title">Data Usage</h2>
          <hr class="expiration-divider">
          <div>Unlimited (Used: ${formatBytes(trafficUsed)})</div>
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
  ${getPageHTML(clientUrls, subXrayUrl, subSbUrl, expirationBlock, usageBlock)}
  <script>${getPageScript()}</script>
</body>
</html>`;

  return finalHTML;
}

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
      --border-radius: 12px; --transition-speed: 0.2s; --transition-speed-fast: 0.1s; 
      --transition-speed-medium: 0.3s; --transition-speed-long: 0.6s;
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
    
    .expiration-card, .usage-card {
      position: relative; padding: 3px; background: var(--background-secondary);
      border-radius: var(--border-radius); margin-bottom: 24px; overflow: hidden; z-index: 1;
    }
    
    .expiration-card::before, .usage-card::before {
      content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
      background: conic-gradient(
        #ff0000, #ff00ff, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000
      );
      animation: rgb-animation 4s linear infinite; z-index: -1;
    }
    
    .expiration-card-content {
      background: var(--background-secondary); padding: 20px; border-radius: calc(var(--border-radius) - 3px);
    }
    
    .expiration-title {
      font-family: var(--serif); font-size: 1.6rem; font-weight: 400; text-align: center;
      color: var(--accent-secondary); margin: 0 0 12px 0;
    }
    
    .expiration-relative-time {
      text-align: center; font-size: 1.1rem; font-weight: 500;
      margin-bottom: 12px; padding: 4px 8px; border-radius: 6px;
    }
    
    .expiration-relative-time.active {
      color: var(--status-success); background-color: rgba(112, 181, 112, 0.1);
    }
    
    .expiration-relative-time.expired {
      color: var(--status-error); background-color: rgba(224, 93, 68, 0.1);
    }
    
    .expiration-divider {
      border: 0; height: 1px; background: var(--border-color);
      margin: 0 auto 16px; width: 80%;
    }
    
    #expiration-display { 
      font-size: 0.9em; text-align: center; color: var(--text-secondary); 
    }
    
    #expiration-display span { 
      display: block; margin-top: 8px; font-size: 0.9em; line-height: 1.6; 
    }
    
    #expiration-display strong { 
      color: var(--text-primary); font-weight: 500; 
    }
    
    .usage-progress {
      height: 10px; background: #413b35; border-radius: 5px;
      overflow: hidden; margin-bottom: 10px;
    }
    
    .usage-progress div { 
      height: 100%; transition: width 0.5s ease; 
    }
    
    .container {
      max-width: 800px; margin: 20px auto; padding: 0 12px; border-radius: var(--border-radius);
      box-shadow: 0 6px 15px rgba(0, 0, 0, 0.2), 0 0 25px 8px var(--shadow-color-accent);
      transition: box-shadow var(--transition-speed-medium) ease;
    }
    
    .container:hover { 
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25), 0 0 35px 10px var(--shadow-color-accent); 
    }
    
    .header { text-align: center; margin-bottom: 30px; padding-top: 30px; }
    
    .header h1 { 
      font-family: var(--serif); font-weight: 400; font-size: 1.8rem; 
      color: var(--text-accent); margin-top: 0px; margin-bottom: 2px; 
    }
    
    .header p { 
      color: var(--text-secondary); font-size: 0.9rem; font-weight: 400; 
    }
    
    .config-card {
      background: var(--background-secondary); border-radius: var(--border-radius); 
      padding: 20px; margin-bottom: 24px; border: 1px solid var(--border-color);
      transition: border-color var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
    }
    
    .config-card:hover { 
      border-color: var(--border-color-hover); box-shadow: 0 4px 8px var(--shadow-color); 
    }
    
    .config-title {
      font-family: var(--serif); font-size: 1.6rem; font-weight: 400; color: var(--accent-secondary);
      margin-bottom: 16px; padding-bottom: 13px; border-bottom: 1px solid var(--border-color);
      display: flex; align-items: center; justify-content: space-between;
    }
    
    .button {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      padding: 8px 16px; border-radius: var(--border-radius); font-size: 15px; font-weight: 500;
      cursor: pointer; border: 1px solid var(--border-color); background-color: var(--background-tertiary);
      color: var(--button-text-secondary);
      transition: background-color var(--transition-speed) ease, border-color var(--transition-speed) ease, 
                  color var(--transition-speed) ease, transform var(--transition-speed) ease, 
                  box-shadow var(--transition-speed) ease;
      text-decoration: none; overflow: hidden; position: relative;
    }
    
    .button:hover {
      background-color: #4d453e; color: var(--accent-primary);
      border-color: var(--border-color-hover); transform: translateY(-2px); 
      box-shadow: 0 4px 8px var(--shadow-color);
    }
    
    .button:active { 
      transform: translateY(0px) scale(0.98); box-shadow: none; 
    }
    
    .client-buttons-container { 
      display: flex; flex-direction: column; gap: 16px; margin-top: 16px; 
    }
    
    .client-buttons-container h3 { 
      font-family: var(--serif); font-size: 14px; color: var(--text-secondary); 
      margin: 8px 0 -8px 0; font-weight: 400; text-align: center; 
    }
    
    .client-buttons { 
      display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; 
    }
    
    .client-btn {
      width: 100%; background-color: var(--accent-primary); color: var(--background-tertiary);
      border-radius: 6px; border-color: var(--accent-primary-darker); position: relative; overflow: hidden;
      transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
    }
    
    .client-btn:hover {
      text-transform: uppercase; letter-spacing: 0.3px; transform: translateY(-3px);
      background-color: var(--accent-secondary); color: var(--button-text-primary);
      box-shadow: 0 5px 15px rgba(190, 155, 123, 0.5); border-color: var(--accent-secondary);
    }
    
    .client-btn:active { 
      transform: translateY(0) scale(0.98); box-shadow: 0 2px 3px rgba(0, 0, 0, 0.2); 
      background-color: var(--accent-primary-darker); 
    }
    
    .qr-container {
      display: none; text-align: center; margin-top: 10px; background: white; 
      padding: 10px; border-radius: 8px; max-width: 276px; margin-left: auto; margin-right: auto;
    }
    
    .footer { 
      text-align: center; margin-top: 20px; margin-bottom: 40px; 
      color: var(--text-secondary); font-size: 12px; 
    }
    
    .footer p { margin-bottom: 0px; }
    
    .network-info-wrapper {
      background: var(--background-secondary); border-radius: var(--border-radius);
      padding: 24px; margin-bottom: 24px; border: 1px solid var(--border-color);
    }
    
    .network-info-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border-color);
    }
    
    .network-info-header h2 { 
      margin: 0; font-size: 1.4rem; font-family: var(--serif); color: var(--accent-secondary); 
    }
    
    .network-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;
    }
    
    .network-card {
      background: #2f2a26; border: 1px solid var(--border-color);
      border-radius: 8px; padding: 16px;
    }
    
    .network-title {
      font-size: 1.1em; margin-top: 0; margin-bottom: 12px;
      border-bottom: 1px solid var(--border-color); padding-bottom: 8px;
      color: var(--accent-secondary); font-family: var(--serif);
    }
    
    .network-info-grid { display: grid; gap: 8px; font-size: 0.9em; }
    
    .network-info-grid strong {
      color: var(--text-secondary); font-weight: 400; display: inline-block; min-width: 90px;
    }
    
    .network-info-grid span { color: var(--text-primary); font-weight: 500; }
    
    .skeleton {
      display: inline-block; width: 120px; height: 1em;
      background-color: var(--background-tertiary); border-radius: 4px;
    }
    
    @keyframes loading {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    
    @media (max-width: 768px) {
      body { padding: 20px; }
      .container { padding: 0 14px; width: min(100%, 768px); }
      .network-grid { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 18px; }
      .header h1 { font-size: 1.8rem; }
      .header p { font-size: 0.7rem; }
      .network-card { padding: 14px; gap: 18px; }
      .network-title { font-size: 16px; }
      .client-buttons { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
    }
    
    @media (max-width: 480px) {
      body { padding: 16px; }
      .container { padding: 0 12px; width: min(100%, 390px); }
      .header h1 { font-size: 20px; }
      .header p { font-size: 8px; }
      .network-card { padding: 14px; gap: 16px; }
      .network-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
      .network-title { font-size: 14px; }
      .client-buttons { grid-template-columns: repeat(auto-fill, minmax(100%, 1fr)); }
      .button { padding: 4px 8px; font-size: 11px; }
      .footer { font-size: 10px; }
    }
  `;
}

function getPageHTML(clientUrls, subXrayUrl, subSbUrl, expirationBlock, usageBlock) {
  return `
    <div class="container">
      <div class="header">
        <h1>VLESS Proxy Configuration</h1>
        <p>Copy the configuration or import directly into your client</p>
      </div>

      <div class="network-info-wrapper">
        <div class="network-info-header">
          <h2>Network Information</h2>
          <button class="button" id="refresh-network-btn">Refresh</button>
        </div>
        <div class="network-grid">
          <div class="network-card">
            <h3 class="network-title">Proxy Server</h3>
            <div class="network-info-grid">
              <div><strong>Proxy Host:</strong> <span id="proxy-host"><span class="skeleton"></span></span></div>
              <div><strong>IP Address:</strong> <span id="proxy-ip"><span class="skeleton"></span></span></div>
              <div><strong>Location:</strong> <span id="proxy-location"><span class="skeleton"></span></span></div>
              <div><strong>ISP:</strong> <span id="proxy-isp"><span class="skeleton"></span></span></div>
            </div>
          </div>
          <div class="network-card">
            <h3 class="network-title">Your Connection</h3>
            <div class="network-info-grid">
              <div><strong>Your IP:</strong> <span id="client-ip"><span class="skeleton"></span></span></div>
              <div><strong>Location:</strong> <span id="client-location"><span class="skeleton"></span></span></div>
              <div><strong>ISP:</strong> <span id="client-isp"><span class="skeleton"></span></span></div>
              <div><strong>Risk Score:</strong> <span id="client-risk"><span class="skeleton"></span></span></div>
            </div>
          </div>
        </div>
      </div>

      ${expirationBlock}
      ${usageBlock}

      <div class="config-card">
        <div class="config-title">
          <span>Xray Subscription</span>
          <button id="copy-xray-sub-btn" class="button" data-clipboard-text="${subXrayUrl}">Copy Link</button>
        </div>
        <div class="client-buttons-container">
          <h3>Android</h3>
          <div class="client-buttons">
            <a href="${clientUrls.universalAndroid}" class="button client-btn">Universal Import (V2rayNG)</a>
            <a href="${clientUrls.karing}" class="button client-btn">Import to Karing</a>
          </div>
          <h3>iOS</h3>
          <div class="client-buttons">
            <a href="${clientUrls.shadowrocket}" class="button client-btn">Import to Shadowrocket</a>
            <a href="${clientUrls.stash}" class="button client-btn">Import to Stash</a>
            <a href="${clientUrls.streisand}" class="button client-btn">Import to Streisand</a>
          </div>
          <h3>Desktop / Other</h3>
          <div class="client-buttons">
            <button class="button client-btn" onclick="toggleQR('xray', '${subXrayUrl}')">Show QR Code</button>
          </div>
          <div id="qr-xray-container" class="qr-container"><div id="qr-xray"></div></div>
        </div>
      </div>

      <div class="config-card">
        <div class="config-title">
          <span>Sing-Box / Clash Subscription</span>
          <button id="copy-sb-sub-btn" class="button" data-clipboard-text="${subSbUrl}">Copy Link</button>
        </div>
        <div class="client-buttons-container">
          <h3>Android / Windows / macOS</h3>
          <div class="client-buttons">
            <a href="${clientUrls.clashMeta}" class="button client-btn">Import to Clash Meta / Stash</a>
          </div>
          <h3>Desktop / Other</h3>
          <div class="client-buttons">
            <button class="button client-btn" onclick="toggleQR('singbox', '${subSbUrl}')">Show QR Code</button>
          </div>
          <div id="qr-singbox-container" class="qr-container"><div id="qr-singbox"></div></div>
        </div>
      </div>

      <div class="footer">
        <p>© ${new Date().getFullYear()} REvil - All Rights Reserved</p>
        <p>Secure. Private. Fast.</p>
      </div>
    </div>
  `;
}

function getPageScript() {
  return `
    function copyToClipboard(button, text) {
      const originalText = button.textContent;
      navigator.clipboard.writeText(text).then(() => {
        button.textContent = 'Copied!';
        setTimeout(() => { button.textContent = originalText; }, 1500);
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    }

    function toggleQR(id, url) {
      const container = document.getElementById('qr-' + id + '-container');
      const qrElement = document.getElementById('qr-' + id);
      
      if (container.style.display === 'none' || container.style.display === '') {
        container.style.display = 'block';
        if (!qrElement.hasChildNodes()) {
          new QRCode(qrElement, {
            text: url, width: 256, height: 256,
            colorDark: "#2a2421", colorLight: "#e5dfd6",
            correctLevel: QRCode.CorrectLevel.H
          });
        }
      } else {
        container.style.display = 'none';
      }
    }

    function displayExpirationTimes() {
      const expElement = document.getElementById('expiration-display');
      const relativeElement = document.getElementById('expiration-relative');
      
      if (!expElement || !expElement.dataset.utcTime) {
        if (expElement) expElement.textContent = 'Expiration time not available';
        if (relativeElement) relativeElement.style.display = 'none';
        return;
      }

      const utcDate = new Date(expElement.dataset.utcTime);
      if (isNaN(utcDate.getTime())) {
        expElement.textContent = 'Invalid expiration time format';
        if (relativeElement) relativeElement.style.display = 'none';
        return;
      }

      const now = new Date();
      const diffSeconds = (utcDate.getTime() - now.getTime()) / 1000;
      const isExpired = diffSeconds < 0;

      const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
      let relTime = '';
      
      if (Math.abs(diffSeconds) < 60) relTime = rtf.format(Math.round(diffSeconds), 'second');
      else if (Math.abs(diffSeconds) < 3600) relTime = rtf.format(Math.round(diffSeconds / 60), 'minute');
      else if (Math.abs(diffSeconds) < 86400) relTime = rtf.format(Math.round(diffSeconds / 3600), 'hour');
      else relTime = rtf.format(Math.round(diffSeconds / 86400), 'day');

      if (relativeElement) {
        relativeElement.textContent = isExpired ? \`Expired \${relTime}\` : \`Expires \${relTime}\`;
        relativeElement.classList.add(isExpired ? 'expired' : 'active');
      }

      const commonOptions = {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: true, timeZoneName: 'short'
      };

      const localTime = utcDate.toLocaleString(undefined, commonOptions);
      const tehranTime = utcDate.toLocaleString('en-US', { ...commonOptions, timeZone: 'Asia/Tehran' });
      const utcTime = utcDate.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

      expElement.innerHTML = \`
        <span><strong>Your Local Time:</strong> \${localTime}</span>
        <span><strong>Tehran Time:</strong> \${tehranTime}</span>
        <span><strong>Universal Time:</strong> \${utcTime}</span>
      \`;
    }

    async function fetchClientIP() {
      try {
        const response = await fetch('https://api.ipify.org?format=json');
        return (await response.json()).ip;
      } catch (error) {
        console.error('Error fetching client IP:', error);
        return null;
      }
    }

    async function fetchScamalyticsInfo(clientIp) {
      if (!clientIp) return null;
      try {
        const response = await fetch(\`/scamalytics-lookup?ip=\${encodeURIComponent(clientIp)}\`);
        if (!response.ok) return null;
        return await response.json();
      } catch (error) {
        console.error('Error fetching Scamalytics data:', error);
        return null;
      }
    }

    async function fetchIpApiInfo(ip) {
      try {
        const response = await fetch(\`https://ip-api.io/json/\${ip}\`);
        if (!response.ok) return null;
        return await response.json();
      } catch (error) {
        console.error('IP API Error:', error);
        return null;
      }
    }

    async function loadNetworkInfo() {
      try {
        const proxyIpWithPort = document.body.getAttribute('data-proxy-ip') || "N/A";
        const proxyDomain = proxyIpWithPort.split(':')[0];
        
        document.getElementById('proxy-host').textContent = proxyIpWithPort;

        if (proxyDomain && proxyDomain !== "N/A") {
          let resolvedIp = proxyDomain;
          if (!/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(proxyDomain)) {
            try {
              const dnsRes = await fetch(\`https://dns.google/resolve?name=\${encodeURIComponent(proxyDomain)}&type=A\`);
              if (dnsRes.ok) {
                const dnsData = await dnsRes.json();
                const ipAnswer = dnsData.Answer?.find(a => a.type === 1);
                if (ipAnswer) resolvedIp = ipAnswer.data;
              }
            } catch (e) {
              console.error('DNS resolution failed:', e);
            }
          }
          
          const proxyGeo = await fetchIpApiInfo(resolvedIp);
          if (proxyGeo) {
            document.getElementById('proxy-ip').textContent = proxyGeo.ip || 'N/A';
            document.getElementById('proxy-location').textContent = 
              [proxyGeo.city, proxyGeo.country_name].filter(Boolean).join(', ') || 'N/A';
            document.getElementById('proxy-isp').textContent = 
              proxyGeo.isp || proxyGeo.organisation || 'N/A';
          }
        }

        const clientIp = await fetchClientIP();
        if (clientIp) {
          document.getElementById('client-ip').textContent = clientIp;
          const scamalyticsData = await fetchScamalyticsInfo(clientIp);
          
          if (scamalyticsData?.scamalytics?.status === 'ok') {
            const sa = scamalyticsData.scamalytics;
            const dbip = scamalyticsData.external_datasources?.dbip;
            
            document.getElementById('client-location').textContent = 
              [dbip?.ip_city, dbip?.ip_country_name].filter(Boolean).join(', ') || 'N/A';
            document.getElementById('client-isp').textContent = 
              sa.scamalytics_isp || dbip?.isp_name || 'N/A';
            
            const riskText = sa.scamalytics_score !== undefined 
              ? \`\${sa.scamalytics_score} - \${sa.scamalytics_risk}\` 
              : 'N/A';
            document.getElementById('client-risk').textContent = riskText;
          }
        }
      } catch (error) {
        console.error('Network info loading failed:', error);
      }
    }

    document.addEventListener('DOMContentLoaded', () => {
      displayExpirationTimes();
      loadNetworkInfo();

      document.querySelectorAll('.button[data-clipboard-text]').forEach(button => {
        button.addEventListener('click', () => {
          copyToClipboard(button, button.dataset.clipboardText);
        });
      });

      document.getElementById('refresh-network-btn')?.addEventListener('click', () => {
        document.querySelectorAll('.network-info-grid span').forEach(el => {
          el.innerHTML = '<span class="skeleton"></span>';
        });
        loadNetworkInfo();
      });
    });
  `;
}

// ============================================================================
// MAIN FETCH HANDLER
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const cfg = Config.fromEnv(env);
    const url = new URL(request.url);

    // Admin panel routes
    if (url.pathname.startsWith('/admin')) {
      return handleAdminRequest(request, env, ctx);
    }

    // WebSocket/VLESS Protocol handler
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      if (!env.DB || !env.USER_KV) {
        return new Response('Service not configured properly', { status: 503 });
      }
      
      const requestConfig = {
        userID: cfg.userID,
        proxyIP: cfg.proxyIP,
        proxyPort: cfg.proxyPort,
        socks5Address: cfg.socks5.address,
        socks5Relay: cfg.socks5.relayMode,
        enableSocks: cfg.socks5.enabled,
        parsedSocks5Address: cfg.socks5.enabled ? socks5AddressParser(cfg.socks5.address) : {},
      };
      
      return await ProtocolOverWSHandler(request, requestConfig, env, ctx);
    }

    // Scamalytics lookup endpoint
    if (url.pathname === '/scamalytics-lookup') {
      return handleScamalyticsLookup(request, cfg);
    }

    // Subscription handlers
    const handleSubscription = async (core) => {
      const uuid = url.pathname.slice(`/${core}/`.length);
      if (!isValidUUID(uuid)) {
        return new Response('Invalid UUID', { status: 400 });
      }
      
      const userData = await getUserData(env, uuid, ctx);
      if (!userData) {
        return new Response('Invalid user', { status: 403 });
      }
      
      if (isExpired(userData.expiration_date, userData.expiration_time)) {
        return new Response('User expired', { status: 403 });
      }
      
      if (userData.traffic_limit && userData.traffic_limit > 0 && 
          userData.traffic_used >= userData.traffic_limit) {
        return new Response('Data limit reached', { status: 403 });
      }
      
      return handleIpSubscription(core, uuid, url.hostname);
    };

    if (url.pathname.startsWith('/xray/')) {
      return handleSubscription('xray');
    }
    
    if (url.pathname.startsWith('/sb/')) {
      return handleSubscription('sb');
    }

    // User config page
    const path = url.pathname.slice(1);
    if (isValidUUID(path)) {
      const userData = await getUserData(env, path, ctx);
      if (!userData) {
        return new Response('Invalid user', { status: 403 });
      }
      
      return handleConfigPage(path, url.hostname, cfg.proxyAddress, userData);
    }

    // Root proxy fallback (if configured)
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
        return new Response(`Proxy configuration error: ${e.message}`, { status: 502 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
