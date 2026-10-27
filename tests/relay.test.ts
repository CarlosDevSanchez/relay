import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEnv } from '../src/main/env'
import { copySessionForHandoff, runHandoff, terminate } from '../src/main/handoff'
import { claudeProjectDir, encodeCwd } from '../src/main/paths'
import { listSessions, sessionTitle } from '../src/main/sessions'
import { checkHandoff, checkNewAccount, checkStart } from '../src/main/validate'
import { addAccount, addProject, loadAccounts, loadProjects } from '../src/main/store'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'relay-')))
const SID = '11111111-2222-3333-4444-555555555555'
const line = (o: object) => JSON.stringify(o) + '\n'
const fixture =
  line({ type: 'mode' }) +
  line({ type: 'user', isMeta: true, message: { content: 'caveat' } }) +
  line({ type: 'user', message: { content: '<command-name>/model</command-name>' } }) +
  line({ type: 'user', message: { content: [{ type: 'text', text: 'fix the   login bug' }] } })

describe('paths', () => {
  it('encodes like Claude Code', () => {
    expect(encodeCwd('/Users/a/Documents/x.y')).toBe('-Users-a-Documents-x-y')
    expect(encodeCwd('/Users/a/.claude/worktrees')).toBe('-Users-a--claude-worktrees')
  })
})

describe('store', () => {
  it('creates account dirs, imports without touching the dir, dedups projects', () => {
    const home = tmp()
    const a = addAccount(home, 'one', 'claude')
    expect(a.configDir).toBe(join(home, 'accounts', a.id))
    const ext = tmp()
    const b = addAccount(home, 'imp', 'claude', ext)
    expect(b.configDir).toBe(ext)
    expect(loadAccounts(home).map((x) => x.label)).toEqual(['one', 'imp'])
    const p = tmp()
    addProject(home, p)
    expect(addProject(home, p)).toEqual([p])
    expect(loadProjects(home)).toEqual([p])
    const link = join(tmp(), 'link')
    symlinkSync(p, link)
    expect(addProject(home, link)).toEqual([p]) // realpath
    let deep = tmp()
    while (deep.length < 210) deep = join(deep, 'x'.repeat(40))
    mkdirSync(deep, { recursive: true })
    expect(() => addProject(home, deep)).toThrow(/too long/)
    expect(loadAccounts(tmp())).toEqual([])
  })
})

describe('env', () => {
  it('sets the config dir per provider and strips credentials', () => {
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDECODE: '1', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: '/old', FOO: '1' }
    const e = buildEnv({ id: '1', label: 'a', provider: 'claude', configDir: '/c' }, base)
    expect(e.CLAUDE_CONFIG_DIR).toBe('/c')
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_PID']) expect(e[k]).toBeUndefined()
    expect(e.FOO).toBe('1')
    expect(e.PATH).toContain('.local/bin')
    expect(buildEnv({ id: '2', label: 'b', provider: 'codex', configDir: '/h' }, base).CODEX_HOME).toBe('/h')
  })
})

describe('sessions', () => {
  it('titles skip meta and command wrappers', () => {
    expect(sessionTitle(fixture)).toBe('fix the login bug')
    expect(sessionTitle('garbage\n')).toBe('(untitled)')
  })
  it('lists across accounts, newest first', () => {
    const cwd = '/work/proj'
    const [a, b] = [tmp(), tmp()].map((configDir, i) => ({ id: `a${i}`, label: `A${i}`, provider: 'claude' as const, configDir }))
    for (const [acc, id, t] of [[a!, SID, 100], [b!, 'ffffffff-2222-3333-4444-555555555555', 200]] as const) {
      const d = claudeProjectDir(acc.configDir, cwd)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, `${id}.jsonl`), fixture)
      utimesSync(join(d, `${id}.jsonl`), t, t)
    }
    const r = listSessions([a!, b!, { id: 'x', label: 'cx', provider: 'codex', configDir: tmp() }], cwd)
    expect(r.map((s) => [s.id, s.accountId])).toEqual([['ffffffff-2222-3333-4444-555555555555', 'a1'], [SID, 'a0']])
    writeFileSync(join(claudeProjectDir(a!.configDir, cwd), 'not-a-uuid.jsonl'), fixture)
    const d2 = claudeProjectDir(b!.configDir, cwd)
    writeFileSync(join(d2, `${SID}.jsonl`), fixture) // newer duplicate of SID on b
    utimesSync(join(d2, `${SID}.jsonl`), 300, 300)
    expect(listSessions([a!, b!], cwd).map((s) => [s.id === SID, s.accountId])).toEqual([[true, 'a1'], [false, 'a1']])
    expect(listSessions([a!], '/nope')).toEqual([])
  })
})

