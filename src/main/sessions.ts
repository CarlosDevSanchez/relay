import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, SessionInfo } from '../shared/types'
import { listCodexSessions } from './codex'
import { claudeProjectDir } from './paths'
import { isSessionId } from './validate'

const HEAD_BYTES = 16 * 1024

/** First real user prompt: skips meta lines and slash-command/caveat wrappers (start with `<`). */
export function sessionTitle(jsonlHead: string): string {
  for (const line of jsonlHead.split('\n')) {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d?.type !== 'user' || d.isMeta) continue
    const c = d.message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p?.type === 'text')?.text : undefined
    if (typeof text === 'string' && text.trim() && !text.trimStart().startsWith('<')) {
      return text.trim().replace(/\s+/g, ' ').slice(0, 120)
    }
  }
  return '(untitled)'
}

function head(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function listSessions(accounts: Account[], cwd: string): SessionInfo[] {
  const out: SessionInfo[] = listCodexSessions(accounts, cwd)
  for (const a of accounts.filter((x) => x.provider === 'claude')) {
    const dir = claudeProjectDir(a.configDir, cwd)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && isSessionId(f.slice(0, -6)))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(dir, f)
      out.push({ id: f.slice(0, -6), title: sessionTitle(head(p)), mtimeMs: statSync(p).mtimeMs, accountId: a.id })
    }
  }
  // same id on several accounts after a handoff: only the newest copy
  const newest = new Map<string, SessionInfo>()
  for (const s of out) if (s.mtimeMs > (newest.get(s.id)?.mtimeMs ?? -1)) newest.set(s.id, s)
  return [...newest.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
}
