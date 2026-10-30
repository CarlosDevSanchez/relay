import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderId } from '../shared/types'
import markSvg from '../../assets/brand/relay-mark.svg?raw'
import logoSvg from '../../assets/brand/relay-logo.svg?raw'

// ---- inline SVG icons (no icon dependency) ----
const Svg = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
export const IconPlus = () => <Svg d="M8 3v10M3 8h10" />
export const IconChevron = ({ open }: { open?: boolean }) => <Svg d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} size={12} />
export const IconChevronUp = () => <Svg d="M4 10l4-4 4 4" size={12} />
export const IconKebab = () => <Svg d="M8 3.5v.01M8 8v.01M8 12.5v.01" size={16} />
export const IconGear = () => <Svg d="M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
export const IconLink = () => <Svg d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1" size={12} />
export const IconFolder = () => <Svg d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />
export const IconSend = () => <Svg size={18} d="M3 8h9M8.5 4l4 4-4 4" />
export const IconStop = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="2" /></svg>

// ---- logo: relay-mark.svg inlined so it follows `currentColor` (brand teal via text-primary); `full` = relay-logo.svg with the wordmark (fixed teal, on a navy chip so it reads in the light theme) ----
export const Logo = ({ size = 20, full = false }: { size?: number; full?: boolean }) => (
  <span data-testid="logo" aria-hidden="true" className={`inline-flex shrink-0 [&>svg]:h-full [&>svg]:w-auto ${full ? 'rounded-box bg-[#1a262c] p-2' : 'text-primary'}`} style={{ height: size }} dangerouslySetInnerHTML={{ __html: full ? logoSvg : markSvg }} />
)

// ---- status dot (daisyUI `status`) ----
export const Dot = ({ tone }: { tone: 'ok' | 'warn' | 'err' | 'off' }) => (
  <span aria-hidden="true" className={`status shrink-0 ${tone === 'ok' ? 'status-success' : tone === 'warn' ? 'status-warning' : tone === 'err' ? 'status-error' : 'status-neutral'}`} />
)

