# Rita protocol — helper ⇄ main (v1)

The helper owns the microphone and runs the WebSocket **server**; the Electron main
process connects as the client. Loopback only (`127.0.0.1:8771`). One client at a time.

Architecture mirrors the pattern found in AYO's helper (fd-3 launch key, HMAC handshake,
command/event schema) but with original names, constants, and a local STT design.

## Auth handshake (before any command; non-auth frames close the socket)
1. helper → `{"type":"auth-hello","v":1,"nonce":"<helper-nonce-hex>"}`
2. main   → `{"type":"auth-proof","v":1,"nonce":"<main-nonce-hex>","proof":<hex>}`
   - proof = HMAC-SHA256(key, `b"rita-listener-auth-v1\n" + b"main-proof " + <helper-nonce> + b" " + <main-nonce>`, hex)
3. helper verifies (constant-time) → `{"type":"auth-ok","proof":<hex>}` with role `helper-proof` over the same message
4. Failure at any point → close. Sockets presenting an `Origin` header are rejected outright.

Root of trust: the 32-byte launch key is written by Electron into inherited stream
fd 3 at spawn (never argv/env/stdio). Dev stand-in: `RITA_KEY_FILE` reads 32 raw bytes.

## Commands (main → helper), envelope `{"command": "...", ...}`
| command | payload | reply |
|---|---|---|
| `hello` | `{client}` | `{type:"state",...}` |
| `get-state` | – | `{type:"state",...}` |
| `set-params` | `{threshold?, sessionRms?, sessionVadBlocks?, cooldownMs?, device?}` — live tuning of the wake threshold and the in-session speech-energy gate | `{type:"ack",of:"set-params",...}` |
| `list-devices` | – | `{type:"devices",devices:[{name,default}]}` |
| `set-device` | `{name}` | ack |
| `capture-start` | `{generation, mode:"wake", maxMs?}` | `{type:"ack",...}` then capture events |
| `capture-stop` | – | ack (capture cancelled, no transcript) |
| `finalize-capture` | `{generation}` | ack; capture finalized by user |
| `pause-listening` | `{reason}` | ack (wake off; used while Rita speaks) |
| `resume-listening` | `{suppressMs?}` | ack (wake re-armed, detections suppressed for suppressMs) |
| `listen-now` | – | ack; capture starts right away (no wake word required) |
| `start-session` | `{silenceMs?}` (default 40000) | ack + `state`. Conversation session: wake word no longer required; captures trigger from voice activity (energy VAD). 1.2 s echo muzzle after start. |
| `stop-session` | – | ack + `session-ended`. Ends the conversation, wake word re-armed. |
| `ping` | – | `{type:"pong",...}` |

## Events (helper → main), envelope `{"type": "...", ...}`
| event | payload |
|---|---|
| `wake` | `{score, model, generation}` |
| `capture-started` | `{generation, preRollMs}` |
| `capture-cancelled` | `{generation, reason}` |
| `transcript` | `{text, language, generation, audioMs, mode}` — end of a successful capture (`mode` = `"wake"` \| `"session"` \| `"manual"`, tells the client why the capture ran; `"wake"` captures contain the wake word itself, so clients may strip the misheard lead) |
| `not-heard` | `{generation, audioMs}` — capture finished but contained no usable speech |
| `session-ended` | `{reason}` — conversation session over (`silence` \| `budget` \| `stopped by main`); wake word needed again |
| `stt-status` | `{available, model, device}` — emitted on connect & change |
| `state` | `{listening, capturing, device, wakeReady, generation, session}` (also reply to `hello`) |
| `mic-error` | `{message, fatal}` |
| `pong` | `{health}` |

## State machine
`listening → (wake) → capturing → (silence/maxMs/finalize) → transcribing → listening`
- `capture-start` with a stale or wrong `generation` is ignored (stale-generation guard).
- `pause-listening` → `paused` (wake scoring suspended; capture aborted if any).
- After `resume-listening`, wake detections are suppressed for `suppressMs` (echo shield).

### Conversation session (`start-session` … `session-ended`)
- While `session: true`, LISTENING-state audio skips wake scoring entirely; sustained
  energy over `RITA_SESSION_RMS` (default 0.075) for `RITA_SESSION_VAD_BLOCKS` (4)
  consecutive blocks auto-starts a capture (`mode:"session"`, model `vad`).
- Silence clock: refreshed by every real transcript and by every `resume-listening`.
  Expires → `session-ended{reason:"silence"}`. Only a session-start `silenceMs` overrides
  the default (`RITA_SESSION_SILENCE_MS` = 40 s).
- After a not-heard capture the window tightens to `RITA_SESSION_EMPTY_GAP_MS` (6 s);
  2 in a row → `session-ended{reason:"silence"}`.
- Hard budget `RITA_SESSION_MAX_MS` (10 min) → `session-ended{reason:"budget"}`.
  `paused`/`transcribing` time does not tick the clock.
- In-session captures never emit a `wake` event — the helper starts them itself.


## Frames
JSON text frames; helpers keep unpublished frame size discipline (≤ 1 MiB). No binary frames in v1.
