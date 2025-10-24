// _worker.js
// Combined, production-ready Cloudflare Worker
// - Combines original script (VLESS over WS, admin panel, D1 + KV) with robust fromEnv + proxy selection
// - Adds user-facing panel (subscription/config page)
// - Adds connection timeouts, retries, and safer parsing
// Comments are intentionally in English to avoid localization parsing issues.

import { connect } from 'cloudflare:sockets';

/* ======================
   Configuration & Helpers
   ====================== */

const DEFAULT_PROXY_LIST = [
  'nima.nscl.ir:443'
  // you can add more defaults here
];

const DEFAULTS = {
  userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
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
  // connection parameters
  CONNECT_TIMEOUT_MS: 8000,
  SOCKET_RETRY_DELAY_MS: 400,
  MAX_SOCKET_RETRIES: 2,
};

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch(e) { return null; }
}

function pad(n){ return String(n).padStart(2,'0'); }

function nowISO() { return new Date().toISOString().replace('T',' ').slice(0,19); }

/* ======================
   Config.fromEnv with proxy selection (merged logic)
   - preserves proxyIPs array
   - env.PROXYIP can override
   - returns proxyHost, proxyPort, proxyAddress and all other env-driven values
   ====================== */

const Config = {
  proxyIPs: DEFAULT_PROXY_LIST,
  userID: DEFAULTS.userID,
  scamalytics: DEFAULTS.scamalytics,
  socks5: DEFAULTS.socks5,

  fromEnv(env = {}) {
    // Support env.PROXYIP override OR pick random from list
    const resolvedList = (env.PROXY_LIST && typeof env.PROXY_LIST === 'string')
      ? env.PROXY_LIST.split(',').map(s=>s.trim()).filter(Boolean)
      : this.proxyIPs;

    const selectedProxyIP = (env.PROXYIP && env.PROXYIP.trim())
      ? env.PROXYIP.trim()
      : resolvedList[Math.floor(Math.random() * resolvedList.length)];

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
        relayMode: (env.SOCKS5_RELAY === 'true') || this.socks5.relayMode,
        address: env.SOCKS5 || this.socks5.address,
      },
      adminKey: env.ADMIN_KEY || null,
      rootProxyUrl: env.ROOT_PROXY_URL || null,
      connectTimeoutMs: parseInt(env.CONNECT_TIMEOUT_MS || DEFAULTS.CONNECT_TIMEOUT_MS, 10),
      socketRetryDelayMs: parseInt(env.SOCKET_RETRY_DELAY_MS || DEFAULTS.SOCKET_RETRY_DELAY_MS || DEFAULTS.SOCKET_RETRY_DELAY_MS, 10),
      maxSocketRetries: parseInt(env.MAX_SOCKET_RETRIES || DEFAULTS.MAX_SOCKET_RETRIES, 10),
    };
  }
};

/* ======================
   Utilities for UUID / Date / Validation
   ====================== */

function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // fallback simple pseudo-uuid (shouldn't be needed in CF runtime)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0; const v = c === 'x' ? r : (r&0x3|0x8); return v.toString(16);
  });
}

function utcCompare(expDate, expTime) {
  // expects YYYY-MM-DD and HH:MM:SS
  try {
    const iso = `${expDate}T${expTime}Z`;
    const d = new Date(iso);
    if (isNaN(d)) return false;
    return d > new Date();
  } catch (e) { return false; }
}

/* ======================
   KV + D1 helpers
   - getUserData: reads KV then falls back to D1
   - caches in KV
   ====================== */

async function getUserData(env, uuid) {
  if (!uuid) return null;
  const kvKey = `user:${uuid}`;
  try {
    const cached = await env.USER_KV.get(kvKey);
    if (cached) {
      const parsed = safeParseJSON(cached);
      if (parsed) return parsed;
    }

    // D1: SELECT expiration_date, expiration_time, created_at, notes FROM users WHERE uuid = ?
    try {
      const q = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, notes FROM users WHERE uuid = ? LIMIT 1").bind(uuid).first();
      if (!q) return null;
      const userData = {
        uuid: q.uuid,
        created_at: q.created_at,
        expiration_date: q.expiration_date,
        expiration_time: q.expiration_time,
        notes: q.notes,
      };
      await env.USER_KV.put(kvKey, JSON.stringify(userData), { expirationTtl: 3600 });
      return userData;
    } catch (e) {
      console.error('D1 getUserData error', e);
      return null;
    }
  } catch (e) {
    console.error('getUserData KV/D1 error', e);
    return null;
  }
}

