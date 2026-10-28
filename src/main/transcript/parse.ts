import type { TDiff, TEvent, THunk, TMeta } from '../../shared/types'

type Obj = Record<string, unknown>
export type Tool = Extract<TEvent, { kind: 'tool' }>
/** What a tool_result adds to its tool event. */
export type Done = Pick<Tool, 'status'> & Partial<Pick<Tool, 'result' | 'interrupted' | 'diffs' | 'agentId'>> & { ts: number }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const RESULT_MAX = 8000
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** Bulky input fields already shown as a diff. */
const DROP: Record<string, string[]> = { Write: ['content'], Edit: ['old_string', 'new_string'], MultiEdit: ['edits'] }

/** Bounded copy of a tool input (depth, item count and string length capped). */
function clip(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return cut(v, 2000)
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v
  if (depth > 4) return undefined
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clip(x, depth + 1))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, clip(x, depth + 1)]))
  return undefined
}

const hunks = (v: unknown): THunk[] =>
  Array.isArray(v)
    ? v.flatMap((h) =>
        isObj(h) && Array.isArray(h.lines)
          ? [{ oldStart: num(h.oldStart) ?? 0, oldLines: num(h.oldLines) ?? 0, newStart: num(h.newStart) ?? 0, newLines: num(h.newLines) ?? 0, lines: h.lines.filter((l): l is string => typeof l === 'string').slice(0, 2000) }]
          : []
      )
    : []

/** toolUseResult (any shape, possibly a string) -> diffs: structuredPatch, Write from `content` when the patch is empty, bashEditDiff. */
function diffsOf(r: Obj): TDiff[] {
  const out: TDiff[] = []
  const file = str(r.filePath)
  if (file && Array.isArray(r.structuredPatch)) {
    const h = hunks(r.structuredPatch)
    if (h.length) out.push({ file, hunks: h })
    else if (typeof r.content === 'string') {
      const lines = r.content.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      out.push({ file, ...(r.type === 'create' ? { created: true } : {}), hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.slice(0, 2000).map((l) => '+' + l) }] })
    }
  }
  const b = r.bashEditDiff
  if (isObj(b) && Array.isArray(b.files))
    for (const f of b.files) {
      const name = isObj(f) ? str(f.filePath) : undefined
      if (isObj(f) && name) out.push({ file: name, hunks: hunks(f.hunks), ...(f.created === true ? { created: true } : {}), ...(f.deleted === true ? { deleted: true } : {}) })
    }
  return out
}

/** tool_result block (+ the line's toolUseResult) -> update for its tool event. */
function done(b: Obj, r: unknown, ts: number): Done {
  const c = b.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.flatMap((x) => (isObj(x) && x.type === 'text' && typeof x.text === 'string' ? [x.text] : [])).join('\n') : ''
  const d: Done = { status: b.is_error === true ? 'error' : 'ok', result: cut(text, RESULT_MAX), ts }
  if (isObj(r)) {
    if (r.interrupted === true) d.interrupted = true
    const diffs = diffsOf(r)
    if (diffs.length) d.diffs = diffs
    if (typeof r.agentId === 'string' && /^[0-9a-f]{8,64}$/i.test(r.agentId)) d.agentId = r.agentId
  }
  return d
}

const textOf = (c: unknown): string[] =>
  typeof c === 'string' ? [c] : Array.isArray(c) ? c.flatMap((x) => (isObj(x) && x.type === 'text' && typeof x.text === 'string' ? [x.text] : [])) : []

export interface Parser {
  /** `at`: byte offset of the line in the file (total order; timestamps are not monotonic) */
  push(line: string, at: number): void
  /** events changed since the last flush (sorted by `at`) and the meta when it changed */
  flush(): { events: TEvent[]; meta?: TMeta }
  size(): number
}

/**
 * Tolerant, allowlist-based parser: every output field is copied from a known input field. Unknown line types, block types and
 * fields are ignored. `orphans` keeps tool_results whose tool_use is outside the parsed window (shared with older pages).
 */
