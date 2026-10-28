import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyBatch, emptyTState } from '../src/shared/transcript'
import type { Account, TEvent } from '../src/shared/types'
import { createParser, isPendingAsk } from '../src/main/transcript/parse'
import { PAGE, createHub, openSession, readPage } from '../src/main/transcript/session'
import { checkAgentId, checkOffset, checkTranscriptRef } from '../src/main/validate'

const FX = join(__dirname, 'fixtures/transcript')
const SID = '11111111-1111-4111-8111-111111111111'
const SECRET = 'PLANTED-SECRET-DO-NOT-FORWARD'
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'relay-ts-')))

/** Whole-file parse (complete lines only), as the tail does. */
function parse(file: string) {
  const p = createParser()
  let at = 0
  const text = readFileSync(file, 'utf8')
  for (const l of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    p.push(l, at)
    at += Buffer.byteLength(l) + 1
  }
  return p.flush()
}
const ev = (n: string) => parse(join(FX, n + '.jsonl'))
const tools = (es: TEvent[]) => es.filter((e): e is Extract<TEvent, { kind: 'tool' }> => e.kind === 'tool')

describe('transcript parser', () => {
  it('normal turn: messages, thinking duration, tools with results, diff, meta', () => {
    const { events, meta } = ev('claude-turn')
    expect(events.map((e) => e.kind)).toEqual(['message', 'thinking', 'message', 'tool', 'tool', 'tool', 'message', 'notice'])
    expect(events[0]).toMatchObject({ role: 'user', text: 'hola, edita a.ts' })
    expect(events[1]).toMatchObject({ kind: 'thinking', durationMs: 1200 })
    const [bash, edit, todo] = tools(events)
    expect(bash).toMatchObject({ name: 'Bash', status: 'ok', result: 'a.ts', durationMs: 1000, input: { command: 'ls /tmp/proj' } })
    expect(edit!.diffs).toEqual([{ file: '/tmp/proj/a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-uno', '+dos'] }] }])
    expect(edit!.input).toEqual({ file_path: '/tmp/proj/a.ts', replace_all: false }) // old/new strings are in the diff
    expect(todo).toMatchObject({ name: 'TodoWrite', status: 'ok' }) // generic card, input kept
    expect(events[7]).toMatchObject({ notice: 'turn', durationMs: 9000 })
    expect(meta).toEqual({ permissionMode: 'auto', cwd: '/tmp/proj', gitBranch: 'main', version: '2.1.312', model: 'claude-fake-1', tokens: { input: 3, output: 5, cacheRead: 20, cacheCreate: 10 }, title: 'Titulo inventado' })
  })

  it('shapes: string toolUseResult, Write diff from content, bashEditDiff, pending asks, last title, block order by message id', () => {
    const { events, meta } = ev('claude-shapes')
    const t = tools(events)
    const byName = (n: string) => t.find((x) => x.name === n)!
    expect(byName('Write').diffs).toEqual([{ file: '/tmp/proj/b.ts', created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+let b = 1'] }] }])
    expect(byName('Write').input).toEqual({ file_path: '/tmp/proj/b.ts' })
    expect(byName('Bash').diffs![0]).toMatchObject({ file: '/tmp/proj/b.ts', hunks: [{ lines: ['-let b = 1', '+let b = 2'] }] })
    expect(byName('Skill')).toMatchObject({ status: 'ok', result: 'Launching skill' })
    expect(events.filter(isPendingAsk).map((e) => (e as { name: string }).name)).toEqual(['AskUserQuestion', 'ExitPlanMode'])
    expect(byName('Skill').status).toBe('ok')
    expect(meta!.title).toBe('Titulo tres')
    // msg_fake80 blocks stay together (text then Write) although a notice sits between the lines
    const order = events.map((e) => (e.kind === 'notice' ? 'notice' : e.kind === 'message' ? e.role : (e as { name?: string }).name))
    expect(order.slice(0, 5)).toEqual(['user', 'assistant', 'Write', 'notice', 'Bash'])
  })

  it('subagent link: agentId on the Agent tool, thread read on demand', () => {
    const { events } = parse(join(FX, 'subagent', SID + '.jsonl'))
    expect(tools(events)[0]).toMatchObject({ name: 'Agent', agentId: 'a1b2c3d4e5f60718', input: { description: 'Buscar', subagent_type: 'general-purpose' } })
    const d = tmp()
    mkdirSync(join(d, SID, 'subagents'), { recursive: true })
    writeFileSync(join(d, SID + '.jsonl'), readFileSync(join(FX, 'subagent', SID + '.jsonl')))
    writeFileSync(join(d, SID, 'subagents', 'agent-a1b2c3d4e5f60718.jsonl'), readFileSync(join(FX, 'subagent', SID, 'subagents', 'agent-a1b2c3d4e5f60718.jsonl')))
    const s = openSession(join(d, SID + '.jsonl'), SID, 'a1', () => undefined)
    const sub = s.subagent('a1b2c3d4e5f60718')
    s.stop()
    expect(sub.agentId).toBe('a1b2c3d4e5f60718')
    expect(sub.events.map((e) => (e as { text?: string }).text)).toEqual(['busca algo', 'Encontrado.'])
    const missing = openSession(join(d, SID + '.jsonl'), SID, 'a1', () => undefined)
    expect(missing.subagent('ffffffffffffffff').events).toEqual([])
    missing.stop()
  })

  it('compaction and rate limit notices; the compact summary line is not a message', () => {
    const c = ev('claude-compact').events
    expect(c.map((e) => e.kind)).toEqual(['message', 'message', 'notice'])
    expect(c[2]).toMatchObject({ notice: 'compact', preTokens: 1000, postTokens: 200 })
    const r = ev('claude-ratelimit')
    expect(r.events[1]).toMatchObject({ notice: 'rate_limit', resetsAt: 1767243000000, limitType: 'five_hour' })
    expect(r.events[1]).toMatchObject({ text: expect.stringContaining('hit your session limit') })
    expect(r.meta?.model).toBeUndefined() // <synthetic> is not the model
  })

  it('api errors other than rate_limit and informational notices', () => {
    const p = createParser()
    p.push(JSON.stringify({ type: 'assistant', uuid: 'e1', isApiErrorMessage: true, error: 'server_error', message: { model: '<synthetic>', content: [{ type: 'text', text: 'boom' }] } }), 0)
    p.push(JSON.stringify({ type: 'system', subtype: 'informational', uuid: 'i1', content: 'aviso' }), 10)
    expect(p.flush().events).toMatchObject([{ notice: 'api_error', text: 'boom', code: 'server_error' }, { notice: 'info', text: 'aviso' }])
  })

  it('unknown line, attachment and block types are ignored; the next lines still parse', () => {
    const { events } = ev('claude-unknown')
    expect(events.map((e) => (e as { text?: string }).text)).toEqual(['hola', 'sigue funcionando'])
  })

  it('truncated last line is skipped until it completes', () => {
    const f = join(FX, 'claude-truncated.jsonl')
    expect(parse(f).events).toHaveLength(2)
    const p = createParser()
    const half = readFileSync(f, 'utf8').split('\n').pop()!
    p.push(half, 0) // invalid JSON: ignored
    expect(p.flush().events).toEqual([])
  })

  it('tool_result before its tool_use (older page) is applied through shared orphans', () => {
    const orphans = new Map()
    const a = createParser(orphans)
    a.push(JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-01-01T00:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), 100)
    const b = createParser(orphans)
    b.push(JSON.stringify({ type: 'assistant', uuid: 'a', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }), 0)
    expect(tools(b.flush().events)[0]).toMatchObject({ status: 'ok', result: 'ok', durationMs: 1000 })
  })

  it('tolerates odd shapes: error results, huge results, non-object lines, bad blocks', () => {
    const p = createParser()
    for (const [i, l] of ['[]', '"x"', 'null', JSON.stringify({ type: 'user', message: { content: [1, { type: 'text' }] } }), JSON.stringify({ type: 'assistant', message: { content: [null, { type: 'tool_use' }] } })].entries()) p.push(l, i)
    expect(p.flush().events).toEqual([])
    p.push(JSON.stringify({ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'x'.repeat(5000), deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } } }] } }), 0)
    p.push(JSON.stringify({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'y'.repeat(9000) }, { type: 'image' }] }] }, toolUseResult: { interrupted: true, agentId: '../x' } }), 5)
    const [t] = tools(p.flush().events)
    expect(t).toMatchObject({ status: 'error', interrupted: true })
    expect(t!.result!.length).toBe(8001)
    expect((t!.input as { file_path: string }).file_path.length).toBe(2001)
    expect(t!.agentId).toBeUndefined()
  })
})

