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
WEB_KEY = "neoncoil.save.v1"


def save_dir() -> Path:
    """Where the save lives.

    Under the user's profile rather than next to the code, so the game still saves when it has
    been unzipped somewhere read-only, and so two copies of the project share progress.
    """
    base = os.environ.get("APPDATA") or os.environ.get("XDG_DATA_HOME")
    root = Path(base) if base else Path.home() / ".local" / "share"
    return root / "NeonCoil"


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
        "high_scores": {"classic": 0, "time": 0, "challenge": 0},
        "best_length": 0,
        "best_combo": 0,
        "total_score": 0,
        "games_played": 0,
        "total_food": 0,
        "unlocked_skins": [s.key for s in theme.SKINS if s.unlock_score == 0],
        "skin": theme.DEFAULT_SKIN,
        "last_mode": theme.DEFAULT_MODE,
        "challenge_best": 0,
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

        unlocked = self.data.get("unlocked_skins")
        if not isinstance(unlocked, list):
            unlocked = []
        valid = {s.key for s in theme.SKINS}
        unlocked = [k for k in unlocked if k in valid]
        for s in theme.SKINS:
            if s.unlock_score == 0 and s.key not in unlocked:
                unlocked.append(s.key)
        self.data["unlocked_skins"] = unlocked

        if self.data.get("skin") not in unlocked:
            self.data["skin"] = theme.DEFAULT_SKIN
        if self.data.get("last_mode") not in theme.MODES_BY_KEY:
            self.data["last_mode"] = theme.DEFAULT_MODE

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

    def skin_unlocked(self, key: str) -> bool:
        return key in self.data["unlocked_skins"]

    def select_skin(self, key: str) -> None:
        if self.skin_unlocked(key) and self.data["skin"] != key:
            self.data["skin"] = key
            self.mark()

    def refresh_unlocks(self) -> list:
        """Unlock any skin whose threshold the player's best score has passed.

        Returns the skins unlocked by THIS call so the UI can celebrate them. Measured against
        the best score across all modes: a skin earned in Time Attack should not be invisible
        to someone who only plays Classic.
        """
        best = self.best_overall()
        newly = []
        for s in theme.SKINS:
            if s.unlock_score and best >= s.unlock_score and s.key not in self.data["unlocked_skins"]:
                self.data["unlocked_skins"].append(s.key)
                newly.append(s)
        if newly:
            self.mark()
        return newly

    def record_run(self, mode_key: str, score: int, length: int, combo: int,
                   food: int, objectives: int = 0) -> dict:
        """Fold one finished run into lifetime stats. Returns what was beaten, for the UI."""
        result = {"new_high": False, "new_length": False, "new_combo": False, "unlocked": []}

        prev = self.high_score(mode_key)
        if score > prev:
            self.data["high_scores"][mode_key] = int(score)
            result["new_high"] = True
        if length > int(self.data.get("best_length", 0)):
            self.data["best_length"] = int(length)
            result["new_length"] = True
        if combo > int(self.data.get("best_combo", 0)):
            self.data["best_combo"] = int(combo)
            result["new_combo"] = True
        if mode_key == "challenge" and objectives > int(self.data.get("challenge_best", 0)):
            self.data["challenge_best"] = int(objectives)

        self.data["total_score"] = int(self.data.get("total_score", 0)) + int(score)
        self.data["games_played"] = int(self.data.get("games_played", 0)) + 1
        self.data["total_food"] = int(self.data.get("total_food", 0)) + int(food)
        self.data["last_mode"] = mode_key
        self.mark()

        result["unlocked"] = self.refresh_unlocks()
        self.flush()
        return result
