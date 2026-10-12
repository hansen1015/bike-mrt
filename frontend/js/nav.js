// Navigation logic (no page code): turn-by-turn directions for a cycling leg, following a GPS position along it,
// and the step cards for a train ride. Works in the browser and in Node (tests/nav.test.mjs).

const M = 111195; // metres per degree of latitude
const rad = d => d * Math.PI / 180;
export const dist = (a, b) => Math.hypot((b[0] - a[0]) * M, (b[1] - a[1]) * M * Math.cos(rad((a[0] + b[0]) / 2)));
export const bearing = (a, b) => (Math.atan2((b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2)), b[0] - a[0]) * 180 / Math.PI + 360) % 360;
const turnOf = (inB, outB) => { let d = outB - inB; while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }; // + = right
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = b => COMPASS[Math.round(b / 45) % 8];

export const ICON = { start: '🚲', arrive: '🏁', left: '←', right: '→', 'slight-left': '↖', 'slight-right': '↗', 'sharp-left': '↙', 'sharp-right': '↘', straight: '↑', uturn: '↩' };

export function fmtDist(m) {
  if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km';
  if (m >= 100) return Math.round(m / 10) * 10 + ' m';
  return Math.max(5, Math.round(m / 5) * 5) + ' m';
}

const KIND_PHRASE = { 1: 'the cycle path', 2: 'the footpath', 3: 'the service road' };
const onto = (name, kind) => (name ? ' onto ' + name : KIND_PHRASE[kind] ? ' onto ' + KIND_PHRASE[kind] : '');

function classify(turn) {
  const a = Math.abs(turn), side = turn > 0 ? 'right' : 'left';
  if (a < 22) return 'straight';
  if (a < 55) return 'slight-' + side;
  if (a < 125) return side;
  if (a < 160) return 'sharp-' + side;
  return 'uturn';
}

const TEXT = {
  left: 'Turn left', right: 'Turn right', 'slight-left': 'Bear left', 'slight-right': 'Bear right',
  'sharp-left': 'Make a sharp left', 'sharp-right': 'Make a sharp right', straight: 'Continue', uturn: 'Make a U-turn',
};

// ===================== cycling leg: directions =====================
// segs: [{ name, kind, coords }] from the router (a seg's first point repeats the previous seg's last point).
// Returns { pts, cum, total, ins } where ins = [{ type, text, name, along, turn }] sorted by distance along the route.
export function buildGuidance(segs, { arrive = 'You have arrived' } = {}) {
  const pts = [], starts = [];
  const addPt = c => { const l = pts[pts.length - 1]; if (l && dist(l, c) < 0.5) return pts.length - 1; pts.push(c); return pts.length - 1; };
  segs.forEach(sg => sg.coords.forEach((c, j) => { const i = addPt(c); if (j === 0) starts.push(i); }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1] || 0;
  const last = pts.length - 1;

  // bearing of the route just before / after point j, measured over about 12 m so tiny bends do not matter
  const back = j => { let i = j - 1; while (i > 0 && cum[j] - cum[i] < 12) i--; return i; };
  const fwd = j => { let i = j + 1; while (i < last && cum[i] - cum[j] < 12) i++; return i; };

  const cand = [];
  for (let k = 1; k < segs.length; k++) {
    const j = starts[k];
    if (j <= 0 || j >= last) continue;
    const i0 = back(j), i1 = fwd(j);
    if (i0 === j || i1 === j) continue;
    const inB = bearing(pts[i0], pts[j]), outB = bearing(pts[j], pts[i1]);
    cand.push({ j, along: cum[j], inB, outB, turn: turnOf(inB, outB), name: segs[k].name, kind: segs[k].kind, prevName: segs[k - 1].name, prevKind: segs[k - 1].kind });
  }
  // Junctions close together (roundabouts, zig-zags, short links, a bend drawn with many points) become one manoeuvre: gaps under
  // 30 m, spanning at most 80 m. Its turn is the net change of heading from before the first junction to after the last one.
  const merged = [];
  for (const c of cand) {
    const m = merged[merged.length - 1];
    if (m && c.along - m.lastAlong < 30 && c.along - m.along < 80) { m.outB = c.outB; m.turn = turnOf(m.inB, c.outB); m.name = c.name; m.kind = c.kind; m.lastAlong = c.along; }
    else merged.push({ ...c, lastAlong: c.along });
  }

  const ins = [];
  const firstSeg = segs[0] || {};
  const j1 = Math.min(last, fwd(0));
  const head = last > 0 ? compass(bearing(pts[0], pts[j1])) : 'ahead';
  ins.push({ type: 'start', along: 0, turn: 0, name: firstSeg.name || '', text: `Head ${head}${firstSeg.name ? ' on ' + firstSeg.name : firstSeg.kind && KIND_PHRASE[firstSeg.kind] ? ' on ' + KIND_PHRASE[firstSeg.kind] : ''}` });
  for (const m of merged) {
    const type = classify(m.turn), a = Math.abs(m.turn);
    if (type === 'straight') {
      const renamed = m.name && m.prevName && m.name !== m.prevName;
      const newKind = !m.name && !m.prevName && m.kind !== m.prevKind;
      if (!(renamed || newKind)) continue;           // nothing to say
      ins.push({ type, along: m.along, turn: m.turn, name: m.name, text: 'Continue' + onto(m.name, m.kind) });
      continue;
    }
    if (!m.name && !m.prevName && a < 45) continue;    // wiggles on unnamed paths
    ins.push({ type, along: m.along, turn: m.turn, name: m.name, text: TEXT[type] + (type === 'uturn' ? '' : onto(m.name, m.kind)) });
  }
  ins.push({ type: 'arrive', along: total, turn: 0, name: '', text: arrive });
  return { pts, cum, total, ins };
}

// ===================== following a GPS position along a leg =====================
// Where is (lat, lon) on the route? Returns { along, cross, idx }: metres travelled along the route, distance from it,
// and the nearest route segment. `hint` (previous `along`) stops a route that doubles back from jumping you ahead.
export function locate(g, lat, lon, hint = 0) {
  const { pts, cum } = g;
  if (pts.length < 2) return { along: 0, cross: pts.length ? dist(pts[0], [lat, lon]) : Infinity, idx: 0 };
  const k = Math.cos(rad(lat));
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const ax = (b[1] - a[1]) * k * M, ay = (b[0] - a[0]) * M, px = (lon - a[1]) * k * M, py = (lat - a[0]) * M;
    const len2 = ax * ax + ay * ay;
    const t = len2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / len2)) : 0;
    const d = Math.hypot(px - t * ax, py - t * ay), along = cum[i] + t * Math.sqrt(len2);
    const score = d + (along < hint - 40 ? 60 : 0);   // prefer places we have not passed yet
    if (!best || score < best.score) best = { score, along, cross: d, idx: i };
  }
  return best;
}

