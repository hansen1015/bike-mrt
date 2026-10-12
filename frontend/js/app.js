// Keep BUILD in step with <meta name="build"> in index.html and VERSION in sw.js (tests/version.test.mjs checks it)
const BUILD = 'v17';
import { Router } from './router.js';
import { Planner } from './planner.js';
import { railFare, sgClock, timeInfo, polyKm, FARE_TYPES } from './fares.js';
import { searchPlaces } from './search.js';
import { Recorder } from './activity.js';
import { buildGuidance, locate, nextInstruction, railCards, fmtDist, dist as navDist, bearing as navBearing, ICON } from './nav.js';

const $ = id => document.getElementById(id);
const L = window.L;

// If the page and this script come from different versions, clear the caches and reload once (instead of misbehaving)
{
  const pageBuild = document.querySelector('meta[name="build"]')?.content;
  if (pageBuild !== BUILD) {
    let tried = false; try { tried = sessionStorage.getItem('bm-recovered') === '1'; sessionStorage.setItem('bm-recovered', '1'); } catch (e) {}
    if (!tried && window.__bmRecover) window.__bmRecover(); else if (window.__bmFatal) window.__bmFatal('Version mismatch (' + pageBuild + ' / ' + BUILD + ')');
  }
}

// ================= settings (saved on this device) =================
const STORE = 'bike-mrt-settings';
const DEFAULT_SETTINGS = {
  theme: 'auto', showNet: true, showLabels: true,
  speed: 16, maxRide: 15, allowMid: true, bikePen: 1,
  lines: ['NS', 'EW', 'NE', 'CC', 'DT', 'TE', 'BP', 'SK', 'PG'],
  fold: 2.5, alight: 2, transferAdj: 0, transferPen: 0, depart: 'now', showFares: true, fareType: 'adult', alts: 3, gpsStart: true,
};
// chip key -> actual line codes in the data (the airport branch rides with East-West, each LRT system has two loops)
const LINE_GROUPS = { NS: ['NS'], EW: ['EW', 'CG'], NE: ['NE'], CC: ['CC'], DT: ['DT'], TE: ['TE'], BP: ['BP'], SK: ['SE', 'SW'], PG: ['PE', 'PW'] };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (e) {}
settings.depart = 'now'; // "Leaving" always starts at Now
if (!['adult', 'student', 'senior'].includes(settings.fareType)) settings.fareType = 'adult';
// favourite destinations (saved on this device)
const FAV_KEY = 'bike-mrt-favs';
let favs = [], favEdit = false;
try { favs = (JSON.parse(localStorage.getItem(FAV_KEY) || '[]') || []).filter(f => f && f.name && Number.isFinite(f.lat) && Number.isFinite(f.lon)).slice(0, 20); } catch (e) {}
const saveSettings = () => { try { const { depart, ...keep } = settings; localStorage.setItem(STORE, JSON.stringify(keep)); } catch (e) {} };

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  let reloaded = false; // a new version just took over: reload once so you are not left on the old one
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
}

// ================= data (bike graph + rail network + land outline), loaded once =================
// the big graph files are published gzipped; decompress in the browser
const bin = f => fetch('data/' + f + '.gz').then(r => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const json = f => fetch('data/' + f).then(r => r.json());
const dataReady = Promise.all([bin('bg_nodes.bin'), bin('bg_edges.bin'), bin('bg_geom.bin'),
  json('stations.json'), json('mrt_edges.json'), json('mrt_shapes.json'), json('bike_matrix.json'), json('entrances.json'),
  bin('bg_names.bin'), bin('bg_kinds.bin'), json('names.json')]);
let planner = null;
const plannerReady = dataReady.then(([n, e, g, st, ed, sh, bm, en, nm, kd, nl]) => { planner = new Planner(new Router(n, e, g, nm, kd, nl), st, ed, sh, bm, en); return planner; });
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

// "reset view" button under the zoom buttons: back to the current route, or the whole of Singapore
const ResetView = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    const a = L.DomUtil.create('a', 'reset-view', bar);
    a.href = '#'; a.title = 'Reset map view'; a.setAttribute('role', 'button'); a.setAttribute('aria-label', 'Reset map view'); a.textContent = '⤢';
    L.DomEvent.on(a, 'click', e => { L.DomEvent.stop(e); resetView(); });
    L.DomEvent.disableClickPropagation(bar);
    return bar;
  },
});
let sgBounds = null;
function resetView() {
  if (plans.length && routeBounds) fitToSheet(routeBounds);
  else if (sgBounds) fitToSheet(sgBounds, 8);
  else map.setView([1.3521, 103.8198], 12);
}
new ResetView().addTo(map);

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
  sgBounds = L.latLngBounds(land[0].ring); // the main island is the first (largest) ring
  const pad = 0.04;
  const sheetRoom = mobileMQ.matches ? 0.3 : 0; // phones: extra room to the south so the map can be moved up above the bottom sheet
  const bounds = L.latLngBounds([Math.min(...land.map(p => p.minLat)) - pad - sheetRoom, Math.min(...land.map(p => p.minLon)) - pad],
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
map.createPane('labels'); map.getPane('labels').style.zIndex = 460; // station names sit above the lines and the route
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
    L.marker([s.lat, s.lon], { pane: 'labels', interactive: false, icon: L.divIcon({ className: 'stn-label', html: s.name, iconSize: [0, 0], iconAnchor: [-5, 6] }), stn: s.name }).addTo(labelLayer);
  });
  hideRouteNames();
  updateNetworkVisibility();
}
// station names that already have a dot + label on the selected route are not drawn a second time
let routeDotNames = new Set();
function hideRouteNames() { labelLayer.eachLayer(m => m.setOpacity(routeDotNames.has(m.options.stn) ? 0 : 1)); }
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
const picked = { from: null, to: null };   // the start is your location (see useMyLocation) unless you choose another
const markers = {}, lastGood = {};
const layer = L.layerGroup().addTo(map);

// returns false (and tells the user) if the spot is not in Singapore
function setPoint(key, lat, lon, pan) {
  if (!onLand(lat, lon)) { toast('Pins can only be placed in Singapore'); return false; }
  picked[key] = { lat, lon }; lastGood[key] = [lat, lon];
  if (!markers[key]) {
    markers[key] = L.marker([lat, lon], { draggable: true, title: key === 'from' ? 'Start' : 'Destination',
      icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 28],
        html: `<div class="pinwrap"><div style="background:${key === 'from' ? '#0b6e4f' : '#d92d20'};color:#fff;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:grid;place-items:center"><b style="transform:rotate(45deg)">${key === 'from' ? 'A' : 'B'}</b></div></div>` }) }).addTo(map);
    markers[key].on('dragend', e => {
      const p = e.target.getLatLng();
      if (setPoint(key, p.lat, p.lng)) $(key).value = 'Pin (' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + ')';
      else e.target.setLatLng(lastGood[key]); // dropped outside Singapore: snap back
    });
  } else markers[key].setLatLng([lat, lon]);
  if (pan) revealPoint(lat, lon);
  if (key === 'to') updateFavStar();
  return true;
}

