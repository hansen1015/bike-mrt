import { Router } from './router.js';
import { Planner } from './planner.js';

const $ = id => document.getElementById(id);
const L = window.L;

// ================= settings (saved on this device) =================
const STORE = 'bike-mrt-settings';
const DEFAULT_SETTINGS = {
  theme: 'auto', showNet: true, showLabels: true,
  speed: 16, maxRide: 15, allowMid: true, bikePen: 1,
  lines: ['NS', 'EW', 'NE', 'CC', 'DT', 'TE', 'BP', 'SK', 'PG'],
  fold: 2.5, alight: 2, transferAdj: 0, transferPen: 0, tod: 'offpeak', alts: 3,
};
// chip key -> actual line codes in the data (the airport branch rides with East-West, each LRT system has two loops)
const LINE_GROUPS = { NS: ['NS'], EW: ['EW', 'CG'], NE: ['NE'], CC: ['CC'], DT: ['DT'], TE: ['TE'], BP: ['BP'], SK: ['SE', 'SW'], PG: ['PE', 'PW'] };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (e) {}
const saveSettings = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) {} };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ================= data (bike graph + rail network + land outline), loaded once =================
// the big graph files are published gzipped; decompress in the browser
const bin = f => fetch('data/' + f + '.gz').then(r => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const json = f => fetch('data/' + f).then(r => r.json());
const dataReady = Promise.all([bin('bg_nodes.bin'), bin('bg_edges.bin'), bin('bg_geom.bin'),
  json('stations.json'), json('mrt_edges.json'), json('mrt_shapes.json'), json('bike_matrix.json')]);
let planner = null;
const plannerReady = dataReady.then(([n, e, g, st, ed, sh, bm]) => { planner = new Planner(new Router(n, e, g), st, ed, sh, bm); return planner; });
const landReady = json('sg_land.json');

// ================= themes and map tiles =================
const LRT_GREY = '#748477';
const LINE_COLORS = { NS: '#dc241f', EW: '#009645', CG: '#009645', NE: '#9016b2', CC: '#fa9e0d', DT: '#0354a6', TE: '#9d5b25', BP: LRT_GREY, SE: LRT_GREY, SW: LRT_GREY, PE: LRT_GREY, PW: LRT_GREY };
const LINE_COLORS_DARK = { ...LINE_COLORS, DT: '#2f86f0', TE: '#c98440', NS: '#ff4d45', LRT: '#9aa89d', BP: '#9aa89d', SE: '#9aa89d', SW: '#9aa89d', PE: '#9aa89d', PW: '#9aa89d' };
const LRT_NAMES = { BP: 'Bukit Panjang LRT', SE: 'Sengkang LRT', SW: 'Sengkang LRT', PE: 'Punggol LRT', PW: 'Punggol LRT' };
const isLrt = code => code in LRT_NAMES;
const lineLabel = code => LRT_NAMES[code] || code;

const media = matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => settings.theme === 'auto' ? (media.matches ? 'dark' : 'light') : settings.theme;
const isDark = () => document.documentElement.dataset.theme === 'dark';
const lineColor = code => (isDark() ? LINE_COLORS_DARK : LINE_COLORS)[code];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const map = L.map('map', { zoomSnap: 1, worldCopyJump: false }).setView([1.3521, 103.8198], 12);
window.__bikeMrtMap = map; // handy for debugging in the console

const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// One free, key-less tile source. Dark mode darkens these same tiles with a CSS filter (see index.html).
const TILES = {
  main: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: ATTR }),
  // OSM sometimes refuses tile requests coming from inside an app; OpenStreetMap France is the fallback
  fallback: () => L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: ATTR + ', tiles by OpenStreetMap France' }),
};
let tileLayer = null, tileErrors = 0;
function applyTiles() {
  if (tileLayer) return; // same tiles in both themes; the CSS filter does the dark look
  tileLayer = TILES.main().addTo(map);
  tileLayer.on('tileerror', () => {
    if (++tileErrors === 8) { map.removeLayer(tileLayer); tileLayer = TILES.fallback().addTo(map); }
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
  document.querySelector('meta[name="theme-color"]').content = isDark() ? '#14171a' : '#0b6e4f';
  applyTiles();
  drawNetwork();
  if (plans.length) show(activePlan);
}
media.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });

