"""Extract MRT + LRT station positions from the Singapore OSM extract -> data/stations_raw.json.
Any railway=station object carrying a code like NS1, EW24, BP6, SE3, PW2 ... is kept (areas/ways -> centroid)."""
import json, re, osmium

CODE = re.compile(r"(NS|EW|CG|NE|CC|DT|TE|BP|SE|SW|PE|PW)\d+")
out = []
for o in osmium.FileProcessor("data/Singapore.osm.pbf").with_locations().with_areas():
    t = o.tags
    if t.get("railway") != "station" or not any(CODE.fullmatch(c.strip()) for c in (t.get("ref") or "").split(";")):
        continue
    if o.is_node():
        lat, lon = o.location.lat, o.location.lon
    elif o.is_area():
        pts = [(n.lat, n.lon) for r in o.outer_rings() for n in r]
        lat, lon = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    elif o.is_way():
        pts = [(n.lat, n.lon) for n in o.nodes]
        lat, lon = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    else:
        continue
    out.append(dict(lat=lat, lon=lon, name=t.get("name"), ref=t.get("ref"), network=t.get("network")))
json.dump(out, open("data/stations_raw.json", "w"), indent=1)
print(len(out), "station objects")