describe('handoff', () => {
  const setup = () => {
    const cwd = '/work/proj'
    const [from, to] = [tmp(), tmp()].map((configDir, i) => ({ id: `a${i}`, label: `A${i}`, provider: 'claude' as const, configDir }))
    const dir = (a: typeof from) => claudeProjectDir(a!.configDir, cwd)
    const src = join(dir(from), `${SID}.jsonl`)
    const dst = join(dir(to), `${SID}.jsonl`)
    mkdirSync(dir(from), { recursive: true })
    writeFileSync(src, 'one\n')
    return { cwd, from: from!, to: to!, src, dst }
  }
  const copy = (x: ReturnType<typeof setup>, rev = false, now = () => 1) =>
    rev ? copySessionForHandoff(x.to, x.from, x.cwd, SID, now) : copySessionForHandoff(x.from, x.to, x.cwd, SID, now)

  it('copies, is idempotent, appends the tail, keeps a newer target', () => {
    const x = setup()
    copy(x)
    expect(readFileSync(x.dst, 'utf8')).toBe('one\n')
    copy(x)
    writeFileSync(x.src, 'one\ntwo\n')
    copy(x)
    expect(readFileSync(x.dst, 'utf8')).toBe('one\ntwo\n')
    writeFileSync(x.dst, 'one\ntwo\nnewer\n')
    copy(x)
    expect(readFileSync(x.dst, 'utf8')).toBe('one\ntwo\nnewer\n')
  })
  it('copies only complete lines', () => {
    const x = setup()
    writeFileSync(x.src, 'one\npart')
    copy(x)
    expect(readFileSync(x.dst, 'utf8')).toBe('one\n')
    writeFileSync(x.src, 'part')
    expect(() => copy(x)).toThrow(/no complete line/)
  })
  it('renames a diverged target instead of overwriting or failing', () => {
    const x = setup()
    mkdirSync(join(x.dst, '..'), { recursive: true })
    writeFileSync(x.dst, 'stale\n')
    copy(x, false, () => 42)
    expect(readFileSync(x.dst, 'utf8')).toBe('one\n')
    expect(readFileSync(`${x.dst}.relay-bak-42`, 'utf8')).toBe('stale\n')
    expect(readdirSync(join(x.dst, '..')).filter((f) => f.endsWith('.jsonl'))).toEqual([`${SID}.jsonl`])
  })
  it('copies the sibling dir (skipping symlinks), rejects bad ids, symlinks, missing source, codex', () => {
    const x = setup()
    const sib = join(x.src, '..', SID, 'subagents')
    mkdirSync(sib, { recursive: true })
    writeFileSync(join(sib, 'a.jsonl'), 'sub\n')
    symlinkSync('/etc/hosts', join(sib, 'evil'))
    copy(x)
    expect(readFileSync(join(x.dst, '..', SID, 'subagents', 'a.jsonl'), 'utf8')).toBe('sub\n')
    expect(existsSync(join(x.dst, '..', SID, 'subagents', 'evil'))).toBe(false)
    expect(() => copySessionForHandoff(x.from, x.to, x.cwd, '../../x')).toThrow(/Invalid session id/)
    expect(() => copySessionForHandoff(x.from, x.to, x.cwd, 'ffffffff-2222-3333-4444-555555555555')).toThrow(/no transcript/)
    expect(() => copySessionForHandoff({ ...x.from, provider: 'codex' }, x.to, x.cwd, SID)).toThrow(/Claude/)
    // symlinked source / target are refused
    const y = setup()
    const real = join(tmp(), 'real.jsonl')
    writeFileSync(real, 'one\n')
    mkdirSync(join(y.dst, '..'), { recursive: true })
    symlinkSync(real, y.dst)
    expect(() => copy(y)).toThrow(/regular file/)
    const z = setup()
    const ext = join(tmp(), 'ext.jsonl')
    writeFileSync(ext, 'one\n')
    require('node:fs').rmSync(z.src)
    symlinkSync(ext, z.src)
    expect(() => copy(z)).toThrow(/no transcript/)
  })
  it('ping-pong A->B->A survives a CLI that appends lines when killed (B1)', async () => {
    const x = setup()
    // fake pty: on kill it appends mode lines asynchronously, like claude on SIGHUP
    const fakePty = (file: string) => {
      let done!: () => void
      const exited = new Promise<void>((r) => (done = r))
      return { exited, kill: () => setTimeout(() => (require('node:fs').appendFileSync(file, '{"type":"mode"}\n'), done()), 20) }
    }
    const a = fakePty(x.src)
    await runHandoff(() => terminate(a.kill, a.exited), () => void copy(x), () => 'B started')
    expect(readFileSync(x.dst, 'utf8')).toBe(readFileSync(x.src, 'utf8')) // copy happened after the exit write
    require('node:fs').appendFileSync(x.dst, 'two-on-B\n')
    const b = fakePty(x.dst)
    await runHandoff(() => terminate(b.kill, b.exited), () => void copy(x, true), () => 'A started')
    expect(readFileSync(x.src, 'utf8')).toBe(readFileSync(x.dst, 'utf8'))
  })
  it('terminate escalates to SIGKILL when the process ignores SIGHUP', async () => {
    const sigs: (string | undefined)[] = []
    let done!: () => void
    const exited = new Promise<void>((r) => (done = r))
    await terminate((s) => (sigs.push(s), s === 'SIGKILL' && done()), exited, 10)
    expect(sigs).toEqual([undefined, 'SIGKILL'])
  })
})

