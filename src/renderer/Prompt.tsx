import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type AnswerAction, type CardOption, cardOptions, hasCard, labelsMatch, matchAsk, planOf, stillShows } from '../shared/prompt'
import type { DialogInfo, DialogKind } from '../shared/screen'
import { Markdown } from './md'
import { type Snap, freshScreen } from './screens'

const KIND: Partial<Record<DialogKind, string>> = { permission: 'Permiso', question: 'Pregunta', review: 'Revisión', plan: 'Plan' }
const MAX_TEXT = 1000
/** a card's buttons work only once its fingerprint has been stable this long (design 5.5: >= 300 ms of stability) */
const SETTLE = 400
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const CHANGED = 'La pantalla del CLI cambió: la tarjeta se descartó y no se envió nada.'

/** A pending AskUserQuestion / ExitPlanMode tool_use from the transcript (richer content than the screen; the screen still decides the keys). */
export interface PendingAsk { name: string; input: unknown }

interface Gone { d: DialogInfo; how: 'sent' | 'terminal'; label: string }

/**
 * Card for a CLI dialog (F6.4, design 5.5). Built from the classified screen; a button sends ONE allowlisted key action, only after the live screen
 * is re-classified (xterm flushed) and still shows the same dialog (kind + fingerprint), with main's seq guard behind it. Buttons arm after the fingerprint
 * has been stable for SETTLE ms. One shot per card: no retries, no queued keys; a double click sends once. A text row is two steps with a screen check in between
 * (the digit, then the line only if the row took focus). Gone dialogs leave a disabled record until the next message.
 */
