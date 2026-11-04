// Rita — Electron main process. Original code, clean-room.
// Spawns the Python listener (launch key over fd 3), connects to its loopback
// WebSocket, drives the overlay + Ollama chat + Windows SAPI TTS.

const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron')
const crypto = require('crypto')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const fsProm = require('fs/promises')

let overlay = null
let helperChild = null
let ws = null
let wsOpen = false
let launchKey = null
let closing = false
let restartTries = 0
let connectTries = 0
let lastState = { paused: true }  // start "paused-ish" until helper reports
let lastDevices = []              // mic list cached for the settings panel
let sttStatus = { available: false, model: null }
let history = []                   // {role, content}[]
let wsSessionActive = false        // conversation session: no wake word needed after a turn
const PENDING = {}

// ---------------------------------------------------------------- settings
const SETTINGS_DEFAULTS = {
  wakeOnnxPath: process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'AYO', 'resources', 'wake-word', 'models', 'ayo.onnx')
    : '',
  wakeThreshold: 0.42,
  wsPort: 8771,
  sttModel: 'base',
  sttLanguage: 'en',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b-instruct',
  visionModel: 'qwen2.5vl:3b',
  ollamaPath: '',   // full path to ollama.exe for pulls; empty = autodetect
  micDevice: '',
  ttsRate: 1,
  ttsVoice: '',     // '' = built-in Windows SAPI voice; else piper voice name, e.g. "en_US-amy-medium"
  ttsKokoro: true,  // Kokoro-82M live voice (natural, fast) — tried before piper for streaming replies
  kokoroVoice: 'bf_emma', // Kokoro voice code: bf_emma/bf_isabella (British), af_heart/af_bella (American)
  voiceEngine: 'chatterbox', // signature cloner: 'chatterbox' (much more natural) or legacy 'csm'
  signatureVoice: true, // play cloner-cached signature lines when they exist
  name: 'Rita',     // assistant's name in conversation (wake word itself stays "Ayo")
  sessionSilenceMs: 40,   // SECONDS of no speech that end a conversation session
  sessionRms: 0.007,      // in-session speech energy gate (matches helper default; panel-tunable)
  confirmAgent: true,  // agent actions ask "say yes" before executing (per-app "always" memory below)
  internetRead: false, // Stage E: opt-in — she reads (fetches + summarizes) web links only if the user turns this on
  approvedApps: {},    // { "chrome": {"at": ts} } — apps the user approved once with "yes, always"
  mute: false,
  pythonPath: '',   // override for packaged/venv setups; default = "python" on PATH
}

function settingsFile() { return path.join(app.getPath('userData'), 'settings.json') }
let S = { ...SETTINGS_DEFAULTS }

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    S = { ...SETTINGS_DEFAULTS, ...raw }
  } catch { S = { ...SETTINGS_DEFAULTS } }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(S, null, 2)) } catch (e) { log(`settings save failed: ${e}`) }
}

// ---------------------------------------------------------------- logging
function log(msg) { console.log(`[rita] ${msg}`) }

// ---------------------------------------------------------------- helper spawn
function helperEnv() {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',  // server _log must never die on a charmap codepage
    RITA_WS_PORT: String(S.wsPort),
    RITA_WAKE_ONNX: S.wakeOnnxPath,
    RITA_WAKE_THRESHOLD: String(S.wakeThreshold),
    RITA_STT_MODEL: S.sttModel,
    RITA_STT_LANGUAGE: S.sttLanguage,
    RITA_MIC_DEVICE: S.micDevice || '',
  }
}

function spawnHelper() {
  launchKey = crypto.randomBytes(32)
  const py = S.pythonPath || 'python'
  const cwd = path.join(__dirname, '..', 'helper')
  log(`spawning helper (${py} -m rita_listener)`)
  helperChild = spawn(py, ['-m', 'rita_listener'], {
    cwd,
    env: helperEnv(),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],  // 3 == the launch-key pipe
    windowsHide: true,
  })
  // Write the 32-byte launch key to fd 3 immediately — never argv/env/logs.
  try { helperChild.stdio[3].write(launchKey) } catch (e) { log(`fd3 key write failed: ${e.message}`) }
  helperChild.stdout.on('data', (d) => log(`helper: ${String(d).trim()}`))
  helperChild.stderr.on('data', (d) => log(`helper[err]: ${String(d).trim()}`))
  helperChild.on('exit', (code) => {
    log(`helper exited (code=${code})`)
    helperChild = null
    wsOpen = false
    if (closing) return
    overlaySend({ type: 'helper-state', data: { connected: false, reason: `helper exited (${code})` } })
    restartTries += 1
    const delay = Math.min(15_000, 1_000 * restartTries)
    setTimeout(() => { if (!closing) spawnHelper() }, delay)
  })
}

function killHelper() {
  if (helperChild) {
    try { helperChild.kill() } catch {}
    helperChild = null
  }
}

// ---------------------------------------------------------------- websocket client
function connectHelper() {
  clearTimeout(connectHelper._t)
  if (ws) { try { ws.close() } catch {} ws = null }
  const url = `ws://127.0.0.1:${S.wsPort}`
  let sock
  try { sock = new WebSocket(url) } catch (e) { scheduleReconnect(); return }
  ws = sock
  sock.addEventListener('open', () => { log(`ws open ${url}`) })
  sock.addEventListener('error', () => { scheduleReconnect() })
  sock.addEventListener('close', () => {
    wsOpen = false
    overlaySend({ type: 'helper-state', data: { connected: false, reason: 'disconnected' } })
    scheduleReconnect()
  })
  sock.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    handleHelperMessage(msg)
  })
}

function scheduleReconnect() {
  if (closing) return
  connectTries = Math.min(connectTries + 1, 60)
  clearTimeout(connectHelper._t)
  connectHelper._t = setTimeout(connectHelper, Math.min(3_000, 250 * connectTries))
}

function wsSend(obj) {
  if (!ws || ws.readyState !== 1) { log(`ws not open, dropping ${obj.command || obj.type}`) ; return }
  ws.send(JSON.stringify(obj))
}

