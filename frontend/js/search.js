// Place search for Singapore, all free and key-less:
//   * MRT/LRT stations      - from the app's own station list (instant)
//   * OneMap (SLA)          - official buildings, landmarks, schools, postal codes, addresses
//   * Photon (OpenStreetMap)- shops, restaurants, cafes, clinics and other businesses (built for type-as-you-go search)
//   * Nominatim             - last-resort fallback if both of the above are unreachable
// Results from the different sources are merged and de-duplicated.

const BBOX = '103.55,1.13,104.12,1.48';
const ACRONYMS = new Set(['NTU', 'NUS', 'SMU', 'SIT', 'SUTD', 'SUSS', 'MRT', 'LRT', 'HDB', 'CBD', 'ION', 'IMM', 'JEM', 'NEX', 'PSA', 'KK', 'TTSH', 'SGH', 'NUH', 'CGH', 'KTPH',
  'CHIJ', 'ITE', 'MOE', 'CPF', 'DBS', 'OCBC', 'UOB', 'HSBC', 'PUB', 'SAFRA', 'OUE', 'UE', 'AMK', 'ECP', 'MBS', 'SMRT', 'SBS', 'LTA', 'URA', 'NLB', 'SCDF', 'SAF', 'CIMB', 'ABC', 'II', 'III', 'IV']);

const titleCase = s => s.toLowerCase().replace(/(^|[\s(\/&-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/\b[A-Za-z0-9]+\b/g, w => (ACRONYMS.has(w.toUpperCase()) || /^[A-Za-z]{1,3}\d+[A-Za-z]?$/.test(w) ? w.toUpperCase() : w)); // NTU, ION, NS22, S1 ...

// de-duplication key: ignores punctuation, bracketed codes and the words MRT / LRT / station
const norm = s => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\b(mrt|lrt|station)\b/g, '').replace(/[^a-z0-9]/g, '');

const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111195, (a.lon - b.lon) * 111195 * Math.cos(a.lat * Math.PI / 180));

function iconFor(key, value) {
  const v = value || '';
  if (/cafe|coffee|bakery|ice_cream/.test(v)) return '☕';
  if (/restaurant|fast_food|food_court|hawker|canteen/.test(v)) return '🍴';
  if (/bar|pub|biergarten/.test(v)) return '🍺';
  if (/mall|supermarket|department_store|convenience|clothes|shop|marketplace/.test(v) || key === 'shop') return '🛍️';
  if (/hospital|clinic|doctors|dentist|pharmacy/.test(v) || key === 'healthcare') return '🏥';
  if (/school|university|college|kindergarten|library/.test(v)) return '🎓';
  if (/bank|atm/.test(v)) return '🏦';
  if (/worship|temple|church|mosque/.test(v)) return '🛐';
  if (/bus_stop|bus_station/.test(v)) return '🚌';
  if (/station|subway|tram|train/.test(v) || key === 'railway') return '🚇';
  if (/parking/.test(v)) return '🅿️';
  if (/hotel|hostel|guest_house|motel/.test(v) || key === 'tourism') return '🏨';
  if (/park|garden|playground|nature|pitch|recreation/.test(v) || key === 'leisure') return '🌳';
  if (/sport|fitness|stadium|gym/.test(v)) return '🏟️';
  if (/apartments|residential|house|building|office|commercial|yes/.test(v) || key === 'building' || key === 'office') return '🏢';
  return '📍';
}
const prettyType = v => (v && v !== 'yes' ? v.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '');

// one retry after a short pause: OneMap throttles bursts of requests
async function getJson(url, signal, retry = true) {
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    if (!retry || (signal && signal.aborted)) throw e;
    await new Promise(res => setTimeout(res, 700));
    return getJson(url, signal, false);
  }
}

