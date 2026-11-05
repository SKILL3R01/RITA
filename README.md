# Rita Assistant

A fully local, fully private desktop assistant for Windows. Wake on **"Wiem"**, ask anything,
and she answers with a natural voice — everything (listening, thinking, speaking, memory) runs
on your machine. **No cloud. Nothing leaves your PC.**

> Clean-room original work: no third-party assistant code, assets, branding, or services are used.
> The reverse-engineering study that guided the rebuild is described in [`AYO-analysis-report.md`](AYO-analysis-report.md);
> all shipped code is an independent implementation.

## Install (one click)

Grab the latest installer from **[Releases](https://github.com/SKILL3R01/RITA/releases)** →
`Rita Assistant Setup x.y.z.exe`.

First run: voice packs download (~350 MB, resumable), Settings has a one-click **Ollama** install
button, and pulling the brain model (`qwen2.5:7b-instruct` by default, ~4.7 GB) happens from the
same panel. Say **"Wiem"** and she's yours.

Notes:
- The installer is unsigned, so Windows SmartScreen may ask for *"More info → Run anyway"*.
- Uninstalling keeps `%APPDATA%\rita-assistant` — her memory — intact.

## What she does

| | |
|---|---|
| 🎧 **Ears** | Custom "Wiem" wake model (energy-gated, no phantom triggers in silence) + faster-whisper STT — CPU, no GPU required |
| 🧠 **Brain** | Ollama (local llama.cpp runtime) — conversation sessions with real memory of facts and follow-ups across sessions |
| 🗣️ **Voice** | 26 built-in live voices (Kokoro-82M), Piper fallback, Windows SAPI fallback — plus your own **cloned signature voice** (optional Chatterbox setup) |
| ✋ **Hands** | Opens apps, types, reads your screen — always **confirm-first** ("yes, always" is remembered) |
| 🖥️ **Dashboard** | `Ctrl+Alt+D` — her memory, check-ins, per-app approvals, live state |
| 🌐 **Web reading** | Optional, **OFF by default** — only links you mention aloud are fetched |

### Hotkeys (global)

`Ctrl+Alt+L` push-to-talk · `Ctrl+Alt+S` ask about screen · `Ctrl+Alt+X` OCR-explain screen ·
`Ctrl+Alt+M` mute · `Ctrl+Alt+O` settings · `Ctrl+Alt+R` show/hide overlay · `Ctrl+Alt+Q` quit

## Architecture

Four runtimes, all local:

```
┌─ Electron shell ────────────── overlay UI, dashboard, settings
│   └─ helper (Python or standalone exe, pyinstaller)
│        wake (openWakeWord) → whisper STT → loopback WS :8771
│        trust: 32-byte launch key over fd 3 + HMAC-SHA256 handshake
└─ Ollama (127.0.0.1:11434) ──── the brain
```

The installer already bundles the standalone ears and voice engine — **no Python is needed for
daily use**. Python is only required if you want to clone your own voice (Chatterbox) or retrain
the wake model.

## Build from source

```bat
:: core (dev mode — ears run inside your Python)
cd ayo-reborn
npm install
pip install -r helper\requirements.txt
npm start
```

Packaging (what the Releases ship): `npm run dist` builds the NSIS installer, embedding
standalone PyInstaller builds of both Python engines (`helper/rita-listener.spec`,
`electron/scripts/kokoro-pack.spec`).

Deep docs: [`ayo-reborn/README.md`](ayo-reborn/README.md) · protocol spec:
[`ayo-reborn/protocol.md`](ayo-reborn/protocol.md) · staged plan:
[`ayo-reborn/ROADMAP.md`](ayo-reborn/ROADMAP.md)

## Privacy

- Speech, transcripts, memory, settings — all in `%APPDATA%\rita-assistant`, never uploaded.
- Network access is opt-in per link she reads for you, and the Ollama/model pulls you choose.
- The launch-key + HMAC handshake keeps anything on localhost from driving her ears.

## Status

v0.1.0 — the complete local assistant loop (wake → STT → local LLM → voice), memory,
dashboard, screen commands, packaged standalone engine.
