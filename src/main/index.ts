import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, Notification, app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { Account, Candidate, HandoffRequest, StartRequest, StartResult } from '../shared/types'
import { createHub } from './transcript/session'
import { limitedFromUsage } from '../shared/usage'
import { findRollout, parseCodexLimitLine, watchCodexNewSession } from './codex'
import { buildEnv, plainEnv } from './env'
import { buildCatalog } from './catalog'
import { detectCli } from './cli'
import { mcpReport } from './mcp'
import { copySessionForHandoff, runHandoff, sourceExists } from './handoff'
import { hasLivePty, killAccountPtys, killAll, killPty, livePtyCount, markStale, ptyInfo, setPtySession, wasBound, resizePty, spawnPty, writePty, sendPty, stopPty, clearPty, answerPty, keyPty, ptyCwd } from './pty'
import { listFiles } from './files'
import { providers } from './providers'
import { type LimitInfo, scheduleAt, pickRebind, watchLimits, watchNewSession } from './limit'
import { candidateDirs, canProbe, claudeProjectDir, dirProvider, isDefaultInstall } from './paths'
import { loadPrefs, savePrefs } from './prefs'
import { claudeSettingsArgs, readUserStatus, statusEnv, trackUsage, writeStatusScript } from './rates'
import { adoptable, loadRegistry, register, registerHandoff, touchSession, forgetSession, updateRegistry, visibleSessions } from './registry'
import { drifted, linkAccount, nextFlag, sharedDir, unlinkAccount } from './shared'
import { listSessions } from './sessions'
import { accountStatus } from './usage'
import { addAccount, addProject, isManaged, loadAccounts, loadCopies, loadProjects, pruneCopies, recordCopy, removeAccount, renameAccount, setSharedMemory } from './store'
import { checkAccountId, checkAnswer, checkClaudePty, checkClear, checkKey, checkPtyId, checkSendText, checkSeq, checkHandoff, checkInstall, checkNewAccount, checkReminder, checkRename, checkSessionRef, checkSharedToggle, checkStart, checkAgentId, checkOffset, checkTranscriptRef } from './validate'

const HOME = process.env.RELAY_HOME || join(homedir(), '.relay')
let win: BrowserWindow
let tracker: ReturnType<typeof trackUsage> | undefined
let statusScript = '' // Relay's status line script (written at startup; empty = could not be written, nothing is injected)

const list = (): Account[] =>
  loadAccounts(HOME).map((a) => {
    const d = a.sharedMemory ? drifted(HOME, a) : []
    return { ...a, managed: isManaged(HOME, a), ...(isDefaultInstall(a.configDir, homedir(), a.provider) ? { defaultInstall: true } : {}), ...(d.length ? { drift: d } : {}) }
  })

const send = (ch: string, ...a: unknown[]): void => {
  if (!win.isDestroyed()) win.webContents.send(ch, ...a)
}

const watchers = new Map<number, { stop(): void }>()
const hub = createHub((b) => send('session:events', b)) // F6.1 transcript streams, refcounted per accountId+sessionId
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

/** Registry writes are best-effort: a read-only home must not orphan a pty, throw in a data callback or fail a handoff that worked. */
const record = (fn: Parameters<typeof updateRegistry>[1]): void => {
  try {
    updateRegistry(HOME, fn)
  } catch {
    // history is a convenience
  }
}
const touched = new Map<number, number>()
const fileCache = new Map<number, { at: number; files: string[] }>()
const ptyData = (id: number, d: string, seq: number): void => {
  send('pty:data', id, d, seq)
  const sid = ptyInfo(id)?.sessionId
  if (sid && Date.now() - (touched.get(id) ?? 0) > 60_000) {
    touched.set(id, Date.now()) // history: "last active", at most once a minute per pty
    record((l) => touchSession(l, sid))
  }
}
const ptyExit = (id: number, code: number): void => {
  touched.delete(id)
  watchers.get(id)?.stop()
  watchers.delete(id)
  fileCache.delete(id)
  send('pty:exit', id, code)
}

