"""Export a compact trifold-bicycle-rideable road graph from the Singapore OSM extract for the on-device JS router.

Output (frontend/data/):
  bg_nodes.bin  Int32 [lat1e6, lon1e6] per node
  bg_edges.bin  per edge: Int32 a, b, geomStart, geomCount | Float32 lenM, penalty | Uint8 spdFwd, spdBwd, pad, pad
  bg_geom.bin   Int32 [lat1e6, lon1e6] interior shape points (a -> b order)
  bg_meta.json  counts
Graph is contracted (only junctions/endpoints are nodes). Speeds in km/h, 0 = direction not rideable.
"""
import json, math, struct, collections
import numpy as np
import osmium

OUT = "frontend/data/"
MAX_SPEED = 16  # trifold-bicycle speed cap (km/h)

ROAD = {  # highway -> (speed km/h, cost multiplier)
    "trunk": (14, 4.0), "trunk_link": (14, 4.0), "primary": (15, 1.6), "primary_link": (15, 1.6),
    "secondary": (16, 1.3), "secondary_link": (16, 1.3), "tertiary": (16, 1.1), "tertiary_link": (16, 1.1),
    "unclassified": (16, 1.0), "residential": (16, 1.0), "living_street": (14, 0.95), "road": (16, 1.2),
    "service": (14, 1.2), "track": (10, 1.5), "cycleway": (16, 0.85),
}
FOOTISH = {"footway", "pedestrian", "path", "bridleway"}


def classify(t):
    """-> (spd_fwd, spd_bwd, penalty) or None if not rideable."""
    hw = t.get("highway")
    if not hw or t.get("bicycle") in ("no", "dismount") or t.get("access") in ("no", "private") and t.get("bicycle") not in ("yes", "designated", "permissive"):
        return None
    if t.get("area") == "yes" or t.get("highway") == "steps":
        return None
    bike_ok = t.get("bicycle") in ("yes", "designated", "permissive")
    if hw in ROAD:
        spd, pen = ROAD[hw]
        if t.get("service") in ("parking_aisle", "driveway"):
            pen = 1.8
        if bike_ok and hw not in ("cycleway",):
            pen *= 0.9
    elif hw in FOOTISH:
        if bike_ok or t.get("segregated") == "yes":
            spd, pen = (14, 0.9)
        elif hw == "path":
            spd, pen = (10, 1.1)
        else:
            spd, pen = (5, 1.0)  # pushing the bike along a footpath
    else:
        return None
    spd = min(spd, MAX_SPEED)
    f = b = spd
    ow = t.get("oneway:bicycle") or t.get("oneway")
    if ow in ("yes", "true", "1") or (t.get("junction") in ("roundabout", "circular") and ow is None):
        b = 0
    elif ow == "-1":
        f = 0
    if t.get("oneway:bicycle") == "no" or str(t.get("cycleway", "")).startswith("opposite") \
            or any(str(t.get(k, "")).startswith("opposite") for k in ("cycleway:left", "cycleway:right", "cycleway:both")):
        f = b = spd
    return f, b, pen


coords, ways = {}, []
for o in osmium.FileProcessor("data/Singapore.osm.pbf").with_locations():
    if not o.is_way():
        continue
    c = classify(o.tags)
    if c is None:
        continue
    refs = [n.ref for n in o.nodes]
    if len(refs) < 2:
        continue
    for n in o.nodes:
        coords[n.ref] = (n.lat, n.lon)
    ways.append((refs, c))
print(len(ways), "rideable ways,", len(coords), "nodes")

use = collections.Counter()
for refs, _ in ways:
    for r in refs:
        use[r] += 1
    use[refs[0]] += 1
    use[refs[-1]] += 1


def hav(p, q):
    return math.hypot((q[0] - p[0]) * 111195.0, (q[1] - p[1]) * 111195.0 * math.cos(math.radians(p[0])))


edges = []  # (a_ref, b_ref, length, [interior (lat,lon)], spdF, spdB, pen)
for refs, (f, b, pen) in ways:
    start, length, interior = refs[0], 0.0, []
    for prev, cur in zip(refs, refs[1:]):
        length += hav(coords[prev], coords[cur])
        if use[cur] > 1 and cur != start or cur == refs[-1]:
            if cur != start or length > 20:
                edges.append((start, cur, length, interior, f, b, pen))
            start, length, interior = cur, 0.0, []
        else:
            interior.append(coords[cur])
print(len(edges), "edges before component filter")

# keep big connected components only (drops private islands / disconnected bits)
parent = {}


def find(x):
    while parent.setdefault(x, x) != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


for a, b, *_ in edges:
    parent[find(a)] = find(b)
size = collections.Counter(find(a) for a, b, *_ in edges for a in (a, b))
keep = {r for r, n in size.items() if n >= 400}
edges = [e for e in edges if find(e[0]) in keep]

node_ids, node_xy = {}, []
for a, b, *_ in edges:
    for r in (a, b):
        if r not in node_ids:
            node_ids[r] = len(node_ids)
            node_xy.append((round(coords[r][0] * 1e6), round(coords[r][1] * 1e6)))

geom, ebuf = [], bytearray()
for a, b, length, interior, f, bw, pen in edges:
    ebuf += struct.pack("<iiiiffBBBB", node_ids[a], node_ids[b], len(geom), len(interior), length, pen, f, bw, 0, 0)
    geom += [(round(la * 1e6), round(lo * 1e6)) for la, lo in interior]

np.array(node_xy, dtype="<i4").tofile(OUT + "bg_nodes.bin")
open(OUT + "bg_edges.bin", "wb").write(bytes(ebuf))
np.array(geom or [(0, 0)], dtype="<i4").tofile(OUT + "bg_geom.bin")
json.dump({"nodes": len(node_xy), "edges": len(edges), "geom": len(geom)}, open(OUT + "bg_meta.json", "w"))
print("nodes", len(node_xy), "edges", len(edges), "geom pts", len(geom))