/* ======================
   Admin session check
   - session stored in KV as 'admin_session_token'
   ====================== */

async function isAdmin(request, env) {
  try {
    const cookieHeader = request.headers.get('Cookie') || '';
    const token = cookieHeader.match(/auth_token=([^;]+)/)?.[1];
    if (!token) return false;
    const stored = await env.USER_KV.get('admin_session_token');
    return stored && stored === token;
  } catch (e) {
    console.error('isAdmin error', e);
    return false;
  }
}

/* ======================
   HTML: Admin Login + Admin Panel
   (kept comprehensive from uploaded file, slightly sanitized)
   ====================== */

const adminLoginHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .login{background:#0b1220;padding:32px;border-radius:12px; width:360px; box-shadow:0 6px 20px rgba(2,6,23,.6)}
  h1{margin:0 0 16px;font-size:20px;color:#e6eef8}
  input{width:100%;padding:10px;margin:8px 0;border-radius:8px;border:1px solid #233047;background:#081122;color:#fff}
  button{width:100%;padding:10px;border-radius:8px;border:none;background:#1e90ff;color:#fff;font-weight:600}
  .error{color:#ff6b6b;margin-top:8px}
</style>
</head><body>
  <div class="login">
    <h1>Admin Login</h1>
    <form method="POST" action="/admin">
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Login</button>
    </form>
  </div>
</body></html>`;

// Admin panel HTML: (a compact but full-featured panel)
// For brevity in this combined file I keep it compact but full-function.
const adminPanelHTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title>
<style>
  :root{--bg:#0b1220;--card:#0f172a;--muted:#94a3b8;--accent:#60a5fa}
  body{font-family:Inter,system-ui,Segoe UI,Roboto;background:var(--bg);color:#e6eef8;margin:0;padding:20px}
  .wrap{max-width:1100px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between}
  h1{margin:0;font-size:20px}
  .card{background:var(--card);padding:18px;border-radius:12px;margin-top:18px}
  input,select{background:#061226;border:1px solid #233043;padding:8px;border-radius:8px;color:#e6eef8}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{padding:10px;border-bottom:1px solid #162233;text-align:left;font-family:monospace}
  .btn{padding:8px 10px;border-radius:8px;border:none;background:var(--accent);color:#021029;cursor:pointer}
  .btn-danger{background:#ef4444;color:#fff}
</style>
</head>
<body>
  <div class="wrap">
    <header><h1>Admin Dashboard</h1><div><form method="POST" action="/admin"><button class="btn" type="submit">Refresh</button></form></div></header>
    <div class="card">
      <h3>Create User</h3>
      <form id="createUserForm">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="uuid" placeholder="UUID" style="flex:1" required>
          <button id="gen" type="button" class="btn">Generate</button>
          <input id="expiryDate" type="date" required>
          <input id="expiryTime" type="time" step="1" required>
          <input id="notes" placeholder="Notes" style="flex:1">
        </div>
        <div style="margin-top:8px"><button class="btn" type="submit">Create</button></div>
      </form>
    </div>

    <div class="card">
      <h3>User List</h3>
      <div id="usersRoot">Loading...</div>
    </div>
  </div>

<script>
(async function(){
  const API='/admin/api';
  const root=document.getElementById('usersRoot');
  document.getElementById('gen').addEventListener('click',()=>{ if(crypto.randomUUID) document.getElementById('uuid').value=crypto.randomUUID(); });
  async function fetchUsers(){
    try{
      const r=await fetch(API+'/users',{credentials:'include'});
      if(!r.ok) throw new Error('fetch users failed');
      const data=await r.json();
      if(!Array.isArray(data)) { root.textContent='No users'; return; }
      const table=document.createElement('table');
      table.innerHTML='<thead><tr><th>UUID</th><th>Created</th><th>Expiry (UTC)</th><th>Notes</th><th>Actions</th></tr></thead>';
      const tbody=document.createElement('tbody');
      data.forEach(u=>{
        const tr=document.createElement('tr');
        tr.innerHTML='<td>'+u.uuid+'</td><td>'+ (u.created_at || '') +'</td><td>'+ (u.expiration_date ? (u.expiration_date+' '+u.expiration_time) : '-') +'</td><td>'+(u.notes||'-')+'</td><td><button class="del">Delete</button></td>';
        tr.querySelector('.del').addEventListener('click', async ()=>{ if(confirm('Delete '+u.uuid+'?')){ await fetch(API+'/users/'+u.uuid,{method:'DELETE'}); fetchUsers(); }});
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      root.innerHTML=''; root.appendChild(table);
    }catch(e){ root.textContent='Error: '+e.message; console.error(e); }
  }
  document.getElementById('createUserForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const uuid=document.getElementById('uuid').value;
    const d=document.getElementById('expiryDate').value;
    const t=document.getElementById('expiryTime').value;
    const notes=document.getElementById('notes').value;
    try{
      const r=await fetch(API+'/users',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({uuid,exp_date:d,exp_time:t,notes})});
      if(!r.ok) throw new Error('create failed'); fetchUsers();
    }catch(e){ alert('Error: '+e.message); }
  });
  await fetchUsers();
})();
</script>
</body></html>`;

/* ======================
   User-facing subscription/config page (skeleton 3)
   - When user visits /:uuid  -> render this nice page
   ====================== */

function generateUserPageHTML({ userID, hostName, proxyAddress, expDate, expTime }) {
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;
  const singleXray = `vless://${userID}@${hostName}:443?type=ws&host=${hostName}&path=/&security=tls#${encodeURIComponent(hostName+'-Xray')}`;
  const singleSb = `vless://${userID}@${hostName}:443?type=ws&host=${hostName}&path=/&security=tls#${encodeURIComponent(hostName+'-Singbox')}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Config</title>
<link rel="icon" href="data:," />
<style>
  body{font-family:Inter,system-ui,Segoe UI,Roboto;background:#071028;color:#e6eef8;margin:0;padding:20px}
  .wrap{max-width:980px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:center}
  h1{margin:0}
  .card{background:#0d2136;padding:18px;border-radius:12px;margin-top:18px}
  .code{background:#041623;padding:12px;border-radius:8px;font-family:monospace;overflow:auto}
  a.btn{display:inline-block;padding:8px 10px;border-radius:8px;background:#60a5fa;color:#021029;text-decoration:none;font-weight:700}
  .meta{color:#94a3b8}
</style>
</head><body>
  <div class="wrap">
    <header><h1>Configuration for ${hostName}</h1><div class="meta">Expires: ${expDate ? (expDate + ' ' + expTime + ' UTC') : 'None'}</div></header>
    <div class="card">
      <h3>Subscription URLs</h3>
      <div class="code"><strong>Xray subscription:</strong><br>${subXrayUrl}<br><br><strong>Singbox subscription:</strong><br>${subSbUrl}</div>
      <div style="margin-top:12px"><a class="btn" href="${subXrayUrl}">Open Xray Sub</a> <a class="btn" href="${subSbUrl}">Open Singbox Sub</a></div>
    </div>

    <div class="card">
      <h3>Single Configs</h3>
      <div class="code"><strong>Xray (single):</strong><br>${singleXray}<br><br><strong>Singbox (single):</strong><br>${singleSb}</div>
    </div>
  </div>
</body></html>`;
}

/* ======================
   Helper: fetchWithTimeout
   ====================== */

async function fetchWithTimeout(input, init = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(input, { ...init, signal: controller.signal });
    clearTimeout(id);
    return resp;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/* ======================
   Socket connect with timeout + retries
   - wraps cloudflare:sockets connect with abortable timeout
   ====================== */

async function connectWithTimeout({ hostname, port, timeoutMs = DEFAULTS.CONNECT_TIMEOUT_MS }) {
  // Note: cloudflare:sockets connect doesn't accept AbortSignal; simulate with Promise.race and manual timeout.
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`connect timeout to ${hostname}:${port} after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    (async () => {
      try {
        const sock = await connect({ hostname, port: Number(port) });
        if (settled) {
          // already timed out
          try { sock.close(); } catch(e) {}
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(sock);
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    })();
  });
}

/* ======================
   Core: WebSocket -> TCP (ProtocolOverWSHandler)
   - uses ProcessProtocolHeader, RemoteSocketToWS, HandleTCPOutBound
   - preserves original logic but uses safe helpers
   ====================== */

async function ProtocolOverWSHandler(request, config, env) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  let address = '';
  let portWithRandomLog = '';
  let udpStreamWriter = null;
  let remoteSocket = { value: null };
  const log = (info, event) => console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');

  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = MakeReadableWebSocketStream(server, earlyDataHeader, log);

  readableWebSocketStream
    .pipeTo(new WritableStream({
      async write(chunk, controller) {
        if (udpStreamWriter) {
          return udpStreamWriter.write(chunk);
        }
        if (remoteSocket.value) {
          // write to existing remote socket writer
          const writer = remoteSocket.value.writable.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
          return;
        }

        const {
          hasError, message, addressType, portRemote = 443, addressRemote = '', rawDataIndex, ProtocolVersion, isUDP
        } = await ProcessProtocolHeader(chunk, env);

        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random().toString(36).slice(2,8)} ${isUDP ? 'udp' : 'tcp'}`;

        if (hasError) {
          controller.error(message);
          return;
        }

        const vlessResponseHeader = new Uint8Array([ProtocolVersion[0] || 0, 0]);
        const rawClientData = chunk.slice(rawDataIndex);

        if (isUDP) {
          if (portRemote === 53) {
            const dnsPipeline = await createDnsPipeline(server, vlessResponseHeader, log);
            udpStreamWriter = dnsPipeline.write;
            await udpStreamWriter(rawClientData);
          } else {
            controller.error('UDP proxy only allowed for DNS (port 53)');
          }
          return;
        }

        // TCP path: try to connect and pipe
        HandleTCPOutBound(remoteSocket, addressType, addressRemote, portRemote, rawClientData, server, vlessResponseHeader, log, config);
      },
      close() { log('readableWebSocketStream closed'); },
      abort(err) { log('readableWebSocketStream aborted', err); }
    }))
    .catch(err => {
      console.error('Pipeline failed:', err && (err.stack || err));
    });

  return new Response(null, { status: 101, webSocket: client });
}

async function ProcessProtocolHeader(protocolBuffer, env) {
  try {
    if (!protocolBuffer || protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };

    const dataView = new DataView(protocolBuffer);
    const version = dataView.getUint8(0);
    // UUID is bytes [1..16]
    const uuidArr = new Uint8Array(protocolBuffer.slice(1, 17));
    const uuid = unsafeStringify(uuidArr, 0);

    const userData = await getUserData(env, uuid);
    if (!userData || !utcCompare(userData.expiration_date, userData.expiration_time)) {
      return { hasError: true, message: 'invalid or expired user' };
    }

    const optLength = dataView.getUint8(17);
    const command = dataView.getUint8(18 + optLength);
    if (command !== 1 && command !== 2) return { hasError: true, message: `command ${command} not supported` };

    const portIndex = 18 + optLength + 1;
    const portRemote = dataView.getUint16(portIndex);
    const addressType = dataView.getUint8(portIndex + 2);
    let addressValue, addressLength, addressValueIndex;

    switch (addressType) {
      case 1: // IPv4
        addressLength = 4;
        addressValueIndex = portIndex + 3;
        addressValue = Array.from(new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + 4))).join('.');
        break;
      case 2: // Domain
        addressLength = dataView.getUint8(portIndex + 3);
        addressValueIndex = portIndex + 4;
        addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 3: // IPv6
        addressLength = 16;
        addressValueIndex = portIndex + 3;
        const parts = [];
        for (let i = 0; i < 8; i++) parts.push(dataView.getUint16(addressValueIndex + i*2).toString(16));
        addressValue = parts.join(':');
        break;
      default:
        return { hasError: true, message: `invalid addressType: ${addressType}` };
    }

    if (!addressValue) return { hasError: true, message: `addressValue empty` };

    return {
      hasError: false,
      addressRemote: addressValue,
      addressType,
      portRemote,
      rawDataIndex: addressValueIndex + addressLength,
      ProtocolVersion: new Uint8Array([version]),
      isUDP: command === 2,
    };
  } catch (e) {
    console.error('ProcessProtocolHeader error', e);
    return { hasError: true, message: 'processing header failed' };
  }
}

