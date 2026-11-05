# PyInstaller entry for the packaged listener.
# Mirrors `python -m rita_listener` (which executes __main__.py -> main.main())
# with a straight import chain — no runpy, so the frozen build has no dynamic
# module lookups at all.
import sys

from rita_listener.main import main

sys.exit(main())
