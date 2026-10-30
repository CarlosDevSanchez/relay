import { describe, expect, it, vi } from 'vitest'
import { MAX_PRESSES, contextInfo, cycleMode, modeFromFooter, passesAuto, pressesTo, tokenCount, type Frame } from '../src/shared/controls'

describe('modeFromFooter (real footer texts, docs/spikes/F6b.md 8)', () => {
  const f = (s: string) => modeFromFooter(['', ' ──────', `  ${s}`, ''])
  it('reads the four modes', () => {
    expect(f('⏸ manual mode on · ? for shortcuts')).toBe('default')
    expect(f('⏸ manual mode on')).toBe('default')
    expect(f('⏵⏵ accept edits on (shift+tab to cycle)')).toBe('acceptEdits')
    expect(f('⏸ plan mode on (shift+tab to cycle)')).toBe('plan')
    expect(f('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')).toBe('auto')
  })
  it('only the last non-blank row counts, and unknown footers read as undefined', () => {
    expect(modeFromFooter(['  ⏵⏵ auto mode on', '  ? for shortcuts'])).toBeUndefined()
    expect(modeFromFooter(['  something else entirely'])).toBeUndefined()
    expect(modeFromFooter([])).toBeUndefined()
    expect(f('Yes, and switch to auto mode · auto mode handles these prompts for you')).toBeUndefined() // a dialog option is not the footer
  })
})

describe('pressesTo', () => {
  it('counts Shift+Tab presses along manual -> accept edits -> plan -> auto -> manual', () => {
    expect(pressesTo('default', 'default')).toBe(0)
    expect(pressesTo('default', 'auto')).toBe(3)
    expect(pressesTo('auto', 'default')).toBe(1)
    expect(pressesTo('plan', 'acceptEdits')).toBe(3)
  })
})

const run = async (...a: Parameters<typeof cycleMode>) => (await cycleMode(...a)).res

describe('passesAuto', () => {
  it('the cycle crosses Auto on the way to Manual from Plan or Accept edits, not from Manual or Auto', () => {
    expect(passesAuto('plan', 'default')).toBe(true)
    expect(passesAuto('acceptEdits', 'default')).toBe(true)
    expect(passesAuto('default', 'auto')).toBe(true)
    expect(passesAuto('plan', 'auto')).toBe(true)
    expect(passesAuto('auto', 'default')).toBe(false)
    expect(passesAuto('default', 'plan')).toBe(false)
    expect(passesAuto('default', 'acceptEdits')).toBe(false)
    expect(passesAuto('plan', 'plan')).toBe(false)
  })
})

