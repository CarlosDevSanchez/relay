import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Account, AccountUsage } from '../src/shared/types'
import { fmtReset, limitedFromUsage, liveWindows, usageLevel, warnText, windowTitle } from '../src/shared/usage'
import { parseCodexRates, scanCodexRates } from '../src/main/codex'
import { checkWarnAt, loadPrefs, savePrefs } from '../src/main/prefs'
import { providers } from '../src/main/providers'
import { STATUS_SCRIPT, claudeSettingsArgs, parseStatusJson, readUserStatusLine, statusEnv, statusScriptPath, trackUsage, writeStatusScript } from '../src/main/rates'
import { adoptable, forgetSession, loadRegistry, register, registerHandoff, touchSession, updateRegistry, visibleSessions } from '../src/main/registry'
import { checkSessionRef } from '../src/main/validate'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'relay-u-')))
const SID = '11111111-2222-3333-4444-555555555555'
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const sec = (ms: number) => Math.floor(ms / 1000)
const fixture = (five: number, seven: number, reset = NOW + 3600_000) =>
  JSON.stringify({ session_id: 'abc', model: { id: 'x' }, rate_limits: { five_hour: { used_percentage: five, resets_at: sec(reset) }, seven_day: { used_percentage: seven, resets_at: sec(reset + 86400_000) } } })

describe('shared usage helpers', () => {
  it('levels, titles and live windows', () => {
    expect(usageLevel(69, 90)).toBe('ok')
    expect(usageLevel(70, 90)).toBe('warning')
    expect(usageLevel(90, 90)).toBe('error')
    expect(windowTitle('5h')).toBe('Sesión 5h')
    expect(windowTitle('7d')).toBe('Semana')
    expect(windowTitle('2d')).toBe('2d')
    expect(liveWindows([{ id: '5h', pct: 1, resetsAt: NOW }, { id: '7d', pct: 1, resetsAt: NOW + 1 }], NOW).map((w) => w.id)).toEqual(['7d'])
  })
  it('formats reset times, the warning text and the 100% limited state', () => {
    const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime()
    const now = at(27, 9, 0)
    expect(fmtReset(at(27, 15, 10), now)).toBe('3:10pm')
    expect(fmtReset(at(27, 0, 5), now)).toBe('12:05am')
    expect(fmtReset(at(28, 15, 10), now)).toBe(`${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][new Date(at(28, 15, 10)).getDay()]} 3:10pm`)
    expect(fmtReset(at(3 + 31, 15, 10), now)).toMatch(/ \d+\/\d+ 3:10pm$/)
    expect(warnText('Alfa', { id: '5h', pct: 90.4, resetsAt: at(27, 15, 10) }, now)).toBe('Alfa lleva 90% de su sesión de 5h · se reinicia 3:10pm')
    expect(warnText('Alfa', { id: '7d', pct: 95, resetsAt: at(27, 15, 10) }, now)).toContain('de su semana')
    expect(warnText('Cx', { id: '2d', pct: 95, resetsAt: at(27, 15, 10) }, now)).toContain('ventana de 2d')
    expect(limitedFromUsage([{ id: '5h', pct: 99, resetsAt: now + 1000 }], now)).toBeUndefined()
    expect(limitedFromUsage([{ id: '5h', pct: 100, resetsAt: now - 1 }], now)).toBeUndefined()
    const l = limitedFromUsage([{ id: '5h', pct: 100, resetsAt: now + 1000 }, { id: '7d', pct: 100, resetsAt: now + 5000 }], now)
    expect(l).toMatchObject({ kind: 'weekly', resetAt: now + 5000 })
    expect(limitedFromUsage([{ id: '5h', pct: 100, resetsAt: now + 1000 }], now)?.kind).toBe('session')
  })
})

