#
# /// script
# dependencies = []
# ///
#
# Deliberately empty, and the reason is worth recording.
#
# This asked for numpy, which is what the desktop build uses for the per-pixel work: glows, the
# background wash, the vignette, and the whole sound bank. pygbag does list a numpy wheel, so the
# request looked reasonable — but it only publishes one built against CPython 3.11 while its
# current runtime is 3.12, so the fetch 404s. pygbag does not treat that as recoverable: the page
# died on an unhandled rejection ("Cannot read properties of undefined, reading 'M_ID'") and never
# reached the game at all.
#
# Rather than pin the build to an older interpreter and stay dependent on a wheel staying where it
# is, numpy became optional. Every field generator has a pygame-only fallback that draws the same
# ramp as nested shapes, and the sound bank has a pure-Python twin. Verified by hiding numpy from
# the import system and running the whole suite: 142 checks pass on both paths, and the rendered
# screens differ by about 3% — banding, not structure.
#
"""
Web entry point.

pygbag requires a `main.py` at the top of the project whose main is a coroutine. That is not an
arbitrary convention: the browser has one event loop and the page only repaints when control is
handed back to it, so a game driven by a plain `while` loop renders one frame and then hangs the
tab. `App.run_async` is the same frame loop as the desktop build with one `await` in it.

This file is also the right place for the handful of adjustments the web needs, kept here rather
than smeared through the game:

* asyncio is imported and driven here, so nothing else in the package has to know about it;
* the window is opened at the fixed virtual resolution, because a browser canvas cannot be
  resized by the user the way a desktop window can;
* the splash is skipped on the web. It exists to cover the cost of generating the sprite and
  sound banks, and in the browser that cost has already been paid by the loader screen the
  player has just sat through.

Running this file directly on a desktop works too, and is a useful way to check that the async
driver behaves the same as the synchronous one.
"""

import asyncio
import sys


async def main():
    from neoncoil.app import App
    from neoncoil.scenes.menu import MenuScene
    from neoncoil.scenes.splash import SplashScene

    on_web = sys.platform == "emscripten"

    app = App(headless=False)
    first = MenuScene(app) if on_web else SplashScene(app)
    await app.run_async(first)


if __name__ == "__main__":
    asyncio.run(main())
