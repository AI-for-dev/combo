# The mark

Three equal bars held by a brass bracket. The files are in `docs/_static/logo/`, they are
generated, and the generators are in `tools/`: edit those, never the path data.

| file | colour | use |
| --- | --- | --- |
| `combo-mark-light.svg` | slate + brass | **the mark**, light ground, above 32px |
| `combo-mark-dark.svg` | paper + brass | **the mark**, dark ground, above 32px |
| `combo-mark-small-light.svg` | slate + brass | at or below 32px, light ground |
| `combo-mark-small-dark.svg` | paper + brass | at or below 32px, dark ground |
| `combo-mark.svg` | `currentColor` | inlined in a page, follows the text colour |
| `combo-tile.svg` | slate ground | favicon, avatar, social image |
| `combo-lockup-light.svg` | slate + brass | **the brand**: README, docs, light ground |
| `combo-lockup-dark.svg` | paper + brass | **the brand**, dark ground |
| `combo-brackets-pair-light.svg` | slate + brass | the symmetric variant, not the mark |

## The rules

**Pick the file by the ground, not by the theme.** `currentColor` does not cross an `<img>`
boundary, so a file referenced as an image never sees the page's text colour. Slate `#232B33`
and brass `#A97C2A` on a light ground; paper `#C9D3DB` and brass `#C79338` on a dark one.
`combo-mark.svg` is the exception, and only when it is inlined in the page.

**At or below 32px, use the small variant.** It carries two bars instead of three and every
stroke is thicker.

**The tile carries its own ground**, so it works against anything and needs no light or dark
variant.

**The lockup is the brand**, and it is what goes in a README or a sidebar. Where the word
`combo` is already written next to it, use the mark alone.

## Regenerating

```bash
uv run python tools/make-marks.py                      # every mark, from one geometry
uv run --with fonttools python tools/build-lockup.py    # the two lockups, from the font
```

Both are run by hand. `npm test` does not run them, and nothing the library ships depends on
Python. The wordmark ships as outlines: `tools/fonts/README.md` records which font it is drawn
from, its digest and its licence.
