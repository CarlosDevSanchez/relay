import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, AccountStatus, SessionInfo, UsageWindow } from '../shared/types'
import type { LimitInfo } from './limit'
import type { CopyRecord } from './store'
import { isSessionId } from './validate'

/**
 * Codex transcripts ("rollouts"): `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local ts>-<session id>.jsonl` (docs/spikes/F5.md).
 * Line 1 is `session_meta` (`payload.id`, `payload.cwd`); each line is `{timestamp, type, payload}`.
 */
const NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const META = 64 * 1024 // line 1 (session_meta) alone is ~20 KB (base instructions)
const HEAD = 512 * 1024 // the first user message follows within the first ~100 KB; only read for rollouts of the project
const TAIL = 256 * 1024
const DAY = 86400_000

const dirs = (p: string, re: RegExp): string[] => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name)
  } catch {
    return []
  }
}

export interface Rollout {
  path: string
  id: string
}

const inDay = (day: string): Rollout[] => {
  try {
    return readdirSync(day, { withFileTypes: true }).flatMap((e) => {
      const m = e.isFile() ? NAME.exec(e.name) : null // symlinks are not regular files here: never followed
      return m ? [{ path: join(day, e.name), id: m[1]!.toLowerCase() }] : []
    })
  } catch {
    return []
  }
}

/** Every rollout under `<configDir>/sessions`. */
export function rolloutFiles(configDir: string): Rollout[] {
  const root = join(configDir, 'sessions')
  return dirs(root, /^\d{4}$/).flatMap((y) => dirs(join(root, y), /^\d{2}$/).flatMap((m) => dirs(join(root, y, m), /^\d{2}$/).flatMap((d) => inDay(join(root, y, m, d)))))
}

/** Path of the rollout of `id` (a regular file), or undefined. */
export const findRollout = (configDir: string, id: string): string | undefined => (isSessionId(id) ? rolloutFiles(configDir).find((f) => f.id === id.toLowerCase())?.path : undefined)

/** Rollouts of today and yesterday (local time, as Codex names the dirs): new sessions can only appear there. */
function recentRollouts(configDir: string, now = Date.now()): Rollout[] {
  return [now, now - DAY].flatMap((t) => {
    const d = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return inDay(join(configDir, 'sessions', String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())))
  })
}

