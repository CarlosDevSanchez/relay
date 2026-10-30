import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

// dependency / build output would starve the project's own files in the capped listing
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'Pods'])
/** whitespace / control characters break the `@path` token (quoting in the CLI is unverified) */
const BAD = /[\s\x00-\x1f\x7f\p{Cf}]/u // incl. bidi overrides and zero-width characters

/**
 * Files of a project for the `@` autocomplete: relative paths, breadth first (shallow files first), file contents never read.
 * Skips dot entries (.git, .env, ...), node_modules and odd names; never follows a symlink to a directory; a symlinked file only if it resolves inside the project.
 */
export function listFiles(cwd: string, max = 2000, maxDepth = 5, maxDirs = 2000): string[] {
  let root: string
  try {
    root = realpathSync(cwd)
  } catch {
    return []
  }
  const out: string[] = []
  let level = ['']
  let dirs = 0
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: string[] = []
    for (const rel of level) {
      if (++dirs > maxDirs) return out // a tree of empty directories must not stall main
      let ents
      try {
        ents = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      } catch {
        continue
      }
      for (const e of ents) {
        if (e.name.startsWith('.') || SKIP.has(e.name) || BAD.test(e.name)) continue
        const p = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) next.push(p)
        else if (e.isFile()) out.push(p)
        else if (e.isSymbolicLink() && insideFile(join(root, p), root)) out.push(p)
        if (out.length >= max) return out
      }
    }
    level = next
  }
  return out
}

const insideFile = (p: string, root: string): boolean => {
  try {
    const r = realpathSync(p)
    return r.startsWith(root + sep) && statSync(r).isFile()
  } catch {
    return false
  }
}
