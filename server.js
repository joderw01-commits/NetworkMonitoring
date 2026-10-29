const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const { execFile } = require('child_process');

const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const INTERVAL = (+process.env.POLL_SECONDS || 30) * 1000;
const SIMULATE = process.env.SIMULATE === '1';
// Auto-discovery of every device on the LAN (disable with DISCOVER=0).
// Override the scanned range with D ISCOVER_SUBNET=192.168.1.0/24,10.0.0.0/24
const DISCOVER = !SIMULATE && process.env.DISCOVER !== '0';
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
  devices = readJson(DEVICES_FILE, null) || (DISCOVER ? [] : SEED);
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
function ping(ip, fast = false) {
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
      ? ['-n', '1', '-w', fast ? '800' : '2000', ip]
      : ['-c', '1', '-W', fast ? '1' : '2', ip];

    const t0 = Date.now();

    execFile('ping', args, { timeout: 5000 }, (err, out) => {
      if (err) return resolve({ up: false });
      // Windows can exit 0 on "Destination host unreachable"; a real reply has TTL=
      if (process.platform === 'win32' && !/TTL=/i.test(out || '')) {
        return resolve({ up: false });
      }

      const m = /time[=<]\s*([\d.]+)/i.exec(out || '');
      resolve({
        up: true,
        ms: m ? Math.round(+m[1]) : Date.now() - t0
      });
    });
  });
}

async function checkDevice(d, first = false, pre = null) {
  const res = pre || await ping(d.ip);
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

// ---------- network discovery ----------
const ip2n = (ip) => ip.split('.').reduce((a, o) => a * 256 + +o, 0);
const n2ip = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// Skip docker / VM / VPN adapters so we scan your real LAN
const VIRTUAL_IF = /docker|veth|br-|virbr|vmnet|vboxnet|vethernet|tailscale|utun|awdl|llw/i;

function subnets() {
  const seen = new Map();

  const add = (addr, prefix, explicit) => {
    if (!explicit && prefix < 22) prefix = 24; // keep sweeps small
    if (prefix < 20 || prefix > 30) return;
    const size = 2 ** (32 - prefix);
    const a = ip2n(addr);
    const net = a - (a % size);
    seen.set(`${net}/${prefix}`, { net, size });
  };

  if (process.env.DISCOVER_SUBNET) {
    for (const c of process.env.DISCOVER_SUBNET.split(',')) {
      const [addr, p] = c.trim().split('/');
      if (/^\d+\.\d+\.\d+\.\d+$/.test(addr) && +p) add(addr, +p, true);
    }
  } else {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (VIRTUAL_IF.test(name)) continue;
      for (const i of list || []) {
        if ((i.family !== 'IPv4' && i.family !== 4) || i.internal) continue;
        if (i.address.startsWith('169.254.')) continue;
        add(i.address, ip2n(i.netmask).toString(2).replace(/0/g, '').length, false);
      }
    }
  }

  return [...seen.values()];
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ip -> MAC, read from the OS neighbour table (filled by the ping sweep)
function readArp() {
  return new Promise((resolve) => {
    const map = new Map();

    const addArp = (ip, mac) => {
      mac = mac.split(/[:-]/).map((o) => o.padStart(2, '0')).join(':').toUpperCase();
      if (mac === 'FF:FF:FF:FF:FF:FF' || mac === '00:00:00:00:00:00' || mac.startsWith('01:00:5E')) return;
      map.set(ip, mac);
    };

    if (process.platform === 'linux') {
      try {
        fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1).forEach((line) => {
          const c = line.trim().split(/\s+/);
          if (c.length >= 4 && c[2] !== '0x0') addArp(c[0], c[3]);
        });
      } catch { /* ignore */ }
      return resolve(map);
    }

    execFile('arp', ['-a'], { timeout: 5000 }, (err, out) => {
      const re = /(\d+\.\d+\.\d+\.\d+)\)?\s+(?:at\s+)?([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\b/gi;
      let m;
      while ((m = re.exec(out || ''))) addArp(m[1], m[2]);
      resolve(map);
    });
  });
}

function getGateway() {
  return new Promise((resolve) => {
    const [cmd, args, re] =
      process.platform === 'win32'
        ? ['route', ['print', '-4', '0.0.0.0'], /0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/]
        : process.platform === 'darwin'
          ? ['route', ['-n', 'get', 'default'], /gateway:\s*(\S+)/]
          : ['ip', ['route', 'show', 'default'], /default via (\S+)/];

    execFile(cmd, args, { timeout: 3000 }, (err, out) => {
      const m = !err && re.exec(out || '');
      resolve(m ? m[1] : null);
    });
  });
}

const rdns = (ip) => Promise.race([
  dns.reverse(ip).then((h) => (h[0] ? h[0].split('.')[0] : null)).catch(() => null),
  new Promise((r) => setTimeout(() => r(null), 1500))
]);

const SERVER_OUI = ['B8:27:EB', 'DC:A6:32', 'E4:5F:01', 'D8:3A:DD', '00:50:56', '08:00:27', '52:54:00', '00:15:5D'];

function guessType(mac, isGw) {
  if (isGw) return 'router';
  if (!mac) return 'pc';
  if (SERVER_OUI.some((p) => mac.startsWith(p))) return 'server'; // Raspberry Pi / VMs
  if (parseInt(mac.slice(0, 2), 16) & 2) return 'phone';          // randomised "private" MAC
  return 'pc';
}

// Ping-sweep every address in the local subnet(s), then read ARP for MACs.
async function discover() {
  const nets = subnets();
  if (!nets.length) return null;

  const hosts = nets.flatMap(({ net, size }) =>
    Array.from({ length: size - 2 }, (_, i) => n2ip(net + 1 + i)));
  const inRange = new Set(hosts);
  const found = new Map(); // ip -> { ms, mac }

  await pool(hosts, 64, async (ip) => {
    const r = await ping(ip, true);
    if (r.up) found.set(ip, { ms: r.ms, mac: null });
  });

  // devices that block ICMP still show up in the ARP table
  for (const [ip, mac] of await readArp()) {
    if (!inRange.has(ip)) continue;
    if (!found.has(ip)) found.set(ip, { ms: null, mac });
    else found.get(ip).mac = mac;
  }

  // our own machine isn't in its own ARP table
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      const f = found.get(i.address);
      if (f && !f.mac && i.mac && i.mac !== '00:00:00:00:00:00') f.mac = i.mac.toUpperCase();
    }
  }

  return { found, hosts: inRange, gateway: await getGateway() };
}

