
const NODE_W = 164;
const NODE_H = 44;

const TYPE_LABEL = {
  router: 'Router',
  switch: 'Switch',
  ap: 'AP',
  server: 'Server',
  pc: 'PC',
  iot: 'IoT',
  laptop: 'Laptop',
  phone: 'Phone'
};

const STATUS_LABEL = {
  online: 'Online',
  warning: 'Warning',
  offline: 'Offline'
};

let devices = [];

const $ = (sel) => document.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

function toast(msg) {
  $('#toast').textContent = msg;
}

// ---------- Data ----------

async function loadDevices() {
  try {
    const res = await fetch('/api/devices');

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${res.url}`);
    }

    const data = await res.json();

    if (!Array.isArray(data)) {
      throw new Error('The server did not return a device list');
    }

    devices = data;
    render();

  } catch (err) {
    console.error('LAN Map load failed:', err);
  }
}

async function scanNetwork() {
  const btn = $('#scan-btn');

  btn.disabled = true;
  toast('Scanning network…');

  try {
    const res = await fetch('/api/scan', {
      method: 'POST'
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(`Scan failed: HTTP ${res.status}`);
    }

    devices = data.devices;
    render();

    toast(`Scan finished at ${new Date(data.scannedAt).toLocaleTimeString()}.`);

  } catch (err) {
    console.error(err);
    toast('Scan failed. Check the server and try again.');

  } finally {
    btn.disabled = false;
  }
}

async function scanDevice(id) {
  try {
    const res = await fetch(
      `/api/devices/${encodeURIComponent(id)}/scan`,
      { method: 'POST' }
    );

    if (!res.ok) {
      throw new Error('Device scan failed');
    }

    const updatedDevice = await res.json();

    const index = devices.findIndex(
      d => d.id === updatedDevice.id
    );

    if (index !== -1) {
      devices[index] = updatedDevice;
    }

    render();

    toast(
      `${updatedDevice.name}: ${STATUS_LABEL[updatedDevice.status] || updatedDevice.status}`
    );

  } catch (error) {
    console.error(error);
    toast('Device scan failed.');
  }
}

// ---------- Map ----------

function linkPath(p, c) {
  const dy = c.y - p.y;

  if (Math.abs(dy) < 5) {
    const dir = c.x > p.x ? 1 : -1;

    return `M${p.x + dir * NODE_W / 2},${p.y} H${c.x - dir * NODE_W / 2}`;
  }

  if (Math.abs(dy) >= 100) {
    const my = (p.y + c.y) / 2;

    return `M${p.x},${p.y + NODE_H / 2} V${my} H${c.x} V${c.y - NODE_H / 2}`;
  }

  const x1 = p.x + NODE_W / 2;
  const x2 = c.x - NODE_W / 2;
  const mx = x1 + (x2 - x1) / 2;

  return `M${x1},${p.y} H${mx} V${c.y} H${x2}`;
}

function renderMap() {
  if (!devices.length) {
    $('#map').innerHTML =
      '<text x="450" y="145" text-anchor="middle" fill="#8b9bb0">The server returned 0 devices. Check data/devices.json or click Scan Network.</text>';

    return;
  }

  const byId = Object.fromEntries(
    devices.map(d => [d.id, d])
  );

  const links = devices
    .filter(d => byId[d.parent])
    .map(d =>
      `<path class="link${d.status === 'offline' ? ' off' : ''}"
       d="${linkPath(byId[d.parent], d)}"/>`
    );

  const nodes = devices.map(d => `
    <g class="node"
       aria-label="${esc(d.name)}, ${STATUS_LABEL[d.status] || d.status}"
       transform="translate(${d.x - NODE_W / 2},${d.y - NODE_H / 2})">
      <rect width="${NODE_W}" height="${NODE_H}" rx="8"/>
      <text class="name" x="12" y="19">${esc(d.name)}</text>
      <text class="meta" x="12" y="34">${esc(d.ip)}</text>
      <text class="meta" x="${NODE_W - 12}" y="34" text-anchor="end">${esc(TYPE_LABEL[d.type] || d.type)}</text>
      <circle class="dot ${esc(d.status)}" cx="${NODE_W - 14}" cy="14" r="4.5"/>
    </g>
  `);

  $('#map').innerHTML = links.join('') + nodes.join('');
}

// ---------- Table ----------

function renderTable() {
  const q = $('#filter').value.trim().toLowerCase();

  const rows = devices.filter(d =>
    !q || [
      d.name,
      d.ip,
      d.mac,
      TYPE_LABEL[d.type],
      d.os
    ].join(' ').toLowerCase().includes(q)
  );

  $('#rows').innerHTML = rows.length
    ? rows.map(d => `
      <tr>
        <td>${esc(d.name)}</td>
        <td class="mono">${esc(d.ip)}</td>
        <td class="mono">${esc(d.mac)}</td>
        <td>${esc(TYPE_LABEL[d.type] || d.type)}</td>
        <td>${esc(d.os)}</td>
        <td>
          <span class="pill ${esc(d.status)}">
            <span>${esc(STATUS_LABEL[d.status] || d.status)}</span>
          </span>
        </td>
        <td>
          <button class="linkbtn" type="button"
            data-scan="${esc(d.id)}">
            Scan
          </button>
        </td>
      </tr>
    `).join('')
    : `<tr><td colspan="7">No devices match “${esc(q)}”. Clear the filter or run a scan.</td></tr>`;
}

function render() {
  const active = devices.filter(
    d => d.status !== 'offline'
  ).length;

  $('#count').textContent =
    `Live network view | ${active} active of ${devices.length} devices`;

  renderMap();
  renderTable();
}

// ---------- Events ----------

$('#scan-btn').addEventListener('click', scanNetwork);

$('#refresh-btn').addEventListener('click', async () => {
  await loadDevices();
  toast('Map refreshed.');
});

$('#filter').addEventListener('input', renderTable);

$('#rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scan]');

  if (btn) {
    scanDevice(btn.dataset.scan);
  }
});

// ---------- Socket.IO live updates ----------

if (typeof io !== 'undefined') {
  const socket = io();

  socket.on('connect', () => {
    console.log('LAN Map connected to live updates');
  });

  socket.on('networkUpdate', (data) => {
    if (Array.isArray(data.devices)) {
      devices = data.devices;
      render();

      console.log('LAN Map updated with live device data');
    }
  });

  socket.on('disconnect', () => {
    console.log('LAN Map disconnected from live updates');
  });

} else {
  console.error('Socket.IO client not loaded. Check lanmap.html.');
}

// Initial load
loadDevices();