// ---- dropdown menu (daisyUI `dropdown`, focus based: closes on blur) ----
export interface MenuItem {
  label: string
  onClick(): void
  disabled?: boolean
  title?: string
  danger?: boolean
  /** the current choice of a selector */
  active?: boolean
}
export function Dropdown({ trigger, items, title, align = 'right', btnClass = 'btn btn-sm btn-ghost', tip = 'tooltip-bottom', menuClass = 'w-60', up = false }: { trigger: ReactNode; items: MenuItem[]; title?: string; align?: 'left' | 'right'; btnClass?: string; tip?: string | null; menuClass?: string; /** opens upwards (controls under the composer) */ up?: boolean }) {
  return (
    <div className={`dropdown nodrag ${align === 'right' ? 'dropdown-end' : ''} ${up ? 'dropdown-top' : ''}`}>
      {/* tip = null: native title only (a CSS tooltip is laid out wide even while invisible, which widens its scroll container) */}
      {tip === null ? (
        <div tabIndex={0} role="button" aria-haspopup="menu" aria-label={title} title={title} className={`${btnClass} gap-1 focus-visible:outline-2 focus-visible:outline-primary`}>
          {trigger}
        </div>
      ) : (
        <div className={`tooltip ${tip}`} data-tip={title}>
          <div tabIndex={0} role="button" aria-haspopup="menu" aria-label={title} className={`${btnClass} gap-1 focus-visible:outline-2 focus-visible:outline-primary`}>
            {trigger}
          </div>
        </div>
      )}
      <ul tabIndex={0} role="menu" className={`dropdown-content menu z-30 ${up ? 'mb-1' : 'mt-1'} max-w-[calc(100vw-1rem)] ${menuClass} rounded-box border border-base-300 bg-base-100 p-1 shadow-lg`}>
        {items.length === 0 && <li className="menu-disabled"><span>Sin opciones</span></li>}
        {items.map((it) => (
          <li key={it.label} className={it.disabled ? 'menu-disabled' : ''}>
            <button type="button" role="menuitem" disabled={it.disabled} title={it.title} className={`${it.danger ? 'text-error' : ''} ${it.active ? 'menu-active' : ''}`} aria-current={it.active || undefined} onClick={() => ((document.activeElement as HTMLElement | null)?.blur(), it.onClick())}>
              {it.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- modal (native <dialog>, daisyUI `modal`): one component for every dialog ----
// Open modal dialogs, oldest first: a top-layer popover is inert while a modal dialog is open, so toasts render inside the topmost one.
let openDialogs: HTMLDialogElement[] = []
const dialogSubs = new Set<() => void>()
const setOpenDialogs = (f: (l: HTMLDialogElement[]) => HTMLDialogElement[]) => ((openDialogs = f(openDialogs)), dialogSubs.forEach((cb) => cb()))
const topDialog = () => openDialogs.at(-1) ?? null
const subscribeDialogs = (cb: () => void) => (dialogSubs.add(cb), () => void dialogSubs.delete(cb))

/** `guard()` true = Escape is ignored (a dialog that appears on its own must not be closed by a stray key) */
export function Dialog({ label, onClose, children, boxClass = '', guard }: { label: string; onClose(): void; children: ReactNode; boxClass?: string; guard?: () => boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) {
      d.showModal()
      // showModal() focuses the first button; a dialog that appears on its own must start on its safe element
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    setOpenDialogs((l) => [...l, d])
    return () => setOpenDialogs((l) => l.filter((x) => x !== d))
  }, [])
  return (
    <dialog ref={ref} aria-label={label} className="modal" onClose={onClose} onCancel={(e) => guard?.() && e.preventDefault()} onKeyDown={(e) => e.key === 'Escape' && guard?.() && e.preventDefault()}>
      <div className={`modal-box ${boxClass}`}>{children}</div>
      <form method="dialog" className="modal-backdrop">
        <button tabIndex={-1} aria-label="Cerrar">cerrar</button>
      </form>
    </dialog>
  )
}

// ---- toasts (daisyUI `toast` + `alert`); errors and anything with paths stay until dismissed ----
export interface ToastItem {
  id: number
  kind: 'success' | 'error' | 'info' | 'warning'
  text: string
}
export function useToasts() {
  const [list, setList] = useState<ToastItem[]>([])
  const n = useRef(0)
  const dismiss = (id: number) => setList((l) => l.filter((t) => t.id !== id))
  const push = (kind: ToastItem['kind'], text: string, sticky = kind === 'error') => {
    const id = ++n.current
    setList((l) => [...l, { id, kind, text }])
    if (!sticky) setTimeout(() => dismiss(id), 7000)
  }
  return { list, push, dismiss }
}
export type Toasts = ReturnType<typeof useToasts>
const ALERT = { success: 'alert-success', error: 'alert-error', info: 'alert-info', warning: 'alert-warning' }
/** Rendered once: a manual popover (top layer) normally, portaled into the topmost open dialog while one is open (a popover under a modal dialog is inert). */
export function ToastStack({ t }: { t: Toasts }) {
  const ref = useRef<HTMLDivElement>(null)
  const host = useSyncExternalStore(subscribeDialogs, topDialog)
  const n = t.list.length
  useEffect(() => {
    const el = ref.current
    if (!el || host) return
    if (el.matches(':popover-open')) el.hidePopover()
    if (n) el.showPopover()
  }, [n, host])
  const stack = (
    <div ref={ref} {...(host ? {} : { popover: 'manual' as const })} className="toast toast-end toast-bottom max-w-md overflow-visible bg-transparent">
      {t.list.map((x) => (
        <div key={x.id} role="alert" className={`alert ${ALERT[x.kind]} items-start text-sm shadow-lg`}>
          <span className="min-w-0 whitespace-pre-wrap break-words">{x.text}</span>
          <button className="btn btn-ghost btn-xs btn-square" aria-label="Cerrar aviso" onClick={() => t.dismiss(x.id)}>✕</button>
        </div>
      ))}
    </div>
  )
  return host ? createPortal(stack, host) : stack
}

// ---- in-app prompt/confirm (Electron has no window.prompt/confirm/alert) ----
interface Req {
  title: string
  message?: string
  input?: { label: string; initial: string }
  confirm: string
  danger?: boolean
  /** focus Cancelar instead of the confirm button (switching/destructive confirms) */
  safe?: boolean
  /** optional dropdown next to the text input (add-account dialog: provider) */
  choice?: { label: string; options: [value: string, label: string][]; initial: string }
  resolve(v: string | boolean | null | { text: string; choice: string }): void
}

function ModalView({ req, done }: { req: Req; done(v: Parameters<Req['resolve']>[0]): void }) {
  const [text, setText] = useState(req.input?.initial ?? '')
  const [pick, setPick] = useState(req.choice?.initial ?? '')
  const ok = !req.input || text.trim() !== ''
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  return (
    <Dialog label={req.title} onClose={() => done(req.input ? null : false)}>
      <form onSubmit={(e) => (e.preventDefault(), ok && done(req.choice ? { text: text.trim(), choice: pick } : req.input ? text.trim() : true))}>
        <h3 className="text-base font-semibold">{req.title}</h3>
        {req.message && <p className="mt-2 whitespace-pre-wrap text-sm opacity-70">{req.message}</p>}
        {req.input && (
          <fieldset className="fieldset mt-3">
            <legend className="fieldset-legend">{req.input.label}</legend>
            <input ref={ref} className="input w-full" data-autofocus value={text} onChange={(e) => setText(e.target.value)} />
          </fieldset>
        )}
        {req.choice && (
          <fieldset className="fieldset mt-1">
            <legend className="fieldset-legend">{req.choice.label}</legend>
            <select className="select w-full" aria-label={req.choice.label} value={pick} onChange={(e) => setPick(e.target.value)}>
              {req.choice.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </fieldset>
        )}
        <div className="modal-action">
          <button type="button" className="btn btn-ghost" {...(req.safe || req.danger ? { 'data-autofocus': true } : {})} onClick={() => done(req.input ? null : false)}>Cancelar</button>
          <button type="submit" {...(!req.input && !req.safe && !req.danger ? { 'data-autofocus': true } : {})} disabled={!ok} className={`btn ${req.danger ? 'btn-error' : 'btn-primary'}`}>
            {req.confirm}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function useModal() {
  const [req, setReq] = useState<Req | null>(null)
  const ask = (r: Omit<Req, 'resolve'>) => new Promise<Parameters<Req['resolve']>[0]>((resolve) => setReq({ ...r, resolve }))
  return {
    prompt: (title: string, initial = '', label = 'Nombre') => ask({ title, input: { label, initial }, confirm: 'Aceptar' }) as Promise<string | null>,
    /** name + provider; null = cancelled */
    account: (title: string, initial: string, provider: ProviderId) =>
      ask({ title, input: { label: 'Nombre', initial }, choice: { label: 'Proveedor', options: [['claude', 'Claude Code'], ['codex', 'Codex']], initial: provider }, confirm: 'Aceptar' }) as Promise<{ text: string; choice: ProviderId } | null>,
    confirm: (title: string, message: string, confirm = 'Aceptar', danger = false, safe = false) => ask({ title, message, confirm, danger, safe }).then((v) => v === true),
    node: req && <ModalView req={req} done={(v) => (req.resolve(v), setReq(null))} />
  }
}
export type Modal = ReturnType<typeof useModal>

export const ago = (ms: number, now = Date.now()): string => {
  const m = Math.max(0, Math.round((now - ms) / 60000))
  return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`
}