// Centre a place in the part of the map that is not under the bottom sheet (the sheet settles at half height after a search).
function revealPoint(lat, lon, zoom = Math.max(map.getZoom(), 14)) {
  const covered = mobileMQ.matches ? sheetPx('half') : 0, size = map.getSize();
  const wanted = L.point(size.x / 2, (size.y - covered) / 2);   // where the place should appear on screen
  const pt = map.project([lat, lon], zoom);
  map.setView(map.unproject(pt.subtract(wanted).add(size.divideBy(2)), zoom), zoom, { animate: true });
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
  if (nav.on) return;
  // with no button active: a tap on the map sets the destination (the start is usually Binjai Hall)
  const key = picking || 'to';
  if (setPoint(key, e.latlng.lat, e.latlng.lng)) $(key).value = 'Pin (' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + ')';
  if (picking) setPicking(picking);
});

// ---- the start is your location by default ----
// One shared lookup (a spinner on the button while we wait). Returns a promise: true when the start was set.
let locateJob = null;
function useMyLocation() {
  if (locateJob) return locateJob;
  const btn = $('gps-from'), input = $('from');
  if (!navigator.geolocation) { toast('GPS is not available on this device'); return Promise.resolve(false); }
  const before = input.value.startsWith('Finding') ? '' : input.value;
  const done = () => { btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); btn.disabled = false; input.classList.remove('locating'); };
  btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  input.value = 'Finding your location…'; input.classList.add('locating');
  locateJob = new Promise(resolve => navigator.geolocation.getCurrentPosition(pos => {
    done();
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (!setPoint('from', lat, lon)) { input.value = before; toast('You seem to be outside Singapore, so pick a start on the map instead'); resolve(false); return; }
    input.value = 'My location (±' + Math.round(accuracy) + ' m)';
    revealPoint(lat, lon, Math.max(map.getZoom(), 15));
    resolve(true);
  }, err => {
    done(); input.value = before;
    toast(err.code === 1 ? 'Location is off. Allow it in your browser settings, or choose a start' : 'Could not get your location. Try again, or choose a start');
    resolve(false);
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 })).finally(() => { locateJob = null; });
  return locateJob;
}
$('gps-from').onclick = () => { useMyLocation(); };

// when planning or starting to navigate, a "My location" start is refreshed to where you are right now
const fromIsGps = () => $('from').value.startsWith('My location');
async function freshStart(maxAge = 15000) { // maxAge 0 = a brand new reading, never a remembered one
  if (!fromIsGps() || !navigator.geolocation) return;
  try {
    const pos = await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: true, timeout: 6000, maximumAge: maxAge }));
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (onLand(lat, lon)) {
      picked.from = { lat, lon }; lastGood.from = [lat, lon];
      if (markers.from) markers.from.setLatLng([lat, lon]);
      $('from').value = 'My location (±' + Math.round(accuracy) + ' m)';
    }
  } catch (e) { /* keep the position we already have */ }
}

const searchCache = new Map();
function clearPoint(key) {
  if (markers[key]) { markers[key].remove(); delete markers[key]; }
  picked[key] = null; lastGood[key] = null;
  if (key === 'to') updateFavStar();
}
function wireSearch(key) {
  const input = $(key), box = $('sugg-' + key), wrap = input.parentElement;
  let timer, ctrl, items = [], active = -1, token = 0;
  const hide = () => { box.style.display = 'none'; active = -1; };
  const setActive = i => { active = i; [...box.querySelectorAll('.it')].forEach((el, j) => { el.classList.toggle('act', j === i); if (j === i) el.scrollIntoView({ block: 'nearest' }); }); };
  const choose = r => {
    input.value = r.title; hide();
    if (!setPoint(key, r.lat, r.lon, true)) input.value = '';
    else { input.blur(); setSheet('half'); }
  };
  const show = (list, msg) => {
    items = list; active = -1; box.innerHTML = '';
    if (!list.length) { const m = document.createElement('div'); m.className = 'msg'; m.textContent = msg; box.appendChild(m); }
    list.forEach(r => {
      const d = document.createElement('div'); d.className = 'it';
      d.innerHTML = '<span class="ic"></span><span><div class="tt"></div><div class="ss"></div></span>';
      d.querySelector('.ic').textContent = r.icon; d.querySelector('.tt').textContent = r.title; d.querySelector('.ss').textContent = r.sub;
      d.addEventListener('mousedown', e => { e.preventDefault(); choose(r); }); // mousedown so the input keeps focus until we choose
      box.appendChild(d);
    });
    box.style.display = 'block';
  };
  async function run(q) {
    if (ctrl) ctrl.abort();
    const key2 = q.toLowerCase();
    if (searchCache.has(key2)) { show(searchCache.get(key2), 'No matches.'); return; }
    ctrl = new AbortController(); const my = ++token;
    wrap.classList.add('busy');
    try {
      const c = map.getCenter();
      const { results, failed, aborted } = await searchPlaces(q, { center: { lat: c.lat, lon: c.lng }, stations: railData ? railData.stations : [], signal: ctrl.signal });
      if (aborted || my !== token) return;
      const list = results.filter(r => onLand(r.lat, r.lon));
      if (!failed) searchCache.set(key2, list);
      show(list, failed ? 'Search is unavailable right now. Check your connection, or drop a pin on the map.' : 'No matches. Try a building, business, postal code or MRT station.');
    } catch (e) { if (my === token) show([], 'Search is unavailable right now. Check your connection, or drop a pin on the map.'); }
    finally { if (my === token) wrap.classList.remove('busy'); }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { if (ctrl) ctrl.abort(); token++; wrap.classList.remove('busy'); hide(); return; }
    timer = setTimeout(() => run(q), 400); // spaced out: OneMap throttles bursts
  });
  input.addEventListener('keydown', e => {
    if (box.style.display !== 'block' || !items.length) { if (e.key === 'Enter') { clearTimeout(timer); const q = input.value.trim(); if (q.length >= 2) run(q); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[Math.max(active, 0)]); }
    else if (e.key === 'Escape') hide();
  });
  input.addEventListener('focus', () => { setSheet('full'); input.select(); if (items.length && input.value.trim().length >= 2 && box.children.length) box.style.display = 'block'; });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  // The clear button acts on press and keeps the keyboard open. On a phone, tapping a button first closes the keyboard,
  // which moves the layout and made the tap miss, so the text stayed.
  const clearBtn = document.querySelector(`[data-clear="${key}"]`);
  const doClear = e => {
    e.preventDefault();
    if (ctrl) ctrl.abort(); token++; clearTimeout(timer); wrap.classList.remove('busy');
    input.value = ''; items = []; hide(); clearPoint(key); input.focus();
  };
  clearBtn.addEventListener('mousedown', e => e.preventDefault()); // do not steal focus from the field
  clearBtn.addEventListener('touchstart', doClear, { passive: false });
  clearBtn.addEventListener('click', doClear);                      // keyboard / assistive tech
}
wireSearch('from'); wireSearch('to');

// ================= planning =================
let plans = [], activePlan = 0, replanTimer, routeBounds = null;
// navigation state (declared here because the page layout code below reads it while loading)
const nav = { on: false, plan: null, phases: [], i: 0, watch: null, along: 0, offCount: 0, follow: true, wake: null, cards: [], cardI: 0, pos: null, prev: null, done: false, arrived: false, recording: false, headingUp: false, bearing: 0, rec: new Recorder() };
window.__bikeMrtNav = nav; // handy for debugging and tests

// ---- departure time: "now" or a picked time, always read as Singapore time ----
let departAt = ''; // 'YYYY-MM-DDTHH:mm' when settings.depart === 'custom' (not saved between visits)
const clockNow = () => sgClock(settings.depart === 'custom' ? departAt : '');
function updateWhenInfo() {
  const c = clockNow(), t = timeInfo(c);
  $('when-info').textContent = (settings.depart === 'custom' ? 'Leaving ' : 'Now: ') + t.label + (t.earlyBird ? ' · early-bird fares' : '');
  $('depart-row').hidden = settings.depart !== 'custom';
}
setInterval(() => { if (settings.depart === 'now') updateWhenInfo(); }, 60000);

