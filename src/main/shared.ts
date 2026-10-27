import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Account, SharedReport } from '../shared/types'
import { encodeCwd } from './paths'

/**
 * Shared global memory: `<home>/shared/<item>` is the single copy, each opted-in account dir gets ABSOLUTE symlinks to it.
 * ONLY the whitelist below is ever touched (never credentials, .claude.json, settings, history, transcripts, plugins...).
 * Codex (F5) can add `AGENTS.md` to TOP later.
 * Merge is ONE level deep: a child present on both sides with different content (e.g. `memory/MEMORY.md`, the index) keeps shared's
 * and the account's copy goes to the backup. Symlinked children are moved verbatim, so a RELATIVE one may dangle in its new place.
 */
const TOP: [string, boolean][] = [['CLAUDE.md', false], ['skills', true], ['agents', true], ['commands', true]] // [rel, isDir]

export const sharedDir = (home: string): string => join(home, 'shared')

const lst = (p: string) => {
  try {
    return lstatSync(p)
  } catch {
    return undefined
  }
}

/** Absolute path of `rel` under `base`; every parent must be a REAL dir (symlinked parents could escape), missing ones are created. */
function guard(base: string, rel: string): string {
  let cur = base
  for (const part of rel.split('/').slice(0, -1)) {
    cur = join(cur, part)
    const st = lst(cur)
    if (!st) mkdirSync(cur)
    else if (!st.isDirectory()) throw new Error(`Refusing ${cur}: parent is not a real directory`)
  }
  const abs = join(base, rel)
  if (!abs.startsWith(base + sep)) throw new Error(`Refusing ${abs}: outside ${base}`)
  return abs
}

function move(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true })
  try {
    renameSync(src, dst)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(src, dst, { recursive: true, verbatimSymlinks: true })
    rmSync(src, { recursive: true, force: true })
  }
}

function same(a: string, b: string): boolean {
  const x = lst(a)
  const y = lst(b)
  if (!x || !y) return false
  if (x.isSymbolicLink() || y.isSymbolicLink()) return x.isSymbolicLink() && y.isSymbolicLink() && readlinkSync(a) === readlinkSync(b)
  if (x.isFile() && y.isFile()) return x.size === y.size && readFileSync(a).equals(readFileSync(b))
  if (x.isDirectory() && y.isDirectory()) {
    const n = readdirSync(a).sort()
    return n.join('\0') === readdirSync(b).sort().join('\0') && n.every((c) => same(join(a, c), join(b, c)))
  }
  return false
}

const points = (link: string, target: string): boolean => lst(link)?.isSymbolicLink() === true && resolve(dirname(link), readlinkSync(link)) === target

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

function setup(home: string, a: Account): { cfg: string; shared: string } {
  if (a.provider !== 'claude') throw new Error('Memoria compartida: solo cuentas Claude')
  mkdirSync(sharedDir(home), { recursive: true })
  if (lst(sharedDir(home))?.isSymbolicLink()) throw new Error(`Refusing ${sharedDir(home)}: it is a symlink`)
  return { cfg: realpathSync(a.configDir), shared: realpathSync(sharedDir(home)) }
}

function linkItem(cfg: string, shared: string, backups: string, rel: string, isDir: boolean, rep: SharedReport): void {
  const t = guard(cfg, rel)
  const s = guard(shared, rel)
  const backup = (p: string, r: string): void => {
    const d = join(backups, r)
    move(p, d)
    rep.backups.push(d)
  }
  const ss = lst(s)
  if (ss?.isSymbolicLink()) throw new Error(`Refusing ${s}: shared item is a symlink`)
  const st = lst(t)
  if (points(t, s)) return
  if (st?.isSymbolicLink()) backup(t, rel) // foreign link: kept as a link in the backup
  else if (st) {
    if (!ss) {
      move(t, s)
      rep.notes.push(`${rel}: movido a la memoria compartida`)
    } else if (st.isDirectory() && ss.isDirectory()) {
      for (const n of readdirSync(t)) {
        const ct = join(t, n)
        const cs = join(s, n)
        if (!lst(cs)) {
          move(ct, cs)
          rep.notes.push(`${rel}/${n}: movido a la memoria compartida`)
        } else if (same(ct, cs)) rmSync(ct, { recursive: true })
        else backup(ct, `${rel}/${n}`)
      }
    } else if (!same(t, s)) backup(t, rel)
    const left = lst(t)
    if (left?.isDirectory()) {
      try {
        rmdirSync(t) // only an emptied dir may go; anything written meanwhile (a running claude) must not be deleted
      } catch {
        throw new Error('el directorio no quedó vacío (¿hay un claude en marcha?); reintenta')
      }
    } else if (left) unlinkSync(t) // identical file
  }
  if (!lst(s)) isDir ? mkdirSync(s) : writeFileSync(s, '')
  symlinkSync(s, t)
  rep.linked.push(rel)
}

/** Idempotent. Per-item failures are reported in `errors` and do not stop the other items. */
export function linkAccount(home: string, a: Account, projects: string[]): SharedReport {
  const { cfg, shared } = setup(home, a)
  const backups = join(home, 'backups', a.id, stamp())
  const rep: SharedReport = { linked: [], backups: [], notes: [], errors: [] }
  const items: [string, boolean][] = [...TOP, ...projects.map((p): [string, boolean] => [`projects/${encodeCwd(p)}/memory`, true])]
  for (const [rel, isDir] of items) {
    try {
      linkItem(cfg, shared, backups, rel, isDir, rep)
    } catch (e) {
      rep.errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return rep
}

/** Replaces each of OUR links with a real copy of the shared content (the account keeps its memory). Shared is never modified. */
export function unlinkAccount(home: string, a: Account): SharedReport {
  const { cfg, shared } = setup(home, a)
  const rep: SharedReport = { linked: [], backups: [], notes: [], errors: [] }
  let projs: string[] = []
  try {
    // only real dirs can hold our links (.DS_Store files and symlinked project dirs cannot; not an error)
    projs = readdirSync(join(cfg, 'projects')).filter((n) => lst(join(cfg, 'projects', n))?.isDirectory())
  } catch {
    // no projects dir
  }
  for (const rel of [...TOP.map(([r]) => r), ...projs.map((p) => `projects/${p}/memory`)]) {
    try {
      const t = guard(cfg, rel)
      const s = join(shared, rel)
      if (!points(t, s)) continue
      if (lst(s)) {
        const tmp = `${t}.relay-tmp-${process.pid}`
        try {
          cpSync(s, tmp, { recursive: true, verbatimSymlinks: true }) // the link stays until the copy is complete
        } catch (e) {
          rmSync(tmp, { recursive: true, force: true })
          throw e
        }
        unlinkSync(t)
        renameSync(tmp, t)
      } else unlinkSync(t)
      rep.notes.push(`${rel}: copia local restaurada`)
    } catch (e) {
      rep.errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return rep
}

/** Top-level items of a linked account that are no longer our links (e.g. the CLI replaced CLAUDE.md with a real file). */
export function drifted(home: string, a: Account): string[] {
  try {
    const shared = realpathSync(sharedDir(home))
    return TOP.map(([r]) => r).filter((rel) => !points(join(a.configDir, rel), join(shared, rel)))
  } catch {
    return TOP.map(([r]) => r)
  }
}

/** Flag to persist after a toggle. A failed unlink keeps an already-on flag (retry); a never-consented account never turns on by a failure. */
export const nextFlag = (on: boolean, errors: number, was: boolean | undefined): boolean => on || (errors > 0 && was === true)
