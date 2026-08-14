#!/usr/bin/env python3
"""
NEON COIL — launcher.

Double-click this, or run `python run.py`. It checks the two dependencies, installs them if they
are missing, and starts the game. Nothing else is required: no configuration, no asset download,
no build step.

Why a launcher rather than "pip install -r requirements.txt && python -m neoncoil": because the
most common way a small Python game fails is that someone runs it before installing anything and
gets a traceback about a missing module. This turns that into a progress message.

It is deliberately conservative about installing. It only ever asks pip for the two packages this
project needs, it prefers a virtual environment if it is running inside one, and if the install
fails for any reason it prints the one command a human can run instead of leaving them with a
stack trace.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys

MIN_PYTHON = (3, 10)

#: (import name, pip requirement). pygame-ce is the maintained community fork; it is a drop-in
#: replacement for pygame and imports under the same name.
REQUIREMENTS = (
    ("pygame", "pygame-ce>=2.4"),
    ("numpy", "numpy>=1.24"),
)


def _missing() -> list[tuple[str, str]]:
    return [(mod, req) for mod, req in REQUIREMENTS if importlib.util.find_spec(mod) is None]


def _install(reqs: list[str]) -> bool:
    print(f"Installing: {', '.join(reqs)}")
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *reqs]
    # --user is required when installing into a system Python that is not writable, and is wrong
    # inside a virtual environment, where it is both unnecessary and rejected.
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    if not in_venv and os.name != "nt":
        cmd.insert(4, "--user")
    try:
        subprocess.check_call(cmd)
    except (subprocess.CalledProcessError, OSError) as exc:
        print(f"\nCould not install automatically ({exc}).")
        print("Run this yourself, then start the game again:")
        print(f"    {sys.executable} -m pip install {' '.join(reqs)}")
        return False
    return True


def main() -> int:
    if sys.version_info < MIN_PYTHON:
        print(f"NEON COIL needs Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer; "
              f"this is {sys.version.split()[0]}.")
        return 1

    missing = _missing()
    if missing:
        print("NEON COIL — first run, fetching what it needs.")
        if not _install([req for _, req in missing]):
            return 1
        still = _missing()
        if still:
            print(f"Still missing after install: {', '.join(m for m, _ in still)}")
            return 1
        print("Done.\n")

    # Imported only now, so a missing dependency is a message rather than a traceback.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from neoncoil.main import main as game_main
    return game_main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
