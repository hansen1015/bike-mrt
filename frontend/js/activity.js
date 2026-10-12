// Records the real GPS track of the cycling parts of a trip and writes it as ONE activity file for Strava.
// The train rides are "paused time": the file has timer stop / start events, and the distance counter does not move while paused.
//   * FIT (the format Garmin / Wahoo devices use): real pause events, one lap per cycling leg  <- the main file
//   * GPX: one track segment per cycling leg (a fallback; GPX has no pause concept)
// No dependencies; runs in the browser and in Node (tests/activity.test.mjs).

const FIT_EPOCH = 631065600;            // seconds from 1970-01-01 to 1989-12-31 (the FIT time origin)
const SEMI = 2147483648 / 180;          // degrees -> semicircles
const R_EARTH = 6371008.8;

const hav = (a, b) => {
  const p = Math.PI / 180, dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
};

export class Recorder {
  constructor() { this.legs = []; this.cur = null; }
  get open() { return !!this.cur; }

  startLeg(t = Date.now()) { if (!this.cur) { this.cur = { start: t, end: t, pts: [] }; this.legs.push(this.cur); } }

  // f: { t (ms since epoch), lat, lon, acc (m), alt (m or null), speed (m/s or null) }
  addFix(f) {
    const L = this.cur;
    if (!L || (f.acc != null && f.acc > 50)) return;           // poor fixes would make the track jump around
    const last = L.pts[L.pts.length - 1];
    if (last && Math.round(f.t / 1000) <= Math.round(last.t / 1000)) return; // one point per second at most, strictly increasing
    L.pts.push({ t: f.t, lat: f.lat, lon: f.lon, alt: Number.isFinite(f.alt) ? f.alt : null, spd: Number.isFinite(f.speed) ? f.speed : null });
    L.end = Math.max(L.end, f.t);
  }

  endLeg(t = Date.now()) {
    if (!this.cur) return;
    this.cur.end = Math.max(t, this.cur.end);
    if (this.cur.pts.length < 2) this.legs.pop();            // nothing worth keeping (no GPS during this leg)
    this.cur = null;
  }

  // legs with distance counted along them (the counter carries on across a pause without jumping)
  _prepared() {
    let dist = 0;
    return this.legs.filter(l => l.pts.length >= 2).map(l => {
      const start = dist, pts = l.pts.map((p, i) => {
        if (i > 0) {
          const step = hav(l.pts[i - 1], p);
          if (step >= 1.5) dist += step;                       // ignore standing-still jitter
        }
        const prev = l.pts[i - 1];
        const spd = p.spd != null ? p.spd : prev ? Math.min(25, hav(prev, p) / Math.max(1, (p.t - prev.t) / 1000)) : 0;
        return { ...p, dist, spd };
      });
      return { ...l, pts, start: Math.min(l.start, pts[0].t), end: Math.max(l.end, pts[pts.length - 1].t), distStart: start, distEnd: dist };
    });
  }

  get usable() { return this.legs.some(l => l.pts.length >= 2); }

  stats() {
    const legs = this._prepared();
    if (!legs.length) return { legs: 0, distance: 0, moving: 0, elapsed: 0, start: null, end: null };
    const moving = legs.reduce((s, l) => s + (l.end - l.start), 0) / 1000;
    const start = legs[0].start, end = legs[legs.length - 1].end;
    return { legs: legs.length, distance: legs[legs.length - 1].distEnd, moving, elapsed: (end - start) / 1000, start, end };
  }

