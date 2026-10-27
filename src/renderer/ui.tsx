import { type ReactNode, useEffect, useRef, useState } from 'react'

// ---- inline SVG icons (no icon dependency) ----
const Svg = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
export const IconPlus = () => <Svg d="M8 3v10M3 8h10" />
export const IconChevron = ({ open }: { open?: boolean }) => <Svg d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} size={12} />
export const IconKebab = () => <Svg d="M8 3.5v.01M8 8v.01M8 12.5v.01" size={16} />
export const IconGear = () => <Svg d="M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
export const IconLink = () => <Svg d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1" size={12} />
export const IconFolder = () => <Svg d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />

// ---- status dot ----
export const Dot = ({ tone }: { tone: 'ok' | 'warn' | 'off' }) => (
  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-white/30'}`} />
)

// ---- dropdown menu ----
export interface MenuItem {
  label: string
  onClick(): void
  disabled?: boolean
  title?: string
  danger?: boolean
}
export function Dropdown({ trigger, items, title, align = 'right' }: { trigger: ReactNode; items: MenuItem[]; title?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="nodrag relative inline-block">
      <button className="btn flex items-center gap-1" title={title} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div role="menu" className={`absolute z-30 mt-1 min-w-44 rounded-card border border-line bg-surface py-1 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}>
            {items.length === 0 && <div className="px-3 py-1.5 text-xs text-muted">Sin opciones</div>}
            {items.map((it) => (
              <button
                key={it.label}
                role="menuitem"
                disabled={it.disabled}
                title={it.title}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent ${it.danger ? 'text-bad' : ''}`}
                onClick={() => (setOpen(false), it.onClick())}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  )
}

// ---- in-app modal (Electron has no window.prompt/confirm/alert) ----
interface Req {
  title: string
  message?: string
  input?: { label: string; initial: string }
  confirm: string
  danger?: boolean
  resolve(v: string | boolean | null): void
}

function ModalView({ req, done }: { req: Req; done(v: string | boolean | null): void }) {
  const [text, setText] = useState(req.input?.initial ?? '')
  const ok = !req.input || text.trim() !== ''
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => ref.current?.querySelector('input')?.select(), [])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), done(req.input ? null : false))}>
      <form
        ref={ref}
        role="dialog"
        aria-label={req.title}
        className="w-96 rounded-card border border-line bg-surface p-4 text-sm"
        onSubmit={(e) => (e.preventDefault(), ok && done(req.input ? text.trim() : true))}
      >
        <b>{req.title}</b>
        {req.message && <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{req.message}</p>}
        {req.input && (
          <label className="mt-3 block text-xs text-muted">
            {req.input.label}
            <input className="input mt-1" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => done(req.input ? null : false)}>Cancelar</button>
          <button type="submit" autoFocus={!req.input} disabled={!ok} className={req.danger ? 'btn border-bad text-bad' : 'btn-primary'}>
            {req.confirm}
          </button>
        </div>
      </form>
    </div>
  )
}

export function useModal() {
  const [req, setReq] = useState<Req | null>(null)
  const ask = (r: Omit<Req, 'resolve'>) => new Promise<string | boolean | null>((resolve) => setReq({ ...r, resolve }))
  return {
    prompt: (title: string, initial = '', label = 'Nombre') => ask({ title, input: { label, initial }, confirm: 'Aceptar' }) as Promise<string | null>,
    confirm: (title: string, message: string, confirm = 'Aceptar', danger = false) => ask({ title, message, confirm, danger }).then((v) => v === true),
    node: req && <ModalView req={req} done={(v) => (req.resolve(v), setReq(null))} />
  }
}
export type Modal = ReturnType<typeof useModal>

export const ago = (ms: number, now = Date.now()): string => {
  const m = Math.max(0, Math.round((now - ms) / 60000))
  return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`
}