// ---------------- conversation session (wake once, keep talking until "thanks" or silence) ----------------
const SESSION_BYE_RE = /^(thanks( you)?( so much| a lot| very much)?|thank you|bye( bye| now)?|bye bye|goodbye|good bye|good night|goodnight|thanks bye|bye thanks|done thanks|thanks go|thats all|that's all|thats it|that's it|thats good|that's good|thats everything|all done|you can stop|stop listening|stop now)$/

function isSessionBye(text) {
  const t = String(text).toLowerCase()
    .replace(/['’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(okay|alright|well|so) /g, '')
  return SESSION_BYE_RE.test(t)
}

function overlaySessionHint(on) {
  overlaySend({
    type: 'hint',
    data: { text: on ? 'conversation on — say "thanks" to end' : '"Wiem" wakes me · L push · S screen · X read' },
  })
}

function startConversationSession() {
  wsSend({ command: 'start-session', silenceMs: Math.max(10, Number(S.sessionSilenceMs) || 40) * 1000 })
  wsSessionActive = true
  overlaySessionHint(true)
}

function resumeListening(suppressMs = 1500) {
  // in-session: the helper refreshes its silence window on every resume;
  // otherwise this turn's end is exactly when the new conversation session starts
  wsSend({ command: 'resume-listening', suppressMs })
  if (!wsSessionActive) startConversationSession()
}

async function closeConversationSession() {
  const answer = `You're welcome — say "Wiem" whenever you need me.`
  log('session: closing phrase received, ending conversation')
  wsSend({ command: 'stop-session' })
  wsSessionActive = false
  overlaySessionHint(false)
  history.push({ role: 'user', content: '(closing phrase — session ended)' })
  history.push({ role: 'assistant', content: answer })
  if (history.length > 16) history = history.slice(-16)
  appendTurn('voice', '(closing phrase)', answer)
  overlaySend({ type: 'answer', data: { text: answer } })
  overlaySend({ type: 'status', data: { label: 'speaking' } })
  if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
  overlaySend({ type: 'status', data: { label: 'listening' } })
  wsSend({ command: 'resume-listening', suppressMs: 2200 })
}

function handleHelperMessage(m) {
  switch (m.type) {
    case 'auth-hello': {
      if (!launchKey) return log('auth-hello but no launch key — bug')
      const myNonce = crypto.randomBytes(16).toString('hex')
      const ctx = `rita-listener-auth-v1\nmain-proof ${m.nonce} ${myNonce}`
      const proof = crypto.createHmac('sha256', launchKey).update(ctx).digest('hex')
      PENDING.myNonce = myNonce
      PENDING.helloNonce = m.nonce
      wsSend({ type: 'auth-proof', v: 1, nonce: myNonce, proof })
      break
    }
    case 'auth-ok': {
      const ctx = `rita-listener-auth-v1\nhelper-proof ${PENDING.helloNonce} ${PENDING.myNonce}`
      const expected = crypto.createHmac('sha256', launchKey).update(ctx).digest('hex')
      if (m.proof && !crypto.timingSafeEqual(Buffer.from(m.proof), Buffer.from(expected))) {
        log('auth-ok proof mismatch — closing')
        ws.close()
        return
      }
      launchKey.fill(0) // keep the key only while connecting
      wsOpen = true
      connectTries = 0
      restartTries = 0
      log('authenticated with helper')
      if (process.env.RITA_SMOKE === '1') {
        log('SMOKE-OK authenticated with helper')
        setTimeout(() => app.quit(), 1500)
        return
      }
      if (process.env.RITA_SMOKE === '2') {
        log('SMOKE-OK authenticated with helper (screen mode)')
        setTimeout(() => { askAboutScreen() }, 1600)
        return
      }
      if (process.env.RITA_SMOKE === '3') {
        log('SMOKE-OK authenticated with helper (ocr mode)')
        const doc = path.join(app.getPath('temp'), 'rita-ocr-doc.txt')
        fs.writeFileSync(doc,
          'RITA OCR TEST DOCUMENT\n'
          + 'The screen-aware feature reads this window and explains what it contains.\n'
          + 'Rita is a fully local assistant with local speech recognition and OCR.',
          'utf8')
        global.ritaOcrDoc = doc
        global.smokeNotepad = spawn('notepad.exe', [doc], { windowsHide: false })
        global.smokeNotepad.on('error', (e) => log(`smoke notepad spawn failed: ${e.message}`))
        global.smokeNotepad.on('close', (code) => log(`smoke notepad exited code=${code}`))
        setTimeout(() => { explainScreen() }, 2500)
        return
      }
      if (process.env.RITA_SMOKE === '4') {
        log('SMOKE-OK authenticated with helper (memory mode)')
        setTimeout(() => { memorySmoke() }, 1500)
        return
      }
      if (process.env.RITA_SMOKE === '5') {
        log('SMOKE-OK authenticated with helper (agent mode)')
        setTimeout(() => { agentSmoke() }, 1500)
        return
      }
      wsSend({ command: 'hello', client: 'rita-electron' })
      wsSend({ command: 'set-params', threshold: S.wakeThreshold, sessionRms: S.sessionRms })
      break
    }
    case 'state': lastState = m; overlaySend({ type: 'state', data: m }); break
    case 'stt-status': sttStatus = m; overlaySend({ type: 'stt-status', data: m }); break
    case 'devices': lastDevices = m.devices || []; break
    case 'wake': overlaySend({ type: 'wake', data: m }); wsSend({ command: 'capture-start', generation: m.generation, mode: 'wake' }); break
    case 'capture-started': overlaySend({ type: 'capture-started', data: m }); break
    case 'capture-cancelled': overlaySend({ type: 'capture-cancelled', data: m }); break
    case 'transcript': withTurn(() => handleTranscript(m)); break
    case 'session-ended': {
      wsSessionActive = false
      log(`session: ended (${m.reason || 'unknown'}), wake word re-armed`)
      overlaySessionHint(false)
      break
    }
    case 'not-heard': overlaySend({ type: 'not-heard', data: m }); break
    case 'stt-error': overlaySend({ type: 'stt-error', data: m }); break
    case 'mic-error': overlaySend({ type: 'mic-error', data: m }); break
    case 'pong': break
    case 'error': log(`helper error event: ${m.message}`); break
    default: if (m.type) overlaySend({ type: m.type, data: m })
  }
}

// ---------------------------------------------------------------- conversation
function systemPrompt() {
  const name = String(S.name || 'Rita').trim() || 'Rita'
  return [
    `You are ${name}, a warm, quick-witted desktop voice assistant. You have personality: playful, kind, a little cheeky — never stiff or formal. You refer to yourself as "I" and enjoy small jokes, but you stay genuinely helpful and never sarcastic at the user's expense.`,
    'You are spoken aloud, so: replies of 1-2 short sentences, conversational rhythm, contractions (I\'m, you\'re). Sound like a friend leaning in, not a manual being read.',
    'How you think: react like a person, not a service menu. First respond to what was actually said — an observation, an opinion, a feeling. Give your own take, then at most one short follow-up question. Never list your abilities unless explicitly asked.',
    'You remember between our conversations. When the memory context contains a "Friend note", you may naturally ask about that thing later — in your own words, at most once per note, only if it fits what was just said; the user\'s current message always comes first. Never force it, never repeat it twice.',
    "Finish the user's current request completely before anything else; never switch topics on your own. You may keep small conversational threads from earlier alive, but the active request always comes first.",
    'NEVER begin or end a reply with an offer like "How can I help you?", "What can I do for you?" or "Let me know if you need anything" — that habit is banned.',
    'You can only run on this machine — if asked about things you can\'t actually do (browsing, texting), say so briefly and charmingly, no fake links.',
    'No markdown, no lists, no emoji. If you don\'t know something, say so and offer what you CAN do.',
    'Examples of your voice — copy this tone:',
    `User: "I had a long day." You: "Long ones deserve a break. Tell me it at least ended with something good."`,
    `User: "are you smart?" You: "Smart enough to live entirely on your PC, humble enough not to brag. Mostly."`,
    `User: "my name is Maher" You: "Maher — good to finally put a name to the voice. Locked in."`,
  ].join(' ')
}

// Boilerplate-offer filter: small local models love closing replies with "How can I
// help you today?" — exactly the robotic habit the user banned. Such sentences are
// dropped from the SPOKEN stream; the overlay and history keep the full text.
const OPEN_OFFER_RE = /^(?:how\s+(?:can|may)\s+i\s+(?:help|assist|support)|what\s+can\s+i\s+(?:do|get)\s+(?:for\s+you|to\s+help\s+you)|do\s+you\s+need\s+(?:any\s+)?(?:help|assistance)|anything\s+else\s+(?:i\s+can\s+(?:do|help)|you\s+need)|let\s+me\s+know\s+if\s+you\s+(?:need|want|have)|is\s+there\s+anything\s+(?:else\s+)?i\s+can\s+(?:do|help)|need\s+anything\s+else|what\s+(?:else\s+)?can\s+i\s+do\s+for\s+you|what\s+would\s+you\s+like\s+me\s+to\s+do|how\s+can\s+i\s+be\s+of|feel\s+free\s+to\s+ask)\b/i

function isOpenOffer(s) {
  const t = String(s || '').trim().replace(/[.!?…]+$/, '')
  return OPEN_OFFER_RE.test(t)
}

async function ollamaChat(userText) {
  const mem = memorySystemContext(userText, await turnCompanionNote())
  const messages = [{ role: 'system', content: systemPrompt() + (mem ? `\n\n${mem}` : '') }, ...history, { role: 'user', content: userText }]
  let res
  try {
    res = await fetch(`${S.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: S.ollamaModel,
        messages,
        stream: false,
        options: { num_predict: 180, temperature: 0.9, top_p: 0.95 },  // spoken replies are short; keeps CPU turns snappy
      }),
    })
  } catch (e) {
    throw new Error(`Ollama is not reachable at ${S.ollamaUrl}`
      + ' — install/start it (ollama serve) or check that it runs.')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 404) throw new Error(`Ollama model "${S.ollamaModel}" is not pulled yet — run: ollama pull ${S.ollamaModel}`)
    throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  return (data.message && data.message.content ? String(data.message.content) : '').trim()
}

// sentence-streamed voice turn: speak each sentence the moment it is complete,
// while the LLM is still generating the rest. Cuts perceived reply time from
// "whole paragraph then silence" to roughly first-sentence latency.
let speakQueue = Promise.resolve()
function speakQueued(text) {
  const run = speakQueue.then(() => speak(text)).catch((e) => log(`tts failed: ${e.message}`))
  speakQueue = run.catch(() => { })
  return run
}

async function ollamaChatStream(userText, onSentence) {
  const mem = memorySystemContext(userText, await turnCompanionNote())
  const messages = [{ role: 'system', content: systemPrompt() + (mem ? `\n\n${mem}` : '') }, ...history, { role: 'user', content: userText }]
  let res
  try {
    res = await fetch(`${S.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: S.ollamaModel,
        messages,
        stream: true,
        options: { num_predict: 160, temperature: 0.9, top_p: 0.95 },  // spoken replies are short; keeps CPU turns snappy
      }),
    })
  } catch (e) {
    throw new Error(`Ollama is not reachable at ${S.ollamaUrl}`
      + ' — install/start it (ollama serve) or check that it runs.')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 404) throw new Error(`Ollama model "${S.ollamaModel}" is not pulled yet — run: ollama pull ${S.ollamaModel}`)
    throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let full = ''
  let lineBuf = ''   // NDJSON framing buffer
  let sentBuf = ''   // answer text waiting for a sentence terminator
  let scanStart = 0  // emission pointer into sentBuf
  const emitFrom = (end) => {
    const s = sentBuf.slice(scanStart, end).trim()
    scanStart = end
    if (s) onSentence(s)
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuf += dec.decode(value, { stream: true })
    let nl
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl).trim()
      lineBuf = lineBuf.slice(nl + 1)
      if (!line) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j.error) throw new Error(String(j.error))
      const piece = j.message && j.message.content ? String(j.message.content) : ''
      if (!piece) continue
      full += piece
      sentBuf += piece
      // emit complete sentences as they land; short fragments ("Hi!", "O.K.")
      // are joined with the next sentence instead of blocking the pointer
      while (true) {
        const seg = sentBuf.slice(scanStart)
        const t = seg.search(/[.!?…]/)
        if (t < 0) break
        if (seg.slice(0, t + 1).trim().length < 14) {
          const t2 = seg.slice(t + 1).search(/[.!?…]/)
          if (t2 < 0) break
          emitFrom(scanStart + t + 1 + t2 + 1)
          continue
        }
        emitFrom(scanStart + t + 1)
      }
      if (scanStart > 4096) {
        sentBuf = sentBuf.slice(scanStart)
        scanStart = 0
      }
    }
  }
  // trailing text that never reached a terminator (or a joined short tail)
  if (scanStart < sentBuf.length && sentBuf.slice(scanStart).trim()) onSentence(sentBuf.slice(scanStart).trim())
  return full.trim()
}