describe('status line JSON', () => {
  it('reads only the rate-limit windows and the session id, defensively', () => {
    const p = parseStatusJson(fixture(48.5, 31, NOW))!
    expect(p.sessionId).toBe('abc')
    expect(p.windows).toEqual([{ id: '5h', pct: 48.5, resetsAt: sec(NOW) * 1000 }, { id: '7d', pct: 31, resetsAt: sec(NOW + 86400_000) * 1000 }])
    expect(parseStatusJson(JSON.stringify({ cost: { total: 1 } }))).toEqual({ windows: [] })
    expect(parseStatusJson(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 'x', resets_at: 5 }, seven_day: { used_percentage: 150, resets_at: 5 } } }))!.windows).toEqual([{ id: '7d', pct: 100, resetsAt: 5000 }])
    expect(parseStatusJson('nope')).toBeUndefined()
    expect(parseStatusJson('null')).toBeUndefined()
    expect(parseStatusJson(JSON.stringify({ session_id: 's'.repeat(101) }))).toEqual({ windows: [] })
  })
})

describe('status line script', () => {
  const run = (json: string, env: Record<string, string>) => execFileSync('sh', [writeStatusScript(env.HOME_DIR as string)], { input: json, env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' })
  it('is written executable, with a private status dir', () => {
    const h = tmp()
    const f = writeStatusScript(h)
    expect(f).toBe(statusScriptPath(h))
    expect(readFileSync(f, 'utf8')).toBe(STATUS_SCRIPT)
    expect(statSync(f).mode & 0o777).toBe(0o755)
    expect(statSync(join(h, 'status')).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(h, 'bin'))).toEqual(['statusline.sh'])
  })
  it('saves the JSON atomically and prints the compact line', () => {
    const h = tmp()
    const file = join(h, 'status', 'acc.json')
    expect(run(fixture(48.2, 31.9), { HOME_DIR: h, RELAY_STATUS_FILE: file })).toBe('5h 48% · 7d 31%')
    expect(readFileSync(file, 'utf8')).toBe(fixture(48.2, 31.9))
    expect(readdirSync(join(h, 'status'))).toEqual(['acc.json']) // no temp file left
    expect(run(JSON.stringify({ rate_limits: { seven_day: { resets_at: 1, used_percentage: 7 } } }), { HOME_DIR: h, RELAY_STATUS_FILE: file })).toBe('7d 7%')
    expect(run('{"model":{}}', { HOME_DIR: h, RELAY_STATUS_FILE: file })).toBe('') // windows absent: nothing printed
    expect(run(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } }, null, 2), { HOME_DIR: h, RELAY_STATUS_FILE: file })).toBe('5h 5%') // pretty-printed input
  })
  it('works without a status file and chains the user status line with the same JSON', () => {
    const h = tmp()
    expect(run(fixture(1, 2), { HOME_DIR: h })).toBe('5h 1% · 7d 2%')
    const file = join(h, 'status', 'acc.json')
    const out = run(fixture(10, 20), { HOME_DIR: h, RELAY_STATUS_FILE: file, RELAY_USER_STATUSLINE: `printf 'mine:'; wc -c | tr -d ' '` })
    expect(out.trim()).toBe(`mine:${fixture(10, 20).length}`) // the user's command got the identical JSON on stdin and replaces the compact line
    expect(readFileSync(file, 'utf8')).toBe(fixture(10, 20))
  })
  it('builds --settings JSON with a quoted path and reads the user status line read-only', () => {
    const [flag, json] = claudeSettingsArgs("/a b/it's/statusline.sh")
    expect(flag).toBe('--settings')
    const cmd = JSON.parse(json as string).statusLine
    expect(cmd.type).toBe('command')
    expect(execFileSync('sh', ['-c', `printf %s ${cmd.command.replace(/statusline\.sh'$/, "x'")}`], { encoding: 'utf8' })).toBe("/a b/it's/x")
    const d = tmp()
    expect(readUserStatusLine(d)).toBeUndefined()
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }))
    expect(readUserStatusLine(d)).toBe('echo hi')
    for (const bad of [{ statusLine: { type: 'static', command: 'x' } }, { statusLine: { type: 'command', command: '  ' } }, { statusLine: { type: 'command', command: 5 } }, {}]) {
      writeFileSync(join(d, 'settings.json'), JSON.stringify(bad))
      expect(readUserStatusLine(d)).toBeUndefined()
    }
    writeFileSync(join(d, 'settings.json'), 'garbage')
    expect(readUserStatusLine(d)).toBeUndefined()
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }))
    const before = readFileSync(join(d, 'settings.json'), 'utf8')
    expect(statusEnv('/h', { id: 'abc', label: 'a', provider: 'claude', configDir: d })).toEqual({ RELAY_STATUS_FILE: '/h/status/abc.json', RELAY_USER_STATUSLINE: 'echo hi' })
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe(before)
    expect(statusEnv('/h', { id: 'abc', label: 'a', provider: 'claude', configDir: tmp() })).toEqual({ RELAY_STATUS_FILE: '/h/status/abc.json' })
  })
  it('argv: Relay flags come before the positional prompt', () => {
    expect(providers.claude.newArgs(SID, ['--settings', '{}'])).toEqual(['--session-id', SID, '--settings', '{}'])
    expect(providers.claude.resumeArgs(SID, 'go on', ['--settings', '{}'])).toEqual(['--resume', SID, '--settings', '{}', 'go on'])
    expect(providers.claude.resumeArgs(SID, undefined, ['--settings', '{}'])).toEqual(['--resume', SID, '--settings', '{}'])
  })
})

