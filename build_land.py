"""Build frontend/data/sg_land.json: Singapore's land outline (main island + islands) from OSM coastline ways.
The app uses it to restrict the map view and to accept pins/GPS only on Singapore soil.
Coastline ways are chained into rings; only rings that close inside the extract and sit within Singapore's
rough extent are kept (the neighbours' coasts are clipped by the extract, so they stay open and are dropped)."""
import json, math, collections
import osmium

SG = (1.13, 1.48, 103.55, 104.12)  # lat_min, lat_max, lon_min, lon_max sanity box
TOL = 0.00015                      # ~17 m simplification tolerance (degrees)

ways = []
for o in osmium.FileProcessor("data/Singapore.osm.pbf").with_locations():
    if o.is_way() and o.tags.get("natural") == "coastline":
        ways.append([(n.ref, n.lat, n.lon) for n in o.nodes])
print(len(ways), "coastline ways")

# chain ways end-to-start. Open chains are started first (from ways nobody continues), then closed loops.
by_start = collections.defaultdict(list)
for i, w in enumerate(ways):
    by_start[w[0][0]].append(i)
way_ends = {w[-1][0] for w in ways}
used, chains = set(), []


def follow(i):
    used.add(i)
    chain = list(ways[i])
    while chain[-1][0] != chain[0][0]:
        nxt = next((j for j in by_start.get(chain[-1][0], []) if j not in used), None)
        if nxt is None:
            break
        used.add(nxt)
        chain += ways[nxt][1:]
    return chain


for i, w in enumerate(ways):
    if i not in used and w[0][0] not in way_ends:
        chains.append(follow(i))
for i in range(len(ways)):
    if i not in used:
        chains.append(follow(i))


def gap_km(c):
    return math.hypot((c[-1][1] - c[0][1]) * 111.0, (c[-1][2] - c[0][2]) * 111.0 * math.cos(math.radians(1.35)))


# a chain whose ends nearly meet is a land ring with a small hole in the data (e.g. the main island); Johor's coast
# is clipped by the extract so its ends are far apart and it is dropped
rings = []
for c in chains:
    if len(c) > 3 and gap_km(c) < 2.0:
        rings.append([(la, lo) for _, la, lo in c])
    else:
        print(f"dropped open chain: {len(c)} pts, ends {gap_km(c):.1f} km apart")


def dp(pts, tol):  # Douglas-Peucker
    if len(pts) < 3:
        return pts
    (y1, x1), (y2, x2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1e-12
    idx, dmax = 0, 0.0
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][1] - x1) - dx * (pts[i][0] - y1)) / L
        if d > dmax:
            idx, dmax = i, d
    if dmax > tol:
        return dp(pts[:idx + 1], tol)[:-1] + dp(pts[idx:], tol)
    return [pts[0], pts[-1]]


def area_km2(r):
    a = sum(r[i][1] * r[(i + 1) % len(r)][0] - r[(i + 1) % len(r)][1] * r[i][0] for i in range(len(r))) / 2
    return abs(a) * 111.0 * 111.0 * math.cos(math.radians(1.35))


kept = []
for r in rings:
    la = sum(p[0] for p in r) / len(r); lo = sum(p[1] for p in r) / len(r)
    inside = SG[0] <= la <= SG[1] and SG[2] <= lo <= SG[3] and la < 1.470 and lo > 103.62  # drops Johor islets north/west of the strait
    print(f"ring: {len(r):6d} pts, {area_km2(r):8.3f} km2, centre {la:.3f},{lo:.3f} {'KEEP' if inside else 'drop'}")
    if inside and area_km2(r) > 0.01:
        if r[0] == r[-1]:
            r = r[:-1]
        far = max(range(len(r)), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)  # split so DP sees a real chord
        s = dp(r[:far + 1], TOL)[:-1] + dp(r[far:] + [r[0]], TOL)[:-1]
        kept.append([[round(p[0], 5), round(p[1], 5)] for p in s])
json.dump(kept, open("frontend/data/sg_land.json", "w"), separators=(",", ":"))
print(len(kept), "rings kept,", sum(len(r) for r in kept), "points")