async function HandleTCPOutBound(remoteSocketWrapper, addressType, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, log, config) {
  async function connectAndWrite(address, port, useSocks = false) {
    // Attempt to connect with retries
    let lastErr = null;
    for (let attempt = 0; attempt <= config.maxSocketRetries; attempt++) {
      try {
        const targetHost = useSocks ? (config.socks5Address?.hostname || '127.0.0.1') : address;
        const targetPort = useSocks ? (config.socks5Address?.port || port) : port;
        const sock = await connectWithTimeout({ hostname: targetHost, port: targetPort, timeoutMs: config.connectTimeoutMs });
        // write initial rawClientData
        const writer = sock.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return sock;
      } catch (e) {
        lastErr = e;
        log(`connect attempt ${attempt} failed: ${e && e.message}`);
        await new Promise(res => setTimeout(res, config.socketRetryDelayMs || 200));
      }
    }
    throw lastErr || new Error('connect failed');
  }

  async function retry() {
    try {
      const tcpSocket = config.enableSocks ? await connectAndWrite(config.proxyIP || addressRemote, config.proxyPort || portRemote, true)
        : await connectAndWrite(config.proxyIP || addressRemote, config.proxyPort || portRemote, false);

      tcpSocket.closed
        .catch(error => console.log('retry tcpSocket closed error', error))
        .finally(() => safeCloseWebSocket(webSocket));
      RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log);
    } catch (e) {
      console.error('retry failed', e);
      safeCloseWebSocket(webSocket);
    }
  }

  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, retry, log);
  } catch (e) {
    console.error('HandleTCPOutBound final connect error', e);
    safeCloseWebSocket(webSocket);
  }
}