// ================= map limits: Singapore only =================
let land = []; // [{ ring, minLat, maxLat, minLon, maxLon }]
function distM(lat, lon, a, b) { // point-to-segment distance in metres (flat-earth is fine at this scale)
  const k = Math.cos(lat * Math.PI / 180), px = (lon - a[1]) * k, py = lat - a[0];
  const dx = (b[1] - a[1]) * k, dy = b[0] - a[0], len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy) * 111195;
}
function onLand(lat, lon) { // inside Singapore's outline, or within 250 m of the coast (piers, boats, rounding)
  if (!land.length) return true; // outline not loaded yet
  for (const p of land) {
    if (lat < p.minLat - 0.003 || lat > p.maxLat + 0.003 || lon < p.minLon - 0.003 || lon > p.maxLon + 0.003) continue;
    const r = p.ring; let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [yi, xi] = r[i], [yj, xj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (distM(lat, lon, r[j], r[i]) <= 250) return true;
  }
  return false;
}
landReady.then(rings => {
  land = rings.map(ring => ({ ring, minLat: Math.min(...ring.map(p => p[0])), maxLat: Math.max(...ring.map(p => p[0])), minLon: Math.min(...ring.map(p => p[1])), maxLon: Math.max(...ring.map(p => p[1])) }));
  const pad = 0.04;
  const bounds = L.latLngBounds([Math.min(...land.map(p => p.minLat)) - pad, Math.min(...land.map(p => p.minLon)) - pad],
                                [Math.max(...land.map(p => p.maxLat)) + pad, Math.max(...land.map(p => p.maxLon)) + pad]);
  const fit = () => { map.setMinZoom(map.getBoundsZoom(bounds)); };
  map.setMaxBounds(bounds); map.options.maxBoundsViscosity = 1.0;
  fit(); map.on('resize', fit);
  if (map.getZoom() < map.getMinZoom()) map.setZoom(map.getMinZoom());
});

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ================= geocoding =================
const titleCase = s => s.toLowerCase().replace(/(^|[\s(\/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
// Singapore address / postal code / building search: OneMap (free), Nominatim as fallback
async function geocode(q) {
  try {
    const r = await (await fetch('https://www.onemap.gov.sg/api/common/elastic/search?returnGeom=Y&getAddrDetails=Y&searchVal=' + encodeURIComponent(q))).json();
    const res = (r.results || []).slice(0, 8).map(x => ({ label: titleCase(x.ADDRESS && x.ADDRESS !== 'NIL' ? x.ADDRESS : x.SEARCHVAL), lat: +x.LATITUDE, lon: +x.LONGITUDE }));
    if (res.length) return res;
  } catch (e) {}
  const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=sg&limit=6&q=' + encodeURIComponent(q))).json();
  return r.map(x => ({ label: x.display_name, lat: +x.lat, lon: +x.lon }));
}

// ================= network overlay =================
map.createPane('network'); map.getPane('network').style.zIndex = 350;
map.createPane('route'); map.getPane('route').style.zIndex = 450;
const netLayer = L.layerGroup(), labelLayer = L.layerGroup();
let railData = null;
function drawNetwork() {
  netLayer.clearLayers(); labelLayer.clearLayers();
  if (!railData) return;
  const casing = css('--casing');
  railData.edges.forEach(e => {
    L.polyline(e.coords, { pane: 'network', color: casing, weight: 6, opacity: .9, interactive: false }).addTo(netLayer);
    L.polyline(e.coords, { pane: 'network', color: lineColor(e.line), weight: isLrt(e.line) ? 2.5 : 3.5, opacity: 1, interactive: false }).addTo(netLayer);
  });
  railData.stations.forEach(s => { // station names only (no dots), shown when zoomed in
    L.marker([s.lat, s.lon], { pane: 'network', interactive: false, icon: L.divIcon({ className: 'stn-label', html: s.name, iconSize: [0, 0], iconAnchor: [-5, 6] }) }).addTo(labelLayer);
  });
  updateNetworkVisibility();
}
function updateNetworkVisibility() {
  if (settings.showNet) netLayer.addTo(map); else map.removeLayer(netLayer);
  if (settings.showNet && settings.showLabels && map.getZoom() >= 14) labelLayer.addTo(map); else map.removeLayer(labelLayer);
}
map.on('zoomend', updateNetworkVisibility);
dataReady.then(([, , , stations, edges, shapes]) => {
  railData = { stations, edges: edges.map((e, i) => ({ ...e, coords: shapes[i] })) };
  drawNetwork();
});
const dimNetwork = on => { map.getPane('network').style.opacity = on ? 0.3 : 1; };

// ================= pins (A = start, B = destination) =================
const picked = { from: { lat: 1.353820, lon: 103.688243 }, to: null };
const markers = {}, lastGood = {};
const layer = L.layerGroup().addTo(map);

// returns false (and tells the user) if the spot is not in Singapore
function setPoint(key, lat, lon, pan) {
  if (!onLand(lat, lon)) { toast('Pins can only be placed in Singapore'); return false; }
  picked[key] = { lat, lon }; lastGood[key] = [lat, lon];
  if (!markers[key]) {
    markers[key] = L.marker([lat, lon], { draggable: true, title: key === 'from' ? 'Start' : 'Destination',
      icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 28],
        html: `<div style="background:${key === 'from' ? '#0b6e4f' : '#d92d20'};color:#fff;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:grid;place-items:center"><b style="transform:rotate(45deg)">${key === 'from' ? 'A' : 'B'}</b></div>` }) }).addTo(map);
    markers[key].on('dragend', e => {
      const p = e.target.getLatLng();
      if (setPoint(key, p.lat, p.lng)) $(key).value = 'Pin (' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + ')';
      else e.target.setLatLng(lastGood[key]); // dropped outside Singapore: snap back
    });
  } else markers[key].setLatLng([lat, lon]);
  if (pan) map.panTo([lat, lon]);
  return true;
}

let picking = null;
function setPicking(key) {
  picking = picking === key ? null : key;
  ['from', 'to'].forEach(k => $('pin-' + k).classList.toggle('on', picking === k));
  $('map').classList.toggle('picking', !!picking);
}
$('pin-from').onclick = () => setPicking('from');
$('pin-to').onclick = () => setPicking('to');
map.on('click', e => {
  // with no button active: a tap on the map sets the destination (the start is usually Binjai Hall)
  const key = picking || 'to';
  if (setPoint(key, e.latlng.lat, e.latlng.lng)) $(key).value = 'Pin (' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + ')';
  if (picking) setPicking(picking);
});
setPoint('from', picked.from.lat, picked.from.lon);

// start from the phone's GPS position, with a spinner on the button while we wait
let locating = false;
$('gps-from').onclick = () => {
  const btn = $('gps-from'), input = $('from');
  if (locating) return;
  if (!navigator.geolocation) { toast('GPS is not available on this device'); return; }
  const before = input.value;
  const done = () => { locating = false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); btn.disabled = false; input.classList.remove('locating'); };
  locating = true; btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  input.value = 'Finding your location…'; input.classList.add('locating');
  navigator.geolocation.getCurrentPosition(pos => {
    done();
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (!setPoint('from', lat, lon, true)) { input.value = before; toast('You seem to be outside Singapore, so pick a start on the map instead'); return; }
    input.value = 'My location (±' + Math.round(accuracy) + ' m)';
    map.setView([lat, lon], Math.max(map.getZoom(), 15));
  }, err => {
    done(); input.value = before;
    toast(err.code === 1 ? 'Location permission denied: allow it in your browser settings' : 'Could not get your location, try again or pick on the map');
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
};

function wireSearch(key) {
  const input = $(key), box = $('sugg-' + key); let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (input.value.length < 3) { box.style.display = 'none'; return; }
    timer = setTimeout(async () => {
      try {
        const res = (await geocode(input.value)).filter(r => onLand(r.lat, r.lon));
        box.innerHTML = '';
        res.forEach(r => {
          const d = document.createElement('div'); d.textContent = r.label;
          d.onclick = () => { input.value = r.label; setPoint(key, r.lat, r.lon, true); box.style.display = 'none'; };
          box.appendChild(d);
        });
        box.style.display = res.length ? 'block' : 'none';
      } catch (e) {}
    }, 300);
  });
}
wireSearch('from'); wireSearch('to');

// ================= planning =================
let plans = [], activePlan = 0, replanTimer;
const planOptions = () => ({
  speed: settings.speed,
  fold_min: settings.fold,
  alight_min: settings.alight,
  transfer_adj: settings.transferAdj,
  peak: settings.tod === 'peak',
  transfer_penalty: settings.transferPen,
  max_ride_km: settings.maxRide,
  allow_mid: settings.allowMid,
  lines: settings.lines.flatMap(k => LINE_GROUPS[k] || []),
  bike_pen: settings.bikePen,
  alternatives: settings.alts,
});

async function runPlan() {
  const out = $('out');
  if (!picked.from || !picked.to) { out.innerHTML = '<div class="err">Pick a destination: type an address or tap the map.</div>'; return; }
  $('go').disabled = true; out.innerHTML = planner ? '<p>Planning…</p>' : '<p>Loading map data (first time only)…</p>';
  try {
    await plannerReady;
    await new Promise(r => setTimeout(r, 30)); // let the "Planning…" text paint before the CPU-heavy search
    plans = planner.plan({ lat: picked.from.lat, lon: picked.from.lon }, { lat: picked.to.lat, lon: picked.to.lon }, planOptions());
    if (!plans.length) throw new Error('No route found with these settings. Try a longer "Longest single ride" or enable more lines.');
    activePlan = 0; render(); show(0);
  } catch (e) { plans = []; layer.clearLayers(); dimNetwork(false); out.innerHTML = '<div class="err">' + e.message + '</div>'; }
  $('go').disabled = false;
}
$('go').onclick = runPlan;
const replanSoon = () => { if (plans.length) { clearTimeout(replanTimer); replanTimer = setTimeout(runPlan, 350); } };

const ll = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);
// Google Maps cycling directions from the start to the end of one cycling leg (Google picks its own route)
function gmaps(l) {
  const a = l.coords[0] || l.from_pt, b = l.coords[l.coords.length - 1] || l.to_pt;
  return 'https://www.google.com/maps/dir/?api=1&travelmode=bicycling&origin=' + ll(a) + '&destination=' + ll(b);
}

