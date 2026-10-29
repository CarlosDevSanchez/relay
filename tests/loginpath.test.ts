import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOGIN_PATH_CMD, mergePath, parseLoginPath, plainEnv, setLoginPath } from '../src/main/env'

describe('login shell PATH', () => {
  it('extracts PATH between markers, ignoring rc junk', () => {
    expect(parseLoginPath('hello\n__RELAY_PATH__/a:/b__RELAY_PATH__\nbye')).toBe('/a:/b')
    expect(parseLoginPath('no markers /a:/b')).toBe('')
    expect(parseLoginPath('__RELAY_PATH____RELAY_PATH__')).toBe('')
    expect(parseLoginPath('__RELAY_PATH__/Applications/VMware Fusion.app/Contents/Public:/c__RELAY_PATH__')).toBe('/Applications/VMware Fusion.app/Contents/Public:/c')
    expect(parseLoginPath('__RELAY_PATH__/a\n:/c__RELAY_PATH__')).toBe('')
  })
  it('the real probe prints PATH through sh and a login zsh', () => {
    const run = (sh: string, args: string[], env: Record<string, string>) => parseLoginPath(execFileSync(sh, [...args, LOGIN_PATH_CMD], { env, encoding: 'utf8' }))
    expect(run('/bin/sh', ['-c'], { PATH: '/x:/y' })).toBe('/x:/y')
    const home = mkdtempSync(join(tmpdir(), 'relay-zdot-'))
    expect(run('/bin/zsh', ['-ilc'], { PATH: '/x:/y', HOME: home, ZDOTDIR: home })).toContain('/x:/y')
  })
  it('merges shell entries first, deduped, keeping current ones', () => {
    expect(mergePath('/u/.bun/bin:/usr/bin', '/usr/bin:/bin')).toBe('/u/.bun/bin:/usr/bin:/bin')
    expect(mergePath('', '/usr/bin')).toBe('/usr/bin')
  })
  it('plainEnv uses the stored login PATH', () => {
    setLoginPath('/u/.bun/bin')
    const p = (plainEnv({ PATH: '/usr/bin' }).PATH ?? '').split(':')
    setLoginPath('')
    expect(p[0]).toBe('/u/.bun/bin')
    expect(p).toContain('/usr/bin')
    expect(p).toContain('/opt/homebrew/bin')
  })
})
