"""Sphinx configuration.

The documentation is written in MyST Markdown, not reStructuredText: every page here is
also read in the repository and in the published tarball, and one syntax is easier to keep
good than two.

Building this site needs Sphinx; **using combo does not**. Nothing under `src/` knows this
file exists, and `docs/requirements.txt` is never installed by anyone who only wants the
library - which is why the dependency lives there rather than in `package.json`.
"""

import json
import sys
from pathlib import Path

_root = Path(__file__).resolve().parent
# This directory, so `pygments_style` below can name `_pygments` by module path.
sys.path.insert(0, str(_root))

project = "combo"
# Derived rather than written a second time: `package.json` names the version.
release = json.loads((_root.parent / "package.json").read_text())["version"]
# No `copyright` and no `author`: the repository carries no LICENSE and names no holder,
# and a documentation footer must not be the first place either is asserted.

extensions = [
    "myst_parser",
    "sphinx_copybutton",
    "sphinx_design",
]

myst_enable_extensions = [
    "colon_fence",  # ::: fences, so admonitions read as Markdown
    "deflist",
    "fieldlist",
    "linkify",  # bare URLs become links
    "substitution",
    "tasklist",
]
myst_heading_anchors = 3

templates_path = ["_templates"]
exclude_patterns = [
    "_build",
    "Thumbs.db",
    ".DS_Store",
    # README.md documents how to *build* these docs, for someone browsing the repository.
    # It is not a page of the site, so Sphinx must not collect it - otherwise it is an
    # orphan in every toctree, and with -W that is a build failure.
    "README.md",
    "requirements.txt",
    # _static is copied verbatim, not parsed. Its own README.md documents the marks for
    # whoever reuses them, and would otherwise be collected as a document with no place in
    # any toctree. `scripts/doc-links.ts` excludes the same two files, for the same reason.
    "_static/**",
]

html_theme = "furo"
html_static_path = ["_static"]
# Furo derives the code background, the gutter and the copy button from the pygments style
# itself, so the blocks join the palette only if the style does. `_pygments.py` says why.
pygments_style = "_pygments.Combo"
pygments_dark_style = "_pygments.ComboDark"
html_title = "combo"
# The brand is the lockup, so `sidebar_hide_name` suppresses the text furo would otherwise
# set beside it - the word is already in the drawing, and writing it twice reads as a
# mistake. `html_title` still names the browser tab.
#
# Two files rather than one: the lockup is two-tone, so it needs a variant per ground, and
# currentColor would not have helped anyway - it does not reach an SVG referenced as an
# image, so a monochrome file would go black in both themes.
html_favicon = "_static/logo/combo-tile.svg"
html_css_files = ["custom.css"]

