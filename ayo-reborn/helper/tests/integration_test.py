"""Integration test for the Rita listener.

Spawn the helper like Electron would, then:
 1. complete the v1 handshake (verify BOTH direction proofs)
 2. reject a bad proof
 3. reject a browser-origin socket
 4. exercise get-state / ping / list-devices / set-params
 5. simulate-wake -> capture-started -> not-heard|transcript (full pipeline)
"""
import asyncio
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HELPER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("RITA_TEST_PORT", "8771"))
AUTH_CTX = b"rita-listener-auth-v1\n"


def hmac_msg(role: bytes, n1: bytes, n2: bytes) -> bytes:
    return AUTH_CTX + role + b" " + n1 + b" " + n2


async def recv_json(ws, timeout=10):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def handshake(ws, key):
    hello = await recv_json(ws)
    assert hello.get("type") == "auth-hello", f"expected auth-hello, got {hello}"
    assert hello.get("v") == 1
    my_nonce = os.urandom(16).hex()
    sent_proof = hmac.new(
        key, hmac_msg(b"main-proof", hello["nonce"].encode(), my_nonce.encode()), hashlib.sha256
    ).hexdigest()
    await ws.send(json.dumps({"type": "auth-proof", "v": 1, "nonce": my_nonce, "proof": sent_proof}))
    ok = await recv_json(ws)
    assert ok.get("type") == "auth-ok", f"expected auth-ok, got {ok}"
    expected = hmac.new(
        key, hmac_msg(b"helper-proof", hello["nonce"].encode(), my_nonce.encode()), hashlib.sha256
    ).hexdigest()
    assert hmac.compare_digest(ok.get("proof", ""), expected), "helper's auth-ok proof MISMATCH"
    return hello, my_nonce


async def event_until(ws, types, timeout=20.0):
    """Collect events until one whose type is in `types`; return full event seen."""
    seen = []
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            m = await recv_json(ws, timeout=end - time.monotonic())
        except (asyncio.TimeoutError, TimeoutError):
            break
        seen.append(m)
        if m.get("type") in types:
            return m, seen
    raise AssertionError(f"never saw any of {types}; got {[x.get('type') for x in seen]}")