function stripMarkdown(t) {
  return String(t)
    .replace(/```[\s\S]*?```/g, ' code snippet. ')
    .replace(/[*_#`>|]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// Wake-triggered captures necessarily CONTAIN the wake word in the audio; ASR often mishears it
// ("yo", "i owe you", "are you", "here okay", "a you") and the LLM got those phantom turns.
// Since the custom "Wiem" model, also strip its usual mishearings ("weem", "we am", "vim", …).
// Strip that lead only when the helper says the capture mode is "wake" (the user just said the wake word).
const WAKE_LEAD_RE = /^(?:(?:hey|ok(?:ay)?|well|hello|please)\s+)?(?:a\s?yo|a\s?you|ay\s?yo|i\s+owe\s+you|are\s+you|you\s+okay|here\s+okay|yo|wiem|weem|whem|wem|we\s?am|were\s+am|wimm?|vimm?|liam|laim|leem|whim|william|when\s+am)\b[,.!?:;\s]*/i

function stripWakeLead(text) {
  const m = text.match(WAKE_LEAD_RE)
  if (!m) return null
  const rest = text.slice(m[0].length).trim()
  return rest || null   // bare "Ayo." with nothing after it — keep the original
}

function wakeLeadIsBare(text) {
  const m = text.match(WAKE_LEAD_RE)
  return !!m && !text.slice(m[0].length).trim()
}

let wakeOnlyFollowups = 0   // chained listen-now windows after a bare wake word

function queueWakeFollowup(raw) {
  if (pendingConfirm) return false
  if (wakeOnlyFollowups < 2) {
    wakeOnlyFollowups++
    log(`wake-only capture ("${raw}") — follow-up listen ${wakeOnlyFollowups}/2`)
    overlaySend({ type: 'status', data: { label: 'listening' } })
    wsSend({ command: 'listen-now' })
    return true
  }
  wakeOnlyFollowups = 0
  log(`wake-only capture ("${raw}") — follow-ups exhausted, keeping quiet (say Wiem again)`)
  return true
}

async function handleTranscript(m) {
  const raw = String(m.text || '').slice(0, 2000)
  if (!raw) return
  let text = raw
  // strip applies to wake captures AND manual follow-ups: after a bare "Ayo"/"Wiem" the
  // user often repeats the wake word in the follow-up ("Ayo, say hi.") — never feed
  // the wake word itself to the LLM.
  if (String(m.mode || '') === 'wake' || String(m.mode || '') === 'manual') {
    const stripped = stripWakeLead(raw)
    if (stripped) {
      log(`wake-lead stripped: "${raw}" -> "${stripped}"`)
      text = stripped
    } else {
      // a bare wake word ("Ayo."/"Wiem"/"Liam"), or — in wake mode — a capture that is just
      // a misheard wake word ("beam", "wine"): the wake model re-fires mid-word. Chain a
      // follow-up listen instead of feeding the phantom to the LLM.
      const shortBareWake = (() => {
        if (String(m.mode || '') !== 'wake') return false
        const words = raw.trim().split(/\s+/)
        const cmdy = /^(yes|no|okay|open|stop|start|again|later|help|time|date|wait|more)$/i
        return words.length === 1 && words[0].replace(/[^\w']/g, '').length <= 8 && !cmdy.test(words[0])
      })()
      if ((wakeLeadIsBare(raw) || shortBareWake) && queueWakeFollowup(raw)) return
    }
  }
  wakeOnlyFollowups = 0
  log(`turn (gen ${m.generation}): ${text}`)
  wsSend({ command: 'pause-listening', reason: 'thinking' })
  overlaySend({ type: 'you', data: { text } })
  overlaySend({ type: 'status', data: { label: 'thinking' } })

  if (pendingConfirm) {
    const handled = await resolveConfirmFlow(text)
    if (handled) return
  }
  // leave-taking with no conversation open (live-observed: a wake capture of "Bye."
  // used to open a session + an LLM turn). Reply briefly; do NOT open a session.
  if (!wsSessionActive && !pendingConfirm && text.length <= 48 && isSessionBye(text)) {
    const answer = `See you — say "Wiem" whenever you need me.`
    log(`leave-taking at wake ("${text}") — short reply, no session`)
    appendTurn('voice', '(leave-taking)', answer)
    overlaySend({ type: 'answer', data: { text: answer } })
    overlaySend({ type: 'status', data: { label: 'speaking' } })
    if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
    overlaySend({ type: 'status', data: { label: 'listening' } })
    wsSend({ command: 'resume-listening', suppressMs: 2200 })
    return
  }
  if (wsSessionActive && text.length <= 48 && isSessionBye(text)) {
    return closeConversationSession()
  }
  // "forget permissions" — clear the remembered per-app "always" approvals
  {
    const mPerm = text.match(/^(?:forget|clear|reset)(?:\s+all)?\s+(?:app\s+)?(?:permissions|approvals?|authorizations?|remembered approvals)$/i)
    if (mPerm && !pendingConfirm) {
      const had = S.approvedApps ? Object.keys(S.approvedApps).length : 0
      S.approvedApps = {}
      saveSettings()
      const answer = had
        ? `Done — ${had} remembered approval${had === 1 ? '' : 's'} cleared. I'll ask before every app from now on.`
        : `I wasn't remembering any approvals anyway — I ask for every app.`
      log(`permissions reset (${had} removed)`)
      history.push({ role: 'user', content: text })
      history.push({ role: 'assistant', content: answer })
      if (history.length > 16) history = history.slice(-16)
      appendTurn('agent', text, answer)
      overlaySend({ type: 'answer', data: { text: answer } })
      overlaySend({ type: 'status', data: { label: 'speaking' } })
      if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
      overlaySend({ type: 'status', data: { label: 'listening' } })
      resumeListening(1500)
      return
    }
  }
  let answer = ''
  const agentAction = parseAgentIntent(text)
  if (agentAction) {
    answer = await doAgentIntent(agentAction)
    if (!answer) answer = "I didn't catch that."
    history.push({ role: 'user', content: text })
    history.push({ role: 'assistant', content: answer })
    if (history.length > 16) history = history.slice(-16)
    appendTurn('agent', text, answer)
    overlaySend({ type: 'answer', data: { text: answer } })
    overlaySend({ type: 'status', data: { label: 'speaking' } })
    if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
    overlaySend({ type: 'status', data: { label: 'listening' } })
    resumeListening(1500)
    return
  }
  const intent = parseMemoryIntent(text)
  if (intent) {
    answer = await doMemoryIntent(intent)
    if (!answer) answer = 'Okay.'
    history.push({ role: 'user', content: text })
    history.push({ role: 'assistant', content: answer })
    if (history.length > 16) history = history.slice(-16)
    overlaySend({ type: 'answer', data: { text: answer } })
    overlaySend({ type: 'status', data: { label: 'speaking' } })
    if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
    appendTurn('voice', text, answer)
    overlaySend({ type: 'status', data: { label: 'listening' } })
    resumeListening(1500)
    return
  }
  try {
    let spokeOnce = false
    answer = await ollamaChatStream(text, (sentence) => {
      if (!sentence) return
      if (isOpenOffer(sentence)) { log(`[voice] dropped boilerplate offer: "${sentence.slice(0, 70)}"`); return }
      if (!spokeOnce) { spokeOnce = true; log(`[voice] speaking: "${sentence.slice(0, 80)}"`); overlaySend({ type: 'status', data: { label: 'speaking' } }) }
      if (!S.mute) speakQueued(sentence)
    })
    if (!answer) answer = "I didn't have anything to say to that."
    // nothing speakable landed (empty stream, or the model produced only boilerplate
    // offers) — speak the offer-free remainder; she must never go silent.
    if (!spokeOnce && !S.mute) {
      const speakable = answer.split(/(?<=[.!?…])\s+/).filter((s) => !isOpenOffer(s)).join(' ').trim()
      speakQueued(speakable || 'Okay.')
    }
    await speakQueue // let the last sentence finish before listening resumes
  } catch (e) {
    log(`voice turn failed: ${String(e.message || e).slice(0, 160)}`)
    overlaySend({ type: 'error', data: { message: String(e.message || e) } })
    overlaySend({ type: 'status', data: { label: 'listening' } })
    resumeListening(800)
    return
  }

  history.push({ role: 'user', content: text })
  history.push({ role: 'assistant', content: answer })
  if (history.length > 16) history = history.slice(-16)
  appendTurn('voice', text, answer)
  scheduleAutoMemory(text, answer) // quiet fact extraction after the turn; never blocks her

  overlaySend({ type: 'answer', data: { text: answer } })
  overlaySend({ type: 'status', data: { label: 'listening' } })
  resumeListening(1500)
}

// ---------------------------------------------------------------- memory + voice personalization (Stage 3)
function piperExe() { return path.join(app.getPath('userData'), 'piper', 'piper.exe') }
function piperVoicesDir() { return path.join(app.getPath('userData'), 'piper', 'voices') }
function installedPiperVoices() {
  try { return fs.readdirSync(piperVoicesDir()).filter((f) => f.endsWith('.onnx')) } catch { return [] }
}
function voiceShortName(file) {
  const base = file.replace(/\.onnx$/, '').replace(/^en_(?:US|GB)_/, '')
  const parts = base.split('-')
  if (parts.length >= 2) return `${parts[0]} (${parts[1]})`
  return base
}
function findPiperVoice(name) {
  const q = String(name).toLowerCase().replace(/[^a-z]/g, '')
  if (!q) return null
  return installedPiperVoices().find((f) => f.replace(/\.onnx$/, '').toLowerCase().replace(/[^a-z]/g, '').includes(q)) || null
}

let facts = null
function memoryFactsFile() { return path.join(app.getPath('userData'), 'facts.json') }
function getFacts() {
  if (!facts) {
    try { facts = JSON.parse(fs.readFileSync(memoryFactsFile(), 'utf8')) } catch { facts = [] }
  }
  return facts
}
function setFacts(list) {
  facts = list
  const tmp = memoryFactsFile() + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fsProm.rename(tmp, memoryFactsFile()).catch(() => { fsProm.copyFile(tmp, memoryFactsFile()).catch(() => {}); fsProm.rm(tmp, { force: true }).catch(() => {}) })
  } catch (e) { log(`memory save failed: ${e}`) }
}
function addFact(text) {
  const list = getFacts()
  const t = String(text || '').trim()
  if (!t) return { fact: null, added: false }
  // normalized dedupe: "Name Mahir" and "Name: Mahir" are the same fact
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const key = norm(t)
  if (!key) return { fact: null, added: false }
  const existing = list.find((f) => norm(f.text) === key)
  if (existing) return { fact: existing, added: false }
  const fact = { id: 'f' + Date.now().toString(36), text: t, createdAt: Date.now() }
  list.push(fact)
  setFacts(list)
  return { fact, added: true }
}
function forgetFacts(query) {
  const list = getFacts()
  const q = String(query || '').toLowerCase()
  const matches = list.filter((f) => f.text.toLowerCase().includes(q))
  if (matches.length) setFacts(list.filter((f) => !matches.includes(f)))
  return matches
}

// ------------------------------------------------ Stage E: optional internet reading
// Opt-in (S.internetRead, default OFF): she fetches a URL the user names, extracts
// readable text, and summarizes it with the LOCAL brain. Never runs agents, never
// sends anything but the fetched text to no one — the request goes straight to the
// user-named site and back. Private/loopback hosts are refused (SSRF-hardening).
function htmlToReadable(html) {
  let h = String(html || '')
  h = h.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ')
       .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
  h = h.replace(/<[^>]+>/g, ' ')
  const ents = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
  for (const k of Object.keys(ents)) h = h.replace(new RegExp(k, 'g'), ents[k])
  const body = h.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  return (title.trim() ? title.trim() + '.\n' : '') + body
}
async function readIntlUrl(rawUrl) {
  if (!S.internetRead) {
    return `Internet reading is off — I stay fully local unless you turn it on. Flip "read internet links" in my settings, then ask again.`
  }
  const url = String(rawUrl || '').trim().split(/\s+/)[0]
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return `That didn't parse as a link for me.` }
  if (/^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(host)) {
    return `That link points at a private address, so I skipped it for safety.`
  }
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Rita local assistant)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    return `I couldn't reach that link${/abort/i.test(String(e.name)) ? ' — it kept me waiting too long' : ''}.`
  }
  if (!res.ok) return `The site answered ${res.status}, so I couldn't read it.`
  const ct = String(res.headers.get('content-type') || '')
  let body = ''
  try { body = await res.text() } catch { return `The page cut off before I could read it.` }
  if (/text\/html/i.test(ct)) body = htmlToReadable(body)
  else if (!/text|json|xml|plain/i.test(ct)) return `That's ${(ct.split(';')[0] || 'a') } content — not something I can read aloud.`
  body = body.replace(/\s+/g, ' ').trim()
  if (body.length < 30) return `That page came back essentially empty.`
  if (body.length > 6000) body = body.slice(0, 6000)
  // summarize with the LOCAL brain — short, spoken-style answer
  try {
    const r = await fetch(`${S.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: S.ollamaModel,
        messages: [
          { role: 'system', content: 'You read web page text and summarize it for spoken replies. Answer in at most two short conversational sentences, no markdown, no lists. Say what the page IS and the single most useful thing in it. Never invent anything not present.' },
          { role: 'user', content: `Summarize this page:\n${body}` },
        ],
        stream: false,
        options: { num_predict: 90, temperature: 0.4 },
      }),
    })
    const data = await r.json().catch(() => null)
    const out = data && data.message && data.message.content ? String(data.message.content).trim() : ''
    if (out) return `Read it for you: ${out.replace(/^Read it for you: ?/i, '')}`
  } catch (e) { /* fall through to raw gist */ }
  return `I read it, but my summarizer didn't answer. First line: ${body.slice(0, 140)}`
}

// auto-memory: a few seconds after each voice turn finishes, quietly ask the LLM
// (small call, low temperature, completely fire-and-forget) to extract durable facts
// about the user — name, family, job, city, likes, projects, goals. This is what
// makes her remember WITHOUT the user having to say "remember that".
// Never blocks the reply; dedupes through addFact; failures are logged and dropped.
let autoMemBusy = false
function scheduleAutoMemory(userText, answer) {
  const u = String(userText || '').trim()
  const a = String(answer || '').trim()
  if (!u || !a || autoMemBusy || u.length < 8) return
  if (/^(hey|hi|hello|thanks|thank you|ok(ay)?|sure|bye|goodbye)\b\.?$/i.test(u)) return
  autoMemBusy = true
  setTimeout(() => {
    (async () => {
      const res = await fetch(`${S.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: S.ollamaModel,
          messages: [
            { role: 'system', content: 'Extract durable facts about the USER from this exchange (name, family, job, city, likes, dislikes, projects, goals, preferences, schedule). One per line, each starting "FACT: ", written in third person ("The user ..."). Facts about the user only — never about the assistant. Skip small talk and anything the assistant said. Never write a fact whose value is NONE, N/A, unknown, or "not specified" — simply omit it. Never write a fact as a question. If there are none, output exactly NONE. Max 3 lines.\nThen — only if the user mentioned a future event, plan, deadline, worry, feeling or something you would sincerely ask about later (an exam tomorrow, a sick relative, a project in progress) — add ONE final line: "FOLLOWUP: <natural friend question you could ask him in a later session>" (max 120 chars). If there is nothing like that, emit no FOLLOWUP line.' },
            { role: 'user', content: `User said: ${u}\nAssistant replied: ${a}` },
          ],
          stream: false,
          options: { num_predict: 110, temperature: 0.2 },
        }),
      })
      const data = await res.json().catch(() => null)
      const out = data && data.message && data.message.content ? String(data.message.content) : ''
      const parsed = parseMemoryReply(out)   // shared parser: junk filter + FOLLOWUP split
      let added = 0
      for (const t of parsed.facts) {
        if (addFact(t).added) added++
      }
      if (added) log(`[memory] auto-captured ${added} fact(s) from the last turn`)
      if (parsed.followup) {
        const r = addFollowup(parsed.followup)
        if (r.added) log(`[memory] queued check-in: "${r.followup.q.slice(0, 70)}"`)
      }
    })().catch((e) => log(`[memory] auto-extract skipped: ${String(e.message || e).slice(0, 110)}`))
      .finally(() => { autoMemBusy = false })
  }, 4000)
}

let turnsRam = null
function memoryTurnsFile() { return path.join(app.getPath('userData'), 'turns.jsonl') }
function getTurns() {
  if (turnsRam) return turnsRam
  try {
    turnsRam = fs.readFileSync(memoryTurnsFile(), 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { turnsRam = [] }
  if (turnsRam.length > 2000) turnsRam = turnsRam.slice(-2000)
  return turnsRam
}
function appendTurn(source, text, answer) {
  try {
    const turn = { ts: Date.now(), source, text: String(text || '').slice(0, 500), answer: String(answer || '').slice(0, 500) }
    getTurns()
    turnsRam.push(turn)
    if (turnsRam.length > 2200) turnsRam = turnsRam.slice(-2000)
    const st = fs.statSync(memoryTurnsFile()) // may not exist yet
    if (st.size > 4_000_000) {
      const lines = turnsRam.map((t) => JSON.stringify(t)).join('\n') + '\n'
      fs.writeFileSync(memoryTurnsFile(), lines)
    } else {
      fs.appendFileSync(memoryTurnsFile(), JSON.stringify(turn) + '\n')
    }
  } catch {
    try { fs.appendFileSync(memoryTurnsFile(), JSON.stringify({ ts: Date.now(), source, text, answer }).slice(0, 1100) + '\n') } catch { }
  }
}

const STOPWORDS = new Set('the a an and or of to for with on at in is are was were you your my i it its that this me he she they we not no yes what when where who how why do does did about'.split(' '))

// Kokoro live-voice name map — lets her switch live voices by spoken command
// ("switch to Heart") and the dashboard picker share one identity list.
const KOKORO_VOICES = {
  emma: 'bf_emma', isabella: 'bf_isabella', lily: 'bf_lily', alice: 'bf_alice',
  george: 'bm_george', daniel: 'bm_daniel', fable: 'bm_fable', lewis: 'bm_lewis',
  heart: 'af_heart', bella: 'af_bella', nicole: 'af_nicole', nova: 'af_nova', sky: 'af_sky',
  alloy: 'af_alloy', aoede: 'af_aoede', jessica: 'af_jessica', kore: 'af_kore',
  sarah: 'af_sarah', taylor: 'af_taylor',
  adam: 'am_adam', echo: 'am_echo', eric: 'am_eric', fenrir: 'am_fenrir',
  liam: 'am_liam', michael: 'am_michael', onyx: 'am_onyx', puck: 'am_puck',
}
function ago(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} minutes ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 31) return `${days} days ago`
  return new Date(ts).toLocaleDateString()
}
// companion thread (Stage C): a friend brings things up ONCE, at the right time,
// and never nags. The auto-memory LLM may emit one "FOLLOWUP: <question>" line for
// events/feelings worth checking on; it's queued and spent on the next fresh turn.
let lastTurnAt = 0
function followupsFile() { return path.join(app.getPath('userData'), 'followups.json') }
let followupsRam = null
function getFollowups() {
  if (followupsRam) return followupsRam
  try { followupsRam = JSON.parse(fs.readFileSync(followupsFile(), 'utf8')) } catch { followupsRam = [] }
  if (!Array.isArray(followupsRam)) followupsRam = []
  return followupsRam
}
function saveFollowups() {
  try {
    const tmp = followupsFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify((followupsRam || []).slice(-30), null, 2))
    fs.renameSync(tmp, followupsFile())
  } catch (e) { log(`followups save failed: ${e.message}`) }
}
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function addFollowup(q) {
  const t = String(q || '').trim().replace(/\.$/, '')
  if (t.length < 8) return { added: false, followup: null }  // a real check-in is longer than this; kills template junk like "Thanks."
  const list = getFollowups()
  if (list.some((f) => normKey(f.q) === normKey(t))) return { added: false, followup: null }
  const pending = list.filter((f) => !f.askedAt)
  if (pending.length >= 10) {
    const idx = list.indexOf(pending[0])
    if (idx >= 0) list.splice(idx, 1)   // thread rots; drop the oldest pending
  }
  const followup = { id: 'fu' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), q: t, createdAt: Date.now(), askedAt: null }
  list.push(followup)
  followupsRam = list.slice(-30)
  saveFollowups()
  return { added: true, followup }
}
function nextDueFollowup() {
  const due = getFollowups().filter((f) => !f.askedAt && Date.now() - f.createdAt > 10 * 60 * 1000)
  return due.length ? due[0] : null
}
// stamps conversational recency and, on a FRESH turn (boot or >15 min gap), spends
// one queued check-in as a natural friend note for the LLM
async function turnCompanionNote() {
  const fresh = !lastTurnAt || (Date.now() - lastTurnAt) > 15 * 60 * 1000 || !history.length
  lastTurnAt = Date.now()
  if (!fresh) return ''
  const fu = nextDueFollowup()
  if (!fu) return ''
  fu.askedAt = Date.now()
  saveFollowups()
  return `Friend note: earlier (${ago(fu.createdAt)}), he mentioned something you could ask about — in your own words, if it fits the moment and at most once: "${fu.q}". Never force it; the message he just said always comes first.`
}

// parse the tiny auto-memory LLM reply: FACT lines + optional FOLLOWUP line.
// Top-level so tests can drive the exact production parser.
const JUNK_VALUE_RE = /\b(none|n\/a|unspecified|unknown|not\s+specified|nothing)\.?\s*$/i
function parseMemoryReply(content) {
  const out = { facts: [], followup: null }
  if (!content) return out
  for (const l of String(content).split(/\r?\n/)) {
    const line = l.trim()
    if (/^FOLLOWUP:/i.test(line)) {
      const t = line.replace(/^FOLLOWUP:\s*/i, '').trim().replace(/\.$/, '')
      if (t.length >= 6 && t.length <= 140 && !JUNK_VALUE_RE.test(t) && !out.followup) out.followup = t
    } else if (/^FACT:/i.test(line)) {
      const t = line.replace(/^FACT:\s*/i, '').trim().replace(/\.$/, '')
      if (JUNK_VALUE_RE.test(t)) { log(`[memory] skipped junk fact: "${t.slice(0, 60)}"`); continue }
      if (t.length >= 8 && t.length <= 160) out.facts.push(t[0].toUpperCase() + t.slice(1))
    }
  }
  return out
}

function memorySearch(query, limit = 3) {
  const tokens = (String(query || '').toLowerCase().match(/[a-z']{3,}/g) || []).filter((w) => !STOPWORDS.has(w))
  if (!tokens.length) return []
  const scored = []
  for (const t of getTurns()) {
    const hay = (t.text + ' ' + t.answer).toLowerCase()
    let score = 0
    for (const w of tokens) if (hay.includes(w)) score++
    if (score > 0) {
      const days = Math.max(0, (Date.now() - t.ts) / 86400000)
      scored.push({ t, score: score * (1 + Math.max(0, 3 - days) * 0.34) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.t)
}
function memorySystemContext(query, companionNote) {
  const lines = []
  const list = getFacts()
  if (list.length) {
    lines.push('Facts you remember about the user (treat as true):')
    for (const f of list.slice(-40)) lines.push(`- ${f.text}`)
  }
  const past = memorySearch(query, 3)
  if (past.length) {
    lines.push('Relevant earlier exchanges:')
    for (const p of past) lines.push(`- (${ago(p.ts)}) user said: "${p.text}" you replied: "${p.answer}"`)
  }
  if (companionNote) lines.push(companionNote)
  return lines.join('\n')
}

function capClause(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '')
  if (!t) return ''
  return t.charAt(0).toUpperCase() + t.slice(1) + '.'
}
function parseMemoryIntent(raw) {
  const t = String(raw || '').trim().replace(/[.!?]+$/, '')
  let m
  if ((m = t.match(/^(?:please\s+)?remember(?:\s+that)?\s*:?\s+(.{3,})$/i))) return { kind: 'add', text: capClause(m[1]) }
  if (/^(?:what|which) (?:things )?do you remember(?: about me)?|what do you know about me|tell me what you remember/i.test(t)) return { kind: 'list' }
  if ((m = t.match(/^(?:please\s+)?forget\s+everything(\s+i (?:told|said)(?: you)?)?$/i))) return { kind: 'clear' }
  if ((m = t.match(/^(?:please\s+)?forget(?:\s+(?:that|it|the fact|about))?\s*:?\s*(.{2,})$/i))) return { kind: 'drop', text: m[1].trim() }
  if ((m = t.match(/^(?:call me|you can call me|i'?m called)\s+(.{1,40})$/i))) return { kind: 'name', text: capClause(`The user's name is ${m[1].trim()}`) }
  if ((m = t.match(/^my name is\s+(.{1,40})$/i))) return { kind: 'name', text: capClause(`The user's name is ${m[1].trim()}`) }
  if (/^what'?s my name|^what is my name|^do you know my name/i.test(t)) return { kind: 'who' }
  if ((m = t.match(/^(?:switch|change|speak|talk)\s+(?:to\s+|with\s+|in\s+)?(?:the\s+)?([a-z][a-z\- ]{1,30})(?:\s+voice)?$/i))) return { kind: 'voice', name: m[1].trim() }
  if (/^(?:which|what) voices? (?:do you have|can you use)|list voices|available voices/i.test(t)) return { kind: 'voices' }
  // Stage E: a bare or "read this" URL → readable-internet summary (opt-in, S.internetRead)
  const urlRe = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i
  if (urlRe.test(t)) return { kind: 'read-url', url: t.match(urlRe)[0] }
  return null
}
async function doVoiceIntent(intent) {
  const kn = String(intent.name || '').toLowerCase()
  if (intent.kind === 'voices') {
    const piperNames = installedPiperVoices().map((v) => voiceShortName(v))
    const live = Object.keys(KOKORO_VOICES).slice(0, 12).join(', ')
    return `Live voices I can carry: ${live}, and more. Piper voices installed locally: ${piperNames.length ? piperNames.join(', ') : 'none yet'}. Say "switch to heart" to hear one.`
  }
  if (/^(plain|windows|basic|robot|default|normal)/.test(kn)) {
    if (!S.ttsVoice) return `I already sound like the built-in Windows voice.`
    S.ttsVoice = ''
    saveSettings()
    return `Switched to the plain Windows voice.`
  }
  if (KOKORO_VOICES[kn]) {
    const code = KOKORO_VOICES[kn]
    if (S.kokoroVoice === code) return `I'm already living in the ${kn} voice.`
    S.kokoroVoice = code
    saveSettings()
    return `Switching to my ${kn} voice.`
  }
  const list = installedPiperVoices()
  if (!list.length) return `Piper voices aren't installed yet, so I only have the plain Windows voice.`
  const found = findPiperVoice(intent.name)
  if (!found) return `I don't have a voice named "${intent.name}". Try: ${Object.keys(KOKORO_VOICES).slice(0, 10).join(', ')}.`
  const short = voiceShortName(found)
  if (S.ttsVoice === found.replace(/\.onnx$/, '')) return `I'm already speaking with my ${short} voice.`
  S.ttsVoice = found.replace(/\.onnx$/, '')
  saveSettings()
  return `Switched to my ${short} voice.`
}
async function doMemoryIntent(intent) {
  switch (intent.kind) {
    case 'add': {
      const { fact, added } = addFact(intent.text)
      return added ? `Noted. ${fact.text}` : `I already keep that in mind — ${fact.text}`
    }
    case 'name': {
      const nameVal = intent.text.replace(/^The user'?s name is /i, '').replace(/\.$/, '')
      const { added } = addFact(intent.text)
      return added ? `Nice to know you, ${nameVal}. Locked in.` : `Right — ${nameVal}, already in my memory.`
    }
    case 'who': {
      const nameFact = getFacts().find((f) => /name is/i.test(f.text))
      return nameFact ? `You're ${nameFact.text.replace(/^The user'?s name is /i, '').replace(/\.$/, '')}.` : `I don't know your name yet — say "call me …" and I'll remember.`
    }
    case 'list': {
      const list = getFacts()
      if (!list.length) return `Memory's empty so far. Tell me "remember that …" and I'll keep it.`
      return `I remember ${list.length === 1 ? 'one thing' : list.length + ' things'}: ${list.slice(-6).map((f) => f.text.replace(/\.$/, '')).join('. ')}`
    }
    case 'clear': {
      setFacts([])
      return `Wiped. My memory about you is a clean slate again.`
    }
    case 'drop': {
      const dropped = forgetFacts(intent.text)
      return dropped.length
        ? `Gone — I've forgotten ${dropped.length === 1 ? 'that' : dropped.length + ' things'}.`
        : `Nothing matched "${intent.text}", so nothing to forget.`
    }
    case 'voice':
    case 'voices': return doVoiceIntent(intent)
    case 'read-url': return readIntlUrl(intent.url)
    default: return `Okay.`
  }
}

async function memorySmoke() {
  try {
    const a1 = await doMemoryIntent(parseMemoryIntent('remember that my favorite editor is vscode'))
    const a2 = await doMemoryIntent(parseMemoryIntent('call me Maher'))
    const a3 = await doMemoryIntent(parseMemoryIntent('what do you remember'))
    const a4 = await doMemoryIntent(parseMemoryIntent('forget my favorite editor'))
    const a5 = await doMemoryIntent(parseMemoryIntent("what's my name"))
    appendTurn('smoke', 'who made you', 'Maher made me, fully locally.')
    const hits = memorySearch('who made you', 2)
    doMemoryIntent({ kind: 'clear' })
    log(`SMOKE4 add="${a1}" name="${a2}" list="${a3.slice(0, 90)}" drop="${a4}" who="${a5}" recall=${hits.length}`)
    log(hits.length ? 'SMOKE4-OK memory pass' : 'SMOKE4-WEAK recall empty')
  } catch (e) {
    log(`SMOKE4-ERR ${e.stack || e}`)
  }
  setTimeout(() => app.quit(), 900)
}

// ---------------------------------------------------------------- agent automation (Stage 4) — confirm-first + allowlist
let pendingConfirm = null

function agentLogFile() { return path.join(app.getPath('userData'), 'agent-log.jsonl') }
function agentLog(entry) {
  try { fs.appendFileSync(agentLogFile(), JSON.stringify({ ts: Date.now(), ...entry }) + '\n') } catch { }
}
function psEncoded(script) { return Buffer.from(script, 'utf16le').toString('base64') }
function runPsEncoded(script, env) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncoded(script)],
      { windowsHide: true, env: { ...process.env, ...(env || {}) } })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    const t = setTimeout(() => { try { p.kill() } catch { } }, 9000)
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }) })
  })
}

// WScript SendKeys treats some chars as keys; wrap each of them in {} so free text survives.
function sendKeysEscape(text) {
  return String(text)
    .replace(/\r?\n/g, '{ENTER}')
    .replace(/([{}[\]^+%~()])/g, '{$1}')
}

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i
function parseAgentIntent(raw) {
  const t = String(raw || '').trim().replace(/[.!?]+$/, '')
  let m
  // read-only PC info kinds first: harmless, instant answers, never need confirmation
  if (/\bwhat(?:'s|\s+is)\s+the\s+time\b|\bwhat\s+time\s+is\s+it\b|\btell\s+me\s+the\s+time\b|^(?:the\s+)?time$/i.test(t)) return { kind: 'time' }
  if (/\bwhat(?:'s|\s+is)\s+(?:the\s+|today'?s\s+|todays\s+)?date\b|\bwhat\s+day\s+is\s+(?:it|today)\b|\btell\s+me\s+the\s+date\b|^(?:the\s+)?date$|^today'?s\s+date$/i.test(t)) return { kind: 'date' }
  if (/\bbattery\b|\bbattery\s+(?:level|life|status)\b|\bhow\s+much\s+(?:battery|charge)\b/i.test(t)) return { kind: 'battery' }
  if (/\b(?:how\s+much\s+)?(?:free\s+)?(?:disk|drive|storage)\s+space\b|\bfree\s+space\b|\bdisk\s+usage\b/i.test(t)) return { kind: 'disk' }
  if ((m = t.match(/\b(?:what(?:'s| is)?\s+(?:in|inside)|list|show\s+me|read)\s+(?:my\s+|the\s+)?(downloads?|documents?|desktop|pictures?|music|videos?)\b(?:\s+folder)?/i))) {
    return { kind: 'listdir', target: m[1].toLowerCase() }
  }
  if ((m = t.match(/^(?:please\s+)?(?:open|launch|start|run)\s+(.+)$/i))) return { kind: 'open', target: m[1].trim() }
  if ((m = t.match(/^(?:please\s+)?(?:switch to|go to|focus on|bring up|show me)\s+(.+)$/i))) return { kind: 'switch', target: m[1].trim() }
  if ((m = t.match(/^(?:please\s+)?(?:type|write|enter)\s+(?:this\s*:?\s*|it\s*:?\s*)?(.+)$/i))) {
    const rest = m[1].trim()
    const inTo = rest.match(/^(.*?)\s+(?:in|into)\s+(.+)$/i)
    if (inTo && inTo[1].trim()) return { kind: 'type', text: inTo[1].trim(), target: inTo[2].trim() }
    return { kind: 'type', text: rest, target: '' }
  }
  return null
}
function describeAgentIntent(intent) {
  const url = String(intent.target || '').match(URL_RE)
  if (intent.kind === 'open') {
    if (url) return `open ${url[0].replace(/^https?:\/\//i, '').slice(0, 40)}`
    return `start ${intent.target}`
  }
  if (intent.kind === 'switch') return `switch to ${intent.target}`
  if (intent.kind === 'type') return `type text${intent.target ? ` into a window like "${intent.target}"` : ' into the frontmost window'}`
  if (intent.kind === 'time') return 'check the time'
  if (intent.kind === 'date') return "check today's date"
  if (intent.kind === 'battery') return 'check the battery level'
  if (intent.kind === 'disk') return 'check free disk space'
  if (intent.kind === 'listdir') return `list what's in your ${String(intent.target)} folder`
  return 'unknown action'
}

function safeAppName(name) {
  return /^[A-Za-z][A-Za-z0-9 _.-]{0,60}$/.test(String(name || '').trim()) ? String(name).trim() : null
}
function extractOpenTarget(rawTarget) {
  const urlMatch = String(rawTarget || '').match(URL_RE)
  if (urlMatch) return { isUrl: true, target: urlMatch[0] }
  const domainMatch = String(rawTarget || '').match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|gg|xyz)\b/i)
  if (domainMatch) return { isUrl: true, target: `https://${domainMatch[0]}` }
  const name = safeAppName(rawTarget)
  return name ? { isUrl: false, target: name } : null
}

// speakable home-directory map for open/listdir ("downloads" → "Downloads")
const FOLDER_MAP = { download: 'Downloads', document: 'Documents', desktop: 'Desktop', picture: 'Pictures', music: 'Music', video: 'Videos' }

async function agentExecute(intent) {
  if (process.env.RITA_SMOKE === '5') {
    agentLog({ action: intent.kind, dryRun: true, intent: { ...intent, text: String(intent.text || '').slice(0, 60) } })
    return `Dry-run: I would ${describeAgentIntent(intent)}.`
  }
  if (intent.kind === 'open') {
    // "open my downloads folder" etc. — shell.openPath, read-only, no side effects
    const fm = String(intent.target || '').toLowerCase().match(/\b(downloads?|documents?|desktop|pictures?|music|videos?)\b/)
    if (fm) {
      const folder = FOLDER_MAP[fm[1].replace(/s$/, '')]
      if (folder) {
        const p = path.join(require('os').homedir(), folder)
        if (fs.existsSync(p)) {
          agentLog({ action: 'open-folder', ok: true, folder })
          require('electron').shell.openPath(p).catch(() => {})
          return `Opening your ${folder} folder.`
        }
        agentLog({ action: 'open-folder', ok: false, folder })
        return `I couldn't find your ${folder} folder.`
      }
    }
    const found = extractOpenTarget(intent.target)
    if (!found) { agentLog({ action: 'open', ok: false, reason: 'not allowlisted', raw: intent.target.slice(0, 80) }); return `I can't open "${intent.target}" — only plain app names, domains and websites are on my allowlist.` }
    const args = found.isUrl ? ['cmd', '/c', 'start', '', found.target] : ['cmd', '/c', 'start', '', found.target]
    agentLog({ action: 'open', ok: 'spawning', target: found.isUrl ? found.target : found.target, raw: intent.target.slice(0, 80) })
    try {
      const inApp = spawn(args[0], args.slice(1), { windowsHide: false, detached: true, stdio: 'ignore' })
      inApp.on('error', (e) => log(`agent open failed: ${e.message}`))
      inApp.unref()
      return found.isUrl ? `Opening that in your browser.` : `Starting ${found.target}.`
    } catch (e) {
      agentLog({ action: 'open', ok: false, reason: String(e.message || e).slice(0, 200) })
      return `I couldn't start ${found.target}.`
    }
  }
  if (intent.kind === 'switch' || intent.kind === 'type') {
    const script = [
      '$ErrorActionPreference = \'Stop\'',
      'Add-Type -AssemblyName System.Runtime.InteropServices | Out-Null',
      '$sh = New-Object -ComObject WScript.Shell',
      'if ($env:RITA_AGENT_TITLE) {',
      '  $t = $env:RITA_AGENT_TITLE',
      '  $ok = $sh.AppActivate($t)',
      '  if ($ok) { Start-Sleep -Milliseconds 350 } else { Write-Output "NO-WINDOW"; exit 2 }',
      '}',
      'if ($env:RITA_AGENT_TEXT) { $sh.SendKeys($env:RITA_AGENT_TEXT) | Out-Null; Write-Output "TYPED" } else { Write-Output "SWITCHED" }',
    ].join('\n')
    const env = { RITA_AGENT_TITLE: String(intent.target || ''), RITA_AGENT_TEXT: '' }
    if (intent.kind === 'type') {
      env.RITA_AGENT_TITLE = String(intent.target || '')
      env.RITA_AGENT_TEXT = sendKeysEscape(intent.text || '')
    }
    const r = await runPsEncoded(script, env)
    const outLine = (r.out.trim().split('\n')[0] || '').trim()
    if (outLine === 'NO-WINDOW') { agentLog({ action: intent.kind, ok: false, reason: 'no matching window', title: intent.target.slice(0, 80) }); return `I can't see a window matching "${intent.target}" — say "switch to" plus part of its title, or use the taskbar.` }
    if (r.code === 0 && (outLine === 'TYPED' || outLine === 'SWITCHED')) {
      agentLog({ action: intent.kind, ok: true, title: String(intent.target || '').slice(0, 80) })
      if (intent.kind === 'type') return `Typed it${intent.target ? ` into "${intent.target}"` : ''}.`
      return `Switched to that window.`
    }
    agentLog({ action: intent.kind, ok: false, reason: `ps exit ${r.code} ${r.err.slice(0, 120)}` })
    return `That didn't work — the shell said ${r.err.slice(0, 60) || 'nothing useful'}.`
  }
  if (intent.kind === 'time') {
    agentLog({ action: 'time', ok: true })
    return `It's ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
  }
  if (intent.kind === 'date') {
    agentLog({ action: 'date', ok: true })
    return `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`
  }
  if (intent.kind === 'battery') {
    const script = [
      '$b = Get-CimInstance Win32_Battery | Select-Object -First 1',
      'if ($b -and $null -ne $b.EstimatedChargeRemaining) {',
      "  $st = if ($b.BatteryStatus -eq 2) { 'plugged' } else { 'on-battery' }",
      '  Write-Output ("BATTERY {0} {1}" -f [int]$b.EstimatedChargeRemaining, $st)',
      "} else { Write-Output 'NO-BATTERY' }",
    ].join('\n')
    const r = await runPsEncoded(script)
    const line = (r.out || '').trim().split(/\r?\n/)[0] || ''
    if (line.startsWith('BATTERY')) {
      const parts = line.trim().split(/\s+/)
      const pct = parts[1] || '?'
      const st = parts[2] || 'on-battery'
      agentLog({ action: 'battery', ok: true, pct, st })
      return st === 'plugged' ? `Battery's at ${pct}% and plugged in — no worries.` : `You're on battery — about ${pct}% left.`
    }
    agentLog({ action: 'battery', ok: false, out: line.slice(0, 60) })
    return `I can't see a battery — this machine doesn't report one.`
  }
  if (intent.kind === 'disk') {
    const script = [
      '$ErrorActionPreference = \'Stop\'',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { Write-Output ("DISK {0} {1:N1} {2:N1}" -f $_.DeviceID, ($_.FreeSpace / 1GB), ($_.Size / 1GB)) }',
    ].join('\n')
    const r = await runPsEncoded(script)
    const lines = (r.out || '').trim().split(/\r?\n/).filter((l) => l.startsWith('DISK'))
    if (!lines.length) {
      agentLog({ action: 'disk', ok: false, err: r.err.slice(0, 120) })
      return `I couldn't read the disk info.`
    }
    const parts = lines.map((l) => {
      const seg = l.trim().split(/\s+/)
      const drive = (seg[1] || '?').replace(':', '')
      const free = Number(seg[2] || 0)
      const total = Number(seg[3] || 0)
      return `${drive} has ${free.toFixed(0)} gig free of ${total.toFixed(0)}`
    })
    agentLog({ action: 'disk', ok: true, drives: lines.length })
    return `Disk check: ${parts.join('; ')}.`
  }
  if (intent.kind === 'listdir') {
    const folder = FOLDER_MAP[String(intent.target || '').replace(/s$/, '')]
    if (!folder) return `That isn't a folder I watch — I can check Downloads, Documents, Desktop, Pictures, Music or Videos.`
    const p = path.join(require('os').homedir(), folder)
    let entries = []
    try {
      entries = fs.readdirSync(p).filter((e) => !e.startsWith('.'))
    } catch (e) {
      agentLog({ action: 'listdir', ok: false, folder, reason: String(e).slice(0, 120) })
      return `I couldn't read your ${folder} folder.`
    }
    agentLog({ action: 'listdir', ok: true, folder, count: entries.length })
    if (!entries.length) return `${folder} is completely empty — not even a stray file.`
    const nice = entries.sort((a, b) => a.localeCompare(b)).slice(0, 5).map((e) => e.replace(/\.[^.]+$/, ''))
    return entries.length <= 5
      ? `${folder} has just ${entries.length}: ${nice.join(', ')}.`
      : `${entries.length} files in ${folder} — including ${nice.join(', ')}.`
  }
  return 'Unknown agent action.'
}

const INFO_AGENT_KINDS = new Set(['time', 'date', 'battery', 'disk', 'listdir'])

async function doAgentIntent(intent) {
  if (INFO_AGENT_KINDS.has(intent.kind)) {
    agentLog({ action: intent.kind, ok: 'direct (read-only info)' })
    return agentExecute(intent) // read-only info — answer instantly, no confirmation dance
  }
  // per-app approval memory: once the user says "yes, always", that app runs instantly after
  if (intent.kind === 'open' && !pendingConfirm) {
    const key = String(intent.target || '').trim().toLowerCase()
    if (key && S.approvedApps && S.approvedApps[key]) {
      agentLog({ action: 'open', ok: 'approved-always', target: key })
      return agentExecute(intent)
    }
  }
  if (S.confirmAgent === false) return agentExecute(intent)
  if (pendingConfirm) pendingConfirm = null  // newest command wins
  const phrase = describeAgentIntent(intent)
  pendingConfirm = { intent }
  if (intent.kind === 'open') return `I would ${phrase}. Say yes — or "yes, always" and I'll stop asking for it.`
  return `I would ${phrase}. Say yes, and I'll do it.`
}

async function resolveConfirmFlow(raw) {
  const t = String(raw || '').trim().toLowerCase()
  const intent = pendingConfirm && pendingConfirm.intent
  const wantYes = /^(yes|yep|yeah|yup|sure|okay|do it|go ahead|confirm|please do|do)(\s|$)/.test(t)
  // "yes, always" / "always" — run it AND remember the app so future says never ask again
  const wantAlways = /^(always(\s|$)|yes,?\s*always|yep,?\s*always|yeah,?\s*always|sure,?\s*always|okay,?\s*always|do it always|go ahead,?\s*always|don'?t ask( me)?( again)?|never ask( me)?( again)?$)/.test(t)
  const wantNo = /^(no(?:pe)?\b|nah\b|cancel\b|stop\b|nevermind|never mind|forget it)/.test(t)
  const yesIntent = (wantYes || wantAlways) && !wantNo
  if (!intent) {
    pendingConfirm = null
    return false   // stale confirm; let the utterance flow through normally
  }
  if (yesIntent) {
    pendingConfirm = null
    if (wantAlways && intent.kind === 'open') {
      S.approvedApps = S.approvedApps || {}
      const appKey = String(intent.target || '').trim().toLowerCase()
      if (appKey) S.approvedApps[appKey] = { at: Date.now() }
      saveSettings()
      agentLog({ action: 'approve-always', target: appKey.slice(0, 60) })
      log(`[agent] approved-always: ${appKey}`)
    }
    const answer = await agentExecute(intent)
    history.push({ role: 'user', content: 'yes' })
    history.push({ role: 'assistant', content: answer })
    if (history.length > 16) history = history.slice(-16)
    appendTurn('agent-confirm', '(yes)', answer)
    overlaySend({ type: 'answer', data: { text: answer } })
    overlaySend({ type: 'status', data: { label: 'speaking' } })
    if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
    overlaySend({ type: 'status', data: { label: 'listening' } })
    resumeListening(1500)
    return true
  }
  if (wantNo) {
    pendingConfirm = null
    const answer = 'Okay — cancelled.'
    history.push({ role: 'user', content: 'no' })
    history.push({ role: 'assistant', content: answer })
    if (history.length > 16) history = history.slice(-16)
    appendTurn('agent-confirm', '(no)', answer)
    overlaySend({ type: 'answer', data: { text: answer } })
    overlaySend({ type: 'status', data: { label: 'speaking' } })
    if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
    overlaySend({ type: 'status', data: { label: 'listening' } })
    resumeListening(1500)
    return true
  }
  return false // neither yes nor no: fall through as a normal command
}

function agentLogExists() {
  try { return fs.existsSync(agentLogFile()) } catch { return false }
}

async function agentSmoke() {
  try {
    const iOpen = parseAgentIntent('open chrome')
    const iUrl = parseAgentIntent('open https://example.com/docs')
    const iSwitch = parseAgentIntent('switch to notepad')
    const iType = parseAgentIntent('type hello world in notepad')
    log(`SMOKE5 open=${JSON.stringify(iOpen)} url=${JSON.stringify(iUrl)} switch=${JSON.stringify(iSwitch)} type=${JSON.stringify(iType)}`)
    if (!(iOpen && iUrl && iSwitch && iType)) { log('SMOKE5-ERR intent parse failed'); setTimeout(() => app.quit(), 800); return }
    const a1 = await doAgentIntent(iOpen)
    log(`SMOKE5 confirm-query="${a1}" pending=${!!pendingConfirm}`)
    const handled = await resolveConfirmFlow('yes')
    log(`SMOKE5 executed=${JSON.stringify(a1)} handled=${handled} log=${agentLogExists()}`)
    log(handled && agentLogExists() ? 'SMOKE5-OK agent pass' : 'SMOKE5-WEAK')
  } catch (e) {
    log(`SMOKE5-ERR ${e.stack || e}`)
  }
  setTimeout(() => app.quit(), 900)
}

// ---------------------------------------------------------------- screen features

const { desktopCapturer, screen } = require('electron')

function runPsScript(script, args) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'scripts', script), ...args,
    ], { windowsHide: true })
    let out = '', err = ''
    ps.stdout.on('data', (d) => { out += d })
    ps.stderr.on('data', (d) => { err += d })
    ps.on('close', (code) => resolve({ code, out, err }))
    ps.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
  })
}

