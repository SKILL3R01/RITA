// Rita settings renderer — talks only to the rita bridge, no direct node access.
const $ = (id) => document.getElementById(id)
let curMicDevice = ''
let cloneBusy = false

function showStatus(msg, err) {
  const el = $('status')
  el.textContent = msg
  el.className = err ? 'err' : ''
  setTimeout(() => { if (el.textContent === msg) el.textContent = '' }, 5000)
}

function fillMics(devices) {
  const mic = $('micDevice')
  mic.innerHTML = ''
  const def = document.createElement('option')
  def.value = ''
  def.textContent = 'Windows default microphone'
  mic.appendChild(def)
  for (const d of devices || []) {
    const o = document.createElement('option')
    o.value = d.name
    o.textContent = d.name.length > 44 ? d.name.slice(0, 44) + '…' : d.name
    mic.appendChild(o)
  }
  mic.value = Array.from(mic.options).some((o) => o.value === curMicDevice) ? curMicDevice : ''
}

async function refresh() {
  const cfg = await window.rita.settingsGet()
  $('title').textContent = `${cfg.s.name || 'Rita'} — settings`
  $('cloneLabel').textContent = `Clone ${cfg.s.name || 'the assistant'}'s voice`
  $('name').value = cfg.s.name || ''
  const sel = $('ttsVoice')
  sel.innerHTML = ''
  const winOpt = document.createElement('option')
  winOpt.value = ''
  winOpt.textContent = 'Windows built-in voice'
  sel.appendChild(winOpt)
  for (const v of cfg.voices) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = v.replace(/^en_(?:US|GB)_/, '').replace('-', ' ')
    sel.appendChild(o)
  }
  sel.value = Array.from(sel.options).some((o) => o.value === cfg.s.ttsVoice) ? cfg.s.ttsVoice : ''
  $('kokoroOn').checked = cfg.s.ttsKokoro !== false
  $('kokoroVoice').value = Array.from($('kokoroVoice').options).some((o) => o.value === cfg.s.kokoroVoice)
    ? cfg.s.kokoroVoice : 'bf_emma'
  curMicDevice = cfg.s.micDevice || ''
  fillMics(cfg.devices || [])
  $('wakeThreshold').value = cfg.s.wakeThreshold
  $('wakeThresholdVal').textContent = Number(cfg.s.wakeThreshold).toFixed(2)
  $('sessionRms').value = cfg.s.sessionRms
  $('sessionRmsVal').textContent = Number(cfg.s.sessionRms).toFixed(3)
  $('sessionSilenceMs').value = cfg.s.sessionSilenceMs
  $('confirmAgent').checked = !!cfg.s.confirmAgent
  $('internetRead').checked = cfg.s.internetRead === true
  $('mute').checked = !!cfg.s.mute
  $('signatureVoice').checked = cfg.s.signatureVoice !== false
  if (cfg.s.ollamaModel) $('ollamaModel').value = cfg.s.ollamaModel
  if (cfg.s.visionModel) $('visionModel').value = cfg.s.visionModel
  if (cfg.referenceExists) {
    $('cloneGenerate').disabled = cloneBusy
    if (!cloneStatusEl().textContent) cloneStatusEl().textContent = 'Reference recorded — press "Regenerate signature voice".'
  }
  $('settingsPath').textContent = cfg.settingsPath || ''
}

function cloneStatusEl() { return $('cloneStatus') }

function collectPatch() {
  return {
    name: $('name').value.trim() || 'Rita',
    ttsVoice: $('ttsVoice').value,
    ttsKokoro: $('kokoroOn').checked,
    kokoroVoice: $('kokoroVoice').value,
    wakeThreshold: Number($('wakeThreshold').value),
    sessionRms: Number($('sessionRms').value),
    sessionSilenceMs: Number($('sessionSilenceMs').value),
    confirmAgent: $('confirmAgent').checked,
    internetRead: $('internetRead').checked,
    mute: $('mute').checked,
    micDevice: $('micDevice').value,
    signatureVoice: $('signatureVoice').checked,
    ollamaModel: $('ollamaModel').value,
    visionModel: $('visionModel').value,
  }
}

$('wakeThreshold').addEventListener('input', (e) => {
  $('wakeThresholdVal').textContent = Number(e.target.value).toFixed(2)
})

$('sessionRms').addEventListener('input', (e) => {
  $('sessionRmsVal').textContent = Number(e.target.value).toFixed(3)
})

