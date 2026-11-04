# Rita — staged roadmap

Everything (staged) was the agreed scope. Fully local stack. Stages 1–4 are implemented (core); 5–7 are future work.

## Stage 1 — Voice core MVP ✅ (this release)
- Python helper: fd-3 launch key → HMAC handshake → openWakeWord wake detection
- Wake → capture → faster-whisper STT → transcript push over WS
- Electron shell: overlay window, Ollama chat, SAPI TTS echo-safe speaking loop
- Settings file, mute hotkey, pause/resume listening around replies
- Generations/stale-capture guard, mic device enumeration + selection

## Stage 2 — Screen awareness ✅ (core shipped)
- Global hotkey **Ctrl+Alt+S** — whole-screen capture → local vision model (qwen2.5vl:3b via Ollama, ~2 s per question on CPU @1400px; moondream retired — weak quality) → spoken "what's on my screen"
- Global hotkey **Ctrl+Alt+X** — capture → Windows built-in OCR (Windows.Media.Ocr, zero install) → LLM explanation → spoken
- Auto-pull of missing vision models (and friendly retry hint)
- Desktop capture via Electron native desktopCapturer (a PowerShell capture variant was blocked by Defender AMSI — native API is the better path)
- ✅ OCR verified reading synthetic text; ✅ capture verified; vision end-to-end verified (SMOKE2), OCR screen-explain end-to-end verified (SMOKE3: 1257 chars read + spoken LLM explanation)
- Key findings baked in: (1) OCR quality collapses below ~1500px width (6 chars) vs native capture (1257 chars) — Win11 OcrEngine.MaxImageDimension = 10000; (2) vision captures must stay 1600px wide or qwen2.5vl exceeds its 4096-token context; (3) never preprocess screenshots for OCR — invert/grayscale both *worsened* reads

### Stage 2 remaining (FUTURE cool ideas)
- Active-window-only capture mode (needs careful window bounds, no PS P/Invoke — Defender blocks script P/Invoke)
- Hover/copy-mode picker (snip region, apply OCR to chosen rect)
- Window picker for "look at THAT app"
- Screen-aware followup chat multi-turn

