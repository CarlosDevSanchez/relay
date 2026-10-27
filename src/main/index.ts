import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import type { Account, HandoffRequest, StartRequest, StartResult } from '../shared/types'
import { buildEnv } from './env'
import { copySessionForHandoff } from './handoff'
import { killPty, resizePty, spawnPty, writePty } from './pty'
import { providers } from './providers'
import { listSessions } from './sessions'
import { addAccount, addProject, loadAccounts, loadProjects } from './store'

const HOME = join(homedir(), '.relay')
let win: BrowserWindow

const account = (id: string): Account => {
  const a = loadAccounts(HOME).find((x) => x.id === id)
  if (!a) throw new Error(`Unknown account ${id}`)
  return a
}

function start({ accountId, cwd, mode, sessionId }: StartRequest): StartResult {
  const a = account(accountId)
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
    (id, d) => win.webContents.send('pty:data', id, d),
    (id, code) => win.webContents.send('pty:exit', id, code)
  )
  return { ptyId, ...(sid ? { sessionId: sid } : {}) }
}

function handle(): void {
  ipcMain.handle('accounts:list', () => loadAccounts(HOME))
  ipcMain.handle('accounts:add', (_e, label: string, provider, configDir?: string) =>
    addAccount(HOME, label, provider, configDir)
  )
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
  ipcMain.handle('sessions:list', (_e, cwd: string) => listSessions(loadAccounts(HOME), cwd))
  ipcMain.handle('pty:start', (_e, req: StartRequest) => start(req))
  ipcMain.on('pty:write', (_e, id: number, d: string) => writePty(id, d))
  ipcMain.on('pty:resize', (_e, id: number, c: number, r: number) => resizePty(id, c, r))
  ipcMain.on('pty:kill', () => killPty())
  ipcMain.handle('handoff', (_e, req: HandoffRequest) => {
    copySessionForHandoff(account(req.fromAccountId), account(req.toAccountId), req.cwd, req.sessionId)
    return start({ accountId: req.toAccountId, cwd: req.cwd, mode: 'resume', sessionId: req.sessionId }) // kills old pty
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
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
})

app.on('window-all-closed', () => {
  killPty()
  app.quit()
})
