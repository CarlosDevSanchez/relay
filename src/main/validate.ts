import type { Account, HandoffRequest, StartRequest } from '../shared/types'
import { providers } from './providers'

export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${what}`)
  return v
}

export function checkNewAccount(label: unknown, provider: unknown, configDir: unknown): void {
  str(label, 'label')
  if (typeof provider !== 'string' || !Object.hasOwn(providers, provider)) throw new Error('Invalid provider')
  if (configDir !== undefined) str(configDir, 'configDir')
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
  const from = checkStart({ accountId: req?.fromAccountId, cwd: req?.cwd, mode: 'resume', sessionId: req?.sessionId }, accounts, projects)
  const to = checkStart({ accountId: req.toAccountId, cwd: req.cwd, mode: 'resume', sessionId: req.sessionId }, accounts, projects)
  return [from, to]
}
