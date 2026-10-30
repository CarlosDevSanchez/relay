import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Account, AccountStatus } from '../shared/types'
import { scanCodexLimit } from './codex'
import { buildEnv } from './env'
import { parseLimitLine } from './limit'
import type { CopyRecord } from './store'
import { isSessionId } from './validate'
import { providers } from './providers'

const H = 3600_000
const WINDOW = 5 * H
// a session limit lasts <= 5h; others (weekly...) up to 7 days. Older lines are not considered active.
const maxAge = (kind: string): number => (kind === 'session' ? WINDOW : 7 * 24 * H)

/** Defensive parse of `claude auth status --json` stdout (stderr may carry noise). */
export function parseAuthStatus(stdout: string): { loggedIn: boolean | null; email?: string; plan?: string } {
  let d: any
  try {
    d = JSON.parse(stdout)
  } catch {
    return { loggedIn: null }
  }
  if (typeof d?.loggedIn !== 'boolean') return { loggedIn: null }
  return {
    loggedIn: d.loggedIn,
    ...(typeof d.email === 'string' && d.email ? { email: d.email } : {}),
    ...(typeof d.subscriptionType === 'string' && d.subscriptionType ? { plan: d.subscriptionType } : {})
  }
}

interface Part {
  msgs: { ts: number; off: number; key?: string; tok: number }[]
  limits: { ts: number; off: number; kind: string; resetText: string; resetAt: number | null }[]
}
// per-file cache: unchanged files (same size + mtime) are not re-read
const parts = new Map<string, { size: number; mtimeMs: number; part: Part }>()

async function* jsonlFiles(dir: string, minMtime: number): AsyncGenerator<{ path: string; size: number; mtimeMs: number }> {
  let ents
  try {
    ents = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const path = join(dir, e.name)
    if (e.isDirectory()) yield* jsonlFiles(path, minMtime)
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = await stat(path)
        if (st.mtimeMs >= minMtime) yield { path, size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        // vanished mid-scan
      }
    }
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

async function parseFile(f: { path: string; size: number; mtimeMs: number }): Promise<Part | null> {
  const hit = parts.get(f.path)
  if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.part
  let text: string
  try {
    text = await readFile(f.path, 'utf8')
  } catch {
    return null
  }
  const part: Part = { msgs: [], limits: [] }
  let off = 0
  for (const l of text.split('\n')) {
    const at = off
    off += Buffer.byteLength(l) + 1
    if (!l.includes('"assistant"')) continue
    let d: any
    try {
      d = JSON.parse(l)
    } catch {
      continue
    }
    const ts = Date.parse(d?.timestamp)
    if (d?.type !== 'assistant' || Number.isNaN(ts)) continue
    if (d.isApiErrorMessage) {
      const m = parseLimitLine(l) // same gate as the limit modal
      if (m) part.limits.push({ ts, off: at, kind: m.kind, resetText: m.resetText, resetAt: m.resetAt })
      continue
    }
    const u = d.message?.usage ?? {}
    const key = d.message?.id ?? d.requestId // one line per content block shares id + usage
    part.msgs.push({ ts, off: at, ...(typeof key === 'string' ? { key } : {}), tok: num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) })
  }
  parts.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, part })
  return part
}

/**
 * Quota state + tokens used in the last 5h from an account's transcripts (files touched in the last 7 days).
 * `copied` = {sessionId: CopyRecord} for transcripts Relay copied INTO this account: those lines belong to another account and are ignored.
 */
