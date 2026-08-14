#
# /// script
# dependencies = [
#   "numpy",
# ]
# ///
#
# The block above is PEP 723 inline script metadata, and it is how pygbag learns what to fetch
# for the WebAssembly build. Without it numpy is simply absent in the browser and the game dies
# on the first import — the desktop build never notices because numpy is installed there.
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