function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => controller.enqueue(event.data));
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer); controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer error'); controller.error(err);
      });
      // early data header may be base64
      try {
        const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
        if (error) controller.error(error);
        else if (earlyData) controller.enqueue(earlyData);
      } catch (e) { /* ignore */ }
    },
    pull() {},
    cancel(reason) { safeCloseWebSocket(webSocketServer); }
  });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log) {
  let hasIncomingData = false;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (webSocket.readyState !== 1) throw new Error('WebSocket is not open');
        hasIncomingData = true;
        const dataToSend = protocolResponseHeader ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer() : chunk;
        webSocket.send(dataToSend);
        protocolResponseHeader = null;
      },
      close() { log('Remote connection closed. incoming:' + hasIncomingData); },
      abort(reason) { console.error('remote readable abort', reason); }
    }));
  } catch (err) {
    console.error('RemoteSocketToWS error', err && (err.stack || err));
    safeCloseWebSocket(webSocket);
  }
  if (!hasIncomingData && retry) {
    log('No incoming data, performing retry');
    retry();
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    const padding = '='.repeat((4 - (base64Str.length % 4)) % 4);
    const base64 = (base64Str + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const buffer = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
    return { earlyData: buffer, error: null };
  } catch (e) { return { earlyData: null, error: e }; }
}