const planOptions = () => ({
  speed: settings.speed,
  fold_min: settings.fold,
  alight_min: settings.alight,
  transfer_adj: settings.transferAdj,
  peak: timeInfo(clockNow()).peak,
  transfer_penalty: settings.transferPen,
  max_ride_km: settings.maxRide,
  allow_mid: settings.allowMid,
  lines: settings.lines.flatMap(k => LINE_GROUPS[k] || []),
  bike_pen: settings.bikePen,
  alternatives: settings.alts,
});

async function runPlan() {
  const out = $('out');
  if (!picked.to) { out.innerHTML = '<div class="err">Pick a destination: type an address or tap the map, or choose a favourite.</div>'; return; }
  $('go').disabled = true;
  if (!picked.from && settings.gpsStart) { out.innerHTML = '<p>Getting your location…</p>'; await useMyLocation(); }
  else if (fromIsGps()) { out.innerHTML = '<p>Getting your location…</p>'; await freshStart(); }
  if (!picked.from) { out.innerHTML = '<div class="err">Choose where to start: allow your location, or type a start address.</div>'; $('go').disabled = false; return; }
  out.innerHTML = planner ? '<p>Planning…</p>' : '<p>Loading map data (first time only)…</p>';
  try {
    await plannerReady;
    await new Promise(r => setTimeout(r, 30)); // let the "Planning…" text paint before the CPU-heavy search
    plans = planner.plan({ lat: picked.from.lat, lon: picked.from.lon }, { lat: picked.to.lat, lon: picked.to.lon }, planOptions());
    if (!plans.length) {
      const why = { start: "There is no way to cycle out of the start point (a restricted or closed area, or an island). Move pin A onto a nearby road.",
                    dest: "There is no way to cycle into the destination (a restricted or closed area, or an island). Move pin B onto a nearby road." }[plans.reason];
      throw new Error(why || 'No route found with these settings. Try a longer "Longest single ride" or enable more lines.');
    }
    activePlan = 0; render(); show(0);
  } catch (e) { plans = []; layer.clearLayers(); routeDotNames = new Set(); hideRouteNames(); dimNetwork(false); out.innerHTML = '<div class="err">' + e.message + '</div>'; }
  $('go').disabled = false;
}
$('go').onclick = runPlan;
const replanSoon = () => { if (plans.length) { clearTimeout(replanTimer); replanTimer = setTimeout(runPlan, 350); } };

const fmt = m => { m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; };

// fare for every rail leg: summed track length of its segments, priced when the leg starts (early-bird before 7:45 am on weekdays)
function addFares() {
  const c = clockNow(), t = timeInfo(c);
  plans.forEach(p => {
    let elapsed = 0, total = 0;
    p.legs.forEach(l => {
      if (l.mode === 'mrt') {
        l.railKm = l.segments.reduce((s, sg) => s + polyKm(sg.coords), 0);
        l.fare = railFare(l.railKm, { type: settings.fareType, earlyBird: t.weekday && c.minutes + elapsed < 7 * 60 + 45, date: c.iso });
        if (!(l.fare >= 0)) l.fare = 0;
        total += l.fare;
      }
      elapsed += l.min;
    });
    p.fare = Math.round(total * 100) / 100;
  });
}
const money = x => '$' + x.toFixed(2);
// which station exits to enter and leave by (the quickest to reach on this route)
const exitsHtml = l => {
  const parts = [];
  if (l.enter) parts.push(`Enter at <b>Exit ${l.enter.label}</b>`);
  if (l.exit) parts.push(`Leave at <b>Exit ${l.exit.label}</b>`);
  return parts.length ? `<br><span class="exits">🚪 ${parts.join(' · ')}</span>` : '';
};

function render() {
  addFares();
  const t = timeInfo(clockNow());
  const note = settings.showFares && plans.some(p => p.fare > 0)
    ? `<div class="hint">Fares are estimated ${FARE_TYPES[settings.fareType].toLowerCase()} card fares${t.earlyBird ? ' (early-bird discount before 7:45 am on weekdays)' : ''}, based on the track distance, so they can be one fare band off. Each train ride is a separate journey when you cycle in between.</div>` : '';
  $('out').innerHTML = plans.map((p, i) => `
    <div class="plan" data-i="${i}">
      <h2>${p.label}</h2>
      <div class="big">${fmt(p.total_min)}</div>
      <div class="split"><span>Cycling <b>${p.bike_km} km</b> · ${fmt(p.bike_min)}</span><span>MRT/LRT &amp; transfers <b>${fmt(p.mrt_min)}</b></span>${settings.showFares ? (p.fare > 0 ? `<span class="fare">Fare <b>≈ ${money(p.fare)}</b></span>` : '<span>No fare (cycling only)</span>') : ''}</div>
      ${p.legs.map(l => l.mode === 'bike'
        ? `<div class="leg"><span class="tag bike">BIKE</span><span>${l.from} → ${l.to}<br><span style="color:var(--mute)">${l.km} km · ${fmt(l.min)}</span></span></div>`
        : `<div class="leg"><span class="tag mrt" style="${l.segments.every(s => isLrt(s.line)) ? 'background:' + LRT_GREY : ''}">${l.segments.every(s => isLrt(s.line)) ? 'LRT' : 'MRT'}</span><span>${l.segments.map(s => `<b>${lineLabel(s.line)}</b> ${s.from} → ${s.to} (${s.stops} stops)`).join('<br>')}${exitsHtml(l)}<br><span style="color:var(--mute)">${fmt(l.min)} incl. fold &amp; wait${settings.showFares ? ` · ${l.railKm.toFixed(1)} km · <b class="fare">≈ ${money(l.fare)}</b>` : ''}</span></span></div>`).join('')}
      <button type="button" class="startbtn" data-start="${i}">▶ Start navigation</button>
    </div>`).join('') + note + (plans.some(p => p.legs.some(l => l.enter || l.exit)) ? '<div class="hint">Exits are the ones quickest to reach on your route. Exit data comes from OpenStreetMap and may be incomplete, so check the signs in the station.</div>' : '');
  document.querySelectorAll('.plan').forEach(el => el.onclick = () => show(+el.dataset.i));
  document.querySelectorAll('.startbtn').forEach(b => b.onclick = e => { e.stopPropagation(); startNav(+b.dataset.start); });
}

// circle split into two halves, one per line colour
function splitIcon(c1, c2, edge) {
  const r = 9, w = 2 * r + 6, m = w / 2;
  return L.divIcon({ className: '', iconSize: [w, w], iconAnchor: [m, m],
    html: `<svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" aria-hidden="true"><path d="M${m} ${m - r} A${r} ${r} 0 0 0 ${m} ${m + r} Z" fill="${c1}"/><path d="M${m} ${m - r} A${r} ${r} 0 0 1 ${m} ${m + r} Z" fill="${c2}"/><circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="${edge}" stroke-width="3"/></svg>` });
}