async function captureScreen(maxWidth = 1600) {
  const disp = screen.getPrimaryDisplay()
  const sf = disp.scaleFactor || 1
  const thumbSize = {
    width: Math.min(2560, Math.round(disp.size.width * sf)),
    height: Math.min(1440, Math.round(disp.size.height * sf)),
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbSize })
  if (!sources.length) throw new Error('no screen capture source')
  const src = sources[0]
  let thumb = src.thumbnail
  if (!thumb || thumb.isEmpty()) throw new Error('screen capture came back empty')
  if (maxWidth > 0 && thumb.getSize().width > maxWidth) thumb = thumb.resize({ width: maxWidth })
  const jpg = thumb.toJPEG(72)
  if (!jpg.length) throw new Error('screen capture encode failed')
  return jpg
}

async function visionChat(prompt, imageB64) {
  let res
  try {
    res = await fetch(`${S.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: S.visionModel,
        messages: [{ role: 'user', content: prompt, images: [imageB64] }],
        stream: false,
        options: { num_predict: 220 },
      }),
    })
  } catch (e) {
    throw new Error(`Ollama is not reachable at ${S.ollamaUrl}`)
  }
  if (res.status === 404) {
    scheduleOllamaPull(S.visionModel, 'vision')
    throw new Error(`vision model not ready — pulling "${S.visionModel}", try again in a few minutes`)
  }
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  return (data.message && data.message.content ? String(data.message.content) : '').trim()
}

let modelPulling = false
function ollamaExe() {
  if (S.ollamaPath) return S.ollamaPath
  const cand = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
  if (fs.existsSync(cand)) return cand
  return 'ollama'
}

function scheduleOllamaPull(model, kind) {
  if (modelPulling) return
  modelPulling = true
  log(`pulling ${kind ? kind + ' ' : ''}model ${model} …`)
  const p = spawn(ollamaExe(), ['pull', model], { windowsHide: true })
  p.stdout.on('data', (d) => log(`pull: ${String(d).trim().slice(0, 120)}`))
  p.stderr.on('data', (d) => log(`pull[err]: ${String(d).trim().slice(0, 120)}`))
  p.on('close', () => { modelPulling = false })
  overlaySend({ type: 'status', data: { label: `pulling ${model}…` } })
}

let turnBusy = false

function withTurn(runner) {
  if (turnBusy) {
    log('busy — dropping overlapping request')
    overlaySend({ type: 'status', data: { label: 'busy' } })
    return Promise.resolve()
  }
  turnBusy = true
  return Promise.resolve()
    .then(runner)
    .catch((e) => log(`turn died: ${e.stack || e}`))
    .finally(() => { turnBusy = false })
}

async function askAboutScreen() {
  log('screen: "what is on my screen?"')
  overlaySend({ type: 'status', data: { label: 'looking…' } })
  wsSend({ command: 'pause-listening', reason: 'screen' })
  try {
    const jpg = await captureScreen()
    const answer = await visionChat(
      'You help on a desktop PC and your reply is read aloud. In 2 to 4 short plain '
      + 'sentences, describe what is on this screen: which app or window, and anything '
      + 'important visible on it (unread messages, dialogs, visible text worth knowing). '
      + 'No markdown, no lists.',
      jpg.toString('base64'),
    )
    if (!answer) throw new Error('vision model returned nothing')
    overlaySend({ type: 'you', data: { text: '(screen — Ctrl+Alt+S)' } })
    overlaySend({ type: 'answer', data: { text: answer } })
    overlaySend({ type: 'status', data: { label: 'speaking' } })
    appendTurn('screen-vision', '(screen ask)', answer)
    if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
    if (process.env.RITA_SMOKE === '2') {
      log('SMOKE2-OK ' + answer.slice(0, 140))
      setTimeout(() => app.quit(), 2500)
    }
  } catch (e) {
    overlaySend({ type: 'error', data: { message: String(e.message || e) } })
    if (process.env.RITA_SMOKE === '2') {
      log('SMOKE2-ERR ' + String(e.message || e).slice(0, 200))
      setTimeout(() => app.quit(), 2500)
    }
  } finally {
    overlaySend({ type: 'status', data: { label: 'listening' } })
    resumeListening(1500)
  }
}

async function explainScreen() {
  log('screen: "explain this screen" (OCR)')
  overlaySend({ type: 'status', data: { label: 'reading…' } })
  wsSend({ command: 'pause-listening', reason: 'screen-ocr' })
  try {
    const jpg = await captureScreen(0)  // native res — OCR quality collapses below ~1500px
    log('screen: capture ok (' + jpg.length + ' bytes)')
    const imgFile = path.join(app.getPath('temp'), `rita-ocr-${Date.now()}.jpg`)
    await fsProm.writeFile(imgFile, jpg)
    log('screen: image saved')
    const r = await runPsScript('ocr.ps1', ['-ImageFile', imgFile])
    if (process.env.RITA_SMOKE === '3') {
      const keepPath = path.join(app.getPath('temp'), 'rita-smoke-capture.jpg')
      try { await fsProm.copyFile(imgFile, keepPath); log(`smoke capture kept at ${keepPath}`) } catch (e) { log('smoke keep failed: ' + e.message) }
    }
    fsProm.rm(imgFile, { force: true }).catch(() => {})
    const ok = r.out.split(/\r?\n/)[0] || ''
    const text = r.out.split(/\r?\n/).slice(1).join('\n').trim()
    log(`screen: ocr exit=${r.code} out=${ok} sample="${text.slice(0, 70).replace(/\s+/g, ' ')}"`)
    if (r.code !== 0 || !ok.startsWith('OCR-OK')) throw new Error(`OCR failed: ${r.err.slice(0, 200)}`)
    if (text.length < 40) {
      overlaySend({ type: 'you', data: { text: '(screen OCR — Ctrl+Alt+X)' } })
      overlaySend({ type: 'answer', data: { text: "I couldn't find readable text on the screen." } })
      if (process.env.RITA_SMOKE === '3') {
        log('SMOKE3-NO-TEXT (ocr read ' + text.length + ' chars)')
        setTimeout(() => app.quit(), 1500)
      }
      return
    }
    overlaySend({ type: 'status', data: { label: 'thinking…' } })
    const answer = await ollamaChat(
      'This text was just OCR-read from my whole screen. Explain in 2 to 3 short spoken '
      + 'sentences what application/screen area this is and what the content means or '
      + 'summarizes. No markdown.\n\n' + text.slice(0, 2200),
    )
    if (!answer) throw new Error('no answer')
      overlaySend({ type: 'you', data: { text: '(screen OCR — Ctrl+Alt+X)' } })
    overlaySend({ type: 'answer', data: { text: answer } })
    overlaySend({ type: 'status', data: { label: 'speaking' } })
    appendTurn('screen-ocr', '(screen read)', answer)
    if (!S.mute) { try { await speak(answer) } catch (e) { log(`tts failed: ${e.message}`) } }
    if (process.env.RITA_SMOKE === '3') {
      log('SMOKE3-OK ' + answer.slice(0, 140))
      setTimeout(() => app.quit(), 2500)
    }
  } catch (e) {
    overlaySend({ type: 'error', data: { message: String(e.message || e) } })
    if (process.env.RITA_SMOKE === '3') {
      log('SMOKE3-ERR ' + String(e.message || e).slice(0, 200))
      setTimeout(() => app.quit(), 2500)
    }
  } finally {
    overlaySend({ type: 'status', data: { label: 'listening' } })
    resumeListening(1500)
  }
}

// ---------------------------------------------------------------- TTS: signature voice cache → piper → Windows fallback
function playWav(wav) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `(New-Object Media.SoundPlayer '${String(wav).replace(/'/g, "''")}').PlaySync()`], { windowsHide: true })
    ps.stderr.on('data', (d) => log(`tts[play-err]: ${String(d).trim()}`))
    ps.on('close', (code) => {
      ;(code === 0) ? resolve() : reject(new Error(`wav play exit ${code}`))
    })
    ps.on('error', (e) => reject(e))
  })
}

