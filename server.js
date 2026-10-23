
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const INTERVAL = (+process.env.POLL_SECONDS || 30) * 1000;
const SIMULATE = process.env.SIMULATE === '1';
const WARN_MS = +process.env.WARN_LATENCY_MS || 150;
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = ['router', 'switch', 'ap', 'server', 'pc', 'iot', 'laptop', 'phone'];

// ---------- storage ----------
let devices = [];
let state = { checks: [], events: [] };

const dev = (id, name, type, ip, mac, os, parent, x, y) =>
  ({ id, name, type, ip, mac, os, parent, x, y, status: 'offline', latencyMs: null, lastSeen: null });

const SEED = [
  dev(1, 'EdgeRouter Pro', 'router', '192.168.1.1', 'AA:BB:CC:00:00:01', 'RouterOS', null, 450, 40),
  dev(2, 'CoreSwitch-1', 'switch', '192.168.1.2', 'AA:BB:CC:00:00:02', 'SwitchOS', 1, 450, 150),
  dev(3, 'AppServer-1', 'server', '192.168.1.10', 'AA:BB:CC:00:00:03', 'Ubuntu 22.04', 2, 150, 250),
  dev(4, 'Dev-Workstation', 'pc', '192.168.1.50', 'AA:BB:CC:00:00:04', 'Windows 11', 2, 330, 250),
  dev(6, 'Office-PC', 'pc', '192.168.1.51', 'AA:BB:CC:00:00:06', 'Windows 11', 2, 570, 250),
  dev(5, 'IoT-Sensor', 'iot', '192.168.1.70', 'AA:BB:CC:00:00:05', 'Embedded', 2, 750, 250)
];

function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  devices = readJson(DEVICES_FILE, null) || SEED;
  state = readJson(STATE_FILE, state);
  saveNow();
}

function saveNow() {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

let timer;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      saveNow();
    } catch (e) {
      console.error(e.message);
    }
  }, 300);
};

const nextId = () => devices.reduce((m, d) => Math.max(m, d.id), 0) + 1;

// ---------- events ----------
function addEvent(severity, d, action, description, user = 'System') {
  const e = {
    id: Date.now() + Math.random(),
    ts: Date.now(),
    severity,
    deviceId: d ? d.id : null,
    device: d ? d.name : 'Network',
    ip: d ? d.ip : null,
    action,
    description,
    user,
    resolvedTs: null
  };

  state.events.unshift(e);
  state.events.length = Math.min(state.events.length, 2000);
  return e;
}

function resolveEvents(d) {
  for (const e of state.events) {
    if (
      e.deviceId === d.id &&
      !e.resolvedTs &&
      (e.severity === 'critical' || e.severity === 'warning')
    ) {
      e.resolvedTs = Date.now();
    }
  }
}

// ---------- monitoring ----------
function ping(ip) {
  return new Promise((resolve) => {
    if (SIMULATE) {
      const r = Math.random();
      return resolve(
        r < 0.8
          ? { up: true, ms: Math.round(1 + Math.random() * 40) }
          : r < 0.9
            ? { up: true, ms: 200 }
            : { up: false }
      );
    }

    if (!/^[0-9a-fA-F:.]+$/.test(ip)) {
      return resolve({ up: false });
    }

    const args = process.platform === 'win32'
      ? ['-n', '1', '-w', '2000', ip]
      : ['-c', '1', '-W', '2', ip];

    const t0 = Date.now();

    execFile('ping', args, { timeout: 5000 }, (err, out) => {
      if (err) return resolve({ up: false });

      const m = /time[=<]\s*([\d.]+)/i.exec(out || '');
      resolve({
        up: true,
        ms: m ? Math.round(+m[1]) : Date.now() - t0
      });
    });
  });
}

async function checkDevice(d, first = false) {
  const res = await ping(d.ip);
  const prev = d.status;

  d.status = !res.up
    ? 'offline'
    : res.ms > WARN_MS
      ? 'warning'
      : 'online';

  d.latencyMs = res.up ? res.ms : null;

  if (res.up) d.lastSeen = Date.now();

  if (prev !== d.status && !(first && d.status === 'online')) {
    if (d.status === 'offline') {
      addEvent('critical', d, 'Device disconnected',
        `${d.name} · ${d.ip} is not responding to ping.`);
    } else if (d.status === 'warning') {
      addEvent('warning', d, 'Device health warning',
        `${d.name} · ${d.ip} latency is ${res.ms} ms.`);
    } else {
      resolveEvents(d);
      addEvent('info', d, 'Device reconnected',
        `${d.name} · ${d.ip} is back online.`);
    }
  }

  return d;
}

