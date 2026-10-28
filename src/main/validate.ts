import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { type Account, CROSS_PROVIDER, type HandoffRequest, type StartRequest } from '../shared/types'
import { MAX_SEND } from './bridge'
import { type InstallCommand, installCommand, providers } from './providers'

export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/** realpath of the deepest existing ancestor + the rest (the path itself may not exist yet). */
const real = (p: string): string => {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs === dirname(abs) ? abs : join(real(dirname(abs)), basename(abs))
  }
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${what}`)
  return v
}

export function checkAccountId(id: unknown, accounts: Account[]): Account {
  const a = accounts.find((x) => x.id === id)
  if (!a) throw new Error('Unknown account')
  return a
}

export function checkRename(id: unknown, label: unknown, accounts: Account[]): string {
  checkAccountId(id, accounts)
  return str(label, 'label')
}

export function checkNewAccount(label: unknown, provider: unknown, configDir: unknown, home?: string): void {
  str(label, 'label')
  if (typeof provider !== 'string' || !Object.hasOwn(providers, provider)) throw new Error('Invalid provider')
  if (configDir !== undefined) {
    const dir = real(str(configDir, 'configDir'))
    const managed = home && real(join(home, 'accounts'))
    if (managed && (dir === managed || dir.startsWith(managed + sep))) throw new Error('configDir must not be inside Relay managed accounts')
  }
}

/** Trust boundary: renderer input is untrusted (traversal, argv injection via session id, arbitrary cwd). */
export function checkStart(req: StartRequest, accounts: Account[], projects: string[]): Account {
  const a = accounts.find((x) => x.id === req?.accountId)
  if (!a) throw new Error('Unknown account')
  if (req.mode === 'login') return a
  if (!projects.includes(str(req.cwd, 'cwd'))) throw new Error('Unknown project')
  if (req.mode === 'resume' && !isSessionId(req.sessionId)) throw new Error('Invalid session id')
  if (req.mode !== 'resume' && req.mode !== 'new') throw new Error('Invalid mode')
  return a
}

export function checkHandoff(req: HandoffRequest, accounts: Account[], projects: string[]): [Account, Account] {
  if (!Number.isInteger(req?.ptyId)) throw new Error('Invalid pty id')
  const from = checkStart({ accountId: req?.fromAccountId, cwd: req?.cwd, mode: 'resume', sessionId: req?.sessionId }, accounts, projects)
  const to = checkStart({ accountId: req.toAccountId, cwd: req.cwd, mode: 'resume', sessionId: req.sessionId }, accounts, projects)
  if (from.provider !== to.provider) throw new Error(CROSS_PROVIDER)
  return [from, to]
}

/** Reminder time from the renderer: finite, in the future, within 8 days (weekly limits are the longest). */
export function checkReminder(resetAt: unknown, now = Date.now()): number {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= now || resetAt > now + 8 * 86400_000) throw new Error('Invalid resetAt')
  return resetAt
}

/** Toggle request from the renderer: known account + real boolean. */
export function checkSharedToggle(id: unknown, enabled: unknown, accounts: Account[]): Account {
  const a = checkAccountId(id, accounts)
  if (typeof enabled !== 'boolean') throw new Error('Invalid enabled')
  return a
}

/** Installer request: only a provider id; the command itself is chosen by main. */
export function checkInstall(provider: unknown, claudeScriptOverride?: string): InstallCommand {
  const c = installCommand(provider, claudeScriptOverride)
  if (!c) throw new Error('No hay instalador oficial para este proveedor')
  return c
}


/** History requests: a known project and a real session id (the id must also be a listed transcript, checked by the caller). */
export function checkSessionRef(cwd: unknown, sessionId: unknown, projects: string[]): { cwd: string; sessionId: string } {
  if (typeof cwd !== 'string' || !projects.includes(cwd)) throw new Error('Unknown project')
  if (!isSessionId(sessionId)) throw new Error('Invalid session id')
  return { cwd, sessionId }
}

/** Transcript view requests: the renderer sends only ids; the file is resolved in main from the account and the session. Claude only (Codex: F6.6). */
export function checkTranscriptRef(ref: unknown, accounts: Account[], projects: string[]): { account: Account; cwd: string; sessionId: string } {
  const r = (ref ?? {}) as Record<string, unknown>
  const account = checkAccountId(r.accountId, accounts)
  if (account.provider !== 'claude') throw new Error('La vista enriquecida solo admite Claude')
  const { cwd, sessionId } = checkSessionRef(r.cwd, r.sessionId, projects)
  return { account, cwd, sessionId }
}

export function checkAgentId(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8,64}$/i.test(v)) throw new Error('Invalid agent id')
  return v
}

/** Byte offset returned by a previous page. */
export function checkOffset(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('Invalid offset')
  return v
}

export function checkPtyId(v: unknown): number {
  if (!Number.isInteger(v)) throw new Error('Invalid pty id')
  return v as number
}

/** Composer text: a string of 1..MAX_SEND chars without NUL (control characters are stripped in main when the bytes are built). */
export function checkSendText(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > MAX_SEND || v.includes('\0')) throw new Error('Invalid message')
  return v
}

/** `pty:clear` options: only whether a `/` or `@` list is open; the bytes come from a fixed allowlist in main. */
export function checkClear(v: unknown): boolean {
  const o = (v ?? {}) as Record<string, unknown>
  if (typeof o.overlay !== 'boolean') throw new Error('Invalid clear options')
  return o.overlay
}

/** Output sequence the renderer last parsed (see pty.ts). */
export function checkSeq(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('Invalid seq')
  return v
}

/** The composer bridge only reaches a live pty of a Claude account that has a session (never a login / installer pty, never Codex). */
export function checkClaudePty(info: { accountId: string; sessionId: string | undefined } | undefined, accounts: Account[]): void {
  if (!info?.sessionId || accounts.find((a) => a.id === info.accountId)?.provider !== 'claude') throw new Error('La sesión ya no está activa')
}