describe('validate', () => {
  const accounts = [{ id: 'a', label: 'a', provider: 'claude' as const, configDir: '/c' }, { id: 'b', label: 'b', provider: 'claude' as const, configDir: '/d' }]
  const req = { accountId: 'a', cwd: '/p', mode: 'resume' as const, sessionId: SID }
  it('start', () => {
    expect(checkStart(req, accounts, ['/p']).id).toBe('a')
    expect(() => checkStart({ ...req, accountId: 'zz' }, accounts, ['/p'])).toThrow(/account/)
    expect(() => checkStart(req, accounts, ['/other'])).toThrow(/project/)
    expect(() => checkStart({ ...req, sessionId: '--dangerously-skip-permissions' }, accounts, ['/p'])).toThrow(/session/)
    expect(() => checkStart({ ...req, mode: 'evil' as never }, accounts, ['/p'])).toThrow(/mode/)
    expect(checkStart({ accountId: 'a', cwd: '', mode: 'login' }, accounts, []).id).toBe('a')
    expect(checkStart({ accountId: 'a', cwd: '/p', mode: 'new' }, accounts, ['/p']).id).toBe('a')
  })
  it('handoff and new account', () => {
    expect(checkHandoff({ fromAccountId: 'a', toAccountId: 'b', cwd: '/p', sessionId: SID }, accounts, ['/p']).map((x) => x.id)).toEqual(['a', 'b'])
    expect(() => checkHandoff({ fromAccountId: 'a', toAccountId: 'b', cwd: '/p', sessionId: '../x' }, accounts, ['/p'])).toThrow()
    expect(() => checkNewAccount('l', 'claude', undefined)).not.toThrow()
    expect(() => checkNewAccount('l', 'toString', undefined)).toThrow(/provider/)
    expect(() => checkNewAccount('', 'claude', undefined)).toThrow(/label/)
    expect(() => checkNewAccount('l', 'claude', 5)).toThrow(/configDir/)
  })
})