let firstRun = true;

async function scanAll(announce = true) {
  await Promise.all(devices.map((d) => checkDevice(d, firstRun)));

  firstRun = false;

  const online = devices.filter((d) => d.status === 'online').length;

  state.checks.push({
    ts: Date.now(),
    online,
    total: devices.length
  });

  state.checks = state.checks.filter(
    (c) => c.ts >= Date.now() - 7 * 864e5
  );

  if (announce) {
    addEvent(
      'info',
      null,
      'Network scan completed',
      `${devices.length} devices scanned successfully`
    );
  }

  save();

  const scannedAt = new Date().toISOString();

  // Send the latest monitoring data to connected browser pages.
  io.emit('networkUpdate', {
    devices,
    dashboard: dashboard(),
    activity: activity(),
    scannedAt
  });

  return scannedAt;
}

// ---------- derived data ----------
const counts = () => ({
  total: devices.length,
  online: devices.filter((d) => d.status === 'online').length,
  offline: devices.filter((d) => d.status === 'offline').length,
  warning: devices.filter((d) => d.status === 'warning').length
});

function dashboard() {
  const c = counts();

  return {
    ...c,
    health: c.total ? +((c.online / c.total) * 100).toFixed(1) : 0,
    traffic: null
  };
}

function availability(hours = 24) {
  const since = Date.now() - hours * 36e5;
  const size = Math.max((hours * 36e5) / 48, 60e3);
  const map = new Map();

  for (const c of state.checks) {
    if (c.ts < since) continue;

    const k = Math.floor(c.ts / size) * size;
    const b = map.get(k) || { s: 0, n: 0 };

    b.s += c.total ? (c.online / c.total) * 100 : 0;
    b.n++;
    map.set(k, b);
  }

  return [...map]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, b]) => ({
      ts,
      availability: +(b.s / b.n).toFixed(1)
    }));
}

const distribution = () => {
  const out = {};
  for (const d of devices) {
    out[d.type] = (out[d.type] || 0) + 1;
  }
  return out;
};

const clock = (ts) => new Date(ts).toLocaleTimeString('en-US', {
  hour: '2-digit',
  minute: '2-digit'
});

