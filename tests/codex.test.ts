import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findRollout, isTopLevel, listCodexSessions, parseCodexLimitLine, parseCodexReset, rolloutFiles, rolloutMeta, rolloutTitle, scanCodexLimit, watchCodexNewSession } from '../src/main/codex'
import { buildEnv, plainEnv } from '../src/main/env'
import { copySessionForHandoff, sourceExists } from '../src/main/handoff'
import { watchLimits } from '../src/main/limit'
import { candidateDirs, canProbe, dirProvider, isDefaultInstall } from '../src/main/paths'
import { drifted, linkAccount, sharedDir, unlinkAccount } from '../src/main/shared'
import { addAccount, loadCopies, pruneCopies, recordCopy } from '../src/main/store'
import { listSessions } from '../src/main/sessions'
import { accountStatus } from '../src/main/usage'
import { checkHandoff, checkSharedToggle, checkStart, isSessionId } from '../src/main/validate'
import { CROSS_PROVIDER, type Account } from '../src/shared/types'
import { guessProvider, suggestLabel } from '../src/renderer/status'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'relay-cx-')))
const ID = '01a17ead-fb85-70f3-a4bb-fc55b4d89fa9'
const ID2 = '01a17eae-0000-7000-8000-000000000002'
const line = (o: object) => JSON.stringify(o) + '\n'
const p2 = (n: number) => String(n).padStart(2, '0')

