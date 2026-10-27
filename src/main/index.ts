import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, Notification, app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { Account, Candidate, HandoffRequest, StartRequest, StartResult } from '../shared/types'
import { buildEnv, plainEnv } from './env'
import { buildCatalog } from './catalog'
import { detectCli } from './cli'
import { mcpReport } from './mcp'
import { copySessionForHandoff, runHandoff, sourceExists } from './handoff'
import { hasLivePty, killAccountPtys, killAll, killPty, livePtyCount, markStale, ptyInfo, setPtySession, wasBound, resizePty, spawnPty, writePty } from './pty'
import { providers } from './providers'
import { type LimitInfo, scheduleAt, pickRebind, watchLimits, watchNewSession } from './limit'
import { candidateDirs, canProbe, claudeProjectDir, isDefaultInstall } from './paths'
import { loadPrefs, savePrefs } from './prefs'
import { drifted, linkAccount, nextFlag, sharedDir, unlinkAccount } from './shared'
import { listSessions } from './sessions'
import { accountStatus } from './usage'
import { addAccount, addProject, isManaged, loadAccounts, loadCopies, loadProjects, pruneCopies, recordCopy, removeAccount, renameAccount, setSharedMemory } from './store'
import { checkAccountId, checkHandoff, checkInstall, checkNewAccount, checkReminder, checkRename, checkSharedToggle, checkStart } from './validate'

const HOME = process.env.RELAY_HOME || join(homedir(), '.relay')
let win: BrowserWindow

const list = (): Account[] =>
  loadAccounts(HOME).map((a) => {
    const d = a.sharedMemory ? drifted(HOME, a) : []
    return { ...a, managed: isManaged(HOME, a), ...(isDefaultInstall(a.configDir, homedir()) ? { defaultInstall: true } : {}), ...(d.length ? { drift: d } : {}) }
  })

const send = (ch: string, ...a: unknown[]): void => {
  if (!win.isDestroyed()) win.webContents.send(ch, ...a)
}

const watchers = new Map<number, { stop(): void }>()
const reminders = new Map<string, () => void>()

const live = new Set<Notification>() // keep a reference until click/close, or GC may drop the click

function notify(title: string, onClick?: () => void, force = false): boolean {
  const prefs = loadPrefs(HOME).notifications
  if ((!prefs.system && !force) || !Notification.isSupported()) return false
  const n = new Notification({ title, silent: !prefs.sound })
  live.add(n)
  setTimeout(() => live.delete(n), 10 * 60_000).unref() // macOS may never fire close
  n.on('click', () => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
    onClick?.()
  })
  for (const ev of ['click', 'close', 'failed'] as const) n.on(ev as 'click', () => live.delete(n))
  n.show()
  return true
}

const ptyData = (id: number, d: string): void => send('pty:data', id, d)
const ptyExit = (id: number, code: number): void => {
  watchers.get(id)?.stop()
  watchers.delete(id)
  send('pty:exit', id, code)
}

function onLimit(ptyId: number, a: Account, sessionId: string, h: LimitInfo): void {
  notify(`${a.label} llegó a su límite · se reinicia ${h.resetText}`, () => send('tab:focus', ptyId))
  send('limit:hit', { ptyId, accountId: a.id, sessionId, ...h })
}

async function start(req: StartRequest, message?: string): Promise<StartResult> {
  const { cwd, mode, sessionId } = req
  const a = checkStart(req, loadAccounts(HOME), loadProjects(HOME))
  const p = providers[a.provider]
  let sid = sessionId
  let args: string[] = p.loginArgs
  let dir = cwd
  if (mode === 'new') {
    sid = randomUUID()
    args = p.newArgs(sid)
  } else if (mode === 'resume') {
    if (!sid) throw new Error('sessionId required')
    args = p.resumeArgs(sid, message)
  } else {
    dir = homedir() // login: official `auth login` flow
    sid = undefined
  }
  const ptyId = spawnPty(
    p.bin,
    args,
    dir,
    buildEnv(a),
    a.id,
    sid,
    ptyData,
    ptyExit
  )
  // live quota detection: tail the session transcript from its current end; follow /clear (new session id)
  if (sid && a.provider === 'claude') {
    const projDir = claudeProjectDir(a.configDir, dir)
    const tail = (id: string) => watchLimits(join(projDir, `${id}.jsonl`), (h) => onLimit(ptyId, a, id, h))
    let cur = sid
    let t = tail(cur)
    const cands = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    const decide = (): void => {
      timer = undefined
      const d = pickRebind([...cands].filter((id) => !wasBound(id)), livePtyCount(a.id, dir))
      cands.clear()
      if (d === 'stale') {
        markStale(ptyId) // keep limit detection on the old file; handoff is refused for this tab
        nw.stop()
        send('pty:stale', ptyId)
      } else if (d) {
        t.stop()
        cur = d.id
        t = tail(d.id)
        setPtySession(ptyId, d.id)
        send('pty:session', ptyId, d.id)
      }
    }
    const nw = watchNewSession(projDir, Date.now(), (id) => id === cur || wasBound(id), (ids) => {
      ids.forEach((i) => cands.add(i))
      timer ??= setTimeout(decide, 1500) // let a second candidate show up before deciding
    })
    watchers.set(ptyId, { stop: () => (t.stop(), nw.stop(), clearTimeout(timer)) })
  }
  return { ptyId, ...(sid ? { sessionId: sid } : {}) }
}

