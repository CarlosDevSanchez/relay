import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Account } from '../shared/types'
import { providers } from './providers'

// Credentials in the parent env would override the account's own login.
const STRIP = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']

export function buildEnv(account: Account, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIP.includes(k)) env[k] = v
  // packaged GUI apps on macOS start with a minimal PATH
  const extra = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const have = (env.PATH ?? '').split(':')
  env.PATH = [...have, ...extra.filter((d) => !have.includes(d))].join(':')
  env[providers[account.provider].envVar] = account.configDir
  return env
}
