// Navigation logic: turn instructions, following a GPS position along a route, train step cards. Offline.
import fs from "node:fs";
import assert from "node:assert/strict";
import { Router } from "../frontend/js/router.js";
import { Planner } from "../frontend/js/planner.js";
import { buildGuidance, locate, nextInstruction, railCards, trainDirection, dist, fmtDist } from "../frontend/js/nav.js";

// ---------- synthetic: 200 m north, then a right turn, 200 m east ----------
const M = 111195, lat0 = 1.30, lon0 = 103.80, kx = Math.cos(lat0 * Math.PI / 180) * M;
const P = (north, east) => [lat0 + north / M, lon0 + east / kx];
const seg = (name, kind, ...c) => ({ name, kind, coords: c });
let g = buildGuidance([seg("Alpha Road", 0, P(0, 0), P(100, 0), P(200, 0)), seg("Beta Street", 0, P(200, 0), P(200, 100), P(200, 200))]);
assert.deepEqual(g.ins.map(i => i.type), ["start", "right", "arrive"]);
assert.equal(g.ins[0].text, "Head north on Alpha Road");
assert.equal(g.ins[1].text, "Turn right onto Beta Street");
assert.ok(Math.abs(g.ins[1].along - 200) < 1 && Math.abs(g.total - 400) < 1);
// left turn, slight turn, straight junction with the same name (no instruction), U-turn
g = buildGuidance([seg("A", 0, P(0, 0), P(150, 0)), seg("B", 0, P(150, 0), P(150, -150))]);
assert.equal(g.ins[1].type, "left");
g = buildGuidance([seg("A", 0, P(0, 0), P(150, 0)), seg("B", 0, P(150, 0), P(300, 100))]);
assert.equal(g.ins[1].type, "slight-right");
g = buildGuidance([seg("Same Rd", 0, P(0, 0), P(150, 0)), seg("Same Rd", 0, P(150, 0), P(300, 0))]);
assert.deepEqual(g.ins.map(i => i.type), ["start", "arrive"], "no instruction for a straight junction on the same road");
g = buildGuidance([seg("Old Rd", 0, P(0, 0), P(150, 0)), seg("New Rd", 0, P(150, 0), P(300, 5))]);
assert.equal(g.ins[1].text, "Continue onto New Rd");
g = buildGuidance([seg("", 1, P(0, 0), P(100, 0)), seg("", 0, P(100, 0), P(100, 100))]);
assert.equal(g.ins[1].text, "Turn right", "no name, plain road");
g = buildGuidance([seg("A", 0, P(0, 0), P(150, 0)), seg("", 1, P(150, 0), P(150, 100))]);
assert.equal(g.ins[1].text, "Turn right onto the cycle path");
// a roundabout: several junctions within 30 m become one instruction
g = buildGuidance([seg("A", 0, P(0, 0), P(100, 0)), seg("R", 0, P(100, 0), P(110, 8)), seg("R", 0, P(110, 8), P(112, 20)), seg("R", 0, P(112, 20), P(105, 32)), seg("B", 0, P(105, 32), P(105, 150))]);
assert.ok(g.ins.length <= 4, "roundabout collapsed: " + g.ins.map(i => i.text).join(" / "));

// ---------- following a position ----------
g = buildGuidance([seg("Alpha Road", 0, P(0, 0), P(100, 0), P(200, 0)), seg("Beta Street", 0, P(200, 0), P(200, 100), P(200, 200))]);
let at = locate(g, ...P(120, 3));
assert.ok(Math.abs(at.along - 120) < 2 && at.cross < 4, JSON.stringify(at));
assert.equal(nextInstruction(g, at.along).type, "right");
at = locate(g, ...P(200, 150));
assert.ok(Math.abs(at.along - 350) < 2);
assert.equal(nextInstruction(g, at.along).type, "arrive");
at = locate(g, ...P(100, 80));                       // 80 m off the route
assert.ok(at.cross > 70);
// a route that doubles back: with a hint the position does not jump forward
const loop = buildGuidance([seg("L", 0, P(0, 0), P(0, 100), P(50, 100), P(50, 0), P(0, 0.5))]);
assert.ok(locate(loop, ...P(0, 50), 0).along < 60);
assert.ok(locate(loop, ...P(50, 50), 140).along > 140);

