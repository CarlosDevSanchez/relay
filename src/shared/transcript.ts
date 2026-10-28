import type { TBatch, TEvent, TMeta } from './types'

/** Renderer-side state for one session (or subagent thread). */
export interface TState {
  events: TEvent[]
  meta: TMeta
  seq: number
  /** byte offset for the next `older` request; null = all loaded */
  older: number | null | undefined
}
export const emptyTState = (): TState => ({ events: [], meta: {}, seq: -1, older: undefined })

/** Idempotent (keyed by accountId+sessionId[+agentId] in the caller): events upsert by id (kept sorted by `at`), a live batch with an already seen seq is ignored, an older page never overrides newer meta. */
export function applyBatch(s: TState, b: TBatch): TState {
  const snap = b.seq !== undefined && b.older !== undefined // a snapshot resets the stream position (re-subscribe)
  if (b.seq !== undefined && !snap && b.seq <= s.seq) return s
  const byId = new Map(s.events.map((e) => [e.id, e]))
  if (snap) byId.clear() // a snapshot replaces the events (new subscription or a rewritten file)
  for (const e of b.events) byId.set(e.id, e)
  const live = b.seq !== undefined
  return {
    events: [...byId.values()].sort((a, c) => a.at - c.at),
    meta: live ? { ...s.meta, ...b.meta } : { ...b.meta, ...s.meta },
    seq: live ? b.seq! : s.seq,
    older: b.older === undefined ? s.older : live && s.older !== undefined && !snap ? s.older : b.older
  }
}
