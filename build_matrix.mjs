// Precompute directed station->station bike minutes/km with the on-device router -> frontend/data/bike_matrix.json
import fs from "fs";
import { Router } from "./frontend/js/router.js";

const buf = f => { const b = fs.readFileSync("frontend/data/" + f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
let t0 = Date.now();
const router = new Router(buf("bg_nodes.bin"), buf("bg_edges.bin"), buf("bg_geom.bin"));
console.log("graph loaded", Date.now() - t0, "ms;", router.N, "nodes");

const stations = JSON.parse(fs.readFileSync("data/stations.json", "utf8"));
const snaps = stations.map(s => router.snap(s.lat, s.lon));
console.log("unsnapped:", stations.filter((s, i) => !snaps[i]).map(s => s.name));
const sk = (a, b) => Router.dist([a.lat, a.lon], [b.lat, b.lon]) / 1000;

const out = {};
t0 = Date.now();
stations.forEach((a, i) => {
  if (!snaps[i]) return;
  const targets = stations.map((b, j) => (i !== j && snaps[j] && sk(a, b) <= 15) ? snaps[j] : null);
  router.oneToMany(snaps[i], targets, false, 120).forEach((r, j) => { if (r) out[i + "," + j] = [+r.min.toFixed(2), +r.km.toFixed(3)]; });
});
console.log("matrix", Object.keys(out).length, "entries in", Date.now() - t0, "ms");
fs.writeFileSync("frontend/data/bike_matrix.json", JSON.stringify(out));

