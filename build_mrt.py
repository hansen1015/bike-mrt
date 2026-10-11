"""Build data/stations.json and data/mrt_edges.json from OSM-derived data/stations_raw.json.
MRT (NS, EW, CG, NE, CC, DT, TE) and LRT (BP, SE, SW, PE, PW). Future lines and unopened stations are excluded."""
import json, re, math, collections

MRT_LINES = {"NS", "EW", "CG", "NE", "CC", "DT", "TE"}
LRT_LINES = {"BP", "SE", "SW", "PE", "PW"}
LINES = MRT_LINES | LRT_LINES
HUB = {"SE": "NE16", "SW": "NE16", "PE": "NE17", "PW": "NE17"}  # Sengkang / Punggol: LRT loops start and end here
EXCLUDE = {"TE22A"}  # Founders' Memorial: not yet open
# per family: in-train speed km/h, per-stop dwell min, track/straight-line ratio (LRT loops wind a lot)
PROFILE = {"MRT": (55.0, 0.5, 1.1), "LRT": (28.0, 0.5, 1.35)}

raw = json.load(open("data/stations_raw.json"))
groups = collections.defaultdict(lambda: {"codes": set(), "pts": []})
for e in raw:
    codes = []
    for c in (e["ref"] or "").split(";"):
        m = re.fullmatch(r"([A-Z]{2})(\d+)", c.strip())
        if m and m.group(1) in LINES and c.strip() not in EXCLUDE:
            codes.append(c.strip())
    if not codes or not e["name"]:
        continue
    g = groups[e["name"]]
    g["codes"].update(codes)
    g["pts"].append((e["lat"], e["lon"]))

stations = []
for name, g in sorted(groups.items()):
    lat = sum(p[0] for p in g["pts"]) / len(g["pts"])
    lon = sum(p[1] for p in g["pts"]) / len(g["pts"])
    stations.append({"id": len(stations), "name": name, "codes": sorted(g["codes"]), "lat": lat, "lon": lon})
by_code = {c: s for s in stations for c in s["codes"]}


def km(a, b):
    p = math.pi / 180
    x = (b["lon"] - a["lon"]) * p * math.cos((a["lat"] + b["lat"]) / 2 * p)
    y = (b["lat"] - a["lat"]) * p
    return 6371 * math.hypot(x, y)


# consecutive codes per line; CG is a branch off EW4, CC is a loop closed by CC34-CC4
pairs = []
for line in sorted(LINES - {"CG"} - (LRT_LINES - {"BP"})):
    nums = sorted(int(c[2:]) for c in by_code if c.startswith(line))
    for a, b in zip(nums, nums[1:]):
        pairs.append((line, f"{line}{a}", f"{line}{b}"))
pairs += [("CG", "EW4", "CG1"), ("CG", "CG1", "CG2"), ("CC", "CC34", "CC4")]
# LRT: Bukit Panjang is a loop off BP6; Sengkang/Punggol loops run hub -> X1 .. Xn -> hub
pairs.append(("BP", "BP13", "BP6"))
for line in sorted(LRT_LINES - {"BP"}):
    nums = sorted(int(c[2:]) for c in by_code if c.startswith(line))
    chain = [HUB[line]] + [f"{line}{n}" for n in nums] + [HUB[line]]
    pairs += [(line, a, b) for a, b in zip(chain, chain[1:])]
pairs = list(dict.fromkeys(pairs))

edges = []
for line, a, b in pairs:
    sa, sb = by_code[a], by_code[b]
    d = km(sa, sb)
    kmh, dwell, detour = PROFILE["LRT" if line in LRT_LINES else "MRT"]
    edges.append({"line": line, "a": sa["id"], "b": sb["id"], "km": round(d, 3),
                  "min": round(d * detour / kmh * 60 + dwell, 2)})

json.dump(stations, open("data/stations.json", "w"), indent=1)
json.dump(edges, open("data/mrt_edges.json", "w"), indent=1)
print(len(stations), "stations,", len(edges), "edges")
for line in sorted(LINES):
    nums = sorted(int(c[2:]) for c in by_code if c.startswith(line))
    gaps = [n for n in range(nums[0], nums[-1] + 1) if n not in nums]
    print(line, nums[0], "-", nums[-1], "count", len(nums), "missing", gaps)
print("longest hops:", sorted(((e["km"], stations[e["a"]]["name"], stations[e["b"]]["name"]) for e in edges), reverse=True)[:6])
