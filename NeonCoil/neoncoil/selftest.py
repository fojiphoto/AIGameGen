"""
The QA harness.

A game that can only be checked by a person looking at it gets checked once. So the game is
built to be driven without a display: `--selftest` runs the whole thing headless with scripted
input and asserts on real outcomes, and `--shots` captures frames of every screen so the art can
be reviewed as images rather than from memory.

What is actually verified here, in order: that every module imports and every generator produces
a surface; that the snake steers, that its body follows and stays evenly spaced, and that it
grows; that each of the three death conditions fires and none of them fires early; that pickups
score, combo and grow; that all six power-ups apply and expire; that the shield absorbs exactly
one hit; that levels and obstacles arrive on schedule; that every screen builds, draws and
navigates; that pause freezes the simulation and resume unfreezes it; that saving round-trips and
survives a corrupt file; and that a long run holds its frame budget.
"""

from __future__ import annotations

import math
import time
from pathlib import Path

import pygame

FAILS: list[str] = []
CHECKS = 0


def check(cond, label: str, detail: str = "") -> bool:
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"  \x1b[32mok\x1b[0m   {label}" + (f"  \x1b[2m{detail}\x1b[0m" if detail else ""))
        return True
    FAILS.append(label + (f" — {detail}" if detail else ""))
    print(f"  \x1b[31mFAIL\x1b[0m {label}" + (f"  {detail}" if detail else ""))
    return False


def section(name: str):
    print(f"\n\x1b[1m{name}\x1b[0m")


def _fresh_app(tmp_save: Path):
    """An App with an isolated save file, so a test run never touches real progress.

    The caches are dropped first. Cached Font objects and cached Surfaces are both tied to the
    pygame session that created them, so any earlier `pygame.quit()` leaves the caches holding
    handles that raise "font module quit since font created" the next time they are drawn. Doing
    this here rather than at each call site is what makes the suite safe to reorder.
    """
    from . import assets, fonts
    from .app import App
    from .save import SaveData

    assets.clear_cache()
    fonts.clear_cache()
    app = App(headless=True)
    app.save = SaveData(tmp_save)
    app.save.data["settings"]["music"] = False
    return app


def _step(app, scene, seconds: float, *, keys=(), dt: float = 1 / 120):
    """Advance a scene by wall-clock seconds with a set of keys held down.

    Patches `pygame.key.get_pressed` because the dummy video driver produces no key events, so
    held-key steering has to be simulated at the source the game actually reads.
    """
    held = set(keys)
    real = pygame.key.get_pressed

    class _Keys:
        def __getitem__(self, k):
            return k in held

    pygame.key.get_pressed = lambda: _Keys()
    try:
        n = max(1, int(seconds / dt))
        for _ in range(n):
            scene.update(dt)
    finally:
        pygame.key.get_pressed = real


def _isolate(scene, *, x=None, y=None, heading=0.0):
    """Pin a play scene into a known state.

    Auto-spawn off, field and power-ups cleared, counters zeroed, snake placed and aimed. Without
    this a sub-test is measuring the scene's own ambient behaviour as well as the thing it means
    to check: a stray orb eaten between two assertions moved the score, restarted the combo
    timer and advanced the level, and the failures that produced were all in the harness rather
    than in the game.
    """
    from .scenes.play import ARENA_RECT
    # Revive as well as reposition. Once a sub-test has killed the snake the scene stops
    # simulating, and every later assertion silently measures a dead game — which is how one
    # real failure turned into five imaginary ones.
    scene.state = "playing"
    scene.state_t = 0.0
    scene.death_cause = ""
    scene.snake.alive = True
    scene.active.clear()
    scene.field.auto_spawn = False
    scene.field.clear()
    scene.powers.items.clear()
    # respawn(), not a raw position write: the path has to be rebuilt behind the head or the
    # snake is left pointing down its own body.
    scene.snake.respawn(ARENA_RECT.centerx if x is None else x,
                        ARENA_RECT.centery if y is None else y, heading)
    scene.score = 0
    scene.food_total = 0
    scene.food_toward_level = 0
    scene.coins = 0
    scene.gems = 0
    scene.combo = 0
    scene.combo_timer = 0.0
    scene.combo_best = 0


def _drop(scene, kind="food", ahead=58.0):
    """Place a single pickup directly in front of the head and return it."""
    from .config import COIN_RADIUS, FOOD_RADIUS, GEM_RADIUS
    from .entities.pickups import Pickup
    radius = {"food": FOOD_RADIUS, "coin": COIN_RADIUS, "gem": GEM_RADIUS}[kind]
    p = Pickup(kind, scene.snake.x + math.cos(scene.snake.heading) * ahead,
               scene.snake.y + math.sin(scene.snake.heading) * ahead, radius, None)
    p.scale = 1.0
    scene.field.items.append(p)
    return p


def _key(scene, key):
    scene.handle(pygame.event.Event(pygame.KEYDOWN, {"key": key, "mod": 0, "unicode": ""}))


