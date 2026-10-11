"""Snap every MRT edge onto real OSM track geometry using each line's own route relations.
Output: data/mrt_shapes.json (list aligned with data/mrt_edges.json). Straight-line fallback if no track path."""
import json, math, heapq, collections
import osmium

stations = json.load(open("data/stations.json"))
edges = json.load(open("data/mrt_edges.json"))
REF2LINE = {"CCL": "CC", "DTL": "DT", "EWL": "EW", "NEL": "NE", "NSL": "NS", "TEL": "TE"}

# pass 1: which ways belong to which line
way_line = collections.defaultdict(set)
LRT_REF = {"BPLRT": ("BP", "BP"), "SKLRT": ("SE", "SW"), "PGLRT": ("PE", "PW")}  # (east/first, west/second)
for o in osmium.FileProcessor("data/Singapore.osm.pbf"):
    if o.is_relation() and o.tags.get("ref") in LRT_REF and o.tags.get("route") in ("monorail", "light_rail"):
        first, second = LRT_REF[o.tags["ref"]]
        line = first if ("East" in o.tags.get("name", "") or first == second) else second
        for m in o.members:
            if m.type == "w":
                way_line[m.ref].add(line)
    if o.is_relation() and o.tags.get("route") == "subway" and o.tags.get("ref") in REF2LINE:
        line = REF2LINE[o.tags["ref"]]
        if line == "EW" and "Changi Airport" in o.tags.get("name", ""):
            line = "CG"
        for m in o.members:
            if m.type == "w":
                way_line[m.ref].add(line)

# pass 2: per-line track graphs
adj = collections.defaultdict(lambda: collections.defaultdict(list))
pos = {}


def km(p, q):
    return math.hypot((q[0] - p[0]) * 111.0, (q[1] - p[1]) * 111.0 * math.cos(math.radians(p[0])))


for o in osmium.FileProcessor("data/Singapore.osm.pbf").with_locations():
    if not o.is_way() or o.id not in way_line:
        continue
    ns = [(n.ref, (n.lat, n.lon)) for n in o.nodes]
    for line in way_line[o.id]:
        for (a, pa), (b, pb) in zip(ns, ns[1:]):
            pos[a], pos[b] = pa, pb
            d = km(pa, pb)
            adj[line][a].append((b, d))
            adj[line][b].append((a, d))
print({l: len(g) for l, g in adj.items()}, "track nodes per line")

# global fallback graphs: every non-construction way of that family (yard track costs extra), small gaps bridged
def build_global(kinds):
    G = collections.defaultdict(list)
    for o in osmium.FileProcessor("data/Singapore.osm.pbf").with_locations():
        if not o.is_way() or o.tags.get("railway") not in kinds or o.tags.get("construction"):
            continue
        ns = [(n.ref, (n.lat, n.lon)) for n in o.nodes]
        mult = {"yard": 4.0, "siding": 3.0, "crossover": 1.5}.get(o.tags.get("service"), 1.0)
        for (a, pa), (b, pb) in zip(ns, ns[1:]):
            pos[a], pos[b] = pa, pb
            G[a].append((b, km(pa, pb) * mult))
            G[b].append((a, km(pa, pb) * mult))
    grid = collections.defaultdict(list)
    for n in G:
        grid[(round(pos[n][0] * 1000), round(pos[n][1] * 1000))].append(n)  # ~110 m cells
    for (gx, gy), ns_ in grid.items():
        near = [m for dx in (-1, 0, 1) for dy in (-1, 0, 1) for m in grid.get((gx + dx, gy + dy), ())]
        for a in ns_:
            for b in near:
                if a < b and not any(v == b for v, _ in G[a]):
                    d = km(pos[a], pos[b])
                    if d < 0.06:
                        G[a].append((b, d * 3)); G[b].append((a, d * 3))
    return G


G_SUBWAY = build_global({"subway"})
G_LRT = build_global({"monorail", "light_rail"})
print(len(G_SUBWAY), "subway nodes,", len(G_LRT), "LRT nodes in global graphs")
LRT_CODES = {"BP", "SE", "SW", "PE", "PW"}


def snap(line, s, maxkm=0.4):
    pt = (s["lat"], s["lon"])
    best = min(adj[line], key=lambda n: km(pos[n], pt), default=None)
    return best if best is not None and km(pos[best], pt) <= maxkm else None


def dijkstra(g, src, dst, limit):
    dist, prev, pq = {src: 0.0}, {}, [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst:
            break
        if d > dist[u] or d > limit:
            continue
        for v, w in g[u]:
            if d + w < dist.get(v, 1e9):
                dist[v], prev[v] = d + w, u
                heapq.heappush(pq, (d + w, v))
    if src != dst and dst not in prev:
        return None
    path, n = [dst], dst
    while n != src:
        n = prev[n]
        path.append(n)
    return [pos[n] for n in reversed(path)]


shapes, bad = [], []
for e in edges:
    a, b = stations[e["a"]], stations[e["b"]]
    line = e["line"]
    path = None
    if line in adj:
        sa, sb = snap(line, a), snap(line, b)
        if sa is not None and sb is not None:
            path = dijkstra(adj[line], sa, sb, e["km"] * 2.0 + 0.5)
    if not path:
        G = G_LRT if line in LRT_CODES else G_SUBWAY
        ga = min(G, key=lambda n: km(pos[n], (a["lat"], a["lon"])))
        gb = min(G, key=lambda n: km(pos[n], (b["lat"], b["lon"])))
        if km(pos[ga], (a["lat"], a["lon"])) < 0.4 and km(pos[gb], (b["lat"], b["lon"])) < 0.4:
            path = dijkstra(G, ga, gb, e["km"] * (2.5 if line in LRT_CODES else 1.8) + 0.4)
    if path:
        pts = [[a["lat"], a["lon"]]] + [[round(p[0], 5), round(p[1], 5)] for p in path[::2]] + [[b["lat"], b["lon"]]]
    else:
        bad.append(f"{line} {a['name']}-{b['name']}")
        pts = [[a["lat"], a["lon"]], [b["lat"], b["lon"]]]
    shapes.append(pts)
json.dump(shapes, open("data/mrt_shapes.json", "w"))
print(len(shapes), "shapes;", len(bad), "straight-line fallbacks:", bad)
