import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, ProviderId } from '../shared/types'

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

export function addProject(home: string, cwd: string): string[] {
  const all = loadProjects(home)
  if (!all.includes(cwd)) all.push(cwd)
  writeJson(join(home, 'projects.json'), all)
  return all
}
