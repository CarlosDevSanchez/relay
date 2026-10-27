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
writeFileSync(
  stub,
  `#!/bin/bash
echo "\${CLAUDE_CONFIG_DIR-UNSET}|$*" >> "${log}"
case "$1 $2" in
  "auth status") [ -n "$CLAUDE_CONFIG_DIR" ] && touch "$CLAUDE_CONFIG_DIR/.claude.json"; echo '{"loggedIn":true,"email":"test@example.com","subscriptionType":"max"}' ;;
  "auth login") sleep 1; echo "Paste code here"; read -t 20 -r code; echo "CODE:$code" >> "${log}"; exit 0 ;;
  "--session-id "*|"--resume "*) sleep 1; echo "Claude Code (stub): sesión interactiva"; sleep 60 ;;
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
  return electron.launch({ args: [root], env })
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
    await card.getByText('test@example.com').waitFor({ timeout: t })
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
    assert.equal(await cards.getByTestId('provider-badge').filter({ hasText: 'codex' }).count(), 2, 'Codex accounts show a provider badge')
    await cards.filter({ hasText: 'Cx1' }).getByText('sesión iniciada').waitFor({ timeout: t }) // `codex login status` exit 0
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
console.log('e2e OK; screenshots in', shots)
