"""
Procedural sound. No audio files, same as there are no image files.

Every effect is synthesised into a numpy buffer at startup and handed to pygame's mixer. The
whole bank is a few hundred kilobytes of float maths and takes well under a second to build.

The hard requirement is that audio can never break the game. Machines with no sound card,
locked audio devices, remote sessions and headless CI all fail at `mixer.init()`, and a game
that raises on launch because it could not open a speaker is broken in a way that matters far
more than silence. So initialisation is wrapped, `enabled` latches to False on any failure,
and every entry point is a no-op from then on. The rest of the codebase calls `sfx.eat()`
without ever checking.

Sound design notes, since these are being invented rather than recorded:

* Pickups are short, bright and pitched. Pitch rises with the combo multiplier, which turns
  the score chain into an audible one and is most of why chaining feels good.
* Nothing is a pure sine. Every voice gets a little detuning or a second partial, because a
  clean sine reads as a test tone.
* Everything is enveloped. A tone that starts instantly clicks; a tone that stops instantly
  clicks louder.

Without numpy — which is the WebAssembly build, where pygbag publishes no wheel for its own
runtime version — there is a smaller pure-Python bank instead. The effects are the same shapes
built with `math.sin` into an `array('h')` and handed to `pygame.mixer.Sound(buffer=...)`, which
needs no numpy at all. The ambient pad is skipped on that path and only there: it is eight
seconds of five detuned voices, about 1.7 million samples, and generating it in a Python loop
would stall startup for several seconds to add a texture most players would not name. Every
effect the game reacts with still plays.
"""

from __future__ import annotations

import math
from array import array

import pygame

try:
    import numpy as np
    HAVE_NUMPY = True
except ImportError:  # pragma: no cover - exercised only where no wheel exists
    np = None
    HAVE_NUMPY = False

SAMPLE_RATE = 44100

_enabled = False
_bank: dict[str, "pygame.mixer.Sound"] = {}
_music = None
_settings = {"sfx": True, "music": True, "volume": 0.7}


# ── pure-python synthesis (no numpy) ────────────────────────────────────────
def _py_env(n: int, attack: float, decay: float, sustain: float, release: float) -> list:
    """The same four-stage envelope as `_env`, as a list."""
    a = max(1, int(SAMPLE_RATE * attack))
    d = max(1, int(SAMPLE_RATE * decay))
    r = max(1, int(SAMPLE_RATE * release))
    if a + d + r > n:
        scale = n / float(a + d + r)
        a, d, r = max(1, int(a * scale)), max(1, int(d * scale)), max(1, int(r * scale))
    sus = max(0, n - a - d - r)
    env = [i / a for i in range(a)]
    env += [1.0 + (sustain - 1.0) * (i / d) for i in range(d)]
    env += [sustain] * sus
    env += [sustain * (1.0 - i / r) for i in range(r)]
    if len(env) < n:
        env += [0.0] * (n - len(env))
    return env[:n]


def _py_voice(f0: float, f1: float, duration: float, kind: str, detune: float,
              env: tuple) -> list:
    """One glide from f0 to f1. Phase is integrated, so a sweep lands on the right pitch."""
    n = max(1, int(SAMPLE_RATE * duration))
    e = _py_env(n, *env)
    out = [0.0] * n
    phase = 0.0
    phase2 = 0.0
    step = 1.0 / SAMPLE_RATE
    for i in range(n):
        f = f0 + (f1 - f0) * (i / n)
        phase += 2.0 * math.pi * f * step
        if kind == "saw":
            v = 2.0 * ((phase / (2.0 * math.pi)) % 1.0) - 1.0
        elif kind == "square":
            v = 1.0 if math.sin(phase) >= 0 else -1.0
        elif kind == "tri":
            v = 2.0 / math.pi * math.asin(max(-1.0, min(1.0, math.sin(phase))))
        else:
            v = math.sin(phase)
        if detune:
            phase2 += 2.0 * math.pi * f * (1.0 + detune) * step
            v = 0.6 * v + 0.4 * math.sin(phase2)
        out[i] = v * e[i]
    return out


def _py_noise(duration: float, seed: int, lp: float) -> list:
    """Low-passed pseudo-noise from a linear congruential generator."""
    n = max(1, int(SAMPLE_RATE * duration))
    out = [0.0] * n
    state = (seed * 1103515245 + 12345) & 0x7FFFFFFF
    acc = 0.0
    for i in range(n):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        v = (state / 0x3FFFFFFF) - 1.0
        acc += lp * (v - acc)
        out[i] = acc
    return out


