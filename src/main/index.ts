import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import type { HandoffRequest, StartRequest, StartResult } from '../shared/types'
import { buildEnv } from './env'
import { copySessionForHandoff, runHandoff } from './handoff'
import { killPty, resizePty, spawnPty, writePty } from './pty'
import { providers } from './providers'
import { listSessions } from './sessions'
import { addAccount, addProject, loadAccounts, loadProjects } from './store'
import { checkHandoff, checkNewAccount, checkStart } from './validate'

const HOME = join(homedir(), '.relay')
let win: BrowserWindow

const send = (ch: string, ...a: unknown[]): void => {
  if (!win.isDestroyed()) win.webContents.send(ch, ...a)
}

async function start(req: StartRequest): Promise<StartResult> {
  const { cwd, mode, sessionId } = req
  const a = checkStart(req, loadAccounts(HOME), loadProjects(HOME))
  await killPty()
  const p = providers[a.provider]
  let sid = sessionId
  let args: string[] = []
  let dir = cwd
  if (mode === 'new') {
    sid = randomUUID()
    args = p.newArgs(sid)
  } else if (mode === 'resume') {
    if (!sid) throw new Error('sessionId required')
    args = p.resumeArgs(sid)
  } else {
    dir = homedir() // login: bare CLI, user runs /login
    sid = undefined
  }
  const ptyId = spawnPty(
    p.bin,
    args,
    dir,
    buildEnv(a),
    (id, d) => send('pty:data', id, d),
    (id, code) => send('pty:exit', id, code)
  )
  return { ptyId, ...(sid ? { sessionId: sid } : {}) }
}

function handle(): void {
  ipcMain.handle('accounts:list', () => loadAccounts(HOME))
  ipcMain.handle('accounts:add', (_e, label: string, provider, configDir?: string) => {
    checkNewAccount(label, provider, configDir)
    return addAccount(HOME, label, provider, configDir)
  })
  ipcMain.handle('accounts:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'showHiddenFiles'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
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
  ipcMain.on('pty:write', (_e, id: number, d: string) => writePty(id, d))
  ipcMain.on('pty:resize', (_e, id: number, c: number, r: number) => resizePty(id, c, r))
  ipcMain.handle('handoff', (_e, req: HandoffRequest) => {
    const [from, to] = checkHandoff(req, loadAccounts(HOME), loadProjects(HOME))
    return runHandoff(
      killPty,
      () => void copySessionForHandoff(from, to, req.cwd, req.sessionId),
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

app.on('will-quit', () => void killPty())

app.on('window-all-closed', () => {
  app.quit()
})
