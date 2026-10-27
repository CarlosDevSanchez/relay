import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEnv } from '../src/main/env'
import { copySessionForHandoff, runHandoff, terminate } from '../src/main/handoff'
import { claudeProjectDir, encodeCwd } from '../src/main/paths'
import { listSessions, sessionTitle } from '../src/main/sessions'
import { checkAccountId, checkHandoff, checkNewAccount, checkRename, checkStart } from '../src/main/validate'
import { addAccount, addProject, loadAccounts, loadCopies, loadProjects, recordCopy, removeAccount, renameAccount } from '../src/main/store'
import { parseAuthStatus, scanUsage } from '../src/main/usage'

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
    expect(checkHandoff({ ptyId: 1, fromAccountId: 'a', toAccountId: 'b', cwd: '/p', sessionId: SID }, accounts, ['/p']).map((x) => x.id)).toEqual(['a', 'b'])
    expect(() => checkHandoff({ ptyId: 1, fromAccountId: 'a', toAccountId: 'b', cwd: '/p', sessionId: '../x' }, accounts, ['/p'])).toThrow()
    expect(() => checkNewAccount('l', 'claude', undefined)).not.toThrow()
    expect(() => checkNewAccount('l', 'toString', undefined)).toThrow(/provider/)
    expect(() => checkNewAccount('', 'claude', undefined)).toThrow(/label/)
    expect(() => checkNewAccount('l', 'claude', 5)).toThrow(/configDir/)
    expect(() => checkNewAccount('l', 'claude', '/h/accounts/x/../y', '/h')).toThrow(/managed/)
    expect(() => checkNewAccount('l', 'claude', '/h/other', '/h')).not.toThrow()
  })
})

describe('accounts rename/remove', () => {
  it('deletes managed dirs, only unlinks imported ones', async () => {
    const home = tmp()
    const m = addAccount(home, 'm', 'claude')
    const ext = tmp()
    writeFileSync(join(ext, 'keep'), 'x')
    const i = addAccount(home, 'i', 'claude', ext)
    expect(renameAccount(home, m.id, 'new').map((a) => a.label)).toEqual(['new', 'i'])
    expect((await removeAccount(home, m.id)).map((a) => a.id)).toEqual([i.id])
    expect(existsSync(m.configDir)).toBe(false)
    expect(await removeAccount(home, i.id)).toEqual([])
    expect(existsSync(join(ext, 'keep'))).toBe(true)
    expect(await removeAccount(home, 'nope')).toEqual([])
  })
  it('validates ids and labels', () => {
    const acc = [{ id: 'a', label: 'a', provider: 'claude' as const, configDir: '/c' }]
    expect(checkAccountId('a', acc).id).toBe('a')
    expect(() => checkAccountId('../x', acc)).toThrow(/account/)
    expect(checkRename('a', 'n', acc)).toBe('n')
    expect(() => checkRename('a', '', acc)).toThrow(/label/)
    expect(() => checkHandoff({ ptyId: 'x' as never, fromAccountId: 'a', toAccountId: 'a', cwd: '/p', sessionId: SID }, acc, ['/p'])).toThrow(/pty/)
  })
})

describe('usage', () => {
  const NOW = Date.parse('2026-10-09T05:00:00Z')
  const asst = (ts: string, tok = 0, extra: object = {}) =>
    line({ type: 'assistant', timestamp: ts, message: { usage: { input_tokens: tok, output_tokens: tok, cache_creation_input_tokens: tok, cache_read_input_tokens: tok } }, ...extra })
  const lim = (ts: string, kind = 'session') =>
    line({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, error: 'rate_limit', message: { usage: { input_tokens: 0 }, content: [{ type: 'text', text: `You've hit your ${kind} limit · resets 1:10am (America/Bogota)` }] } })
  const put = (cfg: string, name: string, body: string, mtime = NOW / 1000) => {
    const d = join(cfg, 'projects', 'p')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, name), body)
    utimesSync(join(d, name), mtime, mtime)
  }
  it('parses auth status defensively', () => {
    expect(parseAuthStatus('{"loggedIn":true,"email":"a@b","subscriptionType":"pro"}')).toEqual({ loggedIn: true, email: 'a@b', plan: 'pro' })
    expect(parseAuthStatus('{"loggedIn":true,"email":null,"subscriptionType":"team"}')).toEqual({ loggedIn: true, plan: 'team' })
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({ loggedIn: false })
    expect(parseAuthStatus('nope')).toEqual({ loggedIn: null })
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toEqual({ loggedIn: null })
  })
  it('sums tokens in the 5h window and ignores old files', async () => {
    const c = tmp()
    put(c, 'a.jsonl', asst('2026-10-09T04:00:00Z', 1) + asst('2026-10-08T20:00:00Z', 100) + 'garbage\n' + line({ type: 'user', timestamp: '2026-10-09T04:30:00Z' }))
    put(c, 'old.jsonl', asst('2026-10-09T04:00:00Z', 1000), NOW / 1000 - 30 * 86400)
    expect(await scanUsage(c, NOW)).toEqual({ tokens5h: 4 })
    expect(await scanUsage(tmp(), NOW)).toEqual({ tokens5h: 0 })
  })
  it('limited only while the rate_limit line is newer than any successful reply', async () => {
    const c = tmp()
    put(c, 'a.jsonl', asst('2026-10-09T03:00:00Z') + lim('2026-10-09T04:17:00Z'))
    expect((await scanUsage(c, NOW)).limited).toEqual({ kind: 'session', resetText: '1:10am (America/Bogota)' })
    put(c, 'b.jsonl', asst('2026-10-09T04:30:00Z'))
    expect((await scanUsage(c, NOW)).limited).toBeUndefined()
    const w = tmp()
    put(w, 'a.jsonl', lim('2026-10-05T04:17:00Z', 'weekly'))
    expect((await scanUsage(w, NOW)).limited?.kind).toBe('weekly')
    const s = tmp()
    put(s, 'a.jsonl', lim('2026-10-09T00:00:00Z')) // session limit older than 5h: expired
    expect((await scanUsage(s, NOW)).limited).toBeUndefined()
  })
})

