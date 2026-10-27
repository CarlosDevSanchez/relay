import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Account, AccountStatus } from '../shared/types'
import { buildEnv } from './env'
import { providers } from './providers'

const H = 3600_000
const WINDOW = 5 * H
const LIMIT_RE = /hit your (\w+) limit · resets (.+)/
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
  msgs: { ts: number; key?: string; tok: number }[]
  limits: { ts: number; kind: string; resetText: string }[]
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
  for (const l of text.split('\n')) {
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
      const m = d.error === 'rate_limit' ? LIMIT_RE.exec(String(d.message?.content?.[0]?.text ?? '')) : null
      if (m) part.limits.push({ ts, kind: m[1]!, resetText: m[2]!.trim() })
      continue
    }
    const u = d.message?.usage ?? {}
    const key = d.message?.id ?? d.requestId // one line per content block shares id + usage
    part.msgs.push({ ts, ...(typeof key === 'string' ? { key } : {}), tok: num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) })
  }
  parts.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, part })
  return part
}

const SESSION_RE = /[0-9a-f]{8}-[0-9a-f-]{27}/i

/**
 * Quota state + tokens used in the last 5h from an account's transcripts (files touched in the last 7 days).
 * `copied` = {sessionId: copiedAt} for transcripts Relay copied INTO this account: their lines up to copiedAt belong to another account and are ignored.
 */
export async function scanUsage(configDir: string, now = Date.now(), copied: Record<string, number> = {}): Promise<Pick<AccountStatus, 'limited' | 'tokens5h'>> {
  const root = join(configDir, 'projects')
  let tokens5h = 0
  let limit: Part['limits'][number] | undefined
  let lastOk = 0
  const seen = new Set<string>()
  for await (const f of jsonlFiles(root, now - 7 * 24 * H)) {
    const part = await parseFile(f)
    if (!part) continue
    const sid = f.path.slice(root.length).split('/').map((x) => x.replace(/\.jsonl$/, '')).find((x) => SESSION_RE.test(x))
    const cut = (sid && copied[sid]) || 0
    for (const m of part.msgs) {
      if (m.ts <= cut) continue
      if (m.key) {
        if (seen.has(m.key)) continue
        seen.add(m.key)
      }
      lastOk = Math.max(lastOk, m.ts)
      if (m.ts >= now - WINDOW) tokens5h += m.tok
    }
    for (const l of part.limits) if (l.ts > cut && l.ts > (limit?.ts ?? 0)) limit = l
  }
  return {
    tokens5h,
    ...(limit && limit.ts > lastOk && now - limit.ts < maxAge(limit.kind) ? { limited: { kind: limit.kind, resetText: limit.resetText } } : {})
  }
}

const run = promisify(execFile)
const cache = new Map<string, { at: number; status: AccountStatus }>()
const TTL = 60_000

/** Official `claude auth status --json` + transcript scan; cached 60s unless `refresh`. */
export async function accountStatus(a: Account, refresh = false, copied: Record<string, number> = {}): Promise<AccountStatus> {
  const hit = cache.get(a.id)
  if (hit && !refresh && Date.now() - hit.at < TTL) return hit.status
  if (a.provider !== 'claude') return { accountId: a.id, loggedIn: null, tokens5h: 0 } // codex unverified
  let auth: ReturnType<typeof parseAuthStatus> = { loggedIn: null }
  try {
    const { stdout } = await run(providers[a.provider].bin, ['auth', 'status', '--json'], { env: buildEnv(a), timeout: 10_000 })
    auth = parseAuthStatus(stdout)
  } catch (e: any) {
    if (typeof e?.stdout === 'string') auth = parseAuthStatus(e.stdout)
  }
  const status: AccountStatus = { accountId: a.id, ...auth, ...(await scanUsage(a.configDir, Date.now(), copied)) }
  cache.set(a.id, { at: Date.now(), status })
  return status
}
