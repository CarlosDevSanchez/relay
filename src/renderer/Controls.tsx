import { useLayoutEffect, useRef, useState } from 'react'
import type { Cmd } from '../shared/commands'
import { MODE_CYCLE, MODE_LABEL, type Mode, contextInfo } from '../shared/controls'
import { Dropdown, IconChevronUp, IconKebab, type MenuItem } from './ui'

export interface PaletteItem { key: string; label: string; badge?: string; desc?: string }
export const cmdItem = (c: Cmd): PaletteItem => ({ key: c.name, label: `/${c.name}`, desc: c.desc, badge: c.tui ? 'abre un selector' : c.src === 'skill' ? 'skill' : c.src === 'command' ? 'comando' : undefined })

/** Floating list above the composer's activity line (`/` commands or `@` files); the highlighted entry's description sits beside its row. Keys are handled by the composer's textarea; the mouse never takes its focus. */
export function Palette({ items, index, title, onPick, onHover }: { items: PaletteItem[]; index: number; title: string; onPick(i: number): void; onHover(i: number): void }) {
  const cur = items[index]
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState(0)
  const measure = () => {
    const li = list.current?.querySelector<HTMLElement>('[aria-selected=true]')
    if (li && box.current) setPos(Math.max(0, Math.min(li.getBoundingClientRect().top - box.current.getBoundingClientRect().top, box.current.offsetHeight - 96 - 4)))
  }
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
    measure()
  }, [index, items.length])
  return (
    <div ref={box} className="absolute bottom-full left-1/2 z-20 w-full max-w-3xl -translate-x-1/2 px-4 pb-1" data-testid="palette">
      <div className="flex w-80 max-w-full flex-col rounded-box border border-base-300 bg-base-100 shadow-lg">
        <div className="truncate px-3 pb-1 pt-2 text-xs opacity-60">{title}</div>
        <ul ref={list} id="palette-list" role="listbox" aria-label={title} data-scroll onScroll={measure} className="menu max-h-56 w-full flex-nowrap overflow-y-auto p-1">
          {items.map((it, i) => (
            <li key={it.key} id={`palette-opt-${i}`} role="option" aria-selected={i === index}>
              <button type="button" tabIndex={-1} className={`flex gap-2 ${i === index ? 'menu-active' : ''}`} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => onHover(i)} onClick={() => onPick(i)} data-testid="palette-item">
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.badge && <span className="badge badge-soft badge-xs shrink-0">{it.badge}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-base-300 px-3 py-1 text-xs opacity-60">↑↓ navegar · Enter elegir · Esc cerrar</div>
        {cur?.desc && (
          <div data-scroll className="absolute left-[21.5rem] hidden max-h-24 w-64 overflow-hidden rounded-box border border-base-300 bg-base-100 p-3 text-xs shadow-lg sm:block" style={{ top: pos }} data-testid="palette-desc">
            <div className="mb-1 truncate font-medium">{cur.label}</div>
            <div className="line-clamp-3 opacity-80">{cur.desc}</div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Circular progress of the context (tokens of the last response against a static window by model family); unknown window = tokens only. */
export function ContextRing({ model, used }: { model: string | undefined; used: number }) {
  if (used <= 0) return null
  const c = contextInfo(model, used)
  const text = `${c.used.toLocaleString('es')} tokens de contexto`
  const title = c.window ? `${text} (${c.pct}% de ~${Math.round(c.window / 1000)}k, estimado)` : text
  const R = 6.5
  const L = 2 * Math.PI * R
  return (
    <span className="inline-flex items-center gap-1" data-testid="info-context" data-pct={c.pct ?? ''} title={title} aria-label={title} role="img">
      {c.window ? (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" className={c.pct! >= 90 ? 'text-warning' : 'text-primary'}>
          <circle cx="9" cy="9" r={R} stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle cx="9" cy="9" r={R} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(L * c.pct!) / 100} ${L}`} transform="rotate(-90 9 9)" />
        </svg>
      ) : (
        <span>{c.used >= 1000 ? `${Math.round(c.used / 1000)}k` : c.used} tok</span>
      )}
    </span>
  )
}

const MODEL_CHOICES: [string, string, string][] = [['opus', 'Opus', 'opus'], ['sonnet', 'Sonnet', 'sonnet'], ['haiku', 'Haiku', 'haiku'], ['default', 'Predeterminado', '']]
const pretty = (m: string) => m.replace(/^claude-/, '').replace(/-/g, ' ')

/** Mode, model and "…" dropdowns of the controls row. Each item is a user click; the actions live in Chat. */
export function ControlsRow({ mode, model, idle, onMode, onModel, onCompact, onClear }: {
  mode: Mode | string | undefined
  model: string | undefined
  idle: boolean
  onMode(m: Mode): void
  onModel(name: string, label: string): void
  onCompact(): void
  onClear(): void
}) {
  const why = idle ? undefined : 'Disponible cuando el CLI está en reposo'
  const modeItems: MenuItem[] = MODE_CYCLE.map((m) => ({ label: MODE_LABEL[m], active: m === mode, disabled: !idle, title: why, onClick: () => m !== mode && onMode(m) }))
  const modelItems: MenuItem[] = MODEL_CHOICES.map(([name, label, fam]) => ({ label, active: !!fam && !!model && model.toLowerCase().includes(fam), disabled: !idle, title: why, onClick: () => !(!!fam && !!model && model.toLowerCase().includes(fam)) && onModel(name, label) }))
  const moreItems: MenuItem[] = [
    { label: 'Compactar conversación', disabled: !idle, title: why, onClick: onCompact },
    { label: 'Limpiar conversación', disabled: !idle, title: why, danger: true, onClick: onClear }
  ]
  const trig = (id: string, text: string) => (
    <span className="flex items-center gap-1" data-testid={id}>
      <span className="max-w-32 truncate">{text}</span>
      <IconChevronUp />
    </span>
  )
  return (
    <>
      <Dropdown up title="Modo de permisos" btnClass="btn btn-ghost btn-xs font-normal" tip={null} items={modeItems} trigger={trig('info-mode', mode ? (MODE_LABEL[mode as Mode] ?? String(mode)) : 'Modo')} menuClass="w-48" />
      <Dropdown up title="Modelo" btnClass="btn btn-ghost btn-xs font-normal" tip={null} items={modelItems} trigger={trig('info-model', model ? pretty(model) : 'Modelo')} menuClass="w-44" />
      <Dropdown up title="Más acciones" btnClass="btn btn-ghost btn-xs btn-square" tip={null} items={moreItems} trigger={<span data-testid="more-menu"><IconKebab /></span>} menuClass="w-52" />
    </>
  )
}