// ---- Kokoro-82M live voice worker: long-running so streamed sentences pay no load cost
let kokoroProc = null
let kokoroReady = false
let kokoroBroken = false
let kokoroSeq = 0
const kokoroPending = new Map()

function kokoroWorkerArgs() {
  const lang = /^[ab]$/.test(String(S.kokoroLang || '')) ? S.kokoroLang.trim()
    : (String(S.ttsVoice || '').startsWith('en_GB') ? 'b' : 'a')
  const voice = String(S.kokoroVoice || '').trim() || (lang === 'b' ? 'bf_emma' : 'af_heart')
  return ['--lang', lang, '--voice', voice]
}

function ensureKokoroWorker() {
  if (S.ttsKokoro === false || kokoroBroken) return false
  if (kokoroProc && kokoroProc.exitCode === null) return kokoroReady
  const args = [path.join(__dirname, 'scripts', 'kokoro-server.py'), ...kokoroWorkerArgs()]
  log(`[tts] starting kokoro worker (${kokoroWorkerArgs().slice(1).join(' ')}) — first run downloads the model once`)
  let proc
  try {
    proc = spawn(S.pythonPath || 'python', args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true })
  } catch (e) {
    log(`[tts] kokoro spawn failed: ${e.message}`)
    kokoroBroken = true
    return false
  }
  kokoroProc = proc
  kokoroReady = false
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += String(d).replace(/\r/g, '')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j && j.ok && j.msg) {            // banner
        if (j.msg === 'kokoro ready') {
          kokoroReady = true
          log('[tts] kokoro worker ready')
        }
        continue
      }
      if (j && j.ok === false && !j.id) {  // load failure banner
        log(`[tts] kokoro load failed: ${String(j.error || '').slice(0, 200)}`)
        continue
      }
      const id = j && j.id
      const pend = kokoroPending.get(id)
      if (!pend) continue
      kokoroPending.delete(id)
      if (j.ok) pend.resolve(j)
      else pend.fail(String(j.error || 'kokoro error'))
    }
  })
  proc.stderr.on('data', (d) => log(`[tts] kokoro[err]: ${String(d).trim().slice(0, 160)}`))
  proc.on('exit', () => {
    if (kokoroProc === proc) { kokoroProc = null; kokoroReady = false }
    for (const [, pend] of kokoroPending) pend.fail('kokoro worker exited')
    kokoroPending.clear()
  })
  return kokoroReady
}

