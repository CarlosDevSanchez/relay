// Smoke test of the built app with fake `claude` / `codex` binaries, a temp RELAY_HOME and a temp HOME: never touches ~/.relay or a real CLI.
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
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
case "$1 $2" in
  "auth status") [ -n "$CLAUDE_CONFIG_DIR" ] && touch "$CLAUDE_CONFIG_DIR/.claude.json"; echo "{\\"loggedIn\\":true,\\"email\\":\\"\${STUB_EMAIL:-test@example.com}\\",\\"subscriptionType\\":\\"max\\"}" ;;
  "auth login") sleep 1; echo "Paste code here"; read -t 20 -r code; echo "CODE:$code" >> "${log}"; exit 0 ;;
  "--session-id "*|"--resume "*) sleep 1; echo "Claude Code (stub): sesión interactiva"; session ;;
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
  const env = { ...process.env, RELAY_HOME: d.relayHome, HOME: d.home, PATH: `${d.bin}:/usr/bin:/bin`, ...extra }
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
      const bad = await page.evaluate((withTab) => {
        const m = document.querySelector('main')
        const out = []
        if (m.scrollWidth > m.clientWidth) out.push(`main scrollWidth ${m.scrollWidth} > ${m.clientWidth}`)
        const mr = m.getBoundingClientRect()
        const isBox = (el) => /flex|grid/.test(getComputedStyle(el).display)
        for (const el of m.querySelectorAll('*')) {
          if (getComputedStyle(el).visibility === 'hidden' || !el.clientWidth) continue
          const r = el.getBoundingClientRect()
          if (r.right > mr.right + 0.5) out.push(`${el.tagName} right ${Math.round(r.right)} > ${Math.round(mr.right)}`)
          if (el.closest('.xterm') || el.tagName === 'SELECT' || el.classList.contains('tab')) continue // exempt: xterm's own scrolling viewport; native <select> (scrollWidth = option width); daisyUI .tab (tabs-lift corner pseudo-elements stick out ~8px, children are still checked against main's box)
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
