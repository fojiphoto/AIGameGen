# BLOCK BLOOM

A block-placement puzzle. Three pieces at a time, an 8×8 board, and a line that clears the moment
you fill it. Easy to start, hard to stop.

Every pixel and every sound is generated at runtime. There are no image files and no audio files
anywhere in this project.

## Play

```bash
python run.py
```

That is the whole setup. The launcher checks its dependencies, installs what is missing, and starts
the game. Only pygame is required; numpy is a fast path the game does without if it is absent.

If you would rather do it by hand:

```bash
pip install -r requirements.txt && python -m blockbloom
```

## Controls

| | |
|---|---|
| **Drag** a block from the tray onto the board | place it |
| Release anywhere illegal | it springs back, no penalty |
| **ESC** or **P** | pause |
| **R** | restart the run |
| **F11** | fullscreen |
| **F1** | frame-rate readout |

Mouse and touch go through the same code path, so it plays the same on a phone as on a desktop.

## Modes

**ENDLESS** — play until none of your three pieces fits anywhere.

**CHALLENGE** — a ladder of ten objectives, in order, one per run: clear five lines, reach 1,500
points, clear two lines at once, place 25 pieces, reach combo x3, and on up to 15,000 points. Each
one pays coins and unlocks the next.

## What is in it

**Scoring.** Two points a cell for placing. A line is worth a hundred times a multiplier that grows
sharply with how many lines you take at once — four together are worth eight times one, not four
times — and again with your combo. Emptying the board entirely pays a 2,000-point bonus.

**Combos.** The chain counts *moves*, not seconds. Clear something on consecutive placements and the
multiplier climbs to x8; make a move that clears nothing and it resets. There is no clock, because a
timed window in a puzzle game punishes thinking.

**Smart dealing.** The generator reads the board before it deals. It scores several candidate hands
on whether anything fits, whether any piece could complete a line, and whether the three are varied,
and keeps the best — but the only *guarantee* is the floor: at least one of your three pieces always
has somewhere to go, as long as somewhere exists. Above that floor it stays random, because a hand
engineered to be solvable every time removes the game.

**Difficulty.** Not cruelty — size. Early deals lean on ones, twos and corners; later ones bring the
fives, the plus and the S-shapes. Small shapes never stop appearing, since those are what let a
crowded board be recovered. And if the longest empty run on the board is three cells, you will not be
sent a five.

**Themes.** Five palettes, bought with coins: Classic, Neon, Candy, Ocean, Galaxy. Each restyles the
background, the board, the tiles, the particles and the interface accents. Neon and Galaxy light
their tiles from behind.

Your high scores, coins, unlocked themes, objective progress and settings save automatically to
`%APPDATA%\BlockBloom\save.json` (or `~/.local/share/BlockBloom/` elsewhere). A missing or corrupt
save resolves to defaults rather than an error.

## Putting it on the web

The game is a Python program, so it does not run in a browser as-is. pygbag compiles CPython and
pygame to WebAssembly and emits a static folder — no server, no build step at the far end. From a
player's side it behaves like any WebGL build: it loads in the page, with nothing to install.

From the repository root:

```bash
npm run publish:blockbloom
```

That runs the test suite, compiles to WebAssembly, and rebuilds the arcade site into `docs/`. Then:

```bash
git add -A && git commit -m "Update BLOCK BLOOM" && git push
```

| | |
|---|---|
| Play | `https://fojiphoto.github.io/AIGameGen/play/block-bloom/` |
| Embed in another page | `https://fojiphoto.github.io/AIGameGen/embed/block-bloom.html` |
| Arcade index | `https://fojiphoto.github.io/AIGameGen/` |

To drop it into your own site — note the **portrait** aspect ratio:

```html
<iframe src="https://fojiphoto.github.io/AIGameGen/embed/block-bloom.html"
        style="width:100%;max-width:460px;aspect-ratio:9/16;border:0;border-radius:14px"
        allow="autoplay; fullscreen" allowfullscreen
        title="BLOCK BLOOM"></iframe>
```

The `allow` attribute is not optional. Without it the game loads and plays in silence, which reads
as a bug in the game rather than a missing permission on the frame.

