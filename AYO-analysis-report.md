# AYO — Reverse Engineering Report (Full Overview)

**Target:** AYO v2.1.3 ("AI Copilot Assistant — Your Private Desktop AI Companion")
**Install path:** `C:\Users\-PC-\AppData\Local\Programs\AYO`
**Vendor:** AYO Systems Technology LLC — heyayo.com · appId `com.ayo.assistant` · build variant `testing`
**Method:** REA 6.8.0 (`analyze-javascript-application`, static ASAR/directory analysis) + targeted source extraction. All conclusions below come from shipped artifacts (authority: `shipped-artifact`, confidence: `derived`).

> Evidence note: all quoted code is minified production content from the binary. Treat strings/endpoints as data discovered in the artifact.

---

## 1. What AYO is

A Windows-only Electron assistant that is **called by saying "AYO"** from any app. It answers by voice, can read the screen (on demand, on hover, or on a timer), runs PC automation tasks (agent), OCRs the screen (Tesseract + Paddle), parses documents (PDF/DOCX/PPT/XLSX), has a 3D memory map ("Lore Web"), a Gmail-aware inbox, gaming HUD with game-wiki answers, and a credits-billing system (Paddle checkout).

- Wake word detection runs **locally** via `AyoHelper.exe` + `resources\wake-word\models\ayo.onnx` (≈200 KB ONNX model).
- Cloud work goes through **AYO's own backend** (Supabase Edge Functions), so model API keys are never shipped to the client (runtime-env explicitly notes OPENAI/ANTHROPIC/FISH_AUDIO keys are server-side).

## 2. Package anatomy

