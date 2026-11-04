"""Rita listener — local microphone daemon.

Original code for the Rita project. Architecture inspired by the pattern used in
desktop assistants' mic daemons (fd-3 launch key, HMAC-auth loopback WebSocket,
wake->capture->STT pipeline), implemented from scratch.
"""

__version__ = "0.1.0"
PROTOCOL_VERSION = 1
