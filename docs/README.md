# Building the documentation

```bash
uv venv && uv pip install -r docs/requirements.txt
.venv/bin/python -m sphinx -b html docs docs/_build/html -W
# or, with the environment active
make -C docs html
```

`-W` turns warnings into errors, deliberately. A warning is a defect in the documentation,
and the same standard applies here as to the code. `.github/workflows/docs.yml` runs the
same build on every pull request, and publishes to GitHub Pages from `main` - so the
question "does it still build" is answered before a merge rather than after one.

Written in **MyST Markdown**, not reStructuredText. Every page under `docs/` is read three
ways - on the site, in the repository, and in the published tarball, which carries `docs`
in `files` - so plain Markdown is what the pages are, and Sphinx syntax appears only where
a site needs something a Markdown file cannot say: the toctrees and the cards on
`index.md`.

Python is a documentation dependency and nothing more. The library is TypeScript, `npm
test` and `npm run typecheck` never reach this directory, and `package.json` still depends
on the pi SDK alone.

## Layout

```
docs/
  index.md              the landing page: what combo is, and where to start
  guide/                task-oriented: how to do a thing
    quickstart.md       the first subagent, the first workflow, the first build
    agents.md           defining an agent in Markdown, tools, scopes
    lifetime.md         the central choice: disposable or persistent
    workflows.md        the nine combinators and the options they share
    pipelines.md        a workflow written in Markdown, next to your agents
    build.md            interview, plan, pair, check, audit, commit
    display.md          reporters, herdr splits, the pi TUI widget
    measurements.md     what Usage counts, and what it refuses to guess
    export.md           runs/<timestamp>/, HTML, JSONL, usage.json
    experiments.md      one workflow, M models, N repetitions, one table
    extension.md        the subagent tool, /interview, /build, /herdr
  reference/            lookup-oriented: what an export or a file does
    api/                generated from the TSDoc by `npm run docs`
    examples.md         one runnable script per shape
  development.md        tests, typechecking, conventions, how the docs stay honest
  decisions.md          why the library is shaped this way, and what was reversed
  _static/custom.css    the palette and the devices, per selector
  _pygments.py          the code blocks, in the same two hues
  _static/logo/         the marks, and README.md for what each one is for
```

`reference/api/` is **generated** - `npm run docs` writes it from the TSDoc of everything
`src/index.ts` exports, and `test/docs.test.ts` fails when the checked-in pages no longer
match the source. Its index carries the hidden toctree that gives those pages a place in
the site's navigation, so a module that disappears takes its navigation entry with it.

Navigation is the toctrees and nothing else. `scripts/doc-links.ts` reads them to check
that every hand-written page is reachable and every entry exists, which is the same
question Sphinx asks - asked offline, in `npm test`, where the answer is cheap.
