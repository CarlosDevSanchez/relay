export type ProviderId = 'claude' | 'codex'

export interface Account {
  id: string
  label: string
  provider: ProviderId
  configDir: string
  /** set by main on listing: Relay owns (and may delete) the dir */
  managed?: boolean
  /** set by main on listing: this is ~/.claude, run without CLAUDE_CONFIG_DIR */
  defaultInstall?: boolean
  /** Claude only: memory/skills/agents/commands are symlinks into ~/.relay/shared (undefined = never asked) */
  sharedMemory?: boolean
  /** set by main on listing: linked items that are no longer links into the shared store */
  drift?: string[]
}

export interface SharedReport {
  linked: string[]
  /** where replaced content went (~/.relay/backups/<account>/<ts>/...) */
  backups: string[]
  notes: string[]
  errors: string[]
}

export interface SessionInfo {
  id: string
  title: string
  mtimeMs: number
  accountId: string
}

export type StartMode = 'new' | 'resume' | 'login'

export interface StartRequest {
  accountId: string
  cwd: string
  mode: StartMode
  sessionId?: string
}

export interface StartResult {
  ptyId: number
  sessionId?: string
}

export interface HandoffRequest {
  ptyId: number
  fromAccountId: string
  toAccountId: string
  cwd: string
  sessionId: string
}

export interface AccountStatus {
  accountId: string
  loggedIn: boolean | null // null = could not be determined
  email?: string
  plan?: string
  /** set when the latest rate_limit line is newer than any later successful assistant line */
  limited?: { kind: string; resetText: string; resetAt: number | null }
  tokens5h: number
}

export interface LimitHit {
  ptyId: number
  accountId: string
  sessionId: string
  kind: string
  resetText: string
  resetAt: number | null
}

/** An existing Claude config dir found in the home dir (importable). */
export interface Candidate {
  dir: string
  loggedIn: boolean | null
  /** not probed: the dir has no .claude.json yet and probing would create files in it */
  unchecked?: boolean
  default?: boolean
  email?: string
  plan?: string
}

export interface Prefs {
  notifications: { system: boolean; sound: boolean }
}

export interface CliInfo {
  installed: boolean
  version?: string
}
export type CliStatus = Record<ProviderId, CliInfo>

export interface CatalogEntry {
  name: string
  description: string
}
/** accountId null = the shared store (~/.relay/shared) */
export interface CatalogLocation {
  accountId: string | null
  label: string
  skills: CatalogEntry[]
  agents: CatalogEntry[]
  commands: CatalogEntry[]
}

/** Only these safe fields ever leave main for MCP servers (never env, headers, args). */
export interface McpServer {
  name: string
  scope: 'user' | 'local' | 'project'
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  /** command basename (stdio) or URL origin (http/sse) */
  target: string
  /** local scope: the project path */
  project?: string
}
export interface McpReport {
  accounts: { accountId: string; servers: McpServer[] }[]
  projects: { cwd: string; servers: McpServer[] }[]
}

export interface RelayApi {
  accounts: {
    list(): Promise<Account[]>
    add(label: string, provider: ProviderId, configDir?: string): Promise<Account>
    pickDir(): Promise<string | null>
    /** ~/.claude and ~/.claude-* dirs that exist and are not yet accounts */
    candidates(): Promise<Candidate[]>
    rename(id: string, label: string): Promise<Account[]>
    remove(id: string): Promise<Account[]>
    status(id: string, refresh?: boolean): Promise<AccountStatus>
  }
  projects: {
    list(): Promise<string[]>
    add(): Promise<string[]>
  }
  shared: {
    set(id: string, enabled: boolean): Promise<{ accounts: Account[]; report: SharedReport }>
    /** opens ~/.relay/shared in the file manager */
    open(): Promise<{ dir: string; claudeMd: string }>
  }
  /** background shared-memory notices (relink on new project, skipped accounts) */
  onShared(cb: (msg: string) => void): () => void
  sessions(cwd: string): Promise<SessionInfo[]>
  pty: {
    start(req: StartRequest): Promise<StartResult>
    kill(ptyId: number): Promise<void>
    write(ptyId: number, data: string): void
    resize(ptyId: number, cols: number, rows: number): void
    onData(cb: (ptyId: number, data: string) => void): () => void
    onExit(cb: (ptyId: number, code: number) => void): () => void
  }
  handoff(req: HandoffRequest): Promise<StartResult>
  prefs: { get(): Promise<Prefs>; set(patch: Partial<Prefs>): Promise<Prefs> }
  cli: {
    detect(): Promise<CliStatus>
    /** after a main-side confirmation, runs the provider's official installer in a new pty; null = cancelled */
    install(provider: ProviderId): Promise<number | null>
  }
  catalog: { list(): Promise<CatalogLocation[]>; open(accountId: string): Promise<void> }
  mcp: { list(): Promise<McpReport> }
  /** shows a test system notification; false = not supported on this system */
  notifyTest(): Promise<boolean>
  /** user chose to wait: Relay shows a notification at resetAt (never types into the CLI) */
  remindReset(accountId: string, resetAt: number): Promise<void>
  onLimit(cb: (hit: LimitHit) => void): () => void
  onFocusTab(cb: (ptyId: number) => void): () => void
  /** the CLI started a new session id in this pty (/clear): handoff must use it */
  onSession(cb: (ptyId: number, sessionId: string) => void): () => void
  /** the session id changed in the CLI and Relay could not tell which: handoff is refused for this pty */
  onStale(cb: (ptyId: number) => void): () => void
  /** a wait-for-reset reminder fired */
  onReminder(cb: (accountId: string) => void): () => void
}
