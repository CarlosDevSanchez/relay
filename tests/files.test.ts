import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listFiles } from '../src/main/files'

const tmp = mkdtempSync(join(tmpdir(), 'relay-files-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const w = (root: string, p: string, c = 'x') => (mkdirSync(join(root, p, '..'), { recursive: true }), writeFileSync(join(root, p), c))

describe('listFiles (the @ autocomplete)', () => {
  const root = join(tmp, 'proj')
  const outside = join(tmp, 'outside')
  w(root, 'README.md')
  w(root, 'src/app.ts')
  w(root, 'src/deep/er/est/est2/est3/est4/too-deep.ts')
  w(root, 'node_modules/pkg/index.js')
  w(root, '.git/config')
  w(root, '.hidden/secret.txt')
  w(root, '.env')
  w(root, 'with space.txt')
  w(root, 'bidi\u202Etxt.md')
  w(root, 'zero\u200Bwidth.md')
  for (const b of ['dist', 'build', 'out', 'coverage', 'target', 'vendor', 'Pods']) w(root, `${b}/x.js`)
  w(root, 'src/ok-inner.ts')
  w(outside, 'secret.txt', 'TOP SECRET')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out.txt'))
  symlinkSync(outside, join(root, 'dir-out'))
  symlinkSync(join(root, 'README.md'), join(root, 'link-in.md'))
  symlinkSync(join(root, 'nope'), join(root, 'dangling'))
  const got = listFiles(root)
  it('lists project files relative to the project, shallow ones first', () => {
    expect(got).toContain('README.md')
    expect(got).toContain('src/app.ts')
    expect(got.indexOf('README.md')).toBeLessThan(got.indexOf('src/app.ts'))
  })
  it('skips .git, node_modules, dot entries (.env too) and names with whitespace', () => {
    expect(got.filter((p) => /node_modules|\.git|\.hidden|\.env|space|bidi|zero|^(dist|build|out|coverage|target|vendor|Pods)\//.test(p))).toEqual([])
  })
  it('never follows symlinks out of the project nor into directories; dangling ones are skipped; links inside are fine', () => {
    expect(got.some((p) => /link-out|dir-out|secret|dangling/.test(p))).toBe(false)
    expect(got).toContain('link-in.md')
  })
  it('caps depth and count', () => {
    expect(got.some((p) => p.includes('too-deep'))).toBe(false)
    expect(listFiles(root, 2)).toHaveLength(2)
  })
  it('caps the directories visited (a tree of empty dirs cannot stall main)', () => {
    const big = join(tmp, 'big')
    for (let i = 0; i < 50; i++) mkdirSync(join(big, `d${i}`), { recursive: true })
    w(big, 'z-last/file.txt')
    expect(listFiles(big, 2000, 5, 10)).not.toContain('z-last/file.txt')
    expect(listFiles(big)).toContain('z-last/file.txt')
  })
  it('a missing project lists nothing', () => {
    expect(listFiles(join(tmp, 'nope'))).toEqual([])
  })
  it('a project root that is itself a symlink works (realpath)', () => {
    symlinkSync(root, join(tmp, 'rootlink'))
    expect(listFiles(join(tmp, 'rootlink'))).toContain('README.md')
  })
})
