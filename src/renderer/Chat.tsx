import { useEffect, useRef, useState } from 'react'
import { hasCard } from '../shared/prompt'
import { activityText, autoOpenMessage, browse, canType, composerHint, isDialog, sendPlan } from '../shared/composer'
import type { TMeta, TranscriptRef } from '../shared/types'
import { ConversationView } from './Conversation'
import { type PendingAsk, PromptCard } from './Prompt'
import { type Snap, freshScreen, readScreen } from './screens'
import { IconFolder, IconSend, IconStop, type Modal } from './ui'

/** Sent messages per pty (in memory; survives switching tabs and views). */
const histories = new Map<number, string[]>()

/** The classified frame of this pty: re-read ~200 ms after output (throttled while it streams) and every 500 ms as a safety net. */
function useScreen(ptyId: number, exited: boolean): Snap {
  const [s, setS] = useState<Snap>(() => readScreen(ptyId, exited))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      timer = undefined
      const n = readScreen(ptyId, exited)
      setS((p) => (p.state === n.state && p.blank === n.blank && p.dialog?.fingerprint === n.dialog?.fingerprint ? p : n))
    }
    tick()
    const off = window.relay.pty.onData((id) => id === ptyId && !timer && (timer = setTimeout(tick, 200)))
    const iv = setInterval(tick, 500)
    return () => (off(), clearInterval(iv), clearTimeout(timer))
  }, [ptyId, exited])
  return s
}