describe('usage prefs', () => {
  it('validates the threshold', () => {
    const h = tmp()
    expect(loadPrefs(h).usage).toEqual({ statusLine: true, warnAt: 90 })
    expect(savePrefs(h, { usage: { statusLine: false, warnAt: 75 } }).usage).toEqual({ statusLine: false, warnAt: 75 })
    for (const bad of [49, 101, 90.5, '90', null, NaN]) expect(() => savePrefs(h, { usage: { warnAt: bad } })).toThrow(/Umbral/)
    expect(() => checkWarnAt(50)).not.toThrow()
    expect(loadPrefs(h).usage).toEqual({ statusLine: false, warnAt: 75 })
    writeFileSync(join(h, 'prefs.json'), JSON.stringify({ usage: { statusLine: 'x', warnAt: 5 } }))
    expect(loadPrefs(h).usage).toEqual({ statusLine: true, warnAt: 90 })
  })
})

describe('usage tracker', () => {
  const acc = (id: string, provider: 'claude' | 'codex' = 'claude', configDir = '/nowhere'): Account => ({ id, label: `L${id}`, provider, configDir })
  const setup = (accounts: Account[], warnAt = 90) => {
    const h = tmp()
    mkdirSync(join(h, 'status'), { recursive: true })
    let now = NOW
    const emitted: AccountUsage[] = []
    const warns: string[] = []
    const mk = () => trackUsage(h, { accounts: () => accounts, warnAt: () => warnAt, emit: (u) => emitted.push(u), warn: (_a, t) => warns.push(t), now: () => now })
    return { h, emitted, warns, mk, tick: (ms: number) => (now += ms), put: (id: string, body: string) => writeFileSync(join(h, 'status', `${id}.json`), body) }
  }
  it('stores last-known windows, warns once per window and not for what was already high at startup', () => {
    const t = setup([acc('aa')])
    t.put('aa', fixture(95, 10))
    const tr = t.mk()
    expect(t.warns).toEqual([]) // seeded: already above at startup
    expect(tr.get()).toHaveLength(1)
    t.put('aa', fixture(96, 10))
    tr.scan()
    expect(t.warns).toEqual([]) // same window as the seeded one: never announced
    t.put('aa', fixture(40, 10, NOW + 2 * 3600_000))
    tr.scan()
    expect(t.warns).toEqual([])
    t.put('aa', fixture(91, 10, NOW + 2 * 3600_000))
    tr.scan()
    expect(t.warns).toHaveLength(1)
    expect(t.warns[0]).toMatch(/^Laa lleva 91% de su sesión de 5h · se reinicia /)
    t.put('aa', fixture(93, 10, NOW + 2 * 3600_000))
    tr.scan()
    expect(t.warns).toHaveLength(1) // same window: once
    t.put('aa', fixture(93, 10, NOW + 5 * 3600_000))
    tr.scan()
    expect(t.warns).toHaveLength(2) // a new window warns again
    tr.stop()
  })
  it('drops expired windows, ignores unknown / garbage / oversized files and unchanged ones', () => {
    const t = setup([acc('aa')])
    t.put('aa', fixture(50, 60, NOW + 1000))
    t.put('zz', fixture(99, 99)) // not an account
    const tr = t.mk()
    expect(tr.get()[0]!.windows.map((w) => w.id)).toEqual(['5h', '7d'])
    t.tick(2000)
    expect(tr.get()[0]!.windows.map((w) => w.id)).toEqual(['7d']) // 5h reset passed
    t.tick(86400_000)
    expect(tr.get()).toEqual([])
    const n = t.emitted.length
    tr.scan()
    expect(t.emitted.length).toBe(n) // same mtime: not re-read
    t.put('aa', 'garbage')
    tr.scan()
    expect(t.emitted.length).toBe(n)
    t.put('aa', 'x'.repeat(1_000_001))
    tr.scan()
    expect(t.emitted.length).toBe(n)
    tr.stop()
  })
  it('uses the current threshold from prefs and picks up Codex rate_limits', () => {
    const cx = tmp()
    const day = join(cx, 'sessions', '2026', '10', '27')
    mkdirSync(day, { recursive: true })
    const rollout = join(day, `rollout-2026-10-27T11-00-00-${SID}.jsonl`)
    const tc = (ts: number, p: number, s: number) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: sec(NOW + 3600_000) }, secondary: { used_percent: s, window_minutes: 10080, resets_at: sec(NOW + 86400_000) } } } }) + '\n'
    writeFileSync(rollout, tc(NOW - 5000, 10, 20) + tc(NOW - 1000, 55, 21))
    const t = setup([acc('cc', 'codex', cx)], 50)
    const tr = t.mk()
    expect(tr.get()[0]).toMatchObject({ accountId: 'cc', windows: [{ id: '5h', pct: 55 }, { id: '7d', pct: 21 }], updatedAt: NOW - 1000 })
    expect(t.warns).toEqual([]) // seeding
    const r = scanCodexRates(cx, NOW)
    expect(r?.windows).toHaveLength(2)
    expect(scanCodexRates(cx, NOW, { [SID]: { ranges: [[0, 1e9]], sib: [] } })).toBeUndefined() // lines copied in by a handoff are another account's
    tr.stop()
  })
})

