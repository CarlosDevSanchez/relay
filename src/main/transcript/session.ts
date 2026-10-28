import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TBatch, TEvent, TMeta } from '../../shared/types'
import { tailFile } from '../limit'
import { createParser, type Done, type Tool } from './parse'

/** Events per page (a page is whole lines, so it can hold a few more). */
export const PAGE = 200
const FIRST_CHUNK = 128 * 1024
/** A page never reads more than this once it has parsed something. */
const BUDGET = 1024 * 1024

const readAt = (fd: number, start: number, end: number): Buffer => {
  const b = Buffer.alloc(end - start)
  return b.subarray(0, readSync(fd, b, 0, b.length, start))
}

/** Offset just after the last '\n' in [0,size) (0 when none): a trailing partial line is not part of any page. */
function lineEnd(fd: number, size: number): number {
  for (let hi = size; hi > 0; ) {
    const lo = Math.max(0, hi - 64 * 1024)
    const i = readAt(fd, lo, hi).lastIndexOf(10)
    if (i >= 0) return lo + i + 1
    hi = lo
  }
  return 0
}

export interface Page extends Pick<TBatch, 'events' | 'meta' | 'older'> {
  /** end of the parsed range (start of the unread tail) */
  end: number
}
type Tools = Map<string, { ev: Tool; ts: number }>

/**
 * Last ~PAGE events before `before` (default: the end of the file), reading backwards in chunks aligned to line starts; each byte is
 * parsed once and a page is capped by BUDGET bytes, so one page never reads a huge file. Missing file = empty page.
 * `orphans` and `tools` link tool_use/tool_result pairs that fall in different pages or in the live tail.
 */
export function readPage(file: string, before?: number, orphans = new Map<string, Done>(), min = PAGE, tools: Tools = new Map()): Page {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return { events: [], older: null, end: 0 }
  }
  try {
    const end = lineEnd(fd, Math.min(before ?? Infinity, fstatSync(fd).size))
    let events: TEvent[] = []
    let meta: TMeta = {}
    let lo = end
    let head: Buffer = Buffer.alloc(0) // partial line at the start of the region read so far
    for (let n = FIRST_CHUNK; ; n *= 2) {
      const start = Math.max(0, lo - n)
      const buf = Buffer.concat([readAt(fd, start, lo), head])
      const nl = start > 0 ? buf.indexOf(10) : -1
      const skip = start === 0 ? 0 : nl < 0 ? buf.length : nl + 1
      head = buf.subarray(0, skip)
      lo = start
      const parser = createParser(orphans, tools)
      for (let p = skip; p < buf.length; ) {
        const q = buf.indexOf(10, p)
        const line = buf.subarray(p, q < 0 ? buf.length : q)
        parser.push(line.toString('utf8'), start + p)
        p += line.length + 1
      }
      const r = parser.flush()
      events = [...r.events, ...events]
      meta = { ...r.meta, ...meta }
      const parsed = start + skip < end
      if (start === 0 || events.length >= min || (parsed && end - start >= BUDGET))
        return { events, ...(Object.keys(meta).length ? { meta } : {}), older: start === 0 ? null : start + skip, end }
    }
  } finally {
    closeSync(fd)
  }
}

export interface Session {
  /** last page up to what the tail has read, carrying the stream's current seq */
  snapshot(): TBatch
  older(before: number): TBatch
  subagent(agentId: string, before?: number): TBatch
  stop(): void
}

/**
 * Live view of one session transcript: batches of changes through `onBatch` (seq 1, 2, ...). Subagent threads are read only when asked for.
 */
export function openSession(file: string, sessionId: string, accountId: string, onBatch: (b: TBatch) => void): Session {
  const orphans = new Map<string, Done>()
  const tools: Tools = new Map()
  const agents = new Map<string, Map<string, Done>>()
  const first = readPage(file, undefined, orphans, PAGE, tools)
  let live = createParser(orphans, tools)
  let pos = first.end
  let seq = 0
  const tail = tailFile(
    file,
    (lines) => {
      for (const l of lines) {
        live.push(l, pos)
        pos += Buffer.byteLength(l) + 1
      }
      const { events, meta } = live.flush()
      if (events.length || meta) onBatch({ accountId, sessionId, seq: ++seq, events, ...(meta ? { meta } : {}) })
    },
    first.end,
    () => {
      // the file shrank (rewritten): start over with a bounded snapshot of the new content (the renderer replaces its events) and resume the tail after it
      orphans.clear()
      tools.clear()
      live = createParser(orphans, tools)
      const p = readPage(file, undefined, orphans, PAGE, tools)
      pos = p.end
      onBatch({ ...page(p), seq: ++seq })
      return p.end
    }
  )
  const page = (p: Page, extra: object = {}): TBatch => ({ accountId, sessionId, ...extra, events: p.events, ...(p.meta ? { meta: p.meta } : {}), older: p.older })
  return {
    snapshot: () => ({ ...page(pos === first.end && seq === 0 ? first : readPage(file, pos)), seq }),
    older: (before) => page(readPage(file, before, orphans, PAGE, tools)),
    subagent: (agentId, before) => {
      const f = join(dirname(file), sessionId, 'subagents', `agent-${agentId}.jsonl`)
      let o = agents.get(agentId)
      if (!o) agents.set(agentId, (o = new Map()))
      return page(readPage(f, before, o), { agentId })
    },
    stop: tail.stop
  }
}

/** One live stream per accountId+sessionId shared by every subscriber (tabs); it stops when the last one leaves. */
export function createHub(onBatch: (b: TBatch) => void) {
  const m = new Map<string, { s: Session; n: number }>()
  return {
    subscribe(accountId: string, sessionId: string, file: string): TBatch {
      const k = `${accountId}:${sessionId}`
      let e = m.get(k)
      if (!e) m.set(k, (e = { s: openSession(file, sessionId, accountId, onBatch), n: 0 }))
      e.n++
      return e.s.snapshot()
    },
    unsubscribe(accountId: string, sessionId: string): void {
      const k = `${accountId}:${sessionId}`
      const e = m.get(k)
      if (e && --e.n <= 0) (e.s.stop(), m.delete(k))
    },
    get: (accountId: string, sessionId: string): Session | undefined => m.get(`${accountId}:${sessionId}`)?.s,
    stopAll(): void {
      m.forEach((e) => e.s.stop())
      m.clear()
    }
  }
}
