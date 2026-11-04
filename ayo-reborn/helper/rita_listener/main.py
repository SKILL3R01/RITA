"""Entry point: acquire the launch key, then serve."""
import asyncio
import os
import sys

from . import __version__, PROTOCOL_VERSION
from .auth import read_launch_key, MissingKey
from .config import Config


def main() -> int:
    cfg = Config()
    print(f"[rita-listener] v{__version__} protocol v{PROTOCOL_VERSION} pid={os.getpid()}", flush=True)
    try:
        key = read_launch_key(cfg.key_file)
    except MissingKey as e:
        print(f"[rita-listener] FATAL: {e}", flush=True)
        return 3
    print("[rita-listener] launch key acquired "
          f"(source: {'dev file' if cfg.key_file else 'fd 3'})", flush=True)

    from .server import Helper
    try:
        asyncio.run(Helper(cfg, key).run())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"[rita-listener] FATAL: {e}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
