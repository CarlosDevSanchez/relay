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
  /** official installer, run in a visible terminal after the user confirms (Relay never downloads anything itself) */
  installScript?: string
}

export interface InstallCommand {
  bin: string
  args: string[]
  /** exact command line shown in the confirmation */
  display: string
}

/** The renderer only names a provider; the command always comes from `installScript` here. */
export function installCommand(id: unknown, claudeScriptOverride?: string): InstallCommand | undefined {
  if (typeof id !== 'string' || !Object.hasOwn(providers, id)) return undefined
  // test hook (e2e), passed in by main only when the app is not packaged; never reachable from the renderer
  const script = (id === 'claude' && claudeScriptOverride) || providers[id as ProviderId].installScript
  return script ? { bin: '/bin/bash', args: ['-lc', script], display: `/bin/bash -lc '${script}'` } : undefined
}

export const providers: Record<ProviderId, Provider> = {
  claude: {
    bin: 'claude',
    envVar: 'CLAUDE_CONFIG_DIR',
    resumeArgs: (id) => ['--resume', id],
    newArgs: (id) => ['--session-id', id],
    loginArgs: ['auth', 'login'],
    verified: true,
    installScript: 'curl -fsSL https://claude.ai/install.sh | bash'
  },
  // TODO(F5): Codex installScript (official installer) once verified.
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