describe('security: no planted secret reaches an IPC payload', () => {
  const files = [...readdirSync(FX).filter((f) => f.startsWith('claude-')).map((f) => join(FX, f)), join(FX, 'subagent', SID + '.jsonl'), join(FX, 'subagent', SID, 'subagents', 'agent-a1b2c3d4e5f60718.jsonl')]
  it('fixtures are planted', () => {
    expect(readFileSync(join(FX, 'claude-sensitive.jsonl'), 'utf8').split(SECRET).length - 1).toBeGreaterThanOrEqual(10)
  })
  it('snapshot, live batch, older page and subagent page of every fixture are non-empty and clean', { timeout: 60_000 }, async () => {
    for (const f of files) {
      const d = tmp()
      const file = join(d, SID + '.jsonl')
      const sub = join(d, SID, 'subagents')
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, 'agent-a1b2c3d4e5f60718.jsonl'), readFileSync(f))
      writeFileSync(file, readFileSync(f))
      const live: any[] = []
      const s = openSession(file, SID, 'a1', (b) => live.push(b))
      appendFileSync(file, readFileSync(f))
      for (let i = 0; i < 40 && !live.length; i++) await new Promise((r) => setTimeout(r, 100))
      const size = readFileSync(file).length
      const payloads = [s.snapshot(), s.older(size), s.subagent('a1b2c3d4e5f60718'), ...live]
      s.stop()
      expect(live.length).toBeGreaterThan(0)
      for (const pl of payloads) {
        expect(pl.events.length).toBeGreaterThan(0)
        expect(JSON.stringify(pl)).not.toContain(SECRET)
      }
      expect(JSON.stringify(parse(f))).not.toContain(SECRET)
    }
  })
})

