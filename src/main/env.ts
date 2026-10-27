import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Account } from '../shared/types'
import { providers } from './providers'

// Credentials/session vars inherited from the parent (possibly itself a Claude session) would override or confuse the account's own login.
const STRIP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$)/

export function buildEnv(account: Account, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIP.test(k)) env[k] = v
  // packaged GUI apps on macOS start with a minimal PATH
  const extra = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const have = (env.PATH ?? '').split(':')
  env.PATH = [...have, ...extra.filter((d) => !have.includes(d))].join(':')
  env[providers[account.provider].envVar] = account.configDir
  return env
}