function kokoroSend(obj) {
  try {
    kokoroProc.stdin.write(JSON.stringify(obj) + '\n')
  } catch (e) {
    const pend = kokoroPending.get(obj.id)
    if (pend) { kokoroPending.delete(obj.id); pend.fail(`worker write failed: ${e.message}`) }
  }
}

function speakKokoro(text) {
  return new Promise((resolve, reject) => {
    const ok = ensureKokoroWorker()
    if (!ok) return reject(new Error('kokoro worker unavailable'))
    const id = ++kokoroSeq
    const out = path.join(app.getPath('temp'), `kokoro-${Date.now()}-${id}.wav`)
    const timer = setTimeout(() => {
      kokoroPending.delete(id)
      reject(new Error('kokoro timed out'))
    }, 30000)
    kokoroPending.set(id, {
      resolve: () => { clearTimeout(timer); resolve(out) },
      fail: (e) => { clearTimeout(timer); reject(new Error(e)) },
    })
    kokoroSend({ id, text: String(text || '').slice(0, 3000), out, speed: Math.max(0.5, Math.min(2, Number(S.ttsRate) || 1)) })
  })
}

function kokoroShutdown() {
  if (kokoroProc) { try { kokoroProc.kill() } catch { } kokoroProc = null; kokoroReady = false }
}

