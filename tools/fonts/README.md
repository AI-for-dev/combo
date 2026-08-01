# JetBrains Mono, vendored

The typeface the wordmark is outlined from, committed so that `tools/build-lockup.py`
regenerates the same lockup on any machine.

| | |
| --- | --- |
| version | 2.304 (`ttfautohint v1.8.4.7-5d5b`) |
| sha256 | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
| source | <https://github.com/JetBrains/JetBrainsMono> |
| licence | SIL Open Font License 1.1, `OFL.txt` |

Unmodified: 1743 glyphs, name table untouched. `build-lockup.py` checks the digest above
before it reads a glyph and refuses if it does not match, so replacing the font means updating
`FONT_SHA256` in that script and the digest here together.

The OFL permits redistribution, embedding, and outlining glyphs into a derivative work. It
requires that the copyright notice and the licence travel with the font: that is what
`OFL.txt` and `AUTHORS.txt` are doing here, and they must stay. The copyright line declares no
Reserved Font Name.

The faces macOS ships - Menlo, SF Mono, Courier - are licensed by Apple and grant no such
permission. Do not outline the wordmark from one of them.