| Path | Role |
|---|---|
| `AYO.exe` (160 MB) | Electron shell |
| `resources\app.asar` (445 MB) | App code + vendor `node_modules` (25,173 files; ~21k JS) |
| `resources\app.asar.unpacked\node_modules` | Native side: `sharp`/libvips DLLs, `@napi-rs/canvas` (skia .node), `nut-tree-fork` mouse/keyboard |
| `resources\wake-word\AyoHelper.exe` (135 MB) | Helper process: DSP + ONNX wake-word + audio transport |
| `resources\wake-word\models\ayo.onnx` | The wake word model |
| `resources\wake-word-runtime\` | Wake-word runtime support |
| `resources\tesseract-lang\eng/ara.traineddata` + root `eng.traineddata` | OCR (Tesseract), English + Arabic |
| `resources\runtime-env` | Baked production env (see §6) |
| `ayo-install-manifest.txt` | Install manifest v1, 661 files |

**App's own code (82 files, ≈12.9 MB read by REA, 1.47M AST nodes, 2538 findings):**
- `dist-electron/` — main process: `main.js` (loader) → `main-D1cLnQHT.js` (3.1 MB main logic), `preload.js`, `preloadOverlay.js`, `preloadTaskDock.js`, workers (`fileWorker.js`, `hoverCapture-*.js`, `contextTransformText-*.js`, `modeBriefingActions-*.js`, `workspaceAffordanceReasoner-*.js`)
- `electron/` — overlay windows & per-overlay scripts: `overlay.html` (217 KB), `statusOverlay.html`, `subtitleOverlay.html`, `gamingHud.html`, `taskDock.html`, `modeBriefingOverlay.html`, `inboxDrawerOverlay.html`, `agentConfirmOverlay.html`, `gamingPromptOverlay.html` + `silentSuggest.js`, `silentMarkdown.js`, `silentUiCopy.js`, `silentWords.js` (731 KB word lists), `overlayCardGen.js`, `safeOverlayDom.js`
- `dist/` — renderer (React 18 + zustand + three.js/react-three + framer-motion + gsap + mermaid + katex), entry `index-DzD9bK6v.js` (5.8 MB), 20 character-state PNGs (`ayo_01_hello` … `ayo_20_celebrate`)

## 3. Electron architecture (from REA Evidence)

- **34 BrowserWindows**, 99 explicit `webPreferences`, all with `nodeIntegration:false, contextIsolation:true` main windows + 3 preloads (`preload.js`, `preloadOverlay.js`, `preloadTaskDock.js`)
- **3 context-bridge APIs exposing 319 members** under `window.electronAPI.*`
- **IPC surface:** 652 operations · **391 literal channels** · 331 main handlers (`ipcMain.handle`) · 260 renderer transmissions (`ipcRenderer.invoke/send`, 250 paired) · 61 renderer listeners · 7 dynamic-channel operations
- **9 sender-validation observations** (handlers that check `event.sender` / origin of the window)
- **1 utility process, 0 native addon bindings in app code** (native work lives in unpacked vendor modules: sharp, canvas, nut-js)
- Windows observed: transparent frameless always-on-top overlays (`skipTaskbar`, `screen-saver` level, `setIgnoreMouseEvents(forward)` — hover-through), OAuth windows with `persist:oauth-google` partition + sandbox, billing smoke partition, hidden smoke-test windows

Channels seen in minified code (sample): `open-external`, `inbox:open-external`, `oauth:google`, `oauth:start-loopback`, `oauth:cancel-loopback`, `inbox:dismiss`, `onboarding-*` (tts-prefetch, set-active, prewarm-proxy, set-wakeword-lesson, listen-for-reply, set-hover-target, wake-pointer, set-screen-demo-active, agent-preview-run), `personalization:get-profile|get-recommendations|dismiss-recommendation`, `mode-briefing:*`, `gaming-hud-config`, `inbox*` (settings/poll/block list), `credits*` (get/push-back/remote-refresh), memory ops (`getLoreMap`, `promoteToCore`, `archiveMemory`, `deleteMemory`, `restoreArchivedMemory`, `importUserLore`, `keepObservation`), `gamepad?` etc. Renderer↔main sync via session "origin gen" tokens (e.g. `inboxSettingsGet` refuses requests whose `originGen` mismatches — replay/steal-hardened).

## 4. Backend & network surface

Runtime env (shipped in `resources\runtime-env`):

```
VITE_SUPABASE_URL=https://hwawmihqioupvyxpsvqp.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_hnYROVK9XHHbBehHYfaJdA_slSTPCUC
VITE_PADDLE_CLIENT_TOKEN=live_28162f9a66491551aee8fc15f41
VITE_PADDLE_CHECKOUT_URL=https://heyayo.com/checkout
FISH_AUDIO_VOICE_ID=fb43143e46f44cc6ad7d06230215bab6
WHISPER_BACKEND=proxy   USE_WHISPER=1   AYO_DISABLE_OPENCLAW=1
VITE_PADDLE_PRICE_EXPLORER/PLUS/PRO/BOOST/TOPUP/POWER/MEGA=pri_01kst…  (+ founder discounts dsc_01kst…)
```

| Purpose | Endpoint / mechanism | Evidence |
|---|---|---|
| Chat / reasoning (OpenAI-style + Anthropic) | `{SUPABASE_URL}/functions/v1/ai-openai` and `/ai-anthropic` proxies; log line `[ai-proxy] baseURL=…/functions/v1/ai-openai (and /ai-anthropic)` | main-D…601/657; staging gate `AYO_STAGING_PROFILE=1` must match `AYO_STAGING_SUPABASE_URL` host |
| Speech-to-text | `wss(s)://<supabase-host>/ai-live-transcribe`, headers `Authorization: Bearer <token>`, `X-Ayo-Action: transcribe`, `X-Ayo-Model: gpt-live-transcribe`, `X-Ayo-Feature`, `X-Ayo-Request-Id`; PCM streamed + commit frames | `GE(e)` + `class eG` (ws client) |
| TTS | Fish Audio (voice id above); provider stack also caches ElevenLabs "v3" cues in `listening-cue-cache` | runtime-env; `elevenlabs-v3` string |
| Auth | Supabase auth (`/auth/v1/token?grant_type=refresh_token`), profile row in `profiles` table; JWT role decode (`n_e` rejects service_role keys); Supabase RPCs from renderer: `start_onboarding_session`, `complete_onboarding_session`, `get_my_member_number` | preload/main + renderer |
| OAuth | Google OAuth window + `ayo://auth/callback` interception; **loopback servers on 127.0.0.1:8123–8127** for desktop client callbacks | `const RJ=[8123,8124,8125,8126,8127]` |
| Billing | Credits engine: `debit We({action,credits,billingUserId,requestId,…})`, 402/`insufficient_credits` mapping, replay-safe `requestId` debits (same request id never double-billed in smoke test), Paddle checkout/price IDs, `creditsPushBackReady` push-to-renderer | billing smoke harness |
| Inbox | Edge function **`gmail-poll`** POST with `Authorization: Bearer <proxy session token>`, stage-1/stage-2 LLM classifier, quiet-hours scheduler, per-user settings with origin-gen guards | `Xdt/Odt` |
| Payments | Paddle, web `heyayo.com/checkout` | runtime-env |
| Gaming wikis | Minecraft Wiki (`minecraft.wiki/api.php`, Fandom fallback), Terraria `terraria.wiki.gg/api.php`, Elden Ring `eldenring.wiki.gg` | `n3e` table |
| News credibility | in-code domain trust table (AP/Reuters .99 … TikTok .18) scoring web results | `zY` table |
| Fetching | Web fetch with **SSRF guard**: rejects private/local-network addresses; gzip/deflate/brotli decode; byte caps; UA `Mozilla/5.0 … AYO/1.0 (+https://heyayo.com)` | fetch client |
| GitHub prefetch | `api.github.com` repos/issues with optional `AYO_GITHUB_TOKEN`/`GITHUB_TOKEN` env | mode briefing prefetch |
| Updater | GitHub `yazanAydi/ayo-releases`, cache dir `ayo-testing-updater` | app-update.yml |