## Stage 3 — Memory/personalization ✅ (core shipped)
- Local memory store, zero cloud, zero native deps: `%APPDATA%\rita-assistant\facts.json` (spoken facts) + `turns.jsonl` (every voice/screen exchange, auto-rotating, last ~2000 kept in RAM)
- Deterministic spoken intents (no LLM round-trip): "remember that …", "call me …", "what do you remember", "forget …", "forget everything", "what's my name"
- Recall injection: facts always enter the chat system prompt; keyword+recency search over past turns injects the 3 most relevant earlier exchanges with fuzzy time labels
- Turn logging from voice, screen-vision and OCR flows
- SMOKE4 memory test passes end-to-end
- Voice, tiered (all fully local): (1) **signature cache** — Sesame **CSM-1B** (Apache-2.0; ungated mirror `unsloth/csm-1b`) pre-generates canned phrases offline on CPU (slow per line, instant playback at runtime); (2) **Piper** voices for everything else (instant); (3) Windows SAPI fallback. Voice **cloning** = CSM speaker-context: any consented reference wav (e.g. the user's own recording) regenerates the signature cache in that voice
- Notes: transformers ≥5.22 supports CSM natively; `torch 2.10.0+cpu` + 31.6 GB RAM verified; `Qwen/Qwen3-TTS-12Hz` 0.6B/1.7B already in the user's HF cache — newer 12Hz design is CPU-friendlier but not yet supported by transformers (vLLM/WSL2 later); sesame HF repo is gated — use the ungated mirror for download
- Voice control, by voice: "switch to jenny/amy/...", "switch to windows voice", "which voices do you have"

### Stage 3 remaining (FUTURE cool ideas)
- Embedding-based semantic recall (Ollama embeddings + local vector index) to replace keyword matching
- Memory UI panel (view/edit/forget-all)
- Daily digest ("what did you learn about me this week")

## Stage 4 — Agent automation ✅ (core shipped)
- **Conversation sessions (new): "Ayo" wakes her once, then the conversation runs hands-free.**
  After every answered turn the main app starts a session; follow-up speech triggers captures
  from energy VAD — no wake word, no CPU wake scoring. End it 3 ways: say "thanks"/"bye"/
  "that's all" (spoken goodbye + wake re-armed), ~40 s of silence (auto), or the 10 min budget.
  Empty false-triggers tighten the window to 6 s (2 in a row → done). All knobs via
  `RITA_SESSION_*` env: SILENCE_MS / EMPTY_GAP_MS / RMS / VAD_BLOCKS / MAX_MS. Helper tests
  extended: start/stop round-trip + silence timeout → 16 ALL-PASS.
- **Confirm-first** voice actions: "open chrome", "open https://…", bare domains auto-prepended `https://`, "switch to notepad", "type hello world in notepad" (or into the frontmost window) — Rita asks, user says "yes"/"no"
- Allowlist: plain app names + domains + http(s) URLs via strict regexes; anything else is refused with a spoken reason
- Windows execution without AMSI trouble: `cmd /c start` via spawn args (no shell string), and `WScript.Shell` AppActivate/SendKeys through **-EncodedCommand** PowerShell (no P/Invoke, no quoting pitfalls); SendKeys specials pre-escaped
- Session log: every action (executed/dry/refused/fail) appended to `%APPDATA%\rita-assistant\agent-log.jsonl`; SMOKE5 dry-run test passes
- **Settings panel, Ctrl+Alt+O**: assistant **name** → derived system prompt, voice picker with instant
  "test line" + **signature voice** toggle, mic device picker (live re-open), wake threshold slider
  (live `set-params`), session silence (seconds), confirm-before-agent, mute, model chooser with
  one-click pull, restart = relaunch
- **Signature cache live**: 12 Sesame CSM lines in `%APPDATA%\rita-assistant\signature`, exact-match
  instant playback (user-audible); voice cloning = a consented reference wav regenerates the cache
- **Wake-bleed polish**: helper tags every transcript with capture `mode`; wake-mode transcripts get
  the misheard wake lead ("yo"/"i owe you"/"are you"/"here okay") stripped before the LLM; wake
  trigger now requires 2 of the last ~400 ms of scores above threshold
  (`RITA_WAKE_MIN_FRAMES`, default 2; 1 = old peak-only) — kills single-frame phantom fires;
  a **wake-only capture** (user said just "Ayo", ASR wrote "Are you?"/"yo") no longer asks the
  LLM to answer "Are you?" — it opens up to 2 chained follow-up listens for the command and
  then stays quiet

### Stage 4 remaining (FUTURE cool ideas)
- EnumWindows-based app switcher ("switch to the window with X in the title" — substring matching beyond title starts)
- "close <app>" with extra confirm; per-action confirm exemptions ("always allow opens")
- Streaming dictation mode (continuous speech→typing), window-picker UI

## Stage 5 — Inbox / drips
- Voice-created reminders + scheduled drips ("catch-up" on asked-for items)
- Local notifications, snooze, completion ledger

## Stage 6 — Local credits engine (stub)
- Mirror the client-side reconciliation architecture (actions with costs, daily refill, receipts), but no enforcing server and no billing — fully local quota for fun/discipline and future-proofing

## Stage 7 — Gaming HUD / polish
- Tiny always-on-top HUD overlay mode, game-mode toggles, wake-word glow polish
- Voice-driven HUD actions, mic diagnostics dashboard

## Deferred by design (documentation only, no implementation)
- Cloud STT proxy + session pinning — replaced by fully-local STT (AYO's `proxy_session` equivalent is not needed); if ever needed, follow the endpoint-pinning pattern documented in `ayo-analysis/ayohelper-findings.md`
- Custom wake model training from the user's own recordings (openWakeWord training pipeline) — the swap-in for `ayo.onnx` when we want a shippable wake phrase
