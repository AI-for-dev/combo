"""Vendors the two faces the site is set in, subset to what it uses.

The pages are served by GitHub Pages and by nobody else: no font CDN, so no third
party learns who reads this documentation, and no page waits on a host that may be
slow or gone. That means the files live in this repository, and this script is how
they get there - `scripts/fonts.json` says which faces, from which commit of
`google/fonts`, and with which characters kept.

Variable rather than instanced: one file per style, and every weight between 400
and 800 available to the stylesheet. Subset to the ranges in that config, which is
most of what a page of prose can contain and a fraction of what the originals
carry.

The coverage it writes is not a nicety. A character no face carries falls back to
whatever the reader happens to have, silently and only for them; `test/fonts.test.ts`
compares the prose of every page against `coverage.json` so that a page which needs
a glyph the subset dropped fails offline, in seconds.

    uv run --with fonttools --with brotli python scripts/subset-fonts.py

Both families are under the SIL Open Font License, which requires the licence to
travel with them: it is copied next to the fonts, and must stay there.
"""

from __future__ import annotations

import io
import json
import urllib.parse
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.varLib import instancer
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/_static/fonts"
CONFIG = json.loads((ROOT / "scripts/fonts.json").read_text())

RAW = "https://raw.githubusercontent.com/{repo}/{commit}/{path}"


def fetch(path: str) -> bytes:
    """One file from the pinned commit - never from `main`, which moves."""
    url = RAW.format(path=urllib.parse.quote(path), **CONFIG["source"])
    with urllib.request.urlopen(url) as response:
        return response.read()


def subset_face(raw: bytes, out: Path, pin: dict[str, float] | None) -> set[int]:
    """Writes the woff2 and returns the codepoints it ended up carrying."""
    font = TTFont(io.BytesIO(raw), lazy=False)
    # An axis nobody varies is deltas nobody reads: Inter's optical size is pinned
    # where the page sets it, and stops costing a third of the file.
    if pin:
        font = instancer.instantiateVariableFont(font, pin, inplace=True)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = CONFIG["features"]
    # Keep the variations: the whole point of shipping one file per style.
    options.drop_tables = [t for t in options.drop_tables if t not in ("STAT", "fvar", "gvar")]
    options.notdef_outline = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=parse_unicodes(CONFIG["unicodes"]))
    subsetter.subset(font)
    font.save(out)
    covered = {code for table in font["cmap"].tables for code in table.cmap}
    font.close()
    return covered


def parse_unicodes(ranges: list[str]) -> list[int]:
    """`U+2000-206F` and `U+00B7`, as the code points they name."""
    codes: list[int] = []
    for entry in ranges:
        first, _, last = entry.removeprefix("U+").partition("-")
        codes.extend(range(int(first, 16), int(last or first, 16) + 1))
    return codes


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    coverage: dict[str, list[int]] = {}

    for face in CONFIG["faces"]:
        covered = subset_face(fetch(face["path"]), OUT / face["file"], face.get("pin"))
        coverage[face["file"]] = sorted(covered)
        (OUT / f"OFL-{face['family'].lower().replace(' ', '-')}.txt").write_bytes(fetch(face["licence"]))
        print(f"{face['file']}: {(OUT / face['file']).stat().st_size // 1024} kB")

    # The intersection, not the union: a character only one face carries is still a
    # fallback in the other, and the page cannot say which face will be asked for it.
    common = set.intersection(*(set(codes) for codes in coverage.values()))
    (OUT / "coverage.json").write_text(
        json.dumps({"codepoints": sorted(common), "faces": sorted(coverage)}, indent="\t") + "\n"
    )
    print(f"coverage.json: {len(common)} code points in every face")


if __name__ == "__main__":
    main()
