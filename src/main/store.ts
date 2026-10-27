import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Account, ProviderId } from '../shared/types'
import type { CopyResult } from './handoff'
import { encodeCwd } from './paths'

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

export const loadAccounts = (home: string): Account[] => readJson(join(home, 'accounts.json'), [])

/** With `configDir` the dir is only referenced (imported): it is never created or touched. */
export function addAccount(home: string, label: string, provider: ProviderId, configDir?: string): Account {
  const id = randomUUID().slice(0, 8)
  const dir = configDir ?? join(home, 'accounts', id)
  if (!configDir) mkdirSync(dir, { recursive: true })
  const account: Account = { id, label, provider, configDir: dir }
  writeJson(join(home, 'accounts.json'), [...loadAccounts(home), account])
  return account
}

export const loadProjects = (home: string): string[] => readJson(join(home, 'projects.json'), [])

export function addProject(home: string, picked: string): string[] {
  const cwd = realpathSync(picked) // the CLI keys sessions by realpath (/tmp -> /private/tmp)
  // ponytail: the CLI truncates + hashes long encoded names with a hash we have not confirmed; refuse rather than guess.
  if (encodeCwd(cwd).length > 200) throw new Error('Project path is too long for Relay (Claude hashes long project dir names)')
  const all = loadProjects(home)
  if (!all.includes(cwd)) all.push(cwd)
  writeJson(join(home, 'projects.json'), all)
  return all
}

export function renameAccount(home: string, id: string, label: string): Account[] {
  const all = loadAccounts(home).map((a) => (a.id === id ? { ...a, label } : a))
  writeJson(join(home, 'accounts.json'), all)
  return all
}

const managedDir = (home: string, id: string): string => join(resolve(home), 'accounts', id)
export const isManaged = (home: string, a: Account): boolean => resolve(a.configDir) === managedDir(home, a.id)

/**
 * Unlinks first (so nothing can start on it), awaits `onUnlinked` (kill its ptys), then deletes the dir only if managed
 * (`<home>/accounts/<id>`, exact match); an imported dir is never touched.
 */
export async function removeAccount(home: string, id: string, onUnlinked?: () => Promise<unknown>): Promise<Account[]> {
  const all = loadAccounts(home)
  const a = all.find((x) => x.id === id)
  if (!a) return all
  const rest = all.filter((x) => x.id !== id)
  writeJson(join(home, 'accounts.json'), rest)
  await onUnlinked?.()
  if (isManaged(home, a)) rmSync(managedDir(home, id), { recursive: true, force: true })
  return rest
}

export interface CopyRecord {
  /** byte ranges [from, to) of `<sid>.jsonl` that were copied in from another account */
  ranges: [number, number][]
  /** sibling-dir files (relative to the project dir) that were copied in */
  sib: string[]
}

/** Sessions copied INTO an account: {accountId: {sessionId: CopyRecord}}; those lines are not that account's usage. */
export const loadCopies = (home: string): Record<string, Record<string, CopyRecord>> => readJson(join(home, 'copies.json'), {})

/** No-op when nothing was appended. A replaced transcript voids the older ranges. */
export function recordCopy(home: string, accountId: string, sessionId: string, r: Pick<CopyResult, 'from' | 'to' | 'replaced' | 'sib'>): void {
  if (r.from === r.to && !r.sib.length) return
  const all = loadCopies(home)
  const old = all[accountId]?.[sessionId]
  const rec: CopyRecord = {
    ranges: [...(r.replaced ? [] : (old?.ranges ?? [])), ...(r.from < r.to ? [[r.from, r.to] as [number, number]] : [])],
    sib: [...new Set([...(old?.sib ?? []), ...r.sib])]
  }
  writeJson(join(home, 'copies.json'), { ...all, [accountId]: { ...all[accountId], [sessionId]: rec } })
}
