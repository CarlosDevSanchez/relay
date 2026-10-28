import * as pty from 'node-pty'
import { STOP, clearSteps, pasteBytes } from './bridge'
import { terminate } from './handoff'

interface Entry {
  proc: pty.IPty
  accountId: string
  sessionId: string | undefined
  cwd: string
  /** the CLI changed session id and Relay could not tell which one: handoff is refused */
  stale: boolean
  /** output chunks emitted so far: the renderer sends back the last one it parsed (stale-frame guard of the composer bridge) */
  seq: number
  exited: Promise<void>
}
const ptys = new Map<number, Entry>()
/** every session id any Relay pty has ever had (incl. handoff targets): never a rebind candidate */
const everBound = new Set<string>()
let nextId = 1

export function spawnPty(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  accountId: string,
  sessionId: string | undefined,
  onData: (id: number, d: string, seq: number) => void,
  onExit: (id: number, code: number) => void
): number {
  const id = nextId++
  const proc = pty.spawn(bin, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env })
  proc.onData((d) => onData(id, d, ptys.has(id) ? ++ptys.get(id)!.seq : 0))
  const exited = new Promise<void>((res) =>
    proc.onExit(({ exitCode }) => {
      ptys.delete(id)
      onExit(id, exitCode)
      res()
    })
  )
  if (sessionId) everBound.add(sessionId)
  ptys.set(id, { proc, accountId, sessionId, cwd, stale: false, seq: 0, exited })
  return id
}

export const writePty = (id: number, d: string): void => ptys.get(id)?.proc.write(d)
export type Written = 'ok' | 'stale' | 'gone'
/** Composer send (bytes built in bridge.ts). `seq` = the last output chunk the renderer had parsed when it classified the screen: if more output came since, nothing is written. */
export function sendPty(id: number, text: string, seq: number): Written {
  const e = ptys.get(id)
  if (!e) return 'gone'
  if (e.seq !== seq) return 'stale'
  e.proc.write(pasteBytes(text))
  return 'ok'
}
/** Stop: exactly one ESC (no guard: ESC landing on a new dialog is a cancel, the safe direction). */
export function stopPty(id: number): boolean {
  const e = ptys.get(id)
  e?.proc.write(STOP)
  return !!e
}
/** Empties the CLI's input box (same stale guard as send); the steps go out apart so the CLI does not read ESC + ^U as one Alt chord. */
export async function clearPty(id: number, overlay: boolean, seq: number, gapMs = 80): Promise<Written> {
  if (!ptys.has(id)) return 'gone'
  if (ptys.get(id)!.seq !== seq) return 'stale'
  for (const [i, step] of clearSteps(overlay).entries()) {
    if (i) await new Promise((r) => setTimeout(r, gapMs))
    const e = ptys.get(id)
    if (!e) return 'gone'
    e.proc.write(step)
  }
  return 'ok'
}
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
export const ptyInfo = (id: number): { accountId: string; sessionId: string | undefined; stale: boolean } | undefined => {
  const e = ptys.get(id)
  return e && { accountId: e.accountId, sessionId: e.sessionId, stale: e.stale }
}

export function setPtySession(id: number, sessionId: string): void {
  const e = ptys.get(id)
  if (!e) return
  e.sessionId = sessionId
  everBound.add(sessionId)
}
export const markStale = (id: number): void => void (ptys.get(id) && (ptys.get(id)!.stale = true))
export const wasBound = (sessionId: string): boolean => everBound.has(sessionId)
/** Live Relay ptys on this account + project dir. */
export const livePtyCount = (accountId: string, cwd: string): number => [...ptys.values()].filter((e) => e.accountId === accountId && e.cwd === cwd).length
export const hasLivePty = (accountId: string): boolean => [...ptys.values()].some((e) => e.accountId === accountId)
