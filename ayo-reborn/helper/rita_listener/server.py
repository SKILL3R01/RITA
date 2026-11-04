"""Rita helper server: loopback WebSocket + wake/capture/STT state machine.

Trust model (mirrors the classic mic-daemon pattern, reimplemented from scratch):
- 32-byte launch key via fd 3; HMAC-SHA256 handshake in both directions with
  constant-time comparison; sockets with an `Origin` header are rejected; only one
  authenticated client at a time.
"""
from __future__ import annotations

import asyncio
import json
import math
import secrets
import sys
import time
from collections import deque
from typing import Optional

import numpy as np
import websockets

from .audio import AudioInput, rms_db
from .config import Config
from .stt import SttEngine
from .wake import WakeEngine
from .auth import read_launch_key, main_proof, helper_proof, secure_compare

STATE_LISTENING = "listening"
STATE_PAUSED = "paused"
STATE_CAPTURING = "capturing"
STATE_TRANSCRIBING = "transcribing"

# console codepages must never crash a log line (cp1252 has no ≈/→/etc.)
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

_HANDSHAKE_TIMEOUT_S = 5.0
_FRAME_MAX = 1024 * 1024  # json text frames only; library-level max_size matches


def _log(msg: str) -> None:
    # console codepages (cp1252/gbk...) must never take the wake loop down with
    # a UnicodeEncodeError — degrade to replacement chars instead
    line = f"[server] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


class HelperState:
    def __init__(self) -> None:
        self.state: str = STATE_LISTENING
        self.generation: int = 0
        self.device_name: str = "default"
        self.wake_ready: bool = False
        self.pending: Optional[dict] = None   # wake awaiting capture-start
        self.capture: Optional[dict] = None
        self.session_active: bool = False         # conversation session: wake once, keep talking
        self.session_idle_until: float = 0.0      # monotonic deadline; no speech by then → end
        self.session_started: float = 0.0         # monotonic; hard budget check
        self.session_empty: int = 0               # consecutive not-heard captures in session
        self._session_speech_blocks: int = 0      # sustained-energy counter for VAD trigger
        self._session_muzzle_until: float = 0.0   # brief VAD muzzle right after start (echo shield)
        self.wake_dud_streak: int = 0             # wake-storm damper: consecutive wake captures ending "no speech"
        self.wake_muzzle_until: float = 0.0       # monotonic; wake scoring pauses until then (exponential backoff)

    def snapshot(self) -> dict:
        return {
            "listening": self.state == STATE_LISTENING,
            "paused": self.state == STATE_PAUSED,
            "capturing": self.state == STATE_CAPTURING,
            "state": self.state,
            "generation": self.generation,
            "device": self.device_name,
            "wakeReady": self.wake_ready,
            "session": self.session_active,
        }


