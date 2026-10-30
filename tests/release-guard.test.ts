import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../scripts/release-guard.sh')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' })
const guard = (cwd: string, tag: string) => {
  try {
    execFileSync('sh', [script, tag], { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('release guard', () => {
  const d = mkdtempSync(join(tmpdir(), 'relay-guard-'))
  git(d, 'init', '-q', '-b', 'main')
  writeFileSync(join(d, 'package.json'), '{"version":"1.2.3"}')
  git(d, 'add', '.')
  git(d, 'commit', '-qm', 'a')
  git(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(d, 'tag', 'v1.2.3')
  git(d, 'tag', 'v1.2.4')
  git(d, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(d, 'x'), 'x')
  git(d, 'add', '.')
  git(d, 'commit', '-qm', 'b')
  git(d, 'tag', 'v1.2.3-off')

  it('passes when the tag equals package.json and sits on origin/main', () => expect(guard(d, 'v1.2.3')).toBe(true))
  it('fails on a version mismatch', () => expect(guard(d, 'v1.2.4')).toBe(false))
  it('fails when the tag does not exist', () => expect(guard(d, 'v9.9.9')).toBe(false))
  it('fails on a malformed tag', () => expect(guard(d, 'v1.2')).toBe(false))
  it('fails when the tag commit is not on origin/main', () => {
    git(d, 'tag', '-f', 'v1.2.3', 'side')
    expect(guard(d, 'v1.2.3')).toBe(false)
  })
})
