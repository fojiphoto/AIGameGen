"""
NEON COIL — a modern arcade snake.

Everything the game draws and everything it plays is generated at runtime; there are no asset
files anywhere in the package. `main()` is the entry point and is what both `run.py` and
`python -m neoncoil` call.
"""

__version__ = "1.0.0"
__all__ = ["main", "__version__"]


def main(argv=None) -> int:
    from .main import main as _main
    return _main(argv)
