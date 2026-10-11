"""Station exits (Exit A, B, C ...) from OpenStreetMap -> frontend/data/entrances.json, each assigned to its station.
Source: railway=subway_entrance nodes. The label comes from the name ("Orchard (NSL) Exit C") or the ref tag."""
import json, math, re, collections
import osmium

stations = json.load(open("data/stations.json"))
MAX_M = 500  # an exit belongs to the nearest station if it is within this distance


def dist(a, b):
    return math.hypot((a[0] - b[0]) * 111195, (a[1] - b[1]) * 111195 * math.cos(math.radians(a[0])))


raw = []
for o in osmium.FileProcessor("data/Singapore.osm.pbf").with_locations():
    if not (o.is_node() and o.tags.get("railway") == "subway_entrance"):
        continue
    t = o.tags
    if t.get("construction") or t.get("disused") or t.get("access") in ("no", "private"):
        continue
    name, ref = t.get("name") or "", (t.get("ref") or "").strip()
    m = re.search(r"Exit\s*([A-Za-z0-9]+)", name, re.I)
    label = (m.group(1) if m else ref).upper()
    if not re.fullmatch(r"[A-Z]\d?|\d{1,2}", label):
        continue
    line = re.search(r"\(([A-Za-z/ ]+)\)", name)
    raw.append({"label": label, "line": line.group(1) if line else "", "lat": o.location.lat, "lon": o.location.lon,
                "wheelchair": t.get("wheelchair") in ("yes", "limited")})

by_station = collections.defaultdict(list)
orphans = 0
for e in raw:
    best = min(stations, key=lambda s: dist((s["lat"], s["lon"]), (e["lat"], e["lon"])))
    if dist((best["lat"], best["lon"]), (e["lat"], e["lon"])) > MAX_M:
        orphans += 1
        continue
    by_station[best["id"]].append(e)

out = []
for sid, ents in by_station.items():
    seen = {}
    for e in sorted(ents, key=lambda x: x["label"]):
        k = (e["label"], e["line"])
        if k in seen and dist((seen[k]["lat"], seen[k]["lon"]), (e["lat"], e["lon"])) < 25:
            continue  # the same exit mapped twice
        seen[k] = e
    labels = collections.Counter(e["label"] for e in seen.values())
    for e in seen.values():
        # the same letter can exist for two lines in a big interchange (e.g. Exit A of the NSL and of the CCL)
        text = e["label"] + (f" ({e['line']})" if labels[e["label"]] > 1 and e["line"] else "")
        out.append({"s": sid, "label": text, "lat": round(e["lat"], 6), "lon": round(e["lon"], 6), "wc": e["wheelchair"]})

json.dump(out, open("frontend/data/entrances.json", "w"), separators=(",", ":"))
covered = {e["s"] for e in out}
print(len(raw), "exits read,", len(out), "kept,", orphans, "too far from any station;", len(covered), "of", len(stations), "stations have exits")
missing = [s["name"] for s in stations if s["id"] not in covered]
print("stations without exit data:", len(missing), missing[:25])
