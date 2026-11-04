"""Local speech-to-text with faster-whisper (CPU, int8 by default).

 pagan-model download happens lazily on first use and is cached by HuggingFace.
 heavy work runs inside the server's executor thread, never the asyncio loop.
"""
from typing import Optional
import numpy as np


class SttEngine:
    def __init__(self, model_name: str, device: str = "cpu", compute_type: str = "int8",
                 language: Optional[str] = None) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self._model = None
        self._load_error: Optional[str] = None
        self.available = True

    def ensure_loaded(self) -> None:
        if self._model is not None or self._load_error is not None:
            return
        try:
            from faster_whisper import WhisperModel  # local import: slow
            print(f"[stt] loading faster-whisper {self.model_name} ({self.device}/{self.compute_type}) …", flush=True)
            self._model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute_type)
            print("[stt] model ready", flush=True)
        except Exception as e:
            self.available = False
            self._load_error = str(e)
            print(f"[stt] FAILED to load: {e}", flush=True)

    def status(self) -> dict:
        return {
            "available": self.available,
            "model": self.model_name if self.available else None,
            "device": self.device if self.available else None,
            "error": self._load_error,
        }

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000) -> tuple[str, str, int]:
        """Returns (text, language, audio_ms). audio: float32 mono, -1..1."""
        if self._model is None:
            self.ensure_loaded()
        if self._model is None:
            raise RuntimeError(f"STT unavailable: {self._load_error}")
        audio_ms = int(len(audio) * 1000 / sample_rate)
        if audio_ms < 200:
            return "", self.language or "en", audio_ms
        segments, info = self._model.transcribe(
            audio,
            language=self.language,
            beam_size=1,
            condition_on_previous_text=False,
            vad_filter=True,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return text, getattr(info, "language", self.language or "en"), audio_ms

    async def transcribe_async(self, loop, audio: np.ndarray) -> tuple[str, str, int]:
        return await loop.run_in_executor(None, self.transcribe, audio, 16000)
