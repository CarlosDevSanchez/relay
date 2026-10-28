import { closeSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Account, CatalogEntry, CatalogLocation } from '../shared/types'
import { sharedDir } from './shared'

type Kind = 'skills' | 'agents' | 'commands'

/** Tolerant `---` frontmatter: `key: value` lines, quotes stripped, `>`/`|` block values folded into one line. Never throws. */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const out: Record<string, string> = {}
  if (lines[0]?.trim() !== '---') return out
  for (let i = 1; i < lines.length && lines[i]!.trim() !== '---'; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!m) continue
    let v = m[2]!.trim()
    if (/^[>|][+-]?$/.test(v)) {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim())
      v = parts.join(' ')
    } else v = v.replace(/^(["'])(.*)\1$/, '$2')
    out[m[1]!] = v
  }
  return out
}

/** First ~4KB of a file, or undefined when unreadable. */
function head(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const b = Buffer.alloc(4096)
    return b.toString('utf8', 0, readSync(fd, b, 0, 4096, 0))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const inside = (p: string, root: string): boolean => {
  try {
    const r = realpathSync(p)
    return r === root || r.startsWith(root + sep)
  } catch {
    return false
  }
}

/** Entries of `<dir>` (skills: subdirs with SKILL.md; agents/commands: *.md). Anything resolving into the shared store is skipped. */
export function listEntries(dir: string, kind: Kind, sharedReal?: string): CatalogEntry[] {
  if (sharedReal && inside(dir, sharedReal)) return []
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: CatalogEntry[] = []
  for (const n of names) {
    const p = join(dir, n)
    if (sharedReal && inside(p, sharedReal)) continue
    if (kind !== 'skills' && !n.endsWith('.md')) continue
    const text = head(kind === 'skills' ? join(p, 'SKILL.md') : p)
    if (text === undefined) continue
    const fm = parseFrontmatter(text)
    out.push({ name: fm.name || n.replace(/\.md$/, ''), description: fm.description ?? '' })
  }
  return out
}

/** Shared store first, then each Claude account's own (non-shared) entries. */
export function buildCatalog(home: string, accounts: Account[]): CatalogLocation[] {
  const sh = sharedDir(home)
  let sharedReal = sh
  try {
    sharedReal = realpathSync(sh)
  } catch {}
  const loc = (accountId: string | null, label: string, base: string, skip?: string): CatalogLocation => ({
    accountId,
    label,
    skills: listEntries(join(base, 'skills'), 'skills', skip),
    agents: listEntries(join(base, 'agents'), 'agents', skip),
    commands: listEntries(join(base, 'commands'), 'commands', skip)
  })
  return [loc(null, 'Compartido (~/.relay/shared)', sh), ...accounts.filter((a) => a.provider === 'claude').map((a) => loc(a.id, a.label, a.configDir, sharedReal))]
}
