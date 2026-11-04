"""Central configuration for the helper. All knobs override via RITA_* env vars."""
import os
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    try:
        return int(v)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _default_wake_onnx() -> str:
    """Default wake model: the installed AYO model used from its own install dir.

    NOTE: that .onnx remains AYO's property; Rita points at the installed copy for
    personal local use only. Set RITA_WAKE_ONNX (or the Electron setting) to your own
    trained openWakeWord model for anything distributable.
    """
    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        cand = Path(local_app) / "Programs" / "AYO" / "resources" / "wake-word" / "models" / "ayo.onnx"
        if cand.is_file():
            return str(cand)
    # fallback: a Rita-owned models dir next to the helper, when it exists
    cand2 = Path(__file__).resolve().parent.parent / "models" / "rita-wake.onnx"
    return str(cand2)


def device_default_input() -> str | None:
    return os.environ.get("RITA_MIC_DEVICE") or None


class Config:
    def __init__(self) -> None:
        self.ws_port: int = _env_int("RITA_WS_PORT", 8771)
        self.ws_host: str = os.environ.get("RITA_WS_HOST", "127.0.0.1")

        # wake word
        self.wake_onnx_path: str = os.environ.get("RITA_WAKE_ONNX") or _default_wake_onnx()
        self.wake_threshold: float = _env_float("RITA_WAKE_THRESHOLD", 0.42)
        self.wake_cooldown_ms: int = _env_int("RITA_WAKE_COOLDOWN_MS", 1500)
        # decision = rolling max of the last scores inside this window ( catches the peak )
        self.wake_rolling_window_ms: int = _env_int("RITA_WAKE_ROLLING_WINDOW_MS", 400)
        self.wake_min_frames: int = _env_int("RITA_WAKE_MIN_FRAMES", 2)  # of the last ~400 ms of wake scores, how many must clear the threshold (1 = peak-only, old behavior)
        # silent-ring gate: this wake model fires on pure silence (observed: 0.9+ scores
        # on an RMS-0.002 empty room, endlessly). A trigger is only honored when the
        # preroll ring carries speech-level energy — no sound, no possible voice.
        # 0 disables the gate.
        self.wake_min_rms: float = _env_float("RITA_WAKE_MIN_RMS", 0.004)

        # capture
        self.capture_max_ms: int = _env_int("RITA_CAPTURE_MAX_MS", 30000)
        self.capture_silence_s: float = _env_float("RITA_CAPTURE_SILENCE_S", 2.0)
        self.capture_silence_min_s: float = _env_float("RITA_CAPTURE_SILENCE_MIN_S", 1.2)
        self.pre_roll_ms: int = _env_int("RITA_PRE_ROLL_MS", 800)
        # speech-energy gate: rms must exceed max(abs floor, ratio * noise floor)
        self.vad_abs_floor: float = _env_float("RITA_VAD_ABS_FLOOR", 0.006)
        self.vad_ratio: float = _env_float("RITA_VAD_RATIO", 2.2)
        self.queued_capture_grace_ms: int = _env_int("RITA_CAP_GRACE_MS", 2000)

        # resume suppression (echo shield while the assistant finishes speaking)
        self.resume_suppress_ms: int = _env_int("RITA_RESUME_SUPPRESS_MS", 1500)

        # stt (faster-whisper, CPU)
        self.stt_model: str = os.environ.get("RITA_STT_MODEL", "base")
        self.stt_device: str = os.environ.get("RITA_STT_DEVICE", "cpu")
        self.stt_compute: str = os.environ.get("RITA_STT_COMPUTE", "int8")
        self.stt_language: str | None = os.environ.get("RITA_STT_LANGUAGE") or None

        # conversation session (wake once, keep talking; ends on silence, "thanks", or budget)
        self.session_silence_ms: int = _env_int("RITA_SESSION_SILENCE_MS", 40000)
        self.session_empty_gap_ms: int = _env_int("RITA_SESSION_EMPTY_GAP_MS", 6000)
        self.session_rms: float = _env_float("RITA_SESSION_RMS", 0.007)
        self.session_vad_blocks: int = _env_int("RITA_SESSION_VAD_BLOCKS", 3)
        self.session_max_ms: int = _env_int("RITA_SESSION_MAX_MS", 600000)

        # audio
        self.mic_device: str | None = device_default_input()
        self.target_sample_rate: int = _env_int("RITA_TARGET_SR", 16000)
        self.block_samples: int = _env_int("RITA_BLOCK_SAMPLES", 1280)  # 80 ms @ 16k
        self.input_gain: float = _env_float("RITA_INPUT_GAIN", 1.0)

        # dev conveniences (never enabled in a packaged app)
        self.key_file: str | None = os.environ.get("RITA_KEY_FILE") or None
        self.dev_mode: bool = os.environ.get("RITA_DEV", "") == "1"

    @property
    def wake_model_exists(self) -> bool:
        return Path(self.wake_onnx_path).is_file()