describe('paging and live tail', () => {
  const mk = (n: number) => {
    const d = tmp()
    const file = join(d, SID + '.jsonl')
    let s = ''
    for (let i = 0; i < n; i++) s += JSON.stringify({ type: 'user', uuid: `u${i}`, message: { content: `msg ${i} ñ` } }) + '\n'
    writeFileSync(file, s)
    return file
  }
  it('last page first, older pages walk back to the start without gaps or duplicates', () => {
    const file = mk(1000)
    const seen: string[] = []
    let p = readPage(file)
    expect(p.events.length).toBeGreaterThanOrEqual(PAGE)
    expect((p.events.at(-1) as { text: string }).text).toBe('msg 999 ñ')
    let guard = 0
    for (;;) {
      seen.unshift(...p.events.map((e) => (e as { text: string }).text))
      if (p.older === null || ++guard > 50) break
      p = readPage(file, p.older)
    }
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, i) => `msg ${i} ñ`))
  })
  it('missing file is an empty page; a partial last line is left out and an overlong line grows the chunk', () => {
    expect(readPage(join(tmp(), 'nope.jsonl'))).toMatchObject({ events: [], older: null })
    const d = tmp()
    const file = join(d, 'a.jsonl')
    const big = JSON.stringify({ type: 'user', uuid: 'big', message: { content: 'x'.repeat(200 * 1024) } }) // longer than the first chunk
    writeFileSync(file, big + '\n' + big.replace('big', 'big2') + '\n{"type":"user","mess')
    expect(readPage(file, undefined, undefined, 2).events.map((e) => e.id)).toEqual(['big:0', 'big2:0'])
    writeFileSync(file, '{"partial"')
    expect(readPage(file).events).toEqual([])
  })
  it('snapshot then live batches with increasing seq; truncated line completes later; applyBatch is idempotent', async () => {
    const file = mk(3)
    const live: any[] = []
    const s = openSession(file, SID, 'a1', (b) => live.push(b))
    expect(s.snapshot().seq).toBe(0)
    expect(s.snapshot().events).toHaveLength(3)
    const l4 = JSON.stringify({ type: 'user', uuid: 'u3', message: { content: 'msg 3' } })
    appendFileSync(file, l4.slice(0, 20))
    appendFileSync(file, l4.slice(20) + '\n')
    for (let i = 0; i < 40 && !live.length; i++) await new Promise((r) => setTimeout(r, 100))
    s.stop()
    expect(live[0]).toMatchObject({ accountId: 'a1', sessionId: SID, seq: 1 })
    expect(live[0].events.map((e: TEvent) => (e as { text: string }).text)).toEqual(['msg 3'])
    let st = applyBatch(emptyTState(), s.snapshot())
    st = applyBatch(st, live[0])
    const again = applyBatch(st, live[0]) // replay ignored
    expect(again).toBe(st)
    expect(st.events.map((e) => e.id)).toEqual(['u0:0', 'u1:0', 'u2:0', 'u3:0'])
    const older = applyBatch(st, { accountId: 'a1', sessionId: SID, events: [{ id: 'u0:0', at: 0, kind: 'message', role: 'user', text: 'old' }], meta: { title: 'older', cwd: 'x' }, older: null })
    expect(older.events[0]).toMatchObject({ text: 'old' })
    expect(older.meta).toEqual({ title: 'older', cwd: 'x' })
    expect(applyBatch(older, { accountId: 'a1', sessionId: SID, seq: 5, events: [], meta: { title: 'new' } }).meta.title).toBe('new')
  })
})