const fmt = m => { m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; };

function render() {
  $('out').innerHTML = plans.map((p, i) => `
    <div class="plan" data-i="${i}">
      <h2>${p.label}</h2>
      <div class="big">${fmt(p.total_min)}</div>
      <div class="split"><span>Cycling <b>${p.bike_km} km</b> · ${fmt(p.bike_min)}</span><span>MRT/LRT &amp; transfers <b>${fmt(p.mrt_min)}</b></span></div>
      ${p.legs.map(l => l.mode === 'bike'
        ? `<div class="leg"><span class="tag bike">BIKE</span><span>${l.from} → ${l.to}<br><span style="color:var(--mute)">${l.km} km · ${fmt(l.min)}</span><br><a class="gbtn" href="${gmaps(l)}" target="_blank" rel="noopener">🗺️ Open in Google Maps</a></span></div>`
        : `<div class="leg"><span class="tag mrt" style="${l.segments.every(s => isLrt(s.line)) ? 'background:' + LRT_GREY : ''}">${l.segments.every(s => isLrt(s.line)) ? 'LRT' : 'MRT'}</span><span>${l.segments.map(s => `<b>${lineLabel(s.line)}</b> ${s.from} → ${s.to} (${s.stops} stops)`).join('<br>')}<br><span style="color:var(--mute)">${fmt(l.min)} incl. fold &amp; wait</span></span></div>`).join('')}
    </div>`).join('');
  document.querySelectorAll('.plan').forEach(el => el.onclick = () => show(+el.dataset.i));
  document.querySelectorAll('.gbtn').forEach(a => a.onclick = e => e.stopPropagation());
}

