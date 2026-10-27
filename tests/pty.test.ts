import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes: any[] = []
vi.mock('node-pty', () => ({
  spawn: () => {
    const f: any = { written: [] as string[], killed: 0, exit: undefined as undefined | ((e: { exitCode: number }) => void) }
    f.onData = () => undefined
    f.onExit = (cb: any) => (f.exit = cb)
    f.kill = () => (f.killed++, f.exit?.({ exitCode: 0 })) // exits on SIGHUP
    f.write = (d: string) => f.written.push(d)
    f.resize = () => undefined
    fakes.push(f)
    return f
  }
}))

const { killAccountPtys, killAll, killPty, ptyAccount, spawnPty, writePty } = await import('../src/main/pty')
const exits: number[] = []
const mk = (acc: string) => spawnPty('x', [], '/', {}, acc, () => undefined, (id) => void exits.push(id))

describe('pty map', () => {
  beforeEach(() => {
    fakes.length = 0
    exits.length = 0
  })
  it('kills only its own id, cleans up on exit, routes writes by id', async () => {
    const [a, b] = [mk('A'), mk('B')] as [number, number]
    writePty(b, 'hi')
    expect(fakes[1].written).toEqual(['hi'])
    expect(fakes[0].written).toEqual([])
    await killPty(a)
    expect([fakes[0].killed, fakes[1].killed]).toEqual([1, 0])
    expect(exits).toEqual([a])
    expect(ptyAccount(a)).toBeUndefined()
    expect(ptyAccount(b)).toBe('B')
    await killPty(a) // already gone: no-op
    expect(fakes[0].killed).toBe(1)
    await killAll()
    expect(fakes[1].killed).toBe(1)
  })
  it('killAccountPtys kills every pty of that account only', async () => {
    mk('A')
    mk('B')
    mk('A')
    await killAccountPtys('A')
    expect(fakes.map((f) => f.killed)).toEqual([1, 0, 1])
    await killAll()
  })
})
