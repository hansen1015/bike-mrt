// Multimodal trifold bicycle + MRT/LRT planner.
// State graph: B:<s> = at station s with bike unfolded, T:<s>:<line> = inside the system on `line`.
// Any number of bike <-> MRT alternations is searched.
import { Router } from "./router.js";

// Route options (all optional):
//   speed            cycling speed km/h (<= 16, the graph's cap)
//   fold_min         folding the bike + gantry + walking to the platform, per boarding (waiting is added from headways)
//   alight_min       exit + unfold after leaving the system
//   transfer_adj     extra (or fewer) minutes added to every line change
//   peak             true = peak-hour headways, false = off-peak headways
//   transfer_penalty extra minutes per line change used only to rank plans (not shown in the time): "avoid transfers"
//   max_ride_km      longest single cycling leg allowed (also limits a pure-cycling trip)
//   allow_mid        allow cycling between stations in the middle of the trip
//   lines            enabled rail line codes (default all: NS EW CG NE CC DT TE BP SE SW PE PW)
//   bike_pen         how much the ranking dislikes cycling, 1 = neutral, higher = prefers trains
//   alternatives     how many plans to return (1-3)
export const DEFAULTS = { speed: 16, fold_min: 2.5, alight_min: 2, transfer_adj: 0, peak: false, max_first_last_km: 15,
  transfer_penalty: 0, max_ride_km: 15, allow_mid: true, lines: null, bike_pen: 1, alternatives: 3 };

// Waiting time = half the gap between trains (you arrive at a random moment). Gaps are LTA's published figures:
// 2-3 min at peak and about 5 min off-peak on the MRT, Thomson-East Coast Line 5 / 6 min, LRT about 3 / 6 min.
const LRT_CODES = new Set(['BP', 'SE', 'SW', 'PE', 'PW']);
const HEADWAY = { mrt: [2.5, 5], te: [5, 6], lrt: [3, 6] }; // [peak, off-peak] minutes
const headway = (line, peak) => HEADWAY[LRT_CODES.has(line) ? 'lrt' : line === 'TE' ? 'te' : 'mrt'][peak ? 0 : 1];

// Walking time (minutes) for changing line inside one station. Default 3 min (platform change with stairs/escalators).
// Exceptions: cross-platform interchanges (step across the platform) and stations where the transfer is a longer walk.
const TRANSFER_WALK_DEFAULT = 3;
const TRANSFER_WALK = {
  'City Hall': { 'EW|NS': 1 }, 'Raffles Place': { 'EW|NS': 1 }, 'Jurong East': { 'EW|NS': 1 }, 'Tanah Merah': { 'CG|EW': 1 },
  'Tampines': { 'DT|EW': 6.5 },        // ~300 m linkway, exit and re-enter within the free-transfer window
  'Newton': { 'DT|NS': 4 },            // 56 m linkway outside the gantry
  'Bukit Panjang': { 'BP|DT': 4 },     // LRT station ~200 m from the Downtown Line station
};
const transferWalk = (station, a, b) => (TRANSFER_WALK[station] || {})[[a, b].sort().join('|')] ?? TRANSFER_WALK_DEFAULT;
const BASE_SPEED = 16;

class Heap { // tiny binary heap of [key, value]
  constructor() { this.a = []; }
  push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= a.length) break; if (c + 1 < a.length && a[c + 1][0] < a[c][0]) c++; if (a[c][0] >= a[i][0]) break; [a[c], a[i]] = [a[i], a[c]]; i = c; } } return top; }
  get size() { return this.a.length; }
}

