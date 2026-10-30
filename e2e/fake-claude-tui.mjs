// Fake `claude` TUI for the e2e (F6.3): never the real CLI. Draws the screens the classifier reads (docs/spikes/F6b.md): an input box (rules + `❯` NBSP + footer),
// a working footer with "esc to interrupt", a `/` list, a dialog, an unknown screen. Enables bracketed paste and parses pasted text. Every submitted message
// appends a user line, a pending Bash tool_use and then the result + an assistant line to its transcript. Logs every byte it receives.
//   argv[2] session id | env STUB_KEYS (log file) STUB_CTL (control file: '', 'unknown' or a dialog name, see DIALOGS) STUB_ENC + CLAUDE_CONFIG_DIR (transcript) STUB_THINK (ms)
// F6.4: the dialogs are drawn from the real fixtures (tests/fixtures/screens) and answer to the keys the spike documents (docs/spikes/F6b.md 4-7): a digit selects and
// confirms (toggles in multi-select), Tab moves to the next tab, a text row takes the typed line and Enter, ESC cancels. Every answer is logged as `ANSWER:...`.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/screens')
const RULE = /^\s*─{20,}\s*$/
const DASH = /^\s*╌+\s*$/
/** The dialog part of a fixture (from the rule above `anchor`), blank runs squeezed, rules redrawn at the pty width. */
function fx(file, anchor, w, edit = (l) => l) {
  const all = readFileSync(join(SCREENS, file), 'utf8').replace(/\n$/, '').split('\n')
  all.pop() // harness metadata
  const at = all.findIndex((l) => anchor.test(l))
  const out = []
  for (const l of all.slice(Math.max(0, at - 1))) {
    const t = RULE.test(l) || DASH.test(l) ? l.replace(/^(\s*)(.).*$/, (_, ind, ch) => ind + ch.repeat(Math.max(1, w - ind.length))) : edit(l).slice(0, w)
    if (t.trim() || out.at(-1)?.trim()) out.push(t)
  }
  while (!out.at(-1)?.trim()) out.pop()
  return out
}

// F6.5: Shift+Tab (ESC [ Z) cycles the permission mode with the real footer texts (docs/spikes/F6b.md 8; ctl `dropkey` ignores it); a submitted `/compact`, `/clear`, `/model x`
// is logged as `CMD:<text>` and reacted to (compact -> brief spinner + compact_boundary line, clear -> a NEW session file like the CLI, model -> later answers carry that model).
let sid = process.argv[2] ?? '00000000-0000-4000-8000-000000000000'
const { STUB_KEYS: keysLog, STUB_CTL: ctl, STUB_ENC: enc, CLAUDE_CONFIG_DIR: cfg } = process.env
const think = Number(process.env.STUB_THINK ?? 1500)
const NBSP = ' '
let tr = enc && cfg ? join(cfg, 'projects', enc, `${sid}.jsonl`) : ''
let model = 'claude-fake-1'
const MODES = ['⏸ manual mode on', '⏵⏵ accept edits on (shift+tab to cycle)', '⏸ plan mode on (shift+tab to cycle)', '⏵⏵ auto mode on (shift+tab to cycle)']
let mode = 0
let shifts = 0 // Shift+Tab presses since the control file last changed (`dropsecond` ignores only the 2nd)
if (tr) mkdirSync(join(cfg, 'projects', enc), { recursive: true })
const log = (l) => keysLog && appendFileSync(keysLog, l + '\n')