function show(i) {
  activePlan = i;
  document.querySelectorAll('.plan').forEach((el, j) => el.classList.toggle('active', i === j));
  layer.clearLayers(); const pts = [];
  dimNetwork(true);
  const casing = css('--casing'), dot = isDark() ? '#e8ecef' : '#222', fill = isDark() ? '#1d2125' : '#fff', bike = css('--bike');
  plans[i].legs.forEach(l => {
    if (l.mode === 'bike') {
      L.polyline(l.coords, { pane: 'route', color: casing, weight: 9 }).addTo(layer);
      L.polyline(l.coords, { pane: 'route', color: bike, weight: 5 }).addTo(layer); pts.push(...l.coords);
    } else {
      l.segments.forEach(sg => {
        const col = lineColor(sg.line);
        L.polyline(sg.coords, { pane: 'route', color: casing, weight: 11 }).addTo(layer);
        L.polyline(sg.coords, { pane: 'route', color: col, weight: 7 }).addTo(layer);
        sg.stop_pts.forEach((p, k) => {
          const end = k === 0 || k === sg.stop_pts.length - 1;
          L.circleMarker(p, { pane: 'route', radius: end ? 8 : 4.5, color: end ? col : dot, weight: end ? 4 : 1.5, fillColor: fill, fillOpacity: 1 })
            .bindTooltip(sg.stop_names[k], { permanent: end, direction: 'right', offset: [8, 0] }).addTo(layer);
        });
        pts.push(...sg.coords);
      });
    }
  });
  map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}

