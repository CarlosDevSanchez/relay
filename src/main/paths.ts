import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Claude Code names a project dir after the cwd with every non-alphanumeric char replaced by `-`. */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export const claudeProjectDir = (configDir: string, cwd: string): string =>
  join(configDir, 'projects', encodeCwd(cwd))

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Plain `claude` keeps its data in ~/.claude but its config in ~/.claude.json and uses its own keychain entry: setting CLAUDE_CONFIG_DIR=~/.claude would make it a different install. */
export const isDefaultInstall = (configDir: string, home: string): boolean => real(configDir) === real(join(home, '.claude'))

/** `auth status` creates `.claude.json` (+ lock, backups) when missing, so only probe dirs that already have one (the default install keeps it in HOME). */
export const canProbe = (dir: string, home: string): boolean => existsSync(join(isDefaultInstall(dir, home) ? home : dir, '.claude.json'))

/** `~/.claude` and `~/.claude-*` directories (read-only existence check) that are not already `existing` account dirs. */
export function candidateDirs(home: string, existing: string[]): string[] {
  const taken = new Set(existing.map(real))
  try {
    return readdirSync(home)
      .filter((n) => n === '.claude' || n.startsWith('.claude-'))
      .map((n) => join(home, n))
      .filter((p) => isDir(p) && !taken.has(real(p)))
      .sort()
  } catch {
    return []
  }
}
