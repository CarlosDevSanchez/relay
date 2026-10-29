// Smoke test of the built app with fake `claude` / `codex` binaries, a temp RELAY_HOME and a temp HOME: never touches ~/.relay or a real CLI.
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'e2e/screenshots')
mkdirSync(shots, { recursive: true })
const tmp = mkdtempSync(join(tmpdir(), 'relay-e2e-'))
const t = 20_000
// fake claude: logs "<CLAUDE_CONFIG_DIR or UNSET>|<args>" and, like the real CLI, creates .claude.json in the config dir on `auth status`
const stub = join(tmp, 'claude.stub')
const log = join(tmp, 'calls.log')
const settingsLog = join(tmp, 'settings.log')
const envLog = join(tmp, 'env.log')
writeFileSync(
  stub,
  `#!/bin/bash
# Relay passes its status line through the official --settings flag (inline JSON): split it off so the logged argv stays the CLI's own
args=(); S=
while [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then S="$2"; shift 2; else args+=("$1"); shift; fi; done
set -- "\${args[@]}"
echo "\${CLAUDE_CONFIG_DIR-UNSET}|$*" >> "${log}"
# like the real CLI, a session runs the configured statusLine command with the status JSON on stdin (fixture file, re-read every second)
session() {
  echo "$S" >> "${settingsLog}"
  echo "\${RELAY_STATUS_FILE-UNSET}|\${RELAY_USER_STATUSLINE-UNSET}" >> "${envLog}"
  cmd=$(printf '%s' "$S" | sed -n 's/.*"command":"\\(.*\\)"}}.*/\\1/p')
  if [ -n "$cmd" ] && [ -n "$STUB_FIXTURE" ]; then
    for i in $(seq 70); do [ -f "$STUB_FIXTURE" ] && sh -c "$cmd" < "$STUB_FIXTURE" > "${tmp}/statusline-out.$(basename "$CLAUDE_CONFIG_DIR")"; sleep 1; done
  else sleep 60; fi
}
# scripted transcript (F6.2): with STUB_SCRIPT set, a new/resumed session appends the script's lines to its transcript over time, like the CLI writing blocks as they happen
script() {
  d="$CLAUDE_CONFIG_DIR/projects/$STUB_ENC"; mkdir -p "$d/$1/subagents"
  sed "s/__SID__/$1/g" "$STUB_AGENT" > "$d/$1/subagents/agent-a1b2c3d4e5f60718.jsonl"
  while IFS= read -r l; do printf '%s\\n' "$l" | sed "s/__SID__/$1/g" >> "$d/$1.jsonl"; sleep "\${STUB_GAP:-0.4}"; done < "$STUB_SCRIPT"
}
case "$1 $2" in
  "auth status") [ -n "$CLAUDE_CONFIG_DIR" ] && touch "$CLAUDE_CONFIG_DIR/.claude.json"; echo "{\\"loggedIn\\":true,\\"email\\":\\"\${STUB_EMAIL:-test@example.com}\\",\\"subscriptionType\\":\\"max\\"}" ;;
  "auth login") sleep 1; echo "Paste code here"; read -t 20 -r code; echo "CODE:$code" >> "${log}"; exit 0 ;;
  # the session is a fake TUI (e2e/fake-claude-tui.mjs, F6.3); the status line loop runs beside it unless STUB_KEYS logs the pty
  "--session-id "*|"--resume "*) [ -n "$STUB_SCRIPT" ] && script "$2" & sleep 1; [ -z "$STUB_KEYS" ] && session & "$STUB_NODE" "$STUB_TUI" "$2" ;;
  *) echo "2.1.0 (Claude Code)" ;;
esac
`
)
chmodSync(stub, 0o755)
// fake codex: logs "<CODEX_HOME or UNSET>|<args>"; `login status` is logged in (exit 0, like the real CLI), `login` ends by itself, resume / bare keep a live session
const cstub = join(tmp, 'codex.stub')
const clog = join(tmp, 'codex-calls.log')
writeFileSync(
  cstub,
  `#!/bin/bash
echo "\${CODEX_HOME-UNSET}|$*" >> "${clog}"
case "$*" in
  "login status") echo "Logged in using ChatGPT" ;;
  "login") sleep 1; echo "Codex (stub): login"; sleep 1; exit 0 ;;
  "--version") echo "codex-cli 0.164.0" ;;
  ""|"resume "*) sleep 60 ;;
  *) echo "codex-cli 0.164.0" ;;
esac
`
)
chmodSync(cstub, 0o755)
const setup = (name) => {
  const d = join(tmp, name)
  const dirs = { bin: join(d, 'bin'), home: join(d, 'home'), relayHome: join(d, 'relay') }
  for (const x of [dirs.bin, dirs.home]) mkdirSync(x, { recursive: true })
  return dirs
}
const launch = (d, extra = {}) => {
  const env = { ...process.env, RELAY_HOME: d.relayHome, HOME: d.home, PATH: `${d.bin}:/usr/bin:/bin`, STUB_NODE: process.execPath, STUB_TUI: join(root, 'e2e/fake-claude-tui.mjs'), ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({ args: [root, `--user-data-dir=${join(d.home, 'userdata')}`], env }) // own Chromium profile: localStorage (sidebar UI state) never leaks between scenarios or into a real app profile
}

// every visible element of the sidebar stays inside its box and the page never scrolls sideways
const sidebarFits = async (page, state) => {
  const bad = await page.evaluate(() => {
    const sb = document.querySelector('aside').getBoundingClientRect()
    const out = []
    for (const el of document.querySelectorAll('aside *')) {
      if (getComputedStyle(el).visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (r.left < sb.left - 0.5 || r.right > sb.right + 0.5) out.push(`${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(r.left - sb.left)}..${Math.round(r.right - sb.left)} of ${Math.round(sb.width)}`)
    }
    const sc = document.querySelector('aside .overflow-y-auto')
    if (sc.scrollLeft !== 0) out.push(`scrollLeft ${sc.scrollLeft}`)
    // the shell never scrolls sideways
    const de = document.documentElement
    if (de.scrollWidth > de.clientWidth) out.push(`html scrollWidth ${de.scrollWidth} > ${de.clientWidth}`)
    if (window.scrollX !== 0) out.push(`scrollX ${window.scrollX}`)
    for (const sel of ['main', 'aside']) {
      const e = document.querySelector(sel)
      if (e.scrollWidth > e.clientWidth) out.push(`${sel} scrollWidth ${e.scrollWidth} > ${e.clientWidth}`)
    }
    // nothing may be wider than its box unless it truncates with an ellipsis (a clipped overflow = content cut off or pushed out)
    for (const el of document.querySelectorAll('aside *')) {
      if (getComputedStyle(el).visibility === 'hidden' || el.clientWidth === 0) continue
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis') out.push(`overflow ${el.tagName}.${String(el.className).slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`)
    }
    return out
  })
  assert.deepEqual(bad, [], `sidebar content outside its box / page scrolls sideways (${state})`)
  // focusing every focusable must not scroll the shell either
  const sx = await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, [tabindex], a, input, select, textarea')) {
      if (el.closest('dialog') || getComputedStyle(el).visibility === 'hidden') continue
      el.focus()
    }
    document.activeElement?.blur()
    return [window.scrollX, document.documentElement.scrollLeft, document.body.scrollLeft, document.querySelector('aside .overflow-y-auto').scrollLeft]
  })
  assert.deepEqual(sx, [0, 0, 0, 0], `focus pass scrolled the shell (${state})`)
}

// the main area stays inside its box and nothing overflows its own box unless it truncates (xterm, native <select>, daisyUI .tab and [data-scroll] boxes, which scroll on purpose, are exempt)
const mainOverflow = (page, withTab) =>
  page.evaluate((withTab) => {
    const m = document.querySelector('main')
    const out = []
    if (m.scrollWidth > m.clientWidth) out.push(`main scrollWidth ${m.scrollWidth} > ${m.clientWidth}`)
    const mr = m.getBoundingClientRect()
    const isBox = (el) => /flex|grid/.test(getComputedStyle(el).display)
    for (const el of m.querySelectorAll('*')) {
      if (getComputedStyle(el).visibility === 'hidden' || !el.clientWidth) continue
      const r = el.getBoundingClientRect()
      if (r.right > mr.right + 0.5) out.push(`${el.tagName} right ${Math.round(r.right)} > ${Math.round(mr.right)}`)
      if (el.closest('.xterm, [data-scroll]') || el.tagName === 'SELECT' || el.classList.contains('tab')) continue // exempt: xterm's own scrolling viewport; native <select> (scrollWidth = option width); daisyUI .tab (tabs-lift corner pseudo-elements stick out ~8px, children are still checked against main's box)
      const cs = getComputedStyle(el)
      if (el.scrollWidth > el.clientWidth + 1 && (cs.textOverflow !== 'ellipsis' || isBox(el))) out.push(`overflow ${el.tagName}.${String(el.className).slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`)
    }
    // account-label badges: the text keeps its start and ends in a real ellipsis
    const badges = m.querySelectorAll('.badge.max-w-28, .badge.max-w-40')
    if (withTab && badges.length !== 2) out.push(`expected 2 account-label badges (tab bar + header strip), found ${badges.length}`)
    for (const b of badges) {
      const sp = b.querySelector('span.truncate')
      if (!sp) { out.push(`badge without inner truncate span: ${b.textContent}`); continue }
      const cs = getComputedStyle(sp), bs = getComputedStyle(b)
      const inner = b.getBoundingClientRect().left + parseFloat(bs.paddingLeft) + parseFloat(bs.borderLeftWidth)
      if (cs.textOverflow !== 'ellipsis' || isBox(sp)) out.push(`badge span not ellipsising: ${b.textContent}`)
      if (sp.getBoundingClientRect().left < inner - 0.5) out.push(`badge text clipped on the left: ${b.textContent}`)
      if (sp.scrollWidth <= sp.clientWidth) out.push(`badge label not long enough to truncate: ${b.textContent}`)
    }
    return out
  }, !!withTab)

// ---- scenario 1: claude present, candidate dirs, onboarding -> dashboard ----
{
  const d = setup('one')
  copyFileSync(stub, join(d.bin, 'claude'))
  mkdirSync(join(d.home, '.claude')) // default install: its config is ~/.claude.json
  writeFileSync(join(d.home, '.claude.json'), '{}')
  mkdirSync(join(d.home, '.claude-foo')) // no .claude.json: must NOT be probed (the CLI would write into it)
  const proj = join(d.home, 'demo-app')
  mkdirSync(proj)
  const app = await launch(d)
  try {
    await app.evaluate(({ dialog }, dir) => void (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })), proj)
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.getByText('Bienvenido a Relay').waitFor({ timeout: t })
    await page.getByTestId('logo').first().waitFor({ timeout: t }) // logo in the onboarding header
    await page.getByText('instalado · 2.1.0').waitFor({ timeout: t })
    await page.getByText('Instalación por defecto · test@example.com').waitFor({ timeout: t })
    await page.getByText('sin comprobar').waitFor({ timeout: t })
    await page.screenshot({ path: join(shots, 'onboarding.png') })

    await page.getByRole('button', { name: 'Iniciar sesión con una cuenta nueva' }).click()
    const dlg = page.getByRole('dialog', { name: 'Nombre de la cuenta' })
    await dlg.getByRole('textbox').fill('Test')
    await dlg.getByRole('textbox').press('Enter')
    // login panel: instructions, code box, real CLI output behind "Ver terminal"
    const code = page.getByPlaceholder('Pega aquí el código')
    await code.waitFor({ timeout: t })
    await page.getByText('Se abrirá tu navegador').waitFor({ timeout: t })
    await page.getByLabel('Ver terminal').check()
    await page.waitForTimeout(2000) // the CLI prints after 1s; xterm draws on a canvas, so the text is checked in the screenshot
    await page.locator('.xterm').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'login.png') })
    await code.fill('abc-123')
    await page.getByRole('button', { name: 'Enviar código' }).click()
    await page.getByText('Sesión iniciada', { exact: true }).waitFor({ timeout: t }) // login pty exited, status refreshed
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await page.getByText('Agrega un proyecto').waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Elegir carpeta…' }).click()
    await page.getByText(proj).waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()

    const card = page.getByTestId('account-card')
    await card.getByText('Test', { exact: true }).waitFor({ timeout: t })
    await card.getByTestId('card-status').getByText('test@example.com').waitFor({ timeout: t }) // compact card: the status text carries the email
    await page.locator('aside').getByTestId('logo').waitFor({ timeout: t }) // logo in the sidebar header
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    await page.getByRole('tab').first().waitFor({ timeout: t })
    await page.getByText('activa', { exact: true }).waitFor({ timeout: t })
    await page.waitForTimeout(2000)
    await page.screenshot({ path: join(shots, 'dashboard.png') })
    assert.ok(existsSync(join(d.relayHome, 'accounts.json')), 'account stored under RELAY_HOME')

    await page.getByRole('button', { name: 'Configuración' }).click()
    const settings = page.getByRole('dialog', { name: 'Configuración' })
    await settings.getByRole('heading', { name: 'Cuentas' }).waitFor({ timeout: t })
    await page.waitForTimeout(600) // modal open transition
    await page.screenshot({ path: join(shots, 'settings.png') })
    await settings.getByRole('button', { name: 'Cambio de cuenta' }).click()
    const msg = settings.getByLabel('Mensaje inicial')
    await msg.fill('Sigue con la tarea.')
    await settings.getByRole('button', { name: 'Guardar' }).click()
    await settings.getByText('Guardado').waitFor({ timeout: t })
    assert.equal(JSON.parse(readFileSync(join(d.relayHome, 'prefs.json'), 'utf8')).handoff.message, 'Sigue con la tarea.')
    await msg.fill('--evil')
    await settings.getByRole('button', { name: 'Guardar' }).click()
    await settings.getByText(/Mensaje inválido/).waitFor({ timeout: t })
    await page.keyboard.press('Escape') // native dialog closes on ESC
    await settings.waitFor({ state: 'hidden', timeout: t })
    await card.waitFor({ timeout: t })

    await page.getByRole('button', { name: 'Opciones de cuenta' }).click()
    await page.getByRole('menuitem', { name: 'Renombrar' }).click()
    const ren = page.getByRole('dialog', { name: 'Renombrar cuenta' })
    await ren.getByRole('textbox').fill('Renamed')
    await ren.getByRole('textbox').press('Enter')
    await card.getByText('Renamed', { exact: true }).waitFor({ timeout: t })
  } finally {
    await app.close()
  }
  assert.deepEqual(readdirSync(join(d.home, '.claude-foo')), [], 'unimported candidate dir must stay untouched')
  const calls = readFileSync(log, 'utf8').split('\n')
  assert.ok(calls.includes('CODE:abc-123'), 'the pasted login code reached the login pty')
  assert.ok(calls.includes('UNSET|auth status --json'), 'default install probed without CLAUDE_CONFIG_DIR')
  assert.ok(!calls.some((c) => c.startsWith(join(d.home, '.claude-foo'))), 'claude never ran against the candidate dir')
}

