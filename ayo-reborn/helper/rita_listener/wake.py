"""Wake-word scoring with openWakeWord.

Mirrors the gripe-free parts of the classic pattern: fixed-size frames
(1280 samples = 80 ms @16 kHz), rolling-max decision over a short window,
cooldown after a detection, and a resume-suppression window so the assistant does
not wake on its own voice (echo shield).

The wake model file is selectable; default points at the installed AyoModel ONNX
for personal local use only.
"""
import time
from collections import deque
from typing import Callable, Optional
import numpy as np


class WakeDecision:
    __slots__ = ("triggered", "score", "model_name", "suppressed_by_cooldown", "suppressed_by_resume")

    def __init__(self, triggered: bool, score: float, model_name: str,
                 suppressed_cooldown: bool, suppressed_resume: bool) -> None:
        self.triggered = triggered
        self.score = score
        self.model_name = model_name
        self.suppressed_by_cooldown = suppressed_cooldown
        self.suppressed_by_resume = suppressed_resume

    def __repr__(self) -> str:  # pragma: no cover
        return (f"WakeDecision(triggered={self.triggered}, score={self.score:.3f}, "
                f"cooldown={self.suppressed_by_cooldown}, resume={self.suppressed_by_resume})")


class WakeEngine:
    def __init__(
        self,
        onnx_path: str,
        threshold: float = 0.42,
        cooldown_ms: int = 900,
        rolling_window_ms: int = 400,
        on_error: Optional[Callable[[str, bool], None]] = None,
        min_frames: int = 2,
    ) -> None:
        from openwakeword.model import Model  # local import: slow

        self.path = onnx_path
        self.threshold = threshold
        self.cooldown_s = cooldown_ms / 1000.0
        self.window = max(1, int(rolling_window_ms / 80))
        self.min_frames = max(1, int(min_frames))  # of the window's frames, how many must clear the threshold (1 = old peak-only)
        self._rolling = deque(maxlen=self.window)
        self._last_trigger = 0.0
        self.model = Model(wakeword_models=[onnx_path], inference_framework="onnx")
        self.model_names = list(self.model.models.keys()) if hasattr(self.model, "models") else ["wake"]
        self.frame_size = self.model_inputs_frame() or 1280
        self._ready = True
        self._on_error = on_error
        self._score_ms_total = 0.0
        self._score_n = 0

    def model_inputs_frame(self) -> int:
        try:
            mi = self.model.model_inputs.get(self.model_names[0], None) if self.model.model_inputs else None
            if mi is None:
                return 1280
            shape = mi[0].get("shape", None) if mi else None
            if shape and len(shape) >= 2 and shape[1]:
                return int(shape[1]) if shape[1] > 0 else 1280
        except Exception:
            pass
        return 1280

    @property
    def ready(self) -> bool:
        return bool(self._ready)

    def reset_state(self) -> None:
        """Drop melspec/embedding context after a capture so askew audio does not leak in."""
        try:
            self.model.reset()
        except Exception:
            pass

    def set_threshold(self, t: float) -> None:
        t = max(0.05, min(0.99, float(t)))
        self.threshold = t

    def set_cooldown_ms(self, ms: int) -> None:
        self.cooldown_s = max(100, int(ms)) / 1000.0

    def suppress_until(self) -> float:
        return self._suppress_until

    # ---------------- scoring ----------------
    def feed_block(self, block: np.ndarray, now_mono: Optional[float] = None) -> WakeDecision:
        """Score one block of int16 PCM (length == frame_size)."""
        now = time.monotonic() if now_mono is None else now_mono
        t0 = time.perf_counter()
        score = 0.0
        name = self.model_names[0] if self.model_names else "wake"
        try:
            scores = self.model.predict(block)
            if scores:
                name, score = max(scores.items(), key=lambda kv: float(kv[1])) if len(scores) > 1 \
                    else next(iter(scores.items()))
                score = float(score)
        except Exception as e:
            if self._on_error is not None:
                self._on_error(f"wake scoring error: {e}", False)
            return WakeDecision(False, 0.0, name, False, False)
        ms = (time.perf_counter() - t0) * 1000.0
        self._score_ms_total += ms
        self._score_n += 1
        if self._score_n == 1 or self._score_n % 100 == 0:
            # includes context: first call warms ORT; later calls should be ~10-40 ms on CPU
            print(f"[wake] score #{self._score_n} took {ms:.0f} ms "
                  f"(avg {(self._score_ms_total / self._score_n):.0f} ms)", flush=True)

        self._rolling.append(score)
        peak = max(self._rolling)
        hits = sum(1 for s in self._rolling if s >= self.threshold)
        if peak >= self.threshold and hits >= self.min_frames:
            in_cooldown = (now - self._last_trigger) < self.cooldown_s
            in_resume = now < self._resume_suppress_until if hasattr(self, "_resume_suppress_until") else False
            if not in_cooldown and not in_resume:
                self._last_trigger = now
                self._rolling.clear()
                return WakeDecision(True, score, name, False, False)
            return WakeDecision(False, score, name, in_cooldown, in_resume)
        return WakeDecision(False, score, name, False, False)

    # resume suppression is set externally (echo shield)
    def set_resume_suppress(self, ms: int, now_mono: float) -> None:
        self._resume_suppress_until = now_mono + ms / 1000.0

    _resume_suppress_until = 0.0
