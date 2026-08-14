"""
Entry point.

Also holds the headless switches, which exist so the game can be tested without a display or a
sound card. `--selftest` is the QA harness; `--shots` captures frames from scripted play for
visual review. Both are how this project is actually verified — a game you can only check by
looking at it is a game you check once.
"""

from __future__ import annotations

import argparse
import os
import sys


def _parse(argv):
    p = argparse.ArgumentParser(prog="neoncoil", description="NEON COIL — arcade snake")
    p.add_argument("--headless", action="store_true",
                   help="run with dummy video and audio drivers (for testing)")
    p.add_argument("--selftest", action="store_true",
                   help="run the automated QA pass and exit non-zero on failure")
    p.add_argument("--shots", metavar="DIR",
                   help="capture screenshots of every screen into DIR and exit")
    p.add_argument("--frames", type=int, default=None,
                   help="quit after this many frames (used by the tests)")
    p.add_argument("--scale", type=float, default=1.0,
                   help="initial window scale, e.g. 0.75 for a smaller window")
    p.add_argument("--mode", choices=("classic", "time", "challenge"),
                   help="skip the menus and start this mode immediately")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse(argv if argv is not None else sys.argv[1:])

    if args.headless or args.selftest or args.shots:
        # Must be set before pygame.display is touched.
        os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
        os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

    if args.selftest:
        from .selftest import run_selftest
        return run_selftest()

    if args.shots:
        from .selftest import capture_shots
        return capture_shots(args.shots)

    from .app import App
    from .scenes.play import PlayScene
    from .scenes.splash import SplashScene

    app = App(headless=args.headless, window_scale=args.scale)
    if args.mode:
        # PlayScene reads the mode from the save when it is not passed one, so setting it here
        # means `--mode` needs no special plumbing through run().
        app.save.data["last_mode"] = args.mode
        app.run(PlayScene(app), max_frames=args.frames)
    else:
        app.run(SplashScene(app), max_frames=args.frames)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
