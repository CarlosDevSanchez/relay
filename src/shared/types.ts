import type { AnswerAction } from './prompt'
export type ProviderId = 'claude' | 'codex'

export const CROSS_PROVIDER = 'Claude ↔ Codex llegará después del MVP'

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
  /** Relay's history only: account switches this session went through */
  handoffs?: { from: string; to: string; at: number }[]
}

export type StartMode = 'new' | 'resume' | 'login'

export interface StartRequest {
  accountId: string
  cwd: string
  mode: StartMode
  sessionId?: string
}

export interface StartResult {
  /** handoff only: the target was started with the auto-continue message */
  autoContinued?: boolean
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
  /** the CLI was not asked (an imported dir that would get files written by the probe); only local transcripts were read */
  unchecked?: boolean
}

export interface LimitHit {
  ptyId: number
  accountId: string
  sessionId: string
  kind: string
  resetText: string
  resetAt: number | null
  modelSpecific?: boolean
}

/** An existing Claude config dir found in the home dir (importable). */
export interface Candidate {
  dir: string
  provider: ProviderId
  loggedIn: boolean | null
  /** not probed: the dir has no .claude.json (Codex: config.toml / sessions) yet and probing would create files in it */
  unchecked?: boolean
  default?: boolean
  email?: string
  plan?: string
}

/** One rate-limit window ("5h", "7d", or "<n>h" / "<n>min" for other Codex windows); resetsAt in epoch ms. */
export interface UsageWindow {
  id: string
  pct: number
  resetsAt: number
}
/** Official usage (Claude: the CLI's status line JSON; Codex: rollout `token_count.rate_limits`). Only these fields cross IPC. */
export interface AccountUsage {
  accountId: string
  windows: UsageWindow[]
  updatedAt: number
}

export interface Prefs {
  notifications: { system: boolean; sound: boolean }
  /** statusLine: Relay injects its own status line into Claude sessions (official `--settings`) to read `rate_limits`; warnAt: % that raises a warning (50-100) */
  usage: { statusLine: boolean; warnAt: number }
  /** after a user-confirmed handoff, the target is started with `message` as the CLI's initial prompt */
  handoff: { autoContinue: boolean; message: string }
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

/** F6.1 transcript view model (Claude). Built field by field in main from an allowlist; never raw lines. */
export interface THunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface TDiff { file: string; hunks: THunk[]; created?: boolean; deleted?: boolean }
/** `at` = byte offset of the line * 1000 + block index: a stable total order across pages and live batches. Events upsert by `id`. */
interface TBase { id: string; at: number }
export type TEvent =
  | (TBase & { kind: 'message'; role: 'user' | 'assistant'; text: string })
  | (TBase & { kind: 'thinking'; durationMs?: number })
  | (TBase & {
      kind: 'tool'
      name: string
      /** clipped copy of the tool input (strings/arrays/depth capped; bulky fields already in `diffs` dropped) */
      input: unknown
      /** pending = no tool_result yet (AskUserQuestion / ExitPlanMode pending = the CLI waits for the user) */
      status: 'pending' | 'ok' | 'error'
      result?: string
      durationMs?: number
      interrupted?: boolean
      diffs?: TDiff[]
      /** Agent tool: thread lives in <session>/subagents/agent-<agentId>.jsonl, requested on demand */
      agentId?: string
    })
  | (TBase & {
      kind: 'notice'
      notice: 'compact' | 'turn' | 'rate_limit' | 'api_error' | 'info'
      text?: string
      durationMs?: number
      /** rate_limit: epoch ms from quotaLimits */
      resetsAt?: number
      limitType?: string
      /** api_error: the CLI's `error` value */
      code?: string
      preTokens?: number
      postTokens?: number
    })
export interface TMeta {
  title?: string
  model?: string
  permissionMode?: string
  cwd?: string
  gitBranch?: string
  version?: string
  /** usage of the last assistant message (last line of a message id wins) */
  tokens?: { input: number; output: number; cacheRead: number; cacheCreate: number }
}
export interface TBatch {
  accountId: string
  sessionId: string
  /** set for a subagent thread */
  agentId?: string
  /** snapshot (has `older`) = the stream's current seq, live batches count on from it; absent on older/subagent pages */
  seq?: number
  events: TEvent[]
  meta?: TMeta
  /** byte offset to pass to `older` for earlier events; null = start of file reached; absent on live batches */
  older?: number | null
}
export interface TranscriptRef { accountId: string; cwd: string; sessionId: string }

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
  /** only sessions started, resumed or adopted from Relay */
  sessions(cwd: string): Promise<SessionInfo[]>
  history: {
    /** transcripts of the project (any account/provider) that are not in Relay's history yet */
    candidates(cwd: string): Promise<SessionInfo[]>
    /** adds an existing transcript to Relay's history */
    adopt(cwd: string, sessionId: string): Promise<void>
    /** removes the registry entry only; the transcript is never touched */
    forget(cwd: string, sessionId: string): Promise<void>
  }
  usage: {
    get(): Promise<AccountUsage[]>
    onUpdate(cb: (u: AccountUsage) => void): () => void
    /** a window crossed the warning threshold (text already composed in main) */
    onWarn(cb: (text: string) => void): () => void
  }
  pty: {
    start(req: StartRequest): Promise<StartResult>
    kill(ptyId: number): Promise<void>
    write(ptyId: number, data: string): void
    resize(ptyId: number, cols: number, rows: number): void
    /** composer (F6.3): main wraps the sanitized text in a bracketed paste + Enter; `seq` = last output chunk parsed by the renderer, 'stale' = more output arrived since (nothing written) */
    send(ptyId: number, text: string, seq: number): Promise<'ok' | 'stale' | 'gone'>
    /** Stop: main writes exactly one ESC */
    stop(ptyId: number): Promise<boolean>
    /** empties the CLI's input box (fixed allowlist in main: `\x15`, preceded by ESC when a `/` or `@` list is open) */
    clear(ptyId: number, opts: { overlay: boolean }, seq: number): Promise<'ok' | 'stale' | 'gone'>
    /** prompt card (F6.4): one action from the closed allowlist; main builds the keys. `seq` as in send, 'stale' = nothing written */
    answer(ptyId: number, seq: number, action: AnswerAction): Promise<'ok' | 'stale' | 'gone'>
    /** `seq` numbers the output chunks of a pty (the composer bridge's stale-frame guard) */
    onData(cb: (ptyId: number, data: string, seq: number) => void): () => void
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
  transcript: {
    /** starts live events for a Claude session; resolves with the last page (snapshot, carries the current seq) */
    subscribe(ref: TranscriptRef): Promise<TBatch>
    unsubscribe(ref: TranscriptRef): Promise<void>
    older(ref: TranscriptRef, before: number): Promise<TBatch>
    subagent(ref: TranscriptRef, agentId: string, before?: number): Promise<TBatch>
    onEvents(cb: (b: TBatch) => void): () => void
  }
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