Two things about the browser build worth knowing. The first load fetches pygbag's Python runtime
(about 20 MB) from its CDN and the browser caches it afterwards, so the first visit is slow and the
rest are not. And it waits for a click before starting, because browsers refuse to begin audio
without one.

## Layout

```
run.py                    launcher: dependency check, then start
main.py                   web entry point (pygbag needs a coroutine at the top level)
blockbloom/
  config.py               every tuning constant, with the reasoning
  theme.py                palettes, objectives, modes
  assets.py               gradients, glows, panels, particles
  tiles.py                the block tile, the board furniture
  audio.py                all sound synthesis
  fonts.py                typography, tracking, glow text
  ui.py                   widgets, pooled layers, focus handling
  fx.py                   particles, floating text, ripples, shake
  background.py           the animated backdrop
  board.py                occupancy, legality, line detection — no pygame in here
  pieces.py               the shape catalogue
  generator.py            smart dealing
  scoring.py              score, combos, banners
  save.py                 atomic JSON save, localStorage on the web
  app.py                  window, fixed timestep, scene stack
  selftest.py             the QA harness
  shots.py                a PNG of every screen
  scenes/                 menu, play, themes, settings
```

## Testing

The game runs without a display or a sound card, which is how it is actually verified:

```bash
python -m blockbloom --selftest        # 239 assertions, exits non-zero on failure
python -m blockbloom --shots out/      # a PNG of every screen, for visual review
python -m blockbloom --mode endless    # skip the menu
python -m blockbloom --theme neon      # start in a particular palette
python -m blockbloom --headless        # dummy video and audio drivers
```

The suite covers placement legality at every edge, row clears, column clears, simultaneous crosses
and the shared cell being counted once, four-line clears, the perfect-clear bonus, scoring and combo
arithmetic including the cap and the reset, the generator never dealing a dead hand across forty
simulated runs, difficulty responding to a cramped board, game-over detection being accurate in both
directions, restart, pause genuinely freezing the simulation, the challenge ladder, the tutorial
firing exactly once, every screen building and navigating, theme purchase and switching, palette
legibility (block colours distinguishable, tiles standing off the board, empty cells reading as
cells), letterboxing at five window sizes, the browser-only save paths against a stub, the async
frame driver, and a frame-time and zero-allocation budget for **every screen** rather than just
gameplay.

To exercise the pygame-only paths the browser actually runs, hide numpy from the import system:

```bash
python -c "import _nonumpy, sys; from blockbloom.selftest import run_selftest; sys.exit(run_selftest())"
```

## Notes on a few decisions

**8×8, not 10×10.** With three pieces dealt at a time and shapes up to five cells long, a ten-wide
row needs too many pieces to finish: clears become rare, the board silts up, and the game reads as
unfair rather than hard. At eight, a row is two or three well-chosen pieces — which is the loop this
genre lives on.

**The board is authoritative; animations only hold pictures.** When a line clears, the cells stay in
the grid for the highlight and are then removed, at which point the clear animation holds nothing but
captured colours and positions. No animation is ever consulted about what is on the board, so the two
cannot disagree about what has been scored.

**Snapping is measured from the piece, not the cursor.** The target cell comes from where the piece's
own top-left cell has landed, so a five-long placed at the edge goes where it looks like it will.
Requiring the cursor to be inside the target cell was the first version, and it felt like fighting
the game.

**The tile is built like a lit object, not a coloured rectangle.** A drop shadow, a vertical body
gradient, a bevel that is light on one diagonal and dark on the other, a broad specular sheen and a
small glint. The sheen is the one that matters: as a lighter rectangle it leaves a visible seam
across every tile, and as an ellipse clipped to the rounded corners it reads as a curved surface.

**Additive light lands on the destination, never in the sprite.** `BLEND_ADD` adds the colour
channels and leaves the destination alpha alone, so compositing a glow into a transparent scratch
surface produces the right colour at alpha zero — nothing at all. The lit themes therefore draw their
tile haloes as a separate pass over the opaque board.

**The highlight for a line you are about to complete is additive too.** As a translucent overlay it
averaged itself with the tiles underneath and desaturated them, so the row looked greyed out and
disabled. Adding light instead lifts the tiles and the empty cells together.
