"""Write every combo mark from one geometry.

    uv run python tools/make-marks.py

Asset generator: it is run by hand, `npm test` does not run it, and nothing the library ships
depends on Python. Edit the geometry here, never the path data in the SVG files.
"""

from __future__ import annotations

import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "docs" / "_static" / "logo"

INK_LIGHT, BRASS_LIGHT = "#232B33", "#A97C2A"
INK_DARK, BRASS_DARK = "#C9D3DB", "#C79338"
TILE_GROUND, TILE_INK = "#232B33", "#EEF1F3"

HEAD = (
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" '
	'role="img" aria-label="combo">\n  <title>combo</title>\n'
)

# Three bars and a bracket. Artwork extent 8,12 to 56,52 in the 64px box.
BARS = "\n".join(f'    <rect x="27" y="{y}" width="29" height="6" />' for y in (16, 29, 42))
BRACKET = "M8 12 H22 V18 H14 V46 H22 V52 H8 Z"

# At or below 32px: two bars, every stroke thicker. Extent 8,11 to 56,53.
SMALL_BARS = "\n".join(f'    <rect x="28" y="{y}" width="28" height="8" />' for y in (19, 36))
SMALL_BRACKET = "M8 11 H23 V18.5 H15.5 V45.5 H23 V53 H8 Z"

# The symmetric variant: two brackets, bars between them.
PAIR_BARS = "\n".join(f'    <rect x="26" y="{y}" width="12" height="6" />' for y in (16, 29, 42))
PAIR_BRACKETS = "M8 12 H22 V18 H14 V46 H22 V52 H8 Z M56 12 H42 V18 H50 V46 H42 V52 H56 Z"


def mark(comment: str, bars: str, bracket: str, ink: str, brass: str) -> str:
	return (
		HEAD
		+ f"  <!-- {comment} -->\n"
		+ f'  <g fill="{ink}">\n{bars}\n  </g>\n'
		+ f'  <path fill="{brass}" d="{bracket}" />\n'
		+ "</svg>\n"
	)


def write(name: str, body: str) -> None:
	(OUT / name).write_text(body, encoding="utf-8")
	print(f"docs/_static/logo/{name}")


def main() -> None:
	write(
		"combo-mark-light.svg",
		mark("The mark, light ground, above 32px.", BARS, BRACKET, INK_LIGHT, BRASS_LIGHT),
	)
	write(
		"combo-mark-dark.svg",
		mark("The mark, dark ground, above 32px.", BARS, BRACKET, INK_DARK, BRASS_DARK),
	)
	write(
		"combo-mark-small-light.svg",
		mark(
			"The mark at or below 32px, light ground.",
			SMALL_BARS,
			SMALL_BRACKET,
			INK_LIGHT,
			BRASS_LIGHT,
		),
	)
	write(
		"combo-mark-small-dark.svg",
		mark(
			"The mark at or below 32px, dark ground.",
			SMALL_BARS,
			SMALL_BRACKET,
			INK_DARK,
			BRASS_DARK,
		),
	)
	write(
		"combo-brackets-pair-light.svg",
		mark(
			"The symmetric variant, light ground. Not the mark.",
			PAIR_BARS,
			PAIR_BRACKETS,
			INK_LIGHT,
			BRASS_LIGHT,
		),
	)
	write(
		"combo-mark.svg",
		HEAD
		+ "  <!-- One tone, for inlining in a page: it follows the surrounding text colour. -->\n"
		+ f'  <g fill="currentColor">\n{BARS}\n    <path d="{BRACKET}" />\n  </g>\n'
		+ "</svg>\n",
	)
	write(
		"combo-tile.svg",
		HEAD
		+ "  <!-- Favicon, avatar, social image. Carries its own ground and the small geometry. -->\n"
		+ f'  <rect width="64" height="64" rx="13" fill="{TILE_GROUND}" />\n'
		+ '  <g transform="translate(32 32) scale(0.74) translate(-32 -32)">\n'
		+ f'    <g fill="{TILE_INK}">\n{SMALL_BARS.replace("    <", "      <")}\n    </g>\n'
		+ f'    <path fill="{BRASS_DARK}" d="{SMALL_BRACKET}" />\n'
		+ "  </g>\n</svg>\n",
	)


if __name__ == "__main__":
	main()
