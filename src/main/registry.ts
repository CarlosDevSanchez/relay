import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId, SessionInfo } from '../shared/types'

/** Relay's own history: only sessions started, resumed or adopted from Relay appear in the sidebar. Transcripts stay in the providers' dirs and are never touched. */
export interface RegistryEntry {
  provider: ProviderId
  accountId: string
  sessionId: string
  cwd: string
  createdAt: number
  lastActiveAt: number
  origin: 'new' | 'resume' | 'adopt'
  handoffs: { from: string; to: string; at: number }[]
}
export type SessionRef = Pick<RegistryEntry, 'provider' | 'accountId' | 'sessionId' | 'cwd'>

const key = (id: string): string => id.toLowerCase()
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Defensive: entries of an unexpected shape are dropped. */
export function loadRegistry(home: string): RegistryEntry[] {
  let d: unknown
  try {
    d = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(d)) return []
  return d.flatMap((e: any): RegistryEntry[] =>
    (e?.provider === 'claude' || e?.provider === 'codex') && str(e.accountId) && str(e.sessionId) && str(e.cwd) && num(e.createdAt) && num(e.lastActiveAt) && ['new', 'resume', 'adopt'].includes(e.origin)
      ? [{ provider: e.provider, accountId: e.accountId, sessionId: key(e.sessionId), cwd: e.cwd, createdAt: e.createdAt, lastActiveAt: e.lastActiveAt, origin: e.origin, handoffs: Array.isArray(e.handoffs) ? e.handoffs.filter((h: any) => str(h?.from) && str(h.to) && num(h.at)).map((h: any) => ({ from: h.from, to: h.to, at: h.at })) : [] }]
      : []
  )
}

/** Read-modify-write (tmp + rename). Main is single threaded, so no lock. */
export function updateRegistry(home: string, fn: (l: RegistryEntry[]) => RegistryEntry[]): void {
  const file = join(home, 'sessions.json')
  mkdirSync(home, { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(fn(loadRegistry(home)), null, 2))
  renameSync(`${file}.tmp`, file)
}

/** Adds the session, or marks an existing entry as active on `ref.accountId` (its origin is kept). */
export function register(l: RegistryEntry[], ref: SessionRef, origin: RegistryEntry['origin'], now = Date.now()): RegistryEntry[] {
  const id = key(ref.sessionId)
  return l.some((e) => e.sessionId === id)
    ? l.map((e) => (e.sessionId === id ? { ...e, accountId: ref.accountId, lastActiveAt: now } : e))
    : [...l, { ...ref, sessionId: id, createdAt: now, lastActiveAt: now, origin, handoffs: [] }]
}

/** The session moved from `from` to `ref.accountId`. */
export const registerHandoff = (l: RegistryEntry[], ref: SessionRef, from: string, now = Date.now()): RegistryEntry[] =>
  register(l, ref, 'resume', now).map((e) => (e.sessionId === key(ref.sessionId) ? { ...e, handoffs: [...e.handoffs, { from, to: ref.accountId, at: now }] } : e))

export const touchSession = (l: RegistryEntry[], sessionId: string, now = Date.now()): RegistryEntry[] => l.map((e) => (e.sessionId === key(sessionId) ? { ...e, lastActiveAt: now } : e))
export const forgetSession = (l: RegistryEntry[], sessionId: string): RegistryEntry[] => l.filter((e) => e.sessionId !== key(sessionId))

const inProject = (l: RegistryEntry[], cwd: string): Map<string, RegistryEntry> => new Map(l.filter((e) => e.cwd === cwd).map((e) => [e.sessionId, e]))

/** Transcripts of the project that are in the history (with their handoffs); a registered session whose transcript is gone is not listed. */
export function visibleSessions(l: RegistryEntry[], transcripts: SessionInfo[], cwd: string): SessionInfo[] {
  const m = inProject(l, cwd)
  return transcripts.flatMap((s) => {
    const e = m.get(key(s.id))
    return e ? [{ ...s, ...(e.handoffs.length ? { handoffs: e.handoffs } : {}) }] : []
  })
}

/** Transcripts of the project that are not in the history yet ("Abrir sesión existente…"). */
export const adoptable = (l: RegistryEntry[], transcripts: SessionInfo[], cwd: string): SessionInfo[] => {
  const m = inProject(l, cwd)
  return transcripts.filter((s) => !m.has(key(s.id)))
}
