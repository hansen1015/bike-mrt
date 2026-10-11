// On-device Brompton router over the compact graph written by export_bikegraph.py.
// Pure ES module: works in the browser/WebView and in Node (for precomputing the station matrix).

const LAT0 = 1.1, LON0 = 103.5, CELLS_PER_DEG = 500, GRID_W = 320;
const OFF_ROAD_KMH = 10; // riding/pushing from a pin to the nearest rideable way

class MinHeap {
  constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() { // returns node, key in this.lastKey
    const rv = this.v[0]; this.lastKey = this.k[0];
    const key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return rv;
  }
}

export class Router {
  constructor(nodesBuf, edgesBuf, geomBuf) {
    const xy = new Int32Array(nodesBuf);
    this.N = xy.length / 2; this.xy = xy;
    this.geom = new Int32Array(geomBuf);
    const E = edgesBuf.byteLength / 28; this.E = E;
    const dv = new DataView(edgesBuf);
    this.ea = new Int32Array(E); this.eb = new Int32Array(E); this.egs = new Int32Array(E); this.egc = new Int32Array(E);
    this.elen = new Float32Array(E); this.epen = new Float32Array(E);
    this.esf = new Uint8Array(E); this.esb = new Uint8Array(E);
    for (let e = 0; e < E; e++) {
      const o = e * 28;
      this.ea[e] = dv.getInt32(o, true); this.eb[e] = dv.getInt32(o + 4, true);
      this.egs[e] = dv.getInt32(o + 8, true); this.egc[e] = dv.getInt32(o + 12, true);
      this.elen[e] = dv.getFloat32(o + 16, true); this.epen[e] = dv.getFloat32(o + 20, true);
      this.esf[e] = dv.getUint8(o + 24); this.esb[e] = dv.getUint8(o + 25);
    }
    this._buildAdjacency();
    this._buildGrid();
    this.cost = new Float64Array(this.N); this.time = new Float64Array(this.N);
    this.meters = new Float32Array(this.N); this.prev = new Int32Array(this.N);
  }

  // arc = edge*2 + dir ; dir 0: a->b (speed esf), dir 1: b->a (speed esb)
  arcSpeed(arc) { const e = arc >> 1; return (arc & 1) ? this.esb[e] : this.esf[e]; }
  arcTo(arc) { const e = arc >> 1; return (arc & 1) ? this.ea[e] : this.eb[e]; }
  arcFrom(arc) { const e = arc >> 1; return (arc & 1) ? this.eb[e] : this.ea[e]; }

