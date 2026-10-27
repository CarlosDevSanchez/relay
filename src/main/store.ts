import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, ProviderId } from '../shared/types'
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