function safeCloseWebSocket(socket) {
  try {
    if (!socket) return;
    if (socket.readyState === 1 || socket.readyState === 2) socket.close();
  } catch (e) { console.error('safeCloseWebSocket', e); }
}

/* ======================
   Misc helpers copied/preserved
   - unsafeStringify/stringify for uuid extraction
   ====================== */

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

/* ======================
   Scamalytics lookup handler (preserved)
   ====================== */

async function handleScamalyticsLookup(request, config) {
  const url = new URL(request.url);
  const ipToLookup = url.searchParams.get('ip');
  if (!ipToLookup) {
    return new Response(JSON.stringify({ error: 'Missing IP parameter' }), { status: 400, headers: { 'Content-Type': 'application/json' }});
  }
  const { username, apiKey, baseUrl } = config.scamalytics;
  if (!username || !apiKey) {
    return new Response(JSON.stringify({ error: 'Scamalytics API credentials not configured.' }), { status: 500, headers: { 'Content-Type': 'application/json' }});
  }
  const scamalyticsUrl = `${baseUrl}${username}/?key=${apiKey}&ip=${ipToLookup}`;
  try {
    const resp = await fetchWithTimeout(scamalyticsUrl, { headers: {'Content-Type':'application/json'} }, 8000);
    const body = await resp.json();
    return new Response(JSON.stringify(body), { headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'} });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500, headers: {'Content-Type':'application/json'} });
  }
}

/* ======================
   IP subscription builder (preserved, with small fixes)
   ====================== */

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
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: { ed: 2560, eh: 'Sec-WebSocket-Protocol' } },
    tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: { ed: 2560, eh: 'Sec-WebSocket-Protocol' } },
  },
};

