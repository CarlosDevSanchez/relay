import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Account, HandoffRequest, StartRequest } from '../shared/types'
import { type InstallCommand, installCommand, providers } from './providers'

export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)

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
  return [from, to]
}

/** Reminder time from the renderer: finite, in the future, within 8 days (weekly limits are the longest). */
export function checkReminder(resetAt: unknown, now = Date.now()): number {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= now || resetAt > now + 8 * 86400_000) throw new Error('Invalid resetAt')
  return resetAt
}

/** Toggle request from the renderer: known Claude account + real boolean. */
export function checkSharedToggle(id: unknown, enabled: unknown, accounts: Account[]): Account {
  const a = checkAccountId(id, accounts)
  if (typeof enabled !== 'boolean') throw new Error('Invalid enabled')
  if (a.provider !== 'claude') throw new Error('Memoria compartida: solo cuentas Claude')
  return a
}

/** Installer request: only a provider id; the command itself is chosen by main. */
export function checkInstall(provider: unknown, claudeScriptOverride?: string): InstallCommand {
  const c = installCommand(provider, claudeScriptOverride)
  if (!c) throw new Error('No hay instalador oficial para este proveedor')
  return c
}