function handle(): void {
  ipcMain.handle('accounts:list', list)
  ipcMain.handle('accounts:add', (_e, label: string, provider, configDir?: string) => {
    checkNewAccount(label, provider, configDir, HOME)
    const a = addAccount(HOME, label, provider, configDir)
    return { ...a, managed: isManaged(HOME, a) }
  })
  ipcMain.handle('accounts:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'showHiddenFiles'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('accounts:candidates', async (): Promise<Candidate[]> => {
    const home = homedir()
    return Promise.all(
      candidateDirs(home, loadAccounts(HOME).map((a) => a.configDir)).map(async (dir): Promise<Candidate> => {
        const def = isDefaultInstall(dir, home) ? { default: true } : {}
        if (!canProbe(dir, home)) return { dir, loggedIn: null, unchecked: true, ...def } // probing would write into it
        const s = await accountStatus({ id: `cand:${dir}`, label: '', provider: 'claude', configDir: dir }, true)
        return { dir, loggedIn: s.loggedIn, ...def, ...(s.email ? { email: s.email } : {}), ...(s.plan ? { plan: s.plan } : {}) }
      })
    )
  })
  ipcMain.handle('accounts:rename', (_e, id: string, label: string) => {
    const lbl = checkRename(id, label, loadAccounts(HOME))
    renameAccount(HOME, id, lbl)
    return list()
  })
  ipcMain.handle('accounts:remove', async (_e, id: string) => {
    const acc = checkAccountId(id, loadAccounts(HOME))
    // an imported dir must be left self-contained: links -> real copies first (abort on failure)
    if (acc.provider === 'claude' && !isManaged(HOME, acc) && existsSync(acc.configDir)) {
      await killAccountPtys(id)
      const r = unlinkAccount(HOME, acc)
      if (r.errors.length) throw new Error(`No se pudo restaurar la memoria local: ${r.errors.join('; ')}`)
    }
    reminders.get(id)?.()
    reminders.delete(id)
    await removeAccount(HOME, id, () => killAccountPtys(id))
    pruneCopies(HOME)
    return list()
  })
  ipcMain.handle('accounts:status', (_e, id: string, refresh?: boolean) => {
    const a = checkAccountId(id, loadAccounts(HOME))
    return accountStatus(a, refresh === true, loadCopies(HOME)[a.id])
  })
  ipcMain.handle('shared:set', async (_e, id: unknown, enabled: unknown) => {
    const a = checkSharedToggle(id, enabled, loadAccounts(HOME))
    if (hasLivePty(a.id)) throw new Error('Cierra las pestañas de esta cuenta antes de cambiar la memoria compartida')
    const on = enabled === true // validated boolean
    if (on && !isManaged(HOME, a)) {
      const c = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Cancelar', 'Activar'],
        defaultId: 0,
        cancelId: 0,
        message: `Activar memoria compartida en "${a.label}" (${a.configDir})?`,
        detail: `Se reemplazarán por enlaces a ~/.relay/shared: CLAUDE.md, skills/, agents/, commands/ y projects/*/memory de tus proyectos. Su contenido se mueve a la memoria compartida y lo que choque se guarda en ~/.relay/backups/${a.id}/<fecha>/. No se tocan credenciales, ajustes ni historial. Al desactivar o quitar la cuenta se restauran copias reales.`
      })
      if (c.response !== 1) return { accounts: list(), report: { linked: [], backups: [], notes: ['Cancelado'], errors: [] } }
    }
    if (hasLivePty(a.id)) throw new Error('Cierra las pestañas de esta cuenta antes de cambiar la memoria compartida') // a tab may have opened during the dialog
    const report = on ? linkAccount(HOME, a, loadProjects(HOME)) : unlinkAccount(HOME, a)
    // a partial link still leaves links behind, so it is saved as requested; a failed unlink keeps an already-on flag so it can be retried
    setSharedMemory(HOME, a.id, nextFlag(on, report.errors.length, a.sharedMemory))
    return { accounts: list(), report }
  })
  ipcMain.handle('shared:open', async () => {
    mkdirSync(sharedDir(HOME), { recursive: true })
    await shell.openPath(sharedDir(HOME))
    return { dir: sharedDir(HOME), claudeMd: join(sharedDir(HOME), 'CLAUDE.md') }
  })
  ipcMain.handle('projects:list', () => loadProjects(HOME))
  ipcMain.handle('projects:add', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    const dir = r.canceled ? undefined : r.filePaths[0]
    if (!dir) return loadProjects(HOME)
    const all = addProject(HOME, dir)
    for (const a of loadAccounts(HOME).filter((x) => x.sharedMemory)) {
      // new project: link its memory too
      if (hasLivePty(a.id)) send('shared:notice', `${a.label}: vuelve a activar la memoria compartida (sin pestañas abiertas) para enlazar el nuevo proyecto`)
      else {
        const r = linkAccount(HOME, a, all)
        if (r.errors.length) send('shared:notice', `${a.label}: memoria compartida con errores\n${r.errors.join('\n')}`)
      }
    }
    return all
  })
  ipcMain.handle('sessions:list', (_e, cwd: string) =>
    loadProjects(HOME).includes(cwd) ? listSessions(loadAccounts(HOME), cwd) : []
  )
  ipcMain.handle('cli:detect', async () => {
    const env = plainEnv()
    const [claude, codex] = await Promise.all([detectCli(providers.claude.bin, env), detectCli(providers.codex.bin, env)])
    return { claude, codex }
  })
  ipcMain.handle('cli:install', async (_e, provider: unknown) => {
    const c = checkInstall(provider, app.isPackaged ? undefined : process.env.RELAY_E2E_INSTALL_SCRIPT) // the command comes from providers.ts, never from the renderer
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancelar', 'Instalar'],
      defaultId: 0,
      cancelId: 0,
      message: `Instalar el CLI oficial (${provider})`,
      detail: `Se ejecutará el instalador oficial de Anthropic en una terminal visible:\n\n${c.display}\n\nRelay no descarga nada por sí mismo.`
    })
    if (r.response !== 1) return null
    return spawnPty(c.bin, c.args, homedir(), plainEnv(), '__install__', undefined, ptyData, ptyExit)
  })
  ipcMain.handle('catalog:list', () => buildCatalog(HOME, loadAccounts(HOME)))
  ipcMain.handle('catalog:open', async (_e, id: unknown) => {
    await shell.openPath(checkAccountId(id, loadAccounts(HOME)).configDir)
  })
  ipcMain.handle('mcp:list', () => mcpReport(loadAccounts(HOME), loadProjects(HOME), homedir()))
  ipcMain.handle('notify:test', () => notify('Relay: notificación de prueba', undefined, true))
  ipcMain.handle('pty:start', (_e, req: StartRequest) => start(req))
  ipcMain.handle('prefs:get', () => loadPrefs(HOME))
  ipcMain.handle('prefs:set', (_e, patch) => savePrefs(HOME, patch))
  ipcMain.handle('limit:remind', (_e, accountId: string, resetAt: number) => {
    const a = checkAccountId(accountId, loadAccounts(HOME))
    checkReminder(resetAt)
    reminders.get(a.id)?.()
    reminders.set(
      a.id,
      scheduleAt(resetAt, () => {
        reminders.delete(a.id)
        send('limit:reminder', a.id) // always shown in-app; the system notification follows prefs
        notify(`${a.label} ya tiene cuota disponible`)
      })
    )
  })
  ipcMain.handle('pty:kill', (_e, id: number) => killPty(id))
  ipcMain.on('pty:write', (_e, id: number, d: string) => writePty(id, d))
  ipcMain.on('pty:resize', (_e, id: number, c: number, r: number) => resizePty(id, c, r))
  ipcMain.handle('handoff', (_e, req: HandoffRequest) => {
    const [from, to] = checkHandoff(req, loadAccounts(HOME), loadProjects(HOME))
    const owner = ptyInfo(req.ptyId) // undefined = already exited (killing it is a no-op)
    if (owner?.stale) throw new Error('Sesión cambiada dentro del CLI; vuelve a abrirla desde el sidebar para poder continuarla en otra cuenta')
    if (owner && (owner.accountId !== from.id || owner.sessionId !== req.sessionId)) throw new Error('pty does not belong to the source account and session')
    if (!sourceExists(from, req.cwd, req.sessionId)) throw new Error('Session has no transcript yet (send a first message before switching)')
    // auto-continue only here: this IPC is reached after an explicit user confirmation (menu confirm or limit-modal click)
    const h = loadPrefs(HOME).handoff
    const message = h.autoContinue && providers[to.provider].resumePrompt ? h.message : undefined
    return runHandoff(
      () => killPty(req.ptyId),
      () => {
        const r = copySessionForHandoff(from, to, req.cwd, req.sessionId)
        recordCopy(HOME, to.id, req.sessionId, r)
      },
      () => start({ accountId: to.id, cwd: req.cwd, mode: 'resume', sessionId: req.sessionId }, message)
    ).then((r) => (message ? { ...r, autoContinued: true } : r))
  })
}

app.whenReady().then(() => {
  pruneCopies(HOME)
  handle()
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1917' : '#faf8f5',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
})

app.on('will-quit', () => void killAll())

app.on('window-all-closed', () => {
  app.quit()
})
