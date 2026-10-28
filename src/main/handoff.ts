import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { type Account, CROSS_PROVIDER } from '../shared/types'
import { findRollout, isTopLevel, readRolloutMeta, sameDir } from './codex'
import { claudeProjectDir } from './paths'
import { isSessionId } from './validate'

/** SIGHUP, then SIGKILL after `ms`; resolves when the process has really exited (the CLI appends lines on exit). */
export async function terminate(kill: (signal?: string) => void, exited: Promise<void>, ms = 3000): Promise<void> {
  const t = setTimeout(() => kill('SIGKILL'), ms)
  kill()
  await exited
  clearTimeout(t)
}

/** Order matters: source must be fully dead before its transcript is copied. */
export async function runHandoff<T>(killSource: () => Promise<void>, copy: () => void, spawn: () => T): Promise<T> {
  await killSource()
  copy()
  return spawn()
}

const regularFile = (p: string): boolean => {
  try {
    return lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** Source transcript: Claude `<dir>/projects/<enc cwd>/<id>.jsonl`, Codex the rollout found by id (always a regular file). */
const sourceFile = (from: Account, cwd: string, sessionId: string): string | undefined =>
  !isSessionId(sessionId) ? undefined : from.provider === 'codex' ? findRollout(from.configDir, sessionId) : join(claudeProjectDir(from.configDir, cwd), `${sessionId}.jsonl`)

/** A Codex rollout may only be handed off for the project it was recorded in, and only a top-level thread (child threads cannot be resumed). */
const codexRolloutOk = (file: string, cwd: string): boolean => {
  const m = readRolloutMeta(file)
  return !!m && isTopLevel(m) && sameDir(m.cwd, cwd)
}

/** True when the source transcript is a regular file (checked before the source process is killed). */
export const sourceExists = (from: Account, cwd: string, sessionId: string): boolean => {
  const f = sourceFile(from, cwd, sessionId)
  return !!f && regularFile(f) && (from.provider !== 'codex' || codexRolloutOk(f, cwd))
}

/** Every existing component of `dst` below `base` must be a real directory (never follow a link out of the target home). */
function assertNoLinks(base: string, dst: string): void {
  let p = base
  for (const seg of relative(base, dirname(dst)).split(sep).filter(Boolean)) {
    p = join(p, seg)
    if (lstatExists(p) && !lstatSync(p).isDirectory()) throw new Error(`Target path ${p} is a link or not a directory; refusing to write through it`)
  }
}

export interface CopyResult {
  dst: string
  /** byte range [from, to) of the target transcript that came from the source */
  from: number
  to: number
  /** the target transcript was replaced (older ranges are void) */
  replaced: boolean
  /** files of the sibling dir newly created in the target, relative to the project dir */
  sib: string[]
}

/** Append-only copy of complete lines from `src` to `dst` (see copySessionForHandoff). */
function copyTranscript(src: string, dst: string, now: () => number): CopyResult {
  const whole = readFileSync(src)
  const end = whole.lastIndexOf(10) + 1
  if (!end) throw new Error('Session transcript has no complete line yet')
  const a = whole.subarray(0, end) // drop a partial trailing line

  const r: CopyResult = { dst, from: 0, to: a.length, replaced: false, sib: [] }
  if (lstatExists(dst)) {
    if (!regularFile(dst)) throw new Error('Target transcript is not a regular file; refusing to touch it')
    const b = readFileSync(dst)
    if (b.length >= a.length && b.subarray(0, a.length).equals(a)) r.from = r.to = b.length // same or newer: nothing appended
    else if (a.subarray(0, b.length).equals(b)) {
      appendFileSync(dst, a.subarray(b.length))
      r.from = b.length
    } else {
      renameSync(dst, `${dst}.relay-bak-${now()}`)
      writeFileSync(dst, a, { flag: 'wx' })
      r.replaced = true
    }
  } else writeFileSync(dst, a, { flag: 'wx' })
  return r
}

/**
 * Copies a session transcript (complete lines only) into the target account (same provider only).
 * Claude: its projects dir plus the sibling `<id>/` dir (subagents, tool-results); file-history (/rewind) is not copied.
 * Codex: the rollout file at the same sessions/YYYY/MM/DD path (the target's SQLite index is not needed: `codex resume <id>` finds it by id).
 * Target is never overwritten: identical/newer is kept, an older prefix is extended by its tail,
 * a diverged copy is renamed to `<id>.jsonl.relay-bak-<ts>` first.
 */
export function copySessionForHandoff(from: Account, to: Account, cwd: string, sessionId: string, now = Date.now): CopyResult {
  if (from.provider !== to.provider) throw new Error(CROSS_PROVIDER)
  if (!isSessionId(sessionId)) throw new Error('Invalid session id')
  const src = sourceFile(from, cwd, sessionId)
  if (!src || !regularFile(src)) throw new Error('Session has no transcript yet (send a first message before switching)')
  if (from.provider === 'codex') {
    // same relative path (sessions/YYYY/MM/DD/rollout-*.jsonl) in the target, or the file it already has for this id
    if (!codexRolloutOk(src, cwd)) throw new Error('The Codex session was not recorded in this project (or is a sub-agent thread); refusing to copy it')
    const dst = findRollout(to.configDir, sessionId) ?? join(to.configDir, relative(from.configDir, src))
    assertNoLinks(to.configDir, dst)
    mkdirSync(dirname(dst), { recursive: true })
    return copyTranscript(src, dst, now)
  }
  const srcDir = claudeProjectDir(from.configDir, cwd)
  const dstDir = claudeProjectDir(to.configDir, cwd)
  mkdirSync(dstDir, { recursive: true })
  const r = copyTranscript(src, join(dstDir, `${sessionId}.jsonl`), now)

  const sib = join(srcDir, sessionId)
  if (existsSync(sib) && lstatSync(sib).isDirectory()) {
    const out = join(dstDir, sessionId)
    cpSync(sib, out, {
      recursive: true,
      force: false,
      filter: (s) => {
        if (lstatSync(s).isSymbolicLink()) return false
        const d = join(out, relative(sib, s))
        if (regularFile(s) && !lstatExists(d)) r.sib.push(join(sessionId, relative(sib, s)))
        return true
      }
    })
  }
  return r
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
