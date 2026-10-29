// Pure rules of the controls bar (F6.5, design 5.7): permission-mode cycle read from the CLI footer, context ring.
import type { TMeta } from './types'
import type { ScreenState } from './screen'

export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto'
/** The CLI's Shift+Tab order (docs/spikes/F6b.md 8). */
export const MODE_CYCLE: Mode[] = ['default', 'acceptEdits', 'plan', 'auto']
export const MODE_LABEL: Record<Mode, string> = { default: 'Manual', acceptEdits: 'Aceptar ediciones', plan: 'Plan', auto: 'Auto' }
export const MAX_PRESSES = 4

/** Mode named by the footer: the LAST non-blank row of the viewport (`⏸ manual mode on`, `⏵⏵ accept edits on (shift+tab to cycle)`, ...). Interface text: unknown = undefined. */
export function modeFromFooter(lines: string[]): Mode | undefined {
  const row = lines.findLast((l) => l.trim())
  if (!row) return undefined
  const m = /^\s*\S{1,2}\s+(?:(manual|plan|auto) mode on|(accept edits) on)\b/.exec(row)
  return m ? (m[2] ? 'acceptEdits' : m[1] === 'manual' ? 'default' : (m[1] as Mode)) : undefined
}

export const pressesTo = (from: Mode, to: Mode): number => (MODE_CYCLE.indexOf(to) - MODE_CYCLE.indexOf(from) + MODE_CYCLE.length) % MODE_CYCLE.length

/** The cycle only goes forward: does the way from `from` to `to` stop in Auto (the target included)? Plan -> Manual crosses it. */
export const passesAuto = (from: Mode, to: Mode): boolean => {
  const i = MODE_CYCLE.indexOf(from)
  return Array.from({ length: pressesTo(from, to) }, (_, k) => MODE_CYCLE[(i + k + 1) % MODE_CYCLE.length]).includes('auto')
}

export interface Frame { state: ScreenState; mode: Mode | undefined; seq: number }
export interface CycleIO {
  /** a fresh frame (xterm has parsed everything received) */
  read(): Promise<Frame>
  /** one `pty:key shift-tab` against the frame `seq` */
  press(seq: number): Promise<'ok' | 'stale' | 'gone'>
  /** the frame once the footer left `prev` (or the last one after a timeout) */
  after(prev: Mode | undefined): Promise<Frame>
}
export type CycleResult = 'done' | 'busy' | 'unreadable' | 'unchanged' | 'gave-up' | 'stale' | 'gone' | 'changed'

/** One Shift+Tab at a time: read the footer, press, wait for it to change, repeat until the target or MAX_PRESSES. Nothing is pressed unless the screen is idle and the footer readable. `from` = the mode the confirmation was shown for; `mode` = the last footer read (the caller must flag a stop in Auto). */
export async function cycleMode(target: Mode, io: CycleIO, from?: Mode): Promise<{ res: CycleResult; mode: Mode | undefined }> {
  let f = await io.read()
  if (from && f.mode !== from) return { res: 'changed', mode: f.mode } // the user confirmed a path from `from`: nothing is pressed from another mode
  for (let presses = 0, stale = 0; ; ) {
    const end = (res: CycleResult) => ({ res, mode: f.mode })
    if (f.state !== 'idle') return end('busy')
    if (f.mode === target) return end('done')
    if (!f.mode) return end('unreadable')
    if (presses >= MAX_PRESSES) return end('gave-up')
    const r = await io.press(f.seq)
    if (r === 'gone') return end('gone')
    if (r === 'stale') {
      if (++stale > 2) return end('stale')
      f = await io.read()
      continue
    }
    presses++
    const prev = f.mode
    f = await io.after(prev)
    if (f.mode === prev) return end('unchanged')
  }
}

/** Prompt-side tokens of the last response = what the context holds now (output excluded). */
export const tokenCount = (t: TMeta['tokens']): number => (t ? t.input + t.cacheRead + t.cacheCreate : 0)

/** Context window by model family (static estimate; unknown models only show the token count). */
export function contextInfo(model: string | undefined, used: number): { used: number; window?: number; pct?: number } {
  const window = !model ? undefined : /1m\b/i.test(model) || (used > 200_000 && /opus|sonnet|haiku/i.test(model)) ? 1_000_000 : /opus|sonnet|haiku/i.test(model) ? 200_000 : undefined
  return window ? { used, window, pct: Math.min(100, Math.round((used / window) * 100)) } : { used }
}