let input = ''
let paste = false
let thinking = null // timer while a turn runs
let listClosed = false
let forced = ''
let dlg = null // { kind, step, boxes: Set, text }
let pendingTool = null
/** AskUserQuestion / ExitPlanMode wait in the transcript (a tool_use with no result) while their dialog is open, like the real CLI. */
function openTool(name, input) {
  pendingTool = `tu_dlg${++n}`
  asst(`dlg${n}`, { type: 'tool_use', id: pendingTool, name, input }, 'tool_use')
}
const answer = (what) => {
  log(`ANSWER:${what}`)
  if (pendingTool) line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: pendingTool, content: 'ok' }] }, toolUseResult: { interrupted: false } })
  pendingTool = null
  dlg = null
  draw()
}
const brief = () => (thinking = setTimeout(() => ((thinking = null), draw()), 1200)) // the CLI works a moment after a yes
const DIALOGS = {
  permission: { v: 'permission' },
  permission2: { v: 'permission', other: true }, // a different command: the stale-guard test swaps to it
  question: { v: 'question' },
  question3: { v: 'question', confirmText: true }, // a CLI where the digit of "Type something" CONFIRMS instead of moving focus: the line must never be sent
  longperm: { v: 'permission', long: true }, // a command taller than the screen: the dialog's top rule scrolls off
  multi: { v: 'multi' },
  plan: { v: 'plan' },
  trust: { v: 'trust' },
  odd: { v: 'odd' } // a dialog with no known anchor: dialog:unknown
}
function dlgFrame(w) {
  const { kind, step, boxes, text, other } = dlg
  if (kind === 'permission') {
    const f = fx('04b-permission-touch.txt', /Bash command/, w, (l) => (other ? l.replace('created1.txt', 'other-file.txt') : l))
    if (dlg.long) f.splice(f.findIndex((l) => /touch created1/.test(l)), 1, ...Array.from({ length: 60 }, (_, i) => ` echo step-${i}`))
    return f
  }
  if (kind === 'odd') return ['─'.repeat(w), ' Pick a flavour', ' ❯ 1. Mint', '   2. Lime', ' Enter to select']
  if (kind === 'trust') return fx('01-trust.txt', /Accessing workspace/, w)
  if (kind === 'plan') return fx(text !== null ? '06b-plan-feedback.txt' : '06a-plan-approval.txt', /Ready to code/, w, (l) => (text ? l.replace('Tell Claude what to change', text) : l))
  if (kind === 'question') return fx(text !== null ? '05b-askuser-other.txt' : '05a-askuser.txt', /☐ Color/, w, (l) => (text ? l.replace('Type something.', text) : l))
  if (step === 'review') return fx('05f-askuser-review.txt', /☒ Fruits  ☒ Size/, w)
  if (step === 'size') return fx('05e-askuser-tab2.txt', /☒ Fruits/, w)
  return fx('05d-askuser-multi.txt', /☐ Fruits/, w, (l) => l.replace(/^(.*?)(\d)\. \[ \]/, (m, a, n) => (boxes.has(Number(n)) ? `${a}${n}. [✔]` : m)))
}
/** One key (a char, or 'ESC' / 'TAB') while a dialog is open. */
function dlgKey(k) {
  const { kind, step } = dlg
  if (kind === 'trust' || kind === 'odd') return // unnumbered, Enter would exit the real CLI: the fake just stays
  if (k === 'ESC') return answer(`${kind}:cancel`)
  if (dlg.text !== null) { // typing in a text row
    if (k === '\r') return answer(`${kind}:text:${dlg.text}`)
    if (k === '\x7f') dlg.text = dlg.text.slice(0, -1)
    else if (k >= ' ') dlg.text += k
    return
  }
  const n = /^[1-9]$/.test(k) ? Number(k) : 0
  if (kind === 'permission') return void (n >= 1 && n <= 4 && (n < 4 && brief(), answer(`permission:${n}`)))
  if (kind === 'question') return n === 3 && !dlg.confirmText ? void (dlg.text = '') : void (n && n <= 4 && answer(`question:${n}`))
  if (kind === 'plan') return n === 3 ? void (dlg.text = '') : void (n && n <= 2 && (brief(), answer(`plan:${n}`)))
  if (step === 'review') return void (n && n <= 2 && answer(`multi:review:${n}`))
  if (step === 'size') return void (n && n <= 4 && (n <= 2 ? (log(`ANSWER:multi:size:${n}`), (dlg.step = 'review')) : answer(`multi:size:${n}`)))
  if (k === '\t') return (log('ANSWER:multi:next'), void (dlg.step = 'size'))
  if (n >= 1 && n <= 4) return (dlg.boxes.has(n) ? dlg.boxes.delete(n) : dlg.boxes.add(n), log(`ANSWER:multi:toggle:${n}`))
  if (n === 5) answer('multi:chat')
}
const queue = []
let n = 0
const stamp = () => new Date(Date.UTC(2026, 0, 1, 12, 0, n++)).toISOString()
const line = (o) => tr && appendFileSync(tr, JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: process.cwd(), sessionId: sid, version: '2.1.312', gitBranch: 'main', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: stamp(), ...o }) + '\n')
const asst = (mid, block, stop) => line({ type: 'assistant', requestId: `req_${mid}`, message: { id: `msg_${mid}`, type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, usage: { input_tokens: 3, output_tokens: 5 } } })

function draw() {
  const rows = process.stdout.rows || 30
  const w = process.stdout.columns || 100
  const rule = '─'.repeat(w)
  const body = []
  let cursor = null // [row index in body, col]
  if (forced === 'unknown') body.push(' Something unexpected happened.', ' Please contact support.')
  else if (dlg) body.push(...dlgFrame(w))
  else {
    if (input.startsWith('/') && !listClosed) body.push(`  ❯ /debug    Debug a problem`, `    /add-dir  Add a directory`)
    if (thinking) body.push('', '✻ Pondering…')
    body.push('', rule)
    const rowsIn = input.split('\n')
    cursor = [body.length, 2 + rowsIn[0].length]
    body.push(`❯${NBSP}${rowsIn[0] || (thinking ? '' : 'Try "something"')}`, ...rowsIn.slice(1).map((l) => `  ${l}`))
    if (!input && !thinking) cursor[1] = 2
    body.push(rule, `  ${MODES[mode]}${thinking ? ' · esc to interrupt' : mode ? '' : ' · ? for shortcuts'}`)
  }
  const head = [' Claude Code (fake TUI)', ' fake model · test', ` ${process.cwd()}`]
  const pad = Math.max(0, rows - head.length - body.length)
  const all = [...head, ...Array(pad).fill(''), ...body]
  let out = '\x1b[2J\x1b[H' + all.slice(-rows).join('\r\n')
  if (cursor) out += `\x1b[${all.slice(-rows).length - body.length + cursor[0] + 1};${cursor[1] + 1}H`
  process.stdout.write(out)
}

