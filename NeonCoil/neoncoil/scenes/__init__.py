"""Screens. Each is a `Scene`; the app keeps them on a stack."""

from .menu import MenuScene
from .modes import ModesScene
from .play import GameOverScene, PauseScene, PlayScene
from .settings import SettingsScene
from .skins import SkinsScene
from .splash import SplashScene

__all__ = [
    "SplashScene", "MenuScene", "ModesScene", "SkinsScene", "SettingsScene",
    "PlayScene", "PauseScene", "GameOverScene",
]
