# Rita
An original, fully-local desktop assistant in the AYO style: wake-word → capture → speech-to-text → local LLM → spoken reply, with a minimal on-screen overlay. Clean-room rebuild — no AYO code, assets, branding, or services are used.

## Status
Stages 1–4 are implemented (core): voice loop with conversation sessions, screen awareness,
memory, agent automation, the typed CSM voice signature cache, and a runtime settings
panel. Detail tracked in `ROADMAP.md`.

## Stack (fully local, zero cloud)
| Role | Component |
|---|---|
| Shell/UI | Electron main process + frameless overlay window |
| Wake word | custom **"Wiem"** openWakeWord model (`wiem.onnx`, trained locally from piper-synthesized positives/hard negatives; `electron/scripts/train-wakeword.py`) |
| Audio | `sounddevice` raw capture, 16 kHz mono pipeline, resample fallback |
| STT | faster-whisper (CPU, int8) inside the helper |
| LLM | Ollama (`http://127.0.0.1:11434`) |
| TTS (live) | **Kokoro-82M** (`kokoro-onnx`, onnxruntime — natural spoken replies, spacy-free) → Piper fallback → Windows SAPI |
| Voice cloning | **Chatterbox TTS** (Resemble AI, MIT) pre-generates the 12 signature lines from the user's recorded reference (legacy CSM-1B kept behind `voiceEngine:"csm"`) |
| Bridge | Helper runs a loopback WebSocket server on `127.0.0.1:8771`; Electron connects |
| Trust | 32-byte launch key passed over an inherited pipe (fd 3) + HMAC-SHA256 handshake |

## Layout
```
electron/        main.cjs (spawn helper, WS client, Ollama chat, TTS, overlay), preload.cjs, ui/
helper/          rita_listener/ Python package (auth, audio, wake, stt, server)
protocol.md      WebSocket + auth protocol spec (our own channel names)
ROADMAP.md       The seven staged stages
```

## Run
```bat
:: 1. once:  npm install   (adds Electron)
:: 2. once:  see helper/README inside pip requirements
npm start
```
Say "Wiem" (or hold **Ctrl+Alt+L**) and ask. After her answer the **conversation session**
starts: keep talking without repeating wake word questions, say "thanks"/"bye"/"that's all" and
she signs off; ~40 s of silence (2 missed triggers narrow it to 6 s) or 10 min ends it the same way.
The Electron main spawns `python -m rita_listener` automatically, writes the launch key to fd 3,
connects, and drives the overlay. Manual helper runs for debugging:
```bat
:: helper dev mode: key comes from a file instead of fd 3
python helper\scripts\make_dev_key.bat      (creates .dev-key)
set RITA_KEY_FILE=... && python -m rita_listener
```

## Control
All hotkeys are global (work from any app):

| Hotkey | Action |
|---|---|
| **Ctrl+Alt+O** | Open the settings panel |
| **Ctrl+Alt+R** | Show/hide the overlay pill |
| **Ctrl+Alt+M** | Mute / unmute |
| **Ctrl+Alt+L** | Push-to-talk (wake-word substitute) |
| **Ctrl+Alt+S** | Ask about your screen (local vision model) |
| **Ctrl+Alt+X** | Explain your screen (built-in OCR) |
| **Ctrl+Alt+Q** | Quit |

The **settings panel** (Ctrl+Alt+O) is the main control interface: assistant **name**
(what she calls herself in conversation; wake word is the locally trained **"Wiem"** —
say it and she wakes), **voice**
(Kokoro natural voice picker + Piper list, live-voice toggle, signature-voice toggle,
instant "say a test line"),
**microphone** device picker (applies live), **wake sensitivity** slider (live threshold
update), **conversation session length**, confirm-before-agent toggle, mute, chat/vision
model chooser with one-click pull, and a **restart assistant** button.

## Settings
`%APPDATA%\rita-assistant\settings.json` (created first run; everything editable in the
panel). Keys: `name`, `wakeThreshold`, `sessionSilenceMs` (seconds), `sttModel`,
`ollamaModel`, `visionModel`, `micDevice`, `ttsRate`, `ttsVoice`, `ttsKokoro`,
`kokoroVoice`, `voiceEngine`, `signatureVoice`, `confirmAgent`, `ollamaPath`,
`pythonPath`, `wsPort`, `mute`.
Wake-loop tuning env: `RITA_WAKE_MIN_FRAMES` (default 2 — of the last ~400 ms of wake
scores, two must clear the threshold to arm a capture; set 1 for old peak-only behavior).

## Legal
- The custom wake model is trained 100% locally (renders, features, training). Re-train with
  `python electron/scripts/train-wakeword.py --phrase "Wiem" --steps 12000`; drop extra spoken
  examples as .wav files via `RITA_WAKE_EXTRA_CLIPS` to fold in her real voice. Retraining is
  fast after the first run (feature cache in `wakeword-train/features`, checkpoint resumable).
- Everything here is original code written for this project. Do not copy AYO's code, assets, or branding and do not use their service endpoints/credentials.
