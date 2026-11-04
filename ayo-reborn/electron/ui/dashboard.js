// Rita dashboard — instant feedback of live state plus management of
// facts / check-ins / forever-approvals / recent turns. Re-reads every 3 s.
const $ = (id) => document.getElementById(id)
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function render(d) {
  const s = d.s || {}
  $('title').textContent = `${s.name || 'Rita'} — control room`

  // brain
  const connected = !!d.helperConnected
  $('tBrain').innerHTML = `<span class="${connected ? 'ok' : 'down'}">${connected ? '● ' : '○ '}</span>${esc(s.ollamaModel || '?')}`
  $('tBrainSub').textContent = connected ? 'helper connected · listening' : 'helper not connected'
  $('tBrainSub').className = 'sub ' + (connected ? 'ok' : 'down')

  // ears
  $('tEars').textContent = `whisper ${s.sttModel || 'base'} · wake ${String(s.wakeModel || '').replace('.onnx','')}`
  $('tEarsSub').textContent = `gate ${Number(s.wakeThreshold).toFixed(2)} · silence ${'' }` ? $('tEarsSub').textContent : ''
  $('tEarsSub').textContent = `wake gate ${Number(s.wakeThreshold || 0).toFixed(2)}`

  // voice
  const eng = s.voiceEngine || 'chatterbox'
  let vsub = ''
  if (eng === 'chatterbox') {
    vsub = d.referenceExists
      ? `signature voice: ${d.signatureLines} line(s) saved`
      : 'no reference yet — record 20 s in settings'
    $('tVoice').textContent = 'signature (cloned)' + (d.referenceExists ? '' : ' → setup')
    $('tVoice').className = 'big ' + (d.referenceExists ? 'ok' : 'warn')
  } else {
    $('tVoice').textContent = `kokoro ${(s.kokoroVoice || '').replace(/^[ab][fm]_/, '')}`
    vsub = 'live on-device voice · says "switch to <name>"'
    $('tVoice').className = 'big'
  }
  $('tVoiceSub').textContent = vsub

  // memory
  const factsN = (d.facts || []).length
  const fuN = (d.followups || []).length
  $('tMemory').textContent = `${factsN} fact${factsN === 1 ? '' : 's'} · ${fuN} check-in${fuN === 1 ? '' : 's'}`
  $('tMemorySub').textContent = factsN ? 'oldest fact is a few hours to days old' : 'nothing captured yet — talk to her'
  $('tMemory').className = 'big'

  // facts
  $('facts').innerHTML = ''
  if (!factsN) $('facts').innerHTML = '<div class="empty">nothing yet — she picks facts up from conversations automatically</div>'
  for (const f of d.facts || []) {
    const r = document.createElement('div')
    r.className = 'rowline'
    r.innerHTML = `<span class="when">${esc(fmtTime(f.createdAt))}</span><span class="grow">${esc(f.text)}</span>`
    const x = document.createElement('button')
    x.className = 'x'; x.textContent = '✕'; x.title = 'forget this fact'
    x.onclick = async () => { await window.rita.memoryFactDelete(f.id); refresh() }
    r.appendChild(x)
    $('facts').appendChild(r)
  }

  // followups
  $('followups').innerHTML = ''
  if (!fuN) $('followups').innerHTML = '<div class="empty">no open check-ins — she will bring things up at the right moment</div>'
  for (const f of d.followups || []) {
    const r = document.createElement('div')
    r.className = 'rowline'
    r.innerHTML = `<span class="when">${esc(fmtTime(f.createdAt))}</span><span class="grow">${esc(f.q)}</span>`
    const x = document.createElement('button')
    x.className = 'x'; x.textContent = '✕'; x.title = 'drop this check-in'
    x.onclick = async () => { await window.rita.memoryFollowupDelete(f.id); refresh() }
    r.appendChild(x)
    $('followups').appendChild(r)
  }

  // approvals
  $('approvals').innerHTML = ''
  if (!(d.approvals || []).length) $('approvals').innerHTML = '<div class="empty">nothing auto-opened yet — she asks before opening anything the first time</div>'
  for (const a of d.approvals || []) {
    const r = document.createElement('div')
    r.className = 'rowline'
    r.innerHTML = `<span class="when">${esc(fmtTime(a.at || Date.now()))}</span><span class="grow">${esc(a.key)}</span>`
    const rev = document.createElement('button')
    rev.className = 'rev'; rev.textContent = 'ask again'
    rev.onclick = async () => { await window.rita.memoryApproveRevoke(a.key); refresh() }
    r.appendChild(rev)
    $('approvals').appendChild(r)
  }

  // turns
  $('turns').innerHTML = ''
  if (!(d.turns || []).length) $('turns').innerHTML = '<div class="empty">no conversations logged yet</div>'
  for (const t of d.turns || []) {
    const r = document.createElement('div')
    r.className = 'rowline'
    r.innerHTML = `<span class="when">${esc(fmtTime(t.ts))}</span><span class="grow">`
      + `<span class="you">${esc(t.text)}</span><br><span class="her">${esc(t.answer || '')}</span></span>`
    $('turns').appendChild(r)
  }
}

function esc(s) {
  const d = document.createElement('div')
  d.textContent = String(s == null ? '' : s)
  return d.innerHTML
}

async function refresh() {
  try { render(await window.rita.dashboardGet()) } catch (e) { /* window closing */ }
}
refresh()
setInterval(refresh, 3000)
