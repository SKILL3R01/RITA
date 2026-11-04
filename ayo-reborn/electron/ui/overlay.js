// Rita overlay renderer — display only, tiny and dependency-free.
const $ = (id) => document.getElementById(id)
const dot = $('dot')
const statusText = $('statusText')
const you = $('lineYou')
const answer = $('lineA')
const pill = $('pill')
const hintSpan = $('hintSpan')

let init = { mute: false, connected: false }
let glowTimer = null

function setDot(cls, labelText) {
  dot.className = 'dot ' + cls
  if (labelText) $('statusText').textContent = labelText
}

function glowOnce() {
  pill.classList.remove('glow')
  void pill.offsetWidth  // restart the animation
  pill.classList.add('glow')
  clearTimeout(glowTimer)
  glowTimer = setTimeout(() => pill.classList.remove('glow'), 1300)
}

function setError(msg) {
  pill.classList.add('error')
  you.textContent = ''
  answer.textContent = msg
  answer.classList.add('errorline')
  setTimeout(() => { pill.classList.remove('error'); answer.classList.remove('errorline') }, 8000)
}

function onEvent({ type, data }) {
  switch (type) {
    case 'init':
      init = data
      document.getElementById('muteBtn').textContent = init.mute ? '🔇' : '🔊'
      if (init.connected) setDot('idle', 'listening for “Ayo”')
      break
    case 'state':
      if (data.capturing) setDot('busy', 'listening…')
      else if (data.paused) setDot('muted', 'paused')
      else if (data.state === 'transcribing') setDot('busy', 'transcribing…')
      else setDot('idle', init.connected ? 'listening for “Ayo”' : 'connecting helper…')
      break
    case 'helper-state':
      init.connected = data.connected
      if (!data.connected) { setDot('down', 'helper down — ' + (data.reason || '')) }
      else setDot('idle', 'listening for “Ayo”')
      break
    case 'wake':
      glowOnce()
      setDot('busy', 'listening…')
      you.textContent = ''
      answer.textContent = ''
      break
    case 'capture-started': setDot('busy', 'listening… you can talk'); break
    case 'capture-cancelled': setDot('idle', 'cancelled'); break
    case 'stt-status':
      init.stt = data
      if (data.available === false) setError('STT unavailable: install faster-whisper (see helper/requirements.txt)')
      break
    case 'you':
      you.textContent = 'you: ' + (data.text || '')
      setDot('busy', 'thinking…')
      break
    case 'answer':
      answer.textContent = data.text || ''
      setDot('speaking', 'answering…')
      break
    case 'not-heard':
      setDot('idle', "didn't catch that")
      break
    case 'status': setDot(data.label === 'speaking' ? 'speaking' : 'busy', data.label); break
    case 'hint': hintSpan.textContent = data.text || ''; break
    case 'mic-error':
      setError('mic: ' + (data.message || 'error'))
      if (data.fatal) setDot('down', 'microphone error')
      break
    case 'stt-error': setError('stt: ' + (data.message || 'error')); break
    case 'error': setError(data.message || 'error'); break
  }
}

document.getElementById('dashBtn').onclick = () => window.rita.dashboardOpen()
document.getElementById('hideBtn').onclick = () => window.rita.hide()
document.getElementById('muteBtn').onclick = async () => {
  const mute = await window.rita.toggleMute()
  document.getElementById('muteBtn').textContent = mute ? '🔇' : '🔊'
  setDot(mute ? 'muted' : 'idle', mute ? 'muted' : 'listening for “Ayo”')
}

window.rita.events(onEvent)
;((async () => {
  const id = await window.rita.getInit()
  init = { ...init, ...id }
  document.getElementById('muteBtn').textContent = init.mute ? '🔇' : '🔊'
  if (init.connected) setDot('idle', 'listening for “Ayo”')
})())