# ── the passes ──────────────────────────────────────────────────────────────
def _test_assets():
    section("Procedural assets")
    from . import assets, fonts, theme

    surf = assets.glow(40, theme.ACCENT)
    check(surf.get_size() == (80, 80), "glow generates at the requested size", str(surf.get_size()))
    check(assets.vertical_gradient((64, 64), (0, 0, 0), (255, 255, 255)).get_at((0, 63))[0] > 240,
          "gradient reaches its end colour")

    ok = True
    for sk in theme.SKINS:
        for r in (6, 11, 15):
            if assets.segment(sk.key, 0.5, r).get_width() < r:
                ok = False
        if assets.head(sk.key, 15).get_width() < 15:
            ok = False
    check(ok, f"every skin renders body and head sprites", f"{len(theme.SKINS)} skins")

    ok = all(assets.power_icon(k, 30).get_size() == (30, 30) for k in theme.POWERS)
    check(ok, "all six power-up icons render", ", ".join(theme.POWERS))
    ok = all(assets.pickup_sprite(k, 14).get_width() > 10 for k in theme.PICKUPS)
    check(ok, "all pickup sprites render")
    check(assets.obstacle(120, 28).get_size() == (120, 28), "obstacle sprite renders")
    check(assets.rounded_panel(200, 80, 12, (10, 10, 10), (40, 40, 40),
                              (90, 90, 90), 2).get_size() == (200, 80), "UI panel renders")

    fam = fonts.get(24, True)
    check(fam.render("NEON", True, (255, 255, 255)).get_width() > 10, "font renders text")
    tracked = fonts.render_tracked("NEON", 24, (255, 255, 255), True, 6.0)
    plain = fonts.render_tracked("NEON", 24, (255, 255, 255), True, 0.0)
    check(tracked.get_width() > plain.get_width(), "letter tracking widens a string",
          f"{plain.get_width()} -> {tracked.get_width()}")


def _test_audio():
    section("Audio")
    from . import audio
    # The dummy driver still supports sndarray, so the bank should build even with no device.
    check(isinstance(audio.is_enabled(), bool), "audio reports a definite state",
          "enabled" if audio.is_enabled() else "silent fallback")
    # Every entry point must be safe regardless.
    for fn in (audio.eat, audio.coin, audio.gem, audio.power, audio.death, audio.shield,
               audio.level_up, audio.click, audio.move, audio.combo):
        fn()
    audio.start_music()
    audio.duck_music(True)
    audio.stop_music()
    check(True, "every sound entry point is callable without a device")


def _test_snake():
    section("Snake movement")
    from .config import SEGMENT_SPACING, START_SEGMENTS
    from .entities import Snake

    s = Snake(400, 300, 0.0, "neon")
    check(s.length == START_SEGMENTS, "starts at the configured length", str(s.length))
    check(len(s.body) >= START_SEGMENTS - 1, "body is populated on spawn", f"{len(s.body)} segments")

    x0 = s.x
    for _ in range(60):
        s.update(1 / 120)
    check(s.x > x0 + 50, "moves along its heading", f"{s.x - x0:.0f}px in 0.5s")

    # Steering: ask for straight up and confirm it gets there, and that it took time.
    s.steer_to(0, -1)
    frames = 0
    while abs(s.heading + math.pi / 2) > 0.05 and frames < 240:
        s.update(1 / 120)
        frames += 1
    check(frames > 4, "turning is rate limited, not instant", f"{frames} steps to turn 90 degrees")
    check(frames < 120, "turning is responsive", f"{frames / 120:.2f}s to turn 90 degrees")

    # Body spacing is the core of the follow model.
    for _ in range(240):
        s.update(1 / 120)
    gaps = [math.dist(s.body[i], s.body[i + 1]) for i in range(min(12, len(s.body) - 1))]
    worst = max(abs(g - SEGMENT_SPACING) for g in gaps)
    check(worst < SEGMENT_SPACING * 0.35, "body segments stay evenly spaced",
          f"worst deviation {worst:.2f}px of {SEGMENT_SPACING}")

    before = s.length
    s.grow(6)
    for _ in range(180):
        s.update(1 / 120)
    check(s.length >= before + 5, "growing lengthens the snake", f"{before} -> {s.length}")

    # The turn-radius guarantee: a snake shorter than one full circle cannot close a loop on
    # itself, so holding a direction can never kill a player who has not yet grown into it.
    from .config import SNAKE_TURN_RADIUS
    safe_len = int(2 * math.pi * SNAKE_TURN_RADIUS / SEGMENT_SPACING)
    check(safe_len > START_SEGMENTS * 2, "the safe circle is comfortably longer than a new snake",
          f"{safe_len} segments around a {SNAKE_TURN_RADIUS:.0f}px circle "
          f"vs {START_SEGMENTS} at spawn")

    s2 = Snake(400, 300, 0.0, "neon")
    s2.target_segments = s2.segments = float(safe_len - 6)
    for _ in range(400):
        s2.update(1 / 120)
    died = False
    for i in range(1200):
        s2.steer_to(math.cos(i * 0.05), math.sin(i * 0.05))
        s2.update(1 / 120)
        if s2.hits_self():
            died = True
            break
    check(not died, "holding a hard turn does not kill a short snake",
          f"{s2.length} segments, under the {safe_len}-segment circle")

    # But a real crossing must be detected. Drive a long snake in a tight circle whose radius is
    # smaller than its own length, which forces the head into the body.
    s3 = Snake(400, 300, 0.0, "neon")
    s3.target_segments = s3.segments = 120.0
    for _ in range(400):
        s3.update(1 / 120)
    hit = False
    for _ in range(1400):
        s3.steer_to(-math.sin(s3.heading + 0.9), math.cos(s3.heading + 0.9))
        s3.update(1 / 120)
        if s3.hits_self():
            hit = True
            break
    check(hit, "self-collision does fire when the head reaches the body")


