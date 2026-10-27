import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildEnv } from '../src/main/env'
import { pickRebind, watchNewSession, parseLimitLine, parseLimitText, parseResetAt, scheduleAt, tailFile, watchLimits } from '../src/main/limit'
import { loadPrefs, savePrefs } from '../src/main/prefs'
import { providers } from '../src/main/providers'
import { copySessionForHandoff, runHandoff, terminate } from '../src/main/handoff'
import { claudeProjectDir, encodeCwd } from '../src/main/paths'
import { listSessions, sessionTitle } from '../src/main/sessions'
import { checkReminder, checkAccountId, checkHandoff, checkNewAccount, checkRename, checkStart } from '../src/main/validate'
import { addAccount, addProject, loadAccounts, loadCopies, loadProjects, pruneCopies, recordCopy, removeAccount, renameAccount } from '../src/main/store'
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
    expect(() => copySessionForHandoff({ ...x.from, provider: 'codex' }, x.to, x.cwd, SID)).toThrow(/Claude ↔ Codex/)
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
  const lim = (ts: string, kind = 'session', when = '1:10am (America/Bogota)') =>
    line({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, error: 'rate_limit', message: { usage: { input_tokens: 0 }, content: [{ type: 'text', text: `You've hit your ${kind} limit · resets ${when}` }] } })
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
    expect((await scanUsage(c, NOW)).limited).toEqual({ kind: 'session', resetText: '1:10am (America/Bogota)', resetAt: Date.parse('2026-10-09T06:10:00Z') })
    put(c, 'b.jsonl', asst('2026-10-09T04:30:00Z'))
    expect((await scanUsage(c, NOW)).limited).toBeUndefined()
    const w = tmp()
    put(w, 'a.jsonl', lim('2026-10-05T04:17:00Z', 'weekly', 'Oct 12, 3pm (UTC)'))
    expect((await scanUsage(w, NOW)).limited?.kind).toBe('weekly')
    const s = tmp()
    put(s, 'a.jsonl', lim('2026-10-08T00:00:00Z')) // reset time already passed: expired
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
  it('ignores lines copied into the account by byte range, keeps the target\'s own', async () => {
    const c = tmp()
    const own = msg('2026-10-09T03:00:00Z', 'own', 7)
    const copiedBody = msg('2026-10-09T04:00:00Z', 'm1', 50) + limLine('2026-10-09T04:17:00Z')
    const later = msg('2026-10-09T04:30:00Z', 'm9', 2)
    put(c, `${SID}.jsonl`, own + copiedBody + later)
    const from = Buffer.byteLength(own)
    const rec = { ranges: [[from, from + Buffer.byteLength(copiedBody)]] as [number, number][], sib: [] }
    expect(await scanUsage(c, NOW, {})).toMatchObject({ tokens5h: 59 })
    expect(await scanUsage(c, NOW, { [SID]: rec })).toEqual({ tokens5h: 9 }) // own 7 + later 2, no limit
    put(c, `${SID}/subagents/x.jsonl`, limLine('2026-10-09T04:45:00Z') + msg('2026-10-09T04:11:00Z', 'sub', 100))
    expect((await scanUsage(c, NOW, { [SID]: rec })).limited).toBeDefined() // sibling file not recorded as copied
    const r2 = { ...rec, sib: [`${SID}/subagents/x.jsonl`] }
    expect(await scanUsage(c, NOW, { [SID]: r2 })).toEqual({ tokens5h: 9 })
  })
  it('dedupe keeps the max usage per message id and limits end at resetAt', async () => {
    const c = tmp()
    put(c, 'a.jsonl', msg('2026-10-09T04:00:00Z', 'm1', 1) + msg('2026-10-09T04:00:01Z', 'm1', 5))
    expect((await scanUsage(c, NOW)).tokens5h).toBe(5)
    const d = tmp()
    put(d, 'a.jsonl', limLine('2026-10-09T04:17:00Z')) // resets 1:10am UTC on 10-10
    expect((await scanUsage(d, NOW)).limited?.resetAt).toBe(Date.parse('2026-10-10T01:10:00Z'))
    expect((await scanUsage(d, Date.parse('2026-10-10T01:11:00Z'))).limited).toBeUndefined()
  })
  it('records copy ranges, skips no-ops, voids ranges on replace', () => {
    const h = tmp()
    recordCopy(h, 'a', SID, { from: 0, to: 10, replaced: false, sib: [] })
    recordCopy(h, 'a', SID, { from: 10, to: 10, replaced: false, sib: [] }) // nothing appended
    recordCopy(h, 'a', SID, { from: 20, to: 30, replaced: false, sib: ['s/x.jsonl'] })
    expect(loadCopies(h)).toEqual({ a: { [SID]: { ranges: [[0, 10], [20, 30]], sib: ['s/x.jsonl'] } } })
    recordCopy(h, 'a', SID, { from: 0, to: 5, replaced: true, sib: [] })
    expect(loadCopies(h).a![SID]!.ranges).toEqual([[0, 5]])
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

describe('copy result', () => {
  it('reports the copied byte range, new sibling files and replacement', () => {
    const cwd = '/work/proj'
    const [from, to] = [tmp(), tmp()].map((configDir, i) => ({ id: `a${i}`, label: `A${i}`, provider: 'claude' as const, configDir }))
    const sd = claudeProjectDir(from!.configDir, cwd)
    mkdirSync(join(sd, SID, 'subagents'), { recursive: true })
    writeFileSync(join(sd, `${SID}.jsonl`), 'one\n')
    writeFileSync(join(sd, SID, 'subagents', 'a.jsonl'), 's\n')
    const r1 = copySessionForHandoff(from!, to!, cwd, SID)
    expect([r1.from, r1.to, r1.replaced, r1.sib]).toEqual([0, 4, false, [`${SID}/subagents/a.jsonl`]])
    const r2 = copySessionForHandoff(from!, to!, cwd, SID)
    expect([r2.from, r2.to, r2.sib]).toEqual([4, 4, []]) // idempotent: nothing appended
    appendFileSync(join(sd, `${SID}.jsonl`), 'two\n')
    const r3 = copySessionForHandoff(from!, to!, cwd, SID)
    expect([r3.from, r3.to]).toEqual([4, 8])
    writeFileSync(join(sd, `${SID}.jsonl`), 'zzz\n')
    const r4 = copySessionForHandoff(from!, to!, cwd, SID, () => 1)
    expect([r4.from, r4.to, r4.replaced]).toEqual([0, 4, true])
  })
})

describe('reset parsing', () => {
  const ref = Date.parse('2026-10-09T04:17:00Z') // 23:17 on 10-08 in Bogota (UTC-5, no DST)
  it('time only: next occurrence after the line, with day rollover', () => {
    expect(parseResetAt('1:10am (America/Bogota)', ref)).toBe(Date.parse('2026-10-09T06:10:00Z'))
    expect(parseResetAt('11:30pm (America/Bogota)', ref)).toBe(Date.parse('2026-10-09T04:30:00Z')) // same local day
    expect(parseResetAt('11pm (America/Bogota)', ref)).toBe(Date.parse('2026-10-10T04:00:00Z')) // already passed -> tomorrow
    expect(parseResetAt('12am (UTC)', ref)).toBe(Date.parse('2026-10-10T00:00:00Z'))
    expect(parseResetAt('12pm (UTC)', ref)).toBe(Date.parse('2026-10-09T12:00:00Z'))
  })
  it('date form, year rollover, DST zone', () => {
    expect(parseResetAt('Oct 30, 9am (America/Bogota)', ref)).toBe(Date.parse('2026-10-30T14:00:00Z'))
    expect(parseResetAt('Jan 2, 9:30am (UTC)', ref)).toBe(Date.parse('2027-01-02T09:30:00Z'))
    expect(parseResetAt('Nov 5, 9am (America/New_York)', ref)).toBe(Date.parse('2026-11-05T14:00:00Z')) // EST after DST ends
    expect(parseResetAt('Oct 20, 9am (America/New_York)', ref)).toBe(Date.parse('2026-10-20T13:00:00Z')) // EDT
  })
  it('tolerates unknown formats', () => {
    for (const t of ['soon', '1:10am', '1:10am (Not/AZone)', '13pm (UTC)', 'Foo 3, 9am (UTC)', '9:75am (UTC)']) expect(parseResetAt(t, ref)).toBeNull()
  })
  it('parses limit text and lines', () => {
    expect(parseLimitText("You've hit your weekly limit · resets Oct 12, 3pm (UTC)", ref)).toEqual({ kind: 'weekly', resetText: 'Oct 12, 3pm (UTC)', resetAt: Date.parse('2026-10-12T15:00:00Z') })
    expect(parseLimitText('hello', ref)).toBeNull()
    const ok = JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T04:17:00Z', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ text: "You've hit your session limit · resets 1:10am (America/Bogota)" }] } })
    expect(parseLimitLine(ok)).toMatchObject({ kind: 'session', ts: ref, resetAt: Date.parse('2026-10-09T06:10:00Z') })
    expect(parseLimitLine(ok.replace('"rate_limit"', '"other_rate_limit"'))).toBeNull()
    expect(parseLimitLine('{"rate_limit"')).toBeNull()
    expect(parseLimitLine(JSON.stringify({ type: 'assistant', timestamp: 'x', error: 'rate_limit' }))).toBeNull()
  })
  it('scheduleAt fires once at the time, can be cancelled, ignores the past', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    scheduleAt(2000, fn, 1000)
    scheduleAt(500, fn, 1000)
    scheduleAt(5000, fn, 1000)()
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

describe('tail + watchLimits', () => {
  const lim = (t: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T04:17:00Z', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ text: `You've hit your session limit · resets ${t}` }] } }) + '\n'
  it('reads only appended complete lines, survives a late file and truncation', () => {
    const f = join(tmp(), 'late.jsonl')
    const got: string[] = []
    const t = tailFile(f, (l) => got.push(...l))
    t.check() // file does not exist yet
    writeFileSync(f, 'a\npart')
    t.check()
    expect(got).toEqual(['a'])
    appendFileSync(f, 'ial\nb\n')
    t.check()
    expect(got).toEqual(['a', 'partial', 'b'])
    writeFileSync(f, 'c\n') // truncated and rewritten
    t.check()
    expect(got.at(-1)).toBe('c')
    t.stop()
  })
  it('starts at the current end (old limit lines do not fire) and collapses repeats', () => {
    const f = join(tmp(), 's.jsonl')
    writeFileSync(f, lim('1:10am (UTC)'))
    const hits: string[] = []
    const w = watchLimits(f, (h) => hits.push(h.resetText))
    w.check()
    expect(hits).toEqual([])
    appendFileSync(f, 'noise\n' + lim('1:10am (UTC)') + lim('1:10am (UTC)'))
    w.check()
    expect(hits).toEqual(['1:10am (UTC)'])
    appendFileSync(f, lim('2:00am (UTC)'))
    w.check()
    expect(hits).toEqual(['1:10am (UTC)', '2:00am (UTC)'])
    w.stop()
  })
})

describe('prefs', () => {
  it('defaults, merges only known booleans, tolerates garbage', () => {
    const h = tmp()
    const hd = { autoContinue: true, message: 'Continúa exactamente donde lo dejaste.' }
    const ud = { statusLine: true, warnAt: 90 }
    expect(loadPrefs(h)).toEqual({ notifications: { system: true, sound: true }, handoff: hd, usage: ud })
    expect(savePrefs(h, { notifications: { sound: false, evil: 1, system: 'x' } })).toEqual({ notifications: { system: true, sound: false }, handoff: hd, usage: ud })
    expect(loadPrefs(h).notifications.sound).toBe(false)
    expect(savePrefs(h, null).notifications.sound).toBe(false)
    writeFileSync(join(h, 'prefs.json'), 'nope')
    expect(loadPrefs(h).notifications.system).toBe(true)
  })
})

describe('handoff prefs and resume args', () => {
  it('validates and persists the auto-continue message', () => {
    const h = tmp()
    expect(savePrefs(h, { handoff: { autoContinue: false, message: '  sigue ya  ' } }).handoff).toEqual({ autoContinue: false, message: 'sigue ya' })
    expect(loadPrefs(h).handoff.message).toBe('sigue ya')
    for (const bad of ['', '   ', 'x'.repeat(501), 'a\nb', 'a\u0000b', '--model x', 'update', 'install', 'doctor', 'Mcp-Add', 5, null]) expect(() => savePrefs(h, { handoff: { message: bad } })).toThrow(/Mensaje/)
    expect(loadPrefs(h).handoff.message).toBe('sigue ya')
    expect(() => savePrefs(h, { handoff: 'x' })).not.toThrow() // non-object patch is ignored, not a TypeError from `in`
    expect(savePrefs(h, { handoff: { message: 'sigue ya otra vez' } }).handoff.message).toBe('sigue ya otra vez')
    expect(savePrefs(h, { handoff: { message: 'Continúa' } }).handoff.message).toBe('Continúa')
    writeFileSync(join(h, 'prefs.json'), JSON.stringify({ handoff: { autoContinue: 'x', message: '-bad' } }))
    expect(loadPrefs(h).handoff).toEqual({ autoContinue: true, message: 'Continúa exactamente donde lo dejaste.' })
  })
  it('builds argv provider-aware, message as one element', () => {
    const id = '11111111-1111-1111-1111-111111111111'
    expect(providers.claude.resumeArgs(id)).toEqual(['--resume', id])
    expect(providers.claude.resumeArgs(id, 'a b; rm -rf /')).toEqual(['--resume', id, 'a b; rm -rf /'])
    expect(providers.codex.resumePrompt).toBe(true)
    expect(providers.codex.resumeArgs(id)).toEqual(['resume', id])
    expect(providers.codex.resumeArgs(id, 'a b; rm -rf /')).toEqual(['resume', id, 'a b; rm -rf /'])
    expect(providers.codex.assignsId).toBe(false)
    expect(providers.codex.statusArgs).toEqual(['login', 'status'])
  })
})

describe('import under managed accounts (realpath)', () => {
  it('refuses symlinks into <home>/accounts', () => {
    const h = tmp()
    mkdirSync(join(h, 'accounts', 'x'), { recursive: true })
    const link = join(tmp(), 'lnk')
    symlinkSync(join(h, 'accounts', 'x'), link)
    expect(() => checkNewAccount('l', 'claude', link, h)).toThrow(/managed/)
    expect(() => checkNewAccount('l', 'claude', join(h, 'accounts', 'new'), h)).toThrow(/managed/)
    expect(() => checkNewAccount('l', 'claude', tmp(), h)).not.toThrow()
  })
})

describe('F2 audit follow-ups', () => {
  const lim = (reset: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T04:17:00Z', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ text: `You've hit your session limit · resets ${reset}` }] } }) + '\n'
  it('tail survives an unreadable file and retries without losing lines', () => {
    const f = join(tmp(), 'u.jsonl')
    writeFileSync(f, '')
    const got: string[] = []
    const t = tailFile(f, (l) => got.push(...l))
    appendFileSync(f, 'a\n')
    chmodSync(f, 0)
    expect(() => t.check()).not.toThrow()
    chmodSync(f, 0o600)
    t.check()
    expect(got).toEqual(['a'])
    t.stop()
  })
  it('collapses repeats by resetAt (any text), or by text within 5 minutes when unparsed', () => {
    const f = join(tmp(), 'c.jsonl')
    writeFileSync(f, '')
    let now = 0
    const hits: string[] = []
    const w = watchLimits(f, (h) => hits.push(h.resetText), () => now)
    appendFileSync(f, lim('1:10am (UTC)') + lim('1:10am  (UTC)'))
    w.check()
    expect(hits).toEqual(['1:10am (UTC)']) // same resetAt
    now = 10 * 3600_000 // hours later: still the same resetAt -> same limit
    appendFileSync(f, lim('1:10am (UTC)'))
    w.check()
    expect(hits.length).toBe(1)
    appendFileSync(f, lim('weird text') + lim('weird text'))
    w.check()
    expect(hits.length).toBe(2)
    now += 6 * 60_000
    appendFileSync(f, lim('weird text'))
    w.check()
    expect(hits.length).toBe(3) // unparsed: collapsed only within a short window
    w.stop()
  })
  it('watchNewSession reports only new, born-after, unclaimed names and stats each name once', () => {
    const d = tmp()
    const [OLD, OTHER, FRESH, FRESH2] = ['a', 'b', 'c', 'd'].map((c) => `${c.repeat(8)}-2222-3333-4444-555555555555`) as [string, string, string, string]
    writeFileSync(join(d, `${OLD}.jsonl`), 'x\n') // existing before the watcher: remembered, never reported
    const found: string[][] = []
    const w = watchNewSession(d, Date.now() - 1000, (id) => id === SID || id === OTHER, (ids) => found.push(ids))
    w.check()
    expect(found).toEqual([])
    for (const id of [SID, OTHER, FRESH]) writeFileSync(join(d, `${id}.jsonl`), 'x\n')
    writeFileSync(join(d, 'not-a-session.jsonl'), 'x')
    w.check()
    expect(found).toEqual([[FRESH]])
    w.check() // nothing new: names already seen are not looked at again
    expect(found).toEqual([[FRESH]])
    writeFileSync(join(d, `${FRESH2}.jsonl`), 'x\n')
    w.check()
    expect(found).toEqual([[FRESH], [FRESH2]])
    expect(() => watchNewSession(join(d, 'missing'), 0, () => false, () => undefined).check()).not.toThrow()
    const late = watchNewSession(d, Date.now() + 60_000, () => false, (ids) => found.push(ids)) // born before `since`
    writeFileSync(join(d, `${'e'.repeat(8)}-2222-3333-4444-555555555555.jsonl`), 'x\n')
    late.check()
    expect(found.length).toBe(2)
    w.stop()
    late.stop()
  })
  it('pickRebind: only a single candidate on the sole live pty rebinds, anything ambiguous is stale', () => {
    expect(pickRebind([], 1)).toBeNull()
    expect(pickRebind(['x'], 1)).toEqual({ id: 'x' })
    expect(pickRebind(['x'], 2)).toBe('stale') // another live tab on the same account+project
    expect(pickRebind(['x', 'y'], 1)).toBe('stale')
  })
  it('validates reminder times', () => {
    expect(checkReminder(2000, 1000)).toBe(2000)
    for (const bad of [1000, 500, NaN, Infinity, '5', null, 1000 + 9 * 86400_000]) expect(() => checkReminder(bad, 1000)).toThrow(/resetAt/)
  })
  it('prunes copy records of removed accounts and missing transcripts', () => {
    const home = tmp()
    const a = addAccount(home, 'a', 'claude', tmp())
    const keep = SID
    const gone = 'ffffffff-2222-3333-4444-555555555555'
    mkdirSync(join(a.configDir, 'projects', 'p'), { recursive: true })
    writeFileSync(join(a.configDir, 'projects', 'p', `${keep}.jsonl`), 'x\n')
    for (const id of [keep, gone]) recordCopy(home, a.id, id, { from: 0, to: 1, replaced: false, sib: [] })
    recordCopy(home, 'ghost', keep, { from: 0, to: 1, replaced: false, sib: [] })
    pruneCopies(home)
    expect(Object.keys(loadCopies(home))).toEqual([a.id])
    expect(Object.keys(loadCopies(home)[a.id]!)).toEqual([keep])
  })
})