export const nextInstruction = (g, along) => g.ins.find(i => i.along > along + 3) || g.ins[g.ins.length - 1];

// ===================== train ride: step cards =====================
// Which way the train goes, as a terminus name, for lines whose two ends are fixed; null = say "towards <next stop>" instead.
const ENDS = {
  NS: { up: 'Marina South Pier', down: 'Jurong East' }, EW: { up: 'Tuas Link', down: 'Pasir Ris' }, NE: { up: 'Punggol Coast', down: 'HarbourFront' },
  DT: { up: 'Sungei Bedok', down: 'Bukit Panjang' }, TE: { up: 'Sungei Bedok', down: 'Woodlands North' },
};
const codeNum = (st, line) => { const c = st && st.codes.find(c => c.startsWith(line) && /\d/.test(c)); return c ? +c.replace(/\D+/, '') : null; };

export function trainDirection(seg, stationByName) {
  const [a, b] = [seg.stop_names[0], seg.stop_names[1]];
  if (seg.line === 'CG') return seg.stop_names.includes('Changi Airport') && seg.to === 'Changi Airport' ? 'Changi Airport' : 'Tanah Merah';
  const ends = ENDS[seg.line];
  const na = codeNum(stationByName.get(a), seg.line), nb = codeNum(stationByName.get(b), seg.line);
  if (ends && na != null && nb != null) return nb > na ? ends.up : ends.down;
  return null;
}

// leg: a rail leg from the planner { segments, enter, exit, min }. ctx: { stationByName, lineName(code), fare, moneyText, nextIsBike }.
// Returns cards: [{ kind, title, lines: [text], chips: [text], line, stops }]
export function railCards(leg, ctx) {
  const cards = [], segs = leg.segments, first = segs[0], last = segs[segs.length - 1];
  const towards = sg => { const d = trainDirection(sg, ctx.stationByName); return d ? `towards ${d}` : `towards ${sg.stop_names[1]}`; };
  cards.push({
    kind: 'enter', line: first.line, title: `Go into ${first.from}`,
    lines: [leg.enter ? `Use Exit ${leg.enter.label}` : 'Use the exit nearest to you', 'Fold your bike and take it through the gates with you.'].concat(ctx.moneyText ? [`Fare for this ride about ${ctx.moneyText}`] : []),
    chips: leg.enter ? [`Exit ${leg.enter.label}`] : [], stops: [],
  });
  segs.forEach((sg, i) => {
    if (i > 0) {
      const prev = segs[i - 1];
      cards.push({
        kind: 'change', line: sg.line, title: `Change at ${sg.from}`,
        lines: [`${ctx.lineName(prev.line)} → ${ctx.lineName(sg.line)}`, `Follow the signs for the ${ctx.lineName(sg.line)} ${towards(sg)}.`],
        chips: [`about ${Math.max(1, Math.round(sg.change_min))} min, including the wait`], stops: [],
      });
    }
    cards.push({
      kind: 'board', line: sg.line, title: `Take the ${ctx.lineName(sg.line)} ${towards(sg)}`,
      lines: [`Ride ${sg.stops} ${sg.stops === 1 ? 'stop' : 'stops'} and get off at ${sg.to}.`],
      chips: [`${sg.stops} ${sg.stops === 1 ? 'stop' : 'stops'}`, `about ${Math.max(1, Math.round(sg.min))} min`], stops: sg.stop_names,
    });
  });
  cards.push({
    kind: 'leave', line: last.line, title: `Get off at ${last.to}`,
    lines: [leg.exit ? `Leave by Exit ${leg.exit.label}` : 'Follow the exit signs', ctx.nextIsBike ? 'Unfold your bike outside, then carry on cycling.' : 'You have arrived.'],
    chips: leg.exit ? [`Exit ${leg.exit.label}`] : [], stops: [],
  });
  return cards;
}

// what to say aloud for an upcoming manoeuvre
export const spoken = (ins, d) => (ins.type === 'arrive' ? ins.text : d < 40 ? ins.text : `In ${fmtDist(d)}, ${ins.text.charAt(0).toLowerCase()}${ins.text.slice(1)}`);
