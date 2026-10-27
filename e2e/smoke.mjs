// Smoke test of the built app with a fake `claude`, a temp RELAY_HOME and a temp HOME: never touches ~/.relay or a real claude.
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
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
  for (const c of Object.values(cfg)) mkdirSync(c)
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
console.log('e2e OK; screenshots in', shots)
