import type { ProviderId } from '../shared/types'

export interface Provider {
  bin: string
  /** env var that points the CLI at an account's config dir */
  envVar: string
  /** `message` = initial prompt (separate argv element, never a shell string); ignored when `resumePrompt` is false */
  resumeArgs(id: string, message?: string): string[]
  /** the CLI accepts a positional prompt together with the resume flag */
  resumePrompt: boolean
  newArgs(id: string): string[]
  loginArgs: string[]
  /** false = never run against the real CLI */
  verified: boolean
  /** Relay picks the new session's id (`newArgs`); false = the CLI assigns it and Relay discovers it from the transcript */
  assignsId: boolean
  /** read-only login probe: exit code 0 = logged in, 1 = not logged in (Codex; Claude uses `auth status --json`) */
  statusArgs: string[]
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
export function installCommand(id: unknown, scriptOverride?: string): InstallCommand | undefined {
  if (typeof id !== 'string' || !Object.hasOwn(providers, id)) return undefined
  // test hook (e2e), passed in by main only when the app is not packaged; never reachable from the renderer
  const script = scriptOverride || providers[id as ProviderId].installScript
  return script ? { bin: '/bin/bash', args: ['-lc', script], display: `/bin/bash -lc '${script}'` } : undefined
}

export const providers: Record<ProviderId, Provider> = {
  claude: {
    bin: 'claude',
    envVar: 'CLAUDE_CONFIG_DIR',
    resumeArgs: (id, message) => (message ? ['--resume', id, message] : ['--resume', id]),
    resumePrompt: true,
    newArgs: (id) => ['--session-id', id],
    loginArgs: ['auth', 'login'],
    verified: true,
    assignsId: true,
    statusArgs: ['auth', 'status', '--json'],
    installScript: 'curl -fsSL https://claude.ai/install.sh | bash'
  },
  // codex-cli 0.164.0, spike in docs/spikes/F5.md. Verified: CODEX_HOME, `login status` exit codes, `resume <id> [prompt]` (exec and TUI),
  // rollout layout, usage-limit transcript signal. UNVERIFIED: the interactive `codex login` flow and the logged-in `login status` output.
  codex: {
    bin: 'codex',
    envVar: 'CODEX_HOME',
    resumeArgs: (id, message) => (message ? ['resume', id, message] : ['resume', id]),
    resumePrompt: true,
    newArgs: () => [],
    loginArgs: ['login'],
    verified: true,
    assignsId: false,
    statusArgs: ['login', 'status'],
    // the two documented official channels (github.com/openai/codex README); brew first, npm when Homebrew is absent
    installScript: 'if command -v brew >/dev/null 2>&1; then brew install --cask codex; else npm i -g @openai/codex; fi'
  }
}