export async function scanUsage(configDir: string, now = Date.now(), copied: Record<string, CopyRecord> = {}): Promise<Pick<AccountStatus, 'limited' | 'tokens5h'>> {
  const root = join(configDir, 'projects')
  let limit: Part['limits'][number] | undefined
  let lastOk = 0
  const byKey = new Map<string, { ts: number; tok: number }>() // same message id: keep the max usage
  const unkeyed: { ts: number; tok: number }[] = []
  const visited = new Set<string>()
  for await (const f of jsonlFiles(root, now - 7 * 24 * H)) {
    visited.add(f.path)
    const part = await parseFile(f)
    if (!part) continue
    // <proj>/<sid>.jsonl, or <proj>/<sid>/.../x.jsonl
    const segs = f.path.slice(root.length + 1).split('/')
    const rel = segs.slice(1).join('/')
    const sid = (segs[1] ?? '').replace(/\.jsonl$/, '')
    const rec = isSessionId(sid) ? copied[sid] : undefined
    const skipFile = !!rec && rec.sib.includes(rel)
    const skip = (off: number): boolean => skipFile || (segs.length === 2 && !!rec?.ranges.some(([a, b]) => off >= a && off < b))
    for (const m of part.msgs) {
      if (skip(m.off)) continue
      lastOk = Math.max(lastOk, m.ts)
      if (m.ts < now - WINDOW) continue
      if (!m.key) unkeyed.push(m)
      else {
        const o = byKey.get(m.key)
        if (!o) byKey.set(m.key, m)
        else o.tok = Math.max(o.tok, m.tok)
      }
    }
    for (const l of part.limits) if (!skip(l.off) && l.ts > (limit?.ts ?? 0)) limit = l
  }
  for (const p of parts.keys()) if (p.startsWith(root + '/') && !visited.has(p)) parts.delete(p) // evict files not seen
  const tokens5h = [...byKey.values(), ...unkeyed].reduce((n, m) => n + m.tok, 0)
  const active = limit && limit.ts > lastOk && (limit.resetAt !== null ? now < limit.resetAt : now - limit.ts < maxAge(limit.kind))
  return { tokens5h, ...(limit && active ? { limited: { kind: limit.kind, resetText: limit.resetText, resetAt: limit.resetAt } } : {}) }
}

const run = promisify(execFile)
const cache = new Map<string, { at: number; status: AccountStatus }>()
const TTL = 60_000

/** Official `claude auth status --json` (or `codex login status`) + transcript scan; cached 60s unless `refresh`. `probe: false` = do not run the CLI (it would write into an imported dir): loggedIn stays null, transcripts are still read. */
export async function accountStatus(a: Account, refresh = false, copied: Record<string, CopyRecord> = {}, probe = true): Promise<AccountStatus> {
  const hit = cache.get(a.id)
  if (hit && !refresh && Date.now() - hit.at < TTL) return hit.status
  if (a.provider === 'codex') {
    // `codex login status`: exit 0 = logged in, exit 1 + "Not logged in" = not; it prints no email or plan. No token usage is read for Codex.
    let loggedIn: boolean | null = null
    if (probe)
      try {
        await run(providers.codex.bin, providers.codex.statusArgs, { env: buildEnv(a), timeout: 10_000 })
        loggedIn = true
      } catch (e: any) {
        if (e?.code === 1) loggedIn = false
      }
    const limited = scanCodexLimit(a.configDir, Date.now(), copied)
    const status: AccountStatus = { accountId: a.id, loggedIn, tokens5h: 0, ...(limited ? { limited } : {}), ...(probe ? {} : { unchecked: true }) }
    cache.set(a.id, { at: Date.now(), status })
    return status
  }
  let auth: ReturnType<typeof parseAuthStatus> = { loggedIn: null }
  if (probe)
    try {
      const { stdout } = await run(providers[a.provider].bin, providers[a.provider].statusArgs, { env: buildEnv(a), timeout: 10_000 })
      auth = parseAuthStatus(stdout)
    } catch (e: any) {
      if (typeof e?.stdout === 'string') auth = parseAuthStatus(e.stdout)
    }
  const status: AccountStatus = { accountId: a.id, ...auth, ...(await scanUsage(a.configDir, Date.now(), copied)), ...(probe ? {} : { unchecked: true }) }
  cache.set(a.id, { at: Date.now(), status })
  return status
}