function startTurn(text) {
  const id = `t${++n}`
  line({ type: 'user', message: { role: 'user', content: text } })
  asst(`${id}a`, { type: 'tool_use', id: `tu_${id}`, name: 'Bash', input: { command: 'bun test' } }, 'tool_use')
  thinking = setTimeout(() => {
    thinking = null
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${id}`, content: 'ok' }] }, toolUseResult: { stdout: 'ok', stderr: '', interrupted: false } })
    asst(`${id}b`, { type: 'text', text: `Respuesta a: ${text.split('\n')[0]}` }, 'end_turn')
    if (queue.length) startTurn(queue.shift())
    draw()
  }, think)
}
function command(text) {
  log(`CMD:${text}`)
  const [name, arg] = text.split(/\s+/)
  if (name === '/clear') {
    sid = randomUUID()
    if (enc && cfg) tr = join(cfg, 'projects', enc, `${sid}.jsonl`)
    line({ type: 'system', subtype: 'local_command', content: '<command-name>/clear</command-name>' })
  } else if (name === '/compact') {
    thinking = setTimeout(() => ((thinking = null), line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 1200 } }), draw()), 1200)
  } else if (name === '/model' && arg) {
    model = `claude-${arg}`
    asst(`m${++n}`, { type: 'text', text: `Set model to ${arg}` }, 'end_turn')
  }
}
function submit() {
  const text = input.trim()
  input = ''
  listClosed = false
  if (!text) return
  if (text.startsWith('/')) return command(text)
  if (thinking) queue.push(text)
  else startTurn(text)
}
function esc() {
  if (thinking) {
    clearTimeout(thinking)
    thinking = null
    queue.length = 0
  } else listClosed = true // a closed `/` list leaves the character in the box, like the real CLI
}

process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  log(`BYTES:${JSON.stringify(d)}`)
  if (dlg) {
    for (let i = 0; i < d.length; i++) {
      if (d[i] !== '\x1b') dlgKey(d[i])
      else if (d[i + 1] === '[') for (i += 2; i < d.length && !/[@-~]/.test(d[i]); i++); // arrows etc.: not modelled
      else dlgKey('ESC')
      if (!dlg) break
    }
    return draw()
  }
  for (let i = 0; i < d.length; i++) {
    const c = d[i]
    if (d.startsWith('\x1b[200~', i)) ((paste = true), (i += 5))
    else if (d.startsWith('\x1b[201~', i)) ((paste = false), (i += 5))
    else if (paste) input += c === '\r' ? '' : c
    else if (c === '\r') submit()
    else if (c === '\x15') ((input = ''), (listClosed = false))
    else if (c === '\x7f') input = input.slice(0, -1)
    else if (c === '\x1b') {
      if (d[i + 1] === '[' && d[i + 2] === 'Z') {
        i += 2
        shifts++
        if (forced !== 'dropkey' && !(forced === 'dropsecond' && shifts === 2)) mode = (mode + 1) % MODES.length
      } else if (d[i + 1] === '[') {
        i += 2
        while (i < d.length && !/[@-~]/.test(d[i])) i++
      } else esc()
    } else if (c >= ' ' || c === '\t') ((input += c), (listClosed = false))
  }
  draw()
})
process.stdout.on('resize', () => (log(`SIZE:${process.stdout.rows} ${process.stdout.columns}`), draw()))
if (ctl) setInterval(() => {
  const v = existsSync(ctl) ? readFileSync(ctl, 'utf8').trim() : ''
  if (v === forced) return
  forced = v
  shifts = 0
  dlg = DIALOGS[v] ? { kind: DIALOGS[v].v, other: !!DIALOGS[v].other, long: !!DIALOGS[v].long, confirmText: !!DIALOGS[v].confirmText, step: 'fruits', boxes: new Set(), text: null } : null
  if (v === 'plan') openTool('ExitPlanMode', { plan: '# Plan de prueba\n\n- paso uno\n- paso dos' })
  if (v === 'question') openTool('AskUserQuestion', { questions: [{ question: 'Which color do you prefer?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Rojo desde el transcript' }, { label: 'Blue', description: 'Azul desde el transcript' }] }] })
  draw()
}, 100)
process.stdout.write('\x1b[?2004h')
log(`SIZE:${process.stdout.rows} ${process.stdout.columns}`)
draw()
setTimeout(() => process.exit(0), 300_000)
