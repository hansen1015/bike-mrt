// The Strava activity file: a real GPS track of the cycling legs only, with the train ride as paused time. Offline.
// Includes a small independent FIT parser, so the test does not depend on the encoder's own assumptions.
import assert from "node:assert/strict";
import { Recorder, fitCrc } from "../frontend/js/activity.js";

// ---- synthetic ride: 5 min of cycling, 40 min on the MRT (no GPS), 4 min of cycling ----
const t0 = Date.UTC(2026, 9, 12, 0, 30, 0);
const r = new Recorder();
r.startLeg(t0);
for (let i = 0; i <= 300; i++) r.addFix({ t: t0 + i * 1000, lat: 1.3538 + i * 6e-5, lon: 103.6882 + i * 1e-5, acc: 6, alt: 20, speed: 6.6 });
r.addFix({ t: t0 + 150500, lat: 1, lon: 1, acc: 6 });                       // less than a second after another point: dropped
r.addFix({ t: t0 + 400 * 1000, lat: 1.5, lon: 103.9, acc: 120 });           // poor accuracy: dropped
r.endLeg(t0 + 301000);
const t1 = t0 + 301000 + 40 * 60 * 1000;
r.startLeg(t1 - 15000);
for (let i = 0; i <= 240; i++) r.addFix({ t: t1 + i * 1000, lat: 1.29 + i * 4e-5, lon: 103.85 + i * 3e-5, acc: 5, alt: null, speed: null });
r.endLeg(t1 + 241000);
const st = r.stats();
assert.equal(st.legs, 2);
assert.ok(Math.abs(st.moving - (301 + 256)) < 3, "moving time excludes the train ride: " + st.moving);
assert.ok(st.elapsed > 2900, "elapsed time includes it");
assert.ok(st.distance > 3000 && st.distance < 3600, "distance of the two legs only: " + st.distance);

// ---- parse the FIT bytes ----
const fit = r.toFIT();
assert.equal(fit[0], 14); assert.equal(String.fromCharCode(...fit.slice(8, 12)), ".FIT");
const dataSize = fit[4] | fit[5] << 8 | fit[6] << 16 | fit[7] << 24;
assert.equal(fit.length, 14 + dataSize + 2, "size in the header matches");
assert.equal(fitCrc(fit.slice(0, 12)), fit[12] | fit[13] << 8, "header CRC");
assert.equal(fitCrc(fit.slice(0, fit.length - 2)), fit[fit.length - 2] | fit[fit.length - 1] << 8, "file CRC");

const defs = {}, msgs = [];
for (let o = 14; o < 14 + dataSize;) {
  const h = fit[o++];
  if (h & 0x40) {                                                            // definition
    const lt = h & 0x0F; o += 2; const g = fit[o] | fit[o + 1] << 8; o += 2; const n = fit[o++];
    const fields = []; for (let i = 0; i < n; i++) { fields.push({ num: fit[o], size: fit[o + 1] }); o += 3; }
    defs[lt] = { g, fields };
  } else {
    const d = defs[h & 0x0F]; const v = {};
    for (const f of d.fields) { let x = 0; for (let i = 0; i < f.size; i++) x += fit[o + i] * 2 ** (8 * i); if (f.size === 4 && x >= 2 ** 31 && (f.num === 0 || f.num === 1 || f.num === 3 || f.num === 4 || f.num === 5 || f.num === 6) && d.g !== 18 && d.g !== 19 && d.g !== 0) x -= 2 ** 32; v[f.num] = x; o += f.size; }
    msgs.push({ g: d.g, v });
  }
}
const of = g => msgs.filter(m => m.g === g);
assert.equal(of(0).length, 1, "file_id"); assert.equal(of(0)[0].v[0], 4, "file type = activity");
assert.equal(of(34).length, 1, "activity"); assert.equal(of(18).length, 1, "session"); assert.equal(of(18)[0].v[5], 2, "sport = cycling");
assert.equal(of(19).length, 2, "one lap per cycling leg");
const events = of(21).map(m => [m.v[253], m.v[0], m.v[1]]);
assert.deepEqual(events.map(e => e[2]), [0, 4, 0, 4], "timer start, stop (train), start (resume), stop");
assert.ok(events[2][0] - events[1][0] > 2300, "the pause lasts as long as the train ride");

// records: strictly increasing time, distance never decreases, and no distance is added during the pause
const rec = of(20).map(m => m.v);
assert.ok(rec.length > 500);
for (let i = 1; i < rec.length; i++) {
  assert.ok(rec[i][253] > rec[i - 1][253], "time increases");
  assert.ok(rec[i][5] >= rec[i - 1][5], "distance never goes down");
  if (rec[i][253] - rec[i - 1][253] > 600) assert.equal(rec[i][5], rec[i - 1][5], "no distance across the pause");
}
assert.ok(Math.abs(rec[0][0] / (2 ** 31 / 180) - 1.3538) < 1e-4, "latitude in semicircles");
assert.equal(rec.at(-1)[2], 0xFFFF, "no altitude when the phone gave none");
const total = of(18)[0].v[9] / 100;
assert.ok(Math.abs(total - st.distance) < 1, "session distance matches");
assert.ok(of(18)[0].v[8] / 1000 < of(18)[0].v[7] / 1000, "timer time is shorter than elapsed time");

// ---- GPX fallback ----
const gpx = r.toGPX("Test");
assert.equal((gpx.match(/<trkseg>/g) || []).length, 2, "one segment per cycling leg");
assert.ok(gpx.includes("<type>cycling</type>") && gpx.includes("2026-10-12T00:30:00Z"));
// nothing recorded -> no file
assert.equal(new Recorder().toFIT(), null);
console.log(`activity tests passed (${rec.length} records, ${fit.length} bytes)`);