def _test_gameplay(app, tmp):
    section("Gameplay")
    from . import theme
    from .config import FOOD_PER_LEVEL
    from .scenes.play import ARENA_RECT, PlayScene

    scene = PlayScene(app)
    scene.enter(mode_key="classic")
    check(scene.state == "intro", "a run opens with the intro banner")
    _step(app, scene, 1.4)
    check(scene.state == "playing", "the intro hands over to play")

    # Pickup: one orb, placed in front of the head, nothing else on the field.
    _isolate(scene)
    before_len = scene.snake.length
    _drop(scene, "food")
    _step(app, scene, 0.7)
    check(scene.score > 0, "eating scores", f"score {scene.score}")
    check(scene.combo == 1, "eating starts a combo", f"x{scene.combo}")
    check(scene.food_total == 1, "orb count tracks", str(scene.food_total))
    _step(app, scene, 0.6)
    check(scene.snake.length > before_len, "eating grows the snake",
          f"{before_len} -> {scene.snake.length}")

    # Score scales with the multiplier: the same orb is worth more inside a chain.
    _isolate(scene)
    _drop(scene, "food")
    _step(app, scene, 0.6)
    first = scene.score
    _drop(scene, "food")
    _step(app, scene, 0.6)
    second = scene.score - first
    check(second > first, "a chained pickup scores more than the first",
          f"{first} then {second}")

    # Combo climbs when pickups are chained, and expires when they are not.
    _isolate(scene)
    for _ in range(4):
        _drop(scene, "food")
        _step(app, scene, 0.55)
    check(scene.combo >= 4, "chaining raises the multiplier", f"x{scene.combo}")
    peak = scene.combo
    scene.snake.base_speed = 0.0
    _step(app, scene, 4.4)
    scene.snake.base_speed = 250.0
    check(scene.combo == 0, "the combo expires when the chain stops", f"peaked at x{peak}")
    check(scene.combo_best >= peak, "the best combo is remembered", f"x{scene.combo_best}")

    # Rarer pickups are worth more than orbs at the same multiplier.
    _isolate(scene)
    _drop(scene, "food")
    _step(app, scene, 0.6)
    orb = scene.score
    _isolate(scene)
    _drop(scene, "gem")
    _step(app, scene, 0.6)
    check(scene.score > orb, "a prism outscores an orb", f"{orb} vs {scene.score}")
    check(scene.gems == 1, "prism count tracks")

    # Levelling.
    _isolate(scene)
    scene.food_toward_level = FOOD_PER_LEVEL - 1
    lvl = scene.level
    _drop(scene, "food")
    _step(app, scene, 0.7)
    check(scene.level == lvl + 1, "levels advance on the food quota",
          f"level {lvl} -> {scene.level}")
    speed_before = scene.snake.base_speed
    scene.snake.set_level_speed(10)
    check(scene.snake.base_speed > speed_before, "higher levels are faster",
          f"{speed_before:.0f} -> {scene.snake.base_speed:.0f} px/s")

    # Obstacles appear on schedule and never on top of the player.
    from .entities import ObstacleField
    check(ObstacleField.target_count(1) == 0, "no obstacles on level 1")
    check(ObstacleField.target_count(20) > 0, "obstacles by the late levels",
          f"{ObstacleField.target_count(20)} at level 20")
    scene.field.auto_spawn = True
    scene.obstacles.clear()
    added = scene.obstacles.sync_to_level(12, scene.snake, scene.field)
    check(len(scene.obstacles.items) > 0, "obstacles place successfully",
          f"{len(scene.obstacles.items)} blocks")
    clear_of_snake = all(
        not ob.rect.inflate(60, 60).collidepoint(scene.snake.x, scene.snake.y)
        for ob in scene.obstacles.items)
    check(clear_of_snake, "no obstacle spawns on the snake")
    inside = all(ARENA_RECT.contains(ob.rect) for ob in scene.obstacles.items)
    check(inside, "every obstacle is inside the arena")


def _test_powers(app, tmp):
    section("Power-ups")
    from . import theme
    from .config import SLOWMO_SCALE
    from .entities import ActivePowers
    from .scenes.play import PlayScene

    ap = ActivePowers()
    for key in theme.POWERS:
        ap.activate(key)
        if not check(ap.has(key), f"{key} activates"):
            continue
    check(ap.score_multiplier == 2, "double applies a x2 multiplier")
    check(abs(ap.time_scale - SLOWMO_SCALE) < 1e-6, "slow-mo scales time", f"x{ap.time_scale}")
    check(ap.magnet and ap.ghost and ap.boost, "magnet, ghost and boost report active")

    check(ap.shield, "shield is up")
    check(ap.spend_shield(), "shield absorbs a hit")
    check(not ap.shield, "shield is spent after absorbing")
    check(not ap.spend_shield(), "shield only absorbs once")

    # Everything expires.
    longest = max(p.duration for p in theme.POWERS.values())
    steps = int((longest + 1.0) / (1 / 120))
    for _ in range(steps):
        ap.update(1 / 120)
    check(ap.active_keys() == [], "every power-up expires", f"after {longest:.0f}s")

    # And through the real scene: collect one and confirm the effect lands.
    scene = PlayScene(app)
    scene.enter(mode_key="classic")
    _step(app, scene, 1.3)
    from .entities.powerups import PowerDrop
    _isolate(scene)
    d = PowerDrop("magnet", scene.snake.x + 58, scene.snake.y)
    d.scale = 1.0
    scene.powers.items.append(d)
    _step(app, scene, 0.7)
    check(scene.active.magnet, "a collected power-up activates in play")
    check(scene.powers_taken == 1, "power-up pickups are counted")

    # Magnet actually pulls. Snake held still so the only motion is the pickup's.
    _isolate(scene)
    scene.active.activate("magnet")
    far = _drop(scene, "food", ahead=175.0)
    far.y += 60.0
    d0 = math.dist((far.x, far.y), (scene.snake.x, scene.snake.y))
    scene.snake.base_speed = 0.0
    _step(app, scene, 0.4)
    d1 = math.dist((far.x, far.y), (scene.snake.x, scene.snake.y))
    check(d1 < d0 - 5.0, "magnet pulls pickups towards the snake",
          f"{d0:.0f}px -> {d1:.0f}px")