async def main() -> int:
    from websockets.asyncio.client import connect

    keypath = os.path.join(HELPER_DIR, ".test-key")
    with open(keypath, "wb") as f:
        f.write(os.urandom(32))
    key = open(keypath, "rb").read()[:32]

    env = {
        **os.environ,
        "RITA_KEY_FILE": keypath,
        "RITA_DEV": "1",
        "RITA_WS_PORT": str(PORT),
        "RITA_STT_MODEL": "base",
        "PYTHONUNBUFFERED": "1",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "rita_listener"],
        cwd=HELPER_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    helper_log: list[str] = []

    import threading

    def drain(stream, sink):
        for line in stream:
            sink.append(line.rstrip())

    threading.Thread(target=drain, args=(proc.stdout, helper_log), daemon=True).start()
    url = f"ws://127.0.0.1:{PORT}"
    try:
        # wait for the server to come up
        log = "waiting for helper…"
        connected = None

        async def try_connect():
            try:
                return await connect(url, open_timeout=8)
                # no Origin header (we are the desktop app, not a web page)
            except Exception:
                return None

        for _ in range(40):
            await asyncio.sleep(0.5)
            connected = await try_connect()
            if connected:
                break
        assert connected is not None, f"helper never came up; log={log}"

        # 1. handshake both directions; second client must be refused while this one lives
        await handshake(connected, key)
        print("PASS handshake (both proofs verified)")
        try:
            async with connect(url, open_timeout=8) as ws2_dup:
                await recv_json(ws2_dup, 4)
                raise AssertionError("second connection allowed!")
        except AssertionError:
            raise
        except Exception:
            print("PASS second client refused while one is active")
        await connected.close()

        # 2. bad proof is rejected (needs a fresh connection; only one client allowed)
        async with connect(url, open_timeout=8) as bad:
            await recv_json(bad)
            await bad.send(json.dumps({"type": "auth-proof", "v": 1, "nonce": "aa", "proof": "ff"}))
            try:
                m = await recv_json(bad, 5)
                raise AssertionError(f"bad proof was accepted! got {m}")
            except AssertionError:
                raise
            except Exception:
                print("PASS bad proof rejected")

        # 3. browser-origin socket rejected
        try:
            async with connect(url, origin="http://evil.example", open_timeout=8) as origin_ws:
                await recv_json(origin_ws, 4)
                raise AssertionError("origin socket got past auth!")
        except AssertionError:
            raise
        except Exception:
            print("PASS origin socket rejected")

        # 4. core commands (fresh connection: only one client at a time)
        source = await connect(url, open_timeout=8)
        await handshake(source, key)
        await source.send(json.dumps({"command": "get-state"}))
        ev, _ = await event_until(source, ["state"], 6)
        print("PASS get-state:", json.dumps(ev.get("state") or ev))
        await source.send(json.dumps({"command": "ping"}))
        ev, _ = await event_until(source, ["pong"], 6)
        print("PASS ping")
        await source.send(json.dumps({"command": "list-devices"}))
        ev, _ = await event_until(source, ["devices"], 6)
        print("PASS list-devices:", [(d["name"][:28]) for d in ev.get("devices", [])[:4]])
        if ev.get("devices") and len(ev["devices"]) > 0:
            await source.send(json.dumps({"command": "set-device", "name": ev["devices"][0]["name"]}))
            ev, _ = await event_until(source, ["ack"], 8)
            print("PASS set-device ok=", ev.get("ok"))

        # reset connection state for pipeline test: connect fresh
        await source.close()

        async with connect(url, open_timeout=8) as ws2:
            await handshake(ws2, key)

            # 5. simulate-wake -> main sends capture-start -> capture -> result
            await ws2.send(json.dumps({"command": "simulate-wake"}))
            ev, _ = await event_until(ws2, ["wake"], 8)
            print("PASS wake event:", {k: ev[k] for k in ("score", "model", "generation")})
            await ws2.send(json.dumps({"command": "capture-start", "generation": ev["generation"], "mode": "wake"}))
            ev,_ = await event_until(ws2, ["capture-started"], 8)
            print("PASS capture-started", ev)
            ev, seen = await event_until(ws2, ["transcript", "not-heard", "capture-cancelled"], 60)
            print("PASS pipeline:", ev)

            # manual (push-to-listen) capture right after the first one finished
            await ws2.send(json.dumps({"command": "listen-now"}))
            ev, _ = await event_until(ws2, ["ack", "capture-started"], 8)
            print("PASS listen-now ack ok=", ev.get("ok"))
            ev, _ = await event_until(ws2, ["transcript", "not-heard", "capture-cancelled"], 60)
            print("PASS pipeline2:", ev)

            # 6. conversation session: start-session flags the state
            await ws2.send(json.dumps({"command": "start-session", "silenceMs": 40000}))
            ev, _ = await event_until(ws2, ["ack"], 8)
            assert ev.get("ok") is True, f"start-session refused: {ev}"
            ev, _ = await event_until(ws2, ["state"], 6)
            assert ev.get("session") is True, f"state.session not active: {ev}"
            print("PASS session started (state.session=true)")

            # 7. stop-session: ends cleanly, back to wake mode
            await ws2.send(json.dumps({"command": "stop-session"}))
            ev, _ = await event_until(ws2, ["session-ended"], 8)
            assert ev.get("reason") == "stopped by main", f"unexpected end reason: {ev}"
            ev, _ = await event_until(ws2, ["state"], 6)
            assert ev.get("session") is False, f"session still active after stop: {ev}"
            print("PASS stop-session round-trip (session=false)")

            # 8. in-session silence timeout: tiny budget -> helper ends on its own
            await ws2.send(json.dumps({"command": "start-session", "silenceMs": 700}))
            ev, _ = await event_until(ws2, ["ack"], 8)
            assert ev.get("ok") is True, f"start-session(700ms) refused: {ev}"
            ev, seen = await event_until(ws2, ["session-ended"], 10)
            assert ev.get("reason") == "silence", \
                f"expected silence timeout, got {ev} (seen={[x.get('type') for x in seen]})"
            print("PASS session silence-timeout -> session-ended (silence)")

            print("ALL-PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(15)
        except Exception:
            pass
        print("---- helper log ----")
        for line in helper_log:
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
