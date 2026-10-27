// Smoke test of the built app with a fake `claude`, a temp RELAY_HOME and a temp HOME: never touches ~/.relay or a real claude.
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  "auth login") sleep 1; exit 0 ;;
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
  const app = await launch(d)
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.getByText('Bienvenido a Relay').waitFor({ timeout: t })
    await page.getByText('instalado · 2.1.0').waitFor({ timeout: t })
    await page.getByText('Instalación por defecto · test@example.com').waitFor({ timeout: t })
    await page.getByText('sin comprobar').waitFor({ timeout: t })
    await page.screenshot({ path: join(shots, 'onboarding.png') })

    await page.getByRole('button', { name: 'Iniciar sesión con una cuenta nueva' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('textbox').fill('Test')
    await dlg.getByRole('textbox').press('Enter')
    await page.getByText('Sesión iniciada').waitFor({ timeout: t }) // login tab ran and exited, status refreshed
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByText('Agrega un proyecto').waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Omitir' }).click() // project step is skippable

    const card = page.getByTestId('account-card')
    await card.getByText('Test', { exact: true }).waitFor({ timeout: t })
    await card.getByText('test@example.com').waitFor({ timeout: t })
    await page.screenshot({ path: join(shots, 'dashboard.png') })
    assert.ok(existsSync(join(d.relayHome, 'accounts.json')), 'account stored under RELAY_HOME')

    await page.getByRole('button', { name: 'Configuración' }).click()
    await page.getByRole('heading', { name: 'Cuentas' }).waitFor({ timeout: t })
    await page.getByRole('button', { name: '← Volver' }).click()
    await card.waitFor({ timeout: t })

    await page.getByTitle('Opciones de cuenta').click()
    await page.getByRole('menuitem', { name: 'Renombrar' }).click()
    await dlg.getByRole('textbox').fill('Renamed')
    await dlg.getByRole('textbox').press('Enter')
    await card.getByText('Renamed', { exact: true }).waitFor({ timeout: t })
  } finally {
    await app.close()
  }
  assert.deepEqual(readdirSync(join(d.home, '.claude-foo')), [], 'unimported candidate dir must stay untouched')
  const calls = readFileSync(log, 'utf8').split('\n')
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
    await page.getByText('no instalado').waitFor({ timeout: t })
    await page.getByRole('button', { name: 'Instalar Claude Code' }).click()
    await page.locator('.xterm').first().waitFor({ timeout: t }) // install pane visible inside onboarding
    await page.getByText('instalado · 2.1.0').waitFor({ timeout: t }) // re-detected after the installer exited
  } finally {
    await app.close()
  }
}
console.log('e2e OK; screenshots in', shots)
