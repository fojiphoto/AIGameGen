#
# /// script
# dependencies = []
# ///
#
# Deliberately empty, and the reason is worth recording.
#
# The obvious entry here is numpy, which is the fast path for everything defined per pixel: glows,
# the background wash, the vignette, and the whole sound bank. pygbag does list a numpy wheel, so
# asking for it looks reasonable — but it only publishes one built against CPython 3.11 while its
# current runtime is 3.12, so the fetch 404s. pygbag does not treat that as recoverable: the page
# dies on an unhandled rejection and never reaches the game at all.
#
# So numpy is optional here rather than required. Every per-pixel generator has a pygame-only
# fallback that draws the same field as nested shapes, and the sound bank has a pure-Python twin.
# Verified by hiding numpy from the import system and running the whole suite: 239 checks pass on
# both paths.
#
"""
Web entry point.

pygbag requires a `main.py` at the top of the project whose main is a coroutine, and that is not an
arbitrary convention: the browser has one event loop and the page only repaints when control is
handed back to it, so a game driven by a plain `while` loop renders one frame and then hangs the
tab. `App.run_async` is the same frame loop as the desktop build with one `await` in it.

This file is also the right place for the handful of adjustments the web needs, kept here rather
than smeared through the game:

* asyncio is imported and driven here, so nothing else in the package has to know about it;
* the window is opened at the fixed virtual resolution, because a browser canvas is sized by the
  page and cannot be resized by the player the way a desktop window can.

Running this file directly on a desktop works too, and is a useful way to check that the async
driver behaves the same as the synchronous one.
"""

import asyncio
import sys

# pygame is imported HERE, at the top of the entry point, and that is load-bearing rather than
# stylistic. pygbag hooks this import to wire up its WebAssembly bindings, and reaching pygame for
# the first time from somewhere deeper — inside a coroutine, or through a package import — leaves a
# module object whose members are missing. The symptom is a bare
# `module 'pygame' has no attribute 'init'` from the first line that tries to use it.
import pygame  # noqa: F401  (imported for its side effects on the web)


async def main():
    from blockbloom.app import App
    from blockbloom.scenes.menu import MenuScene

    app = App(headless=False)
    await app.run_async(MenuScene(app))


if __name__ == "__main__":
    asyncio.run(main())
