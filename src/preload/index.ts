import { contextBridge, ipcRenderer } from 'electron'
import type { RelayApi } from '../shared/types'

const sub = <A extends unknown[]>(ch: string, cb: (...a: A) => void) => {
  const l = (_: unknown, ...a: unknown[]) => cb(...(a as A))
  ipcRenderer.on(ch, l)
  return () => void ipcRenderer.off(ch, l)
}

const api: RelayApi = {
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: (label, provider, configDir) => ipcRenderer.invoke('accounts:add', label, provider, configDir),
    pickDir: () => ipcRenderer.invoke('accounts:pickDir'),
    rename: (id, label) => ipcRenderer.invoke('accounts:rename', id, label),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    status: (id, refresh) => ipcRenderer.invoke('accounts:status', id, refresh)
  },
  projects: { list: () => ipcRenderer.invoke('projects:list'), add: () => ipcRenderer.invoke('projects:add') },
  sessions: (cwd) => ipcRenderer.invoke('sessions:list', cwd),
  pty: {
    start: (req) => ipcRenderer.invoke('pty:start', req),
    kill: (id) => ipcRenderer.invoke('pty:kill', id),
    write: (id, d) => ipcRenderer.send('pty:write', id, d),
    resize: (id, c, r) => ipcRenderer.send('pty:resize', id, c, r),
    onData: (cb) => sub('pty:data', cb),
    onExit: (cb) => sub('pty:exit', cb)
  },
  handoff: (req) => ipcRenderer.invoke('handoff', req),
  prefs: { get: () => ipcRenderer.invoke('prefs:get'), set: (p) => ipcRenderer.invoke('prefs:set', p) },
  remindReset: (accountId, resetAt) => ipcRenderer.invoke('limit:remind', accountId, resetAt),
  onLimit: (cb) => sub('limit:hit', cb),
  onFocusTab: (cb) => sub('tab:focus', cb),
  onStale: (cb) => sub('pty:stale', cb),
  onSession: (cb) => sub('pty:session', cb),
  onReminder: (cb) => sub('limit:reminder', cb)
}

contextBridge.exposeInMainWorld('relay', api)