// ---- scenario 2: claude missing -> installer visible in onboarding (test installer script, never the real one) ----
{
  const d = setup('two')
  const app = await launch(d, { RELAY_E2E_INSTALL_SCRIPT: `echo installing; cp "${stub}" "${d.bin}/claude"; chmod +x "${d.bin}/claude"; sleep 1` })
  try {
    await app.evaluate(({ dialog }) => void (dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })))
    const page = await app.firstWindow()
    await page.getByText('no instalado', { exact: true }).waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Instalar Claude Code' }).click()
    await page.locator('.xterm').first().waitFor({ timeout: t }) // install pane visible inside onboarding
    await page.getByText('instalado · 2.1.0').waitFor({ timeout: t }) // re-detected after the installer exited
  } finally {
    await app.close()
  }
}
// ---- scenario 3: limit modal never acts on a stray key; handoff from the tab bar + auto-continue wiring ----
{
  const d = setup('three')
  copyFileSync(stub, join(d.bin, 'claude'))
  const proj = join(d.home, 'demo-app')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  const cfg = { a: join(d.home, 'cfg-a'), b: join(d.home, 'cfg-b') }
  for (const c of Object.values(cfg)) {
    mkdirSync(c)
    writeFileSync(join(c, '.claude.json'), '{}') // imported dirs that were used before: Relay only asks the CLI about those
  }
  mkdirSync(d.relayHome, { recursive: true })
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  writeFileSync(
    join(d.relayHome, 'accounts.json'),
    JSON.stringify([
      { id: 'aaaaaaaa', label: 'Alfa', provider: 'claude', configDir: cfg.a },
      { id: 'bbbbbbbb', label: 'Beta', provider: 'claude', configDir: cfg.b }
    ])
  )
  const calls = () => readFileSync(log, 'utf8').split('\n')
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const v = fn()
      if (v) return v
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.fail('timeout waiting for the stub log')
  }
  const app = await launch(d)
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.getByTestId('account-card').first().waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    await page.getByRole('tab').first().waitFor({ timeout: t })
    const id = (await until(() => calls().map((c) => c.startsWith(`${cfg.a}|`) ? /--session-id (\S+)/.exec(c)?.[1] : undefined).find(Boolean)))
    const transcript = join(cfg.a, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hola' } }) + '\n')
    await page.waitForTimeout(1500) // the limit watcher is on the file
    appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 2 * 864e5).toISOString(), // reset already passed, so Alfa stays a valid target for the second hop
      isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 1:10am (UTC)" }] } }) + '\n')
    const limit = page.getByRole('dialog', { name: 'Límite alcanzado' })
    await limit.waitFor({ timeout: t })
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cerrar', 'the limit modal opens on its safe button')
    await page.keyboard.press('Enter') // a stray key while typing in the terminal
    await limit.waitFor({ state: 'hidden', timeout: t })
    await page.waitForTimeout(1000)
    assert.ok(!calls().some((c) => c.includes('--resume')), 'a stray Enter must not start a handoff')

    // handoff from the tab bar: the confirm focuses Cancelar; the explicit click on the confirm button switches
    const pick = async (to) => {
      await page.getByRole('button', { name: 'Continuar esta sesión en otra cuenta' }).click()
      await page.getByRole('menuitem', { name: to }).click()
      const ask = page.getByRole('dialog', { name: 'Continuar en otra cuenta' })
      await ask.waitFor({ timeout: t })
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancelar', 'the switch confirm opens on Cancelar')
      await ask.getByRole('button', { name: `Continuar en ${to}` }).click()
    }
    await pick('Beta')
    await until(() => calls().includes(`${cfg.b}|--resume ${id} Continúa exactamente donde lo dejaste.`))
    await page.getByRole('button', { name: 'Configuración' }).click()
    const settings = page.getByRole('dialog', { name: 'Configuración' })
    await settings.getByRole('button', { name: 'Cambio de cuenta' }).click()
    await settings.getByLabel('Continuar automáticamente tras el cambio').click()
    await settings.getByText('Guardado').waitFor({ timeout: t })
    assert.equal(JSON.parse(readFileSync(join(d.relayHome, 'prefs.json'), 'utf8')).handoff.autoContinue, false)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden', timeout: t })
    await pick('Alfa')
    await until(() => calls().includes(`${cfg.a}|--resume ${id}`))
    assert.ok(!calls().some((c) => c.startsWith(`${cfg.a}|--resume ${id} `)), 'no message with auto-continue off')
  } finally {
    await app.close()
  }
}
// ---- scenario 4: Codex accounts: listing, add + login from the UI, shared AGENTS.md, handoff between Codex accounts, toast usable over a dialog ----
{
  const d = setup('four')
  copyFileSync(stub, join(d.bin, 'claude'))
  copyFileSync(cstub, join(d.bin, 'codex'))
  const proj = join(d.home, 'demo-app')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  const cx = { a: join(d.home, 'cx-a'), b: join(d.home, 'cx-b') }
  const ID = '01a17ead-fb85-70f3-a4bb-fc55b4d89fa9'
  const now = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const rel = join('sessions', String(now.getFullYear()), p2(now.getMonth() + 1), p2(now.getDate()), `rollout-${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}-00-00-${ID}.jsonl`)
  mkdirSync(dirname(join(cx.a, rel)), { recursive: true })
  mkdirSync(cx.b, { recursive: true })
  writeFileSync(join(cx.b, 'config.toml'), '') // an imported Codex home is only probed once it has config.toml / sessions
  const ts = now.toISOString()
  writeFileSync(
    join(cx.a, rel),
    JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: ID, cwd, originator: 'codex-tui', source: 'vscode', thread_source: 'user' } }) + '\n' +
      JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'hola codex' }] } } }) + '\n'
  )
  mkdirSync(d.relayHome, { recursive: true })
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  // the sidebar lists only sessions Relay knows: this one is "started from Relay"
  writeFileSync(join(d.relayHome, 'sessions.json'), JSON.stringify([{ provider: 'codex', accountId: 'dddddddd', sessionId: ID, cwd, createdAt: 1, lastActiveAt: 1, origin: 'new', handoffs: [] }]))
  writeFileSync(
    join(d.relayHome, 'accounts.json'),
    JSON.stringify([
      { id: 'cccccccc', label: 'Alfa', provider: 'claude', configDir: join(d.home, 'cfg-claude'), sharedMemory: false },
      { id: 'dddddddd', label: 'Cx1', provider: 'codex', configDir: cx.a, sharedMemory: false },
      { id: 'eeeeeeee', label: 'Cx2', provider: 'codex', configDir: cx.b, sharedMemory: false }
    ])
  )
  mkdirSync(join(d.home, 'cfg-claude'))
  const calls = () => (existsSync(clog) ? readFileSync(clog, 'utf8').split('\n') : [])
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const v = fn()
      if (v) return v
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.fail('timeout waiting for the codex stub log')
  }
  const app = await launch(d)
  try {
    await app.evaluate(({ dialog }) => void (dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })))
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    const cards = page.getByTestId('account-card')
    await cards.nth(2).waitFor({ timeout: t })
    assert.equal(await cards.locator('[data-testid=provider-badge][data-provider=codex]:visible').count(), 2, 'Codex accounts show a visible provider badge')
    assert.equal(await cards.locator('[data-testid=provider-badge][data-provider=claude]:visible').count(), 1, 'Claude accounts show a visible provider badge')
    assert.equal(await cards.getByTestId('provider-badge').first().getAttribute('title'), 'Claude Code')
    await cards.filter({ hasText: 'Cx1' }).getByTestId('card-status').getByText('sesión iniciada').waitFor({ timeout: t }) // `codex login status` exit 0
    await page.getByRole('button', { name: 'hola codex' }).first().waitFor({ timeout: t }) // session listed from the rollout (title = first user message)
    await page.screenshot({ path: join(shots, 'codex.png') })

    // a toast raised while a modal dialog is open must stay usable (its close button is clickable)
    await page.getByRole('button', { name: 'Configuración' }).click()
    const settings = page.getByRole('dialog', { name: 'Configuración' })
    await settings.getByRole('heading', { name: 'Cuentas' }).waitFor({ timeout: t })
    const card1 = settings.locator('.card-body').filter({ hasText: 'Cx1' }).filter({ hasText: 'Memoria compartida' }).last()
    await card1.getByRole('checkbox').click() // imported dir: main-side consent (stubbed to "Activar")
    const toast = page.getByRole('alert').filter({ hasText: 'Memoria compartida · Cx1' })
    await toast.waitFor({ timeout: t })
    assert.ok(lstatSync(join(cx.a, 'AGENTS.md')).isSymbolicLink(), 'Codex shared memory links AGENTS.md')
    assert.ok(!existsSync(join(cx.a, 'CLAUDE.md')) && !existsSync(join(cx.a, 'skills')), 'only AGENTS.md is linked for Codex')
    await toast.getByRole('button', { name: 'Cerrar aviso' }).click({ timeout: 5000 })
    await toast.waitFor({ state: 'hidden', timeout: t })
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden', timeout: t })

    // add a Codex account from the UI: provider choice, managed dir as CODEX_HOME, official `codex login` in a tab
    await page.getByRole('button', { name: 'Agregar cuenta' }).click()
    const dlg = page.getByRole('dialog', { name: 'Nombre de la cuenta' })
    await dlg.getByLabel('Proveedor').selectOption('codex')
    await dlg.getByRole('textbox').fill('Nuevo')
    await dlg.getByRole('textbox').press('Enter')
    await page.getByText('Autoriza el acceso y vuelve aquí (se detecta solo)').waitFor({ timeout: t })
    assert.equal(await page.getByPlaceholder('Pega aquí el código').count(), 0, 'Codex login has no code box')
    const accounts = JSON.parse(readFileSync(join(d.relayHome, 'accounts.json'), 'utf8'))
    const nuevo = accounts.find((a) => a.label === 'Nuevo')
    assert.equal(nuevo.provider, 'codex')
    assert.equal(nuevo.configDir, join(d.relayHome, 'accounts', nuevo.id))
    await until(() => calls().includes(`${nuevo.configDir}|login`))
    await page.getByText('Sesión iniciada', { exact: true }).waitFor({ timeout: t }) // login pty exited, `codex login status` exit 0
    assert.ok(lstatSync(join(nuevo.configDir, 'AGENTS.md')).isSymbolicLink(), 'managed Codex account gets the shared AGENTS.md')
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click()

    // resume the listed session on Cx1, then hand it off to Cx2 (same provider) with the auto-continue prompt
    await page.getByRole('button', { name: 'hola codex' }).first().click()
    await until(() => calls().includes(`${cx.a}|resume ${ID}`))
    await page.getByRole('button', { name: 'Continuar esta sesión en otra cuenta' }).click()
    assert.ok(await page.getByRole('menuitem', { name: 'Claude ↔ Codex llegará después del MVP' }).isDisabled(), 'cross-provider handoff stays disabled')
    await page.getByRole('menuitem', { name: 'Cx2', exact: true }).click()
    const ask = page.getByRole('dialog', { name: 'Continuar en otra cuenta' })
    await ask.waitFor({ timeout: t })
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancelar', 'the switch confirm opens on Cancelar')
    await ask.getByRole('button', { name: 'Continuar en Cx2' }).click()
    await until(() => calls().includes(`${cx.b}|resume ${ID} Continúa exactamente donde lo dejaste.`))
    assert.equal(readFileSync(join(cx.b, rel), 'utf8'), readFileSync(join(cx.a, rel), 'utf8'), 'rollout copied to the same relative path in the target')
    assert.ok(existsSync(join(d.relayHome, 'copies.json')), 'copy recorded')
    const reg = JSON.parse(readFileSync(join(d.relayHome, 'sessions.json'), 'utf8'))
    assert.deepEqual(reg[0].handoffs.map((h) => [h.from, h.to]), [['dddddddd', 'eeeeeeee']], 'handoff recorded in the registry')
    assert.equal(reg[0].accountId, 'eeeeeeee')
  } finally {
    await app.close()
  }
  assert.ok(!calls().some((c) => c.startsWith('UNSET|') && c !== 'UNSET|--version'), 'every Codex call except the version check carries CODEX_HOME')
}
// ---- scenario 5: onboarding offers ~/.codex* dirs; importing one creates a CODEX account and writes no Claude file into it ----
{
  const d = setup('five')
  copyFileSync(stub, join(d.bin, 'claude'))
  copyFileSync(cstub, join(d.bin, 'codex'))
  mkdirSync(join(d.home, '.codex'))
  writeFileSync(join(d.home, '.codex', 'config.toml'), '# user config\n') // has config.toml: may be probed with `codex login status`
  mkdirSync(join(d.home, '.codex-bare')) // nothing in it: must not be probed
  const app = await launch(d)
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.getByText('Bienvenido a Relay').waitFor({ timeout: t })
    const row = (dir) => page.locator('div.lift').filter({ has: page.getByText(dir, { exact: true }) })
    await row(join(d.home, '.codex-bare')).getByText('sin comprobar').waitFor({ timeout: t })
    await row(join(d.home, '.codex')).getByText('Codex ·').waitFor({ timeout: t })
    await row(join(d.home, '.codex')).getByRole('button', { name: 'Importar' }).click()
    const dlg = page.getByRole('dialog', { name: 'Nombre de la cuenta' })
    assert.equal(await dlg.getByLabel('Proveedor').inputValue(), 'codex', 'the dialog guesses Codex from the dir name')
    await dlg.getByRole('textbox').press('Enter')
    await page.getByText('Sesión iniciada', { exact: true }).waitFor({ timeout: t }) // `codex login status` exit 0
    const acc = JSON.parse(readFileSync(join(d.relayHome, 'accounts.json'), 'utf8'))
    assert.equal(acc.length, 1)
    assert.equal(acc[0].provider, 'codex')
    assert.equal(acc[0].configDir, join(d.home, '.codex'))
  } finally {
    await app.close()
  }
  assert.deepEqual(readdirSync(join(d.home, '.codex')), ['config.toml'], 'no Claude files (.claude.json, lock, backups) in the imported Codex dir')
  assert.deepEqual(readdirSync(join(d.home, '.codex-bare')), [], 'unimported Codex candidate stays untouched')
  assert.ok(!readFileSync(log, 'utf8').includes(d.home), 'claude never ran against the Codex dirs (nor anything else in this HOME)')
}
// ---- scenario 6: official usage bars (status line through --settings), warning, 100% = limited, Consumo prefs; project history = registry only, adopt, forget ----
{
  const d = setup('six')
  copyFileSync(stub, join(d.bin, 'claude'))
  const proj = join(d.home, 'demo-app')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  const cfg = { a: join(d.home, 'cfg-a'), b: join(d.home, 'cfg-b') }
  for (const c of Object.values(cfg)) {
    mkdirSync(c)
    writeFileSync(join(c, '.claude.json'), '{}')
  }
  const userSettings = JSON.stringify({ statusLine: { type: 'command', command: "printf 'USERLINE'" } }) // Alfa has its own status line: Relay must chain it, not touch the file
  writeFileSync(join(cfg.a, 'settings.json'), userSettings)
  mkdirSync(d.relayHome, { recursive: true })
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  writeFileSync(
    join(d.relayHome, 'accounts.json'),
    JSON.stringify([
      { id: 'aaaaaaaa', label: 'Alfa', provider: 'claude', configDir: cfg.a, sharedMemory: false },
      { id: 'bbbbbbbb', label: 'Beta', provider: 'claude', configDir: cfg.b, sharedMemory: false }
    ])
  )
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const OLD = '0d0d0d0d-aaaa-bbbb-cccc-111111111111'
  const transcript = (cfgDir, id, text) => {
    const f = join(cfgDir, 'projects', enc, `${id}.jsonl`)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    return f
  }
  const oldFile = transcript(cfg.b, OLD, 'sesión vieja') // exists before Relay ever ran: not in the history
  const fixture = join(tmp, 'status-fixture.json')
  const status = (five, seven) => {
    const at = Math.floor(Date.now() / 1000)
    writeFileSync(fixture, JSON.stringify({ session_id: 'x', model: { display_name: 'm' }, rate_limits: { five_hour: { used_percentage: five, resets_at: at + 3 * 3600 }, seven_day: { used_percentage: seven, resets_at: at + 3 * 86400 } } }))
  }
  status(48, 31)
  const calls = () => readFileSync(log, 'utf8').split('\n')
  const mine = () => (existsSync(settingsLog) ? readFileSync(settingsLog, 'utf8').trim().split('\n').filter((l) => l.includes(d.relayHome)) : []) // the stub logs are shared by all scenarios
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const v = fn()
      if (v) return v
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.fail('timeout waiting for the stub')
  }
  const app = await launch(d, { STUB_FIXTURE: fixture })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    const cards = page.getByTestId('account-card')
    await cards.nth(1).waitFor({ timeout: t })
    const alfa = cards.filter({ hasText: 'Alfa' })
    const beta = cards.filter({ hasText: 'Beta' })
    const side = page.locator('aside')
    const inside = (state) => sidebarFits(page, state)
    assert.equal(await side.getByRole('button', { name: /sesión vieja/ }).count(), 0, 'a transcript Relay did not create is not in the sidebar')
    // cards are compact by default: no detail rows, the section is not collapsed
    for (const c of [alfa, beta]) {
      assert.equal(await c.getAttribute('data-expanded'), 'false', 'compact by default')
      assert.equal(await c.getByTestId('card-details').isVisible(), false)
    }
    assert.equal(await page.getByTestId('account-dots').count(), 0)

    // clicking a card body only selects it (no toggle): a card expands with its chevron
    await alfa.click()
    assert.equal(await alfa.getAttribute('data-expanded'), 'false')
    await inside('compact, no usage')
    // new sessions: one per account, started with Relay's status line (--settings) and the env that locates the status file
    await alfa.click()
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    await until(() => calls().some((c) => c.startsWith(`${cfg.a}|--session-id `)))
    await beta.click()
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    await until(() => calls().some((c) => c.startsWith(`${cfg.b}|--session-id `)))
    const sets = (await until(() => (mine().length >= 2 ? mine() : null))).map((l) => JSON.parse(l))
    for (const x of sets) {
      assert.equal(x.statusLine.type, 'command')
      assert.ok(x.statusLine.command.includes(join(d.relayHome, 'bin', 'statusline.sh')))
    }
    const envs = readFileSync(envLog, 'utf8').trim().split('\n')
    assert.ok(envs.includes(`${join(d.relayHome, 'status', 'aaaaaaaa.json')}|printf 'USERLINE'`), 'the user status line is passed to chain')
    assert.ok(envs.includes(`${join(d.relayHome, 'status', 'bbbbbbbb.json')}|UNSET`), 'no user status line: nothing to chain')
    assert.equal(readFileSync(join(cfg.a, 'settings.json'), 'utf8'), userSettings, 'user settings are read-only')
    assert.ok(!existsSync(join(cfg.b, 'settings.json')), 'no settings file is created in the account dir')

    // official usage bars (cards expanded with their chevrons)
    await alfa.getByTestId('card-toggle').click()
    await beta.getByTestId('card-toggle').click()
    const bars = alfa.getByTestId('usage-5h')
    await bars.getByText('48%').waitFor({ timeout: t })
    await bars.getByText('Sesión 5h').waitFor({ timeout: t })
    await bars.getByText(/se reinicia .* · actualizado hace|se reinicia .* · actualizado ahora/).waitFor({ timeout: t })
    await alfa.getByTestId('usage-7d').getByText('31%').waitFor({ timeout: t })
    await beta.getByTestId('usage-5h').getByText('48%').waitFor({ timeout: t })
    assert.match(await bars.locator('progress').getAttribute('class'), /progress-success/)
    assert.equal(readFileSync(join(d.relayHome, 'status', 'aaaaaaaa.json'), 'utf8'), readFileSync(fixture, 'utf8'), 'the script saved the CLI JSON')
    assert.equal(readFileSync(join(tmp, 'statusline-out.cfg-a'), 'utf8'), 'USERLINE', 'chained: the user status line output is what the CLI shows')
    assert.equal(readFileSync(join(tmp, 'statusline-out.cfg-b'), 'utf8'), '5h 48% · 7d 31%', 'default compact line')
    // expanded: the detail rows are visible, the compact line is replaced
    assert.equal(await alfa.getAttribute('data-expanded'), 'true')
    assert.equal(await alfa.getByTestId('mini-5h').count(), 0)
    await page.screenshot({ path: join(shots, 'usage.png') })
    await page.waitForTimeout(500)
    await inside('expanded')
    await side.screenshot({ path: join(shots, 'sidebar-expanded.png') })
    // collapse with the toggle: two thin bars with the percentages, details hidden
    await alfa.getByTestId('card-toggle').click()
    await beta.getByTestId('card-toggle').click()
    const mini = alfa.getByTestId('mini-5h')
    await mini.getByText('48%').waitFor({ timeout: t })
    await alfa.getByTestId('mini-7d').getByText('31%').waitFor({ timeout: t })
    await bars.waitFor({ state: 'hidden', timeout: t })
    assert.equal(await alfa.getAttribute('data-expanded'), 'false')
    assert.match(await alfa.getByTestId('usage-mini').getAttribute('data-tip'), /Sesión 5h 48% · se reinicia .* · actualizado/, 'reset times are in the tooltip')
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500) // collapse transition
    await inside('compact')
    await side.screenshot({ path: join(shots, 'sidebar-compact.png') })
    await alfa.getByTestId('card-toggle').click() // expanded again for the checks below
    await bars.waitFor({ timeout: t })

    // 92% crosses the 90% threshold: one warning per window
    status(92, 31)
    await page.getByRole('alert').filter({ hasText: /Alfa lleva 92% de su sesión de 5h · se reinicia/ }).first().waitFor({ timeout: t })
    await bars.getByText('92%').waitFor({ timeout: t })
    assert.match(await bars.locator('progress').getAttribute('class'), /progress-error/)
    // 100% = limited (same state as a transcript limit: the card says so and the account is no handoff target)
    status(100, 31)
    await alfa.getByText(/Limitada hasta/).waitFor({ timeout: t })
    // a limited account stands out even when compact: error colour on the dot and the bar
    await alfa.getByTestId('card-toggle').click()
    assert.match(await alfa.getByTestId('mini-5h').locator('progress').getAttribute('class'), /progress-error/)
    assert.equal(await alfa.locator('.status-error').count(), 1, 'the dot of a limited account is red')

    // history: the new sessions show up once they have a transcript; the old one only after adopting it
    const idA = /--session-id (\S+)/.exec(calls().find((c) => c.startsWith(`${cfg.a}|--session-id `)))[1]
    transcript(cfg.a, idA, 'hola nueva')
    await side.getByRole('button', { name: /hola nueva/ }).waitFor({ timeout: t }) // sidebar re-lists while tabs are open
    assert.equal(await side.getByRole('button', { name: /sesión vieja/ }).count(), 0)
    await side.getByRole('button', { name: 'Opciones de proyecto' }).click()
    await page.getByRole('menuitem', { name: 'Abrir sesión existente…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Abrir sesión existente' })
    await dlg.getByRole('button', { name: /sesión vieja/ }).waitFor({ timeout: t })
    assert.equal(await dlg.getByRole('button', { name: /hola nueva/ }).count(), 0, 'sessions already in the history are not offered')
    await dlg.getByRole('button', { name: /sesión vieja/ }).click()
    await until(() => calls().includes(`${cfg.b}|--resume ${OLD}`))
    await side.getByRole('button', { name: /sesión vieja/ }).waitFor({ timeout: t })
    const reg = JSON.parse(readFileSync(join(d.relayHome, 'sessions.json'), 'utf8'))
    assert.deepEqual(reg.map((e) => e.origin).sort(), ['adopt', 'new', 'new'])
    // forget: registry entry only
    await side.getByRole('listitem').filter({ hasText: 'sesión vieja' }).last().getByRole('button', { name: 'Opciones de sesión' }).click()
    await page.getByRole('menuitem', { name: 'Quitar del historial de Relay' }).click()
    const ask = page.getByRole('dialog', { name: 'Quitar del historial de Relay' })
    await ask.waitFor({ timeout: t })
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancelar', 'the confirm opens on Cancelar')
    await ask.getByRole('button', { name: 'Quitar' }).click()
    await side.getByRole('button', { name: /sesión vieja/ }).waitFor({ state: 'hidden', timeout: t })
    assert.ok(existsSync(oldFile), 'the transcript is never deleted')
    assert.ok(!JSON.parse(readFileSync(join(d.relayHome, 'sessions.json'), 'utf8')).some((e) => e.sessionId === OLD))

    // Consumo settings: validation, and with the toggle off new sessions start without --settings
    await page.getByRole('button', { name: 'Configuración' }).click()
    const settings = page.getByRole('dialog', { name: 'Configuración' })
    await settings.getByRole('button', { name: 'Consumo' }).click()
    await settings.getByLabel('Umbral de aviso').fill('120')
    await settings.getByRole('button', { name: 'Guardar' }).click()
    await settings.getByText(/Umbral inválido/).waitFor({ timeout: t })
    await settings.getByLabel('Umbral de aviso').fill('80')
    await settings.getByRole('button', { name: 'Guardar' }).click()
    await settings.getByText('Guardado').waitFor({ timeout: t })
    await settings.getByLabel('Mostrar el consumo oficial de las cuentas Claude').click()
    await until(() => JSON.parse(readFileSync(join(d.relayHome, 'prefs.json'), 'utf8')).usage.statusLine === false)
    assert.equal(JSON.parse(readFileSync(join(d.relayHome, 'prefs.json'), 'utf8')).usage.warnAt, 80)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden', timeout: t })
    await until(() => mine().length >= 3) // alfa, beta and the adopted session (the stub logs a second after it starts)
    const before = mine().length
    const n = calls().filter((c) => c.includes('--session-id')).length
    await alfa.click()
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    await until(() => calls().filter((c) => c.includes('--session-id')).length > n)
    await page.waitForTimeout(1500)
    assert.equal(mine().length, before, 'statusLine off: no --settings')

    // collapsing "Cuentas" leaves one dot per account (tooltip: label + usage); the UI state survives a reload
    for (const [c, want] of [[alfa, 'false'], [beta, 'true']]) if ((await c.getAttribute('data-expanded')) !== want) await c.getByTestId('card-toggle').click() // beta expanded, alfa compact
    await page.getByRole('button', { name: 'Contraer Cuentas' }).click()
    const dots = page.getByTestId('account-dot')
    await dots.nth(1).waitFor({ timeout: t })
    assert.equal(await dots.count(), 2)
    await alfa.waitFor({ state: 'hidden', timeout: t })
    assert.match(await dots.first().getAttribute('aria-label'), /^Alfa/)
    assert.match(await dots.first().getAttribute('aria-label'), /5h 100%/)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    await inside('collapsed')
    await side.screenshot({ path: join(shots, 'sidebar-collapsed.png') })
    // minimum window width, hovering a dot (its tooltip opens inward)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
    await page.waitForTimeout(500)
    await dots.last().hover()
    await page.waitForTimeout(300)
    await inside('collapsed, 900px window')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.reload()
    await page.getByTestId('account-dot').nth(1).waitFor({ timeout: t })
    assert.equal(await cards.first().isVisible(), false, 'collapsed state survives a reload')
    await page.getByRole('button', { name: 'Expandir Cuentas' }).click()
    await cards.nth(1).waitFor({ timeout: t })
    await page.reload()
    await cards.nth(1).waitFor({ timeout: t })
    assert.equal(await page.getByTestId('account-dots').count(), 0)
    assert.equal(await alfa.getAttribute('data-expanded'), 'false', 'expanded cards survive a reload')
    assert.equal(await beta.getAttribute('data-expanded'), 'true')
    // "Proyectos" collapses the same way
    await page.getByRole('button', { name: 'Contraer Proyectos' }).click()
    await page.getByTestId('project-dots').waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Expandir Proyectos' }).click()
    await page.getByTestId('project-dots').waitFor({ state: 'detached', timeout: t })
  } finally {
    await app.close()
  }
}
// ---- scenario 8: real-data sidebar (long labels / email / reset text / session title never push anything out of the sidebar) ----
{
  const d = setup('eight')
  copyFileSync(stub, join(d.bin, 'claude'))
  copyFileSync(cstub, join(d.bin, 'codex'))
  const proj = join(d.home, 'freelancer-voicecall-with-a-long-folder-name')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  mkdirSync(d.relayHome, { recursive: true })
  const personal = join(d.relayHome, 'accounts', 'p1p1p1p1')
  const codexDir = join(d.relayHome, 'accounts', 'c1c1c1c1')
  const mailo = join(d.home, '.claude-mailo') // imported, never used by the CLI: "sin comprobar"
  for (const x of [personal, codexDir, mailo]) mkdirSync(x, { recursive: true })
  writeFileSync(join(personal, '.claude.json'), '{}')
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  writeFileSync(
    join(d.relayHome, 'accounts.json'),
    JSON.stringify([
      { id: 'p1p1p1p1', label: 'Personal CarlosDev con una etiqueta de cuenta muy larga', provider: 'claude', configDir: personal, sharedMemory: true },
      { id: 'm1m1m1m1', label: 'Mailo', provider: 'claude', configDir: mailo, sharedMemory: false },
      { id: 'c1c1c1c1', label: 'Codex', provider: 'codex', configDir: codexDir, sharedMemory: true }
    ])
  )
  // Personal is limited (transcript rate_limit line) and has a long email; one registered session with a ~120 char title
  const SID = '0e0e0e0e-aaaa-bbbb-cccc-222222222222'
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const f = join(personal, 'projects', enc, `${SID}.jsonl`)
  mkdirSync(dirname(f), { recursive: true })
  const title = 'Refactoriza el módulo de llamadas de voz para que soporte reconexión automática y revisa también los tests de integración pendientes'
  writeFileSync(
    f,
    JSON.stringify({ type: 'user', message: { role: 'user', content: title } }) + '\n' +
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 1:10am (America/Bogota)" }] } }) + '\n'
  )
  // a second session whose title is one unbroken 160 char token (main caps titles at 120): must truncate in the sidebar and in the main empty state
  const SID2 = '0e0e0e0e-aaaa-bbbb-cccc-333333333333'
  const LONG = 'x'.repeat(160)
  writeFileSync(join(personal, 'projects', enc, `${SID2}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: LONG } }) + '\n')
  writeFileSync(join(d.relayHome, 'sessions.json'), JSON.stringify([{ provider: 'claude', accountId: 'p1p1p1p1', sessionId: SID2, cwd, createdAt: Date.now(), lastActiveAt: Date.now(), origin: 'new', handoffs: [] }, { provider: 'claude', accountId: 'p1p1p1p1', sessionId: SID, cwd, createdAt: Date.now(), lastActiveAt: Date.now(), origin: 'new', handoffs: [{ from: 'm1m1m1m1', to: 'p1p1p1p1', at: Date.now() }] }]))
  const app = await launch(d, { STUB_EMAIL: 'relay-user+long@example.com' })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    const cards = page.getByTestId('account-card')
    await cards.nth(2).waitFor({ timeout: t })
    const side = page.locator('aside')
    await side.getByRole('button', { name: /Refactoriza el módulo/ }).waitFor({ timeout: t })
    await page.getByTestId('card-status').filter({ hasText: /Limitada hasta/ }).waitFor({ timeout: t })
    await cards.first().getByText('sin comprobar').or(cards.nth(1).getByText('sin comprobar')).first().waitFor({ timeout: t })
    const mainFits = async (size, withTab) => {
      const what = withTab ? 'tab open' : 'empty state'
      await (withTab ? page.getByRole('tab').first() : page.getByRole('button', { name: /^x{100}/ }).last()).waitFor({ timeout: t })
      const bad = await mainOverflow(page, withTab)
      assert.deepEqual(bad, [], `main content overflows with an unbroken session title / long label (${size[0]}px, ${what})`)
    }
    const states = async (size) => {
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), size)
      await page.waitForTimeout(400)
      await mainFits(size)
      await page.getByRole('button', { name: /^x{100}/ }).last().click() // open the long-title session in a tab
      await mainFits(size, true)
      await page.getByRole('button', { name: 'Cerrar pestaña', exact: true }).last().click()
      await sidebarFits(page, `real data, ${size[0]}px, compact`)
      for (let i = 0; i < 3; i++) if ((await cards.nth(i).getAttribute('data-expanded')) !== 'true') await cards.nth(i).getByTestId('card-toggle').click()
      await page.waitForTimeout(500)
      await sidebarFits(page, `real data, ${size[0]}px, expanded`)
      if (size[0] === 1280) await side.screenshot({ path: join(shots, 'sidebar-realdata.png') })
      for (let i = 0; i < 3; i++) await cards.nth(i).getByTestId('card-toggle').click()
      await page.waitForTimeout(500)
      await page.getByRole('button', { name: 'Contraer Cuentas' }).click()
      await page.waitForTimeout(500)
      await sidebarFits(page, `real data, ${size[0]}px, collapsed`)
      await page.getByRole('button', { name: 'Expandir Cuentas' }).click()
      await page.waitForTimeout(500)
    }
    await states([1280, 800])
    await states([900, 600])
  } finally {
    await app.close()
  }
}

// ---- scenario 9: conversation view (F6.2): a scripted transcript is written live by the stub; cards, diffs, inert markdown, chat-first layout, Chat/Terminal toggle, scrolling, fits, light/dark shots ----
{
  const d = setup('nine')
  copyFileSync(stub, join(d.bin, 'claude'))
  const proj = join(d.home, 'chat-app')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  const cfg = join(d.home, 'cfg-chat')
  mkdirSync(cfg)
  writeFileSync(join(cfg, '.claude.json'), '{}')
  mkdirSync(d.relayHome, { recursive: true })
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  writeFileSync(join(d.relayHome, 'accounts.json'), JSON.stringify([{ id: 'cccccccc', label: 'Personal CarlosDev con una etiqueta de cuenta muy larga', provider: 'claude', configDir: cfg }]))
  // synthetic transcript (the shapes of tests/fixtures/transcript); __SID__ is replaced by the stub
  let n = 0
  const ts = () => new Date(Date.UTC(2026, 0, 1, 12, 0, n++)).toISOString()
  const common = (type) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: '__SID__', version: '2.1.312', gitBranch: 'main', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: ts(), type })
  const user = (content, extra = {}) => ({ ...common('user'), message: { role: 'user', content }, ...extra })
  const asst = (mid, idx, block, extra = {}) => ({ ...common('assistant'), requestId: `req_${mid}`, apiBlockIndex: idx, ...extra, message: { id: `msg_${mid}`, type: 'message', role: 'assistant', model: 'claude-fake-1', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 5 } } })
  const use = (mid, id, name, input) => asst(mid, 0, { type: 'tool_use', id, name, input })
  const res = (id, content, toolUseResult, isErr = false) => user([{ type: 'tool_result', tool_use_id: id, content, ...(isErr ? { is_error: true } : {}) }], toolUseResult === undefined ? {} : { toolUseResult })
  const hello = ['```ts', 'export const suma = (a: number, b: number) => a + b', '// <script>window.__pwn = 0</script>', '```']
  const long = Array.from({ length: 14 }, (_, i) => `${i + 1}. Paso ${i + 1} del plan sintético`).join('\n')
  const script = [
    { type: 'ai-title', aiTitle: 'Chat sintético', sessionId: '__SID__' },
    user('Crea una función suma y pruébala.'),
    asst('a1', 0, { type: 'thinking', thinking: '', signature: 'x' }, { thinkingDurationMs: 4000 }),
    asst('a1', 1, { type: 'text', text: `Voy a **crear** la función y probarla.\n\n${hello.join('\n')}\n\n${long}` }),
    asst('a2', 0, { type: 'text', text: 'Sin HTML crudo: <script>window.__pwn = 1</script> y <img src=x onerror="window.__pwn = 2"> y [enlace](javascript:window.__pwn=3) y ![img](https://example.com/x.png)' }),
    use('a3', 'tb1', 'Bash', { command: 'bun test' }),
    res('tb1', 'SALIDA-OK-SINTETICA', { stdout: 'SALIDA-OK-SINTETICA', stderr: '', interrupted: false }),
    use('a4', 'tb2', 'Bash', { command: 'false' }),
    res('tb2', 'FALLO-SINTETICO', { stdout: '', stderr: 'FALLO-SINTETICO', interrupted: false }, true),
    use('a5', 'te1', 'Edit', { file_path: `${cwd}/suma.ts`, old_string: 'a', new_string: 'b' }),
    res('te1', 'edited', { filePath: `${cwd}/suma.ts`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-export const a = 1', '+export const a = 2', '+export const b = 3'] }] }),
    use('a6', 'tw1', 'Write', { file_path: `${cwd}/nuevo.ts`, content: 'let b = 1\n' }),
    res('tw1', 'created', { type: 'create', filePath: `${cwd}/nuevo.ts`, content: 'let b = 1\n', structuredPatch: [] }),
    use('a7', 'tr1', 'Read', { file_path: `${cwd}/suma.ts` }),
    res('tr1', 'uno\ndos\ntres', 'uno\ndos\ntres'),
    use('a8', 'tf1', 'WebFetch', { url: 'https://docs.example.com/guia?x=1', prompt: 'resume' }),
    res('tf1', 'resumen', 'resumen'),
    use('a9', 'tg1', 'Agent', { description: 'Explora el repo', subagent_type: 'general', prompt: 'busca' }),
    res('tg1', 'Async agent launched', { status: 'async_launched', agentId: 'a1b2c3d4e5f60718' }),
    use('a10', 'tk1', 'TodoWrite', { todos: [{ content: 'tarea sintética', status: 'pending' }] }),
    res('tk1', 'ok', 'ok'),
    { ...common('system'), subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 120000, postTokens: 8000 } },
    { ...common('system'), subtype: 'turn_duration', durationMs: 64000 },
    use('a11', 'tq1', 'AskUserQuestion', { questions: [{ question: '¿Sigo con las pruebas?', header: 'Sigo', multiSelect: false, options: [{ label: 'Sí', description: 'continúa' }, { label: 'No', description: 'detente' }] }] })
  ]
  const sub = [
    { ...common('user'), isSidechain: true, message: { role: 'user', content: 'busca' } },
    { ...asst('s1', 0, { type: 'text', text: 'Hallazgo del subagente.' }), isSidechain: true }
  ]
  const lines = (a) => a.map((x) => JSON.stringify(x)).join('\n') + '\n'
  writeFileSync(join(tmp, 'chat-script.jsonl'), lines(script))
  writeFileSync(join(tmp, 'chat-agent.jsonl'), lines(sub))
  const app = await launch(d, { STUB_SCRIPT: join(tmp, 'chat-script.jsonl'), STUB_AGENT: join(tmp, 'chat-agent.jsonl'), STUB_ENC: cwd.replace(/[^a-zA-Z0-9]/g, '-'), STUB_GAP: '0.3', STUB_KEYS: join(tmp, 'chat-keys.log') })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.getByTestId('account-card').first().waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    const chat = page.getByTestId('chat-pane')
    const cards = chat.getByTestId('tool-card')
    await chat.getByText('Crea una función suma y pruébala.').waitFor({ timeout: t })
    // live: the first message shows up before the later blocks are written
    assert.equal(await cards.filter({ hasText: 'suma.ts' }).count(), 0, 'the Edit card does not exist yet when the first message appears')
    // chat-first: the chat covers the terminal's box; the terminal is mounted but not visible
    const term = page.getByTestId('terminal-pane')
    await term.locator('.xterm').waitFor({ state: 'attached', timeout: t })
    const [cb, tb] = await Promise.all([chat.boundingBox(), term.boundingBox()])
    assert.ok(cb && tb && cb.width > 400 && Math.abs(cb.width - tb.width) < 1 && Math.abs(cb.height - tb.height) < 1, 'the chat takes the whole session area, same box as the terminal')
    assert.equal(await term.locator('.xterm').isVisible(), false, 'the terminal is hidden in chat view')
    const keys = () => (existsSync(join(tmp, 'chat-keys.log')) ? readFileSync(join(tmp, 'chat-keys.log'), 'utf8').split('\n') : [])
    const sizes = () => keys().filter((l) => l.startsWith('SIZE:')).map((l) => Number(l.split(' ')[1]))
    const bytes = () => keys().filter((l) => l.startsWith('BYTES:')).map((l) => JSON.parse(l.slice(6))).join('')
    const poll = async (fn, what) => {
      for (let i = 0; i < 50; i++) {
        if (fn()) return
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.fail(`timeout: ${what}`)
    }
    await poll(() => sizes().length, 'the stub reported its pty size')
    const colsChat = sizes().at(-1)

    await chat.getByText('Pensó 4 s').waitFor({ timeout: t })
    await chat.getByText('Voy a crear la función y probarla.').waitFor({ timeout: t })
    await chat.locator('pre code').first().waitFor({ timeout: t })
    assert.ok(await chat.locator('pre code .hljs-keyword').count(), 'code is highlighted (token spans)')
    await chat.getByRole('button', { name: 'Copiar código' }).first().waitFor({ timeout: t })
    // bash: command in the header, output folded; the error card shows its state
    const ok = cards.filter({ hasText: 'bun test' })
    await ok.waitFor({ timeout: t })
    assert.equal(await ok.getByText('SALIDA-OK-SINTETICA').isVisible(), false, 'stdout is folded')
    await ok.locator('summary').first().click()
    await ok.getByText('Salida', { exact: true }).click()
    await ok.getByText('SALIDA-OK-SINTETICA').waitFor({ timeout: t })
    const bad = cards.filter({ hasText: 'false' }).first()
    await bad.getByText('error', { exact: true }).waitFor({ timeout: t })
    await bad.getByText('FALLO-SINTETICO').waitFor({ timeout: t }) // errors open by default
    // edit: coloured diff with counts; write: created
    const edit = cards.filter({ hasText: 'suma.ts' }).first()
    await edit.getByText('+export const b = 3').waitFor({ timeout: t })
    assert.match(await edit.getByTestId('diff').textContent(), /\+2.*−1/)
    const head = edit.getByTestId('diff').locator('span').first()
    assert.equal(await head.textContent(), 'suma.ts', 'diff header is relative to the project')
    assert.equal(await head.getAttribute('title'), `${cwd}/suma.ts`, 'absolute path in the title')
    const addBg = await edit.getByText('+export const b = 3').evaluate((el) => getComputedStyle(el).backgroundColor)
    const delBg = await edit.getByText('-export const a = 1').evaluate((el) => getComputedStyle(el).backgroundColor)
    assert.ok(addBg !== delBg && addBg !== 'rgba(0, 0, 0, 0)' && delBg !== 'rgba(0, 0, 0, 0)', `diff lines are coloured (${addBg} / ${delBg})`)
    const wr = cards.filter({ hasText: 'nuevo.ts' }).first()
    await wr.getByText('creado', { exact: true }).waitFor({ timeout: t })
    await cards.filter({ hasText: 'docs.example.com' }).first().waitFor({ timeout: t })
    await cards.filter({ hasText: 'TodoWrite' }).first().waitFor({ timeout: t }) // generic card
    // subagent: lazy nested thread
    const ag = cards.filter({ hasText: 'Explora el repo' }).first()
    await ag.waitFor({ timeout: t })
    assert.equal(await chat.getByText('Hallazgo del subagente.').count(), 0, 'the subagent thread is not loaded until opened')
    await ag.locator('summary').first().click()
    await ag.getByTestId('subthread').getByText('Hallazgo del subagente.').waitFor({ timeout: t })
    // notices and the pending ask
    await chat.getByText(/Conversación compactada · 120k → 8k tokens/).waitFor({ timeout: t })
    await chat.getByText('Turno de 1 min 4 s').waitFor({ timeout: t })
    const q = cards.filter({ hasText: 'AskUserQuestion' }).first()
    await q.getByText('¿Sigo con las pruebas?').first().waitFor({ timeout: t })

    // security: nothing from the transcript became markup or a navigation
    await chat.getByText('<script>window.__pwn = 1</script>').first().waitFor({ timeout: t })
    assert.equal(await chat.locator('script, img, iframe, a[href], [onerror]').count(), 0, 'no script/img/iframe/link/handler elements in the chat')
    assert.equal(await page.evaluate(() => window.__pwn), undefined, 'no injected script ran')
    assert.equal(await chat.getByText('enlace').evaluate((el) => el.tagName), 'SPAN', 'links are inert')

    // follow the end, then scroll up: "Ir al último" appears and works
    const box = chat.getByTestId('conversation').locator('> div').first()
    const dist = () => box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    await page.waitForTimeout(500)
    assert.ok((await dist()) < 60, 'the view follows the end')
    assert.equal(await chat.getByRole('button', { name: 'Ir al último' }).count(), 0)
    assert.ok(await box.evaluate((el) => el.scrollHeight > el.clientHeight + 200), 'the transcript is taller than the pane')
    await box.evaluate((el) => (el.scrollTop = 0))
    const last = chat.getByRole('button', { name: 'Ir al último' })
    await last.waitFor({ timeout: t })
    await last.click()
    await last.waitFor({ state: 'hidden', timeout: t })
    assert.ok((await dist()) < 60)

    // fits at 1280 and 900 with the chat open
    for (const size of [[1280, 800], [900, 600]]) {
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), size)
      await page.waitForTimeout(500)
      assert.deepEqual(await mainOverflow(page, true), [], `main content overflows with the chat open (${size[0]}px)`)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.waitForTimeout(500)

    // Terminal view: same pty size (the terminal was never display:none), keystrokes reach the pty; back to Chat keeps the content
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await chat.waitFor({ state: 'hidden', timeout: t })
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await term.locator('.xterm').click()
    await page.keyboard.type('hola-marker')
    await page.keyboard.press('Enter')
    await poll(() => bytes().includes('hola-marker\r'), 'the typed marker reached the pty')
    assert.equal(sizes().at(-1), colsChat, 'the pty size did not change with the view')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await chat.getByText('Crea una función suma y pruébala.').waitFor({ timeout: t })
    await chat.getByText(/Conversación compactada/).waitFor({ timeout: t })
    assert.equal(await term.locator('.xterm').isVisible(), false, 'the terminal is hidden again')

    // light / dark shots (the OS theme drives relay-light / relay-dark)
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(600)
      await ag.waitFor({ timeout: t })
      await box.evaluate((el) => (el.scrollTop = 0))
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `chat-${scheme}-top.png`) })
      await page.getByRole('button', { name: 'Ir al último' }).click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `chat-${scheme}.png`) })
    }
    await page.emulateMedia({ colorScheme: null })
    assert.ok(!existsSync(join(d.home, '.claude')), 'nothing written outside the temp HOME')
  } finally {
    await app.close()
  }
}
// ---- scenario 10: chat-first core (F6.3): hidden-but-live terminal, composer bridge bytes, Stop, clear confirmation, dialog/unknown fallback, fits, shots ----
{
  const d = setup('ten')
  copyFileSync(stub, join(d.bin, 'claude'))
  const proj = join(d.home, 'chat-first')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  const cfg = join(d.home, 'cfg-first')
  mkdirSync(cfg)
  writeFileSync(join(cfg, '.claude.json'), '{}')
  mkdirSync(d.relayHome, { recursive: true })
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  writeFileSync(join(d.relayHome, 'accounts.json'), JSON.stringify([{ id: 'dddddddd', label: 'Personal CarlosDev con una etiqueta de cuenta muy larga', provider: 'claude', configDir: cfg }]))
  const klog = join(tmp, 'first-keys.log')
  const ctl = join(tmp, 'first-ctl')
  writeFileSync(ctl, '')
  const app = await launch(d, { STUB_KEYS: klog, STUB_CTL: ctl, STUB_ENC: cwd.replace(/[^a-zA-Z0-9]/g, '-'), STUB_THINK: '7000' })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.getByTestId('account-card').first().waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    const chat = page.getByTestId('chat-pane')
    const term = page.getByTestId('terminal-pane')
    const composer = page.getByTestId('composer')
    const send = page.getByRole('button', { name: 'Enviar', exact: true })
    const lines = () => (existsSync(klog) ? readFileSync(klog, 'utf8').split('\n') : [])
    const sizes = () => lines().filter((l) => l.startsWith('SIZE:')).map((l) => Number(l.split(' ')[1]))
    const bytes = () => lines().filter((l) => l.startsWith('BYTES:')).map((l) => JSON.parse(l.slice(6))).join('')
    const poll = async (fn, what) => {
      for (let i = 0; i < 60; i++) {
        if (await fn()) return
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.fail(`timeout: ${what}`)
    }
    const state = (s) => page.waitForFunction((x) => document.querySelector('[data-testid=activity]')?.dataset.state === x, s, { timeout: t })
    const PS = '\x1b[200~'
    const PE = '\x1b[201~'

    // chat is the default view; the terminal is mounted, hidden, and the screen is classified from it
    await composer.waitFor({ timeout: t })
    await state('idle')
    await page.getByTestId('activity').getByText('Listo', { exact: true }).waitFor({ timeout: t })
    await term.locator('.xterm').waitFor({ state: 'attached', timeout: t })
    assert.equal(await term.locator('.xterm').isVisible(), false, 'terminal hidden by default')
    const [cb, tb] = await Promise.all([chat.boundingBox(), term.boundingBox()])
    assert.ok(cb && tb && Math.abs(cb.width - tb.width) < 1 && Math.abs(cb.height - tb.height) < 1, 'hidden terminal keeps the size of the visible area (not display:none)')
    await poll(() => sizes().length, 'the stub reported its pty size')
    await page.waitForTimeout(600)
    const cols0 = sizes().at(-1)
    assert.ok(cols0 > 60, `pty is fitted to the area (${cols0} cols)`)
    assert.equal(bytes(), '', 'nothing reached the pty before the user sent something')

    // send: exactly paste-start + text + paste-end + CR; both messages appear in the chat
    await composer.fill('hola')
    await composer.press('Enter')
    await chat.getByText('Respuesta a: hola').waitFor({ timeout: t })
    assert.equal(bytes(), `${PS}hola${PE}\r`, 'one bracketed paste + Enter, nothing else')
    await chat.locator('[data-testid=ev-message]', { hasText: /^hola$/ }).waitFor({ timeout: t })
    await state('idle')
    assert.equal(await composer.inputValue(), '', 'the composer is cleared after sending')

    // multi-line (Shift+Enter) arrives intact
    let m = bytes().length
    await composer.fill('')
    await composer.pressSequentially('linea1')
    await composer.press('Shift+Enter')
    await composer.pressSequentially('linea2')
    await composer.press('Enter')
    await poll(() => bytes().slice(m) === `${PS}linea1\nlinea2${PE}\r`, 'multi-line message arrived intact')
    await chat.getByText('Respuesta a: linea1').waitFor({ timeout: t })
    await state('idle')

    // history: ArrowUp recalls the last sent message, ArrowDown returns to the draft
    await composer.fill('')
    await composer.press('ArrowUp')
    assert.equal(await composer.inputValue(), 'linea1\nlinea2')
    await composer.press('ArrowUp') // moves the caret to the first line of the recalled text; only then does it browse further
    await composer.press('ArrowUp')
    assert.equal(await composer.inputValue(), 'hola')
    await composer.press('ArrowDown')
    assert.equal(await composer.inputValue(), 'linea1\nlinea2')
    await composer.press('ArrowDown') // caret to the last line
    await composer.press('ArrowDown')
    assert.equal(await composer.inputValue(), '')

    // working: activity line with the pending tool from the transcript + Stop; screenshots in both themes
    m = bytes().length
    await composer.fill('trabaja un rato')
    await composer.press('Enter')
    await state('working')
    await page.getByTestId('activity').getByText(/Trabajando… · Bash · bun test/).waitFor({ timeout: t })
    const stopBtn = page.getByRole('button', { name: 'Parar', exact: true })
    await stopBtn.waitFor({ timeout: t })
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(shots, `chat-first-${scheme}.png`) })
    }
    await page.emulateMedia({ colorScheme: null })
    for (const size of [[1280, 800], [900, 600]]) {
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), size)
      await page.waitForTimeout(500)
      assert.deepEqual(await mainOverflow(page, true), [], `main content overflows in chat-first (${size[0]}px)`)
      await sidebarFits(page, `chat-first ${size[0]}px`)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.waitForTimeout(500)
    // while the CLI works, sending is blocked (a permission dialog may appear any moment): typing is allowed, Enter writes nothing
    assert.equal(await composer.isDisabled(), false, 'the draft can be typed while working')
    await composer.fill('mas')
    await composer.press('Enter')
    await page.getByTestId('composer-hint').getByText(/Espera a que el CLI termine/).waitFor({ timeout: t })
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), `${PS}trabaja un rato${PE}\r`, 'nothing was sent while working')
    assert.equal(await composer.inputValue(), 'mas', 'the blocked draft is kept')
    await composer.fill('')
    await stopBtn.click()
    await poll(() => bytes().slice(m) === `${PS}trabaja un rato${PE}\r\x1b`, 'Stop wrote exactly one ESC')
    await state('idle')

    // hostile text: control bytes and a paste-end injection never reach the pty
    m = bytes().length
    await composer.fill('x\x03y\x1b[201~z\x04w')
    assert.equal(await composer.inputValue(), 'x\x03y\x1b[201~z\x04w', 'the control characters really are in the textarea before sending')
    await composer.press('Enter')
    await poll(() => bytes().slice(m) === `${PS}xy[201~zw${PE}\r`, 'hostile text was stripped in main')
    assert.ok(!/[\x03\x04\x1a]/.test(bytes()), 'no ^C / ^D / ^Z ever reached the pty')
    await chat.getByText('Respuesta a: xy[201~zw').waitFor({ timeout: t }) // the turn this send started has finished (an idle frame from before the send must not count)
    await state('idle')

    // a non-empty CLI box (typed in the terminal): the composer asks before clearing; Cancel writes nothing
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await term.locator('.xterm').click()
    await page.keyboard.type('abc')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await state('input-pending')
    await page.getByTestId('composer-hint').getByText(/no está vacía/).waitFor({ timeout: t })
    m = bytes().length
    await composer.fill('tras-limpiar')
    await composer.press('Enter')
    const dlg = page.getByRole('dialog', { name: 'Vaciar la entrada del CLI' })
    await dlg.waitFor({ timeout: t })
    assert.equal(await dlg.getByRole('button', { name: 'Cancelar' }).evaluate((el) => el === document.activeElement), true, 'the safe button has the focus')
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'nothing is written while the confirmation is open')
    await dlg.getByRole('button', { name: 'Cancelar' }).click()
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'cancelling writes nothing')
    await composer.press('Enter')
    await dlg.waitFor({ timeout: t })
    await dlg.getByRole('button', { name: 'Vaciar y enviar' }).click()
    await poll(() => bytes().slice(m) === `\x15${PS}tras-limpiar${PE}\r`, 'confirmed: ^U then the message')
    await state('working')
    await state('idle')

    // an open `/` list: ESC then ^U, only after confirming
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await term.locator('.xterm').click()
    await page.keyboard.type('/')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await state('overlay')
    m = bytes().length
    await composer.fill('tras-lista')
    await composer.press('Enter')
    await dlg.waitFor({ timeout: t })
    await page.waitForTimeout(200)
    assert.equal(bytes().slice(m), '', 'nothing written before confirming')
    await dlg.getByRole('button', { name: 'Vaciar y enviar' }).click()
    await poll(() => bytes().slice(m) === `\x1b\x15${PS}tras-lista${PE}\r`, 'confirmed: ESC, ^U, then the message')
    await state('working')
    await state('idle')

    // the frame changes around a send (the keydown handler stalls the renderer 500 ms while the stub draws a dialog): nothing reaches the pty (exercises the xterm flush + gate; the main-side seq guard is covered in tests/pty.test.ts)
    m = bytes().length
    await composer.fill('carrera')
    await page.evaluate(() => document.querySelector('[data-testid=composer]').addEventListener('keydown', () => { const e = Date.now() + 500; while (Date.now() < e); }, { once: true, capture: true }))
    setTimeout(() => writeFileSync(ctl, 'permission'), 80)
    await composer.press('Enter')
    await state('dialog:permission')
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'no byte is written when a dialog appears around the send')
    assert.equal(await composer.inputValue(), 'carrera', 'the draft is kept')
    // a permission dialog has a card (F6.4): the composer is blocked with the card hint, nothing is written without a click, the terminal does NOT open by itself
    assert.equal(await composer.isDisabled(), true, 'composer blocked on a dialog')
    assert.equal(await send.isDisabled(), true)
    await page.getByTestId('activity').getByText('Esperando tu respuesta').waitFor({ timeout: t })
    await page.getByTestId('composer-hint').getByText('Responde a la tarjeta o abre la terminal.').waitFor({ timeout: t })
    await page.getByTestId('prompt-card').waitFor({ timeout: t })
    await page.waitForTimeout(2200)
    assert.equal(await chat.isVisible(), true, 'a card keeps the chat open (no terminal auto-open)')
    assert.equal(await term.locator('.xterm').isVisible(), false)
    assert.equal(bytes().slice(m), '', 'no key is sent without a click')
    writeFileSync(ctl, '')
    await state('idle')
    assert.equal(await composer.isDisabled(), false)
    await composer.fill('')

    // a dialog without a card (folder trust) keeps the F6.3 behaviour: the terminal opens by itself (once), nothing is written
    writeFileSync(ctl, 'trust')
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await page.getByRole('alert').filter({ hasText: 'espera una respuesta' }).waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.waitForTimeout(2200)
    assert.equal(await chat.isVisible(), true, 'back in the chat the same dialog does not reopen the terminal')
    await page.getByTestId('cli-notice').getByRole('button', { name: 'Abrir terminal' }).click()
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    assert.equal(bytes().slice(m), '', 'no key is sent for a dialog')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    writeFileSync(ctl, '')
    await state('idle')
    assert.equal(await composer.isDisabled(), false)
    await composer.fill('')

    // an unreadable screen opens the terminal by itself (after ~1.5 s) and says so
    writeFileSync(ctl, 'unknown')
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await page.getByRole('alert').filter({ hasText: 'Relay no reconoce lo que muestra' }).waitFor({ timeout: t })
    assert.equal(await chat.isVisible(), false, 'the chat view is replaced by the terminal')
    assert.equal(bytes().slice(m), '', 'nothing written for an unknown screen')
    writeFileSync(ctl, '')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await state('idle')

    assert.equal(sizes().at(-1), cols0, 'the pty size never changed while switching views')
    assert.ok(!existsSync(join(d.home, '.claude')), 'nothing written outside the temp HOME')
  } finally {
    await app.close()
  }
}
// ---- scenario 11: prompt cards (F6.4): permission / question / multi-select / review / plan cards, exact keys, fingerprint guard, one shot, answered in the terminal, no-card dialogs, fits, shots ----
{
  const d = setup('eleven')
  copyFileSync(stub, join(d.bin, 'claude'))
  const proj = join(d.home, 'cards')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  const cfg = join(d.home, 'cfg-cards')
  mkdirSync(cfg)
  writeFileSync(join(cfg, '.claude.json'), '{}')
  mkdirSync(d.relayHome, { recursive: true })
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  writeFileSync(join(d.relayHome, 'accounts.json'), JSON.stringify([{ id: 'eeeeeeee', label: 'Personal CarlosDev con una etiqueta de cuenta muy larga', provider: 'claude', configDir: cfg }]))
  const klog = join(tmp, 'cards-keys.log')
  const ctl = join(tmp, 'cards-ctl')
  writeFileSync(ctl, '')
  const app = await launch(d, { STUB_KEYS: klog, STUB_CTL: ctl, STUB_ENC: cwd.replace(/[^a-zA-Z0-9]/g, '-') })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.getByTestId('account-card').first().waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    const chat = page.getByTestId('chat-pane')
    const term = page.getByTestId('terminal-pane')
    const composer = page.getByTestId('composer')
    const card = page.getByTestId('prompt-card')
    const btn = (n) => card.locator(`button[data-n="${n}"]`)
    const lines = () => (existsSync(klog) ? readFileSync(klog, 'utf8').split('\n') : [])
    const bytes = () => lines().filter((l) => l.startsWith('BYTES:')).map((l) => JSON.parse(l.slice(6))).join('')
    const answers = () => lines().filter((l) => l.startsWith('ANSWER:'))
    const poll = async (fn, what) => {
      for (let i = 0; i < 60; i++) {
        if (await fn()) return
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.fail(`timeout: ${what}`)
    }
    const state = (s) => page.waitForFunction((x) => document.querySelector('[data-testid=activity]')?.dataset.state === x, s, { timeout: t })
    /** clears the dialog, waits for the idle screen, opens `name` and waits for its card */
    const open = async (name, kind) => {
      writeFileSync(ctl, '')
      await state('idle')
      await page.waitForTimeout(450) // the previous card's record settles
      writeFileSync(ctl, name)
      await page.locator('[data-testid=prompt-card][data-status=live]').waitFor({ timeout: t }) // armed: the fingerprint was stable for 400 ms
      assert.equal(await card.getAttribute('data-kind'), kind)
    }
    const labels = async () => card.locator('button[data-n] > span:last-child').allInnerTexts()

    await composer.waitFor({ timeout: t })
    await state('idle')
    assert.equal(bytes(), '', 'nothing reached the pty yet')

    // ---- permission: body + options from the screen, nothing sent without a click ----
    await open('permission', 'permission')
    await card.getByText('touch created1.txt').waitFor({ timeout: t })
    await card.getByText('Do you want to proceed?').waitFor({ timeout: t })
    assert.deepEqual((await labels()).map((x) => x.split('\n')[0]), ['Yes', 'Yes, and always allow access to', 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No'])
    await card.getByText('/tmp/proj from this project').waitFor({ timeout: t })
    assert.equal(await composer.isDisabled(), true, 'the composer stays blocked while a card shows')
    await page.getByTestId('composer-hint').getByText('Responde a la tarjeta o abre la terminal.').waitFor({ timeout: t })
    await page.waitForTimeout(2200)
    assert.equal(await term.locator('.xterm').isVisible(), false, 'the terminal does not open for a card')
    assert.equal(bytes(), '', 'no key without a click')
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(shots, `card-permission-${scheme}.png`) })
    }
    await page.emulateMedia({ colorScheme: null })
    // click 2: exactly "2"; the card disables and keeps a record; the fake TUI works a moment and returns to idle
    let m = bytes().length
    await btn(2).click()
    await poll(() => bytes().slice(m) === '2', 'option 2 wrote exactly "2"')
    assert.deepEqual(answers(), ['ANSWER:permission:2'])
    await state('working')
    await state('idle')
    await page.getByTestId('prompt-card').filter({ hasText: 'Respondido' }).waitFor({ timeout: t })
    assert.equal(await card.getAttribute('data-status'), 'sent')
    assert.equal(await card.locator('button').count(), 0, 'the answered record has no buttons')
    assert.equal(bytes().slice(m), '2', 'one key only')

    // double click: one key
    await open('permission', 'permission')
    m = bytes().length
    await btn(1).dblclick()
    await poll(() => bytes().slice(m) === '1', 'option 1')
    await page.waitForTimeout(600)
    assert.equal(bytes().slice(m), '1', 'a double click sends once')
    assert.equal(answers().filter((a) => a === 'ANSWER:permission:1').length, 1)

    // Cancelar = exactly ESC
    await open('permission', 'permission')
    m = bytes().length
    await card.getByRole('button', { name: 'Cancelar' }).click()
    await poll(() => bytes().slice(m) === '\x1b', 'cancel wrote exactly ESC')
    assert.equal(answers().at(-1), 'ANSWER:permission:cancel')

    // keyboard: a digit on the focused card
    await open('permission', 'permission')
    m = bytes().length
    await card.focus()
    await page.keyboard.press('4')
    await poll(() => bytes().slice(m) === '4', 'digit 4 on the focused card')
    assert.equal(answers().at(-1), 'ANSWER:permission:4')

    // ---- stale guard: the TUI swaps to ANOTHER permission dialog (another command) just before the click ----
    await open('permission', 'permission')
    await card.getByText('touch created1.txt').waitFor({ timeout: t })
    m = bytes().length
    const nAnswers = answers().length
    // the click fires inside the pty:data handler of the swapped frame: xterm already holds it, the card still shows the old one (React renders ~200 ms later)
    await page.evaluate(() => {
      window.__swapped = false
      let seen = ''
      window.relay.pty.onData((_id, data) => {
        if (window.__swapped) return
        seen += data
        // the whole swapped frame is in (its last row is the footer) and nothing more will come: xterm holds it, React (200 ms throttle) still shows the old card
        if (!seen.includes('other-file.txt') || !seen.includes('Tab to amend')) return
        window.__swapped = true
        document.querySelector('[data-testid=prompt-card] button[data-n="2"]').click()
      })
    })
    writeFileSync(ctl, 'permission2')
    await page.waitForFunction(() => window.__swapped, null, { timeout: t })
    await page.getByTestId('prompt-note').getByText(/La pantalla del CLI cambió/).waitFor({ timeout: t }) // the fingerprint compare dropped it
    await card.getByText('other-file.txt').waitFor({ timeout: t })
    await page.waitForTimeout(500)
    assert.equal(bytes().slice(m), '', 'the fingerprint guard sent no byte')
    assert.equal(answers().length, nAnswers, 'the fake TUI answered nothing')
    assert.equal(await card.getAttribute('data-status'), 'live', 'the new dialog has its own fresh card')
    assert.equal(await btn(2).isDisabled(), false)
    await page.getByTestId('prompt-note').getByRole('button', { name: 'Abrir terminal' }).waitFor({ timeout: t })

    // ---- answered in the terminal: the card turns into a record ----
    await open('permission', 'permission')
    m = bytes().length
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await term.locator('.xterm').click()
    await page.keyboard.press('1')
    await poll(() => bytes().slice(m) === '1', 'the terminal keystroke reached the pty')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByTestId('prompt-card').filter({ hasText: 'Respondido en la terminal' }).waitFor({ timeout: t })
    assert.equal(await card.getAttribute('data-status'), 'terminal')
    assert.equal(await card.locator('button').count(), 0)
    assert.equal(bytes().slice(m), '1', 'Relay wrote nothing itself')

    // ---- AskUserQuestion, single: descriptions from the transcript, "Type something" -> digit + text + Enter ----
    await open('question', 'question')
    await card.getByText('Rojo desde el transcript').waitFor({ timeout: t })
    assert.deepEqual((await labels()).map((x) => x.split('\n')[0]), ['Red', 'Blue', 'Type something.', 'Chat about this'])
    await page.screenshot({ path: join(shots, 'card-question-light.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(shots, 'card-question-dark.png') })
    await page.emulateMedia({ colorScheme: null })
    m = bytes().length
    await btn(3).click()
    assert.equal(bytes().slice(m), '', 'the digit of a text row waits for the text')
    const box = card.getByTestId('prompt-text')
    await box.fill('Verde\x1b[201~ claro')
    await box.press('Enter')
    await poll(() => bytes().slice(m) === '3Verde[201~ claro\r', 'digit, sanitized line, Enter')
    assert.equal(answers().at(-1), 'ANSWER:question:text:Verde[201~ claro')
    assert.deepEqual(lines().filter((l) => l.startsWith('BYTES:')).map((l) => JSON.parse(l.slice(6))).slice(-3), ['3', 'Verde[201~ claro', '\r'], 'three separate writes')

    // ---- M3b: a new card cannot be answered while it settles (a MutationObserver clicks option 1 the moment a card first renders, and again 150 ms later) ----
    await page.evaluate(() => {
      const a = (window.__arm = { clicks: 0, late: [], seen: new WeakSet(), stop: () => ob.disconnect() })
      const go = (c) => {
        const click = () => (c.querySelector('button[data-n="1"]')?.click(), a.clicks++)
        click()
        setTimeout(() => (a.late.push(c.dataset.status), click()), 150)
      }
      const ob = new MutationObserver((recs) => {
        for (const r of recs) {
          const cs = r.type === 'attributes' ? [r.target] : [...r.addedNodes].flatMap((n) => (n.nodeType === 1 ? [...(n.matches('[data-testid=prompt-card]') ? [n] : []), ...n.querySelectorAll('[data-testid=prompt-card]')] : []))
          for (const c of cs) if (c.dataset?.testid === 'prompt-card' && c.dataset.status === 'settling' && c.querySelector('button[data-n]')) go(c)
        }
      })
      ob.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] })
    })
    m = bytes().length
    const nAns = answers().length
    writeFileSync(ctl, '')
    await state('idle')
    await page.waitForTimeout(450)
    writeFileSync(ctl, 'question')
    await page.locator('[data-testid=prompt-card][data-status=live]').waitFor({ timeout: t })
    await page.waitForTimeout(300) // the delayed click (150 ms after the card appeared) has run by now
    const arm = await page.evaluate(() => (window.__arm.stop(), { clicks: window.__arm.clicks, late: window.__arm.late }))
    assert.ok(arm.clicks >= 2 && arm.late.length >= 1, `the observer clicked the settling card (${JSON.stringify(arm)})`)
    assert.ok(arm.late.every((x) => x === 'settling'), `still settling 150 ms after the card appeared (${arm.late})`)
    assert.equal(bytes().slice(m), '', 'no byte while the card settled')
    assert.equal(answers().length, nAns, 'no answer while the card settled')

    // single option by digit
    await open('question', 'question')
    m = bytes().length
    await btn(2).click()
    await poll(() => bytes().slice(m) === '2', 'option 2 of the question')

    // ---- M1: a CLI where the digit of "Type something" confirms: the line and Enter are never sent ----
    await open('question3', 'question')
    m = bytes().length
    await btn(3).click()
    await card.getByTestId('prompt-text').fill('Hola')
    await card.getByTestId('prompt-text').press('Enter')
    await poll(() => answers().at(-1) === 'ANSWER:question:3', 'the fake TUI took the digit as a confirmation')
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t }) // the failed check opens the terminal
    await page.waitForTimeout(800)
    assert.equal(bytes().slice(m), '3', 'only the digit: neither the line nor Enter reached the pty')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()

    // ---- M2: a command taller than the screen: the card refuses to offer answers ----
    writeFileSync(ctl, '')
    await state('idle')
    await page.waitForTimeout(450)
    m = bytes().length
    writeFileSync(ctl, 'longperm')
    await page.getByTestId('prompt-refused').waitFor({ timeout: t })
    assert.equal(await card.locator('button[data-n]').count(), 0, 'no option buttons for a dialog that does not fit')
    await page.keyboard.press('1')
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'nothing written')

    // ---- multi-select + tabs + review ----
    await open('multi', 'question')
    assert.deepEqual((await labels()).map((x) => x.split('\n')[0]), ['Apple', 'Pear', 'Plum', 'Type something', 'Chat about this'])
    m = bytes().length
    await btn(1).click()
    await poll(() => bytes().slice(m) === '1', 'toggle 1')
    await btn(1).getByText('☑').waitFor({ timeout: t }) // re-armed with the new fingerprint
    await btn(3).click()
    await poll(() => bytes().slice(m) === '13', 'toggle 3')
    await btn(3).getByText('☑').waitFor({ timeout: t })
    assert.equal(await btn(2).getByText('☐').count(), 1)
    await card.getByRole('button', { name: 'Siguiente' }).click()
    await poll(() => bytes().slice(m) === '13\t', 'Next = Tab')
    await card.getByText('Which size do you want?').waitFor({ timeout: t })
    // double click on question 1 of a two-question single-select flow: exactly one digit (the 2nd click lands on the locked card, or on the unarmed review card; arming itself is tested below)
    await btn(2).dblclick()
    await poll(() => bytes().slice(m) === '13\t2', 'single-select digit on the second tab')
    await page.waitForTimeout(700)
    assert.equal(bytes().slice(m), '13\t2', 'the second click of a double click reached nothing')
    await card.getByText('Review your answers').first().waitFor({ timeout: t })
    assert.equal(await card.getAttribute('data-kind'), 'review')
    assert.deepEqual((await labels()).map((x) => x.split('\n')[0]), ['Submit answers', 'Cancel'])
    await btn(1).click()
    await poll(() => bytes().slice(m) === '13\t21', 'review: 1 submits')
    assert.deepEqual(answers().slice(-5), ['ANSWER:multi:toggle:1', 'ANSWER:multi:toggle:3', 'ANSWER:multi:next', 'ANSWER:multi:size:2', 'ANSWER:multi:review:1'])

    // ---- plan: markdown from the transcript, option 3 -> text ----
    await open('plan', 'plan')
    await card.getByRole('heading', { name: 'Plan de prueba' }).waitFor({ timeout: t })
    assert.deepEqual((await labels()).map((x) => x.split('\n')[0]), ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'])
    for (const size of [[1280, 800], [900, 600]]) {
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), size)
      await page.waitForTimeout(500)
      assert.deepEqual(await mainOverflow(page, true), [], `main content overflows with a plan card (${size[0]}px)`)
      await sidebarFits(page, `plan card ${size[0]}px`)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.waitForTimeout(500)
    m = bytes().length
    await btn(3).click()
    await card.getByTestId('prompt-text').fill('Añade tests')
    await card.getByRole('button', { name: 'Enviar', exact: true }).click()
    await poll(() => bytes().slice(m) === '3Añade tests\r', 'plan feedback: digit, text, Enter')
    assert.equal(answers().at(-1), 'ANSWER:plan:text:Añade tests')
    await open('plan', 'plan')
    m = bytes().length
    await btn(1).click()
    await poll(() => bytes().slice(m) === '1', 'plan option 1')

    // ---- dialogs without a card keep the F6.3 behaviour ----
    for (const [name, what] of [['odd', 'dialog:unknown'], ['trust', 'dialog:trust']]) {
      writeFileSync(ctl, '')
      await state('idle')
      await page.waitForTimeout(450)
      m = bytes().length
      writeFileSync(ctl, name)
      await state(what)
      await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
      await page.getByRole('alert').filter({ hasText: 'espera una respuesta' }).last().waitFor({ timeout: t }) // toasts of the previous round may still be up
      assert.equal(await chat.isVisible(), false, `${what}: the terminal opened by itself`)
      assert.equal(bytes().slice(m), '', `${what}: nothing written`)
      await page.getByRole('button', { name: 'Chat', exact: true }).click()
      assert.equal(await card.filter({ has: page.locator('[data-n]') }).count(), 0, `${what}: no card`)
    }
    writeFileSync(ctl, '')
    await state('idle')
    assert.ok(!existsSync(join(d.home, '.claude')), 'nothing written outside the temp HOME')
  } finally {
    await app.close()
  }
}
// ---- scenario 12: controls bar and palettes (F6.5): `/` palette, `@` autocomplete, "+" menu, mode cycle (Shift+Tab), model warning, context ring, compact / clear, nothing while busy, fits, shots ----
{
  const d = setup('twelve')
  copyFileSync(stub, join(d.bin, 'claude'))
  const proj = join(d.home, 'controls-app')
  mkdirSync(proj)
  const cwd = realpathSync(proj)
  const out = join(d.home, 'outside-project')
  mkdirSync(out)
  writeFileSync(join(out, 'secret.txt'), 'TOP SECRET')
  for (const [f, c] of [['README.md', '# hi'], ['src/app.ts', 'export {}'], ['node_modules/pkg/index.js', 'x'], ['.env', 'K=V'], ['.git/config', 'x'], ['con espacio.txt', 'x']]) {
    mkdirSync(join(proj, f, '..'), { recursive: true })
    writeFileSync(join(proj, f), c)
  }
  symlinkSync(join(out, 'secret.txt'), join(proj, 'link-out.txt'))
  symlinkSync(out, join(proj, 'dir-out'))
  const cfg = join(d.home, 'cfg-controls')
  mkdirSync(join(cfg, 'commands'), { recursive: true })
  writeFileSync(join(cfg, '.claude.json'), '{}')
  writeFileSync(join(cfg, 'commands/deploy.md'), '---\ndescription: Despliega el proyecto a producción\n---\nDeploy.\n')
  mkdirSync(d.relayHome, { recursive: true })
  writeFileSync(join(d.relayHome, 'projects.json'), JSON.stringify([cwd]))
  writeFileSync(join(d.relayHome, 'accounts.json'), JSON.stringify([{ id: 'eeeeeeee', label: 'Personal CarlosDev con una etiqueta de cuenta muy larga', provider: 'claude', configDir: cfg }]))
  const klog = join(tmp, 'controls-keys.log')
  const ctl = join(tmp, 'controls-ctl')
  writeFileSync(ctl, '')
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const app = await launch(d, { STUB_KEYS: klog, STUB_CTL: ctl, STUB_ENC: enc, STUB_THINK: '2500' })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.getByTestId('account-card').first().waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Nueva sesión' }).first().click()
    const chat = page.getByTestId('chat-pane')
    const term = page.getByTestId('terminal-pane')
    const composer = page.getByTestId('composer')
    const palette = page.getByTestId('palette')
    const items = palette.getByTestId('palette-item')
    const lines = () => (existsSync(klog) ? readFileSync(klog, 'utf8').split('\n') : [])
    const bytes = () => lines().filter((l) => l.startsWith('BYTES:')).map((l) => JSON.parse(l.slice(6))).join('')
    const cmds = () => lines().filter((l) => l.startsWith('CMD:'))
    const poll = async (fn, what) => {
      for (let i = 0; i < 75; i++) {
        if (await fn()) return
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.fail(`timeout: ${what}`)
    }
    const state = (s) => page.waitForFunction((x) => document.querySelector('[data-testid=activity]')?.dataset.state === x, s, { timeout: t })
    const label = (id) => page.getByTestId(id).innerText().then((x) => x.trim())
    const PS = '\x1b[200~'
    const PE = '\x1b[201~'
    const pick = async (id, name) => {
      await page.getByTestId(id).click()
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    const backToChat = async () => {
      await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
      await page.getByRole('button', { name: 'Chat', exact: true }).click()
      await state('idle')
    }

    await composer.waitFor({ timeout: t })
    await state('idle')
    assert.equal(await label('info-mode'), 'Manual', 'the mode comes from the CLI footer')

    // ---- `/` palette: opens on a leading `/`, lists built-ins + the account's custom commands, filters, keyboard navigation, Esc, fills the composer ----
    await composer.pressSequentially('/')
    await palette.waitFor({ timeout: t })
    assert.equal(bytes(), '', 'typing `/` in the composer writes nothing to the pty')
    const names = await items.allInnerTexts()
    for (const n of ['compact', 'clear', 'model', 'permissions', 'cost', 'memory', 'agents', 'mcp', 'config', 'help', 'review', 'resume', 'init', 'deploy']) assert.ok(names.some((x) => x.startsWith(`/${n}`)), `palette lists /${n}`)
    await composer.pressSequentially('c')
    assert.equal(await composer.getAttribute('role'), 'combobox')
    assert.equal(await composer.getAttribute('aria-expanded'), 'true')
    assert.equal(await composer.getAttribute('aria-activedescendant'), 'palette-opt-0')
    await composer.pressSequentially('zz')
    await poll(async () => (await palette.count()) === 0, 'no match closes the palette')
    await composer.press('Backspace')
    await composer.press('Backspace')
    await palette.waitFor({ timeout: t })
    assert.ok((await items.count()) >= 3, 'filtering as you type')
    assert.match(await items.first().innerText(), /^\/compact/)
    await page.getByTestId('palette-desc').getByText('Resume la conversación').waitFor({ timeout: t })
    await composer.press('ArrowDown')
    assert.equal(await items.nth(1).locator('xpath=..').getAttribute('aria-selected'), 'true', 'ArrowDown moves the highlight')
    await page.getByTestId('palette-desc').getByText(/Empieza una conversación nueva/).waitFor({ timeout: t })
    await composer.press('ArrowUp')
    assert.equal(await items.first().locator('xpath=..').getAttribute('aria-selected'), 'true')
    await composer.press('Escape')
    assert.equal(await palette.count(), 0, 'Esc closes the palette')
    assert.equal(await composer.inputValue(), '/c', 'Esc keeps the draft')
    assert.equal(bytes(), '', 'nothing written by browsing the palette')
    await composer.fill('/dep')
    await items.first().click() // mouse pick
    assert.equal(await composer.inputValue(), '/deploy ', 'a pick fills `/name ` (no send)')
    assert.equal(bytes(), '', 'a pick writes nothing')
    await composer.fill('/comp')
    await composer.press('Enter')
    assert.equal(await composer.inputValue(), '/compact ')
    assert.equal(bytes(), '')
    await composer.press('Enter')
    await poll(() => bytes() === `${PS}/compact${PE}\r`, 'the send pasted exactly /compact + CR')
    await poll(() => cmds().includes('CMD:/compact'), 'the CLI received /compact as a command')
    await state('working')
    await page.getByText(/Conversación compactada/).first().waitFor({ timeout: t })
    await state('idle')

    // ---- a command that opens a picker: the terminal opens by itself right after the send ----
    let m = bytes().length
    await composer.fill('/mod')
    await items.first().waitFor({ timeout: t })
    assert.ok((await palette.innerText()).includes('abre un selector'), 'interactive commands are marked in the palette')
    await composer.press('Enter')
    assert.equal(await composer.inputValue(), '/model ')
    await composer.press('Enter')
    await poll(() => bytes().slice(m) === `${PS}/model${PE}\r`, '/model pasted')
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await page.getByRole('alert').filter({ hasText: '/model abre un selector' }).waitFor({ timeout: t })
    assert.equal(await chat.isVisible(), false, 'the picker command opened the terminal')
    await backToChat()

    // ---- `@`: project files only, inserted as @path, sent as part of the paste ----
    m = bytes().length
    await composer.pressSequentially('mira @')
    await palette.waitFor({ timeout: t })
    await poll(async () => (await items.count()) >= 2, '@ list loaded')
    const files = await items.allInnerTexts()
    assert.deepEqual(files.map((x) => x.trim()).sort(), ['README.md', 'src/app.ts'], `only project files are listed (got ${files.join(', ')})`)
    for (const bad of ['node_modules', '.env', '.git', 'link-out', 'dir-out', 'secret', 'espacio']) assert.ok(!files.some((f) => f.includes(bad)), `${bad} is not listed`)
    assert.equal(bytes().slice(m), '', '`@` writes nothing to the pty')
    await composer.pressSequentially('app')
    assert.equal(await items.count(), 1)
    await composer.press('Enter')
    assert.equal(await composer.inputValue(), 'mira @src/app.ts ')
    assert.equal(bytes().slice(m), '')
    await composer.press('Enter')
    await poll(() => bytes().slice(m) === `${PS}mira @src/app.ts${PE}\r`, 'the mention travelled inside the paste')
    await chat.getByText('Respuesta a: mira @src/app.ts').waitFor({ timeout: t })
    await state('idle')

    // ---- "+" menu: attach (inserts @ and opens the file list) and commands ----
    m = bytes().length
    await pick('plus-menu', 'Adjuntar archivo…')
    assert.equal(await composer.inputValue(), '@')
    await palette.waitFor({ timeout: t })
    await poll(async () => (await items.count()) === 2, 'file list from the + menu')
    await composer.press('Escape')
    await composer.fill('')
    await pick('plus-menu', 'Comandos /')
    assert.equal(await composer.inputValue(), '/')
    await palette.waitFor({ timeout: t })
    await composer.fill('')
    assert.equal(bytes().slice(m), '', 'the + menu writes nothing')

    // ---- mode: Shift+Tab one press at a time, verified against the footer, exact bytes ----
    m = bytes().length
    await pick('info-mode', 'Plan')
    await poll(async () => (await label('info-mode')) === 'Plan', 'mode is Plan')
    assert.equal(bytes().slice(m), '\x1b[Z\x1b[Z', 'manual -> plan = exactly two Shift+Tab')
    m = bytes().length
    await page.getByTestId('info-mode').click()
    await page.getByRole('menuitem', { name: 'Auto', exact: true }).click()
    const auto = page.getByRole('dialog', { name: 'Cambiar a modo Auto' })
    await auto.waitFor({ timeout: t })
    assert.equal(await auto.getByRole('button', { name: 'Cancelar' }).evaluate((el) => el === document.activeElement), true, 'the safe button has the focus')
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'nothing before the confirmation')
    await auto.getByRole('button', { name: 'Cancelar' }).click()
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'cancelling sends nothing')
    assert.equal(await label('info-mode'), 'Plan')
    await page.getByTestId('info-mode').click()
    await page.getByRole('menuitem', { name: 'Auto', exact: true }).click()
    await auto.getByRole('button', { name: 'Cambiar a Auto' }).click()
    await poll(async () => (await label('info-mode')) === 'Auto', 'mode is Auto')
    assert.equal(bytes().slice(m), '\x1b[Z', 'plan -> auto = one press')
    m = bytes().length
    await pick('info-mode', 'Manual')
    await poll(async () => (await label('info-mode')) === 'Manual', 'mode is Manual')
    assert.equal(bytes().slice(m), '\x1b[Z', 'auto -> manual wraps with one press')
    // Plan -> Manual crosses Auto (the cycle only goes forward): it asks first, with the safe button focused
    await pick('info-mode', 'Plan')
    await poll(async () => (await label('info-mode')) === 'Plan', 'mode is Plan again')
    m = bytes().length
    await pick('info-mode', 'Plan') // already active: a no-op, no dialog, no key
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'choosing the active mode sends nothing')
    assert.equal(await page.getByRole('dialog').count(), 0, 'and shows no dialog')
    await page.getByTestId('info-mode').click()
    await page.getByRole('menuitem', { name: 'Manual', exact: true }).click()
    const thru = page.getByRole('dialog', { name: 'Cambiar a modo Auto' })
    await thru.waitFor({ timeout: t })
    assert.ok((await thru.innerText()).includes('pasa un momento por el modo Auto'), 'the dialog says the cycle passes through Auto')
    assert.equal(await thru.getByRole('button', { name: 'Cancelar' }).evaluate((el) => el === document.activeElement), true)
    await thru.getByRole('button', { name: 'Cancelar' }).click()
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'cancelling sends nothing')
    await page.getByTestId('info-mode').click()
    await page.getByRole('menuitem', { name: 'Manual', exact: true }).click()
    await thru.getByRole('button', { name: 'Continuar' }).click()
    await poll(async () => (await label('info-mode')) === 'Manual', 'mode is Manual after crossing Auto')
    assert.equal(bytes().slice(m), '\x1b[Z\x1b[Z', 'plan -> auto -> manual = two presses')
    // stranded in Auto: Plan -> Manual, the CLI ignores the 2nd press -> it stays in Auto: the terminal opens and a persistent error says so
    await pick('info-mode', 'Plan')
    await poll(async () => (await label('info-mode')) === 'Plan', 'mode is Plan before the stranding test')
    writeFileSync(ctl, 'dropsecond')
    await page.waitForTimeout(400)
    m = bytes().length
    await page.getByTestId('info-mode').click()
    await page.getByRole('menuitem', { name: 'Manual', exact: true }).click()
    await thru.getByRole('button', { name: 'Continuar' }).click()
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await page.getByRole('alert').filter({ hasText: 'quedó en modo Auto' }).waitFor({ timeout: t })
    assert.equal(bytes().slice(m), '\x1b[Z\x1b[Z', 'two presses were sent, the CLI ignored the second')
    await page.getByRole('alert').filter({ hasText: 'quedó en modo Auto' }).getByRole('button', { name: 'Cerrar aviso' }).click() // errors stay until dismissed
    writeFileSync(ctl, '')
    await page.waitForTimeout(400)
    await backToChat()
    assert.equal(await label('info-mode'), 'Auto', 'the footer says the CLI really is in Auto')
    await pick('info-mode', 'Manual') // back to Manual (auto -> manual does not cross Auto again)
    await poll(async () => (await label('info-mode')) === 'Manual', 'mode is Manual again')
    // a CLI that ignores the key: one press, the footer did not move -> stop and open the terminal (no more keys)
    m = bytes().length
    writeFileSync(ctl, 'dropkey')
    await page.waitForTimeout(400)
    await pick('info-mode', 'Aceptar ediciones')
    await term.locator('.xterm').waitFor({ state: 'visible', timeout: t })
    await page.getByRole('alert').filter({ hasText: 'no pudo comprobar el modo' }).waitFor({ timeout: t })
    assert.equal(bytes().slice(m), '\x1b[Z', 'a press that changed nothing stops the cycle')
    writeFileSync(ctl, '')
    await page.waitForTimeout(400)
    await backToChat()

    // ---- model: warning first, then /model <name> ----
    m = bytes().length
    await pick('info-model', 'Sonnet')
    const mdl = page.getByRole('dialog', { name: 'Cambiar el modelo' })
    await mdl.waitFor({ timeout: t })
    assert.ok((await mdl.innerText()).includes('predeterminado de la cuenta'), 'the dialog says the account default changes')
    assert.equal(await mdl.getByRole('button', { name: 'Cancelar' }).evaluate((el) => el === document.activeElement), true)
    await mdl.getByRole('button', { name: 'Cancelar' }).click()
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'cancelling sends nothing')
    await pick('info-model', 'Sonnet')
    await mdl.getByRole('button', { name: 'Cambiar a Sonnet' }).click()
    await poll(() => bytes().slice(m) === `${PS}/model sonnet${PE}\r`, '/model sonnet pasted')
    await poll(async () => (await label('info-model')).includes('sonnet'), 'the current model follows the transcript')
    await state('idle')

    // ---- context ring ----
    const ring = page.getByTestId('info-context')
    await ring.waitFor({ timeout: t })
    assert.match((await ring.getAttribute('title')) ?? '', /^\d[\d.,]* tokens de contexto/)
    assert.equal(await ring.locator('svg').count(), 1, 'a known model family gets a ring')

    // ---- compact and clear from the "…" menu ----
    m = bytes().length
    await pick('more-menu', 'Compactar conversación')
    await poll(() => bytes().slice(m) === `${PS}/compact${PE}\r`, 'Compactar pasted /compact (no confirmation)')
    await state('working')
    await state('idle')
    m = bytes().length
    await pick('more-menu', 'Limpiar conversación')
    const clr = page.getByRole('dialog', { name: 'Limpiar la conversación' })
    await clr.waitFor({ timeout: t })
    assert.equal(await clr.getByRole('button', { name: 'Cancelar' }).evaluate((el) => el === document.activeElement), true)
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '', 'nothing before the confirmation')
    await clr.getByRole('button', { name: 'Cancelar' }).click()
    await page.waitForTimeout(300)
    assert.equal(bytes().slice(m), '')
    await pick('more-menu', 'Limpiar conversación')
    await clr.getByRole('button', { name: 'Limpiar', exact: true }).click()
    await poll(() => bytes().slice(m) === `${PS}/clear${PE}\r`, 'Limpiar pasted /clear')
    await poll(async () => (await chat.getByText('Respuesta a: mira @src/app.ts').count()) === 0, 'the chat follows the new session (the old one is gone)')
    assert.equal(readdirSync(join(cfg, 'projects', enc)).filter((f) => f.endsWith('.jsonl')).length, 2, '/clear opened a second session file')
    await composer.fill('tras clear')
    await composer.press('Enter')
    await chat.getByText('Respuesta a: tras clear').waitFor({ timeout: t })
    await state('idle')

    // ---- busy: palettes work on the draft, controls and sends do nothing ----
    await composer.fill('trabaja un rato')
    await composer.press('Enter')
    await state('working')
    m = bytes().length
    await page.getByTestId('info-mode').click()
    assert.equal(await page.getByRole('menuitem', { name: 'Plan', exact: true }).isDisabled(), true, 'mode items are disabled while working')
    await page.getByTestId('info-model').click()
    assert.equal(await page.getByRole('menuitem', { name: 'Haiku', exact: true }).isDisabled(), true)
    await page.getByTestId('more-menu').click()
    assert.equal(await page.getByRole('menuitem', { name: 'Compactar conversación' }).isDisabled(), true)
    assert.equal(await page.getByRole('menuitem', { name: 'Limpiar conversación' }).isDisabled(), true)
    await page.getByRole('menuitem', { name: 'Compactar conversación' }).click({ force: true, timeout: 1000 }).catch(() => undefined)
    await composer.fill('/comp')
    await palette.waitFor({ timeout: t })
    await composer.press('Enter') // picks
    await composer.press('Enter') // blocked: working
    await page.getByTestId('composer-hint').getByText(/Espera a que el CLI termine/).waitFor({ timeout: t })
    await page.waitForTimeout(400)
    assert.equal(bytes().slice(m), '', 'nothing was written while the CLI was busy')
    await composer.fill('')
    await page.getByRole('button', { name: 'Parar', exact: true }).click()
    await state('idle')

    // ---- fits with the palette open, screenshots ----
    await composer.fill('/')
    await palette.waitFor({ timeout: t })
    for (const size of [[1280, 800], [900, 600]]) {
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), size)
      await page.waitForTimeout(500)
      assert.deepEqual(await mainOverflow(page, true), [], `main content overflows with the palette open (${size[0]}px)`)
      await sidebarFits(page, `palette ${size[0]}px`)
      const pb = await palette.boundingBox()
      const cb = await page.locator('main').boundingBox()
      assert.ok(pb && cb && pb.x >= cb.x - 0.5 && pb.x + pb.width <= cb.x + cb.width + 0.5 && pb.y >= 0, `the palette stays inside the window (${size[0]}px)`)
      const ab = await page.getByTestId('activity').boundingBox()
      assert.ok(ab && pb.y + pb.height <= ab.y + 1, `the palette does not cover the activity line (${size[0]}px)`)
      const db = await page.getByTestId('palette-desc').boundingBox()
      assert.ok(db && db.x + db.width <= cb.x + cb.width + 0.5, `the description card stays inside main (${size[0]}px)`)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await page.waitForTimeout(500)
    await page.emulateMedia({ colorScheme: 'dark' })
    await composer.fill('/')
    await composer.press('ArrowDown')
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(shots, 'palette-dark.png') })
    await composer.fill('')
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(400)
      if (scheme === 'dark') await page.getByTestId('info-mode').click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `controls-${scheme}.png`) })
      await composer.click()
    }
    await page.emulateMedia({ colorScheme: null })
    for (const b of ['\x03', '\x04', '\x1a']) assert.ok(!bytes().includes(b), `no ${JSON.stringify(b)} ever reached the pty`)
    assert.ok(!existsSync(join(d.home, '.claude')), 'nothing written outside the temp HOME')
  } finally {
    await app.close()
  }
}
// ---- scenario 7: only Codex installed -> the onboarding account dialog defaults to Codex ----
{
  const d = setup('seven')
  copyFileSync(cstub, join(d.bin, 'codex'))
  const app = await launch(d)
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.getByText('Bienvenido a Relay').waitFor({ timeout: t })
    await page.getByText('no instalado', { exact: true }).waitFor({ timeout: t })
    const btn = page.getByRole('button', { name: 'Iniciar sesión con una cuenta nueva' })
    assert.ok(await btn.isEnabled(), 'enabled when Codex is installed')
    await btn.click()
    const dlg = page.getByRole('dialog', { name: 'Nombre de la cuenta' })
    assert.equal(await dlg.getByLabel('Proveedor').inputValue(), 'codex')
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
}
console.log('e2e OK; screenshots in', shots)
