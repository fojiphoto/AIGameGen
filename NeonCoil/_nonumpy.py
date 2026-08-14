"""Hide numpy from the import system, to exercise the pygame-only paths.

The WebAssembly build has no numpy — pygbag publishes a wheel only for a runtime version it no
longer ships — so those fallbacks are the code that actually runs in a browser. This makes them
testable here, where the result can be compared against the array versions.

Returning None rather than raising matters: pygame itself probes for numpy with `find_spec`, and
a finder that raises breaks the probe instead of answering it.
"""

import sys
from importlib.machinery import ModuleSpec
from importlib.abc import Loader, MetaPathFinder


class _Absent(Loader):
    def create_module(self, spec):
        raise ImportError(f"{spec.name} hidden for the no-numpy verification pass")

    def exec_module(self, module):
        raise ImportError("hidden")


class _HideNumpy(MetaPathFinder):
    """Answer "yes, but it will not load" — so find_spec succeeds and the import fails."""

    def find_spec(self, fullname, path=None, target=None):
        if fullname == "numpy" or fullname.startswith("numpy."):
            return ModuleSpec(fullname, _Absent())
        return None


sys.meta_path.insert(0, _HideNumpy())
for name in [m for m in sys.modules if m == "numpy" or m.startswith("numpy.")]:
    del sys.modules[name]
