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
    candidates: () => ipcRenderer.invoke('accounts:candidates'),
    pickDir: () => ipcRenderer.invoke('accounts:pickDir'),
    rename: (id, label) => ipcRenderer.invoke('accounts:rename', id, label),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    status: (id, refresh) => ipcRenderer.invoke('accounts:status', id, refresh)
  },
  projects: { list: () => ipcRenderer.invoke('projects:list'), add: () => ipcRenderer.invoke('projects:add') },
  shared: { set: (id, enabled) => ipcRenderer.invoke('shared:set', id, enabled), open: () => ipcRenderer.invoke('shared:open') },
  onShared: (cb) => sub('shared:notice', cb),
  sessions: (cwd) => ipcRenderer.invoke('sessions:list', cwd),
  history: {
    candidates: (cwd) => ipcRenderer.invoke('history:candidates', cwd),
    adopt: (cwd, id) => ipcRenderer.invoke('history:adopt', cwd, id),
    forget: (cwd, id) => ipcRenderer.invoke('history:forget', cwd, id)
  },
  usage: { get: () => ipcRenderer.invoke('usage:get'), onUpdate: (cb) => sub('usage:update', cb), onWarn: (cb) => sub('usage:warn', cb) },
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
  cli: { detect: () => ipcRenderer.invoke('cli:detect'), install: (p) => ipcRenderer.invoke('cli:install', p) },
  catalog: { list: () => ipcRenderer.invoke('catalog:list'), open: (id) => ipcRenderer.invoke('catalog:open', id) },
  mcp: { list: () => ipcRenderer.invoke('mcp:list') },
  transcript: {
    subscribe: (ref) => ipcRenderer.invoke('session:subscribe', ref),
    unsubscribe: (ref) => ipcRenderer.invoke('session:unsubscribe', ref),
    older: (ref, before) => ipcRenderer.invoke('session:older', ref, before),
    subagent: (ref, agentId, before) => ipcRenderer.invoke('session:subagent', ref, agentId, before),
    onEvents: (cb) => sub('session:events', cb)
  },
  notifyTest: () => ipcRenderer.invoke('notify:test'),
  remindReset: (accountId, resetAt) => ipcRenderer.invoke('limit:remind', accountId, resetAt),
  onLimit: (cb) => sub('limit:hit', cb),
  onFocusTab: (cb) => sub('tab:focus', cb),
  onStale: (cb) => sub('pty:stale', cb),
  onSession: (cb) => sub('pty:session', cb),
  onReminder: (cb) => sub('limit:reminder', cb)
}

contextBridge.exposeInMainWorld('relay', api)