# Furo's variables, pointed at the palette `_static/custom.css` declares. The map lives
# here rather than in the stylesheet because furo emits it in an inline <style> after every
# linked sheet, on `body[data-theme="dark"]` - a rule in custom.css on plain `body` has
# lower specificity and would lose in dark mode.
#
# One dict handed to both keys, for that same reason: the values point at `--co-*` tokens,
# and it is those tokens that flip. But furo declares its *own* dark values on the more
# specific selector, so the map has to be repeated there to outrank them rather than
# quietly inherited from the light one.
_palette = {
    "font-stack": "var(--co-serif)",
    "font-stack--monospace": "var(--co-mono)",
    # Three faces, one job each: the Garamond for what is read, Inter for what is
    # navigated - headings, sidebar, tables, cards - and the reader's own monospace for
    # what is typed. `_static/custom.css` serves the first two and says why.
    "font-stack--headings": "var(--co-sans)",
    # Ink and ground. The content is paper and the chrome is the ground - which is already
    # how furo splits primary from secondary. Reversed, twenty pages of running prose
    # become a grey slab.
    "color-foreground-primary": "var(--co-ink)",
    "color-foreground-secondary": "var(--co-ink-2)",
    "color-foreground-muted": "var(--co-ink-3)",
    "color-foreground-border": "var(--co-rule)",
    "color-background-primary": "var(--co-panel)",
    "color-background-secondary": "var(--co-ground)",
    "color-background-hover": "var(--co-panel-2)",
    "color-background-hover--transparent": "var(--co-panel-2-clear)",
    "color-background-border": "var(--co-rule-soft)",
    "color-background-item": "var(--co-ink-3)",
    # Verdigris carries links and marks. `--co-verdigris-ink` wherever it is *text*:
    # #227D74 on the ground is 4.35:1, and text needs 4.5.
    "color-brand-primary": "var(--co-verdigris)",
    "color-brand-content": "var(--co-verdigris-ink)",
    "color-brand-visited": "var(--co-verdigris-ink)",
    "color-link-underline": "var(--co-rule)",
    "color-link-underline--hover": "var(--co-verdigris)",
    "color-link-underline--visited": "var(--co-rule)",
    "color-link-underline--visited--hover": "var(--co-verdigris)",
    "color-highlight-on-target": "var(--co-verdigris-wash)",
    "color-highlighted-background": "var(--co-verdigris-wash)",
    "color-inline-code-background": "var(--co-panel-2)",
    "color-sidebar-background": "var(--co-ground)",
    "color-sidebar-background-border": "var(--co-rule)",
    "color-sidebar-caption-text": "var(--co-ink-2)",
    "color-sidebar-link-text": "var(--co-ink-2)",
    # Not the brand colour: furo paints every top-level entry in it, and a column of
    # verdigris links spends the accent on what is *not* the answer. It appears once in the
    # sidebar, on the page you are reading.
    "color-sidebar-link-text--top-level": "var(--co-ink)",
    # Transparent, because the default is the secondary background - which after this map
    # is the sidebar's own colour, so the field would vanish into it. Furo rules the input
    # top and bottom; the ground behind it and a paper fill on focus are field enough.
    "color-sidebar-search-background": "transparent",
    "color-sidebar-search-background--focus": "var(--co-panel)",
    "color-sidebar-search-border": "var(--co-rule)",
    "color-sidebar-search-icon": "var(--co-ink-3)",
    # `-foreground` and not `-text`: furo declares `--color-sidebar-search-text`, but the
    # rule that colours the input reads `--color-sidebar-search-foreground`. Setting the
    # declared name does nothing at all.
    "color-sidebar-search-foreground": "var(--co-ink)",
    "color-toc-title-text": "var(--co-ink-2)",
    "color-toc-item-text": "var(--co-ink-2)",
    "color-toc-item-text--hover": "var(--co-ink)",
    "color-toc-item-text--active": "var(--co-verdigris-ink)",
    # An admonition is a rule and a title strip. Furo fills the body - transparent in light,
    # #18181a in dark - and neither is in this palette. The *title* colours are furo's own
    # and stay: they are semantic, and a verdigris "danger" would be decoration pretending
    # to be meaning.
    "color-admonition-background": "transparent",
    "color-table-border": "var(--co-rule-soft)",
    "color-table-header-background": "transparent",
    # sphinx-design's own tokens, which furo-extensions declares on `body` as well.
    "sd-color-card-background": "var(--co-panel)",
    "sd-color-card-border": "var(--co-rule-soft)",
    "sd-color-card-border-hover": "var(--co-verdigris)",
    "sd-color-card-text": "var(--co-ink)",
    "sd-color-card-header": "var(--co-panel-2)",
    "sd-color-card-footer": "var(--co-panel-2)",
    "sd-color-shadow": "rgba(35, 43, 51, 0.08)",
    "sd-color-primary": "var(--co-verdigris)",
    "sd-color-primary-text": "var(--co-panel)",
    "sd-color-primary-highlight": "var(--co-verdigris-ink)",
}
# `--color-problematic` and the `--color-api-added/changed/deprecated/removed` pairs are
# left alone on purpose. They are semantic, they are rare, and a verdigris "removed" would
# be decoration pretending to be meaning.

html_theme_options = {
    "source_repository": "https://github.com/AI-for-dev/combo",
    "source_branch": "main",
    "source_directory": "docs/",
    "navigation_with_keys": True,
    "light_logo": "logo/combo-lockup-light.svg",
    "dark_logo": "logo/combo-lockup-dark.svg",
    "sidebar_hide_name": True,
    "light_css_variables": _palette,
    "dark_css_variables": _palette,
}

# A warning is a defect in the documentation, and the same standard applies here as to the
# code: it fails loudly rather than accumulating quietly. `make -C docs html` passes -W.
nitpicky = False
suppress_warnings: list[str] = []