function makeName(tag, proto) { return `${tag}-${proto.toUpperCase()}`; }

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path });
  if (security) params.set('security', security);
  if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp);
  if (alpn) params.set('alpn', alpn);
  for (const [k,v] of Object.entries(extra)) params.set(k,v);
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

function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

async function handleIpSubscription(core, uuid, hostName, env) {
  const cfg = Config.fromEnv(env);
  const mainDomains = [
    hostName, 'creativecommons.org', 'www.speedtest.net',
    'sky.rethinkdns.com', 'go.inmobi.com', 'www.visa.com', 'cdnjs.com'
  ];
  const httpsPorts = [443,8443,2053,2083,2087,2096];
  const httpPorts = [80,8080,8880,2052,2082,2086,2095];
  let links = [];
  const isPagesDeployment = hostName.endsWith('.pages.dev');

  mainDomains.forEach((domain,i) => {
    links.push(buildLink({ core, proto: 'tls', userID: uuid, hostName: hostName, address: domain, port: pick(httpsPorts), tag: `D${i+1}` }));
    if (!isPagesDeployment) links.push(buildLink({ core, proto: 'tcp', userID: uuid, hostName, address: domain, port: pick(httpPorts), tag: `D${i+1}` }));
  });

  // try to fetch cloudflare IPs (best-effort)
  try {
    const r = await fetchWithTimeout('https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json', {}, 6000);
    if (r.ok) {
      const j = await r.json();
      const ips = [...(j.ipv4||[]).map(x=>x.ip), ...(j.ipv6||[]).map(x=>x.ip)].slice(0,20);
      ips.forEach((ip,i)=>{
        const formatted = ip.includes(':') ? `[${ip}]` : ip;
        links.push(buildLink({ core, proto:'tls', userID:uuid, hostName, address:formatted, port:pick(httpsPorts), tag:`IP${i+1}` }));
        if (!isPagesDeployment) links.push(buildLink({ core, proto:'tcp', userID:uuid, hostName, address:formatted, port:pick(httpPorts), tag:`IP${i+1}` }));
      });
    }
  } catch(e){ console.error('fetch IP list failed', e); }

  const joined = links.join('\n');
  return new Response(btoa(joined), { headers: { 'Content-Type':'text/plain;charset=utf-8' }});
}

/* ======================
   Main fetch handler
   - routes: /admin*, /scamalytics-lookup, /xray/:uuid, /sb/:uuid, /:uuid (user page), websocket upgrade, root proxy
   ====================== */