def _py_make(parts, gain: float):
    """Mix, normalise, fade the edges, and hand a 16-bit stereo buffer to the mixer."""
    n = max(len(p) for p in parts)
    mix = [0.0] * n
    for p in parts:
        for i, v in enumerate(p):
            mix[i] += v
    peak = max((abs(v) for v in mix), default=1.0) or 1.0
    scale = gain / peak
    edge = min(160, n // 8)
    buf = array("h", bytes(4 * n))
    for i in range(n):
        v = mix[i] * scale
        if edge > 2:
            if i < edge:
                v *= i / edge
            elif i >= n - edge:
                v *= (n - 1 - i) / edge
        s = int(max(-1.0, min(1.0, v)) * 32767)
        buf[i * 2] = s
        buf[i * 2 + 1] = s
    return pygame.mixer.Sound(buffer=buf.tobytes())


# ── synthesis helpers (numpy) ───────────────────────────────────────────────
def _t(duration: float) -> np.ndarray:
    return np.linspace(0.0, duration, max(1, int(SAMPLE_RATE * duration)), endpoint=False,
                       dtype=np.float32)


def _env(n: int, attack: float = 0.005, decay: float = 0.06,
         sustain: float = 0.0, release: float = 0.05) -> np.ndarray:
    """A four-stage envelope, sized to fit whatever length the caller has.

    Proportional rather than absolute: asking for a 40 ms attack on a 30 ms blip should give a
    short attack, not an error or a click.
    """
    a = max(1, int(SAMPLE_RATE * attack))
    d = max(1, int(SAMPLE_RATE * decay))
    r = max(1, int(SAMPLE_RATE * release))
    s = max(0, n - a - d - r)
    if a + d + s + r > n:
        scale = n / float(a + d + r)
        a, d, r = max(1, int(a * scale)), max(1, int(d * scale)), max(1, int(r * scale))
        s = max(0, n - a - d - r)
    env = np.concatenate([
        np.linspace(0.0, 1.0, a, dtype=np.float32),
        np.linspace(1.0, sustain, d, dtype=np.float32),
        np.full(s, sustain, dtype=np.float32),
        np.linspace(sustain, 0.0, r, dtype=np.float32),
    ])
    if env.size < n:
        env = np.pad(env, (0, n - env.size))
    return env[:n]


def _tone(freq, duration: float, kind: str = "sine", detune: float = 0.0) -> np.ndarray:
    """One voice. `freq` may be a scalar or an array the same length as the buffer (a sweep)."""
    t = _t(duration)
    f = np.asarray(freq, dtype=np.float32)
    if f.ndim == 0:
        phase = 2.0 * np.pi * f * t
    else:
        if f.size != t.size:
            f = np.interp(np.linspace(0, 1, t.size), np.linspace(0, 1, f.size), f).astype(np.float32)
        # Integrate frequency to phase, or a glide comes out at the wrong pitch entirely.
        phase = 2.0 * np.pi * np.cumsum(f) / SAMPLE_RATE

    if kind == "square":
        wave = np.sign(np.sin(phase)).astype(np.float32)
    elif kind == "saw":
        wave = (2.0 * ((phase / (2 * np.pi)) % 1.0) - 1.0).astype(np.float32)
    elif kind == "tri":
        wave = (2.0 / np.pi * np.arcsin(np.sin(phase))).astype(np.float32)
    else:
        wave = np.sin(phase).astype(np.float32)

    if detune:
        wave = 0.6 * wave + 0.4 * np.sin(phase * (1.0 + detune)).astype(np.float32)
    return wave


def _noise(duration: float, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.uniform(-1.0, 1.0, max(1, int(SAMPLE_RATE * duration))).astype(np.float32)


def _lowpass(x: np.ndarray, alpha: float = 0.16) -> np.ndarray:
    """One-pole filter. Takes the fizz off white noise so it reads as air, not static."""
    out = np.empty_like(x)
    acc = 0.0
    for i in range(x.size):
        acc += alpha * (x[i] - acc)
        out[i] = acc
    return out


def _mix(*parts) -> np.ndarray:
    n = max(p.size for p in parts)
    acc = np.zeros(n, dtype=np.float32)
    for p in parts:
        acc[:p.size] += p
    return acc


def _make(buf: np.ndarray, gain: float = 0.5):
    """Normalise, apply gain, convert to 16-bit stereo, hand to the mixer."""
    peak = float(np.max(np.abs(buf))) or 1.0
    mono = (buf / peak) * gain
    # A short fade at both ends: even an enveloped buffer can start on a non-zero sample.
    edge = min(160, mono.size // 8)
    if edge > 2:
        mono[:edge] *= np.linspace(0.0, 1.0, edge, dtype=np.float32)
        mono[-edge:] *= np.linspace(1.0, 0.0, edge, dtype=np.float32)
    stereo = np.ascontiguousarray(np.stack([mono, mono], axis=1) * 32767.0).astype(np.int16)
    return pygame.sndarray.make_sound(stereo)


# ── the bank ────────────────────────────────────────────────────────────────
def _build_bank_py() -> None:
    """The same effects, built without numpy.

    Deliberately the same shapes and roughly the same durations, so the game sounds like itself
    rather than like a degraded mode. Total cost is about 110,000 samples of Python arithmetic —
    a fraction of a second, and it happens once behind a loading screen.
    """
    # Twelve pre-pitched pickup blips, so combo pitch is a lookup and not a synth call mid-frame.
    for i in range(12):
        f = 520.0 * (2 ** (i / 12.0))
        _bank[f"eat{i}"] = _py_make([
            _py_voice(f, f, 0.11, "tri", 0.008, (0.003, 0.05, 0.25, 0.05)),
            [v * 0.35 for v in _py_voice(f * 2.0, f * 2.0, 0.11, "sine", 0.0,
                                         (0.002, 0.03, 0.0, 0.03))],
        ], 0.34)

    _bank["coin"] = _py_make([
        _py_voice(1180.0, 1180.0, 0.20, "tri", 0.0, (0.002, 0.09, 0.12, 0.08)),
        [v * 0.5 for v in _py_voice(1760.0, 1760.0, 0.20, "sine", 0.0, (0.002, 0.05, 0.05, 0.10))],
    ], 0.36)

    # Prism: a rising arpeggio, offset into one buffer.
    parts = []
    for i, mult in enumerate((1.0, 1.26, 1.5, 2.0)):
        seg = _py_voice(660.0 * mult, 660.0 * mult, 0.09, "tri", 0.01, (0.003, 0.04, 0.15, 0.04))
        parts.append([0.0] * int(SAMPLE_RATE * 0.055 * i) + seg)
    _bank["gem"] = _py_make(parts, 0.4)

    _bank["power"] = _py_make([
        [v * 0.7 for v in _py_voice(300.0, 1150.0, 0.34, "saw", 0.0, (0.01, 0.10, 0.35, 0.14))],
        [v * 0.3 for v in _py_voice(600.0, 2300.0, 0.34, "sine", 0.0, (0.05, 0.12, 0.20, 0.14))],
    ], 0.34)

    death_noise = _py_noise(0.62, 7, 0.05)
    death_env = _py_env(len(death_noise), 0.002, 0.16, 0.06, 0.42)
    _bank["death"] = _py_make([
        _py_voice(420.0, 62.0, 0.62, "saw", 0.02, (0.004, 0.30, 0.22, 0.30)),
        [death_noise[i] * death_env[i] * 0.6 for i in range(len(death_noise))],
    ], 0.42)

    sh_noise = _py_noise(0.30, 3, 0.30)
    sh_env = _py_env(len(sh_noise), 0.001, 0.06, 0.0, 0.10)
    _bank["shield"] = _py_make([
        _py_voice(880.0, 880.0, 0.30, "sine", 0.03, (0.002, 0.14, 0.10, 0.14)),
        [sh_noise[i] * sh_env[i] * 0.5 for i in range(len(sh_noise))],
    ], 0.38)

    parts = []
    for i, mult in enumerate((1.0, 1.25, 1.5, 2.0)):
        seg = _py_voice(440.0 * mult, 440.0 * mult, 0.42, "tri", 0.006, (0.008, 0.16, 0.30, 0.20))
        parts.append([0.0] * int(SAMPLE_RATE * 0.07 * i) + seg)
    _bank["level"] = _py_make(parts, 0.34)

    cl_noise = _py_noise(0.07, 11, 0.4)
    cl_env = _py_env(len(cl_noise), 0.001, 0.02, 0.0, 0.02)
    _bank["click"] = _py_make([
        _py_voice(640.0, 640.0, 0.07, "tri", 0.0, (0.001, 0.03, 0.0, 0.03)),
        [cl_noise[i] * cl_env[i] * 0.35 for i in range(len(cl_noise))],
    ], 0.26)
    _bank["move"] = _py_make([
        _py_voice(920.0, 920.0, 0.05, "sine", 0.0, (0.001, 0.02, 0.0, 0.02)),
    ], 0.16)
    _bank["combo"] = _py_make([
        _py_voice(700.0, 1400.0, 0.13, "tri", 0.0, (0.002, 0.06, 0.1, 0.05)),
    ], 0.28)


def _build_bank() -> None:
    # Pickups: a two-partial blip. Twelve semitone steps are pre-rendered so combo pitch is a
    # lookup rather than a synth call in the middle of a frame.
    for i in range(12):
        f = 520.0 * (2 ** (i / 12.0))
        n = int(SAMPLE_RATE * 0.11)
        body = _tone(f, 0.11, "tri", detune=0.008) * _env(n, 0.003, 0.05, 0.25, 0.05)
        shine = _tone(f * 2.0, 0.11, "sine") * _env(n, 0.002, 0.03, 0.0, 0.03) * 0.35
        _bank[f"eat{i}"] = _make(_mix(body, shine), 0.34)

    # Spark: a metallic double-ping.
    n = int(SAMPLE_RATE * 0.20)
    coin = _mix(
        _tone(1180.0, 0.20, "tri") * _env(n, 0.002, 0.09, 0.12, 0.08),
        _tone(1760.0, 0.20, "sine") * _env(n, 0.002, 0.05, 0.05, 0.10) * 0.5,
    )
    _bank["coin"] = _make(coin, 0.36)

    # Prism: a rising arpeggio, so a rare pickup sounds rare.
    parts = []
    for i, mult in enumerate((1.0, 1.26, 1.5, 2.0)):
        seg = _tone(660.0 * mult, 0.09, "tri", detune=0.01)
        seg = seg * _env(seg.size, 0.003, 0.04, 0.15, 0.04)
        parts.append(np.pad(seg, (int(SAMPLE_RATE * 0.055 * i), 0)))
    _bank["gem"] = _make(_mix(*parts), 0.4)

    # Power-up: an upward sweep with a shimmer on top.
    n = int(SAMPLE_RATE * 0.34)
    sweep = np.linspace(300.0, 1150.0, n, dtype=np.float32)
    _bank["power"] = _make(_mix(
        _tone(sweep, 0.34, "saw") * _env(n, 0.01, 0.10, 0.35, 0.14) * 0.7,
        _tone(sweep * 2.0, 0.34, "sine") * _env(n, 0.05, 0.12, 0.20, 0.14) * 0.3,
    ), 0.34)

    # Death: a descending detuned tone under a burst of filtered noise.
    n = int(SAMPLE_RATE * 0.62)
    fall = np.linspace(420.0, 62.0, n, dtype=np.float32)
    _bank["death"] = _make(_mix(
        _tone(fall, 0.62, "saw", detune=0.02) * _env(n, 0.004, 0.30, 0.22, 0.30),
        _lowpass(_noise(0.62, 7), 0.05) * _env(n, 0.002, 0.16, 0.06, 0.42) * 0.6,
    ), 0.42)

    # Shield absorbing a hit: a bright, short glassy hit.
    n = int(SAMPLE_RATE * 0.30)
    _bank["shield"] = _make(_mix(
        _tone(880.0, 0.30, "sine", detune=0.03) * _env(n, 0.002, 0.14, 0.10, 0.14),
        _lowpass(_noise(0.30, 3), 0.30) * _env(n, 0.001, 0.06, 0.0, 0.10) * 0.5,
    ), 0.38)

    # Level up: a major triad, played as a flourish.
    parts = []
    for i, mult in enumerate((1.0, 1.25, 1.5, 2.0)):
        seg = _tone(440.0 * mult, 0.42, "tri", detune=0.006)
        seg = seg * _env(seg.size, 0.008, 0.16, 0.30, 0.20)
        parts.append(np.pad(seg, (int(SAMPLE_RATE * 0.07 * i), 0)))
    _bank["level"] = _make(_mix(*parts), 0.34)

    # UI: a soft click and a quieter tick for moving the selection.
    n = int(SAMPLE_RATE * 0.07)
    _bank["click"] = _make(_mix(
        _tone(640.0, 0.07, "tri") * _env(n, 0.001, 0.03, 0.0, 0.03),
        _lowpass(_noise(0.07, 11), 0.4) * _env(n, 0.001, 0.02, 0.0, 0.02) * 0.35,
    ), 0.26)
    n = int(SAMPLE_RATE * 0.05)
    _bank["move"] = _make(_tone(920.0, 0.05, "sine") * _env(n, 0.001, 0.02, 0.0, 0.02), 0.16)

    # Combo tick: a bright confirmation stacked on top of the pickup sound.
    n = int(SAMPLE_RATE * 0.13)
    _bank["combo"] = _make(_mix(
        _tone(np.linspace(700.0, 1400.0, n, dtype=np.float32), 0.13, "tri") * _env(n, 0.002, 0.06, 0.1, 0.05),
    ), 0.28)


def _build_music() -> None:
    """A slow, wide pad that loops seamlessly.

    Eight bars of a minor-ninth voicing with a gentle detune beat. Deliberately almost featureless
    — this sits under the entire game and anything with a melody would wear through in a minute.
    """
    bars = 8.0
    n = int(SAMPLE_RATE * bars)
    t = np.linspace(0.0, bars, n, endpoint=False, dtype=np.float32)

    root = 110.0
    voices = (1.0, 1.5, 1.8, 2.4, 3.0)
    pad = np.zeros(n, dtype=np.float32)
    for i, mult in enumerate(voices):
        f = root * mult
        detune = 1.0 + 0.0016 * (i - 2)
        # Each voice breathes on its own slow cycle so the chord never sits still.
        amp = 0.22 + 0.16 * np.sin(2 * np.pi * (t / bars) * (i + 1) + i)
        pad += (np.sin(2 * np.pi * f * detune * t) * amp).astype(np.float32)

    # A soft pulse on the beat, low in the mix — enough to imply tempo without being drums.
    beat = np.sin(2 * np.pi * 55.0 * t) * np.clip(np.sin(2 * np.pi * t * 2.0), 0, 1) ** 6 * 0.30
    pad += beat.astype(np.float32)

    # Crossfade the tail into the head so the loop point is inaudible.
    fade = int(SAMPLE_RATE * 0.9)
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    pad[:fade] = pad[:fade] * ramp + pad[-fade:] * (1.0 - ramp)
    pad = pad[:-fade]

    global _music
    _music = _make(pad, 0.16)


def init(settings: dict | None = None) -> bool:
    """Bring audio up. Returns whether it succeeded; callers are not expected to care."""
    global _enabled
    if settings:
        _settings.update({k: settings[k] for k in ("sfx", "music", "volume") if k in settings})
    try:
        pygame.mixer.pre_init(SAMPLE_RATE, -16, 2, 512)
        pygame.mixer.init()
        pygame.mixer.set_num_channels(24)
        if HAVE_NUMPY:
            _build_bank()
            _build_music()
        else:
            # No pad on this path — see the note at the top of the module.
            _build_bank_py()
        _enabled = True
    except Exception:
        # No device, no permission, unsupported format — all of it is survivable.
        _enabled = False
    return _enabled


def apply_settings(settings: dict) -> None:
    _settings.update({k: settings[k] for k in ("sfx", "music", "volume") if k in settings})
    if not _enabled:
        return
    if _settings["music"]:
        start_music()
    else:
        stop_music()


def _play(name: str, gain: float = 1.0) -> None:
    if not _enabled or not _settings["sfx"]:
        return
    snd = _bank.get(name)
    if snd is None:
        return
    snd.set_volume(max(0.0, min(1.0, _settings["volume"] * gain)))
    snd.play()


# ── the API the game actually calls ─────────────────────────────────────────
def eat(step: int = 0) -> None:
    _play(f"eat{max(0, min(11, int(step)))}")


def coin() -> None:
    _play("coin")


def gem() -> None:
    _play("gem", 0.95)


def power() -> None:
    _play("power")


def death() -> None:
    _play("death")


def shield() -> None:
    _play("shield")


def level_up() -> None:
    _play("level")


def click() -> None:
    _play("click")


def move() -> None:
    _play("move", 0.8)


def combo() -> None:
    _play("combo", 0.8)


def start_music() -> None:
    if not _enabled or _music is None or not _settings["music"]:
        return
    try:
        ch = pygame.mixer.Channel(0)
        if not ch.get_busy():
            _music.set_volume(max(0.0, min(1.0, _settings["volume"] * 0.5)))
            ch.play(_music, loops=-1)
        else:
            _music.set_volume(max(0.0, min(1.0, _settings["volume"] * 0.5)))
    except pygame.error:
        pass


def stop_music() -> None:
    if not _enabled:
        return
    try:
        pygame.mixer.Channel(0).stop()
    except pygame.error:
        pass


def duck_music(on: bool) -> None:
    """Pull the pad down under menus and the game-over screen."""
    if not _enabled or _music is None:
        return
    base = _settings["volume"] * 0.5
    _music.set_volume(max(0.0, min(1.0, base * (0.45 if on else 1.0))))


def is_enabled() -> bool:
    return _enabled