/** First `max` bytes (complete lines only when the file is longer). */
function head(file: string, max = HEAD): string[] {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(max)
    const n = readSync(fd, buf, 0, max, 0)
    const lines = buf.subarray(0, n).toString('utf8').split('\n')
    if (n === max) lines.pop() // possibly cut mid-line
    return lines
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const json = (l: string): any => {
  try {
    return JSON.parse(l)
  } catch {
    return undefined
  }
}

export interface RolloutMeta {
  id: string
  cwd: string
  originator?: string
  /** "cli" / "vscode" / "exec" for a top-level thread; an object ({"subagent": ...}) for a child thread */
  source?: unknown
  /** "user" for a top-level thread */
  threadSource?: unknown
  /** set on rollouts of child threads (multi-agent) */
  parent?: unknown
  forkedFrom?: unknown
}
/** `session_meta` of a rollout; undefined while line 1 is not written yet. */
export function rolloutMeta(lines: string[]): RolloutMeta | undefined {
  const d = json(lines[0] ?? '')
  const p = d?.type === 'session_meta' ? d.payload : undefined
  if (typeof p?.id !== 'string' || typeof p?.cwd !== 'string') return undefined
  return {
    id: p.id,
    cwd: p.cwd,
    ...(typeof p.originator === 'string' ? { originator: p.originator } : {}),
    source: p.source,
    threadSource: p.thread_source,
    parent: p.parent_thread_id ?? p.source?.subagent?.thread_spawn?.parent_thread_id,
    forkedFrom: p.forked_from_id
  }
}

/**
 * Interactive top-level thread: a plain string source (cli / vscode / exec), thread_source "user" (when present) and no parent thread.
 * Multi-agent child threads are separate rollouts of the same cwd (`source: {"subagent": ...}`) that the CLI refuses to resume.
 */
export const isTopLevel = (m: RolloutMeta): boolean => typeof m.source === 'string' && (m.threadSource === undefined || m.threadSource === 'user') && m.parent == null

/** The Codex TUI in a Relay tab (real 0.164 shape: originator "codex-tui", source "vscode"): `codex exec` (codex_exec) and the IDE extension (codex_vscode) must not bind a tab. */
export const isTuiThread = (m: RolloutMeta): boolean => isTopLevel(m) && m.originator === 'codex-tui'

/** First real user prompt: the `UserMessage` item (or legacy `user_message` event); AGENTS.md / environment wrappers are `response_item`s and never match. */
export function rolloutTitle(lines: string[]): string {
  for (const l of lines) {
    if (!l.includes('"event_msg"')) continue
    const p = json(l)?.payload
    const text = p?.type === 'item_completed' && p.item?.type === 'UserMessage' ? p.item.content?.find((c: any) => c?.type === 'text')?.text : p?.type === 'user_message' ? p.message : undefined
    if (typeof text === 'string' && text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 120)
  }
  return '(untitled)'
}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
export const sameDir = (a: string, b: string): boolean => a === b || real(a) === real(b)

/** session_meta of the rollout at `path` (reads 64 KB). */
export const readRolloutMeta = (path: string): RolloutMeta | undefined => rolloutMeta(head(path, META)) ?? rolloutMeta(head(path)) // line 1 longer than 64 KB: retry with the full head

// unchanged files (same size + mtime) are not re-read; the title is read only for rollouts of the listed project
const infos = new Map<string, { size: number; mtimeMs: number; meta?: RolloutMeta; title?: string }>()

/** Codex sessions of the project `cwd` (by the cwd recorded in the rollout), newest copy per id. */
export function listCodexSessions(accounts: Account[], cwd: string): SessionInfo[] {
  const out: SessionInfo[] = []
  for (const a of accounts.filter((x) => x.provider === 'codex')) {
    for (const f of rolloutFiles(a.configDir)) {
      let st
      try {
        st = statSync(f.path)
      } catch {
        continue
      }
      let c = infos.get(f.path)
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
        const meta = readRolloutMeta(f.path)
        infos.set(f.path, (c = { size: st.size, mtimeMs: st.mtimeMs, ...(meta ? { meta } : {}) }))
      }
      if (c.meta && isTopLevel(c.meta) && sameDir(c.meta.cwd, cwd)) {
        c.title ??= rolloutTitle(head(f.path))
        out.push({ id: f.id, title: c.title, mtimeMs: st.mtimeMs, accountId: a.id })
      }
    }
  }
  return out
}

// ---- usage limit ----
// Quota signal (verified with a stubbed 429 `usage_limit_reached`): a `task_complete` (or `error`) event whose `codex_error_info` is "usage_limit_exceeded"
// and whose message ends in "try again at <%b %-d, %Y %-I:%M %p, local time>". Other errors (rate_limit_exceeded: "try again in 5s") are NOT quota.
const AT = /try again at (.+?)\.?\s*$/i

const CLOCK = /^(\d{1,2}):(\d{2})\s*([AP])M$/i

/**
 * Local time -> epoch ms; null when it does not parse. The CLI prints "Dec 31st, 2029 7:00 PM" for another day and only "3:15 PM" for today
 * (docs/spikes/F5.md); a bare clock time is today relative to `now` (the line's timestamp), tomorrow if already past.
 */
