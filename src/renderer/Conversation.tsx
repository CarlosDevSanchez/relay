import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applyBatch, createFeed, emptyTState, isPendingAsk, type TState } from '../shared/transcript'
import type { TDiff, TEvent, TMeta, TranscriptRef } from '../shared/types'
import { CopyButton, Markdown } from './md'

type Tool = Extract<TEvent, { kind: 'tool' }>
type Notice = Extract<TEvent, { kind: 'notice' }>
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const host = (u: string) => {
  try {
    return new URL(u).hostname
  } catch {
    return u
  }
}
export const dur = (ms: number): string => {
  const sec = Math.round(ms / 1000)
  return ms < 1000 ? '<1 s' : sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`
}
const tok = (n?: number) => (n === undefined ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const lines = (t?: string) => (t ? t.split('\n').length : 0)

// ---- diff ----
export const diffCounts = (d: TDiff): { add: number; del: number } => {
  let add = 0, del = 0
  for (const h of d.hunks) for (const l of h.lines) l.startsWith('+') ? add++ : l.startsWith('-') && del++
  return { add, del }
}
/** Path shown relative to the project (the absolute one stays in the title). */
export const relPath = (file: string, cwd: string): string => (cwd && file.startsWith(cwd + '/') ? file.slice(cwd.length + 1) : file)
function DiffView({ d, cwd }: { d: TDiff; cwd: string }) {
  const { add, del } = diffCounts(d)
  return (
    <div className="mt-1 overflow-clip rounded-box border border-base-300" data-testid="diff">
      <div className="flex items-center gap-2 border-b border-base-300 bg-base-200 px-2 py-1">
        <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono" title={d.file}><bdi>{relPath(d.file, cwd)}</bdi></span>
        {d.created && <span className="badge badge-soft badge-success badge-xs">creado</span>}
        {d.deleted && <span className="badge badge-soft badge-error badge-xs">eliminado</span>}
        <span className="shrink-0 font-mono text-success">+{add}</span>
        <span className="shrink-0 font-mono text-error">−{del}</span>
      </div>
      <div data-scroll className="max-h-80 overflow-auto font-mono leading-snug">
        {d.hunks.map((h, i) => (
          <div key={i} className="w-max min-w-full">
            <div className="px-2 py-0.5 opacity-50">@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</div>
            {h.lines.map((l, j) => (
              <div key={j} className={`whitespace-pre px-2 ${l.startsWith('+') ? 'bg-success/15' : l.startsWith('-') ? 'bg-error/15' : ''}`}>{l || ' '}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- subagent thread (loaded when its card is first opened) ----
function SubThread({ r, agentId }: { r: TranscriptRef; agentId: string }) {
  const [st, setSt] = useState<TState | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    window.relay.transcript.subagent(r, agentId).then((b) => live && setSt(applyBatch(emptyTState(), b)), () => live && setErr(true))
    return () => void (live = false)
  }, [r.accountId, r.sessionId, agentId])
  if (err) return <p className="opacity-60">No se pudo leer el hilo del subagente.</p>
  if (!st) return <span className="loading loading-dots loading-xs" aria-label="Cargando" />
  return (
    <div className="space-y-2" data-testid="subthread">
      {st.older != null && (
        <button className="btn btn-ghost btn-xs" onClick={() => void window.relay.transcript.subagent(r, agentId, st.older!).then((b) => setSt((p) => (p ? applyBatch(p, b) : p)), () => undefined)}>Cargar anteriores</button>
      )}
      {st.events.length === 0 && <p className="opacity-60">El hilo aún no tiene contenido.</p>}
      {st.events.map((e) => <Item key={e.id} e={e} r={r} />)}
    </div>
  )
}

/** Warning in the theme's base text color on a warning-bordered box (the soft alert's text is too pale on the light theme). */
const Warn = ({ children }: { children: ReactNode }) => (
  <div role="status" className="mt-2 flex items-center gap-2 rounded-box border border-warning bg-base-200 px-3 py-1.5 text-base-content">
    <span aria-hidden="true" className="status status-warning shrink-0" />
    <span className="min-w-0 break-words">{children}</span>
  </div>
)

// ---- tool cards ----
const Out = ({ text, err }: { text: string; err?: boolean }) => (
  <pre data-scroll className={`mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-box bg-base-200 p-2 font-mono ${err ? 'text-error' : ''}`}>{text}</pre>
)
const Fold = ({ label, text, err, open }: { label: string; text: string; err?: boolean; open?: boolean }) =>
  text ? (
    <details className="mt-1" {...(open ? { open: true } : {})}>
      <summary className="cursor-pointer opacity-70">{label}</summary>
      <Out text={text} {...(err ? { err } : {})} />
    </details>
  ) : null

/** One-line target and (optional) short summary shown in the card header. */
export function toolHead(e: Tool): { target: string; note?: string } {
  const i = rec(e.input)
  const res = e.result
  switch (e.name) {
    case 'Bash': return { target: s(i.command).split('\n')[0] ?? '' }
    case 'Read': return { target: base(s(i.file_path)), note: res ? `${lines(res)} líneas` : '' }
    case 'Grep': return { target: s(i.pattern), note: res ? `${lines(res)} líneas` : '' }
    case 'Glob': return { target: s(i.pattern), note: res ? `${res.split('\n').filter(Boolean).length} archivos` : '' }
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return { target: base(s(i.file_path) || s(i.notebook_path) || e.diffs?.[0]?.file || '') }
    case 'WebFetch': return { target: host(s(i.url)) }
    case 'WebSearch': return { target: s(i.query) }
    case 'Agent': case 'Task': return { target: s(i.description) || s(i.subagent_type) }
    case 'AskUserQuestion': return { target: s(rec((Array.isArray(i.questions) ? i.questions : [])[0]).question) }
    case 'ExitPlanMode': return { target: 'plan' }
    default: return { target: '' }
  }
}

function ToolCard({ e, r }: { e: Tool; r: TranscriptRef }) {
  const { target, note } = toolHead(e)
  const i = rec(e.input)
  const [loadAgent, setLoadAgent] = useState(false)
  const pending = e.status === 'pending'
  const edit = !!e.diffs?.length
  const ask = isPendingAsk(e)
  return (
    <details
      data-testid="tool-card"
      data-tool={e.name}
      className={`collapse collapse-arrow overflow-clip rounded-xl border bg-base-200 text-xs ${e.status === 'error' ? 'border-error/50' : ask ? 'border-warning' : 'border-base-300'}`}
      {...(edit || e.status === 'error' || ask ? { open: true } : {})}
      onToggle={(ev) => ev.currentTarget.open && setLoadAgent(true)}
    >
      <summary className="collapse-title flex min-h-0 items-center gap-2 py-1.5 pr-10">
        <span className="badge badge-soft badge-sm shrink-0">{e.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={target}>{target}</span>
        {note && <span className="shrink-0 opacity-60">{note}</span>}
        {e.diffs && e.diffs.length > 0 && (() => {
          const c = e.diffs.map(diffCounts)
          return <span className="shrink-0 font-mono"><span className="text-success">+{c.reduce((a, x) => a + x.add, 0)}</span> <span className="text-error">−{c.reduce((a, x) => a + x.del, 0)}</span></span>
        })()}
        {e.interrupted && <span className="badge badge-soft badge-warning badge-xs shrink-0">interrumpido</span>}
        {e.status === 'error' && <span className="badge badge-soft badge-error badge-xs shrink-0">error</span>}
        {pending && <span className="loading loading-dots loading-xs shrink-0 opacity-60" role="status" aria-label="En curso" />}
        {e.durationMs !== undefined && <span className="shrink-0 opacity-60">{dur(e.durationMs)}</span>}
      </summary>
      <div className="collapse-content min-w-0">
        {e.name === 'Bash' && (
          <>
            <Out text={`$ ${s(i.command)}`} />
            <Fold label="Salida" text={e.result ?? ''} err={e.status === 'error'} open={e.status === 'error'} />
          </>
        )}
        {edit && e.diffs!.map((d, k) => <DiffView key={k} d={d} cwd={r.cwd} />)}
        {(e.name === 'AskUserQuestion') && (
          <div className="space-y-2">
            {(Array.isArray(i.questions) ? i.questions : []).map((q, k) => {
              const o = rec(q)
              return (
                <div key={k}>
                  <p className="font-semibold">{s(o.question)}</p>
                  <ul className="list-disc pl-5 opacity-80">
                    {(Array.isArray(o.options) ? o.options : []).map((x, n) => <li key={n}>{s(rec(x).label)}{s(rec(x).description) && ` · ${s(rec(x).description)}`}</li>)}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
        {e.name === 'ExitPlanMode' && (
          <>
            <Markdown text={s(i.plan)} />
          </>
        )}
        {(e.name === 'Agent' || e.name === 'Task') && (
          <>
            {s(i.prompt) && <Fold label="Encargo" text={s(i.prompt)} />}
            {e.agentId && loadAgent ? <div className="mt-2 border-l-2 border-base-300 pl-3"><SubThread r={r} agentId={e.agentId} /></div> : !e.agentId && <Fold label="Resultado" text={e.result ?? ''} />}
          </>
        )}
        {['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(e.name) && (
          <>
            {e.name === 'WebFetch' && <p className="truncate opacity-70" title={s(i.url)}>{host(s(i.url))}</p>}
            <Fold label="Resultado" text={e.result ?? ''} err={e.status === 'error'} />
          </>
        )}
        {!['Bash', 'AskUserQuestion', 'ExitPlanMode', 'Agent', 'Task', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(e.name) && !edit && (
          <>
            <Out text={JSON.stringify(e.input, null, 2) ?? ''} />
            <Fold label="Resultado" text={e.result ?? ''} err={e.status === 'error'} />
          </>
        )}
      </div>
    </details>
  )
}

// ---- notices ----
function NoticeView({ e }: { e: Notice }) {
  switch (e.notice) {
    case 'compact': return <div className="flex items-center gap-2 text-xs opacity-60"><hr className="flex-1 border-base-300" /><span className="min-w-0 text-center">Conversación compactada · {tok(e.preTokens)} → {tok(e.postTokens)} tokens</span><hr className="flex-1 border-base-300" /></div>
    case 'turn': return <p className="text-center text-xs opacity-50">Turno de {dur(e.durationMs ?? 0)}</p>
    case 'rate_limit': return <Warn>{e.text}{e.resetsAt ? ` Se restablece ${new Date(e.resetsAt).toLocaleString()}.` : ''}</Warn>
    case 'api_error': return <div role="alert" className="alert alert-error alert-soft py-1.5 text-xs"><span>{e.text}{e.code ? ` (${e.code})` : ''}</span></div>
    default: return <p className="text-center text-xs opacity-50">{e.text}</p>
  }
}

// ---- one timeline item ----
const Item = memo(function Item({ e, r, fresh }: { e: TEvent; r: TranscriptRef; fresh?: boolean }) {
  return (
    <div data-testid={`ev-${e.kind}`} className={`cv min-w-0 ${fresh ? 'rise' : ''}`}>
      {e.kind === 'message' && e.role === 'user' && <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-box bg-base-200 px-3 py-2">{e.text}</div>}
      {e.kind === 'message' && e.role === 'assistant' && (
        <div className="group relative">
          <Markdown text={e.text} />
          <div className="absolute -top-1 right-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"><CopyButton text={e.text} label="Copiar mensaje" /></div>
        </div>
      )}
      {e.kind === 'thinking' && <p className="text-xs opacity-50">Pensó{e.durationMs !== undefined ? ` ${dur(e.durationMs)}` : ''}</p>}
      {e.kind === 'tool' && <ToolCard e={e} r={r} />}
      {e.kind === 'notice' && <NoticeView e={e} />}
    </div>
  )
})

// ---- view ----
/** The newest tool still waiting for its result ("Bash · bun test"), for the activity line. */
export function pendingTool(events: TEvent[]): string | null {
  const e = events.findLast((x): x is Tool => x.kind === 'tool' && x.status === 'pending')
  if (!e) return null
  const t = toolHead(e).target
  return (t ? `${e.name} · ${t}` : e.name).slice(0, 80)
}

export function ConversationView({ r: ref, onTool, onMeta, onAsk }: { r: TranscriptRef; onTool?: (label: string | null) => void; onMeta?: (m: TMeta) => void; onAsk?: (a: { name: string; input: unknown } | null) => void }) {
  const r = useMemo(() => ref, [ref.accountId, ref.cwd, ref.sessionId]) // stable identity: Item's memo needs it
  const [st, setSt] = useState<TState>(emptyTState)
  const feed = useRef<ReturnType<typeof createFeed>>(null)
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [stuck, setStuck] = useState(true)
  const seen = useRef<number | null>(null) // highest `at` of the first snapshot: later events animate in
  const prev = useRef<{ h: number; first: string } | null>(null)
  useEffect(() => {
    const f = createFeed(window.relay.transcript, r, setSt)
    feed.current = f
    return () => f.stop()
  }, [r.accountId, r.cwd, r.sessionId])
  useEffect(() => onTool?.(pendingTool(st.events)), [st.events])
  useEffect(() => onMeta?.(st.meta), [st.meta])
  useEffect(() => {
    const e = st.events.findLast((x): x is Tool => x.kind === 'tool' && isPendingAsk(x))
    onAsk?.(e ? { name: e.name, input: e.input } : null)
  }, [st.events])
  if (seen.current === null && st.seq >= 0) seen.current = st.events.at(-1)?.at ?? -1
  useLayoutEffect(() => {
    const el = box.current!
    const p = prev.current
    const prepended = !!p && st.events[0]?.id !== p.first && st.events.some((e) => e.id === p.first) // the old first event is still there, now below new ones
    if (prepended) el.scrollTop += el.scrollHeight - p.h // older page prepended: keep the view where it was
    else if (stick.current) el.scrollTop = el.scrollHeight // includes a reset snapshot (stale older reply: its anchor is gone)
    if (prepended || (p && !st.events.some((e) => e.id === p.first))) prev.current = null // an unanswered request keeps waiting for its page
  }, [st])
  useEffect(() => {
    const ro = new ResizeObserver(() => stick.current && (box.current!.scrollTop = box.current!.scrollHeight))
    ro.observe(inner.current!)
    return () => ro.disconnect()
  }, [])
  const older = () => {
    const el = box.current!
    if (st.events[0]) prev.current = { h: el.scrollHeight, first: st.events[0].id }
    feed.current?.older()
  }
  const down = () => {
    stick.current = true
    setStuck(true)
    box.current!.scrollTo({ top: box.current!.scrollHeight })
  }
  return (
    <div className="relative h-full min-h-0 min-w-0" data-testid="conversation">
      <div
        ref={box}
        className="h-full overflow-y-auto overflow-x-clip px-4 pb-14 pt-3"
        onScroll={(ev) => {
          const el = ev.currentTarget
          const at = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          stick.current = at
          setStuck(at)
          if (el.scrollTop < 40 && st.older != null) older()
        }}
      >
        <div ref={inner} className="mx-auto flex max-w-3xl flex-col gap-3 text-sm">
          {st.older != null && <button className="btn btn-ghost btn-xs self-center" onClick={older}>Cargar anteriores</button>}
          {st.seq >= 0 && st.events.length === 0 && <p className="py-8 text-center opacity-60">Aún no hay mensajes. Escribe el primero abajo.</p>}
          {st.events.map((e) => <Item key={e.id} e={e} r={r} fresh={seen.current !== null && e.at > seen.current} />)}
        </div>
      </div>
      {!stuck && <button className="btn btn-xs btn-primary absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-lg" onClick={down}>Ir al último</button>}
    </div>
  )
}
