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
    pickDir: () => ipcRenderer.invoke('accounts:pickDir')
  },
  projects: { list: () => ipcRenderer.invoke('projects:list'), add: () => ipcRenderer.invoke('projects:add') },
  sessions: (cwd) => ipcRenderer.invoke('sessions:list', cwd),
  pty: {
    start: (req) => ipcRenderer.invoke('pty:start', req),
    write: (id, d) => ipcRenderer.send('pty:write', id, d),
    resize: (id, c, r) => ipcRenderer.send('pty:resize', id, c, r),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (cb) => sub('pty:data', cb),
    onExit: (cb) => sub('pty:exit', cb)
  },
  handoff: (req) => ipcRenderer.invoke('handoff', req)
}

contextBridge.exposeInMainWorld('relay', api)