export class Planner {
  constructor(router, stations, mrtEdges, shapes, bikeMatrix, entrances = []) {
    this.router = router; this.stations = stations; this.mrtEdges = mrtEdges; this.shapes = shapes; this.matrix = bikeMatrix;
    this.byName = Object.fromEntries(stations.map(s => [s.name, [s.lat, s.lon]]));
    this.linesAt = {};
    for (const e of mrtEdges) for (const s of [e.a, e.b]) (this.linesAt[s] ||= new Set()).add(e.line);
    this.stationSnaps = stations.map(s => router.snap(s.lat, s.lon));
    // station exits ("Exit A", "Exit B" ...) by station id; their road snaps are made when first needed
    this.entByStation = new Map();
    for (const e of entrances) {
      if (!this.entByStation.has(e.s)) this.entByStation.set(e.s, []);
      this.entByStation.get(e.s).push({ label: e.label, lat: e.lat, lon: e.lon, wc: !!e.wc, snap: undefined });
    }
  }

  plan(origin, dest, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    for (const k of Object.keys(DEFAULTS)) if (typeof DEFAULTS[k] === 'number' && !Number.isFinite(o[k])) o[k] = DEFAULTS[k]; // never let a bad number poison the search
    const scale = BASE_SPEED / o.speed;
    const R = this.router, S = this.stations;
    const so = R.snap(origin.lat, origin.lon), sd = R.snap(dest.lat, dest.lon);
    if (!so || !sd) throw new Error(`No cycling roads near the ${!so ? 'start' : 'destination'}. It may be on a restricted island or in a closed area, so move the pin to a nearby road.`);
    const reach = Math.min(o.max_first_last_km, o.max_ride_km * 1.05); // straight-line pre-filter; exact km checked below
    const near = (p) => S.map(s => Router.dist([p.lat, p.lon], [s.lat, s.lon]) / 1000 <= reach);
    const nearO = near(origin), nearD = near(dest);
    const toStations = R.oneToMany(so, this.stationSnaps.map((sn, i) => nearO[i] ? sn : null), false, 150);
    const fromStations = R.oneToMany(sd, this.stationSnaps.map((sn, i) => nearD[i] ? sn : null), true, 150);
    const direct = R.route(so, sd);

    const variants = [], seen = new Set();
    const base = Math.max(1, o.bike_pen);
    for (const [label, pen] of [["Fastest", base], ["Less cycling", base * 1.6], ["Least cycling", base * 2.6]]) {
      const res = this._dijkstra(o, scale, pen, toStations, fromStations, direct);
      if (!res) continue;
      const sig = JSON.stringify(res.legs.map(l => [l.mode, l.from, l.to, l.segments && l.segments.map(s => s.line + s.from + s.to)]));
      if (seen.has(sig)) continue;
      seen.add(sig); res.label = label; variants.push(res);
    }
    // plans that use the trains. A plan that is only cycling is dropped here: the "Cycle all the way" option below replaces it.
    const plans = variants.filter(p => p.legs.some(l => l.mode === "mrt"));
    plans.sort((a, b) => a.total_min - b.total_min);
    plans.length = Math.min(plans.length, Math.max(1, Math.min(3, o.alternatives)));
    const cycle = direct ? this._cyclePlan(direct, scale, origin, dest) : null;
    if (!plans.length && !cycle) { // nothing at all: say why, so the message can be specific
      const none = [];
      none.reason = !(toStations.some(Boolean)) ? 'start' : !(fromStations.some(Boolean)) ? 'dest' : 'limits';
      return none;
    }
    plans.forEach(p => this._addGeometry(p, origin, dest, so, sd, scale));
    plans.sort((a, b) => a.total_min - b.total_min); // choosing exits can shift times slightly
    const cycleFastest = !!cycle && plans.every(p => cycle.total_min <= p.total_min);
    plans.forEach((p, i) => { // name the plans from their final order
      p.label = i === 0 ? (cycleFastest ? "Fastest with MRT" : "Fastest") : p.bike_km < plans[0].bike_km - 0.05 ? (i === 1 ? "Less cycling" : "Least cycling") : "Alternative";
    });
    if (cycle) { cycle.label = cycleFastest ? "Cycle all the way · fastest" : "Cycle all the way"; plans.push(cycle); } // always the last option
    return plans;
  }

