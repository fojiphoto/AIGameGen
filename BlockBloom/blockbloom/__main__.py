"""
Command line entry point.

Every flag here exists because it was needed to verify the game rather than to play it. The game
can run with no display and no sound card, which is how it is actually tested — a game that can
only be checked by a person watching it gets checked much less often.
"""

from __future__ import annotations

import argparse
import os
import sys


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="blockbloom", description="BLOCK BLOOM")
    parser.add_argument("--selftest", action="store_true",
                        help="run the QA suite and exit non-zero on failure")
    parser.add_argument("--shots", metavar="DIR",
                        help="write a PNG of every screen to DIR and exit")
    parser.add_argument("--headless", action="store_true",
                        help="dummy video and audio drivers")
    parser.add_argument("--mode", choices=("endless", "challenge"),
                        help="skip the menu and start playing")
    parser.add_argument("--theme", help="start with a particular palette")
    parser.add_argument("--scale", type=float, default=1.0,
                        help="window scale; 1.0 fits the window to your display")
    args = parser.parse_args(argv)

    if args.headless or args.selftest or args.shots:
        # Must be set before pygame.display is touched.
        os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
        os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

    if args.selftest:
        from .selftest import run_selftest
        return run_selftest()

    if args.shots:
        from .shots import write_shots
        return write_shots(args.shots)

    import pygame  # noqa: F401  (imported before anything asks pygame for a surface)

    from .app import App
    from .scenes.menu import MenuScene
    from .scenes.play import PlayScene

    app = App(headless=args.headless, window_scale=args.scale)
    if args.theme:
        app.save.select_theme(args.theme)

    if args.mode:
        first = PlayScene(app)
        app.run(first, first_kwargs={"mode_key": args.mode})
    else:
        app.run(MenuScene(app))
    return 0


if __name__ == "__main__":
    sys.exit(main())