class Helper:
    def __init__(self, cfg: Config, launch_key: bytes) -> None:
        self.cfg = cfg
        self.launch_key = launch_key
        self.audio = AudioInput(
            target_sr=cfg.target_sample_rate,
            device=cfg.mic_device,
            block_target_samples=cfg.block_samples,
            input_gain=cfg.input_gain,
            on_error=self._mic_error,
        )
        self.wake: Optional[WakeEngine] = None
        self.stt = SttEngine(cfg.stt_model, cfg.stt_device, cfg.stt_compute, cfg.stt_language)
        self.state = HelperState()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.stopping = False
        self.client = None                # active websocket (raw)
        self.client_locked = False        # our own flag; avoids version-specific ws introspection
        self.outbox: asyncio.Queue | None = None
        self._preroll_blocks: deque = deque()  # block arrays; maxlen set in run()
        self._mic_failures = 0
        self._watchdog_task: Optional[asyncio.Task] = None
        self._wake_task: Optional[asyncio.Task] = None
        self._blk_count = 0
        self._session_diag_n = 0
        self._session_diag_top: float = 0.0

    # ================= conversation session =================
    def _session_awaken(self, silence_ms: Optional[int] = None) -> None:
        """Refresh the in-session silence deadline (ms since last speech)."""
        ms = self.cfg.session_silence_ms
        try:
            v = int(silence_ms) if silence_ms is not None else 0
        except (TypeError, ValueError):
            v = 0
        if v > 0:
            ms = v
        self.state.session_idle_until = time.monotonic() + ms / 1000.0

    async def _end_session(self, reason: str) -> None:
        if not self.state.session_active:
            return
        self.state.session_active = False
        self.state.session_empty = 0
        self.state._session_speech_blocks = 0
        if self.state.state == STATE_CAPTURING:
            await self._capture_cancel(None, reason="session ended")
        if self.wake is not None:
            self.wake.reset_state()
        _log(f"conversation session ended ({reason})")
        await self.emit({"type": "session-ended", "reason": reason})
        await self.emit({"type": "state", **self.state.snapshot()})

    async def _session_noticed_nothing(self) -> None:
        if not self.state.session_active:
            return
        self.state.session_empty += 1
        self._session_awaken(self.cfg.session_empty_gap_ms)   # tighten: ~6 s to say something
        if self.state.session_empty >= 2:
            await self._end_session("silence")

    def _session_noticed_speech(self) -> None:
        if not self.state.session_active:
            return
        self.state.session_empty = 0
        self._session_awaken()

    async def _session_start_capture(self) -> None:
        """In-session capture from voice activity (no wake word, no round-trip,
        no 'wake' event — the main app must not re-run its capture-start here)."""
        if self.state.state != STATE_LISTENING:
            return
        if self.state.pending is not None or self.state.capture is not None:
            return
        self.state.generation += 1
        self.state.pending = {
            "generation": self.state.generation,
            "expires": time.monotonic() + 0.2,
            "model": "vad",
            "score": 1.0,
            "preroll": list(self._preroll_blocks),
            "tail": [],
        }
        _log(f"session VAD capture gen={self.state.generation}")
        await self._cmd_capture_start(
            {"generation": self.state.generation, "mode": "session"}, {"of": "session-vad"})

    async def _cmd_start_session(self, msg: dict, ack: dict) -> None:
        first = not self.state.session_active
        self.state.session_active = True
        self.state.session_started = time.monotonic()
        self.state.session_empty = 0
        self.state._session_speech_blocks = 0
        self.state.pending = None
        if self.wake is not None:
            self.wake.reset_state()
        # real interaction (session/manual) proves a human is present — wake storm over
        self.state.wake_dud_streak = 0
        self.state.wake_muzzle_until = 0.0
        self._session_awaken(msg.get("silenceMs"))
        self.state._session_muzzle_until = time.monotonic() + 1.2
        await self.emit({"type": "ack", **ack, "ok": True})
        await self.emit({"type": "state", **self.state.snapshot()})
        if first:
            _log("conversation session started")

    # ================= lifecycle =================
    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()

        try:
            self._init_wake()
            self.state.wake_ready = True
        except Exception as e:
            _log(f"wake engine failed to load: {e}")
            self.state.wake_ready = False

        await self.loop.run_in_executor(None, self.stt.ensure_loaded)

        try:
            await self.loop.run_in_executor(None, self.audio.open)
        except Exception as e:
            _log(f"mic open failed: {e}")
            await self.emit({"type": "mic-error", "message": str(e), "fatal": True})

        preroll_blocks = max(1, math.ceil(self.cfg.pre_roll_ms / 80))
        self._preroll_blocks = deque(maxlen=preroll_blocks)

        self._watchdog_task = asyncio.create_task(self._watchdog())
        self._wake_task = asyncio.create_task(self._wake_loop())

        server = await websockets.serve(self._handler, self.cfg.ws_host, self.cfg.ws_port,
                                        max_size=_FRAME_MAX)
        _log(f"listening on {self.cfg.ws_host}:{self.cfg.ws_port} (protocol v1, wakeReady={self.state.wake_ready})")
        async with server:
            await asyncio.Future()  # serve forever

    def _init_wake(self) -> None:
        if not self.cfg.wake_model_exists:
            raise RuntimeError(f"wake model not found: {self.cfg.wake_onnx_path}")
        self.wake = WakeEngine(
            onnx_path=self.cfg.wake_onnx_path,
            threshold=self.cfg.wake_threshold,
            cooldown_ms=self.cfg.wake_cooldown_ms,
            rolling_window_ms=self.cfg.wake_rolling_window_ms,
            on_error=self._mic_error,
            min_frames=self.cfg.wake_min_frames,
        )

    def _mic_error(self, message: str, fatal: bool) -> None:
        print(f"[audio] {message}{' (fatal)' if fatal else ''}", flush=True)
        if self.loop is not None:
            asyncio.run_coroutine_threadsafe(
                self.emit({"type": "mic-error", "message": message, "fatal": fatal}), self.loop)

    # ================= ws plumbing =================
    def _send_nowait(self, ws, payload: str) -> None:
        try:
            f = asyncio.ensure_future(ws.send(payload))
            f.add_done_callback(self._drain_send_result)
        except Exception:
            pass

    def _drain_send_result(self, fut: asyncio.Future) -> None:
        try:
            fut.result()
        except Exception:
            pass

    async def emit(self, payload: dict) -> None:
        """Queue an event for the client; a per-connection sender task drains it."""
        q = self.outbox
        if q is not None:
            try:
                q.put_nowait(json.dumps(payload, ensure_ascii=False))
            except Exception:
                pass

    async def _sender(self, ws) -> None:
        q = self.outbox
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                await ws.send(item)
        except websockets.ConnectionClosed:
            pass
        except Exception as e:
            _log(f"sender error: {e}")

    async def _handler(self, ws) -> None:
        origin = ws.request.headers.get("origin") if hasattr(ws, "request") else None
        if origin:
            _log(f"rejected socket with Origin header ({origin}) — browser pages must not probe localhost")
            await ws.close(code=1008, reason="origin not allowed")
            return

        if self.client_locked:
            _log("second connection refused (single client)")
            await ws.close(code=1013, reason="already have a client")
            return

        try:
            await self._handshake(ws)
        except Exception as e:
            _log(f"handshake failed: {e}")
            try:
                await ws.close(code=1008, reason="auth failed")
            except Exception:
                pass
            return

        self.client = ws
        self.client_locked = True
        self.outbox = asyncio.Queue(maxsize=512)
        sender = asyncio.create_task(self._sender(ws))
        _log("client authenticated")
        await self.emit({"type": "stt-status", **self.stt.status()})
        await self.emit({"type": "state", **self.state.snapshot()})
        try:
            async for raw in ws:
                if not await self._dispatch(raw):
                    break
        except websockets.ConnectionClosed:
            pass
        finally:
            try:
                self.outbox.put_nowait(None)
            except Exception:
                pass
            try:
                await asyncio.wait_for(sender, timeout=2.0)
            except Exception:
                pass
            if self.client is ws:
                self.client = None
                self.client_locked = False
                self.outbox = None
                _log("client disconnected")

    async def _handshake(self, ws) -> None:
        hello_nonce = secrets.token_hex(16)
        await ws.send(json.dumps({"type": "auth-hello", "v": 1, "nonce": hello_nonce}))
        deadline = time.monotonic() + _HANDSHAKE_TIMEOUT_S
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("handshake timeout")
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            if msg.get("type") != "auth-proof":
                raise ValueError(f"expected auth-proof, got {msg.get('type')!r}")
            proof_nonce = str(msg.get("nonce") or "")
            proof = str(msg.get("proof") or "")
            if not proof_nonce or not proof:
                raise ValueError("auth-proof missing fields")
            expected = main_proof(self.launch_key, hello_nonce.encode(), proof_nonce.encode())
            if not secure_compare(proof, expected):
                raise ValueError("auth-proof mismatch")
            reply_proof = helper_proof(self.launch_key, hello_nonce.encode(), proof_nonce.encode())
            await ws.send(json.dumps({"type": "auth-ok", "proof": reply_proof}))
            break

    # ================= dispatch =================
    async def _dispatch(self, raw) -> bool:
        try:
            msg = json.loads(raw)
        except Exception:
            await self.emit({"type": "error", "message": "bad json"})
            return True
        cmd = str(msg.get("command") or msg.get("type") or "")
        ack = {"of": cmd}

        if cmd == "ping":
            await self.emit({"type": "pong"})
        elif cmd in ("hello", "get-state"):
            await self.emit({"type": "state", **self.state.snapshot()})
        elif cmd == "set-params":
            await self._cmd_set_params(msg, ack)
        elif cmd == "list-devices":
            devices = await self.loop.run_in_executor(None, AudioInput.list_input_devices)
            await self.emit({"type": "devices", "devices": devices})
        elif cmd == "set-device":
            await self._cmd_set_device(msg, ack)
        elif cmd == "capture-start":
            await self._cmd_capture_start(msg, ack)
        elif cmd == "capture-stop":
            await self._capture_cancel(ack, reason="stopped")
        elif cmd == "finalize-capture":
            await self._cmd_finalize(ack)
        elif cmd == "pause-listening":
            was = self.state.state
            self.state.state = STATE_PAUSED
            self.state.pending = None
            if was == STATE_CAPTURING:
                await self._capture_cancel(None, reason="paused mid-capture")
            await self.emit({"type": "ack", **ack, "ok": True})
        elif cmd == "resume-listening":
            self.state.state = STATE_LISTENING
            suppress = int(msg.get("suppressMs", self.cfg.resume_suppress_ms))
            if self.state.session_active:
                # every announced resume keeps the conversation alive and muzzles self-echo
                self.state._session_speech_blocks = 0
                self._session_awaken()
                self.state._session_muzzle_until = time.monotonic() + max(0.6, suppress / 1000.0)
            if self.wake is not None:
                self.wake.set_resume_suppress(suppress, time.monotonic())
            await self.emit({"type": "ack", **ack, "ok": True})
        elif cmd == "start-session":
            await self._cmd_start_session(msg, ack)
        elif cmd == "stop-session":
            await self._end_session("stopped by main")
            await self.emit({"type": "ack", **ack, "ok": True})
        elif cmd == "listen-now":
            # manual capture without wake word (push-to-listen)
            if self.state.state != STATE_LISTENING:
                await self.emit({"type": "ack", **ack, "ok": False, "error": f"busy ({self.state.state})"})
            else:
                self._trigger_pending_wake("manual", 1.0)
                await self._cmd_capture_start({"generation": self.state.generation, "mode": "manual"}, ack)
        elif cmd == "simulate-wake" and self.cfg.dev_mode:
            self._trigger_pending_wake("sim", 0.99)
            await self.emit({"type": "ack", **ack, "ok": True})
        else:
            await self.emit({"type": "error", "message": f"unknown command {cmd!r}"})
        return True

    async def _cmd_set_params(self, msg: dict, ack: dict) -> None:
        changed: dict = {}
        try:
            if "threshold" in msg and self.wake is not None:
                self.wake.set_threshold(float(msg["threshold"]))
                changed["threshold"] = float(msg["threshold"])
            if "sessionRms" in msg:
                self.cfg.session_rms = min(0.05, max(0.002, float(msg["sessionRms"])))
                changed["sessionRms"] = self.cfg.session_rms
            if "sessionVadBlocks" in msg:
                self.cfg.session_vad_blocks = min(10, max(1, int(msg["sessionVadBlocks"])))
                changed["sessionVadBlocks"] = self.cfg.session_vad_blocks
            if "cooldownMs" in msg and self.wake is not None:
                self.wake.set_cooldown_ms(int(msg["cooldownMs"]))
                changed["cooldownMs"] = int(msg["cooldownMs"])
            await self.emit({"type": "ack", **ack, "ok": True, **changed})
        except Exception as e:
            await self.emit({"type": "ack", **ack, "ok": False, "error": str(e)})

    async def _cmd_set_device(self, msg: dict, ack: dict) -> None:
        name = str(msg.get("name") or "").strip() or None
        self.cfg.mic_device = name
        try:
            self.state.state = STATE_LISTENING
            self.state.capture = None
            await self.loop.run_in_executor(None, self.audio.reopen, name)
            self.state.device_name = name or "default"
            await self.emit({"type": "ack", **ack, "ok": True})
            await self.emit({"type": "state", **self.state.snapshot()})
        except Exception as e:
            await self.emit({"type": "ack", **ack, "ok": False, "error": str(e)})
            await self.emit({"type": "mic-error", "message": f"reopening mic failed: {e}", "fatal": False})

    # ================= wake loop =================
    def _ring_has_speech(self, block) -> bool:
        """True when any block in the preroll ring (or the trigger block) carries
        speech-level energy. The wake model scores 0.9+ on a silent room — energy
        in the surround is the honesty check the model itself lacks."""
        if self.cfg.wake_min_rms <= 0:
            return True
        for b in self._preroll_blocks:
            if float(np.sqrt(np.mean(np.square(np.asarray(b))))) >= self.cfg.wake_min_rms:
                return True
        if block is not None and float(np.size(block)):
            return float(np.sqrt(np.mean(np.square(block)))) >= self.cfg.wake_min_rms
        return False

    def _trigger_pending_wake(self, model_name: str, score: float) -> None:
        self.state.generation += 1
        preroll_n = len(self._preroll_blocks)
        preroll_ms = int(preroll_n * self.cfg.block_samples * 1000 / self.cfg.target_sample_rate)
        _log(f"wake trigger gen={self.state.generation} model={model_name} score={score:.3f} "
             f"prerollBlocks={preroll_n} (~{preroll_ms}ms)")
        pending = {
            "generation": self.state.generation,
            "expires": time.monotonic() + self.cfg.queued_capture_grace_ms / 1000.0,
            "model": model_name,
            "score": score,
            "preroll": list(self._preroll_blocks),
            "tail": [],
        }
        self.state.pending = pending
        asyncio.ensure_future(self.emit(
            {"type": "wake", "score": score, "model": model_name, "generation": self.state.generation}))

    async def _wake_loop(self) -> None:
        block_n = max(480, self.cfg.block_samples)
        while not self.stopping:
            try:
                now = time.monotonic()

                # pending wake that never got capture-start: let it expire
                if self.state.pending and now > self.state.pending["expires"]:
                    _log(f"wake {self.state.pending['generation']} expired without capture-start")
                    self.state.pending = None

                block = self.audio.feed.take(block_n)
                if block is None:
                    await asyncio.sleep(0.005)
                    continue

                if self.state.state == STATE_CAPTURING and self.state.capture is not None:
                    self.state.capture["blocks"].append(block.copy())
                    self.state.capture["slices"].append(rms_db(block))
                    self._eval_capture(self.state.capture)
                    continue

                if self.state.state in (STATE_PAUSED, STATE_TRANSCRIBING):
                    # consume and keep* nothing; wake context reset keeps things clean
                    continue

                # conversation session: energy-VAD trigger (no wake scoring); deadlines enforced here.
                # Placed after PAUSED/TRANSCRIBING so turns-in-flight don't tick the silence clock.
                if self.state.session_active:
                    budget_ms = (now - self.state.session_started) * 1000.0
                    if budget_ms > self.cfg.session_max_ms:
                        await self._end_session("budget")
                        continue
                    if now > self.state.session_idle_until:
                        await self._end_session("silence")
                        continue
                    self._preroll_blocks.append(block.copy())   # keep the ring warm for instant trigger
                    if now < self.state._session_muzzle_until:
                        continue
                    rms_now = float(np.sqrt(float(np.mean(np.square(block)))))
                    # two trigger paths: (1) sustained energy fast path;
                    # (2) keep the wake model running — the user's voice reliably
                    # scores above threshold, and in-session ANY detected speech
                    # means "they are talking", wake word or not.
                    wake_dec = None
                    if self.wake is not None and self.wake.ready:
                        int_block = np.clip(block * 32767.0, -32768, 32767).astype(np.int16)
                        wake_dec = await self.loop.run_in_executor(None, self.wake.feed_block, int_block)
                    trigger = None
                    if rms_now >= self.cfg.session_rms:
                        self.state._session_speech_blocks += 1
                        if self.state._session_speech_blocks >= self.cfg.session_vad_blocks:
                            trigger = "vad"
                    else:
                        # leaky decay: quiet mics flicker around the threshold — one dim
                        # block between faint words must not zero the speech counter
                        self.state._session_speech_blocks = max(0, self.state._session_speech_blocks - 1)
                    if trigger is None and wake_dec is not None and wake_dec.triggered \
                            and self._ring_has_speech(block):
                        trigger = "wake"
                    if trigger is not None:
                        self.state._session_speech_blocks = 0
                        _log(f"session trigger ({trigger}) wakeScore={getattr(wake_dec, 'score', 0) or 0:.3f}")
                        await self._session_start_capture()
                        continue
                    # diagnosis line ~every 4 s: what the room + mic actually look like
                    self._session_diag_n += 1
                    self._session_diag_top = max(self._session_diag_top, rms_now)
                    if self._session_diag_n >= 50:
                        _log(f"session quiet: rmsTop={self._session_diag_top:.4f} "
                             f"thr={self.cfg.session_rms:.3f} "
                             f"wakeTop={(wake_dec.score if wake_dec is not None else 0) or 0:.2f}")
                        self._session_diag_n = 0
                        self._session_diag_top = 0.0
                    continue

                # LISTENING with a pending wake: collect the pre-capture tail
                if self.state.pending is not None:
                    self.state.pending["tail"].append(block.copy())
                    continue

                # LISTENING, no pending: feed preroll ring and score wake word
                self._preroll_blocks.append(block.copy())
                # wake-storm damper: after dud wake captures the model has locked onto
                # dead air; scoring stays paused while the session/tool use continues fine
                if now < self.state.wake_muzzle_until:
                    continue
                self._blk_count += 1
                if self._blk_count % 600 == 0:
                    _log(f"wake-loop steady (~200 takes ok, preroll={len(self._preroll_blocks)}, "
                         f"buffered={len(self.audio.feed.data)})")
                    self._blk_count = 0
                if self.wake is None or not self.wake.ready:
                    await asyncio.sleep(0.05)
                    continue
                int_block = np.clip(block * 32767.0, -32768, 32767).astype(np.int16)
                dec = await self.loop.run_in_executor(None, self.wake.feed_block, int_block)
                if dec.triggered:
                    if not self._ring_has_speech(block):
                        # silent-room storm: model says "wiem" on dead air; no voice
                        # in the ring means no utterance happened — suppress it
                        _log(f"score={dec.score:.3f} SUPPRESSED (silent ring)")
                        continue
                    _log(f"score={dec.score:.3f} model={dec.model_name}")
                    self._trigger_pending_wake(dec.model_name, dec.score)
            except Exception as e:
                _log(f"wake loop error: {e}")
                await asyncio.sleep(0.5)

    # ================= capture =================
    async def _cmd_capture_start(self, msg: dict, ack: dict) -> None:
        if self.state.state != STATE_LISTENING:
            _log(f"capture-start refused: busy ({self.state.state})")
            await self.emit({"type": "ack", **ack, "ok": False, "error": f"not listening ({self.state.state})"})
            return
        gen = int(msg.get("generation", -1))
        pending = self.state.pending
        if not pending or gen != pending["generation"]:
            _log(f"capture-start stale/unknown generation {gen} "
                 f"(pending={pending and pending['generation']})")
            await self.emit({"type": "ack", **ack, "ok": False, "error": "stale generation"})
            return
        pre_blocks = [np.asarray(b, dtype=np.float32) for b in pending["preroll"]]
        tail_blocks = pending["tail"]
        _log(f"capture-start gen={gen} preBlocks={len(pre_blocks)} tailBlocks={len(tail_blocks)}")
        self.state.capture = {
            "generation": gen,
            "blocks": [*pre_blocks, *tail_blocks],
            "slices": [rms_db(np.asarray(b, dtype=np.float32)) for b in [*pre_blocks, *tail_blocks]],
            "started": time.monotonic(),
            "max_ms": int(msg.get("maxMs", self.cfg.capture_max_ms)),
            "mode": str(msg.get("mode", "wake")),
        }
        self.state.pending = None
        self.state.state = STATE_CAPTURING
        if str(msg.get("mode", "wake")) != "wake":
            # manual/session capture: real activity, the storm damper resets
            self.state.wake_dud_streak = 0
            self.state.wake_muzzle_until = 0.0
        pre_ms = int(sum(len(b) for b in pre_blocks) * 1000 / self.cfg.target_sample_rate)
        _log(f"capture started gen={gen} mode={self.state.capture['mode']} preRollMs={pre_ms}")
        await self.emit({"type": "ack", **ack, "ok": True})
        await self.emit({"type": "capture-started", "generation": gen, "preRollMs": pre_ms})

    async def _capture_cancel(self, ack: Optional[dict], reason: str) -> None:
        cap = self.state.capture
        self.state.capture = None
        self.state.pending = None
        self.state.state = STATE_LISTENING
        if cap is not None:
            _log(f"capture {cap['generation']} cancelled ({reason})")
            await self.emit({"type": "capture-cancelled", "generation": cap["generation"], "reason": reason})
        if self.wake is not None:
            self.wake.reset_state()
        # a manual cancel is real user activity; the storm damper resets too
        self.state.wake_dud_streak = 0
        self.state.wake_muzzle_until = 0.0
        if ack is not None:
            await self.emit({"type": "ack", **ack, "ok": True})

    async def _cmd_finalize(self, ack: dict) -> None:
        cap = self.state.capture
        if not cap:
            await self.emit({"type": "ack", **ack, "ok": False, "error": "no active capture"})
            return
        await self.emit({"type": "ack", **ack, "ok": True})
        self._finalize_capture(cap, reason="finalized by user")

    def _eval_capture(self, cap: dict) -> None:
        now = time.monotonic()
        dur_ms = (now - cap["started"]) * 1000.0
        slices = cap["slices"]
        if dur_ms >= cap["max_ms"]:
            self._finalize_capture(cap, reason="max time")
            return
        if len(slices) < 10:
            return
        floor = float(np.percentile(np.asarray(slices, dtype=np.float64), 30))
        speech_level = max(self.cfg.vad_abs_floor, floor * self.cfg.vad_ratio)
        had_speech = any(v >= speech_level for v in slices)
        recent = slices[-12:]  # ~1 s of recent blocks (2 s added dead air after every request)
        recent_quiet = all(v < speech_level for v in recent)
        if had_speech and recent_quiet:
            silence_cfg = self.cfg.capture_silence_min_s if dur_ms < 4000 else self.cfg.capture_silence_s
            if dur_ms >= silence_cfg * 1000:
                self._finalize_capture(cap, reason="silence")
        elif not had_speech and dur_ms >= self.cfg.capture_silence_s * 1000 and recent_quiet:
            self._finalize_capture(cap, reason="no speech")

    def _finalize_capture(self, cap: dict, reason: str) -> None:
        if self.state.capture is not cap:
            return
        cap["reason"] = reason
        self.state.capture = None
        self.state.pending = None
        self.state.state = STATE_TRANSCRIBING
        # wake-storm damper bookkeeping: a wake capture that ends with no speech at all
        # (and does not reach the user) is a likely false trigger on dead air. Each
        # consecutive dud backs wake scoring off longer (2 → 4 → 8 → 12 s cap);
        # any wake capture that DID catch speech resets the streak.
        if cap.get("mode", "wake") == "wake":
            if reason == "no speech":
                self.state.wake_dud_streak += 1
                backoff_s = min(2.0 * (2 ** (self.state.wake_dud_streak - 1)), 12.0)
                self.state.wake_muzzle_until = time.monotonic() + backoff_s
                _log(f"wake damper: dud streak={self.state.wake_dud_streak} "
                     f"-> pause wake scoring {backoff_s:.0f}s")
            else:
                self.state.wake_dud_streak = 0
                self.state.wake_muzzle_until = 0.0
        _log(f"capture {cap['generation']} finalize ({reason}) -> transcribing")
        asyncio.ensure_future(self._transcribe(cap))

    async def _transcribe(self, cap: dict) -> None:
        gen = cap["generation"]
        try:
            audio = np.concatenate(cap["blocks"]).astype(np.float32) if cap["blocks"] else np.empty(0, np.float32)
            audio_ms = int(len(audio) * 1000 / self.cfg.target_sample_rate)
            if audio_ms < 300 or cap.get("reason") == "no speech":
                # short blob or the energy gate already said there was nothing there:
                # skip whisper (hallucinated turns from room noise are a known failure mode)
                await self.emit({"type": "not-heard", "generation": gen, "audioMs": audio_ms})
                await self._session_noticed_nothing()
                return
            text, lang, _ = await self.loop.run_in_executor(None, self.stt.transcribe, audio, 16000)
            text = (text or "").strip()
            _log(f"transcript gen={gen} reason={cap.get('reason')} audioMs={audio_ms} "
                 f"lang={lang} text={text[:120]!r}")
            if not text:
                await self.emit({"type": "not-heard", "generation": gen, "audioMs": audio_ms})
                await self._session_noticed_nothing()
            else:
                self._session_noticed_speech()
                await self.emit({"type": "transcript", "text": text, "language": lang,
                                 "generation": gen, "audioMs": audio_ms,
                                 "mode": cap.get("mode", "wake")})
        except Exception as e:
            _log(f"transcribe failed gen={gen}: {e}")
            await self.emit({"type": "stt-error", "generation": gen, "message": str(e)})
        finally:
            if self.wake is not None:
                self.wake.reset_state()
            if self.state.state == STATE_TRANSCRIBING:
                self.state.state = STATE_LISTENING
            await self.emit({"type": "state", **self.state.snapshot()})

    # ================= watchdog =================
    async def _watchdog(self) -> None:
        while not self.stopping:
            await asyncio.sleep(5)
            try:
                live = self.audio.stream is not None and self.audio.stream.active
            except Exception:
                live = False
            no_data = (time.monotonic() - self.audio.last_data_mono()) if live else 0.0
            if live and no_data > 6.0:
                self._mic_failures += 1
                _log(f"stream dead (no callbacks for {no_data:.1f}s, try {self._mic_failures}) — reopening")
                try:
                    await self.loop.run_in_executor(None, self.audio.reopen)
                    self.state.device_name = str(self.cfg.mic_device or "default")
                except Exception as e:
                    await self.emit({"type": "mic-error",
                                     "message": f"reopening failed: {e}",
                                     "fatal": self._mic_failures >= 3})
            elif live:
                self._mic_failures = 0
