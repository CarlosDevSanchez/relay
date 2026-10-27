import * as pty from 'node-pty'

// ponytail: one terminal at a time; starting a new one kills the previous.
let current: { id: number; proc: pty.IPty } | null = null
let nextId = 1

export function spawnPty(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onData: (id: number, d: string) => void,
  onExit: (id: number, code: number) => void
): number {
  killPty()
  const id = nextId++
  const proc = pty.spawn(bin, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env })
  proc.onData((d) => onData(id, d))
  proc.onExit(({ exitCode }) => onExit(id, exitCode))
  current = { id, proc }
  return id
}

export const writePty = (id: number, d: string): void => void (current?.id === id && current.proc.write(d))
export const resizePty = (id: number, c: number, r: number): void => void (current?.id === id && current.proc.resize(c, r))

export function killPty(): void {
  const c = current
  current = null
  c?.proc.kill()
}