function show(i) {
  activePlan = i;
  document.querySelectorAll('.plan').forEach((el, j) => el.classList.toggle('active', i === j));
  layer.clearLayers(); const pts = [];
  routeDotNames = new Set();
  dimNetwork(true);
  const casing = css('--casing'), fill = isDark() ? '#1d2125' : '#fff', bike = css('--bike');
  plans[i].legs.forEach(l => {
    if (l.mode === 'bike') {
      L.polyline(l.coords, { pane: 'route', color: casing, weight: 9 }).addTo(layer);
      L.polyline(l.coords, { pane: 'route', color: bike, weight: 5 }).addTo(layer); pts.push(...l.coords);
    } else {
      l.segments.forEach((sg, si) => {
        const col = lineColor(sg.line);
        L.polyline(sg.coords, { pane: 'route', color: casing, weight: 11 }).addTo(layer);
        L.polyline(sg.coords, { pane: 'route', color: col, weight: 7 }).addTo(layer);
        pts.push(...sg.coords);
      });
      // dots only where you board, change line or get off. A line change is a circle split in two colours:
      // left half = the line you arrive on, right half = the line you leave on. No dots for the stops in between.
      const segs = l.segments, last = segs.length - 1;
      const ring = (p, name, col) => L.circleMarker(p, { pane: 'labels', radius: 8, color: col, weight: 4, fillColor: fill, fillOpacity: 1 })
        .bindTooltip(name, { permanent: true, direction: 'right', offset: [8, 0] }).addTo(layer);
      ring(segs[0].stop_pts[0], segs[0].stop_names[0], lineColor(segs[0].line));
      for (let si = 0; si < last; si++) {
        const a = lineColor(segs[si].line), b = lineColor(segs[si + 1].line), p = segs[si].stop_pts[segs[si].stop_pts.length - 1];
        const tip = `<b>${segs[si].stop_names[segs[si].stop_names.length - 1]}</b><br>${lineLabel(segs[si].line)} → ${lineLabel(segs[si + 1].line)}`;
        L.marker(p, { pane: 'labels', icon: splitIcon(a, b, casing), keyboard: false }).bindTooltip(tip, { permanent: true, direction: 'right', offset: [14, 0] }).addTo(layer);
      }
      ring(segs[last].stop_pts[segs[last].stop_pts.length - 1], segs[last].stop_names[segs[last].stop_names.length - 1], lineColor(segs[last].line));
      // the exits to use, drawn where they really are (the cycling route ends and starts there)
      [l.enter, l.exit].forEach(x => {
        if (!x) return;
        L.circleMarker([x.lat, x.lon], { pane: 'labels', radius: 4, color: css('--accent'), weight: 2, fillColor: fill, fillOpacity: 1 }).addTo(layer);
        L.marker([x.lat, x.lon], { pane: 'labels', interactive: false, keyboard: false, icon: L.divIcon({ className: 'exit-wrap', iconSize: [0, 0], html: `<span class="exit-pill">Exit ${x.label}</span>` }) }).addTo(layer);
      });
      routeDotNames.add(segs[0].stop_names[0]); routeDotNames.add(segs[last].stop_names[segs[last].stop_names.length - 1]);
      for (let si = 0; si < last; si++) routeDotNames.add(segs[si].stop_names[segs[si].stop_names.length - 1]);
    }
  });
  hideRouteNames();
  routeBounds = L.latLngBounds(pts);
  if (!nav.on) {
    if (sheetState === 'full') setSheet('half'); // reading the list at full height: drop to half so the route is visible
    fitToSheet(routeBounds);
  }
}

// ================= settings sheet =================
const sheet = $('settings');
const openSettings = () => { updateWhenInfo(); sheet.classList.add('open'); };
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
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' || (el.tagName === 'SELECT' && !Number.isNaN(+el.value)) ? +el.value : el.value;
    if (el.type === 'number') { const lo = +el.min, hi = +el.max; if (Number.isNaN(v)) return; v = Math.min(hi, Math.max(lo, v)); el.value = v; }
    settings[key] = v; saveSettings();
    const out = document.querySelector(`[data-out="${key}"]`);
    if (out) out.textContent = key === 'bikePen' ? v.toFixed(1) + '×' : v + ' min';
    if (key === 'gpsStart') { if (v && !picked.from) useMyLocation(); }
    else if (key === 'showNet' || key === 'showLabels') updateNetworkVisibility();
    else if (key === 'showFares' || key === 'fareType') { if (plans.length) { render(); show(activePlan); } }
    else replanSoon();
  };
  el.addEventListener(el.type === 'range' ? 'input' : 'change', apply);
});
document.querySelectorAll('[data-seg]').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => {
  settings[g.dataset.seg] = b.dataset.v; saveSettings(); syncSettingsUI();
  if (g.dataset.seg === 'theme') { applyTheme(); return; }
  if (g.dataset.seg === 'depart') {
    if (settings.depart === 'custom' && !departAt) { const n = sgClock(''); departAt = `${n.iso}T${String(n.h).padStart(2, '0')}:${String(n.mi).padStart(2, '0')}`; $('depart-at').value = departAt; }
    updateWhenInfo();
  }
  replanSoon();
}));
$('depart-at').addEventListener('change', e => { departAt = e.target.value; updateWhenInfo(); replanSoon(); });
document.querySelectorAll('#line-chips button').forEach(b => b.onclick = () => {
  const s = new Set(settings.lines); s.has(b.dataset.line) ? s.delete(b.dataset.line) : s.add(b.dataset.line);
  settings.lines = [...s]; saveSettings(); syncSettingsUI(); replanSoon();
});
$('reset-settings').onclick = () => { settings = { ...DEFAULT_SETTINGS, lines: [...DEFAULT_SETTINGS.lines] }; departAt = ''; saveSettings(); syncSettingsUI(); updateWhenInfo(); applyTheme(); replanSoon(); };

syncSettingsUI();
updateWhenInfo();
applyTheme();

// ================= phone layout: draggable bottom sheet =================
// The map fills the screen; the panel is a sheet you drag between peek (map almost full screen), half and full.
const mobileMQ = matchMedia('(max-width: 800px)');
const sideEl = $('side'), grab = $('grab');
let sheetState = 'half';
const sheetPx = st => (st === 'peek' ? 112 : Math.round(window.innerHeight * (st === 'half' ? 0.5 : 0.9)));
function setSheetPx(px, animate = true) {
  sideEl.style.transition = animate ? 'height .22s ease' : 'none';
  sideEl.style.height = px + 'px';
  document.documentElement.style.setProperty('--sheetH', px + 'px');
}
function setSheet(st) { if (!mobileMQ.matches) return; sheetState = st; setSheetPx(sheetPx(st)); }
function fitToSheet(bounds, pad = 40) { // keep the route inside the part of the map the sheet does not cover
  const bottom = mobileMQ.matches ? sheetPx(sheetState) : 0;
  map.fitBounds(bounds, { paddingTopLeft: [pad, pad], paddingBottomRight: [pad, pad + bottom] });
}
let drag = null;
grab.addEventListener('pointerdown', e => {
  drag = { y0: e.clientY, h0: sideEl.offsetHeight, lastY: e.clientY, lastT: performance.now(), v: 0, moved: 0 };
  grab.setPointerCapture(e.pointerId);
});
grab.addEventListener('pointermove', e => {
  if (!drag) return;
  const h = Math.max(sheetPx('peek'), Math.min(sheetPx('full'), drag.h0 + (drag.y0 - e.clientY)));
  const now = performance.now();
  drag.v = (drag.lastY - e.clientY) / Math.max(1, now - drag.lastT); drag.lastY = e.clientY; drag.lastT = now;
  drag.moved = Math.max(drag.moved, Math.abs(drag.y0 - e.clientY));
  setSheetPx(h, false);
});
const endDrag = () => {
  if (!drag) return;
  const d = drag; drag = null;
  const order = ['peek', 'half', 'full'];
  if (d.moved < 6) { setSheet(order[(order.indexOf(sheetState) + 1) % 3 === 0 ? 1 : (order.indexOf(sheetState) + 1) % 3]); return; } // tap: step up, from full back to half
  const target = sideEl.offsetHeight + d.v * 160; // a quick flick carries it further
  setSheet(order.reduce((best, st) => (Math.abs(sheetPx(st) - target) < Math.abs(sheetPx(best) - target) ? st : best), 'half'));
};
grab.addEventListener('pointerup', endDrag);
grab.addEventListener('pointercancel', endDrag);
const applySheetMode = () => {
  if (nav.on) { document.documentElement.style.setProperty('--sheetH', '86px'); return; }
  if (mobileMQ.matches) setSheetPx(sheetPx(sheetState), false);
  else { sideEl.style.height = ''; sideEl.style.transition = ''; document.documentElement.style.removeProperty('--sheetH'); }
};
mobileMQ.addEventListener('change', applySheetMode);
window.addEventListener('resize', applySheetMode);
applySheetMode();