/** Rollout in the layout `codex-cli 0.164.0` writes (docs/spikes/F5.md): sessions/YYYY/MM/DD/rollout-<local ts>-<id>.jsonl */
function rollout(home: string, id: string, o: { cwd?: string; user?: string | null; at?: Date; legacy?: boolean; extra?: string; meta?: object } = {}): string {
  const d = o.at ?? new Date()
  const dir = join(home, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}-${id}.jsonl`)
  const ts = d.toISOString()
  let body =
    line({ timestamp: ts, type: 'session_meta', payload: { id, cwd: o.cwd ?? '/work/proj', originator: 'codex-tui', source: 'vscode', thread_source: 'user', ...o.meta, base_instructions: { text: 'x'.repeat(30_000) } } }) +
    line({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>' }] } }) +
    line({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/proj\n\n<INSTRUCTIONS>' }] } })
  if (o.user !== null) {
    const text = o.user ?? 'fix the   login bug'
    body += o.legacy
      ? line({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: text } })
      : line({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } })
  }
  writeFileSync(path, body + (o.extra ?? ''))
  return path
}
const usage = (ts: Date) => line({ timestamp: ts.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 15 } }, rate_limits: null } })
const MSG = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Dec 31st, 2029 7:00 PM.'
const limit = (ts: Date, message = MSG, shape: 'task_complete' | 'error' = 'task_complete') =>
  line({ timestamp: ts.toISOString(), type: 'event_msg', payload: shape === 'task_complete' ? { type: 'task_complete', last_agent_message: null, error: { message, codex_error_info: 'usage_limit_exceeded' } } : { type: 'error', message, codex_error_info: 'usage_limit_exceeded' } })
const acct = (configDir: string, id = 'c1'): Account => ({ id, label: id, provider: 'codex', configDir })

describe('codex rollouts', () => {
  it('finds rollouts by id and ignores junk, symlinks and bad ids', () => {
    const h = tmp()
    const f = rollout(h, ID)
    const d = join(f, '..')
    writeFileSync(join(d, 'notes.jsonl'), '')
    writeFileSync(join(d, `rollout-2026-01-01T00-00-00-${ID2}.jsonl.relay-bak-1`), '')
    symlinkSync(f, join(d, `rollout-2026-01-01T00-00-00-${ID2}.jsonl`))
    mkdirSync(join(h, 'sessions', 'abc', '01', '01'), { recursive: true })
    expect(rolloutFiles(h).map((x) => x.id)).toEqual([ID])
    expect(findRollout(h, ID)).toBe(f)
    expect(findRollout(h, ID.toUpperCase())).toBe(f)
    expect(findRollout(h, ID2)).toBeUndefined()
    expect(findRollout(h, '../../etc/passwd')).toBeUndefined()
    expect(rolloutFiles(join(h, 'missing'))).toEqual([])
  })

  it('reads cwd and the first real user message (not the AGENTS.md wrapper), long first line included', () => {
    const h = tmp()
    const lines = readFileSync(rollout(h, ID), 'utf8').split('\n')
    expect(rolloutMeta(lines)).toMatchObject({ id: ID, cwd: '/work/proj', originator: 'codex-tui', source: 'vscode' })
    expect(rolloutTitle(lines)).toBe('fix the login bug')
    expect(rolloutTitle(readFileSync(rollout(h, ID2, { legacy: true, user: 'legacy   prompt' }), 'utf8').split('\n'))).toBe('legacy prompt')
    expect(rolloutTitle(readFileSync(rollout(h, '01a17eaf-0000-7000-8000-000000000003', { user: null }), 'utf8').split('\n'))).toBe('(untitled)')
    expect(rolloutMeta([])).toBeUndefined()
    expect(rolloutMeta(['{"type":"event_msg"}'])).toBeUndefined()
    expect(rolloutMeta(['not json'])).toBeUndefined()
    expect(rolloutTitle(['{bad', line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '   ' }] } } })])).toBe('(untitled)')
  })

  it('long session_meta (over 64 KB) is still read', () => {
    const h = tmp()
    const p = rollout(h, ID, { cwd: '/work/proj' })
    const l = readFileSync(p, 'utf8').split('\n')
    const d = JSON.parse(l[0]!)
    d.payload.base_instructions.text = 'x'.repeat(100_000)
    l[0] = JSON.stringify(d)
    writeFileSync(p, l.join('\n'))
    expect(listCodexSessions([acct(h)], '/work/proj')).toHaveLength(1)
  })
  it('does not list sub-agent / child rollouts of the project, and reads only the head of unrelated ones', () => {
    const h = tmp()
    const proj = tmp()
    const a = acct(h)
    rollout(h, ID, { cwd: proj, user: 'parent task' })
    rollout(h, ID2, { cwd: proj, user: 'child task', meta: { source: { subagent: { thread_spawn: { parent_thread_id: ID } } }, thread_source: 'subagent', parent_thread_id: ID, forked_from_id: ID } })
    expect(listCodexSessions([a], proj).map((s) => s.title)).toEqual(['parent task'])
    expect(isTopLevel(rolloutMeta([JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: '/x', source: 'cli' } })])!)).toBe(true)
    expect(isTopLevel(rolloutMeta([JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: '/x', source: { subagent: 'review' } } })])!)).toBe(false)
  })
  it('lists sessions of a project by recorded cwd, newest copy per id, picks up changes', () => {
    const a = acct(tmp(), 'a')
    const b = acct(tmp(), 'b')
    const proj = tmp()
    const f1 = rollout(a.configDir, ID, { cwd: proj, user: 'first' })
    const f2 = rollout(a.configDir, ID2, { cwd: '/elsewhere' })
    const f3 = rollout(b.configDir, ID, { cwd: proj, user: 'first' })
    utimesSync(f1, 100, 100)
    utimesSync(f2, 100, 100)
    utimesSync(f3, 200, 200)
    expect(listSessions([a, b, { ...a, id: 'cl', provider: 'claude' }], proj).map((s) => [s.id, s.accountId, s.title, s.mtimeMs])).toEqual([[ID, 'b', 'first', 200_000]])
    expect(listCodexSessions([a], proj).map((s) => s.accountId)).toEqual(['a'])
    // the title is re-read when the file changes
    writeFileSync(f1, readFileSync(f1, 'utf8').replace('first', 'second'))
    utimesSync(f1, 300, 300)
    expect(listCodexSessions([a], proj)[0]!.title).toBe('second')
    // a project reached through a symlink still matches
    const alias = join(tmp(), 'alias')
    symlinkSync(proj, alias)
    expect(listCodexSessions([a], alias)).toHaveLength(1)
    expect(listCodexSessions([a], '/nope')).toEqual([])
    unlinkSync(f1)
    expect(listCodexSessions([a], proj)).toEqual([])
  })
})

describe('codex usage limit', () => {
  it('parses the reset time (local) and tolerates other formats', () => {
    expect(parseCodexReset('Dec 31st, 2029 7:00 PM')).toBe(new Date(2029, 11, 31, 19, 0).getTime())
    expect(parseCodexReset('Jan 2, 2030 9:05 AM')).toBe(new Date(2030, 0, 2, 9, 5).getTime())
    expect(parseCodexReset('Mar 3rd, 2030 12:00 PM')).toBe(new Date(2030, 2, 3, 12, 0).getTime())
    expect(parseCodexReset('someday')).toBeNull()
  })

  it('parses the same-day format (clock only) relative to the line timestamp, tomorrow when already past', () => {
    const now = new Date(2026, 9, 27, 14, 0).getTime()
    expect(parseCodexReset('3:15 PM', now)).toBe(new Date(2026, 9, 27, 15, 15).getTime())
    expect(parseCodexReset('12:05 AM', now)).toBe(new Date(2026, 9, 28, 0, 5).getTime()) // already past today
    expect(parseCodexReset('12:30 PM', now)).toBe(new Date(2026, 9, 28, 12, 30).getTime())
    expect(parseCodexReset('11:59 pm', now)).toBe(new Date(2026, 9, 27, 23, 59).getTime())
    expect(parseCodexReset('Oct 28 at 3:15 PM', now)).toBe(new Date(2026, 9, 28, 15, 15).getTime())
    expect(parseCodexReset('Oct 1 9:00 AM', now)).toBe(new Date(2027, 9, 1, 9, 0).getTime()) // already past: next year
    expect(parseCodexReset('13:00 PM', now)).toBeNull()
    expect(parseCodexReset('3:75 PM', now)).toBeNull()
  })

  it('a limit line with a same-day reset is parsed; "Try again later." has no reset; a model-specific limit is flagged', () => {
    const ts = new Date(2026, 9, 27, 14, 0)
    const today = parseCodexLimitLine(limit(ts, 'You’ve hit your usage limit. Upgrade to Pro or try again at 3:15 PM.'))
    expect(today).toMatchObject({ resetText: '3:15 PM', resetAt: new Date(2026, 9, 27, 15, 15).getTime() })
    expect(today!.modelSpecific).toBeUndefined()
    const later = parseCodexLimitLine(limit(ts, 'You’ve hit your usage limit. Try again later.'))
    expect(later).toMatchObject({ resetAt: null, resetText: 'a una hora desconocida' })
    expect(later!.modelSpecific).toBeUndefined()
    const model = parseCodexLimitLine(limit(ts, 'You’ve hit your usage limit for gpt-5.1-codex. Switch to another model now.'))
    expect(model).toMatchObject({ resetAt: null, modelSpecific: true })
  })

  it('recognises the usage_limit_exceeded event (task_complete.error and error) and nothing else', () => {
    const ts = new Date('2026-10-27T18:46:35Z')
    const a = parseCodexLimitLine(limit(ts))
    expect(a).toMatchObject({ kind: 'usage', ts: ts.getTime(), resetAt: new Date(2029, 11, 31, 19, 0).getTime() })
    expect(a!.resetText).toBe('Dec 31st, 2029 7:00 PM')
    expect(parseCodexLimitLine(limit(ts, MSG, 'error'))).toMatchObject({ kind: 'usage' })
    expect(parseCodexLimitLine(limit(ts, 'You hit your usage limit.'))).toMatchObject({ resetAt: null, resetText: 'a una hora desconocida' })
    // other errors and mentions are not a quota
    expect(parseCodexLimitLine(line({ timestamp: ts.toISOString(), type: 'event_msg', payload: { type: 'task_complete', error: { message: 'try again in 5s', codex_error_info: 'rate_limit_exceeded' } } }))).toBeNull()
    expect(parseCodexLimitLine(line({ timestamp: ts.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is usage_limit_exceeded?' }] } }))).toBeNull()
    expect(parseCodexLimitLine(line({ type: 'event_msg', payload: { error: { codex_error_info: 'usage_limit_exceeded' } } }))).toBeNull() // no timestamp
    expect(parseCodexLimitLine('usage_limit_exceeded {not json')).toBeNull()
  })

  const now = new Date('2026-10-27T18:50:00Z').getTime()
  const at = (m: number) => new Date(now + m * 60000)
  const msgAt = (t: Date) => `try again at ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t).replace(' at ', ' ').replace(/(\d), (\d{4})/, '$1, $2')}.`

  it('card status: limited until the reset, cleared by a later response, ignores copied lines and old files', () => {
    const h = tmp()
    const reset = at(60)
    const f = rollout(h, ID, { extra: usage(at(-30)) + limit(at(-10), msgAt(reset)) })
    expect(scanCodexLimit(h, now)).toMatchObject({ kind: 'usage', resetAt: reset.getTime() - (reset.getTime() % 60000) })
    expect(scanCodexLimit(h, reset.getTime() + 120_000)).toBeUndefined() // reset passed
    appendFileSync(f, usage(at(-5))) // a later successful response
    expect(scanCodexLimit(h, now)).toBeUndefined()
    // copied-in lines belong to another account
    const g = tmp()
    const base = rollout(g, ID2, { extra: '' })
    const start = readFileSync(base).length
    appendFileSync(base, limit(at(-10), msgAt(reset)))
    expect(scanCodexLimit(g, now)).toBeDefined()
    const rec = { ranges: [[start, readFileSync(base).length]] as [number, number][], sib: [] }
    expect(scanCodexLimit(g, now, { [ID2]: rec })).toBeUndefined()
    // a file untouched for more than 7 days is not considered
    utimesSync(base, 1, 1)
    expect(scanCodexLimit(g, now)).toBeUndefined()
    expect(scanCodexLimit(join(g, 'none'), now)).toBeUndefined()
  })

  it('reads only the tail of long transcripts', () => {
    const h = tmp()
    const pad = line({ timestamp: at(-100).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(400_000) }] } })
    rollout(h, ID, { extra: pad + limit(at(-10), msgAt(at(60))) })
    expect(scanCodexLimit(h, now)).toBeDefined()
  })

  it('live tail with the Codex parser reports the event once', () => {
    vi.useFakeTimers()
    try {
      const h = tmp()
      const f = rollout(h, ID)
      const hits: unknown[] = []
      const w = watchLimits(f, (x) => hits.push(x), Date.now, parseCodexLimitLine)
      appendFileSync(f, limit(new Date(), MSG))
      appendFileSync(f, line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'ok' } }))
      w.check()
      w.stop()
      expect(hits).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('codex new session discovery', () => {
  afterEach(() => vi.useRealTimers())
  it('reports a new rollout of the cwd, retries until line 1 exists, skips other cwds and claimed ids', () => {
    const h = tmp()
    const proj = tmp()
    rollout(h, ID, { cwd: proj }) // existing before the watcher starts
    const found: string[][] = []
    const w = watchCodexNewSession(h, proj, Date.now() - 1000, (id) => id === '01a17eaf-0000-7000-8000-000000000003', (ids) => found.push(ids))
    w.check()
    expect(found).toEqual([])
    const half = rollout(h, ID2, { cwd: proj })
    const full = readFileSync(half)
    writeFileSync(half, '') // created, line 1 not written yet
    w.check()
    expect(found).toEqual([])
    writeFileSync(half, full)
    w.check()
    expect(found).toEqual([[ID2]])
    w.check()
    expect(found).toHaveLength(1) // reported once
    rollout(h, '01a17eaf-0000-7000-8000-000000000004', { cwd: '/other' })
    rollout(h, '01a17eaf-0000-7000-8000-000000000003', { cwd: proj }) // claimed by another tab
    w.check()
    expect(found).toHaveLength(1)
    w.stop()
    expect(watchCodexNewSession(join(h, 'none'), proj, 0, () => false, () => undefined).stop()).toBeUndefined()
  })
  it('ignores sub-agent, exec and IDE rollouts of the same cwd (only the top-level TUI thread binds the tab)', () => {
    const h = tmp()
    const proj = tmp()
    const found: string[][] = []
    const w = watchCodexNewSession(h, proj, Date.now() - 1000, () => false, (ids) => found.push(ids))
    const sub = { subagent: { thread_spawn: { parent_thread_id: ID, depth: 1, agent_nickname: 'x' } } }
    rollout(h, '01a17eaf-0000-7000-8000-0000000000a1', { cwd: proj, meta: { source: sub, thread_source: 'subagent', parent_thread_id: ID } })
    rollout(h, '01a17eaf-0000-7000-8000-0000000000a2', { cwd: proj, meta: { source: { subagent: 'review' } } })
    rollout(h, '01a17eaf-0000-7000-8000-0000000000a3', { cwd: proj, meta: { parent_thread_id: ID } })
    rollout(h, '01a17eaf-0000-7000-8000-0000000000a4', { cwd: proj, meta: { originator: 'codex_exec', source: 'exec' } })
    rollout(h, '01a17eaf-0000-7000-8000-0000000000a5', { cwd: proj, meta: { originator: 'codex_vscode', source: 'vscode' } })
    rollout(h, '01a17eaf-0000-7000-8000-0000000000a6', { cwd: proj, meta: { source: undefined } }) // very old Codex: no source
    w.check()
    expect(found).toEqual([])
    rollout(h, ID2, { cwd: proj }) // real TUI shape (codex-tui + source vscode + thread_source user) binds
    w.check()
    expect(found).toEqual([[ID2]])
    w.stop()
  })
  it('only considers files born after the watcher asked for them', () => {
    const h = tmp()
    const proj = tmp()
    const found: string[][] = []
    const w = watchCodexNewSession(h, proj, Date.now() + 60_000, () => false, (ids) => found.push(ids))
    rollout(h, ID, { cwd: proj })
    w.check()
    expect(found).toEqual([]) // born before `since`
    w.stop()
  })
})

describe('codex handoff', () => {
  const setup = () => {
    const [from, to] = [tmp(), tmp()].map((d, i) => acct(d, `c${i}`)) as [Account, Account]
    const src = rollout(from.configDir, ID, { extra: line({ n: 1 }) })
    return { from, to, src, dst: join(to.configDir, 'sessions', src.split('/sessions/')[1]!) }
  }
  it('copies the rollout to the same relative path, then appends the tail, never overwriting', () => {
    const x = setup()
    expect(sourceExists(x.from, '/work/proj', ID)).toBe(true)
    expect(sourceExists(x.to, '/work/proj', ID)).toBe(false)
    const r1 = copySessionForHandoff(x.from, x.to, '/work/proj', ID)
    expect(r1).toMatchObject({ dst: x.dst, from: 0, replaced: false, sib: [] })
    expect(readFileSync(x.dst, 'utf8')).toBe(readFileSync(x.src, 'utf8'))
    expect(findRollout(x.to.configDir, ID)).toBe(x.dst)
    // source grows (plus a partial last line): only the complete tail is appended
    appendFileSync(x.src, line({ n: 2 }) + '{"partial')
    const before = readFileSync(x.dst).length
    const r2 = copySessionForHandoff(x.from, x.to, '/work/proj', ID)
    expect(r2.from).toBe(before)
    expect(readFileSync(x.dst, 'utf8').endsWith(line({ n: 2 }))).toBe(true)
    // target moved on (newer): kept as is
    appendFileSync(x.dst, line({ n: 3 }))
    const r3 = copySessionForHandoff(x.from, x.to, '/work/proj', ID)
    expect(r3.from).toBe(r3.to)
    expect(readFileSync(x.dst, 'utf8').endsWith(line({ n: 3 }))).toBe(true)
  })
  it('backs up a diverged target, reuses an existing rollout path for the id, and refuses links and strangers', () => {
    const x = setup()
    const other = rollout(x.to.configDir, ID, { at: new Date(2020, 0, 5, 1, 2, 3), user: 'diverged' }) // same id, other date dir
    const r = copySessionForHandoff(x.from, x.to, '/work/proj', ID, () => 42)
    expect(r.dst).toBe(other)
    expect(r.replaced).toBe(true)
    expect(readFileSync(`${other}.relay-bak-42`, 'utf8')).toContain('diverged')
    expect(readFileSync(other, 'utf8')).toBe(readFileSync(x.src, 'utf8'))
    expect(rolloutFiles(x.to.configDir)).toHaveLength(1) // the .relay-bak file is not a rollout
    expect(() => copySessionForHandoff(x.from, x.to, '/work/proj', '../x')).toThrow(/Invalid session id/)
    expect(() => copySessionForHandoff(x.from, x.to, '/work/proj', ID2)).toThrow(/no transcript/)
    expect(() => copySessionForHandoff(x.from, { ...x.to, provider: 'claude' }, '/work/proj', ID)).toThrow(CROSS_PROVIDER)
    const empty = acct(tmp(), 'e')
    writeFileSync(rollout(empty.configDir, ID2), JSON.stringify({ type: 'session_meta', payload: { id: ID2, cwd: '/work/proj', source: 'cli' } })) // no newline yet
    expect(() => copySessionForHandoff(empty, x.to, '/work/proj', ID2)).toThrow(/complete line/)
    // a target that is a symlink is refused
    const y = setup()
    mkdirSync(join(y.dst, '..'), { recursive: true })
    symlinkSync(y.src, y.dst)
    expect(findRollout(y.to.configDir, ID)).toBeUndefined()
    expect(() => copySessionForHandoff(y.from, y.to, '/work/proj', ID)).toThrow(/not a regular file/)
  })
  it('refuses a rollout recorded in another project or a sub-agent thread, and a target path with a symlinked component', () => {
    const x = setup()
    expect(sourceExists(x.from, '/other', ID)).toBe(false)
    expect(() => copySessionForHandoff(x.from, x.to, '/other', ID)).toThrow(/not recorded in this project/)
    const child = rollout(x.from.configDir, ID2, { meta: { source: { subagent: 'x' }, parent_thread_id: ID } })
    expect(child).toBeTruthy()
    expect(sourceExists(x.from, '/work/proj', ID2)).toBe(false)
    expect(() => copySessionForHandoff(x.from, x.to, '/work/proj', ID2)).toThrow(/sub-agent/)
    // sessions/ of the target is a link to elsewhere: nothing is written through it
    const away = tmp()
    symlinkSync(away, join(x.to.configDir, 'sessions'))
    expect(() => copySessionForHandoff(x.from, x.to, '/work/proj', ID)).toThrow(/link/)
    expect(readdirSync(away)).toEqual([])
  })
  it('copy tracking: recorded for the target, pruned with the rollout', () => {
    const home = tmp()
    const to = addAccount(home, 't', 'codex')
    const x = { from: acct(tmp(), 'f'), to }
    rollout(x.from.configDir, ID)
    const r = copySessionForHandoff(x.from, to, '/work/proj', ID)
    recordCopy(home, to.id, ID, r)
    expect(loadCopies(home)[to.id]![ID]!.ranges).toEqual([[0, r.to]])
    pruneCopies(home)
    expect(loadCopies(home)[to.id]![ID]).toBeDefined()
    unlinkSync(r.dst)
    pruneCopies(home)
    expect(loadCopies(home)).toEqual({})
  })
  it('validation: same-provider only, Codex ids and projects checked like Claude', () => {
    const [a, b] = [acct('/a', 'a'), acct('/b', 'b')]
    const c: Account = { id: 'c', label: 'c', provider: 'claude', configDir: '/c' }
    const req = (to: string) => ({ ptyId: 1, fromAccountId: 'a', toAccountId: to, cwd: '/p', sessionId: ID })
    expect(checkHandoff(req('b'), [a, b, c], ['/p']).map((x) => x.id)).toEqual(['a', 'b'])
    expect(() => checkHandoff(req('c'), [a, b, c], ['/p'])).toThrow(/Claude ↔ Codex llegará después del MVP/)
    expect(() => checkStart({ accountId: 'a', cwd: '/p', mode: 'resume', sessionId: 'x; rm' }, [a], ['/p'])).toThrow(/session id/)
  })
})

describe('codex account environment and status', () => {
  it('sets CODEX_HOME and strips parent credentials; ~/.codex is the default install', () => {
    const h = tmp()
    mkdirSync(join(h, '.codex'))
    const base = { PATH: '/bin', OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'k', CODEX_ACCESS_TOKEN: 't', CODEX_THREAD_ID: 'i', CODEX_HOME: '/parent', OPENAI_BASE_URL: 'https://example.test' }
    const e = buildEnv(acct('/managed'), base, h)
    expect(e.CODEX_HOME).toBe('/managed')
    for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_THREAD_ID']) expect(e[k]).toBeUndefined()
    expect(e.OPENAI_BASE_URL).toBe('https://example.test')
    expect(plainEnv(base).CODEX_HOME).toBeUndefined()
    expect(isDefaultInstall(join(h, '.codex'), h, 'codex')).toBe(true)
    expect(isDefaultInstall(join(h, '.codex'), h)).toBe(false)
    expect(isDefaultInstall(join(h, '.claude'), h, 'codex')).toBe(false)
  })
  it('login probe: exit 0 = logged in, exit 1 = not, anything else unknown; runs with CODEX_HOME and no secrets', async () => {
    const bin = tmp()
    const home = tmp()
    const stub = join(bin, 'codex')
    writeFileSync(stub, `#!/bin/bash\necho "$CODEX_HOME|$OPENAI_API_KEY|$*" >> "${join(bin, 'calls')}"\ncase "$STUB_EXIT" in 0) echo 'Logged in using ChatGPT';; 1) echo 'Not logged in' >&2;; esac\nexit \${STUB_EXIT:-0}\n`)
    chmodSync(stub, 0o755)
    const old = { ...process.env }
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.OPENAI_API_KEY = 'sk-secret'
    try {
      const a = acct(home, 'st')
      for (const [code, want] of [['0', true], ['1', false], ['2', null]] as const) {
        process.env.STUB_EXIT = code
        expect((await accountStatus(a, true)).loggedIn).toBe(want)
      }
      const s = await accountStatus(a, true)
      expect(s).toMatchObject({ accountId: 'st', tokens5h: 0 })
      expect(s.limited).toBeUndefined()
      expect(await accountStatus(a)).toBe(await accountStatus(a)) // cached
      expect(readFileSync(join(bin, 'calls'), 'utf8').split('\n')[0]).toBe(`${home}||login status`)
      rollout(home, ID, { extra: limit(new Date(), `try again at ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(Date.now() + 3600_000)).replace(' at ', ' ')}.`) })
      expect((await accountStatus(a, true)).limited).toMatchObject({ kind: 'usage' })
    } finally {
      process.env = old
    }
  })
})