$('testVoice').addEventListener('click', async () => {
  showStatus('testing voice…')
  await window.rita.settingsApply(collectPatch())   // save first so the test uses what you picked
  const r = await window.rita.settingsTestVoice()
  showStatus(r && r.ok ? 'Playing — signature line first, then your chosen voice.' : 'Voice failed: ' + ((r && r.error) || 'unknown'), !(r && r.ok))
})

$('saveBtn').addEventListener('click', async () => {
  const r = await window.rita.settingsApply(collectPatch())
  showStatus(r && r.ok ? 'Saved.' : 'Save failed', !(r && r.ok))
})

$('pullModel').addEventListener('click', async () => {
  await window.rita.settingsApply(collectPatch())
  const r = await window.rita.settingsPullModel(collectPatch())
  showStatus(r && r.ok ? ('Pulling ' + (r.model || '') + '…') : 'Pull failed: ' + ((r && r.error) || 'unknown'), !(r && r.ok))
})

async function refreshOllamaStatus() {
  const el = document.getElementById('ollamaStatus')
  const btn = document.getElementById('installOllama')
  if (!el) return
  try {
    const r = await window.rita.ollamaStatus()
    if (r.ok) {
      el.textContent = 'Ollama running ✓'
      el.className = 'ok'
      btn.style.display = 'none'
    } else {
      el.textContent = 'Ollama not detected'
      el.className = 'warn'
      btn.style.display = ''
    }
  } catch {
    el.textContent = 'Ollama not detected'
    el.className = 'warn'
    btn.style.display = ''
  }
}
document.getElementById('installOllama').addEventListener('click', async () => {
  const el = document.getElementById('ollamaStatus')
  const btn = document.getElementById('installOllama')
  btn.disabled = true
  if (el) el.textContent = 'installing Ollama via winget… (this can take a few minutes)'
  const r = await window.rita.ollamaInstallWinget()
  btn.disabled = false
  if (r.ok) showStatus('Ollama installed — starting it may take a minute.')
  else showStatus('winget install failed — install Ollama from ollama.com manually.', true)
  await refreshOllamaStatus()
})
refreshOllamaStatus()
setInterval(refreshOllamaStatus, 15000)

$('restartBtn').addEventListener('click', async () => {
  await window.rita.settingsApply(collectPatch())
  showStatus('Restarting…')
  await new Promise((r) => setTimeout(r, 400))
  await window.rita.settingsRestart()
})

$('cloneRecord').addEventListener('click', async () => {
  if (cloneBusy) return
  cloneBusy = true
  $('cloneRecord').disabled = true
  cloneStatusEl().textContent = 'Recording ~20 s — talk naturally right now (your own voice only)…'
  const r = await window.rita.settingsCloneRecord()
  cloneBusy = false
  $('cloneRecord').disabled = false
  if (r && r.ok) {
    cloneStatusEl().textContent = (r.message || 'Recorded.')
    $('cloneGenerate').disabled = false
  } else {
    cloneStatusEl().textContent = (r && (r.message || r.error)) || 'Recording failed.'
    showStatus('record failed — see the section above', true)
  }
})

$('cloneGenerate').addEventListener('click', async () => {
  if (cloneBusy) return
  cloneBusy = true
  const gen = $('cloneGenerate')
  gen.disabled = true
  cloneStatusEl().textContent = 'Generating in your voice… lines appear as they finish.'
  const r = await window.rita.settingsCloneGenerate()
  if (!(r && r.ok)) {
    cloneBusy = false
    gen.disabled = false
    cloneStatusEl().textContent = (r && r.error) || 'Generation failed to start.'
  }
})

$('closeBtn').addEventListener('click', () => { window.close() })

// live events: mic device list + voice-clone progress
window.rita.events((m) => {
  if (m.type === 'devices' && Array.isArray(m.data)) {
    fillMics(m.data)
    return
  }
  if (m.type === 'clone-progress' && m.data) {
    cloneStatusEl().textContent = (m.data.snapshot || '') + '\nGenerating… 12 lines total'
  } else if (m.type === 'clone-done') {
    cloneBusy = false
    cloneStatusEl().textContent = 'Done — press "Say a test line" above to hear your voice.'
    const gen = $('cloneGenerate')
    if (gen) gen.disabled = true
  } else if (m.type === 'clone-failed') {
    cloneBusy = false
    cloneStatusEl().textContent = (m.data && m.data.message) || 'Generation failed.'
    const gen = $('cloneGenerate')
    if (gen) gen.disabled = false
  }
})

;(async () => {
  try {
    await refresh()
  } catch (e) {
    showStatus('load failed: ' + String((e && e.message) || e), true)
  }
})()