  _buildAdjacency() {
    const N = this.N, E = this.E;
    const outCnt = new Int32Array(N + 1), inCnt = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) {
      if (this.esf[e]) { outCnt[this.ea[e] + 1]++; inCnt[this.eb[e] + 1]++; }
      if (this.esb[e]) { outCnt[this.eb[e] + 1]++; inCnt[this.ea[e] + 1]++; }
    }
    for (let i = 0; i < N; i++) { outCnt[i + 1] += outCnt[i]; inCnt[i + 1] += inCnt[i]; }
    this.outStart = outCnt; this.inStart = inCnt;
    this.outArcs = new Int32Array(outCnt[N]); this.inArcs = new Int32Array(inCnt[N]);
    const po = outCnt.slice(0, N), pi = inCnt.slice(0, N);
    for (let e = 0; e < E; e++) {
      if (this.esf[e]) { this.outArcs[po[this.ea[e]]++] = e * 2; this.inArcs[pi[this.eb[e]]++] = e * 2; }
      if (this.esb[e]) { this.outArcs[po[this.eb[e]]++] = e * 2 + 1; this.inArcs[pi[this.ea[e]]++] = e * 2 + 1; }
    }
  }

  _cell(lat, lon) {
    const cy = Math.floor((lat - LAT0) * CELLS_PER_DEG), cx = Math.floor((lon - LON0) * CELLS_PER_DEG);
    return [cy, cx];
  }

  _buildGrid() {
    // index every shape point (edge endpoints + interior) by grid cell
    const cells = GRID_W * 400;
    const cnt = new Int32Array(cells + 1);
    const key = (lat, lon) => { const [cy, cx] = this._cell(lat, lon); return (cy < 0 || cx < 0 || cx >= GRID_W || cy >= 400) ? -1 : cy * GRID_W + cx; };
    const each = fn => {
      for (let e = 0; e < this.E; e++) {
        const a = this.ea[e], b = this.eb[e];
        fn(key(this.xy[a * 2] / 1e6, this.xy[a * 2 + 1] / 1e6), e, 0);
        const g = this.egs[e], c = this.egc[e];
        for (let i = 0; i < c; i++) fn(key(this.geom[(g + i) * 2] / 1e6, this.geom[(g + i) * 2 + 1] / 1e6), e, i + 1);
        fn(key(this.xy[b * 2] / 1e6, this.xy[b * 2 + 1] / 1e6), e, c + 1);
      }
    };
    each(k => { if (k >= 0) cnt[k + 1]++; });
    for (let i = 0; i < cells; i++) cnt[i + 1] += cnt[i];
    const pos = cnt.slice(0, cells);
    this.gridStart = cnt; this.gridE = new Int32Array(cnt[cells]); this.gridI = new Int32Array(cnt[cells]);
    each((k, e, i) => { if (k >= 0) { const p = pos[k]++; this.gridE[p] = e; this.gridI[p] = i; } });
  }

  edgePoint(e, i) { // [lat, lon] of the i-th shape point of edge e (a -> b)
    if (i === 0) return [this.xy[this.ea[e] * 2] / 1e6, this.xy[this.ea[e] * 2 + 1] / 1e6];
    if (i === this.egc[e] + 1) return [this.xy[this.eb[e] * 2] / 1e6, this.xy[this.eb[e] * 2 + 1] / 1e6];
    const g = this.egs[e] + i - 1;
    return [this.geom[g * 2] / 1e6, this.geom[g * 2 + 1] / 1e6];
  }

  edgePoints(e) { const out = []; for (let i = 0; i < this.egc[e] + 2; i++) out.push(this.edgePoint(e, i)); return out; }

  static dist(p, q) { return Math.hypot((q[0] - p[0]) * 111195, (q[1] - p[1]) * 111195 * Math.cos(p[0] * Math.PI / 180)); }

  // Nearest rideable shape point to (lat, lon). Returns a snap descriptor, or null.
  snap(lat, lon) {
    const [cy, cx] = this._cell(lat, lon);
    let best = null, bd = Infinity;
    for (let r = 0; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const y = cy + dy, x = cx + dx;
        if (y < 0 || x < 0 || x >= GRID_W || y >= 400) continue;
        const k = y * GRID_W + x;
        for (let p = this.gridStart[k]; p < this.gridStart[k + 1]; p++) {
          const pt = this.edgePoint(this.gridE[p], this.gridI[p]);
          const d = Router.dist([lat, lon], pt);
          if (d < bd) { bd = d; best = { e: this.gridE[p], i: this.gridI[p], pt }; }
        }
      }
      if (best && bd < r * 200) break; // ring r fully covers radius ~r*200 m
    }
    if (!best) return null;
    const pts = this.edgePoints(best.e);
    let offA = 0;
    for (let i = 1; i <= best.i; i++) offA += Router.dist(pts[i - 1], pts[i]);
    let total = offA;
    for (let i = best.i + 1; i < pts.length; i++) total += Router.dist(pts[i - 1], pts[i]);
    const scale = total > 0 ? this.elen[best.e] / total : 1; // normalise to the stored edge length
    best.offA = offA * scale; best.offB = (total - offA) * scale; best.gap = bd; best.query = [lat, lon];
    return best;
  }

  _arcCost(arc) { // [searchCost, realMinutes, meters]
    const e = arc >> 1, spd = this.arcSpeed(arc), m = this.elen[e];
    const t = m / 1000 / spd * 60;
    return [t * this.epen[e], t, m];
  }

  // Dijkstra from a snap point. reverse=true walks arcs backwards (gives "node -> source" costs).
  _search(src, reverse, maxCost, stopNodes) {
    const { cost, time, meters, prev } = this;
    cost.fill(Infinity); prev.fill(-1);
    const heap = new MinHeap();
    const offT = src.gap / 1000 / OFF_ROAD_KMH * 60;
    const seed = (node, off) => {
      const t = off / 1000 / 14 * 60 + offT; // along-edge offset ridden at ~14 km/h
      if (t < cost[node]) { cost[node] = t; time[node] = t; meters[node] = off + src.gap; heap.push(t, node); }
    };
    seed(this.ea[src.e], src.offA); seed(this.eb[src.e], src.offB);
    let remaining = stopNodes ? new Set(stopNodes) : null;
    while (heap.n) {
      const u = heap.pop(), d = heap.lastKey;
      if (d > cost[u]) continue;
      if (d > maxCost) break;
      if (remaining && remaining.delete(u) && remaining.size === 0) break;
      const start = reverse ? this.inStart[u] : this.outStart[u], end = reverse ? this.inStart[u + 1] : this.outStart[u + 1];
      const arcs = reverse ? this.inArcs : this.outArcs;
      for (let p = start; p < end; p++) {
        const arc = arcs[p], v = reverse ? this.arcFrom(arc) : this.arcTo(arc);
        const [c, t, m] = this._arcCost(arc);
        if (d + c < cost[v]) { cost[v] = d + c; time[v] = time[u] + t; meters[v] = meters[u] + m; prev[v] = arc; heap.push(d + c, v); }
      }
    }
  }

  // Candidate (minutes, meters) to reach/leave snap point `t` given the last search; direct same-edge shortcut included.
  _finish(src, t) {
    const off = t.gap / 1000 / OFF_ROAD_KMH * 60;
    let best = null;
    const tryNode = (node, o) => {
      if (this.cost[node] === Infinity) return;
      const tm = this.time[node] + o / 1000 / 14 * 60 + off, c = this.cost[node] + o / 1000 / 14 * 60 + off;
      if (!best || c < best.cost) best = { cost: c, min: tm, m: this.meters[node] + o + t.gap, node };
    };
    tryNode(this.ea[t.e], t.offA); tryNode(this.eb[t.e], t.offB);
    if (src.e === t.e) {
      const o = Math.abs(src.offA - t.offA);
      const tm = o / 1000 / 14 * 60 + src.gap / 1000 / OFF_ROAD_KMH * 60 + off;
      if (!best || tm < best.cost) best = { cost: tm, min: tm, m: o + src.gap + t.gap, node: -1 };
    }
    return best;
  }

  // One search -> many targets. reverse=true gives targets -> src ("how long from each target to src").
  oneToMany(src, targets, reverse = false, maxMin = 90) {
    const stop = targets.flatMap(t => t ? [this.ea[t.e], this.eb[t.e]] : []);
    this._search(src, reverse, maxMin * 1.6, stop);
    return targets.map(t => {
      const r = t && this._finish(src, t);
      return r && r.min <= maxMin ? { min: r.min, km: r.m / 1000 } : null;
    });
  }

  // Full route with geometry from snap a to snap b.
  route(a, b) {
    this._search(a, false, Infinity, [this.ea[b.e], this.eb[b.e]]);
    const r = this._finish(a, b);
    if (!r) return null;
    if (r.node === -1) { // same edge, direct
      const pts = this.edgePoints(a.e);
      const [lo, hi] = a.offA <= b.offA ? [a, b] : [b, a];
      const mid = pts.filter((_, i) => i > lo.i && i <= hi.i);
      return { min: r.min, km: r.m / 1000, coords: [a.query, a.pt, ...(a.offA <= b.offA ? mid : mid.reverse()), b.pt, b.query] };
    }
    const arcs = [];
    for (let n = r.node; this.prev[n] !== -1; n = this.arcFrom(this.prev[n])) arcs.push(this.prev[n]);
    arcs.reverse();
    const coords = [a.query, a.pt];
    const startNode = arcs.length ? this.arcFrom(arcs[0]) : r.node;
    // lead-in along the source edge
    const sp = this.edgePoints(a.e);
    if (startNode === this.ea[a.e]) coords.push(...sp.slice(0, a.i + 1).reverse());
    else coords.push(...sp.slice(a.i));
    for (const arc of arcs) {
      const pts = this.edgePoints(arc >> 1);
      coords.push(...((arc & 1) ? pts.slice().reverse() : pts).slice(1));
    }
    // lead-out along the target edge
    const tp = this.edgePoints(b.e);
    if (r.node === this.ea[b.e]) coords.push(...tp.slice(0, b.i + 1).slice(1));
    else coords.push(...tp.slice(b.i, tp.length).reverse().slice(1));
    coords.push(b.pt, b.query);
    return { min: r.min, km: r.m / 1000, coords };
  }
}
