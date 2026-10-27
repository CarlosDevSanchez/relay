import type { ProviderId } from '../shared/types'

export interface Provider {
  bin: string
  /** env var that points the CLI at an account's config dir */
  envVar: string
  resumeArgs(id: string): string[]
  newArgs(id: string): string[]
  loginArgs: string[]
  /** false = never run against the real CLI */
  verified: boolean
}

export const providers: Record<ProviderId, Provider> = {
  claude: {
    bin: 'claude',
    envVar: 'CLAUDE_CONFIG_DIR',
    resumeArgs: (id) => ['--resume', id],
    newArgs: (id) => ['--session-id', id],
    loginArgs: ['auth', 'login'],
    verified: true
  },
  // UNVERIFIED: Codex is not installed here; CODEX_HOME / `codex resume <id>` taken from the brief.
  codex: {
    bin: 'codex',
    envVar: 'CODEX_HOME',
    resumeArgs: (id) => ['resume', id],
    newArgs: () => [],
    loginArgs: ['login'],
    verified: false
  }
}