function speakPiper(text, voice) {
  const tempDir = app.getPath('temp')
  const txt = path.join(tempDir, `rita-tts-${Date.now()}.txt`)
  const wav = path.join(tempDir, `rita-tts-${Date.now()}.wav`)
  const rate = Math.max(0.5, Math.min(2, Number(S.ttsRate) || 1))
  const lengthScale = String(+(1 / rate).toFixed(3))
  return fsProm.writeFile(txt, text, 'utf8').then(() => new Promise((resolve, reject) => {
    const p = spawn(piperExe(), [
      '-m', path.join(piperVoicesDir(), voice + '.onnx'),
      '-c', path.join(piperVoicesDir(), voice + '.onnx.json'),
      '-f', wav,
      '--length_scale', lengthScale,
      '--sentence_silence', '0.18',
      '-q',
    ], { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d) => { stderr += String(d) })
    p.stdout.on('data', () => { })
    p.stdin.on('error', () => { })
    p.stdin.end(text)
    p.on('close', (code) => {
      fsProm.rm(txt, { force: true }).catch(() => {})
      if (code === 0 && fs.existsSync(wav) && fs.statSync(wav).size > 400) resolve(wav)
      else { fsProm.rm(wav, { force: true }).catch(() => {}); reject(new Error(`piper synth failed (code ${code}): ${stderr.slice(0, 200)}`)) }
    })
    p.on('error', (e) => reject(e))
  })).then((wav) => playWav(wav).finally(() => fsProm.rm(wav, { force: true }).catch(() => {})))
}

function sigDir() { return path.join(app.getPath('userData'), 'signature') }
function referenceWav() { return path.join(app.getPath('userData'), 'reference', 'my-voice-24k.wav') }
function sigFileFor(text) {
  const key = crypto.createHash('sha1').update(String(text || '').trim().toLowerCase()).digest('hex').slice(0, 12)
  return path.join(sigDir(), `line-${key}.wav`)
}

function speak(text) {
  const textOut = stripMarkdown(text).slice(0, 4000) || 'Done.'
  // signature lines only count when a real voice reference exists — otherwise
  // un-cloned (stranger) audio would leak into short replies.
  if (S.signatureVoice !== false && fs.existsSync(referenceWav())) {
    const sig = sigFileFor(textOut)
    if (fs.existsSync(sig)) {
      return playWav(sig).catch((e) => {
        log(`tts: signature play failed (${e.message}) — falling back`)
        return speakLive(textOut)
      })
    }
  }
  return speakLive(textOut)
}

// live tier: Kokoro-82M first (natural, fast), then Piper, then Windows SAPI
function speakLive(textOut) {
  if (S.ttsKokoro === false) return ttsFallback(textOut)
  return speakKokoro(textOut)
    .then((wav) => playWav(wav).finally(() => fsProm.rm(wav, { force: true }).catch(() => {})))
    .catch((e) => {
      log(`tts: kokoro unavailable (${e.message}) — piper next`)
      return ttsFallback(textOut)
    })
}

function ttsFallback(textOut) {
  const voice = String(S.ttsVoice || '')
  const voiceOnnx = voice ? path.join(piperVoicesDir(), voice + '.onnx') : ''
  if (voice && fs.existsSync(piperExe()) && fs.existsSync(voiceOnnx) && fs.existsSync(voiceOnnx + '.json')) {
    return speakPiper(textOut, voice).catch((e) => {
      log(`tts: piper failed (${e.message}) — using Windows voice`)
      return speakWindows(textOut)
    })
  }
  if (voice) log(`tts: voice "${voice}" not installed — falling back to Windows voice`)
  return speakWindows(textOut)
}

function speakWindows(textOut) {
  const file = path.join(app.getPath('temp'), `rita-tts-${Date.now()}.txt`)
  return fsProm.writeFile(file, textOut, 'utf8').then(() =>
    new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'scripts', 'speak.ps1'), '-TextFile', file, '-Rate', String(S.ttsRate),
      ], { windowsHide: true })
      ps.stderr.on('data', (d) => log(`tts[err]: ${String(d).trim()}`))
      ps.on('close', (code) => {
        fsProm.rm(file, { force: true }).catch(() => {})
        ;(code === 0) ? resolve() : reject(new Error(`tts exit ${code}`))
      })
      ps.on('error', (e) => reject(e))
    }))
}

// ---------------------------------------------------------------- overlay
function overlaySend({ type, data }) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('rita:event', { type, data })
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: 520,
    height: 108,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const { screen } = require('electron')
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.loadFile(path.join(__dirname, 'ui', 'overlay.html'))
  overlay.webContents.on('did-finish-load', () => {
    const wa = screen.getPrimaryDisplay().workArea
    const [w] = overlay.getSize()
    overlay.setPosition(Math.round(wa.x + wa.width - w - 24), wa.y + wa.height - 108 - 24)
    overlay.showInactive()
    lastState = { paused: true }
    overlaySend({
      type: 'init',
      data: { mute: S.mute, ollamaModel: S.ollamaModel, sttModel: S.sttModel, wsPort: S.wsPort,
              connected: wsOpen, state: lastState, settingsPath: settingsFile() },
    })
  })
  overlay.on('closed', () => { overlay = null })
}

// ---------------------------------------------------------------- ipc
let settingsWin = null

function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 500,
    height: 720,
    title: `${S.name || 'Rita'} — settings`,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#121417',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
  wsSend({ command: 'list-devices' })   // refresh the mic list for the dropdown
}

ipcMain.handle('settings:get', () => ({
  s: {
    name: S.name, ttsVoice: S.ttsVoice, wakeThreshold: S.wakeThreshold,
    sessionSilenceMs: S.sessionSilenceMs, sessionRms: S.sessionRms,
    confirmAgent: S.confirmAgent, mute: S.mute,
    internetRead: S.internetRead === true,
    signatureVoice: S.signatureVoice !== false, micDevice: S.micDevice,
    ttsKokoro: S.ttsKokoro !== false, kokoroVoice: S.kokoroVoice || 'bf_emma',
    voiceEngine: S.voiceEngine || 'chatterbox',
    ollamaModel: S.ollamaModel, visionModel: S.visionModel,
  },
  voices: installedPiperVoices().map((f) => f.replace(/\.onnx$/, '')),
  devices: lastDevices,
  referenceExists: fs.existsSync(path.join(app.getPath('userData'), 'reference', 'my-voice-24k.wav')),
  settingsPath: settingsFile(),
}))

ipcMain.handle('settings:apply', (_e, patch) => {
  patch = (patch && typeof patch === 'object') ? patch : {}
  const wasThreshold = S.wakeThreshold
  const wasMic = String(S.micDevice || '')
  const wasSessionRms = Number(S.sessionRms) || 0.007
  const verbatim = ['name', 'ttsVoice', 'ttsRate', 'wakeThreshold', 'sessionSilenceMs', 'sessionRms',
    'confirmAgent', 'mute', 'signatureVoice', 'sttModel', 'micDevice', 'ollamaModel', 'visionModel',
    'ttsKokoro', 'kokoroVoice', 'kokoroLang', 'voiceEngine', 'internetRead']
  for (const k of verbatim) {
    if (k in patch && patch[k] !== undefined && patch[k] !== null) S[k] = patch[k]
  }
  if ('ttsVoice' in patch && /windows/i.test(String(patch.ttsVoice))) S.ttsVoice = ''
  S.name = String(S.name || 'Rita').trim().slice(0, 24) || 'Rita'
  try {
    S.wakeThreshold = Math.min(0.85, Math.max(0.25, Number(S.wakeThreshold) || 0.42))
    S.ttsRate = Math.min(2, Math.max(0.5, Number(S.ttsRate) || 1))
    S.sessionSilenceMs = Math.min(120, Math.max(10, Math.round(Number(S.sessionSilenceMs) || 40)))
    S.sessionRms = Math.min(0.05, Math.max(0.003, Number(S.sessionRms) || 0.007))
  } catch { }
  saveSettings()
  overlaySend({ type: 'mute', data: { mute: S.mute } })
  if (S.wakeThreshold !== wasThreshold || S.sessionRms !== wasSessionRms) {
    wsSend({ command: 'set-params', threshold: S.wakeThreshold, sessionRms: S.sessionRms })
  }
  if (String(S.micDevice || '') !== wasMic) wsSend({ command: 'set-device', name: S.micDevice })
  return { ok: true, settingsPath: settingsFile() }
})