  // the whole trip by bike, whatever the "longest single ride" setting says
  _cyclePlan(direct, scale, origin, dest) {
    const min = +(direct.min * scale).toFixed(1), km = +direct.km.toFixed(2);
    const leg = { mode: "bike", from: "Start", to: "Destination", min, km, coords: direct.coords, segs: direct.segs, from_pt: [origin.lat, origin.lon], to_pt: [dest.lat, dest.lon] };
    return { total_min: min, bike_km: km, bike_min: min, mrt_min: 0, legs: [leg] };
  }

  _dijkstra(o, scale, pen, toSt, fromSt, direct) {
    const adj = new Map();
    const add = (u, v, real, bike, info, extra = 0) => { if (!adj.has(u)) adj.set(u, []); adj.get(u).push({ v, real, bike, info, extra }); };
    const on = o.lines ? new Set(o.lines) : null;
    const lineOn = l => !on || on.has(l);
    const rideOk = km => km <= o.max_ride_km + 1e-9;
    this.stations.forEach(s => {
      const lines = new Set([...(this.linesAt[s.id] || [])].filter(lineOn));
      for (const line of lines) {
        add("B" + s.id, `T${s.id}:${line}`, o.fold_min + headway(line, o.peak) / 2, false, { mode: "board" });
        add(`T${s.id}:${line}`, "B" + s.id, o.alight_min, false, { mode: "alight" });
        for (const other of lines) if (other !== line) {
          const t = Math.max(0.5, transferWalk(s.name, line, other) + headway(other, o.peak) / 2 + o.transfer_adj);
          add(`T${s.id}:${line}`, `T${s.id}:${other}`, t, false, { mode: "transfer" }, o.transfer_penalty);
        }
      }
    });
    this.mrtEdges.forEach((e, i) => {
      if (!lineOn(e.line)) return;
      add(`T${e.a}:${e.line}`, `T${e.b}:${e.line}`, e.min, false, { mode: "train", line: e.line, eid: i, rev: false });
      add(`T${e.b}:${e.line}`, `T${e.a}:${e.line}`, e.min, false, { mode: "train", line: e.line, eid: i, rev: true });
    });
    if (o.allow_mid) for (const k in this.matrix) {
      const [a, b] = k.split(","); const [m, km] = this.matrix[k];
      if (rideOk(km)) add("B" + a, "B" + b, m * scale, true, { mode: "bike", km });
    }
    toSt.forEach((r, i) => r && rideOk(r.km) && add("O", "B" + i, r.min * scale, true, { mode: "bike", km: r.km }));
    fromSt.forEach((r, i) => r && rideOk(r.km) && add("B" + i, "D", r.min * scale, true, { mode: "bike", km: r.km }));
    if (direct && rideOk(direct.km)) add("O", "D", direct.min * scale, true, { mode: "bike", km: direct.km });

    const dist = new Map([["O", 0]]), prev = new Map(), pq = new Heap();
    pq.push(0, "O");
    while (pq.size) {
      const [d, u] = pq.pop();
      if (d > dist.get(u)) continue;
      if (u === "D") break;
      for (const a of adj.get(u) || []) {
        const nd = d + (a.bike ? a.real * pen : a.real) + a.extra;
        if (nd < (dist.has(a.v) ? dist.get(a.v) : Infinity)) { dist.set(a.v, nd); prev.set(a.v, [u, a.real, a.info]); pq.push(nd, a.v); }
      }
    }
    if (!prev.has("D")) return null;
    const path = []; let node = "D";
    while (node !== "O") { const [u, real, info] = prev.get(node); path.push([u, node, real, info]); node = u; }
    return this._legs(path.reverse());
  }

  _name(n) { return n === "O" ? "Start" : n === "D" ? "Destination" : this.stations[+n.slice(1).split(":")[0]].name; }

