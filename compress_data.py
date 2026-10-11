"""gzip the big graph files for publishing: frontend/data/bg_*.bin -> bg_*.bin.gz (the page decompresses them in the browser).
GitHub Pages does not compress .bin files by itself, so this cuts the first-load download by roughly 60%."""
import gzip, pathlib, shutil
for f in sorted(pathlib.Path("frontend/data").glob("bg_*.bin")):
    with open(f, "rb") as src, gzip.open(str(f) + ".gz", "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst)
    print(f.name, f.stat().st_size // 1024, "KB ->", pathlib.Path(str(f) + ".gz").stat().st_size // 1024, "KB")