describe('codex rate_limits parsing', () => {
  const line = (rl: unknown, type = 'token_count') => JSON.stringify({ timestamp: '2026-10-27T12:00:00Z', type: 'event_msg', payload: { type, rate_limits: rl } })
  it('labels windows by length and skips incomplete ones', () => {
    const w = (min: number) => ({ used_percent: 12.5, window_minutes: min, resets_at: 1_800_000_000 })
    const r = parseCodexRates(line({ primary: w(300), secondary: w(10080) }))!
    expect(r.windows.map((x) => x.id)).toEqual(['5h', '7d'])
    expect(r.windows[0]).toEqual({ id: '5h', pct: 12.5, resetsAt: 1_800_000_000_000 })
    expect(parseCodexRates(line({ primary: w(1440), secondary: w(120) }))!.windows.map((x) => x.id)).toEqual(['1d', '2h'])
    expect(parseCodexRates(line({ primary: w(45) }))!.windows[0]!.id).toBe('45min')
    expect(parseCodexRates(line({ primary: { ...w(300), resets_at: 1_800_000_000_000 } }))!.windows[0]!.resetsAt).toBe(1_800_000_000_000) // already ms
    expect(parseCodexRates(line({ primary: { used_percent: 1, window_minutes: 300 } }))).toBeNull() // no reset time
    expect(parseCodexRates(line({ primary: { ...w(0) } }))).toBeNull()
    expect(parseCodexRates(line({ primary: null, secondary: null }))).toBeNull() // null in the stub backend
    expect(parseCodexRates(line(null))).toBeNull()
    expect(parseCodexRates(line({ primary: w(300) }, 'other'))).toBeNull()
    expect(parseCodexRates('{"type":"event_msg","payload":{"type":"token_count","rate_limits":{}}}')).toBeNull() // no timestamp
    expect(parseCodexRates('plain line')).toBeNull()
  })
})

