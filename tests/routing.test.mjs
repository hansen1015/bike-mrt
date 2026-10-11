// Routing regression test (offline). Guards against places that snapped onto one-way pockets (airport terminals,
// checkpoints, car parks) and then had "no route". Run after rebuilding the bike graph.
import fs from "node:fs";
import assert from "node:assert/strict";
import { Router } from "../frontend/js/router.js";
import { Planner } from "../frontend/js/planner.js";

const dir = new URL("../frontend/data/", import.meta.url);
const buf = f => { const b = fs.readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const js = f => JSON.parse(fs.readFileSync(new URL(f, dir), "utf8"));
const P = new Planner(new Router(buf("bg_nodes.bin"), buf("bg_edges.bin"), buf("bg_geom.bin")), js("stations.json"), js("mrt_edges.json"), js("mrt_shapes.json"), js("bike_matrix.json"));
const opts = { speed: 16, fold_min: 2.5, alight_min: 2, transfer_adj: 0, transfer_penalty: 0, max_ride_km: 15, allow_mid: true, lines: null, bike_pen: 1, alternatives: 3, peak: false };
const NTU = { lat: 1.35382, lon: 103.688243 };

// places that used to fail: each must be routable both ways
const must = { "Changi Airport T3": [1.3566, 103.9866], "Jewel Changi": [1.3603, 103.9891], "National Gallery": [1.2907, 103.8517],
  "Tuas Checkpoint": [1.3494, 103.6361], "Woodlands Checkpoint": [1.4456, 103.7690], "Marina Bay Sands": [1.2834, 103.8607], "Sentosa Gateway": [1.2542, 103.8210] };
for (const [name, [lat, lon]] of Object.entries(must)) {
  assert.ok(P.plan(NTU, { lat, lon }, opts).length > 0, `NTU -> ${name}`);
  assert.ok(P.plan({ lat, lon }, NTU, opts).length > 0, `${name} -> NTU`);
}

// random trips between points on the main island
const land = js("sg_land.json")[0];
const inRing = (lat, lon) => { let inside = false; for (let i = 0, j = land.length - 1; i < land.length; j = i++) { const [yi, xi] = land[i], [yj, xj] = land[j]; if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pt = () => { for (;;) { const lat = 1.20 + rnd() * 0.27, lon = 103.62 + rnd() * 0.40; if (inRing(lat, lon)) return { lat, lon }; } };
let none = 0; const N = 150;
for (let i = 0; i < N; i++) { try { if (!P.plan(pt(), pt(), opts).length) none++; } catch (e) { none++; } }   // a few points fall on road-less restricted islands
assert.ok(none <= 6, `${none} of ${N} random trips had no route`);

// restricted islands give a helpful message instead of a silent failure
assert.throws(() => P.plan(NTU, { lat: 1.2650, lon: 103.6990 }, opts), /No cycling roads near the destination/);
console.log(`routing tests passed (${N - none}/${N} random trips routed)`);
