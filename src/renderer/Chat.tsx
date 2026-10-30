import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hasCard } from '../shared/prompt'
import { activityText, autoOpenMessage, browse, canType, composerHint, isDialog, sendPlan } from '../shared/composer'
import { BUILTIN, type Cmd, atToken, filterCmds, filterFiles, insertAt, mergeCmds, opensTui, slashQuery } from '../shared/commands'
import { type Mode, MODE_LABEL, cycleMode, passesAuto, tokenCount } from '../shared/controls'
import type { TMeta, TranscriptRef } from '../shared/types'
import { ContextRing, ControlsRow, Palette, cmdItem } from './Controls'
import { ConversationView } from './Conversation'
import { type PendingAsk, PromptCard } from './Prompt'
import { type Snap, freshScreen, readScreen } from './screens'
import { Dropdown, IconFolder, IconPlus, IconSend, IconStop, type Modal } from './ui'

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
      setS((p) => (p.state === n.state && p.blank === n.blank && p.mode === n.mode && p.dialog?.fingerprint === n.dialog?.fingerprint ? p : n))
    }
    tick()
    const off = window.relay.pty.onData((id) => id === ptyId && !timer && (timer = setTimeout(tick, 200)))
    const iv = setInterval(tick, 500)
    return () => (off(), clearInterval(iv), clearTimeout(timer))
  }, [ptyId, exited])
  return s
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Chat of a Claude tab: conversation + notice + activity line + composer. The CLI's terminal stays mounted (hidden) underneath. */
export function ChatPane({ ptyId, r, account, shared, exited, active, showing, modal, onError, onTerminal }: {
  ptyId: number
  r: TranscriptRef
  /** account label for the info row */
  account: string
  /** the account linked the shared store: its commands and skills apply here */
  shared: boolean
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
  const [caret, setCaret] = useState(0)
  const [sel, setSel] = useState(0)
  const [closed, setClosed] = useState<string | null>(null)
  const [custom, setCustom] = useState<Cmd[]>([])
  const [files, setFiles] = useState<string[]>([])
  const nextCaret = useRef<number | null>(null)
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
  /** Writes `text` to the CLI (one bracketed paste + Enter, built in main). `composer` = may ask to empty the CLI's box; the controls only act on an idle screen. True = sent. */
  const deliver = async (text: string, composer: boolean): Promise<boolean> => {
    if (!text.trim() || flight.current) return false
    flight.current = true
    setBusy(true)
    const fail = (msg: string) => (onError(msg), false)
    try {
      const plan = (f: Snap) => sendPlan(f.state, f.bracketed)
      let r = await onFrame(async (f) => (plan(f) === 'send' ? window.relay.pty.send(ptyId, text, f.seq) : 'blocked'))
      if (r === 'blocked') {
        const f = readScreen(ptyId, exited)
        if (!composer) return fail('El CLI no está en reposo: no se envió nada.')
        if (plan(f) !== 'confirm') return false
        if (f.busy) return fail('El CLI está trabajando: espera a que termine o pulsa Parar antes de enviar.')
        const ok = await modal.confirm('Vaciar la entrada del CLI', 'La caja de entrada del CLI no está vacía (texto sin enviar en la terminal o una lista abierta). Para enviar tu mensaje, Relay la vaciará antes (Ctrl+U). ¿Continuar?', 'Vaciar y enviar', false, true)
        if (!ok) return false
        // the frame may have changed while the dialog was open: decide again on a fresh one
        const c = await onFrame(async (g) => (plan(g) === 'confirm' && !g.busy ? window.relay.pty.clear(ptyId, { overlay: g.state === 'overlay' }, g.seq) : 'blocked'))
        if (c !== 'ok') return fail(c === 'blocked' ? 'La pantalla del CLI cambió: revisa la terminal.' : 'No se pudo vaciar la entrada del CLI: abre la terminal.')
        for (let i = 0; i < 20 && plan(readScreen(ptyId, exited)) !== 'send'; i++) await wait(100)
        r = await onFrame(async (g) => (plan(g) === 'send' ? window.relay.pty.send(ptyId, text, g.seq) : 'blocked'))
      }
      if (r === 'gone') return fail('La sesión ya no está activa.')
      if (r === 'blocked' && plan(readScreen(ptyId, exited)) === 'confirm') return fail('La entrada del CLI sigue con texto tras vaciarla (Ctrl+U): no se envió nada. Revísala con «Abrir terminal».')
      if (r !== 'ok') return fail('El CLI no ha mostrado su pantalla todavía o cambió mientras enviabas: no se envió nada. Inténtalo de nuevo o usa «Abrir terminal».')
      setSent((n) => n + 1)
      return true
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    } finally {
      flight.current = false
      setBusy(false)
      ta.current?.focus()
    }
  }
  /** After a slash command went in: a picker/screen command opens the terminal; a command whose text is still sitting in the CLI's box (the paste did not run it: unverified with the real CLI) opens it too. Nothing more is sent. */
  const afterSlash = async (text: string) => {
    if (opensTui(text)) return onTerminal(`${text.trim()} abre un selector del CLI: se abrió la terminal para que elijas.`)
    for (let i = 0, hits = 0; i < 10; i++) {
      await wait(300)
      const st = readScreen(ptyId, exited).state
      hits = st === 'input-pending' || st === 'overlay' ? hits + 1 : 0
      if (hits >= 2) return onTerminal(`El CLI no ejecutó ${text.trim().split(/\s/)[0]}: el texto quedó en su entrada. Revísalo en la terminal.`)
    }
  }
  const send = async () => {
    const text = draft
    if (!(await deliver(text, true))) return
    hist.current.push(text)
    pos.current = hist.current.length
    setDraft('')
    if (text.startsWith('/')) void afterSlash(text)
  }
  /** A control: the whole command as text, only from an idle screen (box empty), nothing else touched. */
  const command = async (text: string) => {
    if (readScreen(ptyId, exited).state !== 'idle') return onError('Espera a que el CLI termine para usar este control.')
    if (await deliver(text, false)) void afterSlash(text)
  }
  const confirmed = (title: string, msg: string, ok: string, danger = false) => modal.confirm(title, msg, ok, danger, true)
  const changeModel = async (name: string, label: string) => {
    if (!(await confirmed('Cambiar el modelo', `Esto cambia el modelo predeterminado de la cuenta «${account}» para las sesiones nuevas, no solo para esta (lo guarda el propio CLI con /model). Se enviará: /model ${name}`, `Cambiar a ${label}`))) return
    await command(`/model ${name}`)
  }
  const clearChat = async () => {
    if (!(await confirmed('Limpiar la conversación', 'El CLI empieza una conversación nueva (/clear): esta sesión cambia de id y el chat de ahora deja de seguirse. La anterior queda en el historial y se puede reanudar. ¿Continuar?', 'Limpiar', true))) return
    await command('/clear')
  }
  const changeMode = async (target: Mode) => {
    if (flight.current) return onError('Espera a que el CLI termine para cambiar el modo.')
    flight.current = true
    setBusy(true)
    let crossed = false
    try {
      const f0 = await freshScreen(ptyId, exited) // decide on a fresh frame, never on the last poll
      if (f0.state !== 'idle') return onError('Espera a que el CLI termine para cambiar el modo.')
      const from = f0.mode
      if (!from) return onTerminal('Relay no pudo leer el modo de permisos en el pie del CLI: se abrió la terminal, no se envió nada.')
      if (from === target) return
      // Shift+Tab only goes forward: Plan -> Manual passes through Auto, and a stop on the way would leave the CLI there
      crossed = passesAuto(from, target)
      if (crossed && !(await confirmed('Cambiar a modo Auto', target === 'auto' ? 'En modo Auto el CLI ejecuta herramientas sin pedirte permiso en cada paso. ¿Cambiar a Auto?' : `El CLI solo avanza el modo con Shift+Tab: para llegar a ${MODE_LABEL[target]} pasa un momento por el modo Auto, en el que ejecuta herramientas sin pedirte permiso, y si algo falla en medio podría quedarse en Auto. ¿Continuar?`, target === 'auto' ? 'Cambiar a Auto' : 'Continuar', true))) return
      const { res, mode } = await cycleMode(target, {
        read: () => freshScreen(ptyId, exited),
        press: (seq) => window.relay.pty.key(ptyId, seq, 'shift-tab'),
        after: async (prev) => {
          let f = await freshScreen(ptyId, exited)
          for (let i = 0; i < 15 && (!f.mode || f.mode === prev); i++) (await wait(100), (f = await freshScreen(ptyId, exited)))
          return f
        }
      }, from)
      const auto = crossed ? ' Pasó por el modo Auto: comprueba el modo en la terminal.' : ''
      if (res !== 'done' && mode === 'auto' && target !== 'auto') {
        onTerminal()
        onError('El CLI quedó en modo Auto: cámbialo en la terminal (Shift+Tab hasta el modo que quieras).')
      } else if (res === 'unreadable' || res === 'unchanged') onTerminal(`Relay no pudo comprobar el modo de permisos en el pie del CLI: se abrió la terminal, no se envió nada más.${auto}`)
      else if (res !== 'done') onError((res === 'gave-up' ? `No se llegó al modo ${MODE_LABEL[target]} tras 4 pulsaciones: revisa el pie en la terminal.` : res === 'gone' ? 'La sesión ya no está activa.' : res === 'changed' ? 'El modo del CLI cambió mientras confirmabas: no se envió nada.' : 'El CLI no estaba en reposo: no se cambió el modo.') + auto)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      if (readScreen(ptyId, exited).mode === 'auto' && target !== 'auto') (onTerminal(), onError('El CLI quedó en modo Auto: cámbialo en la terminal.'))
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

  useEffect(() => {
    void window.relay.catalog.list().then((l) => setCustom(mergeCmds(l, r.accountId, shared))).catch(() => undefined)
  }, [r.accountId, shared])
  // `/` palette (draft is `/name`) or `@` autocomplete (token before the caret): both only fill the composer
  const q = slashQuery(draft)
  const tok = q === null ? atToken(draft, caret) : null
  useEffect(() => {
    if (tok) void window.relay.files.list(ptyId).then(setFiles).catch(() => setFiles([]))
  }, [!!tok, ptyId])
  useEffect(() => setSel(0), [q, tok?.query])
  const slash = q === null ? [] : filterCmds([...BUILTIN, ...custom], q)
  const fileList = tok ? filterFiles(files, tok.query) : []
  const items = q === null ? fileList.map((f) => ({ key: f, label: f })) : slash.map(cmdItem)
  const palette = canType(state) && !busy && items.length > 0 && closed !== draft
  const index = Math.min(sel, items.length - 1)
  const pick = (i: number) => {
    if (q !== null) {
      const c = slash[i]
      if (!c) return
      setDraft(`/${c.name} `)
      nextCaret.current = c.name.length + 2
    } else if (tok && fileList[i]) {
      const n = insertAt(draft, tok, fileList[i]!)
      setDraft(n.text)
      nextCaret.current = n.caret
    }
    pos.current = hist.current.length
    ta.current?.focus()
  }
  useLayoutEffect(() => {
    const c = nextCaret.current
    if (c === null || !ta.current) return
    nextCaret.current = null
    ta.current.setSelectionRange(c, c)
    setCaret(c)
  })
  const attach = () => {
    const c = ta.current?.selectionStart ?? draft.length
    const pre = draft.slice(0, c)
    const gap = pre && !/\s$/.test(pre) ? ' ' : ''
    setDraft(`${pre}${gap}@${draft.slice(c)}`)
    nextCaret.current = c + gap.length + 1
    ta.current?.focus()
  }
  const commands = () => {
    if (!draft) (setDraft('/'), (nextCaret.current = 1))
    else if (q === null) onError('Los comandos se eligen al inicio del mensaje: vacía el mensaje primero.')
    setClosed(null)
    ta.current?.focus()
  }
  const typable = canType(state) && !busy
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
      <div className="relative">
      {palette && <Palette items={items} index={index} title={q === null ? 'Archivos del proyecto' : 'Comandos'} onPick={pick} onHover={setSel} />}
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-1 text-xs opacity-70" data-testid="activity" data-state={state}>
        <span aria-hidden="true" className={`status shrink-0 ${state === 'working' ? 'status-primary animate-pulse' : state === 'idle' ? 'status-success' : 'status-warning'}`} />
        <span className="min-w-0 flex-1 truncate">{activityText(state, tool)}</span>
        {(state === 'unknown' || state === 'exited') && <button className="btn btn-xs btn-ghost" onClick={() => onTerminal()}>Abrir terminal</button>}
      </div>
      </div>
      <div className="px-4 pb-3">
        <div className="relative mx-auto w-full max-w-3xl">
          <form
            className="flex items-end gap-1 rounded-3xl border border-base-300 bg-base-200 py-2 pl-2 pr-2 focus-within:border-primary"
            onSubmit={(e) => (e.preventDefault(), void send())}
          >
            <Dropdown
              up
              align="left"
              title="Añadir"
              tip={null}
              btnClass="btn btn-circle btn-ghost btn-sm"
              menuClass="w-48"
              trigger={<span data-testid="plus-menu"><IconPlus /></span>}
              items={[
                { label: 'Adjuntar archivo…', disabled: !typable, onClick: attach },
                { label: 'Comandos /', disabled: !typable, onClick: commands }
              ]}
            />
            <textarea
              ref={ta}
              className="min-h-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none disabled:opacity-50"
              aria-label="Mensaje"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={palette}
              aria-controls="palette-list"
              aria-activedescendant={palette ? `palette-opt-${index}` : undefined}
              data-testid="composer"
              placeholder="Escribe un mensaje…  (/ comandos, @ archivos)"
              rows={Math.min(6, draft.split('\n').length)}
              disabled={!canType(state) || busy}
              value={draft}
              onChange={(e) => ((pos.current = hist.current.length), setDraft(e.target.value), setCaret(e.target.selectionStart))}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                const el = e.currentTarget
                if (palette) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return e.preventDefault(), setSel((index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
                  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') return e.preventDefault(), pick(index)
                  if (e.key === 'Escape') return e.preventDefault(), setClosed(draft)
                }
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
        </div>
        {hint && <p className="mx-auto mt-1 w-full max-w-3xl px-2 text-xs opacity-60" data-testid="composer-hint">{hint}</p>}
        <div className="mx-auto mt-1.5 flex w-full max-w-3xl items-center gap-1 px-1 text-xs opacity-80" data-testid="chat-info">
          <span className="flex min-w-0 items-center gap-1 px-1 opacity-70" title={r.cwd}><IconFolder /><span className="truncate">{base(r.cwd)}</span></span>
          <span className="badge badge-soft badge-sm max-w-36"><span className="truncate">{account}</span></span>
          <span className="flex-1" />
          <ControlsRow mode={screen.mode ?? meta.permissionMode} model={meta.model} idle={state === 'idle' && !busy} onMode={(m) => void changeMode(m)} onModel={(n, l) => void changeModel(n, l)} onCompact={() => void command('/compact')} onClear={() => void clearChat()} />
          <ContextRing model={meta.model} used={tokenCount(meta.tokens)} />
        </div>
      </div>
    </div>
  )
}