describe('registry', () => {
  const ref = { provider: 'claude' as const, accountId: 'a', sessionId: SID, cwd: '/p' }
  const info = (id: string, accountId = 'a') => ({ id, title: 't', mtimeMs: 1, accountId })
  it('registers once, tracks handoffs, touches and forgets', () => {
    let l = register([], ref, 'new', 100)
    expect(l).toEqual([{ ...ref, createdAt: 100, lastActiveAt: 100, origin: 'new', handoffs: [] }])
    l = register(l, { ...ref, accountId: 'b' }, 'resume', 200) // resume: same entry, origin kept, now active on b
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ accountId: 'b', origin: 'new', lastActiveAt: 200, createdAt: 100 })
    l = registerHandoff(l, { ...ref, accountId: 'c' }, 'b', 300)
    expect(l[0]).toMatchObject({ accountId: 'c', handoffs: [{ from: 'b', to: 'c', at: 300 }] })
    expect(registerHandoff([], ref, 'z', 5)[0]).toMatchObject({ origin: 'resume', handoffs: [{ from: 'z', to: 'a', at: 5 }] }) // unknown session: created
    expect(touchSession(l, SID.toUpperCase(), 400)[0]!.lastActiveAt).toBe(400)
    expect(touchSession(l, 'other', 400)).toEqual(l)
    expect(forgetSession(l, SID)).toEqual([])
    expect(forgetSession(l, 'other')).toEqual(l)
  })
  it('lists only registered sessions of the project (newest transcript copy, handoff marker) and offers the rest', () => {
    const other = '99999999-2222-3333-4444-555555555555'
    const l = registerHandoff(register([], ref, 'new', 1), { ...ref, accountId: 'b' }, 'a', 2)
    const ts = [info(SID, 'b'), info(other)]
    expect(visibleSessions(l, ts, '/p')).toEqual([{ ...info(SID, 'b'), handoffs: [{ from: 'a', to: 'b', at: 2 }] }])
    expect(visibleSessions(l, ts, '/q')).toEqual([]) // other project
    expect(visibleSessions(l, [info(other)], '/p')).toEqual([]) // transcript gone: hidden
    expect(adoptable(l, ts, '/p')).toEqual([info(other)])
    expect(adoptable([], ts, '/p')).toEqual(ts)
    expect(visibleSessions(register([], ref, 'adopt'), [info(SID)], '/p')[0]).not.toHaveProperty('handoffs')
  })
  it('persists in sessions.json, starts empty and drops malformed entries', () => {
    const h = tmp()
    expect(loadRegistry(h)).toEqual([])
    updateRegistry(h, (l) => register(l, ref, 'adopt', 7))
    expect(loadRegistry(h)).toHaveLength(1)
    expect(readdirSync(h)).toEqual(['sessions.json']) // no tmp file left
    writeFileSync(join(h, 'sessions.json'), JSON.stringify([{ ...ref, createdAt: 1, lastActiveAt: 2, origin: 'new', handoffs: [{ from: 'a', to: 'b', at: 3 }, { bad: 1 }] }, { ...ref, origin: 'new' }, { ...ref, createdAt: 1, lastActiveAt: 1, origin: 'weird' }, { ...ref, provider: 'x', createdAt: 1, lastActiveAt: 1, origin: 'new' }, null, { ...ref, sessionId: SID.toUpperCase(), createdAt: 1, lastActiveAt: 1, origin: 'new' }]))
    const r = loadRegistry(h)
    expect(r).toHaveLength(2)
    expect(r[0]!.handoffs).toEqual([{ from: 'a', to: 'b', at: 3 }])
    expect(r[1]!.sessionId).toBe(SID) // lower-cased, handoffs defaulted
    expect(r[1]!.handoffs).toEqual([])
    writeFileSync(join(h, 'sessions.json'), '{"not":"a list"}')
    expect(loadRegistry(h)).toEqual([])
    writeFileSync(join(h, 'sessions.json'), 'garbage')
    expect(loadRegistry(h)).toEqual([])
  })
  it('validates history requests', () => {
    expect(checkSessionRef('/p', SID, ['/p'])).toEqual({ cwd: '/p', sessionId: SID })
    expect(() => checkSessionRef('/x', SID, ['/p'])).toThrow(/project/)
    expect(() => checkSessionRef(5, SID, ['/p'])).toThrow(/project/)
    expect(() => checkSessionRef('/p', '../etc', ['/p'])).toThrow(/session id/)
    expect(() => checkSessionRef('/p', undefined, ['/p'])).toThrow(/session id/)
  })
})


