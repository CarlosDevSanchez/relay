import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account } from '../shared/types'
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

/**
 * Copies a Claude session transcript (complete lines only) into the target account's projects dir,
 * plus the sibling `<id>/` dir (subagents, tool-results). file-history (/rewind) is not copied.
 * Target is never overwritten: identical/newer is kept, an older prefix is extended by its tail,
 * a diverged copy is renamed to `<id>.jsonl.relay-bak-<ts>` first.
 */
export function copySessionForHandoff(from: Account, to: Account, cwd: string, sessionId: string, now = Date.now): string {
  if (from.provider !== 'claude' || to.provider !== 'claude') {
    throw new Error('Handoff is only verified for Claude accounts')
  }
  if (!isSessionId(sessionId)) throw new Error('Invalid session id')
  const srcDir = claudeProjectDir(from.configDir, cwd)
  const src = join(srcDir, `${sessionId}.jsonl`)
  if (!regularFile(src)) throw new Error('Session has no transcript yet (send a first message before switching)')
  const whole = readFileSync(src)
  const end = whole.lastIndexOf(10) + 1
  if (!end) throw new Error('Session transcript has no complete line yet')
  const a = whole.subarray(0, end) // drop a partial trailing line

  const dstDir = claudeProjectDir(to.configDir, cwd)
  const dst = join(dstDir, `${sessionId}.jsonl`)
  mkdirSync(dstDir, { recursive: true })
  if (lstatExists(dst)) {
    if (!regularFile(dst)) throw new Error('Target transcript is not a regular file; refusing to touch it')
    const b = readFileSync(dst)
    if (b.length >= a.length && b.subarray(0, a.length).equals(a)) return dst // same or newer
    if (a.subarray(0, b.length).equals(b)) appendFileSync(dst, a.subarray(b.length))
    else {
      renameSync(dst, `${dst}.relay-bak-${now()}`)
      writeFileSync(dst, a, { flag: 'wx' })
    }
  } else writeFileSync(dst, a, { flag: 'wx' })

  const sib = join(srcDir, sessionId)
  if (existsSync(sib) && lstatSync(sib).isDirectory()) {
    cpSync(sib, join(dstDir, sessionId), { recursive: true, force: false, filter: (s) => !lstatSync(s).isSymbolicLink() })
  }
  return dst
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