const MODES: Record<string, string> = { default: 'Manual', acceptEdits: 'Aceptar ediciones', plan: 'Plan', auto: 'Auto' }
const prettyModel = (m: string) => m.replace(/^claude-/, '').replace(/-/g, ' ')
const tokens = (m: TMeta) => (m.tokens ? m.tokens.input + m.tokens.cacheRead + m.tokens.cacheCreate + m.tokens.output : 0)
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Chat of a Claude tab: conversation + notice + activity line + composer. The CLI's terminal stays mounted (hidden) underneath. */
export function ChatPane({ ptyId, r, account, exited, active, showing, modal, onError, onTerminal }: {
  ptyId: number
  r: TranscriptRef
  /** account label for the info row */
  account: string
  exited: boolean
  /** this tab is the selected one */
  active: boolean
  /** the chat (not the terminal view) is the visible one */
  showing: boolean
  modal: Modal
  onError(msg: string): void
  /** switch this tab to the terminal view; `auto` = Relay did it by itself, with this toast text */
  onTerminal(auto?: string): void
}) {
  const screen = useScreen(ptyId, exited)
  const { state } = screen
  const [tool, setTool] = useState<string | null>(null)
  const [meta, setMeta] = useState<TMeta>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<PendingAsk | null>(null)
  const [sent, setSent] = useState(0)
  const hist = useRef(histories.get(ptyId) ?? histories.set(ptyId, []).get(ptyId)!)
  const pos = useRef(hist.current.length)
  const saved = useRef('')
  const ta = useRef<HTMLTextAreaElement>(null)
  const autoDone = useRef(false)
  const flight = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state

  // a screen the chat cannot show (unknown, or a dialog without a card: trust / model / unknown; not blank: the CLI may still be starting) for ~1.5 s: open the real terminal, once per episode
  const card = !!screen.dialog && hasCard(screen.dialog.kind)
  const attention = (isDialog(state) && !card) || state === 'unknown'
  useEffect(() => {
    if (!attention) return void (autoDone.current = false)
    if (!active || screen.blank || autoDone.current || !showing) return
    const t = setTimeout(() => ((autoDone.current = true), onTerminal(autoOpenMessage(stateRef.current))), 1500) // the wording follows the state when it fires, not when the episode began
    return () => clearTimeout(t)
  }, [attention, screen.blank, active, showing])
  useEffect(() => {
    if (active && showing) ta.current?.focus()
  }, [active, showing])

  /** Runs `go` on a frame xterm has fully parsed; main refuses ('stale') when more output arrived since, then it retries on the newer frame. */
  const onFrame = async (go: (f: Snap) => Promise<'ok' | 'stale' | 'gone' | 'blocked'>) => {
    for (let i = 0; i < 3; i++) {
      const r = await go(await freshScreen(ptyId, exited))
      if (r !== 'stale') return r
      await wait(60)
    }
    return 'stale' as const
  }
  const send = async () => {
    const text = draft
    if (!text.trim() || flight.current) return
    flight.current = true
    setBusy(true)
    try {
      const plan = (f: Snap) => sendPlan(f.state, f.bracketed)
      let r = await onFrame(async (f) => (plan(f) === 'send' ? window.relay.pty.send(ptyId, text, f.seq) : 'blocked'))
      if (r === 'blocked') {
        const f = readScreen(ptyId, exited)
        if (plan(f) !== 'confirm') return
        if (f.busy) return onError('El CLI está trabajando: espera a que termine o pulsa Parar antes de enviar.')
        const ok = await modal.confirm('Vaciar la entrada del CLI', 'La caja de entrada del CLI no está vacía (texto sin enviar en la terminal o una lista abierta). Para enviar tu mensaje, Relay la vaciará antes (Ctrl+U). ¿Continuar?', 'Vaciar y enviar', false, true)
        if (!ok) return
        // the frame may have changed while the dialog was open: decide again on a fresh one
        const c = await onFrame(async (g) => (plan(g) === 'confirm' && !g.busy ? window.relay.pty.clear(ptyId, { overlay: g.state === 'overlay' }, g.seq) : 'blocked'))
        if (c !== 'ok') return onError(c === 'blocked' ? 'La pantalla del CLI cambió: revisa la terminal.' : 'No se pudo vaciar la entrada del CLI: abre la terminal.')
        for (let i = 0; i < 20 && plan(readScreen(ptyId, exited)) !== 'send'; i++) await wait(100)
        r = await onFrame(async (g) => (plan(g) === 'send' ? window.relay.pty.send(ptyId, text, g.seq) : 'blocked'))
      }
      if (r === 'gone') return onError('La sesión ya no está activa.')
      if (r !== 'ok') return onError('El CLI no ha mostrado su pantalla todavía o cambió mientras enviabas: no se envió nada. Inténtalo de nuevo o usa «Abrir terminal».')
      hist.current.push(text)
      pos.current = hist.current.length
      setDraft('')
      setSent((n) => n + 1)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      flight.current = false
      setBusy(false)
      ta.current?.focus()
    }
  }

  const stop = () => {
    if (readScreen(ptyId, exited).state === 'working') void window.relay.pty.stop(ptyId).catch(() => undefined)
  }
  const history = (dir: -1 | 1) => {
    const n = browse(hist.current.length, pos.current, dir)
    if (n === pos.current) return false
    if (pos.current === hist.current.length) saved.current = draft
    pos.current = n
    setDraft(n === hist.current.length ? saved.current : hist.current[n]!)
    return true
  }

  const cantSend = sendPlan(state, screen.bracketed) === 'blocked'
  const hint = composerHint(state, screen.bracketed)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat">
      <div className="min-h-0 flex-1">
        <ConversationView key={r.sessionId} r={r} onTool={setTool} onMeta={setMeta} onAsk={setAsk} />
      </div>
      <PromptCard ptyId={ptyId} exited={exited} screen={screen} pending={ask} epoch={sent} onTerminal={() => onTerminal()} />
      {attention && (
        <div role="status" className="alert alert-soft rounded-none py-1 text-xs" data-testid="cli-notice">
          <span>{isDialog(state) ? 'El CLI muestra un aviso o una pregunta que el chat aún no sabe mostrar.' : 'Relay no reconoce lo que muestra el CLI.'}</span>
          <button className="btn btn-xs" onClick={() => onTerminal()}>Abrir terminal</button>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-1 text-xs opacity-70" data-testid="activity" data-state={state}>
        <span aria-hidden="true" className={`status shrink-0 ${state === 'working' ? 'status-primary animate-pulse' : state === 'idle' ? 'status-success' : 'status-warning'}`} />
        <span className="min-w-0 flex-1 truncate">{activityText(state, tool)}</span>
        {(state === 'unknown' || state === 'exited') && <button className="btn btn-xs btn-ghost" onClick={() => onTerminal()}>Abrir terminal</button>}
      </div>
      <div className="px-4 pb-3">
        <form
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-3xl border border-base-300 bg-base-200 py-2 pl-5 pr-2 focus-within:border-primary"
          onSubmit={(e) => (e.preventDefault(), void send())}
        >
          <textarea
            ref={ta}
            className="min-h-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none disabled:opacity-50"
            aria-label="Mensaje"
            data-testid="composer"
            placeholder="Escribe un mensaje…"
            rows={Math.min(6, draft.split('\n').length)}
            disabled={!canType(state) || busy}
            value={draft}
            onChange={(e) => ((pos.current = hist.current.length), setDraft(e.target.value))}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              const el = e.currentTarget
              if (e.key === 'Enter' && !e.shiftKey) return e.preventDefault(), void (!cantSend && send())
              if (e.key === 'ArrowUp' && !el.value.slice(0, el.selectionStart).includes('\n') && history(-1)) e.preventDefault()
              if (e.key === 'ArrowDown' && !el.value.slice(el.selectionEnd).includes('\n') && history(1)) e.preventDefault()
            }}
          />
          {state === 'working' ? (
            <button type="button" className="btn btn-circle btn-sm btn-error btn-soft" aria-label="Parar" title="Parar (envía Esc al CLI)" onClick={stop}><IconStop /></button>
          ) : (
            <button type="submit" className="btn btn-circle btn-sm btn-primary" aria-label="Enviar" title="Enviar (Enter)" disabled={cantSend || busy || !draft.trim()}><IconSend /></button>
          )}
        </form>
        {hint && <p className="mx-auto mt-1 w-full max-w-3xl px-2 text-xs opacity-60" data-testid="composer-hint">{hint}</p>}
        {/* read-only in F6.3; each item is its own span so F6.5 can turn it into a dropdown */}
        <div className="mx-auto mt-1.5 flex w-full max-w-3xl items-center gap-3 px-2 text-xs opacity-60" data-testid="chat-info">
          <span className="flex min-w-0 items-center gap-1" title={r.cwd}><IconFolder /><span className="truncate">{base(r.cwd)}</span></span>
          <span className="badge badge-soft badge-sm max-w-36"><span className="truncate">{account}</span></span>
          <span className="flex-1" />
          {meta.permissionMode && <span data-testid="info-mode">{MODES[meta.permissionMode] ?? meta.permissionMode}</span>}
          {meta.model && <span data-testid="info-model" className="truncate">{prettyModel(meta.model)}</span>}
          {tokens(meta) > 0 && <span data-testid="info-tokens" title="Tokens de la última respuesta (ventana de contexto desconocida)">{tokens(meta) >= 1000 ? `${Math.round(tokens(meta) / 1000)}k` : tokens(meta)} tok</span>}
        </div>
      </div>
    </div>
  )
}