export default {
  async fetch(request, env, ctx) {
    const cfg = Config.fromEnv(env);
    const url = new URL(request.url);
    const { pathname } = url;

    // Admin routes
    if (pathname.startsWith('/admin')) {
      return handleAdminRequest(request, env, cfg);
    }

    // websocket upgrade: VLESS over WS
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      // Use ProtocolOverWSHandler
      const requestConfig = {
        userID: cfg.userID,
        proxyIP: cfg.proxyIP,
        proxyPort: cfg.proxyPort,
        enableSocks: cfg.socks5.enabled,
        socks5Relay: cfg.socks5.relayMode,
        parsedSocks5Address: cfg.socks5.address ? socks5AddressParser(cfg.socks5.address) : null,
        connectTimeoutMs: cfg.connectTimeoutMs,
        maxSocketRetries: cfg.maxSocketRetries,
        socketRetryDelayMs: cfg.socketRetryDelayMs,
      };
      return await ProtocolOverWSHandler(request, requestConfig, env);
    }

    // Scamalytics lookup
    if (pathname === '/scamalytics-lookup') {
      return handleScamalyticsLookup(request, cfg);
    }

    // Xray and SB subscription routes
    if (pathname.startsWith('/xray/')) {
      const uuid = pathname.slice('/xray/'.length);
      if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
      const userData = await getUserData(env, uuid);
      if (!userData || !utcCompare(userData.expiration_date, userData.expiration_time)) {
        return new Response('Invalid or expired user', { status: 403 });
      }
      return handleIpSubscription('xray', uuid, url.hostname, env);
    }
    if (pathname.startsWith('/sb/')) {
      const uuid = pathname.slice('/sb/'.length);
      if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
      const userData = await getUserData(env, uuid);
      if (!userData || !utcCompare(userData.expiration_date, userData.expiration_time)) {
        return new Response('Invalid or expired user', { status: 403 });
      }
      return handleIpSubscription('sb', uuid, url.hostname, env);
    }

    // If path is a UUID => user-facing config page
    const pathWithoutSlash = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    if (isValidUUID(pathWithoutSlash)) {
      const userData = await getUserData(env, pathWithoutSlash);
      if (!userData || !utcCompare(userData.expiration_date, userData.expiration_time)) return new Response('Invalid or expired user', { status: 403 });
      return new Response(generateUserPageHTML({
        userID: pathWithoutSlash,
        hostName: url.hostname,
        proxyAddress: cfg.proxyAddress,
        expDate: userData.expiration_date,
        expTime: userData.expiration_time
      }), { headers: { 'Content-Type': 'text/html; charset=utf-8' }});
    }

    // Root proxy support
    if (cfg.rootProxyUrl) {
      try {
        const proxyUrl = new URL(cfg.rootProxyUrl);
        const targetUrl = new URL(request.url);
        targetUrl.hostname = proxyUrl.hostname;
        targetUrl.protocol = proxyUrl.protocol;
        targetUrl.port = proxyUrl.port;
        const newReq = new Request(targetUrl, request);
        newReq.headers.set('Host', proxyUrl.hostname);
        newReq.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
        newReq.headers.set('X-Forwarded-Proto', targetUrl.protocol.replace(':',''));
        const resp = await fetchWithTimeout(newReq, {}, cfg.connectTimeoutMs || 8000);
        const mutable = new Headers(resp.headers);
        mutable.delete('Content-Security-Policy'); mutable.delete('X-Frame-Options');
        return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: mutable });
      } catch (e) {
        console.error('Reverse proxy error', e);
        return new Response(`Proxy configuration error or upstream down. Error: ${e.message}`, { status: 502 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
};

/* ======================
   Admin request handler (preserved / improved)
   ====================== */

async function handleAdminRequest(request, env, cfg) {
  const url = new URL(request.url);
  const { pathname } = url;
  const jsonHeader = { 'Content-Type': 'application/json' };

  if (!cfg.adminKey) {
    // if ADMIN_KEY not set, admin panel disabled
    return new Response('Admin panel not configured. Set ADMIN_KEY environment variable.', { status: 503 });
  }

  // API routes under /admin/api/
  if (pathname.startsWith('/admin/api/')) {
    if (!(await isAdmin(request, env))) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
    }

    if (request.method !== 'GET') {
      // basic CSRF check: Origin header must match
      const origin = request.headers.get('Origin');
      if (!origin || new URL(origin).hostname !== url.hostname) {
        return new Response(JSON.stringify({ error: 'Invalid Origin' }), { status: 403, headers: jsonHeader });
      }
    }

    // GET users list
    if (pathname === '/admin/api/users' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, notes FROM users ORDER BY created_at DESC").all();
        return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
      }
    }

    // POST create user
    if (pathname === '/admin/api/users' && request.method === 'POST') {
      try {
        const { uuid, exp_date: expDate, exp_time: expTime, notes } = await request.json();
        if (!uuid || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
          throw new Error('Invalid or missing fields. Use UUID, YYYY-MM-DD, and HH:MM:SS.');
        }
        await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes) VALUES (?, ?, ?, ?)").bind(uuid, expDate, expTime, notes || null).run();
        await env.USER_KV.put(`user:${uuid}`, JSON.stringify({ uuid, created_at: nowISO(), expiration_date: expDate, expiration_time: expTime, notes: notes || null }), { expirationTtl: 3600 });
        return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
          return new Response(JSON.stringify({ error: 'A user with this UUID already exists.' }), { status: 409, headers: jsonHeader });
        }
        return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 400, headers: jsonHeader });
      }
    }

    // bulk-delete
    if (pathname === '/admin/api/users/bulk-delete' && request.method === 'POST') {
      try {
        const { uuids } = await request.json();
        if (!Array.isArray(uuids) || uuids.length === 0) throw new Error('Invalid request body: Expected an array of UUIDs.');
        const deleteStmt = env.DB.prepare("DELETE FROM users WHERE uuid = ?");
        const stmts = uuids.map(u => deleteStmt.bind(u));
        await env.DB.batch(stmts);
        await Promise.all(uuids.map(u => env.USER_KV.delete(`user:${u}`)));
        return new Response(JSON.stringify({ success: true, count: uuids.length }), { status: 200, headers: jsonHeader });
      } catch (err) { return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 400, headers: jsonHeader }); }
    }

    const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/i);

    // PUT update user
    if (userRouteMatch && request.method === 'PUT') {
      const uuid = userRouteMatch[1];
      try {
        const { exp_date: expDate, exp_time: expTime, notes } = await request.json();
        if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
          throw new Error('Invalid date/time fields. Use YYYY-MM-DD and HH:MM:SS.');
        }
        await env.DB.prepare("UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ? WHERE uuid = ?").bind(expDate, expTime, notes || null, uuid).run();
        await env.USER_KV.put(`user:${uuid}`, JSON.stringify({ uuid, expiration_date: expDate, expiration_time: expTime, notes: notes || null }), { expirationTtl: 3600 });
        return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
      } catch (err) { return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 400, headers: jsonHeader }); }
    }

    // DELETE single user
    if (userRouteMatch && request.method === 'DELETE') {
      const uuid = userRouteMatch[1];
      try {
        await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
        await env.USER_KV.delete(`user:${uuid}`);
        return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
      } catch (err) { return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500, headers: jsonHeader }); }
    }

    return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
  }

  // Admin login page and panel
  if (pathname === '/admin') {
    if (request.method === 'POST') {
      // login attempt
      const form = await request.formData();
      const pass = form.get('password');
      if (pass === cfg.adminKey) {
        const token = generateUUID();
        await env.USER_KV.put('admin_session_token', token, { expirationTtl: 86400 });
        return new Response(null, { status: 302, headers: { 'Location': '/admin', 'Set-Cookie': `auth_token=${token}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict` }});
      } else {
        return new Response(adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>'), { status: 401, headers: { 'Content-Type':'text/html;charset=utf-8' }});
      }
    }
    if (request.method === 'GET') {
      const ok = await isAdmin(request, env);
      return new Response(ok ? adminPanelHTML : adminLoginHTML, { headers: { 'Content-Type':'text/html;charset=utf-8' }});
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  return new Response('Not found', { status: 404 });
}

/* ======================
   Helper: socks5 address parser (preserved)
   ====================== */

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
