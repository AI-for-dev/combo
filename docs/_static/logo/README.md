# The mark

A combo is several moves that land as one. So is a workflow here: subtasks run apart and
come back as a single `Result`, and the whole library is the arithmetic of that. The mark
draws it - **three strokes in, one out**.

Two things keep it from being a generic merge glyph. The three branches are identical, in
the ink and at the same weight, because a fan-out has no favourite branch. The one that
leaves is the only coloured stroke, because a workflow is judged on what it returns, not
on how busy it looked.

The mark is `combo-mark-light.svg` on a light ground, `combo-mark-dark.svg` on a dark one.
Everything else here serves a constraint those two cannot.

Where they are used today: the **lockup** is the brand, in the documentation sidebar
(`html_theme_options` in `docs/conf.py`, with `sidebar_hide_name` so the word is not
written twice) and at the head of the repository README. The **tile** is the favicon. The
mark on its own is for anywhere the word is already present.

| file | colour | use |
| --- | --- | --- |
| `combo-mark-light.svg` | slate + verdigris | **the mark**, light ground, above 24px |
| `combo-mark-dark.svg` | paper + verdigris | **the mark**, dark ground, above 24px |
| `combo-mark.svg` | `currentColor` | inlined in a page, follows the text colour |
| `combo-tile.svg` | slate ground | favicon, avatar, social image - and any size |
| `combo-lockup-light.svg` | slate + verdigris | **the brand**: sidebar, README, light ground |
| `combo-lockup-dark.svg` | paper + verdigris | **the brand**: sidebar, README, dark ground |

**Two tones need two grounds.** Slate `#232B33` disappears on `#14181B`, so the dark
variants take the inverse ink for the branches and lift the verdigris to `#4FB8AC`, which
would otherwise go muddy.

**`currentColor` does not cross an `<img>` boundary.** A monochrome file inlined in a page
inherits the surrounding text colour; the same file referenced as an image does not, and
falls back to black on both grounds. That is why `combo-mark.svg` is for inlining only, and
why anything referenced by `src` or `href` picks the light or dark file explicitly.

**Below 24px, use the tile rather than the mark.** Three branches 18 units apart, two of
them curving, close into a blob at favicon size. The tile drops one branch and thickens the
strokes: fewer branches still say *several in, one out*, and a smear says nothing.

**The wordmark is geometry, not type.** Circles of radius 10 on a 20-unit x-height, one
stroke width of 3.6 throughout, letters spaced 16 units apart edge to edge - `c` is an arc
open to the right, `o` a circle, `m` two semicircles on three stems, `b` a circle tangent to
an ascender. So there is no typeface to license, nothing to vendor, no generator to run
before the lockup can be rebuilt, and no font to fall back on silently for a reader who
lacks it. Edit the coordinates; keep the stroke width and the x-height, or the word stops
matching the mark it stands beside.

## The palette

Slate `#232B33`, verdigris `#227D74` (`#4FB8AC` on dark), paper `#EEF1F3`, dark ground
`#14181B`, inverse ink `#C9D3DB`. Steel for the branches, and the green of aged bronze for
what comes out of them.

The neutrals are [trysquare](https://github.com/AI-for-dev/trysquare)'s, deliberately: two
tools by the same hand, meant to be read together, cost a reader more when they look
unrelated than they gain by being distinct. What differs is the accent, which is the whole
of the identity: brass there, verdigris here.

On contrast, which decides where each verdigris goes: `#227D74` is 4.35:1 on the ground and
4.94:1 on paper, so it is fine for a rule, a border or a mark, and short of AA for text.
Verdigris *text* is therefore `#1B655E` (6.03:1 on the ground), and on a dark ground
`#4FB8AC` (6.80:1 on the panel) with `#7FD0C2` above it. `_static/custom.css` declares both
as tokens and says the same thing where a stylesheet can enforce it.