describe('cycleMode', () => {
  /** a CLI whose footer follows the real cycle; `drop` = number of presses it ignores */
  const cli = (start: Frame['mode'], over: Partial<Frame> = {}, drop = 0) => {
    const order = ['default', 'acceptEdits', 'plan', 'auto'] as const
    const s = { mode: start, seq: 1, dropped: 0, presses: 0 }
    const io = {
      read: async (): Promise<Frame> => ({ state: 'idle', mode: s.mode, seq: s.seq, ...over }),
      press: vi.fn(async (seq: number): Promise<'ok' | 'stale' | 'gone'> => {
        if (seq !== s.seq) return 'stale'
        s.presses++
        s.seq++
        if (s.dropped < drop) s.dropped++
        else s.mode = order[(order.indexOf(s.mode as never) + 1) % 4]
        return 'ok'
      }),
      after: async (prev: Frame['mode']): Promise<Frame> => ({ state: 'idle', mode: s.mode, seq: s.seq, ...over, ...(prev === s.mode ? {} : {}) })
    }
    return { io, s }
  }
  it('presses once per step and stops exactly on the target', async () => {
    const { io, s } = cli('default')
    expect(await run('plan', io)).toBe('done')
    expect(s.presses).toBe(2)
  })
  it('does nothing when already there', async () => {
    const { io } = cli('auto')
    expect(await run('auto', io)).toBe('done')
    expect(io.press).not.toHaveBeenCalled()
  })
  it('stops when the footer is unreadable (nothing pressed)', async () => {
    const { io } = cli(undefined)
    expect(await run('auto', io)).toBe('unreadable')
    expect(io.press).not.toHaveBeenCalled()
  })
  it('never presses on a screen that is not idle', async () => {
    const { io } = cli('default', { state: 'working' })
    expect(await run('auto', io)).toBe('busy')
    expect(io.press).not.toHaveBeenCalled()
  })
  it('stops when a press changed nothing (the footer did not move)', async () => {
    const { io, s } = cli('default', {}, 1)
    expect(await run('auto', io)).toBe('unchanged')
    expect(s.presses).toBe(1)
  })
  it('gives up after MAX_PRESSES (a CLI whose cycle skips the target)', async () => {
    const { io, s } = cli('default')
    // a cycle that never reaches the target: report an endless alternation
    let flip = false
    io.after = async () => ((flip = !flip), { state: 'idle', mode: flip ? 'acceptEdits' : 'default', seq: ++s.seq })
    expect(await run('auto', io)).toBe('gave-up')
    expect(io.press).toHaveBeenCalledTimes(MAX_PRESSES)
  })
  it('reports the mode it stopped in: Plan -> Manual with the 2nd press dropped is left in Auto', async () => {
    const { io, s } = cli('plan', {}, 0)
    const orig = io.press.getMockImplementation()!
    let n = 0
    io.press.mockImplementation(async (seq) => (++n === 2 ? 'ok' : orig(seq))) // the 2nd press "succeeds" but the CLI ignores it
    const r = await cycleMode('default', io)
    expect(s.mode).toBe('auto')
    expect(r).toEqual({ res: 'unchanged', mode: 'auto' })
  })
  it('refuses to press when the footer is no longer the mode the user confirmed from', async () => {
    const { io } = cli('auto')
    const r = await cycleMode('default', io, 'plan') // the confirmation was for Plan -> Manual, but the CLI now shows Auto
    expect(r).toEqual({ res: 'changed', mode: 'auto' })
    expect(io.press).not.toHaveBeenCalled()
    const ok = cli('plan')
    expect((await cycleMode('default', ok.io, 'plan')).res).toBe('done') // same mode: runs normally
  })
  it('re-reads on a stale frame but stops after a few', async () => {
    const io = { read: async (): Promise<Frame> => ({ state: 'idle', mode: 'default', seq: 1 }), press: vi.fn(async () => 'stale' as const), after: async (): Promise<Frame> => ({ state: 'idle', mode: 'default', seq: 1 }) }
    expect(await run('plan', io)).toBe('stale')
    expect(io.press.mock.calls.length).toBeLessThanOrEqual(4)
  })
  it('reports a vanished session', async () => {
    const { io } = cli('default')
    io.press.mockResolvedValueOnce('gone')
    expect(await run('plan', io)).toBe('gone')
  })
})

describe('context ring', () => {
  const m = (input: number, cacheRead = 0, cacheCreate = 0, output = 0) => ({ input, output, cacheRead, cacheCreate })
  it('counts the prompt side of the last response', () => {
    expect(tokenCount(m(10, 20, 30, 5))).toBe(60)
    expect(tokenCount(undefined)).toBe(0)
  })
  it('known families use a static window, unknown models only show tokens', () => {
    expect(contextInfo('claude-opus-4-5', 50_000)).toEqual({ used: 50_000, window: 200_000, pct: 25 })
    expect(contextInfo('claude-sonnet-4-5[1m]', 100_000)).toEqual({ used: 100_000, window: 1_000_000, pct: 10 })
    expect(contextInfo('claude-fake-1', 5000)).toEqual({ used: 5000 })
    expect(contextInfo(undefined, 5000)).toEqual({ used: 5000 })
    expect(contextInfo('claude-haiku-4', 2_000_000).pct).toBe(100) // clamped
    expect(contextInfo('claude-opus-4-5', 250_000)).toEqual({ used: 250_000, window: 1_000_000, pct: 25 }) // more than 200k: it must be a 1M window
    expect(contextInfo('claude-fake-1', 250_000)).toEqual({ used: 250_000 })
    expect(contextInfo('claude-haiku-4', 0)).toEqual({ used: 0, window: 200_000, pct: 0 })
  })
})
