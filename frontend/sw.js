// Bike-MRT service worker: makes the app installable and lets it open without signal.
// Bump VERSION whenever the files in data/ change so phones re-download them.
const VERSION = 'v6';
const CACHE = 'bike-mrt-' + VERSION;
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'js/app.js', 'js/router.js', 'js/planner.js', 'js/fares.js', 'js/search.js', 'lib/leaflet.js', 'lib/leaflet.css',
  'icons/icon-192.png', 'icons/icon-512.png',
  'data/bg_nodes.bin.gz', 'data/bg_edges.bin.gz', 'data/bg_geom.bin.gz', 'data/bike_matrix.json',
  'data/sg_land.json', 'data/stations.json', 'data/mrt_edges.json', 'data/mrt_shapes.json'];

self.addEventListener('install', e => {
  // cache:'reload' skips the browser's own HTTP cache (GitHub Pages lets browsers reuse files for 10 minutes), so a new
  // version is always cached as one consistent set instead of a mix of old and new files
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return c.put(u, r); }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // tiles / address search go straight to the network
  const heavy = /\/(data|lib|icons)\//.test(url.pathname);
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    // data/lib/icons: cache-first. Page and scripts: serve the cached copy but refresh it in the background.
    const refresh = fetch(e.request.url, { cache: 'no-cache' }).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit ? (heavy ? hit : (refresh, hit)) : refresh;
  }));
});
