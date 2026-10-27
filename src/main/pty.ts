import * as pty from 'node-pty'
import { terminate } from './handoff'

// ponytail: one terminal at a time; callers `await killPty()` before spawning another.
let current: { id: number; proc: pty.IPty; exited: Promise<void> } | null = null
let nextId = 1

export function spawnPty(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onData: (id: number, d: string) => void,
  onExit: (id: number, code: number) => void
): number {
  const id = nextId++
  const proc = pty.spawn(bin, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env })
  proc.onData((d) => onData(id, d))
  const exited = new Promise<void>((res) =>
    proc.onExit(({ exitCode }) => {
      onExit(id, exitCode)
      res()
    })
  )
  current = { id, proc, exited }
  return id
}

export const writePty = (id: number, d: string): void => void (current?.id === id && current.proc.write(d))
export const resizePty = (id: number, c: number, r: number): void => void (current?.id === id && current.proc.resize(c, r))

/** Resolves once the process has really exited (SIGKILL after 3s). */
export function killPty(): Promise<void> {
  const c = current
  current = null
  return c ? terminate((sig) => c.proc.kill(sig), c.exited) : Promise.resolve()
}