def _test_deaths(app, tmp):
    section("Death conditions")
    from .scenes.play import ARENA_RECT, PlayScene

    # Wall.
    scene = PlayScene(app)
    scene.enter(mode_key="classic")
    _step(app, scene, 1.3)
    _isolate(scene, x=ARENA_RECT.right - 40, y=ARENA_RECT.centery, heading=0.0)
    scene.snake.invuln = 0.0
    _step(app, scene, 1.0)
    check(scene.state in ("dying", "dead"), "hitting a wall ends the run", scene.death_cause)
    check(scene.death_cause == "wall", "the cause is reported as the wall", scene.death_cause)

    # Obstacle.
    scene2 = PlayScene(app)
    scene2.enter(mode_key="classic")
    _step(app, scene2, 1.3)
    _isolate(scene2)
    scene2.snake.invuln = 0.0
    from .entities.obstacles import Obstacle
    ob = Obstacle(pygame.Rect(int(scene2.snake.x + 70), int(scene2.snake.y - 40), 40, 80))
    ob.spawn = 1.0
    scene2.obstacles.items.append(ob)
    _step(app, scene2, 0.9)
    check(scene2.death_cause == "obstacle", "hitting an obstacle ends the run",
          scene2.death_cause or "survived")

    # Shield saves exactly one hit.
    scene3 = PlayScene(app)
    scene3.enter(mode_key="classic")
    _step(app, scene3, 1.3)
    _isolate(scene3, x=ARENA_RECT.right - 40, y=ARENA_RECT.centery, heading=0.0)
    scene3.active.activate("shield")
    scene3.snake.invuln = 0.0
    _step(app, scene3, 0.8)
    check(scene3.state == "playing", "a shield survives a wall hit", scene3.death_cause or "alive")
    check(not scene3.active.shield, "the shield is consumed")

    # Ghost passes through obstacles.
    scene4 = PlayScene(app)
    scene4.enter(mode_key="classic")
    _step(app, scene4, 1.3)
    _isolate(scene4)
    scene4.active.activate("ghost")
    scene4.snake.invuln = 0.0
    ob2 = Obstacle(pygame.Rect(int(scene4.snake.x + 60), int(scene4.snake.y - 50), 40, 100))
    ob2.spawn = 1.0
    scene4.obstacles.items.append(ob2)
    _step(app, scene4, 0.8)
    check(scene4.state == "playing", "ghost mode passes through obstacles",
          scene4.death_cause or "alive")

    # Nothing kills the snake while it is simply driving around the middle.
    scene5 = PlayScene(app)
    scene5.enter(mode_key="classic")
    _step(app, scene5, 1.3)
    _isolate(scene5)
    scene5.field.auto_spawn = True
    # A box, not a staircase. Alternating two directions walks diagonally into a corner, which
    # tests the corner rather than the steering.
    box = (pygame.K_RIGHT, pygame.K_DOWN, pygame.K_LEFT, pygame.K_UP)
    for i in range(12):
        _step(app, scene5, 0.45, keys=[box[i % 4]])
        if scene5.state != "playing":
            break
    check(scene5.state == "playing", "steering around the arena does not kill you",
          scene5.death_cause or "alive")


def _test_modes(app, tmp):
    section("Game modes")
    from . import theme
    from .scenes.play import PlayScene

    scene = PlayScene(app)
    scene.enter(mode_key="time")
    _step(app, scene, 1.3)
    _isolate(scene)
    scene.snake.base_speed = 0.0
    t0 = scene.time_left
    _step(app, scene, 1.0)
    check(scene.time_left < t0, "the time attack clock runs down",
          f"{t0:.1f} -> {scene.time_left:.1f}")

    scene.snake.base_speed = 250.0
    _drop(scene, "food")
    before = scene.time_left
    _step(app, scene, 0.6)
    check(scene.time_left > before, "pickups buy time back",
          f"{before:.1f} -> {scene.time_left:.1f}")

    _isolate(scene)
    scene.snake.base_speed = 0.0
    scene.time_left = 0.05
    _step(app, scene, 0.5)
    check(scene.death_cause == "time", "the run ends when the clock does", scene.death_cause)

    ch = PlayScene(app)
    ch.enter(mode_key="challenge")
    _step(app, ch, 1.3)
    _isolate(ch)
    ch.snake.base_speed = 0.0
    check(ch.objective is not None, "challenge mode has an objective",
          ch.objective.text.format(target=ch.objective.target))
    # Satisfy the first objective outright and confirm it advances.
    first = ch.objective
    ch.food_total = first.target if first.stat == "food" else ch.food_total
    ch.score = first.target if first.stat == "score" else ch.score
    ch.coins = first.target if first.stat == "coins" else ch.coins
    ch.gems = first.target if first.stat == "gems" else ch.gems
    ch.combo_best = first.target if first.stat == "combo_best" else ch.combo_best
    _step(app, ch, 0.2)
    check(ch.challenge_index >= 1, "objectives advance when met",
          f"objective {ch.challenge_index + 1}")

    ch.challenge_index = len(theme.CHALLENGES) - 1
    last = theme.CHALLENGES[-1]
    setattr(ch, "score", last.target)
    _step(app, ch, 0.2)
    check(ch.death_cause == "complete", "clearing every objective wins the run",
          ch.death_cause or "still running")