const stamp = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');

  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const dur = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);

  return h ? `${h}h ${m}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
};

const ICON = {
  critical: ['danger', '!'],
  error: ['danger', '!'],
  warning: ['warning', '!']
};

const activity = () => state.events.slice(0, 8).map((e) => {
  const [type, icon] = ICON[e.severity] ||
    (e.action === 'Device reconnected'
      ? ['info', '+']
      : ['success', '✓']);

  return {
    title: e.action,
    description: e.ip ? `${e.device} · ${e.ip}` : e.description,
    time: clock(e.ts),
    type,
    icon,
    ts: e.ts
  };
});

const activeAlerts = (severity) => state.events
  .filter((e) =>
    !e.resolvedTs &&
    (e.severity === 'critical' || e.severity === 'warning') &&
    (!severity || severity === 'all' || e.severity === severity)
  )
  .map((e) => ({
    time: new Date(e.ts).toLocaleTimeString('en-US'),
    severity: e.severity,
    device: e.device,
    message: e.action,
    duration: dur(Date.now() - e.ts)
  }));

function history(q = '', from, to, type = 'all') {
  q = q.toLowerCase();
  type = type.toLowerCase();

  const f = from ? Date.parse(from) : 0;
  const t = to ? Date.parse(to) + 864e5 : Infinity;

  return state.events
    .filter((e) =>
      e.ts >= f &&
      e.ts < t &&
      (!q || [e.device, e.action, e.description]
        .join(' ').toLowerCase().includes(q)) &&
      (type === 'all' || e.action.toLowerCase().includes(type))
    )
    .slice(0, 500)
    .map((e) => ({
      timestamp: stamp(e.ts),
      severity: e.severity,
      source: e.device,
      action: e.action,
      user: e.user,
      description: e.description
    }));
}

// ---------- HTTP ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const send = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    ...CORS
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((ok, no) => {
  let s = '';

  req.on('data', (c) => {
    s += c;
    if (s.length > 1e5) req.destroy();
  });

  req.on('end', () => {
    try {
      ok(s ? JSON.parse(s) : {});
    } catch (e) {
      no(new Error('invalid JSON'));
    }
  });
});

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

function clean(b, partial) {
  const o = {};
  const need = (k) => !partial || k in b;

  if (need('name')) {
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return { error: 'name required' };
    }
    o.name = b.name.trim().slice(0, 80);
  }

  if (need('type')) {
    if (!TYPES.includes(b.type)) {
      return { error: `type must be one of: ${TYPES.join(', ')}` };
    }
    o.type = b.type;
  }

  if (need('ip')) {
    if (typeof b.ip !== 'string' || !IP_RE.test(b.ip)) {
      return { error: 'valid ip required' };
    }
    o.ip = b.ip;
  }

  for (const k of ['mac', 'os']) {
    if (k in b) o[k] = String(b[k]).slice(0, 60);
  }

  for (const k of ['parent', 'x', 'y']) {
    if (k in b) o[k] = b[k] === null ? null : +b[k];
  }

  return { value: o };
}

async function api(req, res, url) {
  const [, resource, id, action] = url.pathname.split('/').filter(Boolean);
  const m = req.method;
  const qs = url.searchParams;

  if (m === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (m === 'GET') {
    if (resource === 'dashboard') return send(res, 200, dashboard());
    if (resource === 'availability') return send(res, 200, availability(+qs.get('hours') || 24));
    if (resource === 'distribution') return send(res, 200, distribution());
    if (resource === 'activity') return send(res, 200, activity());
    if (resource === 'attention') return send(res, 200, devices.filter((d) => d.status !== 'online'));

    if (resource === 'logs' && id === 'events') {
      return send(res, 200, activeAlerts(qs.get('severity')));
    }

    if (resource === 'logs' && id === 'history') {
      return send(res, 200, history(
        qs.get('q') || '',
        qs.get('from'),
        qs.get('to'),
        qs.get('type') || 'all'
      ));
    }
  }

  if (resource === 'scan' && m === 'POST') {
    const scannedAt = await scanAll();
    return send(res, 200, { devices, scannedAt });
  }

  if (resource === 'devices') {
    if (!id) {
      if (m === 'GET') return send(res, 200, devices);

      if (m === 'POST') {
        const { value, error } = clean(await readBody(req), false);
        if (error) return send(res, 400, { error });

        const d = {
          id: nextId(),
          mac: '',
          os: '',
          parent: null,
          x: 450,
          y: 250,
          status: 'offline',
          latencyMs: null,
          lastSeen: null,
          ...value
        };

        devices.push(d);
        addEvent('info', d, 'Device added',
          `${d.name} · ${d.ip} added to monitoring.`, 'Admin');

        await checkDevice(d, true);
        save();

        return send(res, 201, d);
      }
    } else {
      const d = devices.find((x) => x.id === +id);
      if (!d) return send(res, 404, { error: 'device not found' });

      if (m === 'GET' && !action) return send(res, 200, d);

      if (m === 'POST' && action === 'scan') {
        await checkDevice(d);
        save();
        return send(res, 200, d);
      }

      if (m === 'PATCH' && !action) {
        const { value, error } = clean(await readBody(req), true);
        if (error) return send(res, 400, { error });

        Object.assign(d, value);
        save();
        return send(res, 200, d);
      }

      if (m === 'DELETE' && !action) {
        devices = devices.filter((x) => x !== d);
        devices.forEach((x) => {
          if (x.parent === d.id) x.parent = null;
        });

        addEvent('warning', null, 'Device removed',
          `${d.name} · ${d.ip} removed from monitoring.`, 'Admin');

        save();
        return send(res, 200, { ok: true });
      }
    }
  }

  send(res, 404, { error: 'not found' });
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(res, url) {
  const p = path.normalize(
    path.join(
      PUBLIC_DIR,
      decodeURIComponent(url.pathname) === '/'
        ? 'index.html'
        : decodeURIComponent(url.pathname)
    )
  );

  if (!p.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }

  fs.readFile(p, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream'
    });
    res.end(data);
  });
}

// ---------- start server ----------
load();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await api(req, res, url);
    } else {
      serveStatic(res, url);
    }
  } catch (e) {
    send(res, e.message === 'invalid JSON' ? 400 : 500, {
      error: e.message
    });
  }
});

const io = new Server(server);

io.on('connection', (socket) => {
  console.log('Client connected to Socket.IO');

  socket.emit('networkUpdate', {
    devices,
    dashboard: dashboard(),
    activity: activity(),
    scannedAt: new Date().toISOString()
  });
});

server.listen(PORT, () => {
  console.log(
    `NetworkMonitor → http://localhost:${PORT}  (poll ${INTERVAL / 1000}s${SIMULATE ? ', SIMULATED' : ''})`
  );

  scanAll(false);
  setInterval(() => scanAll(false), INTERVAL);
});