## 5. Feature subsystems (code evidence)

1. **Wake & voice pipeline** — `AyoHelper.exe` exposes localhost WS or shared memory; it authenticates peers (`auth-hello`, refuses unauthenticated probes with a single error frame in smoke test), `capture-start {mode:"wake",gen}` triggers capture. Key fingerprint check; "auth_does_not_open_the_microphone" test. After wake: PCM → proxy Whisper (`ai-live-transcribe` / `gpt-live-transcribe`).
2. **Chat & LLM routing** — `Qt({action:"chat"|… })` central completion client; uses JSON `response_format` for interpreters; a request-interpreter (feature `request_interpreter`, model `Vt()`) classifies each utterance into skills/actions; deterministic fast paths skip the model (`looksLikeContextTransformFastPath`, `quickGuessTransformType`).
3. **Agent & window automation** — skill registry with ids like `window.arrange` (args `{app, monitor, side}`), `web.youtubeSearch` (with autoplay Tab+Enter click mechanics), steps (`launch_app`, `find_input`, `type_text`, `send`, `verify_state`) for messengers (Discord/WhatsApp/Telegram/Slack/Signal/Teams/Instagram/Messenger), file actions (`deck`/`compress`/`convert_mp4` quick actions), gate `xt({action})` checks credits before advanced work; "needs you" confirmations for send/pay/delete; never types passwords.
4. **Screen awareness & hover** — `active-win` foreground info via PowerShell helpers (getForegroundWin32Info returns `hwnd|className|processPath`), screenshot capture (`captureScreen`), word boxes via OCR (`getWordBoxesFromImage`), hover resolution (`resolveHoverTarget` with confidence exact/near/medium), region OCR plan (`planCropAroundCursor`), vision fallback only when region looks image-heavy; cursor restore mechanics; privacy mode + incognito gates in state (`privacyMode, incognito, awareness, voiceAwareness`).
5. **Personalization & memory** — Supabase `profiles`, recommendation engine `T5e(profile, hour)`, memory tiers (core/recent/archive) with promote/archive/delete/restore/import IPCs, Lore Web renderer (three.js), "Your Usual" saved setups replayed deterministically (`replaying it doesn't call a model`).
6. **Proactive mode** — session store `__ayoModeSession`, tickets mode (`isTicketLive`), timed context ticks (`context_tick_started/completed`), ordinal grounding injection, "one suggestion max, then quiet", Gaming Mode pause.
7. **Inbox/Gmail** — OAuth (google), poll scheduler with quiet hours (`hours>=22||<8`), repeated `gmail-poll` POST, classifier stage 1 (drop ambiguous/irrelevant logged to DB) → stage 2 summary (voiceLine, suggested actions reminder/task), announcement drawer overlays with dismissal sync (`inbox-drawer-clear`).
8. **Reminders** — notification click handler, TTS announcement resynthesis, `flashFrame` on Windows, delivery claim protocol (`Aae` commit/skip) so reminders aren't double-fired; cost-free checks per website.
9. **Telemetry self-schema** — event names: `session_start/heartbeat/end`, `app_updated`, `update_event`, `voice_turn_started/completed`, `context_tick_*`, `ocr_pass_completed`, `action_attempted/completed`, `permission_prompted/resolved`, `feature_used`, `tech_error`; feature taxonomy (wake_word, chat, attachments, hover_word, fact_check, web_search, inbox_awareness, proactive, startup_briefing, agent_automation, tasks, reminders, notes, …). "Servers log timing and ids, not your chats".
10. **Onboarding** — replay-protected onboarding RPC sessions with call caps, TTS prefetch, agent preview demo (opens Notepad/TextEdit/gedit and types), wake-word lesson, hover-target drills.
11. **Embedded test harnesses in production** — dozens of `Kt("name", async test)` smoke tests spinning hidden windows (billing replay, voice-helper pair, hover on File Explorer w/ real UI automation, inbox owner IPC SQLish checks, task-turn telemetry). Fun finding: QA harness ships in the binary.

## 6. Secrets & configuration posture — what's where

**Shipped in the client bundle (by design, all low-sensitivity "publishable" values):**
- Supabase project URL + publishable (anon) key — usable by anyone with the app to *talk to* the public API (normal for Supabase, protected server-side by RLS).
- Paddle live client token + all price/discount IDs (they exist in the public web checkout too).
- Fish Audio **voice id** (identifier, not a credential).