export function PromptCard({ ptyId, exited, screen, pending, epoch, onTerminal }: { ptyId: number; exited: boolean; screen: Snap; pending: PendingAsk | null; epoch: number; onTerminal(): void }) {
  const live = screen.dialog && hasCard(screen.dialog.kind) ? screen.dialog : null
  const fp = live?.fingerprint
  const [locked, setLocked] = useState<string | null>(null) // fingerprint of the card whose key went out (or was refused): disabled
  const [armedFp, setArmedFp] = useState<string | undefined>() // the fingerprint that has been stable for SETTLE ms: derived, so a new card is never armed in its first render
  const armed = armedFp === fp
  const [note, setNote] = useState('')
  const [gone, setGone] = useState<Gone | null>(null)
  const [edit, setEdit] = useState<number | null>(null) // open text row
  const [text, setText] = useState('')
  const inflight = useRef(false)
  const lockRef = useRef<string | null>(null)
  const sawGone = useRef(false) // the dialog left the screen since the lock: an identical one that comes back is a new card
  const gen = useRef(0) // bumps whenever the dialog on screen changes or goes: a late timer must not blame a new card
  const armedAt = useRef(0)
  const label = useRef('')
  const seen = useRef<DialogInfo | null>(null)
  const fpRef = useRef(fp)
  fpRef.current = fp
  const ready = () => Date.now() - armedAt.current >= SETTLE

  useLayoutEffect(() => {
    gen.current++
    armedAt.current = Date.now()
    if (!fp) setArmedFp(undefined) // the same dialog coming back later must settle again
  }, [fp])
  useEffect(() => {
    setEdit(null)
    setText('')
    if (fp) {
      if (lockRef.current && (lockRef.current !== fp || sawGone.current)) ((lockRef.current = null), (sawGone.current = false), setLocked(null)) // another dialog / tab / toggled box / a repeat of the same one: a new card
      seen.current = live
      setGone(null)
      const t = setTimeout(() => setArmedFp(fp), SETTLE)
      return () => clearTimeout(t)
    }
    sawGone.current = lockRef.current !== null
    const d = seen.current
    if (!d) return
    // the dialog is off the screen (debounced: a redraw may pass through other frames): answered by Relay's click, or in the terminal
    const t = setTimeout(() => {
      setGone({ d, how: lockRef.current === d.fingerprint ? 'sent' : 'terminal', label: label.current })
      seen.current = lockRef.current = null
      sawGone.current = false
      setLocked(null)
      setNote('')
    }, 400)
    return () => clearTimeout(t)
  }, [fp])
  useEffect(() => setGone(null), [epoch])

  /** Runs `body` on the frame xterm has fully parsed, only if it still shows `d`; `body` returns a note when something is off. */
  const go = async (d: DialogInfo, what: string, body: (f: Snap) => Promise<string>) => {
    if (inflight.current || lockRef.current === d.fingerprint || !ready()) return
    inflight.current = true
    lockRef.current = d.fingerprint
    sawGone.current = false
    label.current = what
    setLocked(d.fingerprint)
    setNote('')
    try {
      const f = await freshScreen(ptyId, exited)
      if (!stillShows(d, f)) return setNote(CHANGED)
      const err = await body(f)
      if (err) return setNote(err)
      const g = gen.current
      setTimeout(() => {
        if (gen.current !== g || fpRef.current !== d.fingerprint) return
        setNote('El CLI no reaccionó a la tecla: revisa la terminal.')
        onTerminal()
      }, 2000)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      inflight.current = false
    }
  }
  const send = async (f: Snap, d: DialogInfo, action: AnswerAction): Promise<string> => {
    const r = await window.relay.pty.answer(ptyId, f.seq, action)
    return r === 'stale' ? 'El CLI cambió la pantalla mientras contestabas: no se envió nada.' : r === 'gone' ? 'La sesión ya no está activa.' : ''
  }
  const key = (d: DialogInfo, action: AnswerAction, what: string) => go(d, what, (f) => send(f, d, action))
  /** Text row: the digit, then (only if the row took focus: same dialog, option n selected, nothing else changed) the line + Enter. */
  const typed = (d: DialogInfo, o: CardOption, line: string) =>
    go(d, `${o.n}. ${o.label}`, async (f) => {
      const e = await send(f, d, { kind: 'text', n: o.n })
      if (e) return e
      let g = f
      for (let i = 0, last = f.seq; i < 20; i++) {
        await wait(100)
        g = await freshScreen(ptyId, exited)
        if (g.seq !== f.seq && g.seq === last) break // the CLI redrew and went quiet
        last = g.seq
      }
      const ok = g.seq !== f.seq && stillShows(d, g) && g.dialog!.options.every((x) => x.selected === (x.n === o.n))
      if (!ok) return (onTerminal(), 'La fila de texto no tomó el foco: no se envió la línea. Revisa la terminal.')
      const err = await send(g, d, { kind: 'line', text: line })
      if (!err) label.current = `${o.n}. ${o.label} · ${line.trim()}`
      return err
    })

  if (!live) {
    if (!gone) return null
    return (
      <div className="px-4 pb-2" data-testid="prompt-done">
        <section className="mx-auto w-full max-w-3xl rounded-xl border border-base-300 bg-base-200 p-3 text-sm opacity-70" data-testid="prompt-card" data-status={gone.how}>
          <p className="font-semibold">{gone.d.question}</p>
          <p className="mt-1 text-xs"><span className="badge badge-soft badge-sm mr-2">{gone.how === 'sent' ? 'Respondido' : 'Respondido en la terminal'}</span>{gone.how === 'sent' ? gone.label : ''}</p>
        </section>
      </div>
    )
  }

  const d = live
  const { options, multi } = cardOptions(d)
  const ask = pending?.name === 'AskUserQuestion' && d.kind === 'question' ? matchAsk(pending.input, d.question) : null
  const plan = pending?.name === 'ExitPlanMode' && d.kind === 'plan' ? planOf(pending.input) : ''
  const refuse = d.truncated ? 'El comando o el plan no cabe en la pantalla: revísalo en la terminal.' : ask && !labelsMatch(options, ask.labels) ? 'Las opciones de la pantalla no coinciden con la pregunta del CLI: revísalas en la terminal.' : ''
  const off = locked === d.fingerprint || exited || !armed
  const press = (o: CardOption) => {
    if (off || !ready()) return
    if (o.mode === 'text') return void (setEdit(o.n), setText(''))
    void key(d, { kind: o.mode, n: o.n }, `${o.n}. ${o.label}`)
  }
  return (
    <div className="max-h-[60%] shrink-0 overflow-y-auto px-4 pb-2">
      <section
        className="mx-auto w-full max-w-3xl rounded-xl border border-warning bg-base-200 p-3 text-sm focus-visible:outline-2 focus-visible:outline-primary"
        role="group"
        aria-label="Pregunta del CLI"
        data-testid="prompt-card"
        data-kind={d.kind}
        data-status={locked === d.fingerprint || exited ? 'answered' : armed ? 'live' : 'settling'}
        tabIndex={0}
        onKeyDown={(e) => {
          const t = e.target as HTMLElement // digits count on the card itself or an option button, never inside the text field or on Enviar / Abrir terminal
          if (refuse || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key) || !(t === e.currentTarget || t.closest('button[data-n]'))) return
          const o = options.find((x) => x.n === Number(e.key))
          if (o) (e.preventDefault(), press(o))
        }}
      >
        <div className="mb-2"><span className="badge badge-warning badge-soft badge-sm">{KIND[d.kind]}</span></div>
        {plan && !d.truncated ? (
          <div className="mb-2 max-h-56 overflow-auto rounded-box bg-base-100 p-2" data-scroll><Markdown text={plan} /></div>
        ) : (
          d.body.length > 0 && <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-box bg-base-100 p-2 font-mono text-xs" data-scroll>{d.body.join('\n')}</pre>
        )}
        <p className="mb-2 break-words font-semibold">{ask?.question ?? d.question}</p>
        {refuse ? (
          <div role="status" className="flex items-center gap-2 text-xs" data-testid="prompt-refused">
            <span className="min-w-0 flex-1">{refuse}</span>
            <button type="button" className="btn btn-xs" onClick={onTerminal}>Abrir terminal</button>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {options.map((o) => {
              const more = ask?.desc[o.label.trim()] ?? o.more
              return (
                <li key={o.n}>
                  <button
                    type="button"
                    className={`btn btn-ghost btn-block h-auto min-h-9 justify-start gap-3 border bg-base-100 py-1.5 text-left font-normal hover:bg-base-300 ${o.risky ? 'border-warning/60' : 'border-base-300'}`}
                    disabled={off}
                    data-n={o.n}
                    aria-keyshortcuts={String(o.n)}
                    onClick={() => press(o)}
                  >
                    <kbd className="kbd kbd-sm shrink-0">{o.n}</kbd>
                    {o.mode === 'toggle' && <span aria-hidden="true" className="shrink-0">{o.checked ? '☑' : '☐'}</span>}
                    <span className="min-w-0 flex-1 whitespace-normal break-words">{o.label}{more && <span className="block text-xs opacity-60">{more}</span>}</span>
                  </button>
                  {edit === o.n && !off && (
                    <form className="mt-1.5 flex gap-2" onSubmit={(e) => (e.preventDefault(), text.trim() && (void typed(d, o, text), setEdit(null)))}>
                      <input
                        className="input input-sm min-w-0 flex-1"
                        aria-label={`Tu respuesta (${o.label})`}
                        data-testid="prompt-text"
                        maxLength={MAX_TEXT}
                        autoFocus
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEdit(null))}
                      />
                      <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>Enviar</button>
                    </form>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-2">
          {multi && !refuse && <button type="button" className="btn btn-outline btn-sm" disabled={off} title="Pasa a la siguiente pestaña (Tab)" onClick={() => void key(d, { kind: 'next' }, 'Siguiente')}>Siguiente</button>}
          <span className="flex-1" />
          <button type="button" className="btn btn-ghost btn-sm" disabled={off} title="Envía Esc al CLI" onClick={() => void key(d, { kind: 'cancel' }, 'Cancelar')}>Cancelar</button>
        </div>
        {note && (
          <div role="status" className="mt-2 flex items-center gap-2 text-xs" data-testid="prompt-note">
            <span className="min-w-0 flex-1">{note}</span>
            <button type="button" className="btn btn-xs" onClick={onTerminal}>Abrir terminal</button>
          </div>
        )}
      </section>
    </div>
  )
}
