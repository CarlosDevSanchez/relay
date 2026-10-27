import { copyFileSync, mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Account } from '../shared/types'
import { claudeProjectDir } from './paths'

/**
 * Copies a Claude session transcript into the target account's projects dir.
 * Never overwrites different content. If the target already holds an earlier
 * prefix of the source (ping-pong between accounts), only the missing tail is appended.
 */
export function copySessionForHandoff(from: Account, to: Account, cwd: string, sessionId: string): string {
  if (from.provider !== 'claude' || to.provider !== 'claude') {
    throw new Error('Handoff is only verified for Claude accounts')
  }
  const src = join(claudeProjectDir(from.configDir, cwd), `${sessionId}.jsonl`)
  if (!existsSync(src)) throw new Error('Session has no transcript yet (send a first message before switching)')
  const dstDir = claudeProjectDir(to.configDir, cwd)
  const dst = join(dstDir, `${sessionId}.jsonl`)
  mkdirSync(dstDir, { recursive: true })
  if (!existsSync(dst)) {
    copyFileSync(src, dst)
    return dst
  }
  const a = readFileSync(src)
  const b = readFileSync(dst)
  if (a.equals(b) || (b.length > a.length && b.subarray(0, a.length).equals(a))) return dst // target is same or newer
  if (a.length > b.length && a.subarray(0, b.length).equals(b)) {
    appendFileSync(dst, a.subarray(b.length))
    return dst
  }
  throw new Error(`Target already has a different ${sessionId}.jsonl; refusing to overwrite`)
}
