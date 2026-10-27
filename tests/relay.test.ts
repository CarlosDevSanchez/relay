import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEnv } from '../src/main/env'
import { copySessionForHandoff } from '../src/main/handoff'
import { claudeProjectDir, encodeCwd } from '../src/main/paths'
import { listSessions, sessionTitle } from '../src/main/sessions'
import { addAccount, addProject, loadAccounts, loadProjects } from '../src/main/store'

const tmp = () => mkdtempSync(join(tmpdir(), 'relay-'))
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
    addProject(home, '/p')
    expect(addProject(home, '/p')).toEqual(['/p'])
    expect(loadProjects(home)).toEqual(['/p'])
    expect(loadAccounts(tmp())).toEqual([])
  })
})

describe('env', () => {
  it('sets the config dir per provider and strips credentials', () => {
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'x', FOO: '1' }
    const e = buildEnv({ id: '1', label: 'a', provider: 'claude', configDir: '/c' }, base)
    expect(e.CLAUDE_CONFIG_DIR).toBe('/c')
    expect(e.ANTHROPIC_API_KEY).toBeUndefined()
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
    for (const [acc, id, t] of [[a!, 's1', 100], [b!, 's2', 200]] as const) {
      const d = claudeProjectDir(acc.configDir, cwd)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, `${id}.jsonl`), fixture)
      utimesSync(join(d, `${id}.jsonl`), t, t)
    }
    const r = listSessions([a!, b!, { id: 'x', label: 'cx', provider: 'codex', configDir: tmp() }], cwd)
    expect(r.map((s) => [s.id, s.accountId])).toEqual([['s2', 'a1'], ['s1', 'a0']])
    expect(listSessions([a!], '/nope')).toEqual([])
  })
})

describe('handoff', () => {
  const setup = () => {
    const cwd = '/work/proj'
    const [from, to] = [tmp(), tmp()].map((configDir, i) => ({ id: `a${i}`, label: `A${i}`, provider: 'claude' as const, configDir }))
    const src = join(claudeProjectDir(from!.configDir, cwd), 's.jsonl')
    const dst = join(claudeProjectDir(to!.configDir, cwd), 's.jsonl')
    mkdirSync(join(src, '..'), { recursive: true })
    writeFileSync(src, 'one\n')
    return { cwd, from: from!, to: to!, src, dst }
  }
  it('copies, is idempotent, appends the tail on ping-pong, never overwrites different content', () => {
    const { cwd, from, to, src, dst } = setup()
    copySessionForHandoff(from, to, cwd, 's')
    expect(readFileSync(dst, 'utf8')).toBe('one\n')
    copySessionForHandoff(from, to, cwd, 's')
    writeFileSync(src, 'one\ntwo\n')
    copySessionForHandoff(from, to, cwd, 's')
    expect(readFileSync(dst, 'utf8')).toBe('one\ntwo\n')
    writeFileSync(dst, 'other\n')
    expect(() => copySessionForHandoff(from, to, cwd, 's')).toThrow(/refusing/)
    expect(readFileSync(dst, 'utf8')).toBe('other\n')
  })
  it('keeps a newer target untouched and rejects missing source / codex', () => {
    const { cwd, from, to, dst } = setup()
    copySessionForHandoff(from, to, cwd, 's')
    writeFileSync(dst, 'one\nnewer\n')
    copySessionForHandoff(from, to, cwd, 's')
    expect(readFileSync(dst, 'utf8')).toBe('one\nnewer\n')
    expect(() => copySessionForHandoff(from, to, cwd, 'missing')).toThrow(/no transcript/)
    expect(() => copySessionForHandoff({ ...from, provider: 'codex' }, to, cwd, 's')).toThrow(/Claude/)
  })
})
