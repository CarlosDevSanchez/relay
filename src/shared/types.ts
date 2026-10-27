export type ProviderId = 'claude' | 'codex'

export interface Account {
  id: string
  label: string
  provider: ProviderId
  configDir: string
  /** set by main on listing: Relay owns (and may delete) the dir */
  managed?: boolean
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

export interface Prefs {
  notifications: { system: boolean; sound: boolean }
}

export interface RelayApi {
  accounts: {
    list(): Promise<Account[]>
    add(label: string, provider: ProviderId, configDir?: string): Promise<Account>
    pickDir(): Promise<string | null>
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
