import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'

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
 * Handles a file that does not exist yet and truncation. fs.watch triggers `check`; a 1s interval is the fallback.
 */
export function tailFile(file: string, onLines: (lines: string[]) => void): { check(): void; stop(): void } {
  const size = (): number => {
    try {
      return statSync(file).size
    } catch {
      return -1
    }
  }
  let off = Math.max(size(), 0)
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
      off = 0
      pending = Buffer.alloc(0)
    }
    if (n === off) return
    const chunk = Buffer.alloc(n - off)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, chunk, 0, chunk.length, off)
    } finally {
      closeSync(fd)
    }
    off = n
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

/** Calls `onHit` for each new rate_limit line (repeats with the same reset text are collapsed). */
export function watchLimits(file: string, onHit: (h: LimitInfo) => void): { check(): void; stop(): void } {
  let last = ''
  return tailFile(file, (lines) => {
    for (const l of lines) {
      const h = parseLimitLine(l)
      if (h && h.resetText !== last) {
        last = h.resetText
        onHit(h)
      }
    }
  })
}

/** Runs `fn` at `resetAt` (ignored when past or beyond setTimeout's range). Returns a canceller. */
export function scheduleAt(resetAt: number, fn: () => void, now = Date.now()): () => void {
  const ms = resetAt - now
  if (!(ms > 0 && ms < 2 ** 31)) return () => undefined
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}