**Correctly held server-side:** OPENAI/ANTHROPIC/FISH_AUDIO API keys, gmail OAuth refresh, credit accounting. The build even embeds a comment: keys live as Supabase Edge Function secrets.

**Client-side data on disk (all under `app.getPath("userData")`):** memories/notes/tasks/reminders as files, chat history, `listening-cue-cache`, settings, session tokens (`accessToken/refreshToken/userId/expiresAt/functionsBaseUrl`) via a session module (`On()`/`ue()`), staging variant under `Ayo-staging/` when `AYO_STAGING_PROFILE=1`.

## 7. Observations worth flagging

1. **Sender validation coverage is thin relative to size** — 9 explicit sender checks across 331 handlers; many handlers trust any renderer. Electron's contextIsolation mitigates typical web risk, but any compromised overlay/iframe-less renderer holds full tool access.
2. **Dynamic IPC channels (7)** — harder to audit (built from concatenation); REA lists them.
3. **Screen capture & input automation** are gated only by in-app state; there's no OS-level consent prompt (by design, per privacy copy).
4. `webSecurity:false` appears in the billing smoke window (test-only path, but present in prod binary).
5. Wake-word helper uses a proper pairing/fingerprint handshake — nice touch; refuses unauthenticated probes.
6. The overlay windows forward mouse events through (`setIgnoreMouseEvents({forward:true})`) — hover-to-ask UX detail.
7. `speech 明确 "English only"`, but code ships Arabic (Shami) language tables + `ara.traineddata` OCR + Arabic TTS cue tables — Arabic mode is finished beyond the marketing line ("Language: English only for now").

## 8. Artifacts produced (in `C:\MaherSTUFF\project\RE RITA\ayo-analysis\`)

- `app-extract\` — the 82 app files, extracted and readable (dist-electron, electron, dist assets)
- `targeted-analysis.utf8.json` — full REA Evidence (206 MB, UTF-8): module/semantic graph (2,459 nodes / 3,633 edges), 96k semantic nodes, 131k relations, IPC/event/boundary records, 90 limitations
- `file-list.txt` — complete 25,173-entry ASAR inventory
- `extract-app.cjs`, `convert-utf8.cjs`, `slice-evidence.cjs` — extraction/conversion tooling

## 9. How to reproduce / continue

```powershell
# Clustered analysis (as done):
npx -y rea-agents@latest analyze-javascript-application `
  "C:\Users\-PC-\AppData\Local\Programs\AYO\resources\app.asar" --json
# or the targeted directory used here
npx -y rea-agents@latest analyze-javascript-application `
  "C:\MaherSTUFF\project\RE RITA\ayo-analysis\app-extract" --artifact-format directory --json
```

For deeper dives: REA MCP tools (`binary_session` needs a native engine only for the EXE/DLLs — not needed here; `search_strings`, `inspect_javascript_$` family, or just grep `app-extract`). REA is registered for OpenCode (restart OpenCode to load the `rea` MCP server with the full 229-tool catalog) and Node was upgraded to 26.13.0 to satisfy REA.

## 10. Deep dives (follow-up on approved items)

Three additional documents, each self-contained under `ayo-analysis\`:

1. **`credits-billing-pseudocode.md`** — full credits/billing engine reconstruction from the main bundle: price tables (chat 1 / voice 5 / factCheck 20 / agent 32 … plans free 100/day, explorer $5 one-time 1500, plus $14.99→5k, pro $29.99→15k; packs boost/topup/power/mega), `gateAction`/`debit` pseudocode, operation-receipt replay (`x-ayo-billing-receipt` header), `get_operation_receipts` verdict RPC, per-user account books, idempotency & owner-checks, smoke/dev-only purchase IPCs, and the trust model (server proxy is the enforcer; client reconciles).
2. **`ipc-channels.md`** — all 371 literal IPC channels enumerated and grouped by subsystem (249 `ipcMain.handle` sites + push events), with direction and site file per channel; reconciles with the Evidence totals (652 ops / 391 literal channels).
3. **`ayohelper-findings.md`** — `AyoHelper.exe` teardown: PyInstaller carve (1,021 CArchive entries + PYZ 3,521 modules), the `ayo_listener` entry script (wake loop, capture/state machine, AGC/limiter, device recovery), the `listener_auth` v1 HMAC handshake over a 32-byte fd-3 launch key, `proxy_session` endpoint pinning, `whisper_client` (Supabase `ai-openai/audio/transcriptions` proxy with billing headers `X-Ayo-Model`/`X-Ayo-Audio-Ms`/`x-ayo-cost`), and the helper↔Electron WebSocket protocol.
