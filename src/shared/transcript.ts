import type { RelayApi, TBatch, TEvent, TMeta, TranscriptRef } from './types'

/** Renderer-side state for one session (or subagent thread). */
export interface TState {
  events: TEvent[]
  meta: TMeta
  seq: number
  /** byte offset for the next `older` request; null = all loaded */
  older: number | null | undefined
}
export const emptyTState = (): TState => ({ events: [], meta: {}, seq: -1, older: undefined })

/** Idempotent (keyed by accountId+sessionId[+agentId] in the caller): events upsert by id (kept sorted by `at`), a live batch with an already seen seq is ignored, a snapshot (seq + older) replaces the events, an older page never overrides newer meta. */
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

/** A tool_use of AskUserQuestion / ExitPlanMode with no result yet: the CLI is waiting for the user (the only reliable wait signal). */
export const isPendingAsk = (e: TEvent): boolean => e.kind === 'tool' && e.status === 'pending' && (e.name === 'AskUserQuestion' || e.name === 'ExitPlanMode')

/** The part of `RelayApi.transcript` the feed uses. */
export type FeedApi = Pick<RelayApi['transcript'], 'subscribe' | 'unsubscribe' | 'older' | 'onEvents'>

/**
 * Live state of ONE session in ONE tab (never shared across tabs): subscribes, buffers live batches until the subscribe snapshot is
 * in (applyBatch drops the ones it already contains), and drops an `older` reply that was requested before the latest snapshot
 * (a re-subscribe or a rewritten file replaced the events, its byte offsets no longer apply).
 */
export function createFeed(api: FeedApi, ref: TranscriptRef, onChange: (s: TState) => void) {
  let s = emptyTState()
  let gen = 0 // bumped by every snapshot
  let ready = false
  let dead = false
  let busy = false
  let buf: TBatch[] = []
  const apply = (b: TBatch): void => {
    if (b.seq !== undefined && b.older !== undefined) gen++
    s = applyBatch(s, b)
    onChange(s)
  }
  const off = api.onEvents((b) => {
    if (b.accountId !== ref.accountId || b.sessionId !== ref.sessionId || b.agentId) return
    if (ready) apply(b)
    else buf.push(b)
  })
  api.subscribe(ref).then(
    (snap) => {
      if (dead) return
      apply(snap)
      ready = true
      buf.forEach(apply)
      buf = []
    },
    () => undefined // no such session / not Claude: the view stays empty
  )
  return {
    state: () => s,
    /** loads the page before the oldest loaded event (no-op when everything is loaded or a request is in flight) */
    older(): void {
      if (!ready || busy || s.older == null) return
      const g = gen
      busy = true
      api.older(ref, s.older).then(
        (b) => ((busy = false), !dead && g === gen && apply(b)),
        () => void (busy = false)
      )
    },
    stop(): void {
      dead = true
      off()
      void api.unsubscribe(ref).catch(() => undefined)
    }
  }
}