function onLimit(ptyId: number, a: Account, sessionId: string, h: LimitInfo): void {
  if (h.modelSpecific) notify(`${a.label}: se agotó el límite de uso de un modelo`, () => send('tab:focus', ptyId))
  else notify(`${a.label} llegó a su límite · se reinicia ${h.resetText}`, () => send('tab:focus', ptyId))
  send('limit:hit', { ptyId, accountId: a.id, sessionId, ...h })
}

async function start(req: StartRequest, message?: string): Promise<StartResult> {
  const { cwd, mode, sessionId } = req
  const a = checkStart(req, loadAccounts(HOME), loadProjects(HOME))
  const p = providers[a.provider]
  let sid = sessionId
  // official usage: Relay's status line script through `--settings` (user settings files are only read, to chain their own status line)
  const statusLine = a.provider === 'claude' && mode !== 'login' && statusScript !== '' && loadPrefs(HOME).usage.statusLine
  const extra = statusLine ? claudeSettingsArgs(statusScript, readUserStatus(a.configDir)) : []
  let args: string[] = p.loginArgs
  let dir = cwd
  if (mode === 'new') {
    sid = p.assignsId ? randomUUID() : undefined // Codex assigns its own id: discovered below from the new rollout
    args = p.newArgs(sid ?? '', extra)
  } else if (mode === 'resume') {
    if (!sid) throw new Error('sessionId required')
    args = p.resumeArgs(sid, message, extra)
  } else {
    dir = homedir() // login: official `auth login` flow
    sid = undefined
  }
  const ptyId = spawnPty(
    p.bin,
    args,
    dir,
    statusLine ? { ...buildEnv(a), ...statusEnv(HOME, a) } : buildEnv(a),
    a.id,
    sid,
    ptyData,
    ptyExit
  )
  const ref = (id: string) => ({ provider: a.provider, accountId: a.id, sessionId: id, cwd: dir })
  if (mode !== 'login' && sid) record((l) => register(l, ref(sid!), mode === 'new' ? 'new' : 'resume'))
  // live quota detection: tail the session transcript from its current end; follow /clear (new session id).
  // Codex new sessions have no id yet: the first new rollout of this cwd binds the tab (setPtySession + 'pty:session').
  if (mode !== 'login') {
    const codex = a.provider === 'codex'
    const projDir = claudeProjectDir(a.configDir, dir)
    const none = { check: () => undefined, stop: () => undefined }
    const tail = (id: string) => {
      const file = codex ? findRollout(a.configDir, id) : join(projDir, `${id}.jsonl`)
      return file ? watchLimits(file, (h) => onLimit(ptyId, a, id, h), Date.now, codex ? parseCodexLimitLine : undefined) : none
    }
    let cur = sid
    let t = cur ? tail(cur) : none
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
        record((l) => register(l, ref(d.id), 'new')) // Codex: first bind of a new session; Claude: /clear
        send('pty:session', ptyId, d.id)
      }
    }
    const onNew = (ids: string[]): void => {
      ids.forEach((i) => cands.add(i))
      timer ??= setTimeout(decide, 1500) // let a second candidate show up before deciding
    }
    const skip = (id: string): boolean => id === cur || wasBound(id)
    const nw = codex ? watchCodexNewSession(a.configDir, dir, Date.now(), skip, onNew) : watchNewSession(projDir, Date.now(), skip, onNew)
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
        const provider = dirProvider(dir)
        const def = provider === 'claude' && isDefaultInstall(dir, home) ? { default: true } : {}
        if (!canProbe(dir, home, provider)) return { dir, provider, loggedIn: null, unchecked: true, ...def } // probing would write into it
        const s = await accountStatus({ id: `cand:${dir}`, label: '', provider, configDir: dir }, true)
        return { dir, provider, loggedIn: s.loggedIn, ...def, ...(s.email ? { email: s.email } : {}), ...(s.plan ? { plan: s.plan } : {}) }
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
    if (!isManaged(HOME, acc) && existsSync(acc.configDir)) {
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
  ipcMain.handle('accounts:status', async (_e, id: string, refresh?: boolean) => {
    const a = checkAccountId(id, loadAccounts(HOME))
    // an imported dir is only asked when the probe cannot create files in it (see canProbe); Relay's own dirs are always asked
    const s = await accountStatus(a, refresh === true, loadCopies(HOME)[a.id], isManaged(HOME, a) || canProbe(a.configDir, homedir(), a.provider))
    // official usage at 100% = limited too (same state the transcript scan produces: handoff targets and cards reuse it)
    const lim = s.limited ? undefined : limitedFromUsage(tracker?.get().find((u) => u.accountId === a.id)?.windows ?? [])
    return lim ? { ...s, limited: lim } : s
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
        detail: `Se reemplazarán por enlaces a ~/.relay/shared: ${a.provider === 'codex' ? 'AGENTS.md (solo ese archivo)' : 'CLAUDE.md, skills/, agents/, commands/ y projects/*/memory de tus proyectos'}. Su contenido se mueve a la memoria compartida y lo que choque se guarda en ~/.relay/backups/${a.id}/<fecha>/. No se tocan credenciales, ajustes ni historial. Al desactivar o quitar la cuenta se restauran copias reales.`
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
  ipcMain.handle('sessions:list', (_e, cwd: string) => {
    if (!loadProjects(HOME).includes(cwd)) return []
    const reg = loadRegistry(HOME)
    const ids = new Set(reg.filter((e) => e.cwd === cwd).map((e) => e.sessionId)) // only registered transcripts are read
    return ids.size ? visibleSessions(reg, listSessions(loadAccounts(HOME), cwd, ids), cwd) : []
  })
  ipcMain.handle('history:candidates', (_e, cwd: string) => (loadProjects(HOME).includes(cwd) ? adoptable(loadRegistry(HOME), listSessions(loadAccounts(HOME), cwd), cwd) : []))
  ipcMain.handle('history:adopt', (_e, cwd: unknown, sessionId: unknown) => {
    const r = checkSessionRef(cwd, sessionId, loadProjects(HOME))
    const accounts = loadAccounts(HOME)
    const s = adoptable(loadRegistry(HOME), listSessions(accounts, r.cwd), r.cwd).find((x) => x.id.toLowerCase() === r.sessionId.toLowerCase())
    const acc = s && accounts.find((x) => x.id === s.accountId)
    if (!s || !acc) throw new Error('No hay una transcripción de esa sesión en este proyecto')
    updateRegistry(HOME, (l) => register(l, { provider: acc.provider, accountId: acc.id, sessionId: s.id, cwd: r.cwd }, 'adopt'))
  })
  ipcMain.handle('history:forget', (_e, cwd: unknown, sessionId: unknown) => {
    const r = checkSessionRef(cwd, sessionId, loadProjects(HOME))
    updateRegistry(HOME, (l) => forgetSession(l, r.sessionId)) // the registry entry only; transcripts are never deleted
  })
  // F6.1 transcript view: the renderer sends ids only; the file is resolved here from the account and the session
  const tsub = (ref: unknown): { accountId: string; file: string; sessionId: string } => {
    const r = checkTranscriptRef(ref, loadAccounts(HOME), loadProjects(HOME))
    return { accountId: r.account.id, file: join(claudeProjectDir(r.account.configDir, r.cwd), `${r.sessionId}.jsonl`), sessionId: r.sessionId }
  }
  const tget = (ref: unknown) => {
    const t = tsub(ref)
    const s = hub.get(t.accountId, t.sessionId)
    if (!s) throw new Error('Not subscribed')
    return s
  }
  ipcMain.handle('session:subscribe', (_e, ref: unknown) => {
    const t = tsub(ref)
    return hub.subscribe(t.accountId, t.sessionId, t.file)
  })
  ipcMain.handle('session:unsubscribe', (_e, ref: unknown) => {
    const t = tsub(ref)
    hub.unsubscribe(t.accountId, t.sessionId)
  })
  ipcMain.handle('session:older', (_e, ref: unknown, before: unknown) => tget(ref).older(checkOffset(before)))
  ipcMain.handle('session:subagent', (_e, ref: unknown, agentId: unknown, before: unknown) => tget(ref).subagent(checkAgentId(agentId), before === undefined ? undefined : checkOffset(before)))
  ipcMain.handle('usage:get', () => tracker?.get() ?? [])
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
      detail: `Se ejecutará el instalador oficial de ${provider === 'codex' ? 'OpenAI (Homebrew o npm)' : 'Anthropic'} en una terminal visible:\n\n${c.display}\n\nRelay no descarga nada por sí mismo.`
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
  // composer bridge (F6.3): the renderer sends ids and text; the bytes are built in bridge.ts
  const claudePty = (id: unknown): number => {
    const n = checkPtyId(id)
    checkClaudePty(ptyInfo(n), loadAccounts(HOME))
    return n
  }
  ipcMain.handle('pty:send', (_e, id: unknown, text: unknown, seq: unknown) => sendPty(claudePty(id), checkSendText(text), checkSeq(seq)))
  ipcMain.handle('pty:key', (_e, id: unknown, seq: unknown, key: unknown) => keyPty(claudePty(id), checkKey(key), checkSeq(seq)))
  // `@` autocomplete (F6.5): file names of the tab's own project only, never contents
  ipcMain.handle('files:list', (_e, id: unknown) => {
    const n = claudePty(id)
    const hit = fileCache.get(n)
    if (hit && Date.now() - hit.at < 5000) return hit.files // asked on every `@` token: walk at most once per 5 s
    const files = listFiles(ptyCwd(n)!)
    fileCache.set(n, { at: Date.now(), files })
    return files
  })
  ipcMain.handle('pty:stop', (_e, id: unknown) => stopPty(claudePty(id)))
  ipcMain.handle('pty:clear', (_e, id: unknown, opts: unknown, seq: unknown) => clearPty(claudePty(id), checkClear(opts), checkSeq(seq)))
  // prompt cards (F6.4): a closed action set; the renderer compares the card's fingerprint with the live screen, main applies the seq guard
  ipcMain.handle('pty:answer', (_e, id: unknown, seq: unknown, action: unknown) => answerPty(claudePty(id), checkSeq(seq), checkAnswer(action)))
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
    ).then((r) => {
      record((l) => registerHandoff(l, { provider: to.provider, accountId: to.id, sessionId: req.sessionId, cwd: req.cwd }, from.id))
      return message ? { ...r, autoContinued: true } : r
    })
  })
}