// ================= navigation =================
// Phases follow the plan: a cycling leg (map + turn-by-turn, following your GPS position), then a train ride (step cards you page
// through with the arrows), then cycling again, until you arrive.
map.createPane('nav'); map.getPane('nav').style.zIndex = 470;
const navLayer = L.layerGroup().addTo(map);
let posMarker = null, accCircle = null;
const LINE_FULL = { NS: 'North-South Line', EW: 'East-West Line', CG: 'East-West Line (Changi Airport branch)', NE: 'North East Line', CC: 'Circle Line', DT: 'Downtown Line', TE: 'Thomson-East Coast Line' };
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildPhases(plan) {
  const stationByName = new Map(railData.stations.map(s => [s.name, s]));
  return plan.legs.map((l, k) => {
    const nextLeg = plan.legs[k + 1];
    if (l.mode === 'bike') {
      const toRide = nextLeg && nextLeg.mode === 'mrt' ? nextLeg : null;
      const target = toRide ? `${l.to}${toRide.enter ? ', Exit ' + toRide.enter.label : ''}` : 'your destination';
      const segs = l.segs && l.segs.length ? l.segs : [{ name: '', kind: 0, coords: l.coords }];
      return { type: 'bike', leg: l, target, toRide, g: buildGuidance(segs, { arrive: toRide ? `Arrive at ${target}` : 'You have arrived' }) };
    }
    return { type: 'rail', leg: l, cards: railCards(l, { stationByName, lineName: c => LINE_FULL[c] || lineLabel(c), moneyText: settings.showFares && l.fare ? money(l.fare) : '', nextIsBike: !!nextLeg && nextLeg.mode === 'bike' }) };
  });
}

async function lockScreen() { try { if ('wakeLock' in navigator && nav.on) nav.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (nav.on && document.visibilityState === 'visible') lockScreen(); });

async function startNav(i, keepWatch = false, resume = null) {
  if (!plans[i] || !railData) return;
  if (!keepWatch && !resume && fromIsGps()) {
    const was = picked.from; await freshStart(0);
    if (was && picked.from && navDist([was.lat, was.lon], [picked.from.lat, picked.from.lon]) > 80) {   // you have moved since the plan was made
      toast('Updating the route from where you are…');
      const label = plans[i].label; await runPlan();
      const k = plans.findIndex(p => p.label === label); i = k >= 0 ? k : plans.length - 1;
      if (!plans[i]) return;
    }
  }
  show(i);
  nav.on = true; nav.plan = plans[i]; nav.done = false;
  if (resume) { nav.rec = Recorder.restore(resume.rec); nav.title = resume.title; nav.recording = !!resume.recording; }
  else if (!keepWatch) { nav.rec = new Recorder(); nav.title = rideTitle(); nav.recording = false; }   // a re-route keeps the original title and the recording as it was
  nav.phases = buildPhases(nav.plan);
  document.body.classList.add('navigating'); $('nav').hidden = false;
  document.documentElement.style.setProperty('--sheetH', '86px');
  map.getPane('route').style.opacity = 0.35;
  if (!keepWatch) startWatch();
  lockScreen();
  savePlan();
  if (resume && resume.done) finishNav({ download: false }); else enterPhase(resume ? resume.i : 0);
  if (resume) applyResume(resume);
  saveNavState(true);
}

// ---- keep the navigation when the app is closed: it is saved on the device and picked up again when the app opens ----
const NAV_KEY = 'bike-mrt-nav', NAV_PLAN_KEY = 'bike-mrt-nav-plan', NAV_MAX_AGE = 12 * 3600 * 1000;
let lastNavSave = 0;
function saveNavState(force = false) {            // small state + the GPS points so far (throttled; forced on every step change and when the page is hidden)
  if (!nav.on) return;
  const now = Date.now();
  if (!force && now - lastNavSave < 8000) return;
  lastNavSave = now;
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify({ v: 1, saved: now, i: nav.i, along: nav.along, arrived: nav.arrived, cardI: nav.cardI, done: nav.done, headingUp: nav.headingUp,
      title: nav.title, recording: nav.recording, from: $('from').value, to: $('to').value, pf: picked.from, pt: picked.to, rec: nav.rec.snapshot() }));
  } catch (e) { /* storage full or blocked: carry on without saving */ }
}
function savePlan() { try { localStorage.setItem(NAV_PLAN_KEY, JSON.stringify(nav.plan)); } catch (e) {} }
function clearNavSession() { try { localStorage.removeItem(NAV_KEY); localStorage.removeItem(NAV_PLAN_KEY); } catch (e) {} }
function hasNavSession() {
  try { const s = JSON.parse(localStorage.getItem(NAV_KEY) || 'null'); return !!s && Date.now() - s.saved < NAV_MAX_AGE && !!localStorage.getItem(NAV_PLAN_KEY); } catch (e) { return false; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNavState(true); });
window.addEventListener('pagehide', () => saveNavState(true));

function applyResume(r) {
  const ph = nav.phases[nav.i];
  if (ph && ph.type === 'bike') {
    nav.along = Math.max(nav.along, r.along || 0);
    if (r.arrived) { nav.arrived = true; $('nav-arrived').classList.add('attn'); }
    refreshMainButton();
    updateBike();
  } else if (ph && ph.type === 'rail') { nav.cardI = Math.max(0, Math.min(r.cardI || 0, nav.cards.length - 1)); renderRail(); }
  if (r.headingUp) setHeadingUp(true);
  toast('Navigation resumed');
}
async function resumeNav() {
  let st = null, plan = null;
  try { st = JSON.parse(localStorage.getItem(NAV_KEY)); plan = JSON.parse(localStorage.getItem(NAV_PLAN_KEY)); } catch (e) {}
  if (!st || !plan || Date.now() - st.saved > NAV_MAX_AGE) { clearNavSession(); return; }
  await dataReady;
  if (st.pf) { setPoint('from', st.pf.lat, st.pf.lon); $('from').value = st.from; }   // the planning screen as it was
  if (st.pt) { setPoint('to', st.pt.lat, st.pt.lon); $('to').value = st.to; }
  plans = [plan]; activePlan = 0; render();
  startNav(0, false, st);
}

