"""Launch-key handling and the v1 handshake primitives.

The 32-byte root of trust arrives on inherited stream fd 3 (written by the shell at
spawn) — never argv, env, or stdio logs. A dev stand-in file (RITA_KEY_FILE) exists so
the helper can be run standalone for debugging; it is still a real key, not an
unauthenticated fallback.
"""
import hashlib
import hmac
import os

AUTH_CONTEXT = b"rita-listener-auth-v1\n"
ROLE_MAIN = b"main-proof"
ROLE_HELPER = b"helper-proof"
KEY_LEN = 32


class MissingKey(RuntimeError):
    pass


def read_launch_key(dev_file: str | None = None) -> bytes:
    if dev_file:
        raw = open(dev_file, "rb").read()
        if len(raw) < KEY_LEN:
            raise MissingKey(f"dev key file too short: {dev_file}")
        return raw[:KEY_LEN]
    try:
        data = os.read(3, KEY_LEN)
    except OSError as e:  # fd 3 not connected => len(a) < KEY_LEN
        raise MissingKey(
            f"no launch key on fd 3 ({e}); Rita always requires a key — run via the app "
            "or set RITA_KEY_FILE for standalone debugging"
        ) from e
    while len(data) < KEY_LEN:
        more = os.read(3, KEY_LEN - len(data))
        if not more:
            break
        data += more
    if len(data) != KEY_LEN:
        raise MissingKey(f"launch key truncated on fd 3: got {len(data)} of {KEY_LEN} bytes")
    return data


def auth_message(role: bytes, hello_nonce: bytes, proof_nonce: bytes) -> bytes:
    return AUTH_CONTEXT + role + b" " + hello_nonce + b" " + proof_nonce


def main_proof(key: bytes, hello_nonce: bytes, proof_nonce: bytes) -> str:
    mac = hmac.new(key, auth_message(ROLE_MAIN, hello_nonce, proof_nonce), hashlib.sha256)
    return mac.hexdigest()


def helper_proof(key: bytes, hello_nonce: bytes, proof_nonce: bytes) -> str:
    mac = hmac.new(key, auth_message(ROLE_HELPER, hello_nonce, proof_nonce), hashlib.sha256)
    return mac.hexdigest()


def secure_compare(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