  // ---------- FIT ----------
  // commute = true sets the FIT sub-sport to 48 ("commuting"), which Strava turns into its Commute tag
  toFIT({ commute = true } = {}) {
    const legs = this._prepared();
    if (!legs.length) return null;
    const subSport = commute ? 48 : 0;
    const w = new FitWriter();
    const T = ms => Math.round(ms / 1000) - FIT_EPOCH;
    const semi = d => Math.round(d * SEMI);
    const st = this.stats();
    const startT = T(legs[0].start), endT = T(legs[legs.length - 1].end);

    w.msg(0, [[0, 'enum'], [1, 'u16'], [2, 'u16'], [3, 'u32z'], [4, 'u32']], [4, 255, 1, 1, startT]);                         // file_id: activity, development manufacturer
    const EVENT = [[253, 'u32'], [0, 'enum'], [1, 'enum'], [4, 'u8']];                                                            // event: timestamp, event, event_type, group
    const REC = [[253, 'u32'], [0, 's32'], [1, 's32'], [2, 'u16'], [5, 'u32'], [6, 'u16']];                                       // record: time, lat, lon, altitude, distance, speed
    const LAP = [[253, 'u32'], [0, 'enum'], [1, 'enum'], [2, 'u32'], [3, 's32'], [4, 's32'], [5, 's32'], [6, 's32'], [7, 'u32'], [8, 'u32'], [9, 'u32'], [254, 'u16'], [25, 'enum']];
    legs.forEach((l, i) => {
      w.msg(21, EVENT, [T(l.start), 0, 0, 0]);                                                                                 // timer: start (or resume after the MRT ride)
      for (const p of l.pts) {
        w.msg(20, REC, [T(p.t), semi(p.lat), semi(p.lon), p.alt == null ? 0xFFFF : Math.max(0, Math.min(65534, Math.round((p.alt + 500) * 5))), Math.round(p.dist * 100), Math.round(Math.min(65, Math.max(0, p.spd)) * 1000)]);
      }
      w.msg(21, EVENT, [T(l.end), 0, 4, 0]);                                                                                   // timer: stop_all (the pause during the train ride)
      const a = l.pts[0], z = l.pts[l.pts.length - 1];
      w.msg(19, LAP, [T(l.end), 9, 1, T(l.start), semi(a.lat), semi(a.lon), semi(z.lat), semi(z.lon), Math.round((l.end - l.start)), Math.round((l.end - l.start)), Math.round((l.distEnd - l.distStart) * 100), i, 2]);
    });
    const maxSpd = Math.max(...legs.flatMap(l => l.pts.map(p => p.spd)));
    const first = legs[0].pts[0];
    w.msg(18, [[254, 'u16'], [253, 'u32'], [0, 'enum'], [1, 'enum'], [2, 'u32'], [3, 's32'], [4, 's32'], [7, 'u32'], [8, 'u32'], [9, 'u32'], [14, 'u16'], [15, 'u16'], [5, 'enum'], [6, 'enum'], [25, 'u16'], [26, 'u16']],
      [0, endT, 8, 1, startT, semi(first.lat), semi(first.lon), Math.round(st.elapsed * 1000), Math.round(st.moving * 1000), Math.round(st.distance * 100),
        Math.round(Math.min(65, st.moving ? st.distance / st.moving : 0) * 1000), Math.round(Math.min(65, maxSpd) * 1000), 2, subSport, 0, legs.length]);      // session: cycling (commuting)
    w.msg(34, [[253, 'u32'], [0, 'u32'], [1, 'u16'], [2, 'enum'], [3, 'enum'], [4, 'enum']], [endT, Math.round(st.moving * 1000), 1, 0, 26, 1]);       // activity
    return w.finish();
  }

  // ---------- GPX (fallback) ----------
  toGPX(name = 'Bike-MRT ride') {
    const legs = this._prepared();
    if (!legs.length) return null;
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const seg = l => '    <trkseg>\n' + l.pts.map(p => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString().replace(/\.\d+Z$/, 'Z')}</time></trkpt>`).join('\n') + '\n    </trkseg>';
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Bike-MRT" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${esc(name)}</name><time>${new Date(legs[0].start).toISOString().replace(/\.\d+Z$/, 'Z')}</time></metadata>\n  <trk>\n    <name>${esc(name)}</name>\n    <type>cycling</type>\n${legs.map(seg).join('\n')}\n  </trk>\n</gpx>\n`;
  }
}

// ---------- minimal FIT writer ----------
const TYPES = { enum: [0x00, 1], u8: [0x02, 1], s32: [0x85, 4], u16: [0x84, 2], u32: [0x86, 4], u32z: [0x8C, 4] };
const CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
export function fitCrc(bytes, crc = 0) {
  for (const b of bytes) {
    let t = CRC_TABLE[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[b & 0xF];
    t = CRC_TABLE[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[(b >> 4) & 0xF];
  }
  return crc;
}

class FitWriter {
  constructor() { this.data = []; this.local = new Map(); }
  _put(v, size) { v = Math.trunc(v); for (let i = 0; i < size; i++) this.data.push((v >>> (8 * i)) & 0xFF); }   // little endian (also right for negatives)
  msg(globalNum, fields, values) {
    let lt = this.local.get(globalNum);
    if (lt === undefined) {                                                  // definition message the first time a message type is used
      lt = this.local.size; this.local.set(globalNum, lt);
      this.data.push(0x40 | lt, 0, 0); this._put(globalNum, 2); this.data.push(fields.length);
      for (const [num, type] of fields) this.data.push(num, TYPES[type][1], TYPES[type][0]);
    }
    this.data.push(lt);
    fields.forEach(([, type], i) => this._put(values[i], TYPES[type][1]));
  }
  finish() {
    const n = this.data.length;
    const head = [14, 0x20, 2140 & 0xFF, 2140 >> 8, n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF, 0x2E, 0x46, 0x49, 0x54];
    const hc = fitCrc(head);
    const body = [...head, hc & 0xFF, hc >> 8, ...this.data];
    const c = fitCrc(body);
    return Uint8Array.from([...body, c & 0xFF, c >> 8]);
  }
}
