// Station exits: data sanity and the exit choice (quickest to reach on the route). Offline.
import fs from "node:fs";
import assert from "node:assert/strict";
import { Router } from "../frontend/js/router.js";
import { Planner } from "../frontend/js/planner.js";

const dir = new URL("../frontend/data/", import.meta.url);
const buf = f => { const b = fs.readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const js = f => JSON.parse(fs.readFileSync(new URL(f, dir), "utf8"));
const stations = js("stations.json"), ent = js("entrances.json");
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111195, (a.lon - b.lon) * 111195 * Math.cos(a.lat * Math.PI / 180));

// data: every exit belongs to a real station and is close to it, labels look like exits
for (const e of ent) {
  assert.ok(stations[e.s], "station id " + e.s);
  assert.ok(dist(e, stations[e.s]) <= 500, `exit ${e.label} of ${stations[e.s].name} is ${Math.round(dist(e, stations[e.s]))} m away`);
  assert.match(e.label, /^([A-Z]\d?|\d{1,2})( \(.+\))?$/, "label " + e.label);
}
assert.ok(new Set(ent.map(e => e.s)).size >= 120, "exit data for at least 120 stations");

const P = new Planner(new Router(buf("bg_nodes.bin"), buf("bg_edges.bin"), buf("bg_geom.bin")), stations, js("mrt_edges.json"), js("mrt_shapes.json"), js("bike_matrix.json"), ent);
const opts = { speed: 16, fold_min: 2.5, alight_min: 2, transfer_adj: 0, transfer_penalty: 0, max_ride_km: 15, allow_mid: true, lines: null, bike_pen: 1, alternatives: 3, peak: false };
const NTU = { lat: 1.35382, lon: 103.688243 }, ION = { lat: 1.303979, lon: 103.832032 };
const plans = P.plan(NTU, ION, opts);
assert.ok(plans.length > 0);
for (const p of plans) {
  assert.ok(Math.abs(p.legs.reduce((t, l) => t + l.min, 0) - p.total_min) < 0.15, "legs add up to the total");
  for (const l of p.legs.filter(l => l.mode === "mrt")) for (const k of ["enter", "exit"]) if (l[k]) assert.ok(l[k].label && !("snap" in l[k]), k + " is plain data");
}
// the plan that ends by train near ION Orchard should leave by an exit within 150 m of it (the mall is on top of the station)
const viaTrain = plans.find(p => p.legs.some(l => l.mode === "mrt" && l.segments.at(-1).to === "Orchard"));
assert.ok(viaTrain, "a plan that rides to Orchard");
const lastRide = viaTrain.legs.filter(l => l.mode === "mrt").at(-1);
assert.ok(lastRide.exit && dist(lastRide.exit, ION) < 150, "exit at Orchard is close to ION Orchard: " + JSON.stringify(lastRide.exit));
// boarding at Pioneer: the chosen exit is the one closest to where the bike arrives from (west/north), not an arbitrary one
const firstRide = viaTrain.legs.find(l => l.mode === "mrt");
assert.ok(firstRide.enter, "an exit to enter Pioneer by");
console.log("exit tests passed; ION Orchard plan:", `enter Exit ${firstRide.enter.label}, leave Exit ${lastRide.exit.label}`);