// ================= settings sheet =================
const sheet = $('settings');
const openSettings = () => { sheet.classList.add('open'); };
const closeSettings = () => { sheet.classList.remove('open'); };
$('open-settings').onclick = openSettings;
$('close-settings').onclick = closeSettings;
$('done-settings').onclick = closeSettings;
sheet.addEventListener('click', e => { if (e.target === sheet) closeSettings(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettings(); });

function syncSettingsUI() {
  document.querySelectorAll('[data-key]').forEach(el => {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    const out = document.querySelector(`[data-out="${el.dataset.key}"]`);
    if (out) out.textContent = el.dataset.key === 'bikePen' ? (+v).toFixed(1) + '×' : v + ' min';
  });
  document.querySelectorAll('[data-seg]').forEach(g => g.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === settings[g.dataset.seg])));
  document.querySelectorAll('#line-chips button').forEach(b => b.classList.toggle('on', settings.lines.includes(b.dataset.line)));
}

document.querySelectorAll('[data-key]').forEach(el => {
  const apply = () => {
    const key = el.dataset.key;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' || el.tagName === 'SELECT' ? +el.value : el.value;
    if (el.type === 'number') { const lo = +el.min, hi = +el.max; if (Number.isNaN(v)) return; v = Math.min(hi, Math.max(lo, v)); el.value = v; }
    settings[key] = v; saveSettings();
    const out = document.querySelector(`[data-out="${key}"]`);
    if (out) out.textContent = key === 'bikePen' ? v.toFixed(1) + '×' : v + ' min';
    if (key === 'showNet' || key === 'showLabels') updateNetworkVisibility(); else replanSoon();
  };
  el.addEventListener(el.type === 'range' ? 'input' : 'change', apply);
});
document.querySelectorAll('[data-seg]').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => {
  settings[g.dataset.seg] = b.dataset.v; saveSettings(); syncSettingsUI();
  if (g.dataset.seg === 'theme') applyTheme(); else replanSoon();
}));
document.querySelectorAll('#line-chips button').forEach(b => b.onclick = () => {
  const s = new Set(settings.lines); s.has(b.dataset.line) ? s.delete(b.dataset.line) : s.add(b.dataset.line);
  settings.lines = [...s]; saveSettings(); syncSettingsUI(); replanSoon();
});
$('reset-settings').onclick = () => { settings = { ...DEFAULT_SETTINGS, lines: [...DEFAULT_SETTINGS.lines] }; saveSettings(); syncSettingsUI(); applyTheme(); replanSoon(); };

syncSettingsUI();
applyTheme();

// ================= feedback e-mail =================
// assembled here (not written in the HTML) so it is not sitting in the page for address scrapers
(() => {
  const to = ['hansen.khornelius', 'gmail.com'].join('@');
  const a = $('feedback');
  a.href = 'mailto:' + to + '?subject=' + encodeURIComponent('Bike-MRT feedback') + '&body=' + encodeURIComponent('Hi,\n\nMy feedback on Bike-MRT:\n\n\n');
  a.addEventListener('click', () => toast('Opening your email app… no mail app? Write to ' + to));
})();

// ================= intro screen + "add to home screen" =================
const INTRO_KEY = 'bike-mrt-intro-seen';
const intro = $('intro');
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvent = null;

function updateInstallBox() {
  const box = $('install-box'), btn = $('install-btn');
  if (standalone) { box.hidden = true; return; }              // already installed
  if (installEvent) {                                          // Chrome / Edge / Samsung Internet: one-tap install
    box.hidden = false; btn.hidden = false;
  } else if (isIOS) {                                          // iPhone / iPad Safari has no install event, show the steps
    box.hidden = false; btn.hidden = true;
    $('install-text').innerHTML = 'On iPhone or iPad: tap the <b style="display:inline">Share</b> button (the square with an arrow) in Safari, then choose <b style="display:inline">Add to Home Screen</b>.';
  } else box.hidden = true;                                    // not supported here
}
window.addEventListener('beforeinstallprompt', e => { installEvent = e; updateInstallBox(); }); // the browser's own prompt still appears as usual
window.addEventListener('appinstalled', () => { installEvent = null; $('install-box').hidden = true; toast('Bike-MRT was added to your home screen'); });
$('install-btn').onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch (e) {}
  installEvent = null; updateInstallBox();
};

function openIntro() { updateInstallBox(); intro.classList.add('open'); }
function closeIntro() { intro.classList.remove('open'); try { localStorage.setItem(INTRO_KEY, '1'); } catch (e) {} }
$('open-help').onclick = openIntro;
$('intro-go').onclick = closeIntro;
intro.addEventListener('click', e => { if (e.target === intro) closeIntro(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeIntro(); });
let seen = false; try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch (e) {}
if (!seen) openIntro();