describe('performance: 50 MB session with a heavy tail', () => {
  it('first page and older page block the main thread under 16 ms', () => {
    const d = tmp()
    const file = join(d, SID + '.jsonl')
    const parts: string[] = []
    let bytes = 0
    const add = (o: object) => {
      const l = JSON.stringify(o) + '\n'
      parts.push(l)
      bytes += l.length
    }
    const result = (i: number, n: number, extra: object = {}) => ({ type: 'user', uuid: `r${i}`, timestamp: '2026-01-01T00:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'q'.repeat(n) }] }, toolUseResult: { stdout: 'q'.repeat(Math.min(n, 60_000)) }, ...extra })
    const use = (i: number) => ({ type: 'assistant', uuid: `a${i}`, timestamp: '2026-01-01T00:00:01.000Z', apiBlockIndex: 0, message: { id: `m${i}`, model: 'x', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] } })
    let i = 0
    for (; bytes < 12 * 1024 * 1024; i++) (add(use(i)), add(result(i, i % 3 ? 20_000 : 60_000)))
    for (let k = 0; k < 40; k++, i++) (add(use(i)), add(result(i, 1_400_000))) // image tool results at the tail
    for (let k = 0; k < 300; k++, i++) (add(use(i)), add(result(i, 2000)))
    writeFileSync(file, parts.join(''))
    const time = <T,>(f: () => T): [T, number] => {
      let best = Infinity
      let r!: T
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now()
        r = f()
        best = Math.min(best, performance.now() - t0) // best of 3 per page: one GC pause is not a blocked page
      }
      return [r, best]
    }
    const [p, ms] = time(() => readPage(file))
    const [o, ms2] = time(() => readPage(file, p.older!))
    let worst = Math.max(ms, ms2)
    let pages = 2
    for (let pg = o; pg.older; pages++) {
      const before = pg.older
      const [n, t] = time(() => readPage(file, before)) // walks through the 1.4 MB image results and the 20-60 KB results
      worst = Math.max(worst, t)
      pg = n
    }
    console.log(`${(bytes / 1048576).toFixed(1)} MB: first page ${p.events.length} events ${ms.toFixed(1)} ms; older ${o.events.length} events ${ms2.toFixed(1)} ms; every page of the file (${pages}): worst-of-best ${worst.toFixed(1)} ms`)
    expect(p.events.length).toBeGreaterThanOrEqual(PAGE)
    expect(ms).toBeLessThan(16)
    expect(ms2).toBeLessThan(16)
    expect(worst).toBeLessThan(16)
  })
})