app.whenReady().then(() => {
  pruneCopies(HOME)
  try {
    statusScript = writeStatusScript(HOME)
  } catch {
    // read-only home: sessions still start, just without the status line (no usage bars)
  }
  handle()
  // packaged: icon.png next to the app resources; dev: <project>/build/icon.png (app.getAppPath is the project root, not the bundle dir)
  const iconFile = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build/icon.png')
  const icon = existsSync(iconFile) ? iconFile : undefined
  if (process.platform === 'darwin' && !app.isPackaged && icon) app.dock?.setIcon(icon) // dev only: a packaged app carries its .icns
  win = new BrowserWindow({
    ...(icon ? { icon } : {}),
    width: 1280,
    minWidth: 900,
    minHeight: 560,
    height: 800,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a262c' : '#f4f7f8',
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
  // a reloaded or crashed renderer loses its subscriptions: drop the streams (it subscribes again)
  win.webContents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => isMainFrame && !inPlace && hub.stopAll())
  win.webContents.on('render-process-gone', () => hub.stopAll())
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  tracker = trackUsage(HOME, {
    accounts: () => loadAccounts(HOME),
    warnAt: () => loadPrefs(HOME).usage.warnAt,
    emit: (u) => send('usage:update', u),
    warn: (_a, text) => {
      send('usage:warn', text) // always shown in-app; the system notification follows prefs
      notify(text)
    }
  })
})

app.on('will-quit', () => (tracker?.stop(), hub.stopAll(), void killAll()))

app.on('window-all-closed', () => {
  app.quit()
})
