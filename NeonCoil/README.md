# NEON COIL

A modern arcade snake. Free steering rather than a grid, a body that traces real curves, three
modes, six power-ups, eight unlockable skins, and a combo chain that is worth playing for.

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
pip install -r requirements.txt && python -m neoncoil
```

## Controls

| | |
|---|---|
| **Arrows** or **WASD** | steer — hold two for a diagonal |
| **ESC** or **P** | pause |
| **R** | restart the run |
| **Enter** | select · play again |
| **F11** | fullscreen |
| **F1** | frame-rate readout |

The snake turns at a fixed radius, so it curves rather than pivots. It is always moving.

## Modes

**CLASSIC** — no timer. Grow, survive, and watch the arena fill up with obstacles.

**TIME ATTACK** — 75 seconds, and every pickup buys more. Orbs give a second, prisms give four.

**CHALLENGE** — six objectives in one run, in order, no restarts. Clear all six to win outright.

## What is in it

**Pickups.** Orbs are the staple: always three on the field, permanent. Sparks are worth more and
expire. Prisms are rare, expire fastest, and are worth a lot.

**Power-ups.** Magnet, Shield, Slow-Mo, Double Score, Boost, Ghost. Each has its own icon, its own
effect, and a duration bar in the HUD. Collecting one you already have refreshes it rather than
stacking it.

**Combo.** Chain pickups to climb the multiplier, up to x8. The window narrows as it rises, so a
long chain is a real run rather than a formality — and the pickup sound rises in pitch with it.

**Progression.** A level every six orbs: faster, and from level three onwards a new obstacle every
other level. Nothing spawns on top of you, and blocks fade in before they become solid.

**Skins.** Eight, unlocked against your best score across all modes. The one you pick shows up on
the menu, drifting behind the interface.

Your high scores, unlocked skins and settings are saved automatically to
`%APPDATA%\NeonCoil\save.json` (or `~/.local/share/NeonCoil/` elsewhere). A missing or corrupt
save resolves to defaults rather than an error.

## Layout

```
run.py                    launcher: dependency check, then start
neoncoil/
  config.py               every tuning constant, with the reasoning
  theme.py                palette, skins, pickups, power-ups, modes
  assets.py               all sprite and texture generation
  audio.py                all sound synthesis
  fonts.py                typography, tracking, glow text
  ui.py                   buttons, toggles, sliders, focus handling
  fx.py                   particles, floating text, shake, ripples
  background.py           the animated backdrop and the arena frame
  save.py                 atomic JSON save, defensive loading
  app.py                  window, fixed timestep, scene stack
  selftest.py             the QA harness
  entities/               snake, pickups, power-ups, obstacles
  scenes/                 splash, menu, modes, skins, settings, play
```

## Testing

The game can run without a display or a sound card, which is how it is actually verified:

```bash
python -m neoncoil --selftest        # 142 assertions, exits non-zero on failure
python -m neoncoil --shots out/      # a PNG of every screen, for visual review
python -m neoncoil --mode classic    # skip the menus
python -m neoncoil --headless        # dummy video and audio drivers
```

The self test covers steering and body spacing, all three death conditions and that none of them
fires early, scoring and combo and growth, every power-up applying and expiring, the shield
absorbing exactly one hit, level and obstacle scheduling, every screen building and navigating,
pause genuinely freezing the simulation, the save surviving a corrupt file, letterboxing at five
window sizes, and a frame-time budget measured as a median across batches. It also covers the
browser-only code — the localStorage-backed save against a stub, storage that refuses, storage that
is absent, the async frame driver, and the contents of the packed WebAssembly archive.

To exercise the pygame-only paths the browser actually runs, hide numpy from the import system:

```bash
python -c "import _nonumpy, sys; from neoncoil.selftest import run_selftest; sys.exit(run_selftest())"
```

## Notes on a few decisions

**Steering is a radius, not a rate.** A fixed turn rate means the turn radius changes with speed,
so handling shifts under the player between levels — and at the rate that felt responsive, the
radius came out tighter than the snake was wide, which killed you for holding a direction.
Deriving the rate from a fixed radius fixes both, and lets the radius be chosen against the length
at which a full circle closes on itself: below about 33 segments you physically cannot loop into
yourself.

**numpy is optional.** It is the fast path for anything defined per pixel — glows, the background
wash, the vignette, the sound bank — and every one of those has a pygame-only fallback that draws
the same ramp as nested shapes. That is not insurance, it is the browser build: pygbag publishes a
numpy wheel built against CPython 3.11 while its runtime is 3.12, so asking for it 404s and kills
the page before the game loads. Both paths are tested — 142 checks pass with numpy hidden from the
import system, and the rendered screens differ by about 3%.

**Additive sprites carry their brightness in RGB.** pygame's additive blend ignores alpha, both
per-surface and per-pixel. Every glow in the game is premultiplied and generated at the brightness
it will be drawn at; fading one means regenerating it dimmer, quantised so a fading particle reuses
a small ramp of cached sprites.

**The simulation runs on a fixed timestep.** Rendering runs as fast as the display allows; the
simulation advances in 1/120 slices from an accumulator. At full speed a single dropped frame under
a variable timestep would move the head far enough to pass through a wall between two collision
checks.

**Moving the snake means rebuilding its path.** The body is a set of samples of where the head has
been, so writing a new position without rebuilding that history leaves the body behind and the
snake drives down its own neck. `respawn` and `deflect` exist for exactly this reason.