  _legs(path) {
    const legs = [];
    for (const [u, v, real, info] of path) {
      const m = info.mode;
      if (m === "bike") legs.push({ mode: "bike", from: this._name(u), to: this._name(v), min: real, km: info.km, _u: u, _v: v, parts: [[u, v]] });
      else if (m === "board") legs.push({ mode: "mrt", from: this._name(u), min: real, segments: [], _u: u });
      else if (m === "train") {
        const leg = legs[legs.length - 1], seg = leg.segments, last = seg[seg.length - 1];
        const shape = info.rev ? this.shapes[info.eid].slice().reverse() : this.shapes[info.eid];
        const nu = this._name(u), nv = this._name(v);
        if (!last || last.line !== info.line) { seg.push({ line: info.line, from: nu, to: nv, stops: 1, min: real, change_min: leg._pendingChange || 0, coords: [...shape], stop_pts: [this.byName[nu], this.byName[nv]], stop_names: [nu, nv] }); leg._pendingChange = 0; }
        else { last.to = nv; last.stops++; last.min += real; last.coords.push(...shape.slice(1)); last.stop_pts.push(this.byName[nv]); last.stop_names.push(nv); }
        leg.min += real;
      } else if (m === "transfer") { const l = legs[legs.length - 1]; l.min += real; l._pendingChange = real; }
      else if (m === "alight") { const l = legs[legs.length - 1]; l.min += real; l.to = this._name(u); l._v = u; }
    }
    const merged = [];
    for (const l of legs) {
      if (l.mode === "bike" && l.km < 0.03) continue;
      const m = merged[merged.length - 1];
      if (l.mode === "bike" && m && m.mode === "bike") { m.to = l.to; m.min += l.min; m.km += l.km; m._v = l._v; m.parts.push(...l.parts); }
      else merged.push(l);
    }
    const total = merged.reduce((s, l) => s + l.min, 0);
    const bikeMin = merged.filter(l => l.mode === "bike").reduce((s, l) => s + l.min, 0);
    const bikeKm = merged.filter(l => l.mode === "bike").reduce((s, l) => s + l.km, 0);
    merged.forEach(l => {
      l.min = +l.min.toFixed(1); if (l.km !== undefined) l.km = +l.km.toFixed(2);
      if (l.segments) { delete l._pendingChange; l.segments.forEach(sg => { sg.min = +sg.min.toFixed(1); sg.change_min = +sg.change_min.toFixed(1); }); }
    });
    return { total_min: +total.toFixed(1), bike_km: +bikeKm.toFixed(2), bike_min: +bikeMin.toFixed(1), mrt_min: +(total - bikeMin).toFixed(1), legs: merged };
  }

  _snapOf(n, origin, dest, so, sd) { return n === "O" ? so : n === "D" ? sd : this.stationSnaps[+n.slice(1).split(":")[0]]; }
  _ptOf(n, origin, dest) { if (n === "O") return [origin.lat, origin.lon]; if (n === "D") return [dest.lat, dest.lon]; const s = this.stations[+n.slice(1).split(":")[0]]; return [s.lat, s.lon]; }

  _stationOf(n) { return +n.slice(1).split(":")[0]; }

  _exits(sid) {
    const list = this.entByStation.get(sid) || [];
    for (const e of list) if (e.snap === undefined) e.snap = this.router.snap(e.lat, e.lon);
    return list.filter(e => e.snap);
  }

  // The exit of station `sid` that is quickest to reach from `other` (a router snap): reverse=false, you ride other -> exit.
  // reverse=true: you ride exit -> other. Returns null when the station has no exit data.
  _bestExit(sid, other, reverse) {
    const ents = this._exits(sid);
    if (!ents.length || !other) return null;
    const res = this.router.oneToMany(other, ents.map(e => e.snap), reverse, 60);
    let best = null;
    res.forEach((r, i) => { if (r && (!best || r.min < best.min)) best = { e: ents[i], min: r.min }; });
    if (best) return best.e;
    const d = e => Router.dist(other.query, [e.lat, e.lon]);                   // unreachable by road: take the closest as the crow flies
    return ents.reduce((a, b) => (d(a) <= d(b) ? a : b));
  }

