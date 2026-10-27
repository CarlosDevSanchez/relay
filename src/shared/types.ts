export type ProviderId = 'claude' | 'codex'

export interface Account {
  id: string
  label: string
  provider: ProviderId
  configDir: string
  /** set by main on listing: Relay owns (and may delete) the dir */
  managed?: boolean
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
  limited?: { kind: string; resetText: string }
  tokens5h: number
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
}