export function createParser(orphans: Map<string, Done> = new Map(), tools: Map<string, { ev: Tool; ts: number }> = new Map()): Parser {
  const events = new Map<string, TEvent>()
  const anchor = new Map<string, number>() // message.id -> `at` of its first line: a message's blocks stay together
  const dirty = new Set<string>()
  const meta: TMeta = {}
  let metaDirty = false
  const set = (e: TEvent): void => {
    events.set(e.id, e)
    dirty.add(e.id)
  }
  const m = <K extends keyof TMeta>(k: K, v: TMeta[K] | undefined): void => {
    if (v !== undefined && meta[k] !== v && JSON.stringify(meta[k]) !== JSON.stringify(v)) (meta[k] = v), (metaDirty = true)
  }
  const finish = (t: { ev: Tool; ts: number }, d: Done): void => {
    const { ts, ...rest } = d
    Object.assign(t.ev, rest)
    if (ts && t.ts) t.ev.durationMs = Math.max(0, ts - t.ts)
    dirty.add(t.ev.id)
  }

  const settle = (id: string, res: Done): void => {
    const tool = tools.get(id)
    if (tool) finish(tool, res)
    else orphans.set(id, res)
  }

  function line(d: Obj, at: number): void {
    const ts = Date.parse(String(d.timestamp))
    const t = d.type
    if (t === 'ai-title') return m('title', str(d.aiTitle))
    if (t === 'permission-mode') return m('permissionMode', str(d.permissionMode))
    if (t !== 'user' && t !== 'assistant' && t !== 'system') return
    m('cwd', str(d.cwd))
    m('gitBranch', str(d.gitBranch))
    m('version', str(d.version))
    const uuid = str(d.uuid) ?? String(at)
    const msg = isObj(d.message) ? d.message : {}
    if (t === 'system') {
      const sub = d.subtype
      const base = { id: uuid, at: at * 1000, kind: 'notice' } as const
      if (sub === 'turn_duration') set({ ...base, notice: 'turn', durationMs: num(d.durationMs) })
      else if (sub === 'compact_boundary') {
        const c = isObj(d.compactMetadata) ? d.compactMetadata : {}
        set({ ...base, notice: 'compact', preTokens: num(c.preTokens), postTokens: num(c.postTokens) })
      } else if (sub === 'informational' && typeof d.content === 'string') set({ ...base, notice: 'info', text: cut(d.content, 500) })
      return
    }
    if (t === 'user') {
      if (d.isMeta === true || d.isCompactSummary === true) return
      const c = msg.content
      if (typeof c === 'string') return set({ id: `${uuid}:0`, at: at * 1000, kind: 'message', role: 'user', text: c })
      if (!Array.isArray(c)) return
      c.forEach((b, i) => {
        if (!isObj(b)) return
        if (b.type === 'text' && typeof b.text === 'string') set({ id: `${uuid}:${i}`, at: at * 1000 + i, kind: 'message', role: 'user', text: b.text })
        else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          settle(b.tool_use_id, done(b, d.toolUseResult, ts))
        }
      })
      return
    }
    // assistant
    const u = msg.usage
    const synthetic = msg.model === '<synthetic>'
    if (!synthetic) {
      m('model', str(msg.model))
      if (isObj(u)) m('tokens', { input: num(u.input_tokens) ?? 0, output: num(u.output_tokens) ?? 0, cacheRead: num(u.cache_read_input_tokens) ?? 0, cacheCreate: num(u.cache_creation_input_tokens) ?? 0 })
    }
    const content = Array.isArray(msg.content) ? msg.content : []
    if (d.isApiErrorMessage === true) {
      const text = cut(textOf(content).join('\n'), 500)
      const q = isObj(d.quotaLimits) ? d.quotaLimits : {}
      const resets = num(q.resetsAt)
      const rl = d.error === 'rate_limit'
      return set({ id: uuid, at: at * 1000, kind: 'notice', notice: rl ? 'rate_limit' : 'api_error', text, ...(rl && resets ? { resetsAt: resets * 1000 } : {}), ...(rl && str(q.rateLimitType) ? { limitType: str(q.rateLimitType) } : {}), ...(!rl ? { code: str(d.error) } : {}) })
    }
    const mid = str(msg.id)
    let base = at
    if (mid) base = anchor.get(mid) ?? (anchor.set(mid, at), at)
    const idx = num(d.apiBlockIndex)
    content.forEach((b, i) => {
      if (!isObj(b)) return
      const n = idx ?? i
      const id = `${mid ?? uuid}:${n}`
      const pos = base * 1000 + n
      if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') set({ id, at: pos, kind: 'message', role: 'assistant', text: b.text })
      else if (b.type === 'thinking') set({ id, at: pos, kind: 'thinking', durationMs: num(d.thinkingDurationMs) })
      else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const drop = DROP[b.name] ?? []
        const input = isObj(b.input) ? clip(Object.fromEntries(Object.entries(b.input).filter(([k]) => !drop.includes(k)))) : {}
        const ev: Tool = { id: b.id, at: pos, kind: 'tool', name: b.name, input, status: 'pending' }
        const tool = { ev, ts }
        tools.set(b.id, tool)
        const early = orphans.get(b.id)
        if (early) finish(tool, early) // kept: the same older page may be read again
        set(ev)
      }
    })
  }

  return {
    push(l, at) {
      if (l === '') return
      let d: unknown
      try {
        d = JSON.parse(l)
      } catch {
        return // truncated or invalid line
      }
      if (isObj(d)) line(d, at)
    },
    flush() {
      const out = [...dirty].map((id) => events.get(id) ?? tools.get(id)!.ev).sort((a, b) => a.at - b.at)
      dirty.clear()
      const r: { events: TEvent[]; meta?: TMeta } = { events: out }
      if (metaDirty) (r.meta = { ...meta }), (metaDirty = false)
      return r
    },
    size: () => events.size
  }
}

/** A tool_use of AskUserQuestion / ExitPlanMode with no result yet: the CLI is waiting for the user (the only reliable wait signal). */
export const isPendingAsk = (e: TEvent): boolean => e.kind === 'tool' && e.status === 'pending' && (e.name === 'AskUserQuestion' || e.name === 'ExitPlanMode')
