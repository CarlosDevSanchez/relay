import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeCwd } from '../src/main/paths'
import { drifted, linkAccount, nextFlag, sharedDir, unlinkAccount } from '../src/main/shared'
import { addAccount, addProject, removeAccount, setSharedMemory, loadAccounts } from '../src/main/store'
import { checkSharedToggle } from '../src/main/validate'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'relay-sh-')))
const w = (p: string, c: string) => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, c))
const r = (p: string) => readFileSync(p, 'utf8')
const isLink = (p: string) => lstatSync(p).isSymbolicLink()
const acct = (home: string, cfg = tmp()) => ({ id: 'a1', label: 'a', provider: 'claude' as const, configDir: cfg, home })
const SECRETS = { '.credentials.json': 'tok', '.claude.json': 'cj', 'settings.json': 's', 'settings.local.json': 'sl', 'history.jsonl': 'h', 'plugins/p': 'p', 'todos/t': 't', 'shell-snapshots/x': 'x', 'statsig/y': 'y', 'projects/-p/s.jsonl': 'tr' }

describe('shared memory', () => {
  it('seeds shared from the account, links, leaves excluded files untouched, is idempotent', () => {
    const home = tmp()
    const a = acct(home)
    const proj = tmp()
    const mem = join(a.configDir, 'projects', encodeCwd(proj), 'memory')
    w(join(a.configDir, 'CLAUDE.md'), 'me')
    w(join(a.configDir, 'skills/s1/SKILL.md'), 'skill')
    w(join(mem, 'MEMORY.md'), 'mem')
    for (const [k, v] of Object.entries(SECRETS)) w(join(a.configDir, k), v)
    const rep = linkAccount(home, a, [proj])
    expect(rep.errors).toEqual([])
    expect(rep.backups).toEqual([])
    const sh = sharedDir(home)
    expect(rep.linked.sort()).toEqual(['CLAUDE.md', 'agents', 'commands', `projects/${encodeCwd(proj)}/memory`, 'skills'].sort())
    expect(readlinkSync(join(a.configDir, 'CLAUDE.md'))).toBe(join(sh, 'CLAUDE.md')) // absolute
    expect(r(join(sh, 'CLAUDE.md'))).toBe('me')
    expect(r(join(a.configDir, 'skills/s1/SKILL.md'))).toBe('skill')
    expect(r(join(sh, 'projects', encodeCwd(proj), 'memory/MEMORY.md'))).toBe('mem')
    expect(isLink(join(a.configDir, 'agents'))).toBe(true)
    for (const [k, v] of Object.entries(SECRETS)) {
      expect(isLink(join(a.configDir, k))).toBe(false)
      expect(r(join(a.configDir, k))).toBe(v)
    }
    const again = linkAccount(home, a, [proj])
    expect(again).toEqual({ linked: [], backups: [], notes: [], errors: [] })
  })

  it('merges dirs: moves missing children, keeps shared on conflict and backs up the account copy', () => {
    const home = tmp()
    const a = acct(home)
    const sh = sharedDir(home)
    w(join(sh, 'skills/common/x'), 'shared')
    w(join(sh, 'skills/same/x'), 'eq')
    w(join(a.configDir, 'skills/common/x'), 'account')
    w(join(a.configDir, 'skills/same/x'), 'eq')
    w(join(a.configDir, 'skills/only-acct/x'), 'mine')
    w(join(sh, 'CLAUDE.md'), 'shared md')
    w(join(a.configDir, 'CLAUDE.md'), 'acct md')
    const rep = linkAccount(home, a, [])
    expect(rep.errors).toEqual([])
    expect(r(join(sh, 'skills/common/x'))).toBe('shared')
    expect(r(join(sh, 'skills/only-acct/x'))).toBe('mine')
    expect(r(join(a.configDir, 'skills/only-acct/x'))).toBe('mine')
    expect(r(join(a.configDir, 'CLAUDE.md'))).toBe('shared md')
    expect(rep.backups).toHaveLength(2) // identical 'same' is not backed up
    const bk = Object.fromEntries(rep.backups.map((b) => [b.includes('CLAUDE.md') ? 'md' : 'skill', b]))
    expect(r(bk.md!)).toBe('acct md')
    expect(r(join(bk.skill!, 'x'))).toBe('account')
    expect(bk.md!.startsWith(join(home, 'backups', 'a1'))).toBe(true)
  })

  it('relinks a foreign symlink after backing it up as a link', () => {
    const home = tmp()
    const a = acct(home)
    const other = tmp()
    w(join(other, 'f'), 'x')
    symlinkSync(other, join(a.configDir, 'agents'))
    const rep = linkAccount(home, a, [])
    expect(readlinkSync(join(a.configDir, 'agents'))).toBe(join(sharedDir(home), 'agents'))
    expect(isLink(rep.backups[0]!)).toBe(true)
    expect(readlinkSync(rep.backups[0]!)).toBe(other)
    expect(r(join(other, 'f'))).toBe('x') // target untouched
  })

  it('refuses a path that escapes through a symlinked parent', () => {
    const home = tmp()
    const a = acct(home)
    const outside = tmp()
    symlinkSync(outside, join(a.configDir, 'projects'))
    const proj = tmp()
    const rep = linkAccount(home, a, [proj])
    expect(rep.errors).toHaveLength(1)
    expect(rep.errors[0]).toMatch(/not a real directory/)
    expect(readdirSync(outside)).toEqual([]) // nothing created outside
    expect(rep.linked).toContain('skills') // other items still done
  })

  it('unlinks into real copies and never deletes shared content', () => {
    const home = tmp()
    const a = acct(home)
    const proj = tmp()
    w(join(a.configDir, 'CLAUDE.md'), 'me')
    w(join(a.configDir, 'agents/a.md'), 'ag')
    linkAccount(home, a, [proj])
    const mem = join(a.configDir, 'projects', encodeCwd(proj), 'memory')
    w(join(mem, 'n.md'), 'note')
    const rep = unlinkAccount(home, { ...a })
    expect(rep.errors).toEqual([])
    for (const p of [join(a.configDir, 'CLAUDE.md'), join(a.configDir, 'agents'), join(a.configDir, 'skills'), join(a.configDir, 'commands'), mem]) expect(isLink(p)).toBe(false)
    expect(r(join(a.configDir, 'CLAUDE.md'))).toBe('me')
    expect(r(join(a.configDir, 'agents/a.md'))).toBe('ag')
    expect(r(join(mem, 'n.md'))).toBe('note')
    expect(r(join(sharedDir(home), 'agents/a.md'))).toBe('ag')
    expect(r(join(sharedDir(home), 'projects', encodeCwd(proj), 'memory/n.md'))).toBe('note')
    expect(unlinkAccount(home, a).notes).toEqual([]) // idempotent
  })

  it('removing a managed account does not follow links into the shared store', async () => {
    const home = tmp()
    const m = addAccount(home, 'm', 'claude')
    const proj = tmp()
    addProject(home, proj)
    w(join(m.configDir, 'skills/k/SKILL.md'), 'keep')
    w(join(m.configDir, 'CLAUDE.md'), 'keep md')
    linkAccount(home, m, [realpathSync(proj)])
    expect(isLink(join(m.configDir, 'skills'))).toBe(true)
    await removeAccount(home, m.id)
    expect(existsSync(m.configDir)).toBe(false)
    expect(r(join(sharedDir(home), 'skills/k/SKILL.md'))).toBe('keep')
    expect(r(join(sharedDir(home), 'CLAUDE.md'))).toBe('keep md')
  })

  it('persists the toggle and validates it', () => {
    const home = tmp()
    const m = addAccount(home, 'm', 'claude')
    setSharedMemory(home, m.id, true)
    expect(loadAccounts(home)[0]!.sharedMemory).toBe(true)
    const accs = loadAccounts(home)
    expect(checkSharedToggle(m.id, false, accs).id).toBe(m.id)
    expect(() => checkSharedToggle(m.id, 'yes', accs)).toThrow(/enabled/)
    expect(() => checkSharedToggle('../x', true, accs)).toThrow(/account/)
    expect(checkSharedToggle(m.id, true, [{ ...m, provider: 'codex' }]).provider).toBe('codex')
  })

  it('partial link (projects/ is a symlink) can still be unlinked into real copies, and an imported dir survives removal', async () => {
    const home = tmp()
    const ext = tmp()
    const a = addAccount(home, 'imp', 'claude', ext)
    const outside = tmp()
    symlinkSync(outside, join(ext, 'projects'))
    w(join(ext, 'skills/k'), 'sk')
    const rep = linkAccount(home, a, [tmp()])
    expect(rep.errors).toHaveLength(1)
    expect(isLink(join(ext, 'skills'))).toBe(true)
    expect(drifted(home, a)).toEqual([])
    const un = unlinkAccount(home, a)
    expect(un.errors).toEqual([])
    expect(isLink(join(ext, 'skills'))).toBe(false)
    expect(r(join(ext, 'skills/k'))).toBe('sk')
    await removeAccount(home, a.id)
    expect(r(join(ext, 'skills/k'))).toBe('sk')
    expect(readdirSync(outside)).toEqual([])
  })

  it('unlink is atomic: an unreadable shared file leaves the link in place and no temp copy', () => {
    const home = tmp()
    const a = acct(home)
    linkAccount(home, a, [])
    const f = join(sharedDir(home), 'skills/bad')
    w(f, 'x')
    chmodSync(f, 0)
    const un = unlinkAccount(home, a)
    chmodSync(f, 0o644)
    expect(un.errors.length).toBeGreaterThan(0)
    expect(isLink(join(a.configDir, 'skills'))).toBe(true)
    expect(readdirSync(a.configDir).filter((n) => n.includes('relay-tmp'))).toEqual([])
  })

  it('detects drift when the CLI replaces a link with a real file; relink backs it up', () => {
    const home = tmp()
    const a = acct(home)
    linkAccount(home, a, [])
    unlinkSync(join(a.configDir, 'CLAUDE.md'))
    w(join(a.configDir, 'CLAUDE.md'), 'replaced')
    expect(drifted(home, a)).toEqual(['CLAUDE.md'])
    const rep = linkAccount(home, a, [])
    expect(rep.backups).toHaveLength(1)
    expect(r(rep.backups[0]!)).toBe('replaced')
    expect(drifted(home, a)).toEqual([])
  })

  it('refuses when the shared store itself is a symlink', () => {
    const home = tmp()
    symlinkSync(tmp(), sharedDir(home))
    expect(() => linkAccount(home, acct(home), [])).toThrow(/symlink/)
  })

  it('unlinks an imported dir that has non-dir and symlinked entries under projects/, then removes it', async () => {
    const home = tmp()
    const ext = tmp()
    const a = addAccount(home, 'imp', 'claude', ext)
    w(join(ext, 'projects/.DS_Store'), 'x')
    symlinkSync(tmp(), join(ext, 'projects/-linked'))
    w(join(ext, 'CLAUDE.md'), 'me')
    linkAccount(home, a, [])
    const un = unlinkAccount(home, a)
    expect(un.errors).toEqual([])
    expect(r(join(ext, 'CLAUDE.md'))).toBe('me')
    expect((await removeAccount(home, a.id)).length).toBe(0)
    expect(existsSync(join(ext, 'CLAUDE.md'))).toBe(true)
  })

  it('a failure never turns the flag on for a never-consented account', () => {
    expect(nextFlag(true, 0, undefined)).toBe(true)
    expect(nextFlag(true, 2, undefined)).toBe(true) // partial link leaves links, so it must be unlinkable
    expect(nextFlag(false, 1, undefined)).toBe(false)
    expect(nextFlag(false, 1, false)).toBe(false)
    expect(nextFlag(false, 1, true)).toBe(true) // failed unlink: retry
    expect(nextFlag(false, 0, true)).toBe(false)
  })
})