export async function oneMap(q, signal) {
  const d = await getJson('https://www.onemap.gov.sg/api/common/elastic/search?returnGeom=Y&getAddrDetails=Y&pageNum=1&searchVal=' + encodeURIComponent(q), signal);
  return (d.results || []).slice(0, 8).map(x => {
    const name = x.BUILDING && x.BUILDING !== 'NIL' ? x.BUILDING : x.SEARCHVAL;
    const street = [x.BLK_NO && x.BLK_NO !== 'NIL' ? x.BLK_NO : '', x.ROAD_NAME && x.ROAD_NAME !== 'NIL' ? x.ROAD_NAME : ''].filter(Boolean).join(' ');
    const sub = [street && titleCase(street), x.POSTAL && x.POSTAL !== 'NIL' ? 'S' + x.POSTAL : ''].filter(Boolean).join(' · ');
    return { title: titleCase(name), sub, icon: /station|mrt|lrt/i.test(name) ? '🚇' : '🏢', lat: +x.LATITUDE, lon: +x.LONGITUDE, src: 'onemap' };
  }).filter(r => r.title && Number.isFinite(r.lat));
}

async function photon(q, center, signal) {
  let url = 'https://photon.komoot.io/api/?lang=en&limit=10&bbox=' + BBOX + '&q=' + encodeURIComponent(q);
  if (center) url += '&lat=' + center.lat.toFixed(4) + '&lon=' + center.lon.toFixed(4); // prefer results near the map view
  const d = await getJson(url, signal);
  return (d.features || []).filter(f => (f.properties.countrycode || 'SG') === 'SG' && f.properties.osm_key !== 'landuse' && f.properties.osm_value !== 'construction').map(f => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const title = p.name || street;
    if (!title) return null;
    const where = [p.name ? street : '', p.district || p.locality || '', p.postcode ? 'S' + p.postcode : ''].filter(Boolean).join(' · ');
    const type = prettyType(p.osm_value);
    return { title, sub: [type, where].filter(Boolean).join(' · '), icon: iconFor(p.osm_key, p.osm_value), lat, lon, src: 'photon' };
  }).filter(Boolean);
}

async function nominatim(q, signal) {
  const d = await getJson('https://nominatim.openstreetmap.org/search?format=json&countrycodes=sg&limit=6&q=' + encodeURIComponent(q), signal);
  return d.map(x => ({ title: x.display_name.split(',')[0], sub: x.display_name.split(',').slice(1, 3).join(',').trim(), icon: '📍', lat: +x.lat, lon: +x.lon, src: 'nominatim' }));
}

function stationMatches(q, stations) {
  const t = q.trim().toLowerCase().replace(/\s*(mrt|lrt|station)\s*$/, '');
  if (t.length < 2) return [];
  const up = q.trim().toUpperCase();
  return stations
    .filter(s => s.name.toLowerCase().includes(t) || s.codes.some(c => c === up))
    .sort((a, b) => (b.name.toLowerCase().startsWith(t)) - (a.name.toLowerCase().startsWith(t)) || a.name.length - b.name.length)
    .slice(0, 3)
    .map(s => ({ title: `${s.name} ${s.codes.every(c => /^(BP|SE|SW|PE|PW)/.test(c)) ? 'LRT' : 'MRT'} station`, sub: s.codes.join(' · '), icon: '🚇', lat: s.lat, lon: s.lon, src: 'station' }));
}

// Returns { results: [{ title, sub, icon, lat, lon, src }], failed }. `center` = {lat, lon} to bias towards the map view.
export async function searchPlaces(q, { center, stations = [], signal } = {}) {
  const local = stationMatches(q, stations);
  const [om, ph] = await Promise.allSettled([oneMap(q, signal), photon(q, center, signal)]);
  if (signal && signal.aborted) return { results: [], failed: false, aborted: true };
  let official = om.status === 'fulfilled' ? om.value : [], osm = ph.status === 'fulfilled' ? ph.value : [];
  let failed = om.status === 'rejected' && ph.status === 'rejected';
  if (failed) { try { osm = await nominatim(q, signal); failed = false; } catch (e) { /* stay failed */ } }

  // merge: stations first, then a mix of official places and OSM businesses (OneMap first), dropping duplicates
  const out = [], seen = [];
  const add = r => {
    const k = norm(r.title);
    if (seen.some(s => s.k === k && dist(s.r, r) < 200)) return;
    seen.push({ k, r }); out.push(r);
  };
  local.forEach(add);
  const a = official.slice(0, 4), b = osm;
  const room = 9 - out.length;
  const bTake = Math.max(3, room - a.length);
  a.forEach(add); b.slice(0, bTake).forEach(add);
  official.slice(4).forEach(r => { if (out.length < 9) add(r); });
  b.slice(bTake).forEach(r => { if (out.length < 9) add(r); });
  return { results: out.slice(0, 9), failed };
}