def _test_scenes(app, tmp):
    section("Screens and navigation")
    from .app import App
    from .scenes.menu import MenuScene
    from .scenes.modes import ModesScene
    from .scenes.play import GameOverScene, PauseScene, PlayScene
    from .scenes.settings import SettingsScene
    from .scenes.skins import SkinsScene
    from .scenes.splash import SplashScene

    surf = pygame.Surface((1280, 720))
    for cls in (SplashScene, MenuScene, ModesScene, SkinsScene, SettingsScene):
        sc = cls(app)
        sc.enter()
        for _ in range(30):
            sc.update(1 / 60)
        sc.draw(surf)
        name = cls.__name__.replace("Scene", "")
        check(True, f"{name} builds, updates and draws")
        if hasattr(sc, "group") and sc.group.widgets:
            n = len(sc.group.widgets)
            sc.group.move(1)
            sc.group.move(-1)
            check(sc.group.current is not None, f"{name} has keyboard focus", f"{n} widgets")

    # Menu navigation reaches every screen without leaving a dangling transition.
    menu = MenuScene(app)
    menu.enter()
    menu.update(1 / 60)
    for i, label in enumerate(("PLAY", "MODES", "SKINS", "SETTINGS")):
        m = MenuScene(app)
        m.enter()
        m.update(1 / 60)
        m.group.widgets[i].activate()
        check(app._pending is not None, f"menu item {label} starts a transition")
        app._pending = None
        app._transition = 0.0
        app._transition_dir = 0

    # Pause freezes the simulation; resume restores it.
    play = PlayScene(app)
    app.switch_now(play, mode_key="classic")
    _step(app, play, 1.3)
    x_before = play.snake.x
    pause = PauseScene(app)
    app.push(pause, play=play)
    check(app.scene is pause, "pause pushes onto the stack")
    for _ in range(60):
        app._update_stack(1 / 120)
    check(abs(play.snake.x - x_before) < 0.001, "the game does not advance while paused",
          f"moved {abs(play.snake.x - x_before):.4f}px")
    check(pause.transparent, "the arena stays visible behind the pause menu")
    pause._resume()
    check(app.scene is play, "resuming pops back to the game")
    for _ in range(60):
        app._update_stack(1 / 120)
    check(abs(play.snake.x - x_before) > 0.5, "the game advances again after resuming")

    # Restart from pause.
    play.score = 4321
    p2 = PauseScene(app)
    app.push(p2, play=play)
    p2._restart()
    check(play.score == 0 and play.state == "intro", "restart from pause resets the run")

    # Game over builds and offers a way back in.
    play._die("wall")
    _step(app, play, 1.1)
    check(isinstance(app.scene, GameOverScene), "death pushes the game-over screen",
          type(app.scene).__name__)
    over = app.scene
    for _ in range(40):
        over.update(1 / 60)
    over.draw(surf)
    check(len(over.group.widgets) == 3, "game over offers again / modes / menu")
    over._again()
    check(play.state == "intro", "play again restarts immediately")


def _test_save(tmp: Path):
    section("Save system")
    from . import theme
    from .save import SaveData

    path = tmp / "roundtrip.json"
    s = SaveData(path)
    check(s.high_score("classic") == 0, "a missing save starts at zero")
    check(len(s.data["unlocked_skins"]) >= 2, "starter skins are unlocked",
          ", ".join(s.data["unlocked_skins"]))

    res = s.record_run("classic", 5200, 44, 6, 21)
    check(res["new_high"], "a first run sets a personal best")
    check(path.exists(), "the save file is written", str(path.name))
    check(len(res["unlocked"]) >= 1, "passing a threshold unlocks a skin",
          ", ".join(x.name for x in res["unlocked"]))

    again = SaveData(path)
    check(again.high_score("classic") == 5200, "the high score round-trips")
    check(again.data["best_length"] == 44, "the best length round-trips")
    check(again.data["best_combo"] == 6, "the best combo round-trips")

    res2 = again.record_run("classic", 100, 5, 1, 1)
    check(not res2["new_high"], "a worse run does not overwrite the best")
    check(again.high_score("classic") == 5200, "the best survives a worse run")

    # A corrupt file must not stop the game launching.
    bad = tmp / "corrupt.json"
    bad.write_text("{not json at all", encoding="utf-8")
    c = SaveData(bad)
    check(c.high_score("classic") == 0, "a corrupt save falls back to defaults")

    # Nor must a save full of the wrong types.
    weird = tmp / "weird.json"
    weird.write_text('{"high_scores": "nope", "unlocked_skins": 5, '
                     '"settings": {"volume": "loud"}, "skin": "does_not_exist"}',
                     encoding="utf-8")
    w = SaveData(weird)
    check(isinstance(w.data["high_scores"], dict), "bad types are repaired")
    check(w.data["skin"] in {sk.key for sk in theme.SKINS}, "an unknown skin resets to default")
    check(isinstance(w.settings["volume"], float), "a bad volume is coerced",
          str(w.settings["volume"]))

    # Selecting a locked skin must be refused.
    locked = next(sk for sk in theme.SKINS if sk.unlock_score > 0
                  and sk.key not in again.data["unlocked_skins"])
    before = again.data["skin"]
    again.select_skin(locked.key)
    check(again.data["skin"] == before, "a locked skin cannot be selected", locked.name)


