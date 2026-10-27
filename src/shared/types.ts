export type ProviderId = 'claude' | 'codex'

export interface Account {
  id: string
  label: string
  provider: ProviderId
  configDir: string
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
  fromAccountId: string
  toAccountId: string
  cwd: string
  sessionId: string
}

export interface RelayApi {
  accounts: {
    list(): Promise<Account[]>
    add(label: string, provider: ProviderId, configDir?: string): Promise<Account>
    pickDir(): Promise<string | null>
  }
  projects: {
    list(): Promise<string[]>
    add(): Promise<string[]>
  }
  sessions(cwd: string): Promise<SessionInfo[]>
  pty: {
    start(req: StartRequest): Promise<StartResult>
    write(ptyId: number, data: string): void
    resize(ptyId: number, cols: number, rows: number): void
    onData(cb: (ptyId: number, data: string) => void): () => void
    onExit(cb: (ptyId: number, code: number) => void): () => void
  }
  handoff(req: HandoffRequest): Promise<StartResult>
}
