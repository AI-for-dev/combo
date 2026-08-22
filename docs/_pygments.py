"""Syntax colouring in the same two hues as the rest of the page.

Furo ships ``a11y-light`` and ``native``, writes its own ``pygments.css`` at build time,
and - this is the part that matters - derives ``--color-code-background`` and
``--color-code-foreground`` from ``style.background_color`` and the colour it resolves for
``Text``. Those two drive the block background, the line-number gutter, the code-block
caption and the copy button, so overriding token classes in the stylesheet would fight a
generated file and still leave four things the wrong colour. A style class settles all of
it in one place.

The scheme has three roles: a literal is verdigris, a comment recedes, a keyword is the ink
at full weight. Punctuation drops to the secondary ink so structure reads without being
coloured, and nothing else is coloured at all. Eight hues in a code block is decoration
that reads as meaning; the page already says what matters by where it puts it.

The colours are the palette in ``_static/custom.css``, written out as literals because
Pygments emits a stylesheet, not custom properties, and cannot read a ``var()``.
"""

from __future__ import annotations

from pygments.style import Style
from pygments.token import (
    Comment,
    Error,
    Generic,
    Keyword,
    Name,
    Number,
    Operator,
    Punctuation,
    String,
    Text,
)

# Light: ink #232B33, ink-2 #5D6873, ink-3 #7E8894, panel-2 #E4E9ED, verdigris #227D74.
# Dark:  ink #C9D3DB, ink-2 #93A0AC, ink-3 #74808C, panel-2 #232A30, verdigris #4FB8AC.


class Combo(Style):
    """The light scheme."""

    background_color = "#E4E9ED"
    highlight_color = "#DCEAE7"
    line_number_color = "#7E8894"
    line_number_background_color = "#E4E9ED"

    styles = {
        Text: "#232B33",
        Comment: "#7E8894",
        Comment.Preproc: "#5D6873",
        Keyword: "bold #232B33",
        Keyword.Constant: "#1B655E",
        Name: "#232B33",
        Name.Function: "bold #232B33",
        Name.Class: "bold #232B33",
        Name.Tag: "bold #232B33",
        Name.Attribute: "#5D6873",
        Name.Decorator: "#1B655E",
        String: "#1B655E",
        String.Escape: "bold #1B655E",
        Number: "#1B655E",
        Operator: "#5D6873",
        Punctuation: "#5D6873",
        Generic.Prompt: "#7E8894",
        Generic.Output: "#5D6873",
        Generic.Emph: "italic",
        Generic.Strong: "bold",
        Generic.Heading: "bold #232B33",
        Error: "#B30000",
    }


class ComboDark(Style):
    """The dark scheme, one step lighter throughout and with the verdigris lifted."""

    background_color = "#232A30"
    highlight_color = "#172624"
    line_number_color = "#74808C"
    line_number_background_color = "#232A30"

    styles = {
        Text: "#C9D3DB",
        Comment: "#74808C",
        Comment.Preproc: "#93A0AC",
        Keyword: "bold #C9D3DB",
        Keyword.Constant: "#4FB8AC",
        Name: "#C9D3DB",
        Name.Function: "bold #C9D3DB",
        Name.Class: "bold #C9D3DB",
        Name.Tag: "bold #C9D3DB",
        Name.Attribute: "#93A0AC",
        Name.Decorator: "#4FB8AC",
        String: "#4FB8AC",
        String.Escape: "bold #4FB8AC",
        Number: "#4FB8AC",
        Operator: "#93A0AC",
        Punctuation: "#93A0AC",
        Generic.Prompt: "#74808C",
        Generic.Output: "#93A0AC",
        Generic.Emph: "italic",
        Generic.Strong: "bold",
        Generic.Heading: "bold #C9D3DB",
        Error: "#FF7575",
    }
