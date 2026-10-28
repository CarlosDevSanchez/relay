import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes: any[] = []
vi.mock('node-pty', () => ({
  spawn: () => {
    const f: any = { written: [] as string[], killed: 0, exit: undefined as undefined | ((e: { exitCode: number }) => void) }
    f.onData = (cb: any) => (f.data = cb)
    f.onExit = (cb: any) => (f.exit = cb)
    f.kill = () => (f.killed++, f.exit?.({ exitCode: 0 })) // exits on SIGHUP
    f.write = (d: string) => f.written.push(d)
    f.resize = () => undefined
    fakes.push(f)
    return f
  }
}))

const { clearPty, sendPty, stopPty, killAccountPtys, killAll, killPty, livePtyCount, markStale, ptyInfo, setPtySession, spawnPty, wasBound, writePty } = await import('../src/main/pty')
const exits: number[] = []
const mk = (acc: string, sid?: string) => spawnPty('x', [], '/', {}, acc, sid, () => undefined, (id) => void exits.push(id))

describe('pty session binding', () => {
  it('remembers every bound session, counts live ptys per account+cwd, marks stale', async () => {
    const id = spawnPty('x', [], '/p', {}, 'A', 's1', () => undefined, () => undefined)
    const other = spawnPty('x', [], '/p', {}, 'A', 's9', () => undefined, () => undefined)
    expect(livePtyCount('A', '/p')).toBe(2)
    expect(livePtyCount('A', '/q')).toBe(0)
    setPtySession(id, 's2')
    expect(ptyInfo(id)).toEqual({ accountId: 'A', sessionId: 's2', stale: false })
    expect(wasBound('s1') && wasBound('s2') && wasBound('s9')).toBe(true)
    expect(wasBound('s3')).toBe(false)
    setPtySession(9999, 'zz') // unknown pty: ignored
    expect(wasBound('zz')).toBe(false)
    markStale(id)
    expect(ptyInfo(id)?.stale).toBe(true)
    await killPty(id)
    await killPty(other)
    expect(wasBound('s1')).toBe(true) // survives the pty (closed tab / finished handoff source)
    expect(livePtyCount('A', '/p')).toBe(0)
  })
})

describe('pty map', () => {
  beforeEach(() => {
    fakes.length = 0
    exits.length = 0
  })
  it('kills only its own id, cleans up on exit, routes writes by id', async () => {
    const [a, b] = [mk('A', 's1'), mk('B')] as [number, number]
    writePty(b, 'hi')
    expect(fakes[1].written).toEqual(['hi'])
    expect(fakes[0].written).toEqual([])
    await killPty(a)
    expect([fakes[0].killed, fakes[1].killed]).toEqual([1, 0])
    expect(exits).toEqual([a])
    expect(ptyInfo(a)).toBeUndefined()
    expect(ptyInfo(b)).toEqual({ accountId: 'B', sessionId: undefined, stale: false })
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

describe('composer bridge writes', () => {
  const live = () => {
    const seqs: number[] = []
    const id = spawnPty('x', [], '/', {}, 'B', 's-bridge', (_i, _d, seq) => void seqs.push(seq), () => undefined)
    const f = fakes.at(-1)
    f.data('a')
    f.data('b')
    return { id, f, seqs }
  }
  it('every output chunk gets the next sequence number', async () => {
    const { id, seqs } = live()
    expect(seqs).toEqual([1, 2])
    await killPty(id)
  })
  it('send writes ONE paste + Enter with the exact bytes; Stop writes exactly ESC', async () => {
    const { id, f } = live()
    expect(sendPty(id, 'a\x03b\x1b[201~c\x04d', 2)).toBe('ok')
    expect(f.written).toEqual(['\x1b[200~ab[201~cd\x1b[201~\r'])
    f.written.length = 0
    expect(stopPty(id)).toBe(true)
    expect(f.written).toEqual(['\x1b'])
    await killPty(id)
  })
  it('a stale sequence (output the renderer has not parsed) writes nothing, for send and clear', async () => {
    const { id, f } = live()
    expect(sendPty(id, 'x', 1)).toBe('stale')
    expect(await clearPty(id, true, 1, 1)).toBe('stale')
    expect(f.written).toEqual([])
    f.data('c') // output arrives after the renderer read its frame
    expect(sendPty(id, 'x', 2)).toBe('stale')
    expect(f.written).toEqual([])
    await killPty(id)
  })
  it('clear writes the allowlisted steps in order, ESC only for an open list', async () => {
    const { id, f } = live()
    expect(await clearPty(id, true, 2, 1)).toBe('ok')
    expect(await clearPty(id, false, 2, 1)).toBe('ok')
    expect(f.written).toEqual(['\x1b', '\x15', '\x15'])
    await killPty(id)
  })
  it('a gone pty reports gone and writes nothing', async () => {
    const { id, f } = live()
    await killPty(id)
    expect(sendPty(id, 'x', 2)).toBe('gone')
    expect(stopPty(id)).toBe(false)
    expect(await clearPty(id, true, 2, 1)).toBe('gone')
    expect(f.written).toEqual([])
  })
})