describe('usage: dedupe, copies, unreadable files, tampered accounts', () => {
  const NOW = Date.parse('2026-10-09T05:00:00Z')
  const msg = (ts: string, id: string, tok: number) =>
    line({ type: 'assistant', timestamp: ts, message: { id, usage: { input_tokens: tok } } })
  const limLine = (ts: string) =>
    line({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 1:10am (UTC)" }] } })
  const put = (cfg: string, rel: string, body: string) => {
    const f = join(cfg, 'projects', 'p', rel)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, body)
    utimesSync(f, NOW / 1000, NOW / 1000)
  }
  it('counts a message id once (one line per content block)', async () => {
    const c = tmp()
    put(c, 'a.jsonl', msg('2026-10-09T04:00:00Z', 'm1', 5) + msg('2026-10-09T04:00:01Z', 'm1', 5) + msg('2026-10-09T04:01:00Z', 'm2', 1))
    expect((await scanUsage(c, NOW)).tokens5h).toBe(6)
  })
  it('ignores lines of a transcript copied into the account (rate_limit and tokens)', async () => {
    const c = tmp()
    const body = msg('2026-10-09T04:00:00Z', 'm1', 50) + limLine('2026-10-09T04:17:00Z')
    put(c, `${SID}.jsonl`, body)
    expect((await scanUsage(c, NOW)).limited).toBeDefined()
    const copiedAt = Date.parse('2026-10-09T04:20:00Z')
    expect(await scanUsage(c, NOW, { [SID]: copiedAt })).toEqual({ tokens5h: 0 })
    put(c, `${SID}.jsonl`, body + msg('2026-10-09T04:30:00Z', 'm9', 2)) // new work on the target after the copy
    expect(await scanUsage(c, NOW, { [SID]: copiedAt })).toEqual({ tokens5h: 2 })
    put(c, `${SID}/subagents/x.jsonl`, limLine('2026-10-09T04:10:00Z')) // sibling dir belongs to the same session
    expect((await scanUsage(c, NOW, { [SID]: copiedAt })).limited).toBeUndefined()
  })
  it('records copies per account', () => {
    const h = tmp()
    recordCopy(h, 'a', SID, 5)
    recordCopy(h, 'a', 'x', 6)
    expect(loadCopies(h)).toEqual({ a: { [SID]: 5, x: 6 } })
  })
  it('skips unreadable files instead of throwing', async () => {
    const c = tmp()
    put(c, 'ok.jsonl', msg('2026-10-09T04:00:00Z', 'm1', 3))
    put(c, 'bad.jsonl', msg('2026-10-09T04:00:00Z', 'm2', 3))
    chmodSync(join(c, 'projects', 'p', 'bad.jsonl'), 0)
    expect((await scanUsage(c, NOW)).tokens5h).toBe(3)
  })
  it('removeAccount never deletes a tampered configDir', async () => {
    const home = tmp()
    const victim = tmp()
    writeFileSync(join(victim, 'keep'), 'x')
    const a = addAccount(home, 'a', 'claude')
    writeFileSync(join(home, 'accounts.json'), JSON.stringify([{ ...a, configDir: victim }]))
    const order: string[] = []
    await removeAccount(home, a.id, async () => void order.push(`unlinked:${loadAccounts(home).length}`))
    expect(order).toEqual(['unlinked:0']) // unlinked before cleanup hook runs
    expect(existsSync(join(victim, 'keep'))).toBe(true)
  })
})