def _test_performance(app, tmp):
    section("Performance")
    from .scenes.play import PlayScene

    scene = PlayScene(app)
    scene.enter(mode_key="classic")
    _step(app, scene, 1.3)

    # A worst-ish case: long snake, full obstacle set, particles going.
    scene.snake.target_segments = scene.snake.segments = 180.0
    scene.obstacles.sync_to_level(20, scene.snake, scene.field)
    for _ in range(8):
        scene.particles.burst((640, 400), 90, (255, 200, 80), speed=(60, 400), life=(0.9, 1.4))
    for _ in range(30):
        scene.update(1 / 120)

    surf = pygame.Surface((1280, 720))

    # Median of several batches, not the mean of one.
    #
    # A single timed batch on a busy desktop swung between 12 ms and 19 ms for identical code,
    # which made this check flap — and a test that fails at random is worse than no test, because
    # it trains you to ignore it. The median across batches is stable against another process
    # stealing a slice, while still catching a real regression, and both halves are timed
    # separately so a slowdown is attributable to drawing or to simulation rather than to "the
    # game".
    def batch(n, do_update, do_draw):
        t0 = time.perf_counter()
        for _ in range(n):
            if do_update:
                scene.update(1 / 120)
                scene.update(1 / 120)
            if do_draw:
                scene.draw(surf)
        return (time.perf_counter() - t0) / n * 1000.0

    batch(10, True, True)  # warm the caches
    draws = sorted(batch(40, False, True) for _ in range(5))
    sims = sorted(batch(40, True, False) for _ in range(5))
    draw_ms, sim_ms = draws[2], sims[2]
    frame_ms = draw_ms + sim_ms

    check(frame_ms < 16.6, "a heavy frame fits inside the 60fps budget",
          f"{frame_ms:.2f}ms median ({1000 / frame_ms:.0f} fps equivalent) — "
          f"draw {draw_ms:.2f}, sim {sim_ms:.2f}, spread {draws[0]:.1f}-{draws[-1]:.1f}; "
          f"{scene.snake.length} segments, {scene.particles.live} particles")
    check(draw_ms < 12.0, "drawing alone leaves room for the simulation", f"{draw_ms:.2f}ms")

    check(scene.particles.live <= 900, "the particle pool respects its ceiling",
          f"{scene.particles.live} live")


