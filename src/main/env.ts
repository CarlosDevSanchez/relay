import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Account } from '../shared/types'
import { isDefaultInstall } from './paths'
import { providers } from './providers'

// Credentials/session vars inherited from the parent (possibly itself a Claude session) would override or confuse the account's own login.
const STRIP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$)/

/** Parent env without Claude credential/session vars, with Relay's PATH fix; no account config var. */
export function plainEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIP.test(k)) env[k] = v
  delete env.CLAUDE_CONFIG_DIR // an account var inherited from the parent must not leak into other processes
  delete env.CODEX_HOME
  // packaged GUI apps on macOS start with a minimal PATH
  const extra = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const have = (env.PATH ?? '').split(':')
  env.PATH = [...have, ...extra.filter((d) => !have.includes(d))].join(':')
  return env
}

/** The default install (~/.claude) runs WITHOUT CLAUDE_CONFIG_DIR so it is the same install as a plain `claude` (see isDefaultInstall). */
export function buildEnv(account: Account, base: NodeJS.ProcessEnv = process.env, home = homedir()): Record<string, string> {
  const env = plainEnv(base)
  if (account.provider === 'claude' && isDefaultInstall(account.configDir, home)) return env
  return { ...env, [providers[account.provider].envVar]: account.configDir }
}