export function parseCodexReset(text: string, now = Date.now()): number | null {
  const c = CLOCK.exec(text.trim())
  if (c) {
    const h = Number(c[1])
    const m = Number(c[2])
    if (h < 1 || h > 12 || m > 59) return null
    const d = new Date(now)
    d.setHours((h % 12) + (c[3]!.toUpperCase() === 'P' ? 12 : 0), m, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const clean = text.replace(/(\d)(st|nd|rd|th)\b/i, '$1')
  // "Oct 28 at 3:15 PM": the binary also carries a year-less "%b %-d at %-I:%M %p" format; Date.parse would invent a year
  const noYear = /^([A-Za-z]{3,9}) (\d{1,2}) (?:at )?(\d{1,2}:\d{2} [AP]M)$/i.exec(clean)
  if (noYear) {
    const y = new Date(now).getFullYear()
    const t = Date.parse(`${noYear[1]} ${noYear[2]}, ${y} ${noYear[3]}`)
    if (Number.isNaN(t)) return null
    return t > now ? t : Date.parse(`${noYear[1]} ${noYear[2]}, ${y + 1} ${noYear[3]}`)
  }
  const t = Date.parse(clean)
  return Number.isNaN(t) ? null : t
}

/** "usage limit for <model>. Switch to another model now": switching account would not help the other models, and there is no reset time. */
const MODEL_LIMIT = /usage limit for .+?\.\s*Switch to another model/i

export function parseCodexLimitLine(line: string): (LimitInfo & { ts: number }) | null {
  if (!line.includes('usage_limit_exceeded')) return null
  const d = json(line)
  const p = d?.payload
  const ts = Date.parse(d?.timestamp)
  if (Number.isNaN(ts) || (p?.codex_error_info ?? p?.error?.codex_error_info) !== 'usage_limit_exceeded') return null
  const resetText = AT.exec(String(p?.message ?? p?.error?.message ?? ''))?.[1]?.trim()
  const msg = String(p?.message ?? p?.error?.message ?? '')
  return { kind: 'usage', resetText: resetText ?? 'a una hora desconocida', resetAt: resetText ? parseCodexReset(resetText, ts) : null, ts, ...(!resetText && MODEL_LIMIT.test(msg) ? { modelSpecific: true } : {}) }
}

/** Window id from its length: 300 min = "5h", 10080 = "7d", else "<n>d" / "<n>h" / "<n>min". */
const windowId = (min: number): string => (min === 300 ? '5h' : min === 10080 ? '7d' : min % 1440 === 0 ? `${min / 1440}d` : min % 60 === 0 ? `${min / 60}h` : `${min}min`)

/**
 * `event_msg` `token_count` whose `rate_limits` has `primary` / `secondary` windows ({used_percent, window_minutes, resets_at}). Only seen as null with the stub backend
 * (docs/spikes/F5.md), so the shape is unverified: a window missing any field is skipped, `resets_at` is epoch seconds (milliseconds also accepted).
 */
export function parseCodexRates(line: string): { ts: number; windows: UsageWindow[] } | null {
  if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) return null
  const d = json(line)
  const p = d?.payload
  const ts = Date.parse(d?.timestamp)
  if (Number.isNaN(ts) || p?.type !== 'token_count' || !p.rate_limits) return null
  const windows: UsageWindow[] = []
  for (const w of [p.rate_limits.primary, p.rate_limits.secondary]) {
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
    if (!ok(w?.used_percent) || !ok(w.window_minutes) || w.window_minutes <= 0 || !ok(w.resets_at)) continue
    windows.push({ id: windowId(w.window_minutes), pct: Math.min(100, Math.max(0, w.used_percent)), resetsAt: w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at })
  }
  return windows.length ? { ts, windows } : null
}

interface Scan {
  rates?: { ts: number; off: number; windows: UsageWindow[] }
  limit?: LimitInfo & { ts: number; off: number }
  /** newest successful model response (token_count with usage info) and its byte offset */
  ok: { ts: number; off: number }[]
}
const scans = new Map<string, { size: number; mtimeMs: number; scan: Scan }>()

function scanTail(path: string, size: number, mtimeMs: number): Scan {
  const hit = scans.get(path)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.scan
  const scan: Scan = { ok: [] }
  try {
    const start = Math.max(0, size - TAIL)
    const fd = openSync(path, 'r')
    let text: string
    try {
      const buf = Buffer.alloc(size - start)
      text = buf.subarray(0, readSync(fd, buf, 0, buf.length, start)).toString('utf8')
    } finally {
      closeSync(fd)
    }
    let off = start
    const lines = text.split('\n')
    if (start > 0) off += Buffer.byteLength(lines.shift() ?? '') + 1 // first line may be cut
    for (const l of lines) {
      const at = off
      off += Buffer.byteLength(l) + 1
      const lim = parseCodexLimitLine(l)
      const rates = lim ? null : parseCodexRates(l)
      if (rates && rates.ts >= (scan.rates?.ts ?? 0)) scan.rates = { ...rates, off: at }
      if (lim && lim.ts > (scan.limit?.ts ?? 0)) scan.limit = { ...lim, off: at }
      else if (l.includes('"token_count"') && l.includes('"total_token_usage"')) {
        const ts = Date.parse(json(l)?.timestamp)
        if (!Number.isNaN(ts)) scan.ok.push({ ts, off: at })
      }
    }
  } catch {
    // unreadable: no signal
  }
  scans.set(path, { size, mtimeMs, scan })
  return scan
}

/**
 * Active usage limit of an account from rollouts touched in the last 7 days: the newest limit event with a parseable reset time in the future
 * and no successful response after it. Lines copied in by a handoff (`copied` byte ranges) belong to another account and are ignored.
 */
export function scanCodexLimit(configDir: string, now = Date.now(), copied: Record<string, CopyRecord> = {}): AccountStatus['limited'] | undefined {
  let limit: (LimitInfo & { ts: number }) | undefined
  let lastOk = 0
  for (const f of rolloutFiles(configDir)) {
    let st
    try {
      st = statSync(f.path)
    } catch {
      continue
    }
    if (st.mtimeMs < now - 7 * DAY) continue
    const ranges = copied[f.id]?.ranges ?? []
    const mine = (off: number): boolean => !ranges.some(([a, b]) => off >= a && off < b)
    const s = scanTail(f.path, st.size, st.mtimeMs)
    if (s.limit && mine(s.limit.off) && s.limit.ts > (limit?.ts ?? 0)) limit = s.limit
    for (const o of s.ok) if (mine(o.off)) lastOk = Math.max(lastOk, o.ts)
  }
  if (!limit || limit.ts <= lastOk || limit.resetAt === null || now >= limit.resetAt) return undefined
  return { kind: limit.kind, resetText: limit.resetText, resetAt: limit.resetAt }
}

/** Newest `rate_limits` snapshot of rollouts touched in the last 7 days (lines copied in by a handoff are another account's and ignored). */
export function scanCodexRates(configDir: string, now = Date.now(), copied: Record<string, CopyRecord> = {}): { ts: number; windows: UsageWindow[] } | undefined {
  let best: { ts: number; windows: UsageWindow[] } | undefined
  for (const f of rolloutFiles(configDir)) {
    let st
    try {
      st = statSync(f.path)
    } catch {
      continue
    }
    if (st.mtimeMs < now - 7 * DAY) continue
    const r = scanTail(f.path, st.size, st.mtimeMs).rates
    if (r && !(copied[f.id]?.ranges ?? []).some(([a, b]) => r.off >= a && r.off < b) && r.ts > (best?.ts ?? 0)) best = r
  }
  return best
}

/**
 * Reports rollouts of `cwd` born after `since` that `skip` does not claim (today's and yesterday's dirs only; existing files are remembered).
 * A file whose line 1 is not written yet is retried on the next tick. It only reports candidates; `pickRebind` decides.
 */
export function watchCodexNewSession(configDir: string, cwd: string, since: number, skip: (id: string) => boolean, onNew: (ids: string[]) => void): { check(): void; stop(): void } {
  const seen = new Set(recentRollouts(configDir).map((f) => f.path))
  const check = (): void => {
    const fresh: string[] = []
    for (const f of recentRollouts(configDir)) {
      if (seen.has(f.path)) continue
      if (skip(f.id)) {
        seen.add(f.path)
        continue
      }
      const meta = readRolloutMeta(f.path)
      if (!meta) continue
      seen.add(f.path)
      try {
        // top-level TUI threads only: sub-agent / exec / IDE rollouts of the same cwd are not this tab
        if (statSync(f.path).birthtimeMs >= since && isTuiThread(meta) && sameDir(meta.cwd, cwd)) fresh.push(f.id)
      } catch {
        // vanished
      }
    }
    if (fresh.length) onNew(fresh)
  }
  const t = setInterval(check, 1000)
  t.unref()
  return { check, stop: () => clearInterval(t) }
}
