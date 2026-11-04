"""Audio input: one always-open capture stream, converted to a 16 kHz mono float32
feed that the wake engine and capture recorder both read from.

Design notes (mirroring the pattern used in desktop mic daemons):
- PortAudio on Windows may reject 16 kHz directly on some devices, so we open the
  device at its default rate and resample per-block (linear interpolation) instead.
- The stream callback does as little as possible; consumers poll on a worker loop.
- Device loss is surfaced to callers; whipaws and reconnect breathes before retry.
"""
import threading
import time
from typing import Callable, Optional
import sounddevice as sd
import numpy as np


class SampleBuffer:
    """Bounded FIFO of float32 samples (thread-safe: producer=callback, consumer=server loop)."""
    def __init__(self, max_samples: int) -> None:
        self.max_samples = max_samples
        self._lock = threading.Lock()
        self.data = np.empty(0, dtype=np.float32)

    def append(self, block: np.ndarray) -> None:
        with self._lock:
            self.data = np.concatenate([self.data, block])
            if len(self.data) > self.max_samples:
                self.data = self.data[-self.max_samples:]

    def take(self, n: int) -> Optional[np.ndarray]:
        with self._lock:
            if len(self.data) < n:
                return None
            out = self.data[:n]
            self.data = self.data[n:]
            return out


def rms_db(block: np.ndarray) -> float:
    """RMS of a normalized block, as a plain magnitude (1.0 ~ full scale)."""
    if len(block) == 0:
        return 0.0
    return float(np.sqrt(np.mean(block.astype(np.float64) ** 2)))


class AudioInput:
    def __init__(
        self,
        target_sr: int = 16000,
        device: Optional[str] = None,
        block_target_samples: int = 1280,
        input_gain: float = 1.0,
        on_error: Optional[Callable[[str, bool], None]] = None,
    ) -> None:
        self.target_sr = target_sr
        self.device = device
        self.gain = float(input_gain)
        self.on_error = on_error
        self.stream: sd.RawInputStream | None = None
        self.feed = SampleBuffer(target_sr * 30)  # ~30 s of slack for consumers
        self._device_sample_rate = target_sr
        self._phase = 0.0         # fractional device-index of the next 16 kHz sample
        self._last_raw = np.empty(0, dtype=np.float32)
        self._opened = False
        self._cb_n = 0          # diagnostics: callback counter
        self._cb_out_total = 0  # diagnostics: total resampled samples emitted
        self._cb_out_last = 0   # diagnostics: target samples emitted by last callback
        self._last_data_mono = time.monotonic()

    def last_data_mono(self) -> float:
        return self._last_data_mono

    # ---------- device enumeration ----------
    @staticmethod
    def list_input_devices() -> list[dict]:
        try:
            devs = sd.query_devices()
        except Exception as e:
            return [dict(name=f"<device query failed: {e}>", default=False)]
        default_in = sd.default.device[0]
        out = []
        for idx, d in enumerate(devs):
            if d.get("max_input_channels", 0) > 0:
                out.append({
                    "name": d["name"],
                    "default": idx == default_in,
                })
        return out

    @staticmethod
    def _resolve_device(device: Optional[str]) -> Optional[int]:
        if not device:
            return None
        devs = sd.query_devices()
        candidate: Optional[int] = None
        for idx, d in enumerate(devs):
            d_name = d.get("name", "")
            if str(device) == d_name or d_name[:31] == str(device)[:31]:
                candidate = idx
                if d.get("max_input_channels", 0) > 0:
                    return idx
        return candidate

    @staticmethod
    def default_samplerate_of(device_index: Optional[int]) -> int:
        try:
            dev = sd.query_devices(device_index if device_index is not None else sd.default.device[0])
            return int(dev.get("default_samplerate", 16000)) or 16000
        except Exception:
            return 16000

    # ---------- stream ----------
    def open(self) -> None:
        dev_idx = self._resolve_device(self.device)
        self._device_sample_rate = self.default_samplerate_of(dev_idx)
        frames = max(64, int(self._device_sample_rate / (1000 / 80)))  # ~80 ms blocks
        self._last_raw = np.empty(0, dtype=np.float32)
        self._phase = 0.0  # fractional device-index of the next 16 kHz sample
        try:
            self.stream = sd.RawInputStream(
                samplerate=self._device_sample_rate,
                blocksize=frames,
                device=dev_idx,
                channels=1,
                dtype="int16",
                callback=self._callback,
            )
            self.stream.start()
        except Exception as e:
            self.stream = None
            raise RuntimeError(f"cannot open input device: {e}") from e
        self._opened = True
        sr_note = self._device_sample_rate if self._device_sample_rate != self.target_sr else "same"
        print(f"[audio] opened device={dev_idx} sr={self._device_sample_rate} (target {self.target_sr}, {sr_note})",
              flush=True)
        if self._device_sample_rate != self.target_sr:
            print(f"[audio] device runs at {self._device_sample_rate} Hz; resampling to {self.target_sr} Hz",
                  flush=True)

    def close(self) -> None:
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        self._opened = False

    @property
    def opened(self) -> bool:
        return self._opened

    def reopen(self, device: Optional[str] = None) -> None:
        self.close()
        if device is not None:
            self.device = device or None
        self.open()

    # ---------- conversion ----------
    def _resample_to_target(self, x_new: np.ndarray) -> np.ndarray:
        """Streaming linear resample device-rate -> 16 kHz, phase-correct across calls.

        Keeps only the source tail that has not been fully consumed yet (`_last_raw`)
        plus the fractional position (`_phase`) of the next target sample, so no
        history is duplicated and no source sample is used twice.
        """
        if self._device_sample_rate == self.target_sr:
            return x_new
        dev, tgt = float(self._device_sample_rate), float(self.target_sr)
        x = np.concatenate([self._last_raw, x_new]).astype(np.float32)
        ratio = dev / tgt  # device samples per target sample
        phase = self._phase  # in (0, ratio]; relative to x[0]
        avail = len(x) - phase
        n_out = int(avail // ratio)  # whole target samples that fit in the remaining source
        if n_out <= 0:
            # not enough new data yet; keep everything for the next call
            self._last_raw = x.copy()
            return np.empty(0, dtype=np.float32)
        positions = phase + ratio * np.arange(n_out)
        out = np.interp(positions, np.arange(len(x)), x).astype(np.float32)
        last = float(positions[-1])
        keep_start = int(np.floor(last)) + 1  # first device sample not fully consumed
        self._last_raw = x[keep_start:].copy()
        self._phase = (last + ratio) - keep_start  # next target sample's offset
        return out

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        try:
            self._last_data_mono = time.monotonic()
            self._cb_n += 1
            x = np.frombuffer(indata, dtype=np.int16).astype(np.float32) / 32768.0
            if status:
                # overflow/underflow etc; ignore small transient ones
                pass
            x = x * self.gain
            resampled = self._resample_to_target(x)
            self._cb_out_last = len(resampled)
            self._cb_out_total += len(resampled)
            np.clip(resampled, -1.0, 1.0, out=resampled)
            self.feed.append(resampled)
        except Exception as e:  # callback must never raise
            if self.on_error is not None:
                self.on_error(f"audio callback error: {e}", False)