def _test_resize(app):
    section("Window handling")
    from .config import GAME_H, GAME_W

    for size in ((1280, 720), (960, 540), (1600, 900), (1000, 900), (640, 480)):
        app.window = pygame.display.set_mode(size, pygame.RESIZABLE)
        app._layout_window()
        ok = (app.view.w <= size[0] + 1 and app.view.h <= size[1] + 1
              and abs(app.view.w / max(1, app.view.h) - GAME_W / GAME_H) < 0.02)
        if not check(ok, f"letterbox is correct at {size[0]}x{size[1]}",
                     f"view {app.view.w}x{app.view.h}"):
            break

    # Virtual coordinates must survive the round trip through the letterbox.
    app.window = pygame.display.set_mode((1600, 900), pygame.RESIZABLE)
    app._layout_window()
    vx, vy = app.to_virtual((app.view.x + app.view.w // 2, app.view.y + app.view.h // 2))
    check(abs(vx - GAME_W // 2) < 3 and abs(vy - GAME_H // 2) < 3,
          "mouse mapping survives scaling", f"centre maps to ({vx}, {vy})")

    app.window = pygame.display.set_mode((GAME_W, GAME_H), pygame.RESIZABLE)
    app._layout_window()
    app.present()
    check(True, "presenting to the window succeeds")


def _test_long_run(app, tmp):
    section("Endurance")
    from .scenes.play import ARENA_RECT, PlayScene

    scene = PlayScene(app)
    scene.enter(mode_key="classic")
    _step(app, scene, 1.3)

    # Drive a lap pattern for a simulated minute, eating whatever it runs into, and confirm the
    # game neither crashes nor leaks.
    surf = pygame.Surface((1280, 720))
    pattern = (pygame.K_RIGHT, pygame.K_DOWN, pygame.K_LEFT, pygame.K_UP)
    deaths = 0
    for lap in range(24):
        key = pattern[lap % 4]
        _step(app, scene, 0.55, keys=[key])
        scene.draw(surf)
        if scene.state in ("dying", "dead"):
            deaths += 1
            scene.reset()
            _step(app, scene, 1.3)

    check(True, "a long scripted run completes without raising",
          f"{deaths} deaths, score {scene.score}, level {scene.level}")
    check(len(scene.snake.path) < 4000, "the path history stays bounded",
          f"{len(scene.snake.path)} points")
    check(len(scene.floaters.items) <= 40, "floating text is capped",
          f"{len(scene.floaters.items)} live")
    check(len(scene.field.items) <= 12, "pickups do not accumulate",
          f"{len(scene.field.items)} on field")


def _test_web_paths(tmp: Path):
    """The code that only ever runs inside the browser build.

    Worth testing precisely because it cannot be exercised by launching the game here: the web
    build runs under a WebAssembly interpreter this machine has no way to drive to completion, so
    without these the first time anybody finds out whether the browser save works is in front of
    a player.
    """
    section("Web build code paths")
    import asyncio

    from . import save as save_mod

    # ── localStorage backend, with a stub standing in for the browser ────────
    class _StubStorage:
        def __init__(self):
            self.items = {}

        def getItem(self, k):
            return self.items.get(k)

        def setItem(self, k, v):
            self.items[k] = v

    store = save_mod._WebStore.__new__(save_mod._WebStore)
    store._ls = _StubStorage()
    check(store.read() is None, "an empty browser store reads as absent")
    check(store.write('{"a": 1}'), "the browser store accepts a write")
    check(store.read() == '{"a": 1}', "the browser store round-trips")
    check(save_mod.WEB_KEY in store._ls.items, "it writes under the expected key", save_mod.WEB_KEY)

    # A save object wired to the browser backend must behave exactly like the file one.
    web_save = save_mod.SaveData(tmp / "unused-web.json")
    web_save.store = store
    web_save.path = None
    res = web_save.record_run("classic", 7300, 51, 5, 24)
    check(res["new_high"], "a run records through the browser store")
    check(not (tmp / "unused-web.json").exists(), "nothing was written to disk")

    reloaded = save_mod.SaveData(tmp / "unused-web.json")
    reloaded.store = store
    reloaded.load()
    check(reloaded.high_score("classic") == 7300, "progress survives a reload in the browser",
          f"{reloaded.high_score('classic')}")

    # ── storage that refuses, which is a real browser configuration ──────────
    class _Refusing:
        def getItem(self, k):
            raise RuntimeError("blocked")

        def setItem(self, k, v):
            raise RuntimeError("blocked")

    blocked = save_mod._WebStore.__new__(save_mod._WebStore)
    blocked._ls = _Refusing()
    check(blocked.read() is None, "blocked storage reads as absent rather than raising")
    check(blocked.write("{}") is False, "blocked storage reports the failure")

    no_store = save_mod._WebStore.__new__(save_mod._WebStore)
    no_store._ls = None
    s2 = save_mod.SaveData(tmp / "unused2.json")
    s2.store = no_store
    s2.data = save_mod._defaults()
    s2.mark()
    check(s2.flush() is False, "an unwritable store gives up instead of erroring")
    check(s2.readonly, "and latches, so it does not retry every scene change")
    s2.data["high_scores"]["classic"] = 10
    check(s2.high_score("classic") == 10, "the game still plays with no persistence")

    # ── the async frame driver ───────────────────────────────────────────────
    # No pygame.quit() here. Tearing the session down mid-suite invalidated every cached font
    # and surface, and the tests that ran afterwards failed with an error about the font module
    # having quit — a fault in this harness that looked exactly like a fault in the game.
    app = _fresh_app(tmp / "web-app.json")
    if True:
        app.on_web = True
        app.save.settings["fullscreen"] = False
        app.toggle_fullscreen()
        check(app.save.settings["fullscreen"] is False,
              "fullscreen is a no-op on the web, where the page owns the canvas")

        from .scenes.menu import MenuScene
        frames_before = app.frame
        asyncio.run(app.run_async(MenuScene(app), max_frames=frames_before + 45))
        check(app.frame >= frames_before + 45, "the async driver advances frames",
              f"{app.frame - frames_before} frames")
        check(not app.running, "the async driver stops when asked")

    # ── the packed archive the browser will actually download ────────────────
    import tarfile
    from pathlib import Path as _P

    archive = _P(__file__).resolve().parent.parent / "build" / "web" / "neoncoil.tar.gz"
    if archive.exists():
        with tarfile.open(archive) as tar:
            names = tar.getnames()
        modules = [n for n in names if n.endswith(".py")]
        check(any(n.endswith("assets/main.py") for n in names),
              "the web archive has an entry point", f"{len(names)} entries")
        for want in ("app.py", "snake.py", "play.py", "selftest.py"):
            if not check(any(n.endswith(want) for n in modules), f"the archive carries {want}"):
                break
        check(len(modules) >= 28, "every module is packed", f"{len(modules)} python files")
    else:
        check(False, "the web archive exists", "run: python -m pygbag --build .")


# ── entry points ────────────────────────────────────────────────────────────
def run_selftest() -> int:
    import tempfile

    print("\x1b[1mNEON COIL — self test\x1b[0m")
    t0 = time.perf_counter()

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        _test_assets()
        _test_audio()
        _test_snake()
        _test_save(tmp)
        _test_web_paths(tmp)

        app = _fresh_app(tmp / "app.json")
        try:
            _test_gameplay(app, tmp)
            _test_powers(app, tmp)
            _test_deaths(app, tmp)
            _test_modes(app, tmp)
            _test_scenes(app, tmp)
            _test_resize(app)
            _test_performance(app, tmp)
            _test_long_run(app, tmp)
        finally:
            pygame.quit()

    elapsed = time.perf_counter() - t0
    print()
    if FAILS:
        print(f"\x1b[31m\x1b[1m{len(FAILS)} of {CHECKS} checks failed\x1b[0m  "
              f"\x1b[2min {elapsed:.1f}s\x1b[0m")
        for f in FAILS:
            print(f"  \x1b[31m·\x1b[0m {f}")
        return 1
    print(f"\x1b[32m\x1b[1mall {CHECKS} checks passed\x1b[0m  \x1b[2min {elapsed:.1f}s\x1b[0m")
    return 0


def capture_shots(out_dir: str) -> int:
    """Render every screen to PNG so the art can be reviewed as images."""
    import tempfile

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        app = _fresh_app(Path(td) / "shots.json")
        # A save with some progress, so the menus are not all empty zeros.
        app.save.data["high_scores"] = {"classic": 18400, "time": 9250, "challenge": 4100}
        app.save.data["best_length"] = 96
        app.save.data["best_combo"] = 7
        app.save.data["games_played"] = 34
        app.save.data["total_food"] = 412
        app.save.data["challenge_best"] = 4
        app.save.refresh_unlocks()

        surf = pygame.Surface((1280, 720))
        shots: list[tuple[str, object]] = []

        from .scenes.menu import MenuScene
        from .scenes.modes import ModesScene
        from .scenes.play import GameOverScene, PauseScene, PlayScene
        from .scenes.settings import SettingsScene
        from .scenes.skins import SkinsScene
        from .scenes.splash import SplashScene

        def shoot(name, scene, seconds, keys=()):
            scene.enter()
            _step(app, scene, seconds, keys=keys)
            surf.fill((0, 0, 0))
            scene.draw(surf)
            pygame.image.save(surf, str(out / f"{name}.png"))
            print(f"  wrote {name}.png")

        shoot("01-splash", SplashScene(app), 1.6)
        shoot("02-menu", MenuScene(app), 1.2)
        shoot("03-modes", ModesScene(app), 1.2)
        shoot("04-skins", SkinsScene(app), 1.2)
        shoot("05-settings", SettingsScene(app), 1.2)

        # Gameplay, developed a little so there is something to look at.
        play = PlayScene(app)
        play.enter(mode_key="classic")
        _step(app, play, 1.3)
        play.snake.target_segments = play.snake.segments = 54.0
        play.score = 12480
        play.level = 7
        play.food_total = 34
        play.food_toward_level = 3
        play.combo = 6
        play.combo_timer = 2.4
        play.combo_best = 6
        play.active.activate("magnet")
        play.active.activate("shield")
        play.active.activate("double")
        play.obstacles.sync_to_level(9, play.snake, play.field)
        for ob in play.obstacles.items:
            ob.spawn = 1.0
        _step(app, play, 0.8, keys=[pygame.K_RIGHT])
        for p in play.field.items:
            p.scale = 1.0
        play.particles.ring((play.snake.x + 90, play.snake.y - 40), 22,
                            (255, 140, 170), radius_speed=(120, 220))
        play.floaters.add(play.snake.x + 60, play.snake.y - 50, "+180", (255, 202, 64), 30)
        _step(app, play, 0.10)
        surf.fill((0, 0, 0))
        play.draw(surf)
        pygame.image.save(surf, str(out / "06-play-classic.png"))
        print("  wrote 06-play-classic.png")

        # Time attack and challenge HUDs.
        for name, mode_key in (("07-play-time", "time"), ("08-play-challenge", "challenge")):
            p2 = PlayScene(app)
            p2.enter(mode_key=mode_key)
            _step(app, p2, 1.4)
            p2.snake.target_segments = p2.snake.segments = 34.0
            p2.score = 6200
            p2.food_total = 5
            p2.time_left = 41.6
            p2.obstacles.sync_to_level(6, p2.snake, p2.field)
            for ob in p2.obstacles.items:
                ob.spawn = 1.0
            _step(app, p2, 0.6, keys=[pygame.K_DOWN])
            for pk in p2.field.items:
                pk.scale = 1.0
            surf.fill((0, 0, 0))
            p2.draw(surf)
            pygame.image.save(surf, str(out / f"{name}.png"))
            print(f"  wrote {name}.png")

        # Pause, over the live arena.
        pause = PauseScene(app)
        pause.enter(play=play)
        _step(app, pause, 0.6)
        surf.fill((0, 0, 0))
        play.draw(surf)
        pause.draw(surf)
        pygame.image.save(surf, str(out / "09-pause.png"))
        print("  wrote 09-pause.png")

        # Game over, with a fresh best and an unlock to celebrate.
        play._result = app.save.record_run("classic", 26400, 96, 7, 41)
        play.death_cause = "self"
        play.score = 26400
        play.combo_best = 7
        play.coins = 12
        play.gems = 4
        over = GameOverScene(app)
        over.enter(play=play)
        _step(app, over, 1.1)
        surf.fill((0, 0, 0))
        play.draw(surf)
        over.draw(surf)
        pygame.image.save(surf, str(out / "10-gameover.png"))
        print("  wrote 10-gameover.png")

        pygame.quit()
    return 0
