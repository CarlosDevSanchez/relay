import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, SessionInfo } from '../shared/types'
import { claudeProjectDir } from './paths'

const HEAD_BYTES = 256 * 1024

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

// ponytail: Claude only; Codex session layout is unverified so it lists nothing.
export function listSessions(accounts: Account[], cwd: string): SessionInfo[] {
  const out: SessionInfo[] = []
  for (const a of accounts.filter((x) => x.provider === 'claude')) {
    const dir = claudeProjectDir(a.configDir, cwd)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(dir, f)
      out.push({ id: f.slice(0, -6), title: sessionTitle(head(p)), mtimeMs: statSync(p).mtimeMs, accountId: a.id })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}
