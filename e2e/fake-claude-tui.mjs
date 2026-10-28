// Fake `claude` TUI for the e2e (F6.3): never the real CLI. Draws the screens the classifier reads (docs/spikes/F6b.md): an input box (rules + `❯` NBSP + footer),
// a working footer with "esc to interrupt", a `/` list, a dialog, an unknown screen. Enables bracketed paste and parses pasted text. Every submitted message
// appends a user line, a pending Bash tool_use and then the result + an assistant line to its transcript. Logs every byte it receives.
//   argv[2] session id | env STUB_KEYS (log file) STUB_CTL (control file: '', 'dialog' or 'unknown') STUB_ENC + CLAUDE_CONFIG_DIR (transcript) STUB_THINK (ms)
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const sid = process.argv[2] ?? '00000000-0000-4000-8000-000000000000'
const { STUB_KEYS: keysLog, STUB_CTL: ctl, STUB_ENC: enc, CLAUDE_CONFIG_DIR: cfg } = process.env
const think = Number(process.env.STUB_THINK ?? 1500)
const NBSP = ' '
const tr = enc && cfg ? join(cfg, 'projects', enc, `${sid}.jsonl`) : ''
if (tr) mkdirSync(join(cfg, 'projects', enc), { recursive: true })
const log = (l) => keysLog && appendFileSync(keysLog, l + '\n')

let input = ''
let paste = false
let thinking = null // timer while a turn runs
let listClosed = false
let forced = ''
const queue = []
let n = 0
const stamp = () => new Date(Date.UTC(2026, 0, 1, 12, 0, n++)).toISOString()
const line = (o) => tr && appendFileSync(tr, JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: process.cwd(), sessionId: sid, version: '2.1.312', gitBranch: 'main', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: stamp(), ...o }) + '\n')
const asst = (mid, block, stop) => line({ type: 'assistant', requestId: `req_${mid}`, message: { id: `msg_${mid}`, type: 'message', role: 'assistant', model: 'claude-fake-1', content: [block], stop_reason: stop, usage: { input_tokens: 3, output_tokens: 5 } } })

function draw() {
  const rows = process.stdout.rows || 30
  const w = process.stdout.columns || 100
  const rule = '─'.repeat(w)
  const body = []
  let cursor = null // [row index in body, col]
  if (forced === 'unknown') body.push(' Something unexpected happened.', ' Please contact support.')
  else if (forced === 'dialog') {
    body.push(rule, ' Bash command', ' Create empty file created1.txt', '╌'.repeat(w), ' touch created1.txt', '╌'.repeat(w), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and always allow access', '   3. No', '', ' Esc to cancel · Tab to amend')
  } else {
    if (input.startsWith('/') && !listClosed) body.push(`  ❯ /debug    Debug a problem`, `    /add-dir  Add a directory`)
    if (thinking) body.push('', '✻ Pondering…')
    body.push('', rule)
    const rowsIn = input.split('\n')
    cursor = [body.length, 2 + rowsIn[0].length]
    body.push(`❯${NBSP}${rowsIn[0] || (thinking ? '' : 'Try "something"')}`, ...rowsIn.slice(1).map((l) => `  ${l}`))
    if (!input && !thinking) cursor[1] = 2
    body.push(rule, thinking ? '  ⏸ manual mode on · esc to interrupt' : '  ⏸ manual mode on · ? for shortcuts')
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
function submit() {
  const text = input.trim()
  input = ''
  listClosed = false
  if (!text) return
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
  for (let i = 0; i < d.length; i++) {
    const c = d[i]
    if (d.startsWith('\x1b[200~', i)) ((paste = true), (i += 5))
    else if (d.startsWith('\x1b[201~', i)) ((paste = false), (i += 5))
    else if (paste) input += c === '\r' ? '' : c
    else if (c === '\r') submit()
    else if (c === '\x15') ((input = ''), (listClosed = false))
    else if (c === '\x7f') input = input.slice(0, -1)
    else if (c === '\x1b') {
      if (d[i + 1] === '[') {
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
  if (v !== forced) ((forced = v), draw())
}, 100)
process.stdout.write('\x1b[?2004h')
log(`SIZE:${process.stdout.rows} ${process.stdout.columns}`)
draw()
setTimeout(() => process.exit(0), 300_000)