function startWatch() {
  if (nav.watch != null || !navigator.geolocation) { if (!navigator.geolocation) toast('GPS is not available on this device'); return; }
  nav.watch = navigator.geolocation.watchPosition(onFix, err => {
    $('nav-text').textContent = err.code === 1 ? 'Location is blocked. Allow it to follow your position' : 'Waiting for GPS…';
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

function drawPos() {
  const p = nav.pos; if (!p) return;
  const at = [p.lat, p.lon];
  if (!posMarker) {
    posMarker = L.marker(at, { pane: 'nav', interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="me"><div class="me-arrow"></div></div>' }) }).addTo(map);
    accCircle = L.circle(at, { pane: 'nav', radius: p.accuracy, weight: 1, color: '#2f7cf6', fillOpacity: 0.1, interactive: false }).addTo(map);
  } else { posMarker.setLatLng(at); accCircle.setLatLng(at).setRadius(p.accuracy); }
  const me = posMarker.getElement() && posMarker.getElement().querySelector('.me');
  if (me) {
    const has = p.heading != null && !Number.isNaN(p.heading);
    me.querySelector('.me-arrow').style.display = has ? 'block' : 'none';
    me.style.transform = has ? `rotate(${p.heading}deg)` : '';   // inside a turned map this ends up pointing up
  }
}

function onFix(pos) {
  if (!nav.on) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  // direction of travel: the phone's heading, or worked out from the last few metres moved
  let heading = pos.coords.heading, fromMoves = false;
  const here = [lat, lon];
  if (nav.prev) {
    const moved = navDist([nav.prev.lat, nav.prev.lon], here);
    if ((heading == null || Number.isNaN(heading)) && moved >= 6) { heading = navBearing([nav.prev.lat, nav.prev.lon], here); fromMoves = true; }
    if (moved >= 6) nav.prev = { lat, lon };
  } else nav.prev = { lat, lon };
  nav.pos = { lat, lon, accuracy, heading };
  if (nav.headingUp && heading != null && !Number.isNaN(heading) && (fromMoves || pos.coords.speed == null || pos.coords.speed > 0.8)) turnMap(heading);
  drawPos();
  const ph = nav.phases[nav.i];
  if (!ph || ph.type !== 'bike') return;
  nav.rec.addFix({ t: pos.timestamp, lat, lon, acc: accuracy, alt: pos.coords.altitude, speed: pos.coords.speed });
  saveNavState();
  const f = locate(ph.g, lat, lon, nav.along);
  if (f.cross <= Math.max(45, accuracy * 1.2)) { nav.offCount = 0; nav.along = Math.max(nav.along, f.along); $('nav-off').hidden = true; }
  else if (!nav.arrived && accuracy < 80 && ++nav.offCount >= 3) $('nav-off').hidden = false;
  updateBike();
  const end = ph.g.pts[ph.g.pts.length - 1];
  if (ph.g.total - nav.along < 25 || navDist(end, [lat, lon]) < 25) {
    if (!nav.arrived) {                                     // at the station or the destination: keep recording until you press the button
      nav.arrived = true; $('nav-arrived').classList.add('attn'); $('nav-off').hidden = true; refreshMainButton();
      toast(!nav.recording ? (ph.toRide ? 'You are at the station' : 'You have arrived') : ph.toRide ? 'You are at the station. Still recording: press Pause & MRT when you go in' : 'You have arrived. Still recording: press Stop & save when you are done');
      updateBike(); saveNavState(true);
    }
  }
  if (nav.follow) followPos(lat, lon);
}

function updateBike() {
  const ph = nav.phases[nav.i]; if (!ph || ph.type !== 'bike') return;
  if (nav.arrived) {
    $('nav-icon').textContent = ph.toRide ? '🚇' : '🏁'; $('nav-dist').textContent = 'Arrived';
    $('nav-text').textContent = !nav.recording ? (ph.toRide ? 'Press To the MRT when you go in' : 'Press Finish to end the navigation')
      : ph.toRide ? 'Still recording. Press Pause & MRT when you go in' : 'Still recording. Press Stop & save when you are done';
    $('nav-remain').textContent = ph.toRide ? 'At the station' : 'You have arrived'; $('nav-sub').textContent = nav.recording ? 'Recording continues' : 'Not recording'; return;
  }
  const g = ph.g, ni = nextInstruction(g, nav.along), d = Math.max(0, ni.along - nav.along);
  $('nav-icon').textContent = ICON[ni.type] || '↑';
  $('nav-dist').textContent = d < 25 && ni.type !== 'arrive' ? 'Now' : fmtDist(d);
  $('nav-text').textContent = ni.text;
  const rem = Math.max(0, g.total - nav.along);
  $('nav-remain').textContent = `${fmtDist(rem)} · ${Math.max(1, Math.round(ph.leg.min * (g.total ? rem / g.total : 0)))} min`;
  navSub(ph);
}

// the line under the distance: whether the GPS is locked and whether the ride is being recorded
function navSub(ph) {
  const sub = $('nav-sub'), p = nav.pos;
  if (nav.recording) { sub.innerHTML = `<span class="recdot">●</span> Recording · to ${esc(ph.target)}`; return; }
  const gps = !p ? '🔴 Waiting for GPS…' : p.accuracy <= 15 ? `🟢 GPS locked (±${Math.round(p.accuracy)} m)` : p.accuracy <= 40 ? `🟡 GPS ±${Math.round(p.accuracy)} m` : `🔴 GPS weak (±${Math.round(p.accuracy)} m)`;
  sub.textContent = `${gps} · not recording`;
}

// the big button on the bar: Start recording, then Pause & MRT / Stop & save
function refreshMainButton() {
  const ph = nav.phases[nav.i], b = $('nav-arrived');
  if (!ph || ph.type !== 'bike') return;
  b.classList.toggle('rec', !nav.recording && !nav.arrived);
  b.textContent = !nav.recording ? (nav.arrived ? (ph.toRide ? 'To the MRT ›' : 'Finish ›') : '● Start recording') : ph.toRide ? 'Pause & MRT ⏸' : 'Stop & save ■';
}
function startRecording() {
  const p = nav.pos;
  if ((!p || p.accuracy > 50) && !confirm('The GPS is not locked yet, so the start of the track may be inaccurate. Start recording anyway?')) return;
  nav.recording = true; nav.rec.startLeg();
  refreshMainButton(); updateBike(); saveNavState(true); toast('Recording started');
}

function enterPhase(idx) {
  nav.i = idx; nav.along = 0; nav.offCount = 0; nav.follow = true; nav.arrived = false; $('nav-arrived').classList.remove('attn');
  navLayer.clearLayers(); $('nav-off').hidden = true;
  const ph = nav.phases[idx];
  if (!ph) { finishNav(); return; }
  if (ph.type === 'bike') {
    if (ph.g.pts.length < 2) { enterPhase(idx + 1); return; }
    if (nav.recording) nav.rec.startLeg();   // timer runs while you cycle (a resume after the train ride)
    $('rail').hidden = true; $('nav-top').hidden = false; $('nav-bottom').hidden = false; $('nav-fabs').hidden = false;
    const casing = css('--casing');
    L.polyline(ph.leg.coords, { pane: 'nav', color: casing, weight: 13 }).addTo(navLayer);
    L.polyline(ph.leg.coords, { pane: 'nav', color: css('--bike'), weight: 8 }).addTo(navLayer);
    const end = ph.g.pts[ph.g.pts.length - 1];
    L.marker(end, { pane: 'nav', interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [4, 28], html: '<div class="flagwrap" style="font-size:28px;line-height:1">🏁</div>' }) }).addTo(navLayer);
    refreshMainButton();
    $('nav-icon').textContent = ICON.start; $('nav-dist').textContent = '-'; $('nav-text').textContent = nav.pos ? ph.g.ins[0].text : 'Waiting for GPS…';
    updateBike();
    if (nav.pos) map.setView([nav.pos.lat, nav.pos.lon], 17); else map.fitBounds(L.latLngBounds(ph.leg.coords), { paddingTopLeft: [20, 120], paddingBottomRight: [20, 100] });
  } else {
    nav.rec.endLeg();              // timer paused during the train ride
    $('nav-top').hidden = true; $('nav-bottom').hidden = true; $('nav-fabs').hidden = true;
    nav.cards = ph.cards; nav.cardI = 0; nav.done = false;
    renderRail(); $('rail').hidden = false;
  }
}

const nextPhase = () => { enterPhase(nav.i + 1); saveNavState(true); };

// ---- the ride as an activity file for Strava ----
const sgStamp = ms => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
};
function saveBlob(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// "Commute: NTU Binjai Hall → ION Orchard", from the From / To fields when the trip starts
const placeLabel = el => {
  const v = el.value.trim();
  const t = /^Pin \(/.test(v) ? 'a map pin' : /^My location/.test(v) ? 'My location' : v || 'start';
  return t.length > 36 ? t.slice(0, 35).trim() + '…' : t;
};
const rideTitle = () => `Commute: ${placeLabel($('from'))} → ${placeLabel($('to'))}`;
const fileSlug = t => t.replace(/→/g, 'to').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
function downloadRide(kind) {
  const st = nav.rec.stats(); if (!st.start) return false;
  const base = `Bike-MRT_${fileSlug(nav.title || 'ride')}_${sgStamp(st.start)}`;
  if (kind === 'gpx') saveBlob(base + '.gpx', nav.rec.toGPX(nav.title || 'Bike-MRT ride'), 'application/gpx+xml');
  else saveBlob(base + '.fit', nav.rec.toFIT({ commute: true }), 'application/octet-stream');
  return true;
}
const copyTitle = () => { const t = nav.title || 'Commute'; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Title copied'), () => toast(t)); };
const fmtHms = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`; };

function finishNav({ download = true } = {}) {
  $('nav-top').hidden = true; $('nav-bottom').hidden = true; $('nav-fabs').hidden = true;
  nav.rec.endLeg();
  const st = nav.rec.stats(), ok = nav.rec.usable;
  nav.done = true; nav.cardI = 0;
  nav.cards = [{ kind: 'done', line: '', title: 'You have arrived', stops: [],
    lines: ok ? [`Your ride was saved as a file for Strava: ${(st.distance / 1000).toFixed(1)} km of cycling in ${fmtHms(st.moving)}.${st.legs > 1 ? ' The train rides are paused time.' : ''} It is marked as a commute.`, `Title: ${nav.title}`, 'Upload it at strava.com/upload, or share the file to the Strava app. If Strava shows another title, paste this one.']
              : ['Safe riding!', 'No GPS track was recorded (GPS was off or had no signal), so there is no file to save.'],
    chips: ok ? [`${(st.distance / 1000).toFixed(1)} km`, `${fmtHms(st.moving)} moving`, `${st.legs} cycling ${st.legs === 1 ? 'leg' : 'legs'}`] : [],
    actions: ok ? [{ label: 'Open Strava upload ↗', href: 'https://www.strava.com/upload/select' }, { label: 'Copy title', run: copyTitle }, { label: 'Save .fit again', run: () => downloadRide('fit') }, { label: 'GPX version', run: () => downloadRide('gpx') }] : [] }];
  if (ok && download) { try { downloadRide('fit'); } catch (e) { toast('Could not save the ride file'); } }  // downloads when you press Stop & save
  renderRail(); $('rail').hidden = false;
  saveNavState(true);
}

// ---- train step cards ----
function renderRail() {
  const c = nav.cards[nav.cardI], n = nav.cards.length;
  $('rail-step').textContent = nav.done ? 'Done' : `Step ${nav.cardI + 1} of ${n}`;
  const col = (c.line && lineColor(c.line)) || css('--accent');
  const icon = { enter: '🚪', board: '🚇', change: '🔁', leave: '🚪', done: '🏁' }[c.kind];
  let stops = '';
  if (c.stops && c.stops.length > 1) {
    const mid = c.stops.slice(1, -1);
    stops = `<ol class="rc-stops"><li class="end">${esc(c.stops[0])}<small>get on here</small></li>${mid.length ? `<li class="mid"><details><summary>${mid.length} ${mid.length === 1 ? 'stop' : 'stops'} in between</summary><ul>${mid.map(s => `<li>${esc(s)}</li>`).join('')}</ul></details></li>` : ''}<li class="end">${esc(c.stops[c.stops.length - 1])}<small>get off here</small></li></ol>`;
  }
  $('rail-card').innerHTML = `<div class="rc" style="--lc:${col}"><div class="rc-icon">${icon}</div><h2>${esc(c.title)}</h2>${c.lines.map(t => `<p>${esc(t)}</p>`).join('')}<div class="rc-chips">${c.chips.map(t => `<span>${esc(t)}</span>`).join('')}</div>${stops}${c.actions && c.actions.length ? '<div class="rc-actions"></div>' : ''}</div>`;
  (c.actions || []).forEach(a => {
    const b = a.href ? Object.assign(document.createElement('a'), { href: a.href, target: '_blank', rel: 'noopener' }) : Object.assign(document.createElement('button'), { type: 'button', onclick: a.run });
    b.textContent = a.label; $('rail-card').querySelector('.rc-actions').appendChild(b);
  });
  $('rail-dots').innerHTML = nav.done ? '' : nav.cards.map((_, k) => `<i class="${k === nav.cardI ? 'on' : ''}"></i>`).join('');
  $('rail-prev').disabled = nav.done || nav.cardI === 0; $('rail-next').disabled = nav.done || nav.cardI === n - 1;
  $('rail-prev').hidden = $('rail-next').hidden = nav.done;
  const last = nav.done || nav.cardI === n - 1;
  $('rail-go').hidden = !last;
  $('rail-go').textContent = nav.done ? 'Done' : nav.i + 1 < nav.phases.length ? 'Continue cycling ›' : 'Finish ›';
}
const railStep = d => { const k = nav.cardI + d; if (nav.done || k < 0 || k >= nav.cards.length) return; nav.cardI = k; renderRail(); saveNavState(true); };
$('rail-prev').onclick = () => railStep(-1);
$('rail-next').onclick = () => railStep(1);
$('rail-go').onclick = () => { if (nav.done) endNav(); else nextPhase(); };
let swipeX = null;
$('rail-card').addEventListener('touchstart', e => { swipeX = e.touches[0].clientX; }, { passive: true });
$('rail-card').addEventListener('touchend', e => { if (swipeX == null) return; const dx = e.changedTouches[0].clientX - swipeX; swipeX = null; if (Math.abs(dx) > 55) railStep(dx < 0 ? 1 : -1); }, { passive: true });
document.addEventListener('keydown', e => { if (nav.on && !$('rail').hidden) { if (e.key === 'ArrowRight') railStep(1); else if (e.key === 'ArrowLeft') railStep(-1); } });

// ---- turning the map with your direction of travel (our own implementation: the map element is enlarged and rotated with CSS) ----
function layoutMap(on) {
  const el = $('map');
  if (on) {
    const D = Math.ceil(Math.hypot(innerWidth, innerHeight)) + 4;   // big enough that no corner shows however it is turned
    Object.assign(el.style, { position: 'fixed', inset: 'auto', left: '50%', top: '50%', width: D + 'px', height: D + 'px', margin: `${-D / 2}px 0 0 ${-D / 2}px`, transformOrigin: '50% 50%' });
    el.classList.add('rotating');
  } else {
    for (const k of ['position', 'inset', 'left', 'top', 'width', 'height', 'margin', 'transform', 'transformOrigin']) el.style[k] = '';
    el.style.removeProperty('--unrot'); el.classList.remove('rotating');
  }
  map.invalidateSize({ animate: false });
}
function setBearing(deg) { nav.bearing = deg; $('map').style.transform = `rotate(${-deg}deg)`; $('map').style.setProperty('--unrot', `${deg}deg`); }
function turnMap(heading) {                                           // ease towards the direction of travel by the shortest way round
  const d = ((heading - (nav.bearing % 360) + 540) % 360) - 180;
  if (Math.abs(d) < 4) return;
  setBearing(nav.bearing + d * 0.6);
}
function setHeadingUp(on) {
  nav.headingUp = on;
  document.body.classList.toggle('headingup', on);
  $('nav-rotate').classList.toggle('on', on); $('nav-rotate').setAttribute('aria-pressed', on);
  if (on) {
    layoutMap(true); setBearing(nav.pos && nav.pos.heading != null && !Number.isNaN(nav.pos.heading) ? nav.pos.heading : 0);
    map.dragging.disable();                                            // dragging would go the wrong way on a turned map
    map.touchZoom.disable(); map.options.touchZoom = 'center'; map.touchZoom.enable();   // pinch zooms around the centre
    map.doubleClickZoom.disable();
  } else {
    setBearing(0); layoutMap(false);
    map.dragging.enable(); map.touchZoom.disable(); map.options.touchZoom = true; map.touchZoom.enable(); map.doubleClickZoom.enable();
  }
  if (nav.pos) followPos(nav.pos.lat, nav.pos.lon);
  toast(on ? 'The map now turns with your direction' : 'North is up');
  saveNavState(true);
}
// keep you on screen: centred, or (turned map) low on the screen so you can see further ahead
function followPos(lat, lon) {
  const z = Math.max(map.getZoom(), 17);
  if (nav.headingUp) {
    const ahead = Math.round(innerHeight * 0.2), r = nav.bearing * Math.PI / 180;
    const c = map.unproject(map.project([lat, lon], z).add(L.point(Math.sin(r), -Math.cos(r)).multiplyBy(ahead)), z);
    map.setView(c, z, { animate: true });
  } else map.setView([lat, lon], z, { animate: true });
}
$('nav-rotate').onclick = () => setHeadingUp(!nav.headingUp);
$('nav-zin').onclick = () => map.zoomIn(); $('nav-zout').onclick = () => map.zoomOut();
window.addEventListener('resize', () => { if (nav.headingUp) layoutMap(true); });

// ---- controls ----
function endNav() {
  if (nav.headingUp) setHeadingUp(false);
  nav.on = false; clearNavSession(); nav.prev = null; nav.arrived = false;
  if (nav.watch != null && navigator.geolocation) navigator.geolocation.clearWatch(nav.watch);
  nav.watch = null; nav.pos = null;
  try { if (nav.wake) nav.wake.release(); } catch (e) {} nav.wake = null;
  navLayer.clearLayers();
  if (posMarker) { posMarker.remove(); accCircle.remove(); posMarker = accCircle = null; }
  $('nav').hidden = true; $('rail').hidden = true;
  document.body.classList.remove('navigating');
  map.getPane('route').style.opacity = '';
  applySheetMode(); setSheet('half');
  if (plans.length) show(activePlan);
}
const confirmEnd = () => {
  if (!confirm('End navigation?')) return;
  nav.rec.endLeg();
  const st = nav.rec.stats();
  if (nav.rec.usable && st.moving >= 30 && confirm(`Save the ride so far (${(st.distance / 1000).toFixed(1)} km) as a file for Strava?`)) downloadRide('fit');
  endNav();
};
$('nav-end').onclick = confirmEnd;
$('rail-end').onclick = confirmEnd;
$('nav-arrived').onclick = () => {
  const ph = nav.phases[nav.i];
  if (ph && ph.type === 'bike' && !nav.recording && !nav.arrived) { startRecording(); return; }   // wait for the GPS to lock, then press it
  if (ph && ph.type === 'bike' && !ph.toRide) finishNav(); else nextPhase();
};   // the last leg ends only when you press Stop & save
$('nav-center').onclick = () => { nav.follow = true; if (nav.pos) followPos(nav.pos.lat, nav.pos.lon); };
map.on('dragstart', () => { if (nav.on) nav.follow = false; });
$('nav-reroute').onclick = () => { // plan again from where you are now, to the same destination
  if (!nav.pos || !picked.to || !planner) return;
  try {
    const np = planner.plan({ lat: nav.pos.lat, lon: nav.pos.lon }, { lat: picked.to.lat, lon: picked.to.lon }, planOptions());
    if (!np.length) throw new Error('none');
    plans = np; activePlan = 0; render(); startNav(0, true); toast('New route found');
  } catch (e) { toast('Could not find a new route from here'); }
};

// ================= favourite destinations =================
const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) {} };
const favNear = p => p && favs.find(f => navDist([f.lat, f.lon], [p.lat, p.lon]) < 40);
function updateFavStar() {
  const on = !!favNear(picked.to), b = $('fav-to');
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.title = on ? 'Remove from favourites' : 'Save as a favourite';
}
function renderFavs() {
  $('favs').hidden = !favs.length;
  $('fav-edit').textContent = favEdit ? 'Done' : 'Edit';
  $('favlist').innerHTML = '';
  favs.forEach(f => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'favchip' + (favEdit ? ' edit' : '');
    b.innerHTML = `<span>⭐ ${esc(f.name)}</span>` + (favEdit ? '<i aria-label="Remove">✕</i>' : '');
    b.onclick = () => { if (favEdit) { favs = favs.filter(x => x !== f); saveFavs(); if (!favs.length) favEdit = false; renderFavs(); } else useFav(f); };
    $('favlist').appendChild(b);
  });
  updateFavStar();
}
function useFav(f) { // one tap: the destination is set and the routes appear
  $('to').value = f.name;
  if (setPoint('to', f.lat, f.lon, true)) { setSheet('half'); runPlan(); }
}
$('fav-to').onclick = () => {
  if (!picked.to) { toast('Choose a destination first, then tap ☆ to save it'); return; }
  const have = favNear(picked.to);
  if (have) { if (confirm(`Remove "${have.name}" from your favourites?`)) { favs = favs.filter(x => x !== have); saveFavs(); renderFavs(); } return; }
  if (favs.length >= 20) { toast('You can keep up to 20 favourites'); return; }
  const raw = $('to').value.trim();
  const name = (prompt('Name this favourite (for example Home or Work)', /^Pin \(/.test(raw) ? '' : raw.slice(0, 30)) || '').trim().slice(0, 30);
  if (!name) return;
  favs.push({ name, lat: picked.to.lat, lon: picked.to.lon }); saveFavs(); renderFavs(); toast('Saved to favourites');
};
$('fav-edit').onclick = () => { favEdit = !favEdit; renderFavs(); };
renderFavs();
if (hasNavSession()) resumeNav();              // a navigation was in progress when the app was closed
else { clearNavSession(); if (settings.gpsStart) useMyLocation(); }   // (a stale or broken saved navigation is dropped) otherwise start from where you are

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