async function mergeDiscovery(disc) {
  const initial = devices.length === 0;
  const fresh = [];

  const ips = [...disc.found.keys()].sort((a, b) =>
    a === disc.gateway ? -1 : b === disc.gateway ? 1 : ip2n(a) - ip2n(b));

  for (const ip of ips) {
    const f = disc.found.get(ip);
    const known =
      (f.mac && devices.find((x) => x.mac && x.mac.toUpperCase() === f.mac)) ||
      devices.find((x) => x.ip === ip && (!x.mac || !f.mac || x.mac.toUpperCase() === f.mac));

    if (known) {
      known.ip = ip; // follows DHCP address changes (matched by MAC)
      if (f.mac && !known.mac) known.mac = f.mac;
    } else {
      fresh.push(ip);
    }
  }

  const names = await Promise.all(fresh.map(rdns));

  fresh.forEach((ip, n) => {
    const f = disc.found.get(ip);
    const isGw = ip === disc.gateway;
    const gw = devices.find((x) => x.ip === disc.gateway);
    const k = devices.filter((x) => x.discovered && x.ip !== disc.gateway).length;

    const d = {
      id: nextId(),
      name: names[n] || (isGw ? 'Gateway' : `Device ${ip}`),
      type: guessType(f.mac, isGw),
      ip,
      mac: f.mac || '',
      os: '',
      parent: isGw || !gw ? null : gw.id,
      x: isGw ? 450 : 90 + (k % 7) * 120,
      y: isGw ? 40 : 150 + Math.floor(k / 7) * 100,
      status: 'online',
      latencyMs: f.ms,
      lastSeen: Date.now(),
      discovered: true
    };

    devices.push(d);
    if (!initial) {
      addEvent('info', d, 'New device discovered',
        `${d.name} · ${d.ip}${d.mac ? ` (${d.mac})` : ''} joined the network.`);
    }
  });

  if (initial && fresh.length) {
    addEvent('info', null, 'Network discovery',
      `${fresh.length} devices discovered on the local network.`);
  }
}

let firstRun = true;

async function runScan(announce = true) {
  const disc = DISCOVER
    ? await discover().catch((e) => { console.error('discovery failed:', e.message); return null; })
    : null;

  if (disc) await mergeDiscovery(disc);

  await Promise.all(devices.map((d) => {
    const r = disc && disc.found.get(d.ip);
    return checkDevice(d, firstRun, r ? { up: true, ms: r.ms } : null);
  }));

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

// one scan at a time; overlapping callers share the in-flight scan
let scanning = null;
function scanAll(announce = true) {
  if (!scanning) scanning = runScan(announce).finally(() => { scanning = null; });
  return scanning;
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
    `NetworkMonitor → http://localhost:${PORT}  (poll ${INTERVAL / 1000}s${SIMULATE ? ', SIMULATED' : ''}${DISCOVER ? ', auto-discovery' : ''})`
  );

  scanAll(false).catch(console.error);
  setInterval(() => scanAll(false).catch(console.error), INTERVAL);
});