describe('F6.1 audit regressions', () => {
  const use = (id: string, name = 'Bash') => JSON.stringify({ type: 'assistant', uuid: 'a' + id, timestamp: '2026-01-01T00:00:01.000Z', apiBlockIndex: 0, message: { id: 'm' + id, content: [{ type: 'tool_use', id, name, input: {} }] } }) + '\n'
  const res = (id: string) => JSON.stringify({ type: 'user', uuid: 'r' + id, timestamp: '2026-01-01T00:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } }) + '\n'
  const filler = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user', uuid: 'f' + i, message: { content: 'f'.repeat(2000) } }) + '\n').join('')

  it('an orphan result applies every time the same older page is read (no false pending ask)', () => {
    const file = join(tmp(), 'a.jsonl')
    writeFileSync(file, use('tq', 'AskUserQuestion') + filler(600) + res('tq') + filler(10))
    const orphans = new Map()
    const befores: number[] = []
    let pg = readPage(file, undefined, orphans, 1)
    while (pg.older) (befores.push(pg.older), (pg = readPage(file, pg.older, orphans, 1)))
    expect(befores.length).toBeGreaterThan(2)
    const last = befores.at(-1)! // the page that holds the tool_use
    for (const again of [readPage(file, last, orphans, 1), readPage(file, last, orphans, 1)]) {
      expect(tools(again.events).find((x) => x.id === 'tq')!.status).toBe('ok')
      expect(again.events.some(isPendingAsk)).toBe(false)
    }
  })

  it('a live result finishes a tool_use shown by an older page', async () => {
    const file = join(tmp(), SID + '.jsonl')
    writeFileSync(file, use('tl') + filler(10))
    const live: any[] = []
    const s = openSession(file, SID, 'a1', (b) => live.push(b))
    const old = s.older(readFileSync(file).length)
    expect(tools(old.events)[0]).toMatchObject({ id: 'tl', status: 'pending' })
    appendFileSync(file, res('tl'))
    for (let i = 0; i < 40 && !live.length; i++) await new Promise((r) => setTimeout(r, 100))
    s.stop()
    expect(live[0].events).toMatchObject([{ id: 'tl', status: 'ok', result: 'done' }])
  })

  it('result lines above 256 KB keep their diff and agentId (no size cap on parsing)', () => {
    const file = join(tmp(), 'a.jsonl')
    const big = 'x'.repeat(300 * 1024)
    const use = (id: string, name: string) => JSON.stringify({ type: 'assistant', uuid: 'a' + id, message: { id: 'm' + id, content: [{ type: 'tool_use', id, name, input: {} }] } }) + '\n'
    const res = (id: string, r: object, is_error = false) => JSON.stringify({ type: 'user', uuid: 'r' + id, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'ok' }] }, toolUseResult: r }) + '\n'
    writeFileSync(file, use('e1', 'Edit') + res('e1', { filePath: '/f', originalFile: big, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }) + use('g1', 'Agent') + res('g1', { agentId: 'a1b2c3d4e5f60718', prompt: big }) + use('b1', 'Bash') + res('b1', { stdout: big, interrupted: true }, true) + use('q1', 'AskUserQuestion') + JSON.stringify({ type: 'attachment', attachment: { tool_use_id: 'q1', pad: big } }) + '\n')
    const t = tools(readPage(file, undefined, undefined, 100).events)
    expect(t.find((x) => x.id === 'e1')!.diffs![0]!.hunks[0]!.lines).toEqual(['-a', '+b'])
    expect(t.find((x) => x.id === 'g1')!.agentId).toBe('a1b2c3d4e5f60718')
    expect(t.find((x) => x.id === 'b1')).toMatchObject({ status: 'error', interrupted: true })
    expect(t.find((x) => x.id === 'q1')!.status).toBe('pending') // a big attachment never settles a pending ask
  })

  it('a file that shrinks while subscribed resets the stream: snapshot batch, then the new content', async () => {
    const file = join(tmp(), SID + '.jsonl')
    writeFileSync(file, filler(5))
    const got: any[] = []
    const s = openSession(file, SID, 'a1', (b) => got.push(b))
    let st = applyBatch(emptyTState(), s.snapshot())
    expect(st.events).toHaveLength(5)
    writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'new', message: { content: 'rewritten' } }) + '\n')
    for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 100))
    s.stop()
    expect(got[0]).toMatchObject({ seq: 1, events: [], older: null })
    expect(got[1].events[0]).toMatchObject({ text: 'rewritten' })
    for (const b of got) st = applyBatch(st, b)
    expect(st.events.map((e) => (e as { text: string }).text)).toEqual(['rewritten'])
  })

  it('hub: one stream per account+session, refcounted, seq continuous, accounts separate', async () => {
    const file = join(tmp(), SID + '.jsonl')
    const file2 = join(tmp(), SID + '.jsonl')
    writeFileSync(file, filler(2))
    writeFileSync(file2, filler(1))
    const got: any[] = []
    const hub = createHub((b) => got.push(b))
    const a = hub.subscribe('a1', SID, file)
    const b = hub.subscribe('a1', SID, file) // second tab, same stream
    const other = hub.subscribe('a2', SID, file2) // handoff target: same session id, other account
    expect([a.accountId, b.accountId, other.accountId]).toEqual(['a1', 'a1', 'a2'])
    expect(other.events).toHaveLength(1)
    hub.unsubscribe('a1', SID) // one tab leaves: the other keeps receiving
    appendFileSync(file, filler(1))
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 100))
    expect(got[0]).toMatchObject({ accountId: 'a1', seq: 1 })
    // a late subscriber gets the current seq, so the next live batch applies on top of its snapshot
    const late = hub.subscribe('a1', SID, file)
    expect(late.seq).toBe(1)
    let st = applyBatch(emptyTState(), late)
    appendFileSync(file, filler(1))
    for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 100))
    expect(got[1].seq).toBe(2)
    st = applyBatch(st, got[1])
    expect(st.seq).toBe(2)
    hub.unsubscribe('a1', SID)
    hub.unsubscribe('a1', SID)
    expect(hub.get('a1', SID)).toBeUndefined() // last subscriber gone: stream stopped
    expect(hub.get('a2', SID)).toBeDefined()
    hub.unsubscribe('a1', SID) // extra unsubscribe is harmless
    // re-subscribe after a full stop restarts seq at 0: the renderer snapshot resets its position
    const again = hub.subscribe('a1', SID, file)
    expect(again.seq).toBe(0)
    st = applyBatch(st, again)
    expect(st.seq).toBe(0)
    hub.stopAll()
    expect(hub.get('a2', SID)).toBeUndefined()
  })

  it('offset beyond the file is clamped; Write update with empty patch is a diff but not "created"; api_error code', () => {
    const file = join(tmp(), 'a.jsonl')
    writeFileSync(file, filler(3))
    expect(readPage(file, 10 ** 12).events).toHaveLength(3)
    const q = createParser(new Map(), new Map())
    q.push(JSON.stringify({ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'tool_use', id: 'w', name: 'Write', input: {} }] } }), 0)
    q.push(JSON.stringify({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] }, toolUseResult: { type: 'update', filePath: '/x', content: 'a\n', structuredPatch: [] } }), 5)
    const d = tools(q.flush().events)[0]!.diffs![0]!
    expect(d.created).toBeUndefined()
    expect(d.hunks[0]!.lines).toEqual(['+a'])
  })
})

