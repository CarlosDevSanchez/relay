import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

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

/**
 * Plain `claude` keeps its data in ~/.claude but its config in ~/.claude.json and uses its own keychain entry: setting CLAUDE_CONFIG_DIR=~/.claude would make it a different install.
 * Codex's default home is ~/.codex (auth.json inside it, file-based by default), so CODEX_HOME=~/.codex is the same install; the flag is informational there.
 */
export const isDefaultInstall = (configDir: string, home: string, provider: 'claude' | 'codex' = 'claude'): boolean => real(configDir) === real(join(home, provider === 'codex' ? '.codex' : '.claude'))

/** Directory entry names only (contents are never read). */
const names = (p: string): string[] => {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

/**
 * `auth status` creates `.claude.json` (+ lock, backups) when missing, so only probe dirs that already have one (the default install keeps it in HOME).
 * `codex login status` creates `tmp/` in its home, so only probe Codex homes that already have `config.toml`, `installation_id`, `state_*.sqlite` or `sessions/` (auth.json is never stat'ed).
 */
export const canProbe = (dir: string, home: string, provider: 'claude' | 'codex' = 'claude'): boolean =>
  provider === 'codex' ? existsSync(join(dir, 'config.toml')) || existsSync(join(dir, 'installation_id')) || isDir(join(dir, 'sessions')) || names(dir).some((n) => /^state_\d+\.sqlite$/.test(n)) : existsSync(join(isDefaultInstall(dir, home) ? home : dir, '.claude.json'))

/** Provider a dir name suggests: `~/.codex`, `~/.codex-work` are Codex homes. */
export const dirProvider = (dir: string): 'claude' | 'codex' => (/^\.codex(-|$)/.test(basename(dir)) ? 'codex' : 'claude')

/** `~/.claude`, `~/.claude-*`, `~/.codex` and `~/.codex-*` directories (read-only existence check) that are not already `existing` account dirs. */
export function candidateDirs(home: string, existing: string[]): string[] {
  const taken = new Set(existing.map(real))
  try {
    return readdirSync(home)
      .filter((n) => n === '.claude' || n.startsWith('.claude-') || n === '.codex' || n.startsWith('.codex-'))
      .map((n) => join(home, n))
      .filter((p) => isDir(p) && !taken.has(real(p)))
      .sort()
  } catch {
    return []
  }
}
