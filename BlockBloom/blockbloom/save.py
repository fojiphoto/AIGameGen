"""
Persistent player state: high scores, unlocked skins, settings, lifetime progression.

Design rules this file holds to, because a save system that loses data or crashes a launch is
worse than no save system at all:

* It always returns a usable state. A missing file, an empty file, a truncated file, a file
  full of the wrong types, or a directory the user cannot write to all resolve to defaults
  rather than an exception, and the game never blocks on it.
* Writes are atomic. The file is written to a sibling temp path and then replaced, so a crash
  or a power cut during a save cannot leave a half-written JSON that fails to parse next time.
* Unknown keys from a future version are preserved. Downgrading and re-upgrading does not
  silently wipe progress the older build did not understand.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from . import theme

SAVE_VERSION = 1

#: True inside the WebAssembly build.
ON_WEB = sys.platform == "emscripten"
#: localStorage key used by the web build.
WEB_KEY = "blockbloom.save.v1"


def save_dir() -> Path:
    """Where the save lives.

    Under the user's profile rather than next to the code, so the game still saves when it has
    been unzipped somewhere read-only, and so two copies of the project share progress.
    """
    base = os.environ.get("APPDATA") or os.environ.get("XDG_DATA_HOME")
    root = Path(base) if base else Path.home() / ".local" / "share"
    return root / "BlockBloom"


class _FileStore:
    """Desktop backend: an atomically-replaced JSON file."""

    def __init__(self, path: Path):
        self.path = path

    def read(self) -> str | None:
        try:
            return self.path.read_text(encoding="utf-8")
        except OSError:
            return None

    def write(self, text: str) -> bool:
        """Atomic: temp file in the same directory, then `os.replace`.

        Writing in place risks a truncated file if the process dies mid-write, and a truncated
        save is indistinguishable from a corrupt one.
        """
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".save-", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(text)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError:
            return False
        return True

    def describe(self) -> str:
        return str(self.path)


class _WebStore:
    """Browser backend: `window.localStorage`.

    The WebAssembly filesystem is a virtual one that is discarded when the tab closes, so
    writing a file there would look like it worked and lose every score. localStorage is the
    one store that is actually persistent, shared across reloads, and available without asking
    the player for anything.

    Every call is guarded. If the browser has storage disabled, or the page is in a context
    where localStorage throws on access, the game carries on with progress that lasts for the
    session — which is strictly better than refusing to start.
    """

    def __init__(self):
        self._ls = None
        try:
            import platform as _platform  # pygbag replaces this with a JS bridge
            self._ls = _platform.window.localStorage
        except Exception:
            self._ls = None

    def read(self) -> str | None:
        if self._ls is None:
            return None
        try:
            value = self._ls.getItem(WEB_KEY)
        except Exception:
            return None
        return value or None

    def write(self, text: str) -> bool:
        if self._ls is None:
            return False
        try:
            self._ls.setItem(WEB_KEY, text)
        except Exception:
            return False
        return True

    def describe(self) -> str:
        return f"localStorage[{WEB_KEY}]" if self._ls else "memory (storage unavailable)"


def _defaults() -> dict:
    return {
        "version": SAVE_VERSION,
        "high_scores": {m.key: 0 for m in theme.MODES},
        "best_combo": 0,
        "best_lines": 0,
        "best_simultaneous": 0,
        "total_score": 0,
        "total_lines": 0,
        "games_played": 0,
        "coins": 0,
        # The first theme is free; the rest are the reward loop. Derived from the palettes rather
        # than listed, so adding a free theme does not also need a save migration.
        "unlocked_themes": [p.key for p in theme.PALETTES if p.cost == 0],
        "theme": theme.DEFAULT_THEME,
        "last_mode": theme.DEFAULT_MODE,
        # Index of the next objective to attempt. Stored rather than derived, because objectives
        # are a ladder and "which rung" is the whole of the progression.
        "challenge_index": 0,
        "tutorial_done": False,
        "settings": {
            "sfx": True,
            "music": True,
            "volume": 0.7,
            "shake": True,
            "particles": True,
            "fullscreen": False,
            "show_fps": False,
        },
    }


class SaveData:
    """A dict-backed save with typed accessors and a best-effort write.

    `dirty` exists so scenes can call `mark()` freely — the actual disk write happens once, on
    a natural boundary (leaving a scene, quitting), instead of on every score change.
    """

    def __init__(self, path: Path | None = None):
        # An explicit path always means the file backend — that is what the test harness uses to
        # keep a run away from real progress, and it must behave the same on every platform.
        if path is None and ON_WEB:
            self.store = _WebStore()
            self.path = None
        else:
            self.path = path or (save_dir() / "save.json")
            self.store = _FileStore(self.path)
        self.data = _defaults()
        self.dirty = False
        self.readonly = False
        self.load()

    # ── storage ─────────────────────────────────────────────────────────────
    def load(self) -> None:
        text = self.store.read()
        if not text:
            return
        try:
            raw = json.loads(text)
        except ValueError:
            # Corrupt: start clean rather than dying on launch.
            return
        if not isinstance(raw, dict):
            return
        self._merge(raw)

    def _merge(self, raw: dict) -> None:
        """Overlay stored values onto the defaults, keeping anything we do not recognise.

        Merging rather than replacing means a save written by an older build — one that has no
        `challenge_best`, say — comes back with that key present and sane instead of raising a
        KeyError deep inside a scene.
        """
        for key, value in raw.items():
            base = self.data.get(key)
            if isinstance(base, dict) and isinstance(value, dict):
                base.update(value)
            elif key not in self.data or type(value) is type(base) or base is None:
                self.data[key] = value

        # Defensive normalisation: a hand-edited save should not be able to crash the game.
        hs = self.data.get("high_scores")
        if not isinstance(hs, dict):
            self.data["high_scores"] = _defaults()["high_scores"]
        else:
            for m in theme.MODES:
                try:
                    hs[m.key] = max(0, int(hs.get(m.key, 0)))
                except (TypeError, ValueError):
                    hs[m.key] = 0

        unlocked = self.data.get("unlocked_themes")
        if not isinstance(unlocked, list):
            unlocked = []
        valid = {p.key for p in theme.PALETTES}
        unlocked = [k for k in unlocked if k in valid]
        for p in theme.PALETTES:
            if p.cost == 0 and p.key not in unlocked:
                unlocked.append(p.key)
        self.data["unlocked_themes"] = unlocked

        if self.data.get("theme") not in unlocked:
            self.data["theme"] = theme.DEFAULT_THEME
        if self.data.get("last_mode") not in theme.MODES_BY_KEY:
            self.data["last_mode"] = theme.DEFAULT_MODE

        for key in ("coins", "challenge_index", "best_combo", "best_lines",
                    "best_simultaneous", "total_score", "total_lines", "games_played"):
            try:
                self.data[key] = max(0, int(self.data.get(key, 0)))
            except (TypeError, ValueError):
                self.data[key] = 0
        # A save claiming more objectives than exist would index off the end of the ladder.
        self.data["challenge_index"] = min(self.data["challenge_index"], len(theme.CHALLENGES))

        st = self.data.get("settings")
        if not isinstance(st, dict):
            self.data["settings"] = _defaults()["settings"]
        else:
            base = _defaults()["settings"]
            for k, v in base.items():
                if k not in st or not isinstance(st[k], type(v)):
                    st[k] = v
            st["volume"] = max(0.0, min(1.0, float(st["volume"])))

    def flush(self) -> bool:
        """Write if anything changed. Returns True on a successful write."""
        if not self.dirty or self.readonly:
            return False
        if not self.store.write(json.dumps(self.data, indent=1)):
            # Nowhere writable. Play on; just stop trying on every scene change.
            self.readonly = True
            return False
        self.dirty = False
        return True

    def mark(self) -> None:
        self.dirty = True

    # ── accessors ───────────────────────────────────────────────────────────
    @property
    def settings(self) -> dict:
        return self.data["settings"]

    def high_score(self, mode_key: str) -> int:
        return int(self.data["high_scores"].get(mode_key, 0))

    def best_overall(self) -> int:
        return max(self.data["high_scores"].values(), default=0)

    @property
    def coins(self) -> int:
        return int(self.data.get("coins", 0))

    def add_coins(self, n: int) -> None:
        if n:
            self.data["coins"] = max(0, self.coins + int(n))
            self.mark()

    # ── themes ──────────────────────────────────────────────────────────────
    def theme_unlocked(self, key: str) -> bool:
        return key in self.data["unlocked_themes"]

    def can_afford(self, key: str) -> bool:
        p = theme.PALETTES_BY_KEY.get(key)
        return bool(p) and self.coins >= p.cost

    def buy_theme(self, key: str) -> bool:
        """Spend coins to unlock a theme. Returns whether the purchase happened.

        Deliberately does not also select it: buying and wearing are two decisions, and silently
        restyling the whole game the instant a player can afford something is startling.
        """
        p = theme.PALETTES_BY_KEY.get(key)
        if p is None or self.theme_unlocked(key) or self.coins < p.cost:
            return False
        self.data["coins"] = self.coins - p.cost
        self.data["unlocked_themes"].append(key)
        self.mark()
        self.flush()
        return True

    def select_theme(self, key: str) -> bool:
        """Wear an unlocked theme. Applies it immediately so every screen follows."""
        if not self.theme_unlocked(key):
            return False
        if self.data.get("theme") != key:
            self.data["theme"] = key
            self.mark()
            self.flush()
        theme.apply(key)
        return True

    def apply_theme(self) -> None:
        """Point the live palette at whatever the save says. Called once at startup."""
        theme.apply(self.data.get("theme", theme.DEFAULT_THEME))

    # ── challenges ──────────────────────────────────────────────────────────
    @property
    def challenge_index(self) -> int:
        return int(self.data.get("challenge_index", 0))

    def current_objective(self):
        """The objective the player is on, or None once the ladder is finished."""
        i = self.challenge_index
        return theme.CHALLENGES[i] if i < len(theme.CHALLENGES) else None

    def complete_objective(self) -> int:
        """Advance the ladder and pay out. Returns the coins awarded."""
        obj = self.current_objective()
        if obj is None:
            return 0
        self.data["challenge_index"] = self.challenge_index + 1
        self.add_coins(obj.reward)
        self.mark()
        self.flush()
        return obj.reward

    # ── runs ────────────────────────────────────────────────────────────────
    def record_run(self, mode_key: str, *, score: int, combo: int, lines: int,
                   simultaneous: int, coins: int) -> dict:
        """Fold one finished run into lifetime stats. Returns what was beaten, for the UI."""
        result = {"new_high": False, "new_combo": False, "new_lines": False, "coins": int(coins)}

        if score > self.high_score(mode_key):
            self.data["high_scores"][mode_key] = int(score)
            result["new_high"] = True
        if combo > int(self.data.get("best_combo", 0)):
            self.data["best_combo"] = int(combo)
            result["new_combo"] = True
        if lines > int(self.data.get("best_lines", 0)):
            self.data["best_lines"] = int(lines)
            result["new_lines"] = True
        if simultaneous > int(self.data.get("best_simultaneous", 0)):
            self.data["best_simultaneous"] = int(simultaneous)

        self.data["total_score"] = int(self.data.get("total_score", 0)) + int(score)
        self.data["total_lines"] = int(self.data.get("total_lines", 0)) + int(lines)
        self.data["games_played"] = int(self.data.get("games_played", 0)) + 1
        self.data["last_mode"] = mode_key
        self.add_coins(coins)
        self.mark()
        self.flush()
        return result

    def finish_tutorial(self) -> None:
        if not self.data.get("tutorial_done"):
            self.data["tutorial_done"] = True
            self.mark()
            self.flush()
