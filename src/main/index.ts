import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, Notification, app, dialog, ipcMain } from 'electron'
import type { Account, HandoffRequest, StartRequest, StartResult } from '../shared/types'
import { buildEnv } from './env'
import { copySessionForHandoff, runHandoff, sourceExists } from './handoff'
import { killAccountPtys, killAll, killPty, ptyInfo, resizePty, spawnPty, writePty } from './pty'
import { providers } from './providers'
import { type LimitInfo, scheduleAt, watchLimits } from './limit'
import { claudeProjectDir } from './paths'
import { loadPrefs, savePrefs } from './prefs'
import { listSessions } from './sessions'
import { accountStatus } from './usage'
import { addAccount, addProject, isManaged, loadAccounts, loadCopies, loadProjects, recordCopy, removeAccount, renameAccount } from './store'
import { checkAccountId, checkHandoff, checkNewAccount, checkRename, checkStart } from './validate'

const HOME = join(homedir(), '.relay')
let win: BrowserWindow

const list = (): Account[] => loadAccounts(HOME).map((a) => ({ ...a, managed: isManaged(HOME, a) }))

const send = (ch: string, ...a: unknown[]): void => {
  if (!win.isDestroyed()) win.webContents.send(ch, ...a)
}

const watchers = new Map<number, { stop(): void }>()
const reminders = new Map<string, () => void>()

function notify(title: string, onClick?: () => void): void {
  const prefs = loadPrefs(HOME).notifications
  if (!prefs.system || !Notification.isSupported()) return
  const n = new Notification({ title, silent: !prefs.sound })
  n.on('click', () => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
    onClick?.()
  })
  n.show()
}

function onLimit(ptyId: number, a: Account, sessionId: string, h: LimitInfo): void {
  notify(`${a.label} llegó a su límite · se reinicia ${h.resetText}`, () => send('tab:focus', ptyId))
  send('limit:hit', { ptyId, accountId: a.id, sessionId, ...h })
}

async function start(req: StartRequest): Promise<StartResult> {
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
    args = p.resumeArgs(sid)
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
    (id, d) => send('pty:data', id, d),
    (id, code) => {
      watchers.get(id)?.stop()
      watchers.delete(id)
      send('pty:exit', id, code)
    }
  )
  // live quota detection: tail this session's transcript from its current end
  if (sid && a.provider === 'claude') {
    const w = watchLimits(join(claudeProjectDir(a.configDir, dir), `${sid}.jsonl`), (h) => onLimit(ptyId, a, sid, h))
    watchers.set(ptyId, w)
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
  ipcMain.handle('accounts:rename', (_e, id: string, label: string) => {
    const lbl = checkRename(id, label, loadAccounts(HOME))
    renameAccount(HOME, id, lbl)
    return list()
  })
  ipcMain.handle('accounts:remove', async (_e, id: string) => {
    checkAccountId(id, loadAccounts(HOME))
    await removeAccount(HOME, id, () => killAccountPtys(id))
    return list()
  })
  ipcMain.handle('accounts:status', (_e, id: string, refresh?: boolean) => {
    const a = checkAccountId(id, loadAccounts(HOME))
    return accountStatus(a, refresh === true, loadCopies(HOME)[a.id])
  })
  ipcMain.handle('projects:list', () => loadProjects(HOME))
  ipcMain.handle('projects:add', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    const dir = r.canceled ? undefined : r.filePaths[0]
    return dir ? addProject(HOME, dir) : loadProjects(HOME)
  })
  ipcMain.handle('sessions:list', (_e, cwd: string) =>
    loadProjects(HOME).includes(cwd) ? listSessions(loadAccounts(HOME), cwd) : []
  )
  ipcMain.handle('pty:start', (_e, req: StartRequest) => start(req))
  ipcMain.handle('prefs:get', () => loadPrefs(HOME))
  ipcMain.handle('prefs:set', (_e, patch) => savePrefs(HOME, patch))
  ipcMain.handle('limit:remind', (_e, accountId: string, resetAt: number) => {
    const a = checkAccountId(accountId, loadAccounts(HOME))
    if (typeof resetAt !== 'number') throw new Error('Invalid resetAt')
    reminders.get(a.id)?.()
    reminders.set(a.id, scheduleAt(resetAt, () => notify(`${a.label} ya tiene cuota disponible`)))
  })
  ipcMain.handle('pty:kill', (_e, id: number) => killPty(id))
  ipcMain.on('pty:write', (_e, id: number, d: string) => writePty(id, d))
  ipcMain.on('pty:resize', (_e, id: number, c: number, r: number) => resizePty(id, c, r))
  ipcMain.handle('handoff', (_e, req: HandoffRequest) => {
    const [from, to] = checkHandoff(req, loadAccounts(HOME), loadProjects(HOME))
    const owner = ptyInfo(req.ptyId) // undefined = already exited (killing it is a no-op)
    if (owner && (owner.accountId !== from.id || owner.sessionId !== req.sessionId)) throw new Error('pty does not belong to the source account and session')
    if (!sourceExists(from, req.cwd, req.sessionId)) throw new Error('Session has no transcript yet (send a first message before switching)')
    return runHandoff(
      () => killPty(req.ptyId),
      () => {
        const r = copySessionForHandoff(from, to, req.cwd, req.sessionId)
        recordCopy(HOME, to.id, req.sessionId, r)
      },
      () => start({ accountId: to.id, cwd: req.cwd, mode: 'resume', sessionId: req.sessionId })
    )
  })
}

app.whenReady().then(() => {
  handle()
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1f1e1d',
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