  _addGeometry(plan, origin, dest, so, sd, scale) {
    const legs = plan.legs, S = n => this._snapOf(n, origin, dest, so, sd);

    // 1. for every train ride pick the exit to enter by (closest to where you come from) and the exit to leave by (closest to where you go next)
    legs.forEach((l, i) => {
      if (l.mode !== "mrt") return;
      const prev = legs[i - 1] && legs[i - 1].mode === "bike" ? legs[i - 1] : null;
      const next = legs[i + 1] && legs[i + 1].mode === "bike" ? legs[i + 1] : null;
      let from = null;
      if (prev) { const k = prev.parts.length - 1; from = k === 0 && prev._exitSnap ? prev._exitSnap : S(prev.parts[k][0]); }
      else if (i === 0) from = so;
      l.enter = this._bestExit(this._stationOf(l._u), from, false);
      const to = next ? S(next.parts[0][1]) : sd;
      l.exit = this._bestExit(this._stationOf(l._v), to, true);
      if (next && l.exit) next._exitSnap = l.exit.snap;
    });

    // 2. cycle routes now run to / from those exact exits
    legs.forEach((l, i) => {
      if (l.mode === "bike") {
        const prevRide = legs[i - 1] && legs[i - 1].mode === "mrt" ? legs[i - 1] : null;
        const nextRide = legs[i + 1] && legs[i + 1].mode === "mrt" ? legs[i + 1] : null;
        l.coords = []; l.segs = []; let min = 0, km = 0, ok = true;
        l.parts.forEach(([u, v], k) => {
          let a = S(u), b = S(v);
          if (k === 0 && prevRide && prevRide.exit) a = prevRide.exit.snap;
          if (k === l.parts.length - 1 && nextRide && nextRide.enter) b = nextRide.enter.snap;
          const r = this.router.route(a, b) || this.router.route(S(u), S(v));
          if (r) { l.coords.push(...r.coords); l.segs.push(...r.segs); min += r.min * scale; km += r.km; } else ok = false;
        });
        if (ok && l.coords.length) { l.min = +min.toFixed(1); l.km = +km.toFixed(2); } // keep the planner's numbers if a part could not be re-routed
        delete l.parts; delete l._exitSnap;
      } else l.coords = [];
      l.from_pt = this._ptOf(l._u, origin, dest); l.to_pt = this._ptOf(l._v, origin, dest);
      delete l._u; delete l._v;
    });
    // only now drop the road snaps from the exits (the cycling legs above needed them)
    legs.forEach(l => { if (l.mode === "mrt") for (const k of ["enter", "exit"]) if (l[k]) l[k] = { label: l[k].label, lat: l[k].lat, lon: l[k].lon, wc: l[k].wc }; });

    // a cycling stub of a few metres at the very start or end (the exit is right at your destination) is not worth a leg of its own:
    // its minutes stay in the trip, added to the neighbouring train ride
    for (let i = legs.length - 1; i >= 0; i--) {
      const l = legs[i];
      if (l.mode === "bike" && l.km < 0.06 && legs.length > 1 && (i === 0 || i === legs.length - 1)) {
        const nb = legs[i === 0 ? 1 : i - 1];
        if (nb && nb.mode === "mrt") { nb.min = +(nb.min + l.min).toFixed(1); legs.splice(i, 1); }
      }
    }

    // 3. totals follow the new cycling legs
    const total = legs.reduce((t, l) => t + l.min, 0);
    const bikes = legs.filter(l => l.mode === "bike");
    const bikeMin = bikes.reduce((t, l) => t + l.min, 0);
    plan.total_min = +total.toFixed(1); plan.bike_min = +bikeMin.toFixed(1); plan.mrt_min = +(total - bikeMin).toFixed(1);
    plan.bike_km = +bikes.reduce((t, l) => t + l.km, 0).toFixed(2);
  }
}
