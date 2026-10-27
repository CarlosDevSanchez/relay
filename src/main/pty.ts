import * as pty from 'node-pty'
import { terminate } from './handoff'

interface Entry {
  proc: pty.IPty
  accountId: string
  sessionId: string | undefined
  exited: Promise<void>
}
const ptys = new Map<number, Entry>()
let nextId = 1

export function spawnPty(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  accountId: string,
  sessionId: string | undefined,
  onData: (id: number, d: string) => void,
  onExit: (id: number, code: number) => void
): number {
  const id = nextId++
  const proc = pty.spawn(bin, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env })
  proc.onData((d) => onData(id, d))
  const exited = new Promise<void>((res) =>
    proc.onExit(({ exitCode }) => {
      ptys.delete(id)
      onExit(id, exitCode)
      res()
    })
  )
  ptys.set(id, { proc, accountId, sessionId, exited })
  return id
}

export const writePty = (id: number, d: string): void => ptys.get(id)?.proc.write(d)
export const resizePty = (id: number, c: number, r: number): void => ptys.get(id)?.proc.resize(c, r)

/** Kills only this pty; resolves once it has really exited (SIGKILL after 3s). */
export function killPty(id: number): Promise<void> {
  const e = ptys.get(id)
  return e ? terminate((sig) => e.proc.kill(sig), e.exited) : Promise.resolve()
}

export const killAll = (): Promise<void[]> => Promise.all([...ptys.keys()].map(killPty))
export const killAccountPtys = (accountId: string): Promise<void[]> =>
  Promise.all([...ptys].filter(([, e]) => e.accountId === accountId).map(([id]) => killPty(id)))

/** Owner account + session of a live pty (undefined once exited). */
export const ptyInfo = (id: number): { accountId: string; sessionId: string | undefined } | undefined => {
  const e = ptys.get(id)
  return e && { accountId: e.accountId, sessionId: e.sessionId }
}
