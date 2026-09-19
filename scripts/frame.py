"""Turns the log `drive-pi.py` keeps into a picture of the terminal.

`drive-pi.py` prints what pi painted with the escape sequences stripped, which
says what pi wrote and nothing about how it looked. Spacing, colour and density
are the half `NEXT.md` leaves to a human, and stripping is what throws them away.

The raw log keeps them. Replayed through a terminal emulator it is a screen
again, each cell with its colour and its column, and drawn in a monospaced face
it is a picture anyone can open:

    python3 scripts/drive-pi.py --log run.log "/run explore how usage is measured||6||150"
    python3 scripts/frame.py run.log run.png

What comes out is the **last** screen the log holds, the way a terminal would
show it: a repaint overwrites the cell under it rather than scrolling past. Give
`--size` the terminal `drive-pi.py` was given, or the frame is laid out at a
width nobody ran, and the judgement is about the wrong picture.

The first three pictures it drew found an option description cut mid-word at the
right edge, a fan-out reading `scout#2, scout#1, scout#3`, and `esc` claiming
two different things on screen at once. Stripped text shows none of the three.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# The two that are not in the standard library, asked for at the prompt rather
# than in a requirements file: this is a pre-flight run by hand, like drive-pi.py,
# and `npm test` must never come to depend on a python environment.
MISSING = "frame.py needs pyte and pillow: pip install pyte pillow"

# xterm-256color as a dark terminal shows it, which is what TERM says in drive-pi.py.
PALETTE = [
	"#000000", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
	"#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
]
NAMED = {
	"black": 0, "red": 1, "green": 2, "brown": 3, "blue": 4, "magenta": 5, "cyan": 6, "white": 7,
	"brightblack": 8, "brightred": 9, "brightgreen": 10, "brightyellow": 11,
	"brightblue": 12, "brightmagenta": 13, "brightcyan": 14, "brightwhite": 15,
}
FOREGROUND, BACKGROUND = "#d0d0d0", "#101014"

# The usual places a monospaced face lives, most specific first. `--font` wins.
FACES = [
	"/System/Library/Fonts/Menlo.ttc",
	"/System/Library/Fonts/SFNSMono.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
	"/usr/share/fonts/TTF/DejaVuSansMono.ttf",
	str(Path.home() / ".local/share/fonts/DejaVuSansMono.ttf"),
]


def face(given: str | None) -> str:
	"""A monospaced font file, or a refusal that says how to give one."""
	for candidate in ([given] if given else []) + FACES:
		if candidate and Path(candidate).exists():
			return candidate
	raise SystemExit(f"no monospaced font found - pass --font <file.ttf> (tried {', '.join(FACES)})")


def colour(name: str, default: str) -> str:
	"""pyte names a colour, numbers it, or says `default`; a terminal shows a pixel."""
	if name == "default":
		return default
	if name in NAMED:
		return PALETTE[NAMED[name]]
	return f"#{name}" if len(name) == 6 else default


def draw(log: Path, out: Path, rows: int, cols: int, size: int, font_file: str | None) -> None:
	try:
		import pyte
		from PIL import Image, ImageDraw, ImageFont
	except ImportError:
		raise SystemExit(MISSING)

	screen = pyte.Screen(cols, rows)
	pyte.Stream(screen).feed(log.read_bytes().decode("utf-8", "replace"))

	path = face(font_file)
	regular = ImageFont.truetype(path, size)
	# A bold face beside the regular one where there is one; dim and bright are
	# already colours, and pyte reports them as such.
	bold_path = path.replace("DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf")
	bold = ImageFont.truetype(bold_path, size) if Path(bold_path).exists() else regular

	cell_w, cell_h, pad = round(regular.getlength("M")), round(size * 1.35), 12
	image = Image.new("RGB", (cols * cell_w + 2 * pad, rows * cell_h + 2 * pad), BACKGROUND)
	pen = ImageDraw.Draw(image)

	for y in range(rows):
		line = screen.buffer[y]
		for x in range(cols):
			cell = line[x]
			if cell.data in ("", " ") and cell.bg == "default":
				continue
			fg, bg = colour(cell.fg, FOREGROUND), colour(cell.bg, BACKGROUND)
			left, top = pad + x * cell_w, pad + y * cell_h
			if cell.reverse:
				fg, bg = bg, fg
			if bg != BACKGROUND:
				pen.rectangle([left, top, left + cell_w, top + cell_h], fill=bg)
			pen.text((left, top), cell.data, font=bold if cell.bold else regular, fill=fg)

	image.save(out)
	print(f"{out} ({image.size[0]}x{image.size[1]})", file=sys.stderr)


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("log", type=Path, help="the file drive-pi.py --log wrote")
	parser.add_argument("out", type=Path, help="where to write the picture")
	parser.add_argument("--size", default="45x120", help="the terminal drive-pi.py was given")
	parser.add_argument("--font-size", type=int, default=15, help="pixels per cell height")
	parser.add_argument("--font", help="a monospaced .ttf to draw with")
	args = parser.parse_args()

	rows, cols = (int(part) for part in args.size.split("x"))
	draw(args.log, args.out, rows, cols, args.font_size, args.font)


if __name__ == "__main__":
	main()
