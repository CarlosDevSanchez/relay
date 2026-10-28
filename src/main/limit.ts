import { closeSync, openSync, readSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { isSessionId } from './validate'

const LIMIT_RE = /hit your (\w+) limit · resets (.+)/
const RESET_RE = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)\s*$/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Offset (ms) of `tz` from UTC at instant `ms`. Throws RangeError on an unknown zone. */
function tzOffset(ms: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)])
  ) as Record<string, number>
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000
}

/** Epoch of the wall-clock time y-m-d h:min in `tz` (month 0-based; day overflow normalises). */
function wall(y: number, mo: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, min)
  const first = guess - tzOffset(guess, tz)
  return guess - tzOffset(first, tz) // second pass settles DST boundaries
}

/**
 * "1:10am (America/Bogota)" or "Oct 30, 9am (TZ)" -> epoch ms of the next such wall-clock time after `refTs`.
 * Unknown format or zone -> null.
 */
export function parseResetAt(resetText: string, refTs: number): number | null {
  const m = RESET_RE.exec(resetText.trim())
  if (!m) return null
  const [, mon, day, hh, mm, ap, tz] = m
  const h12 = Number(hh)
  if (h12 < 1 || h12 > 12) return null
  const h = (h12 % 12) + (ap!.toLowerCase() === 'pm' ? 12 : 0)
  const min = Number(mm ?? 0)
  if (min > 59) return null
  try {
    const ref = new Date(refTs + tzOffset(refTs, tz!)) // wall clock of refTs in tz, read via getUTC*
    const y = ref.getUTCFullYear()
    if (mon) {
      const mo = MONTHS.indexOf(mon.toLowerCase())
      if (mo < 0) return null
      const at = wall(y, mo, Number(day), h, min, tz!)
      return at > refTs ? at : wall(y + 1, mo, Number(day), h, min, tz!)
    }
    const at = wall(y, ref.getUTCMonth(), ref.getUTCDate(), h, min, tz!)
    return at > refTs ? at : wall(y, ref.getUTCMonth(), ref.getUTCDate() + 1, h, min, tz!)
  } catch {
    return null
  }
}

export interface LimitInfo {
  kind: string
  resetText: string
  resetAt: number | null
  /** Codex: limit of one model only (no reset time); another model still works, so no account switch is offered */
  modelSpecific?: boolean
}

/** Text of a rate_limit message -> kind + reset; null when it is not one. */
export function parseLimitText(text: string, ts: number): LimitInfo | null {
  const m = LIMIT_RE.exec(text)
  if (!m) return null
  const resetText = m[2]!.trim()
  return { kind: m[1]!, resetText, resetAt: parseResetAt(resetText, ts) }
}

/** One transcript line -> rate_limit info (with the line's timestamp), or null. */
export function parseLimitLine(line: string): (LimitInfo & { ts: number }) | null {
  if (!line.includes('rate_limit')) return null
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  const ts = Date.parse(d?.timestamp)
  if (d?.type !== 'assistant' || !d.isApiErrorMessage || d.error !== 'rate_limit' || Number.isNaN(ts)) return null
  const info = parseLimitText(String(d.message?.content?.[0]?.text ?? ''), ts)
  return info && { ...info, ts }
}

/**
 * Reads only bytes appended after creation (complete lines; a partial tail waits for its newline).
 * `from` starts at a known offset instead of the current end; `onReset` is called when the file shrank (it is then read from 0). Handles a file that does not exist yet and truncation. fs.watch triggers `check`; a 1s interval is the fallback.
 */
export function tailFile(file: string, onLines: (lines: string[]) => void, from?: number, onReset?: () => void): { check(): void; stop(): void } {
  const size = (): number => {
    try {
      return statSync(file).size
    } catch {
      return -1
    }
  }
  let off = from ?? Math.max(size(), 0)
  let pending = Buffer.alloc(0)
  let watcher: FSWatcher | undefined
  const check = (): void => {
    const n = size()
    if (n < 0) return
    if (!watcher) {
      try {
        watcher = watch(file, check)
        watcher.on('error', () => undefined)
      } catch {
        // interval fallback
      }
    }
    if (n < off) {
      onReset?.()
      off = 0
      pending = Buffer.alloc(0)
    }
    if (n === off) return
    let chunk = Buffer.alloc(n - off)
    try {
      const fd = openSync(file, 'r')
      try {
        chunk = chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, off))
      } finally {
        closeSync(fd)
      }
    } catch {
      return // vanished or unreadable: retry on the next tick
    }
    off += chunk.length
    const buf = Buffer.concat([pending, chunk])
    const end = buf.lastIndexOf(10)
    pending = buf.subarray(end + 1)
    if (end >= 0) onLines(buf.subarray(0, end).toString('utf8').split('\n'))
  }
  const t = setInterval(check, 1000)
  t.unref()
  return {
    check,
    stop: () => {
      clearInterval(t)
      watcher?.close()
    }
  }
}

/**
 * Calls `onHit` for each new rate_limit line. A repeat of the same limit is collapsed: same resetAt,
 * or (reset unparsed) same text within 5 minutes.
 */
export function watchLimits(file: string, onHit: (h: LimitInfo) => void, now = Date.now, parse: (line: string) => LimitInfo | null = parseLimitLine): { check(): void; stop(): void } {
  let last: { key: string; at: number } | undefined
  return tailFile(file, (lines) => {
    for (const l of lines) {
      const h = parse(l)
      if (!h) continue
      const key = h.resetAt !== null ? String(h.resetAt) : h.resetText
      if (last?.key === key && (h.resetAt !== null || now() - last.at < 300_000)) continue
      last = { key, at: now() }
      onHit(h)
    }
  })
}

/**
 * /clear or an in-CLI new session changes the CLI's session id. Reports transcripts in `dir` whose NAME is new since
 * the watcher started (existing names are remembered, so only new names are stat'ed), were born after `since`
 * and that `skip` does not claim. It only reports candidates; `pickRebind` decides what to do with them.
 */
export function watchNewSession(dir: string, since: number, skip: (id: string) => boolean, onNew: (ids: string[]) => void): { check(): void; stop(): void } {
  const seen = new Set<string>()
  const list = (): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  for (const f of list()) seen.add(f)
  const check = (): void => {
    const fresh: string[] = []
    for (const f of list()) {
      if (seen.has(f)) continue
      seen.add(f)
      const id = f.slice(0, -6)
      if (!f.endsWith('.jsonl') || !isSessionId(id) || skip(id)) continue
      try {
        if (statSync(join(dir, f)).birthtimeMs >= since) fresh.push(id)
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

/** Rebind only when the tab is the sole live Relay pty for its account+cwd and exactly one candidate exists; otherwise the session is stale. */
export function pickRebind(candidates: string[], livePtys: number): { id: string } | 'stale' | null {
  if (!candidates.length) return null
  return candidates.length === 1 && livePtys === 1 ? { id: candidates[0]! } : 'stale'
}

/** Runs `fn` at `resetAt` (ignored when past or beyond setTimeout's range). Returns a canceller. */
export function scheduleAt(resetAt: number, fn: () => void, now = Date.now()): () => void {
  const ms = resetAt - now
  if (!(ms > 0 && ms < 2 ** 31)) return () => undefined
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}