describe('codex shared AGENTS.md', () => {
  it('links only AGENTS.md, seeds shared from the account, is idempotent, restores a real copy on unlink', () => {
    const home = tmp()
    const a = acct(tmp())
    writeFileSync(join(a.configDir, 'AGENTS.md'), 'my rules')
    writeFileSync(join(a.configDir, 'auth.json'), 'SECRET')
    mkdirSync(join(a.configDir, 'skills'))
    writeFileSync(join(a.configDir, 'config.toml'), 'model="x"')
    expect(drifted(home, a)).toEqual(['AGENTS.md'])
    const rep = linkAccount(home, a, ['/some/project'])
    expect(rep.errors).toEqual([])
    expect(rep.linked).toEqual(['AGENTS.md'])
    expect(lstatSync(join(a.configDir, 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(sharedDir(home), 'AGENTS.md'), 'utf8')).toBe('my rules')
    expect(existsSync(join(sharedDir(home), 'CLAUDE.md'))).toBe(false)
    expect(readFileSync(join(a.configDir, 'auth.json'), 'utf8')).toBe('SECRET')
    expect(readdirSync(a.configDir).sort()).toEqual(['AGENTS.md', 'auth.json', 'config.toml', 'skills'])
    expect(linkAccount(home, a, []).linked).toEqual([])
    expect(drifted(home, a)).toEqual([])
    // a second account shares the same file; its differing content is backed up
    const b = acct(tmp(), 'c2')
    writeFileSync(join(b.configDir, 'AGENTS.md'), 'other rules')
    const rb = linkAccount(home, b, [])
    expect(rb.backups).toHaveLength(1)
    expect(readFileSync(join(b.configDir, 'AGENTS.md'), 'utf8')).toBe('my rules')
    expect(unlinkAccount(home, b).errors).toEqual([])
    expect(lstatSync(join(b.configDir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(b.configDir, 'AGENTS.md'), 'utf8')).toBe('my rules')
    expect(readFileSync(join(sharedDir(home), 'AGENTS.md'), 'utf8')).toBe('my rules')
    expect(checkSharedToggle('c2', true, [b]).provider).toBe('codex')
  })
})

describe('imported dirs and ids', () => {
  it('probes a Codex home only when it already has config.toml or sessions/, never looking at auth.json', async () => {
    const h = tmp()
    const home = tmp()
    expect(canProbe(h, home, 'codex')).toBe(false)
    writeFileSync(join(h, 'auth.json'), '{}')
    expect(canProbe(h, home, 'codex')).toBe(false)
    mkdirSync(join(h, 'sessions'))
    expect(canProbe(h, home, 'codex')).toBe(true)
    const h2 = tmp()
    writeFileSync(join(h2, 'config.toml'), '')
    expect(canProbe(h2, home, 'codex')).toBe(true)
    const h3 = tmp()
    writeFileSync(join(h3, 'installation_id'), 'x')
    expect(canProbe(h3, home, 'codex')).toBe(true)
    const h4 = tmp()
    writeFileSync(join(h4, 'state_5.sqlite'), '')
    expect(canProbe(h4, home, 'codex')).toBe(true)
    // not asked => the CLI never runs
    const bin = tmp()
    const stub = join(bin, 'codex')
    writeFileSync(stub, `#!/bin/bash\necho run >> "${join(bin, 'calls')}"\n`)
    chmodSync(stub, 0o755)
    const old = process.env.PATH
    process.env.PATH = `${bin}:${old}`
    try {
      const s = await accountStatus(acct(tmp(), 'np'), true, {}, false)
      expect(s).toMatchObject({ loggedIn: null, unchecked: true })
      expect(existsSync(join(bin, 'calls'))).toBe(false)
    } finally {
      process.env.PATH = old
    }
  })
  it('lists ~/.codex* dirs as candidates with their provider', () => {
    const home = tmp()
    for (const d of ['.claude', '.claude-a', '.codex', '.codex-work', '.codexx', '.other']) mkdirSync(join(home, d))
    expect(candidateDirs(home, []).map((d) => d.slice(home.length + 1))).toEqual(['.claude', '.claude-a', '.codex', '.codex-work'])
    expect(dirProvider(join(home, '.codex'))).toBe('codex')
    expect(dirProvider(join(home, '.codex-work'))).toBe('codex')
    expect(dirProvider(join(home, '.claude-a'))).toBe('claude')
  })
  it('session ids are strict UUIDs (Claude v4 and Codex v7 pass)', () => {
    expect(isSessionId(ID)).toBe(true)
    expect(isSessionId('3f2a9c1e-5b7d-4e8a-9c0b-1a2b3c4d5e6f')).toBe(true)
    expect(isSessionId('-'.repeat(36))).toBe(false)
    expect(isSessionId('0'.repeat(36))).toBe(false)
    expect(isSessionId('01a17ead-fb85-70f3-a4bb-fc55b4d89fa9\n')).toBe(false)
  })
})

describe('renderer helpers', () => {
  it('guesses the provider and label from a dir name', () => {
    expect(guessProvider('/h/.codex')).toBe('codex')
    expect(guessProvider('/h/.codex-work')).toBe('codex')
    expect(guessProvider('/h/.codexa')).toBe('claude')
    expect(guessProvider('/h/.claude-mailo')).toBe('claude')
    expect(suggestLabel('/h/.codex-work')).toBe('work')
    expect(suggestLabel('/h/.codex')).toBe('Principal')
    expect(suggestLabel('/h/.claude-mailo')).toBe('mailo')
  })
})