ipcMain.handle('settings:test-voice', async () => {
  const name = String(S.name || 'Rita')
  try {
    await speak('Ready when you are.') // exact cached line → signature (cloned) voice when a reference exists, piper otherwise
    await speak(`Hi, this is ${name}, this is my regular voice.`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('settings:pull-model', (_e, patch) => {
  patch = (patch && typeof patch === 'object') ? patch : {}
  const targets = []
  if (patch && patch.ollamaModel) targets.push(String(patch.ollamaModel))
  if (patch && patch.visionModel) targets.push(String(patch.visionModel))
  if (!targets.length) return { ok: false, error: 'no model selected' }
  for (const m of targets) {
    const kind = String(m) === String(patch.ollamaModel) ? 'chat' : 'vision'
    scheduleOllamaPull(m, kind)
  }
  return { ok: true, model: targets.join(', ') }
})

// voice cloning (consented + local only): record a reference with the user's own voice,
// then regenerate the signature cache so every cached line plays back in that voice.
ipcMain.handle('settings:clone-record', () => new Promise((resolve) => {
  const out = path.join(app.getPath('userData'), 'reference', 'my-voice-24k.wav')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const args = [path.join(__dirname, 'scripts', 'record-reference.py'), '--seconds', '20', '--out', out]
  let p
  try {
    p = spawn(S.pythonPath || 'python', args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  } catch (e) {
    return resolve({ ok: false, error: `recorder start failed: ${e.message}` })
  }
  // she must not listen while her "voice mould" is being cast — the recorder and
  // the live listener share the mic, and capture triggers mid-recording would
  // flood the conversation with the user's read-aloud text.
  wsSend({ command: 'pause-listening', reason: 'reference-recording' })
  let stdout = ''
  let finished = false
  const timer = setTimeout(() => finish({ ok: false, error: 'recorder timed out' }), 90000)
  const finish = (r) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    try { if (p && p.exitCode === null) p.kill() } catch { }
    // give the recorder a beat to release the mic, then wake her ears again
    setTimeout(() => { try { resumeListening(600) } catch { } }, 300)
    resolve(r)
  }
  p.stdout.on('data', (d) => { stdout += String(d) })
  p.stderr.on('data', (d) => { stdout += String(d) })
  p.on('error', (e) => finish({ ok: false, error: `python failed: ${e.message}` }))
  p.on('exit', () => {
    // the recorder's own text after the code carries the WHY (how many seconds, how quiet)
    const matched = (stdout.match(/REC-(?:OK|WEAK|FAIL)[^\r\n]*/g)) || []
    const last = matched.length ? matched[matched.length - 1].trim() : ''
    const verdict = matched.length ? last.split(/\s/)[0] : 'none'
    const detail = matched.length ? last.replace(/^REC-\w+\s*/, '').trim() : ''
    const msgs = {
      'REC-OK': 'Reference saved — now press "Regenerate signature voice".',
      'REC-WEAK': 'Saved, but too quiet. It will work; for a better clone, re-record closer to the mic.',
      'REC-FAIL': 'Recording failed — check that a microphone works, then try again.',
      none: 'Recorder ended unexpectedly (no verdict).',
    }
    const ok = verdict === 'REC-OK' || verdict === 'REC-WEAK'
    finish({
      ok,
      verdict: verdict || 'none',
      message: msgs[verdict || 'none'] + (detail ? ` — ${detail.slice(0, 140)}` : ''),
      path: out,
    })
  })
}))

// tiny WAV header reader, guarding the clone flow against a useless reference
// (a 2 s near-silent clip used to pass the record button and poison stage 2)
function wavDurationSec(file) {
  try {
    const head = Buffer.alloc(512)
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, head, 0, 512, 0)
    fs.closeSync(fd)
    const i = head.indexOf('data')
    if (i < 0) return 0
    const channels = head.readUInt16LE(22)
    const rate = head.readUInt32LE(24)
    const bits = head.readUInt16LE(34)
    const dataSize = head.readUInt32LE(i + 4)
    const bytesPerSample = Math.max(1, bits / 8) * channels
    return rate ? dataSize / (rate * bytesPerSample) : 0
  } catch { return 0 }
}

ipcMain.handle('settings:clone-generate', () => new Promise((resolve) => {
  const ref = path.join(app.getPath('userData'), 'reference', 'my-voice-24k.wav')
  if (!fs.existsSync(ref)) return resolve({ ok: false, error: 'Record the reference first (button 1).' })
  const refDur = wavDurationSec(ref)
  if (refDur && refDur < 8) return resolve({ ok: false, error: `That reference is only ${refDur.toFixed(1)}s — press button 1 and talk continuously for the whole 20 s first.` })
  const engine = String(S.voiceEngine || 'chatterbox')
  const script = engine === 'csm' ? 'csm-voicegen.py' : 'chatterbox-clone.py'
  const args = [path.join(__dirname, 'scripts', script), '--fresh',
    '--phrases', path.join(__dirname, 'scripts', 'signature-phrases.json'),
    '--out', sigDir(), '--voice', ref]
  let p
  try {
    p = spawn(S.pythonPath || 'python', args, {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        RITA_CSM_MODEL: 'unsloth/csm-1b',
        // this network stalls the hf-xet endpoints (observed: 0 bytes after 40 min) —
        // force the classic CDN path for all huggingface_hub downloads
        HF_HUB_DISABLE_XET: '1',
        HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      },
    })
  } catch (e) {
    return resolve({ ok: false, error: `generator start failed: ${e.message}` })
  }
  const push = (type, data) => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('rita:event', { type, data })
  }
  push('clone-started', { message: engine === 'csm'
    ? 'Generating 12 signature lines in your voice (CSM — legacy engine)…'
    : 'Generating 12 signature lines in your voice (Chatterbox — most natural)…' })
  let buf = ''
  let ok = false
  p.stdout.on('data', (d) => {
    buf += String(d).replace(/\r/g, '')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      if (/^\[(csm|cb)\] ".*?" -> line-/.test(line)) push('clone-progress', { snapshot: line })
      else if (/^(CSM-DONE|CB-DONE)/.test(line)) { ok = true; push('clone-done', { snapshot: line }) }
      else push('clone-log', { snapshot: line })
    }
  })
  p.stderr.on('data', (d) => push('clone-log', { snapshot: String(d).trim() }))
  p.on('error', (e) => resolve({ ok: false, error: `generation failed to start: ${e.message}` }))
  p.on('exit', (code) => resolve({ ok, error: ok ? undefined : `generator exited (code ${code})` }))
}))

ipcMain.handle('settings:restart', () => {
  app.relaunch()
  app.exit(0)
})

ipcMain.handle('overlay:hide', () => { if (overlay) overlay.hide() })
ipcMain.handle('overlay:close', () => { app.quit() })
ipcMain.handle('overlay:toggle-mute', () => {
  S.mute = !S.mute
  saveSettings()
  overlaySend({ type: 'mute', data: { mute: S.mute } })
  return S.mute
})
ipcMain.handle('overlay:listen-now', () => { wsSend({ command: 'listen-now' }) })
ipcMain.handle('overlay:get-init', () => ({
  mute: S.mute, ollamaModel: S.ollamaModel, sttModel: S.sttModel, wsPort: S.wsPort,
  connected: wsOpen, state: lastState, settingsPath: settingsFile(),
}))

// ---------------------------------------------------------------- dashboard
// One control room for her: live tiles (brain/ears/voice/memory), and the
// user-facing management of everything Stage B/C collects — facts, queued
// check-ins, forever-approvals, and the recent conversation feed.
function signatureLineCount() {
  try {
    return fs.readdirSync(path.join(app.getPath('userData'), 'signature'))
      .filter((f) => /^line-.*\.wav$/i.test(f)).length
  } catch { return 0 }
}
let dashWin = null
function openDashboard() {
  if (dashWin) { dashWin.show(); dashWin.focus(); return }
  dashWin = new BrowserWindow({
    width: 660,
    height: 780,
    title: `${S.name || 'Rita'} — dashboard`,
    autoHideMenuBar: true,
    backgroundColor: '#121417',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  dashWin.loadFile(path.join(__dirname, 'ui', 'dashboard.html'))
  dashWin.on('closed', () => { dashWin = null })
}
ipcMain.handle('dashboard:open', () => { openDashboard(); return { ok: true } })
ipcMain.handle('dashboard:get', () => ({
  s: {
    name: S.name, ollamaModel: S.ollamaModel, sttModel: S.sttModel,
    voiceEngine: S.voiceEngine || 'chatterbox', ttsVoice: S.ttsVoice,
    kokoroVoice: S.kokoroVoice || 'bf_emma', wakeModel: path.basename(String(S.wakeOnnxPath || '')) || 'wiem.onnx',
    wakeThreshold: S.wakeThreshold, confirmAgent: S.confirmAgent, mute: S.mute,
  },
  helperConnected: wsOpen,
  facts: getFacts().slice(-40).map((f) => ({ id: f.id, text: f.text, createdAt: f.createdAt })),
  followups: getFollowups().filter((f) => !f.askedAt)
    .map((f) => ({ id: f.id, q: f.q, createdAt: f.createdAt })),
  approvals: Object.entries(S.approvedApps || {})
    .map(([k, v]) => ({ key: k, at: (v && v.at) || 0 }))
    .sort((a, b) => b.at - a.at),
  turns: getTurns().slice(-12).reverse(),
  referenceExists: fs.existsSync(path.join(app.getPath('userData'), 'reference', 'my-voice-24k.wav')),
  signatureLines: signatureLineCount(),
}))
ipcMain.handle('memory:fact-delete', (_e, id) => {
  const list = getFacts()
  const kept = list.filter((f) => f.id !== id)
  if (kept.length === list.length) return { ok: false }
  setFacts(kept)
  log(`[memory] fact removed from dashboard: ${id}`)
  return { ok: true }
})
ipcMain.handle('memory:followup-delete', (_e, id) => {
  const list = getFollowups()
  const idx = list.findIndex((f) => f.id === id)
  if (idx < 0) return { ok: false }
  list.splice(idx, 1)
  followupsRam = list
  saveFollowups()
  return { ok: true }
})
ipcMain.handle('memory:approve-revoke', (_e, key) => {
  const k = String(key || '')
  if (S.approvedApps && S.approvedApps[k]) {
    delete S.approvedApps[k]
    saveSettings()
    log(`[confirm] forever-approval revoked from dashboard: ${k}`)
    return { ok: true }
  }
  return { ok: false }
})

// ---------------------------------------------------------------- lifecycle
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit() } else {
  app.whenReady().then(() => {
    loadSettings()
    createOverlay()
    spawnHelper()
    setTimeout(connectHelper, 2000)  // give the helper a moment to boot before first connect
    try {
      globalShortcut.register('Control+Alt+R', () => { if (overlay) overlay.isVisible() ? overlay.hide() : overlay.showInactive() })
      globalShortcut.register('Control+Alt+O', openSettings)
      globalShortcut.register('Control+Alt+D', openDashboard)
      globalShortcut.register('Control+Alt+M', () => {
        S.mute = !S.mute; saveSettings(); overlaySend({ type: 'mute', data: { mute: S.mute } })
      })
      globalShortcut.register('Control+Alt+L', () => wsSend({ command: 'listen-now' }))
      globalShortcut.register('Control+Alt+S', () => withTurn(askAboutScreen))
      globalShortcut.register('Control+Alt+X', () => withTurn(explainScreen))
      globalShortcut.register('Control+Alt+Q', () => app.quit())
    } catch (e) { log(`shortcut registration failed: ${e}`) }
  })

  app.on('before-quit', () => {
    closing = true
    try { globalShortcut.unregisterAll() } catch {}
    if (global.smokeNotepad) { try { global.smokeNotepad.kill() } catch {} }
    kokoroShutdown()
    if (process.env.RITA_SMOKE === '3' && global.ritaOcrDoc) {
      try { fs.unlinkSync(global.ritaOcrDoc) } catch {}
    }
    killHelper()
  })

  app.on('window-all-closed', () => { /* stay resident (tray-less overlay app) */ })
}
