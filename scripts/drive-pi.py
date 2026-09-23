"""Types commands into a real pi, and prints what it drew.

A slash command's output exists **only in the TUI**. Everything a command says
goes through `ctx.ui.notify`, which writes to pi's own surface, so the
non-interactive modes show none of it:

    $ pi -e extension -p "/agents"                 # exits 0, prints nothing
    $ pi -e extension --mode json -p "/agents"     # one session event, and that is all

The command really ran. Nobody can see what it said. This script is the way
round that: a pty, so pi believes it is talking to a terminal, then keystrokes
in and the drawn frames out.

**It scrapes a terminal, which the test suite never does.** `test/extension.test.ts`
captures the registered renderers and calls them directly, precisely so that no
test depends on how a terminal happens to paint. That rule is not weakened here,
because this is not a test and never runs in `npm test`: a step is considered
finished after a stretch of silence, so where it ends depends on model latency.
It is a pre-flight, run by hand, before claiming that a change to the extension
works.

What that buys is the class of defect no fake can reach. One startup said:

    Extension command '/share' conflicts with built-in interactive command.

`share` is one of pi's own built-in slash commands, and an extension command of
that name is dropped from its own autocomplete. The fake `pi` handed to the
tests has no built-ins to collide with, so 750 green tests had nothing to say
about it.

    python3 scripts/drive-pi.py \\
        --model <provider/model> \\
        "/step scout where the wall time is measured||25||300" \\
        "/chain" "/quote"

Each argument is one command line, optionally followed by `||idle||cap` in
seconds: how long a silence means the step is over, and how long to wait
regardless. The defaults suit a listing; a step that spawns subagents wants a
longer pair.

`--model` is the model **pi** runs on. A command spawns its subagents on the
`--model` it was itself given, and on pi's settings when it was given none, so
the status bar and the subagent lines can honestly disagree. `--log` keeps every
byte, escape sequences included: `scripts/frame.py` turns that into a picture,
which is the only way to judge spacing and colour.

An argument of the form `key:<name>` presses a key instead of typing a line,
which is the only way to check what stops a run:

    python3 scripts/drive-pi.py \\
        "/run explore where is the wall time measured||3||20" \\
        "key:ctrl+down||2||4" "key:ctrl+delete||3||10" "key:escape||3||15"

A run keeps repainting, so silence never comes while it works: give those steps
a cap, and read what the frames say.
"""

from __future__ import annotations

import argparse
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Escape sequences, and the carriage returns a redraw leaves behind.
ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]|\r")

# What `key:<name>` sends. A key is how a run is interrupted and how a question
# card is answered, and neither is something a line of text can express.
KEYS = {
    "escape": b"\x1b",
    "enter": b"\r",
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "ctrl+up": b"\x1b[1;5A",
    "ctrl+down": b"\x1b[1;5B",
    "ctrl+delete": b"\x1b[3;5~",
}

# The widget's dimmed row, repainted four times a second while a subagent works.
# Hundreds of copies of it bury the one frame worth reading.
SPINNER = re.compile(r"↑\d+ ↓\d+ · [\d.]+s")


def readable(text: str, raw: bool) -> str:
    """The frames, minus what a repaint duplicated."""
    lines, last = [], None
    for line in text.splitlines():
        line = line.rstrip()
        if not raw and SPINNER.search(line):
            continue
        if line != last or line:
            lines.append(line)
        last = line
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


class Pi:
    """A pi running in a pty: write a line, read what it painted."""

    def __init__(self, argv: list[str], cwd: str, log: Path, rows: int, cols: int):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows))
        self.proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.log = log.open("wb")

    def read_until_idle(self, idle: float, cap: float) -> str:
        """Everything painted until nothing has arrived for `idle` seconds."""
        chunks, last, started = [], time.time(), time.time()
        while time.time() - last < idle and time.time() - started < cap:
            if not select.select([self.master], [], [], 0.5)[0]:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:  # the pty closed: pi is gone
                break
            if not data:
                break
            chunks.append(data)
            self.log.write(data)
            self.log.flush()
            last = time.time()
        return ANSI.sub(b"", b"".join(chunks)).decode("utf-8", "replace")

    def send(self, line: str) -> None:
        os.write(self.master, line.encode() + b"\r")

    def press(self, key: str) -> None:
        """One keystroke, with no carriage return after it."""
        try:
            os.write(self.master, KEYS[key])
        except KeyError:
            raise SystemExit(f"unknown key `{key}`: say one of {', '.join(KEYS)}")

    def close(self) -> None:
        # Twice: the first interrupt clears the prompt, the second exits.
        for _ in range(2):
            try:
                os.write(self.master, b"\x03")
                time.sleep(0.5)
            except OSError:
                break
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "commands",
        nargs="+",
        help=f"a command line, or `key:<{'|'.join(KEYS)}>`, optionally `||idle||cap` in seconds",
    )
    parser.add_argument("--model", default="ilaas/gemma-4-31b", help="pi's own model; a command's subagents take their own --model")
    parser.add_argument("--extension", default="extension/index.ts", help="the extension to load")
    parser.add_argument("--cwd", default=str(ROOT), help="where pi runs, and where runs/ lands")
    parser.add_argument("--log", default="drive-pi.log", help="every byte pi wrote, escape sequences included")
    parser.add_argument("--idle", type=float, default=4.0, help="silence that means the command is done")
    parser.add_argument("--cap", type=float, default=60.0, help="wait no longer than this, whatever happens")
    parser.add_argument("--raw", action="store_true", help="keep the repaint frames")
    parser.add_argument("--size", default="45x120", help="terminal the TUI draws for")
    args = parser.parse_args()

    rows, cols = (int(part) for part in args.size.split("x"))
    # `-a` trusts the project's own files for this run: the alternative is a
    # dialog nobody is there to answer.
    argv = ["pi", "-a", "-e", args.extension, "--model", args.model]
    pi = Pi(argv, args.cwd, Path(args.log), rows, cols)

    try:
        print("=== startup ===", flush=True)
        print(readable(pi.read_until_idle(idle=args.idle, cap=args.cap), args.raw), flush=True)

        for spec in args.commands:
            command, _, rest = spec.partition("||")
            idle, _, cap = rest.partition("||")
            print(f"\n=== {command} ===", flush=True)
            if command.startswith("key:"):
                pi.press(command[len("key:") :])
            else:
                pi.send(command)
            time.sleep(0.4)
            painted = pi.read_until_idle(float(idle or args.idle), float(cap or args.cap))
            print(readable(painted, args.raw), flush=True)
    finally:
        pi.close()

    print(f"\n=== raw transcript: {args.log} ===", file=sys.stderr)


if __name__ == "__main__":
    main()