describe('validation', () => {
  const acc = (provider: 'claude' | 'codex'): Account => ({ id: 'a1', label: 'A', provider, configDir: '/c' }) as Account
  it('transcript ref: known claude account, known project, real session id', () => {
    const ok = { accountId: 'a1', cwd: '/p', sessionId: SID }
    expect(checkTranscriptRef(ok, [acc('claude')], ['/p'])).toMatchObject({ cwd: '/p', sessionId: SID })
    expect(() => checkTranscriptRef({ ...ok, accountId: 'x' }, [acc('claude')], ['/p'])).toThrow('Unknown account')
    expect(() => checkTranscriptRef(ok, [acc('codex')], ['/p'])).toThrow('Claude')
    expect(() => checkTranscriptRef({ ...ok, cwd: '/q' }, [acc('claude')], ['/p'])).toThrow('Unknown project')
    expect(() => checkTranscriptRef({ ...ok, sessionId: '../../x' }, [acc('claude')], ['/p'])).toThrow('session id')
    expect(() => checkTranscriptRef(undefined, [acc('claude')], ['/p'])).toThrow()
  })
  it('agent id and offset', () => {
    expect(checkAgentId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718')
    for (const bad of ['../x', 'abc', 5, '', 'a1b2c3d4/../x']) expect(() => checkAgentId(bad)).toThrow()
    expect(checkOffset(0)).toBe(0)
    for (const bad of [-1, 1.5, '3', NaN, undefined]) expect(() => checkOffset(bad)).toThrow()
  })
})