// ---------- real route from the planner ----------
const dir = new URL("../frontend/data/", import.meta.url);
const buf = f => { const b = fs.readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const js = f => JSON.parse(fs.readFileSync(new URL(f, dir), "utf8"));
const stations = js("stations.json");
const router = new Router(buf("bg_nodes.bin"), buf("bg_edges.bin"), buf("bg_geom.bin"), buf("bg_names.bin"), buf("bg_kinds.bin"), js("names.json"));
const planner = new Planner(router, stations, js("mrt_edges.json"), js("mrt_shapes.json"), js("bike_matrix.json"), js("entrances.json"));
const opts = { speed: 16, fold_min: 2.5, alight_min: 2, transfer_adj: 0, transfer_penalty: 0, max_ride_km: 15, allow_mid: true, lines: null, bike_pen: 1, alternatives: 3, peak: false };
const plans = planner.plan({ lat: 1.35382, lon: 103.688243 }, { lat: 1.303979, lon: 103.832032 }, opts);
const plan = plans.find(p => p.legs.some(l => l.mode === "mrt" && l.segments.length > 1)) || plans[0];   // one with a line change
const bike = plan.legs.find(l => l.mode === "bike");
assert.ok(bike.segs && bike.segs.length > 3, "cycling legs carry street segments");
assert.ok(bike.segs.some(s => s.name), "some segments have street names");
const gd = buildGuidance(bike.segs, { arrive: "Arrive at Pioneer" });
assert.ok(gd.ins.length >= 3 && gd.ins[0].type === "start" && gd.ins.at(-1).type === "arrive");
assert.ok(gd.ins.every((i, k) => k === 0 || i.along >= gd.ins[k - 1].along), "instructions are in order");
assert.ok(Math.abs(gd.total / 1000 - bike.km) < 0.15, `route length ${gd.total} m vs leg ${bike.km} km`);
console.log("   first cycling leg:", gd.ins.map(i => `${fmtDist(i.along)} ${i.text}`).slice(0, 6).join(" | "));
// walking the real route with fake GPS fixes finishes at the end
let along = 0;
for (let d = 0; d < gd.total; d += 40) { const i = gd.cum.findIndex(c => c >= d); const f = locate(gd, ...gd.pts[Math.max(0, i)], along); assert.ok(f.cross < 1 && f.along >= along - 1); along = f.along; }

// ---------- train step cards ----------
const byName = new Map(stations.map(s => [s.name, s]));
const ride = plan.legs.find(l => l.mode === "mrt");
const lineName = c => c;
const cards = railCards(ride, { stationByName: byName, lineName, moneyText: "$2.36", nextIsBike: true });
assert.equal(cards[0].kind, "enter"); assert.equal(cards.at(-1).kind, "leave");
assert.equal(cards.length, 2 + ride.segments.length * 2 - 1, "enter + board + (change + board)* + leave");
assert.ok(cards.filter(c => c.kind === "change").length === ride.segments.length - 1);
console.log("   train cards:", cards.map(c => c.title).join(" | "));
assert.equal(trainDirection({ line: "EW", stop_names: ["Pioneer", "Joo Koon"], to: "x" }, byName), "Tuas Link");
assert.equal(trainDirection({ line: "EW", stop_names: ["Pioneer", "Boon Lay"], to: "x" }, byName), "Pasir Ris");
assert.equal(trainDirection({ line: "NS", stop_names: ["Orchard", "Somerset"], to: "x" }, byName), "Marina South Pier");
assert.equal(trainDirection({ line: "TE", stop_names: ["Orchard", "Great World"], to: "x" }, byName), "Sungei Bedok");
assert.equal(trainDirection({ line: "TE", stop_names: ["Great World", "Orchard"], to: "x" }, byName), "Woodlands North");
assert.equal(fmtDist(42), "40 m"); assert.equal(fmtDist(130), "130 m"); assert.equal(fmtDist(1234), "1.2 km");
console.log("navigation tests passed");
