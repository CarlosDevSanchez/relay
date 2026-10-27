import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Account, AccountStatus, AccountUsage, ProviderId, SessionInfo, UsageWindow } from '../shared/types'
import { fmtReset, liveWindows, usageLevel, windowTitle } from '../shared/usage'
import { NAMES, missingMsg } from './status'
import { Dot, Logo, Dropdown, IconChevron, IconFolder, IconGear, IconKebab, IconLink, IconPlus, ago } from './ui'

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

export interface SidebarProps {
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  active: string | null
  projects: string[]
  cwd: string | null
  sessions: Record<string, SessionInfo[]>
  usage: Record<string, AccountUsage>
  warnAt: number
  /** the provider's CLI is not installed */
  missing(provider: ProviderId | undefined): boolean
  newSession(): void
  selectAccount(id: string): void
  selectProject(p: string): void
  addProject(): void
  addAccount(): void
  resume(p: string, s: SessionInfo): void
  /** project menu: pick an existing transcript to add to Relay's history */
  openExisting(p: string): void
  /** session menu: remove it from Relay's history (transcript untouched) */
  forget(p: string, s: SessionInfo): void
  rename(a: Account): void
  remove(a: Account): void
  login(a: Account): void
  setShared(a: Account, on: boolean): void
  refreshStatus(id: string): void
  openSettings(): void
}

const BAR = { ok: 'progress-success', warning: 'progress-warning', error: 'progress-error' }

// ---- UI preferences (collapsed sections, expanded cards): localStorage only, purely cosmetic, so every access is guarded ----
const UI_KEY = 'relay.ui.sidebar'
interface UiPrefs {
  accounts: boolean
  projects: boolean
  expanded: string[]
}
function loadUi(): UiPrefs {
  try {
    const d = JSON.parse(localStorage.getItem(UI_KEY) ?? '')
    return { accounts: d?.accounts === true, projects: d?.projects === true, expanded: Array.isArray(d?.expanded) ? d.expanded.filter((x: unknown) => typeof x === 'string') : [] }
  } catch {
    return { accounts: false, projects: false, expanded: [] }
  }
}
function useUi(): [UiPrefs, (f: (u: UiPrefs) => UiPrefs) => void] {
  const [ui, set] = useState(loadUi)
  return [
    ui,
    (f) =>
      set((u) => {
        const n = f(u)
        try {
          localStorage.setItem(UI_KEY, JSON.stringify(n))
        } catch {
          // private mode / blocked storage: the preference just does not persist
        }
        return n
      })
  ]
}

/**
 * Height transition via grid rows (motion is cut by the reduced-motion rule in styles.css); `invisible` also removes the content from focus and the a11y tree.
 * The content is clipped (`overflow-clip`, never `hidden`: a hidden box can still be scrolled sideways by focus / scrollIntoView, which pushed the cards out of the sidebar)
 * while closed or moving; once settled open it is not clipped, so dropdown menus and tooltips of the content can overflow.
 */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const [moving, setMoving] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) return void (first.current = false)
    setMoving(true)
    const t = setTimeout(() => setMoving(false), 260)
    return () => clearTimeout(t)
  }, [open])
  return (
    <div className={`grid transition-[grid-template-rows,visibility] duration-200 ${open ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'}`}>
      <div className={`min-h-0 ${open && !moving ? '' : 'overflow-clip'}`}>{children}</div>
    </div>
  )
}

const SectionHeader = ({ title, open, toggle, addLabel, add }: { title: string; open: boolean; toggle(): void; addLabel: string; add(): void }) => (
  <ul className="menu w-full p-0 px-1">
    <li className="menu-title flex-row items-center justify-between pr-1">
      <button className="flex items-center gap-1 rounded text-[11px] uppercase tracking-wide hover:opacity-100 focus-visible:outline-2 focus-visible:outline-primary" aria-expanded={open} aria-label={`${open ? 'Contraer' : 'Expandir'} ${title}`} onClick={toggle}>
        <span className={`transition-transform ${open ? '' : '-rotate-90'}`}><IconChevron open /></span>
        {title}
      </button>
      <span className="tooltip tooltip-left" data-tip={addLabel}>
        <button className="btn btn-ghost btn-xs btn-square" aria-label={addLabel} onClick={add}><IconPlus /></button>
      </span>
    </li>
  </ul>
)

/** The worst bar level of the live windows (drives the dot colour and the compact bars). */
const worst = (ws: UsageWindow[], warnAt: number): 'ok' | 'warning' | 'error' => {
  const l = ws.map((w) => usageLevel(w.pct, warnAt))
  return l.includes('error') ? 'error' : l.includes('warning') ? 'warning' : 'ok'
}
const toneOf = (s: AccountStatus | undefined, ws: UsageWindow[], warnAt: number): 'ok' | 'warn' | 'err' | 'off' => {
  if (s?.loggedIn !== true) return 'off'
  const w = worst(ws, warnAt)
  return s.limited || w === 'error' ? 'err' : w === 'warning' ? 'warn' : 'ok'
}

/** Compact usage: two thin bars side by side; reset times live in the tooltip. */
function MiniBars({ ws, u, warnAt, now }: { ws: UsageWindow[]; u: AccountUsage; warnAt: number; now: number }) {
  const tip = ws.map((w) => `${windowTitle(w.id)} ${Math.round(w.pct)}% · se reinicia ${fmtReset(w.resetsAt, now)}`).join(' | ') + ` · actualizado ${ago(u.updatedAt, now)}`
  return (
    <div className="tooltip tooltip-bottom flex w-full gap-3 text-[11px] before:max-w-56 before:whitespace-normal" data-tip={tip} data-testid="usage-mini">
      {ws.map((w) => (
        <div key={w.id} className="flex min-w-0 flex-1 items-center gap-1" data-testid={`mini-${w.id}`}>
          <span className="opacity-60">{w.id}</span>
          <progress className={`progress h-1 min-w-0 flex-1 ${BAR[usageLevel(w.pct, warnAt)]}`} value={w.pct} max={100} aria-label={`${windowTitle(w.id)} ${Math.round(w.pct)}%`} />
          <span className="w-7 text-right tabular-nums">{Math.round(w.pct)}%</span>
        </div>
      ))}
    </div>
  )
}

function UsageBars({ ws, u, warnAt, now }: { ws: UsageWindow[]; u: AccountUsage | undefined; warnAt: number; now: number }) {
  return (
    <div className="space-y-1.5" data-testid="usage">
      {ws.map((w) => (
        <div key={w.id} data-testid={`usage-${w.id}`}>
          <div className="flex justify-between"><span>{windowTitle(w.id)}</span><b className="tabular-nums">{Math.round(w.pct)}%</b></div>
          <progress className={`progress h-1.5 w-full ${BAR[usageLevel(w.pct, warnAt)]}`} value={w.pct} max={100} aria-label={`${windowTitle(w.id)} ${Math.round(w.pct)}% (detalle)`} />
          <div className="text-[11px] opacity-60">se reinicia {fmtReset(w.resetsAt, now)}{u ? ` · actualizado ${ago(u.updatedAt, now)}` : ''}</div>
        </div>
      ))}
    </div>
  )
}

export function Sidebar(p: SidebarProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [ui, setUi] = useUi()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000) // "actualizado hace X" and expired windows
    return () => clearInterval(t)
  }, [])
  const isOpen = (x: string) => open[x] ?? x === p.cwd
  const label = (id: string) => p.accounts.find((a) => a.id === id)?.label ?? id
  const prov = (id: string) => p.accounts.find((a) => a.id === id)?.provider
  const activeProv = prov(p.active ?? '')
  const toggleCard = (id: string) => setUi((u) => ({ ...u, expanded: u.expanded.includes(id) ? u.expanded.filter((x) => x !== id) : [...u.expanded, id] }))
  const live = (id: string) => liveWindows(p.usage[id]?.windows ?? [], now)
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-base-300 bg-base-200">
      <div className="drag px-3 pb-3 pt-10">
        <div className="mb-3 flex items-center gap-2 px-1 text-base font-semibold tracking-wide"><Logo size={22} /> Relay</div>
        <button className="btn btn-primary nodrag w-full" disabled={p.missing(activeProv)} title={p.missing(activeProv) ? missingMsg(activeProv!) : ''} onClick={p.newSession}>
          <IconPlus /> Nueva sesión
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip px-1 pb-2">
        <SectionHeader title="Cuentas" open={!ui.accounts} toggle={() => setUi((u) => ({ ...u, accounts: !u.accounts }))} addLabel="Agregar cuenta" add={p.addAccount} />
        {ui.accounts && (
          <div className="flex flex-wrap gap-1 px-4 pb-1" data-testid="account-dots">
            {p.accounts.map((a) => {
              const ws = live(a.id)
              const tip = `${a.label}${ws.length ? ` · ${ws.map((w) => `${w.id} ${Math.round(w.pct)}%`).join(' · ')}` : ''}`
              return (
                <span key={a.id} className="tooltip tooltip-right before:max-w-48" data-tip={tip}>
                  <button className={`btn btn-ghost btn-xs btn-square ${a.id === p.active ? 'ring-1 ring-primary' : ''}`} data-testid="account-dot" aria-label={tip} onClick={() => p.selectAccount(a.id)}>
                    <Dot tone={toneOf(p.statuses[a.id], ws, p.warnAt)} />
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <Collapsible open={!ui.accounts}>
          <div className="flex flex-col gap-2 px-2 pb-1">
            {p.accounts.map((a) => {
              const s = p.statuses[a.id]
              const u = p.usage[a.id]
              const ws = live(a.id)
              const expanded = ui.expanded.includes(a.id)
              return (
                <div key={a.id} data-testid="account-card" data-expanded={expanded} onClick={() => p.selectAccount(a.id)} className={`card card-border card-sm lift group cursor-pointer shadow-sm hover:shadow-md ${a.id === p.active ? 'border-primary bg-base-100' : 'bg-base-100/60 hover:bg-base-100'}`}>
                  <div className="card-body gap-1.5 p-2.5">
                    <div className="flex items-center gap-1.5">
                      <Dot tone={toneOf(s, ws, p.warnAt)} />
                      <button className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-primary" onClick={(e) => (e.stopPropagation(), p.selectAccount(a.id))}>{a.label}</button>
                      {s?.plan && <span className="badge badge-soft badge-primary badge-xs uppercase">{s.plan}</span>}
                      <span className="badge badge-ghost badge-xs capitalize" data-testid="provider-badge">{a.provider}</span>
                      <span className="opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                        <Dropdown
                          title="Opciones de cuenta"
                          trigger={<IconKebab />}
                          btnClass="btn btn-ghost btn-xs btn-square"
                          menuClass="w-52"
                          items={[
                            { label: 'Renombrar', onClick: () => p.rename(a) },
                            { label: 'Iniciar sesión', onClick: () => p.login(a), disabled: p.missing(a.provider), title: p.missing(a.provider) ? missingMsg(a.provider) : '' },
                            { label: a.sharedMemory ? 'Desactivar memoria compartida' : 'Activar memoria compartida', onClick: () => p.setShared(a, !a.sharedMemory) },
                            { label: 'Actualizar estado', onClick: () => p.refreshStatus(a.id) },
                            { label: 'Quitar', onClick: () => p.remove(a), danger: true }
                          ]}
                        />
                      </span>
                      <button className="btn btn-ghost btn-xs btn-square" data-testid="card-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Contraer' : 'Expandir'} ${a.label}`} onClick={(e) => (e.stopPropagation(), toggleCard(a.id))}>
                        <span className={`transition-transform ${expanded ? '' : '-rotate-90'}`}><IconChevron open /></span>
                      </button>
                    </div>
                    {!s ? (
                      <div className="space-y-1.5" aria-label="Cargando estado">
                        <div className="skeleton h-2.5 w-3/4" />
                      </div>
                    ) : expanded ? null : ws.length && u ? ( // the expanded card shows the same data in detail
                      <MiniBars ws={ws} u={u} warnAt={p.warnAt} now={now} />
                    ) : (
                      <div className={`truncate text-[11px] ${s.limited ? 'text-warning' : 'opacity-60'}`} data-testid="card-status">
                        {s.limited ? `Limitada hasta ${s.limited.resetText}` : s.loggedIn === null ? 'estado desconocido' : s.loggedIn ? (s.email ?? 'sesión iniciada') : 'sin sesión'}
                      </div>
                    )}
                    <Collapsible open={expanded}>
                      {s && (
                        <div className="space-y-1.5 pt-1 text-xs" data-testid="card-details">
                          <div className="truncate text-[11px] opacity-70">{s.loggedIn === null ? 'estado desconocido' : s.loggedIn ? (s.email ?? 'sesión iniciada') : 'sin sesión'}</div>
                          {s.limited && <div className="text-warning">Limitada hasta {s.limited.resetText}</div>}
                          <UsageBars ws={ws} u={u} warnAt={p.warnAt} now={now} />
                          {a.provider === 'claude' && <div className="text-[11px] opacity-60">{fmt(s.tokens5h)} tokens / 5h{u ? ` · actualizado ${ago(u.updatedAt, now)}` : ''}</div>}
                          {a.sharedMemory && <div className="flex items-center gap-1 text-[11px] opacity-60"><IconLink /> Memoria compartida</div>}
                          {a.drift && <div className="text-warning">Memoria compartida desincronizada; desactívala y vuelve a activarla.</div>}
                        </div>
                      )}
                    </Collapsible>
                  </div>
                </div>
              )
            })}
          </div>
        </Collapsible>
        <div className="mt-2" />
        <SectionHeader title="Proyectos" open={!ui.projects} toggle={() => setUi((u) => ({ ...u, projects: !u.projects }))} addLabel="Agregar proyecto" add={p.addProject} />
        {ui.projects && (
          <div className="flex flex-wrap gap-1 px-4 pb-1" data-testid="project-dots">
            {p.projects.map((x) => (
              <span key={x} className="tooltip tooltip-right before:max-w-48" data-tip={base(x)}>
                <button className={`btn btn-ghost btn-xs btn-square ${x === p.cwd ? 'ring-1 ring-primary' : ''}`} aria-label={base(x)} onClick={() => p.selectProject(x)}>
                  <span aria-hidden="true" className={`status ${x === p.cwd ? 'status-primary' : 'status-neutral'}`} />
                </button>
              </span>
            ))}
          </div>
        )}
        <Collapsible open={!ui.projects}>
          <ul className="menu w-full p-0 px-1">
            {p.projects.length === 0 && <li className="menu-disabled"><span>Sin proyectos</span></li>}
            {p.projects.map((x) => (
              <li key={x}>
                <details open={isOpen(x)}>
                  <summary title={x} className={x === p.cwd ? 'menu-active' : ''} onClick={(e) => (e.preventDefault(), setOpen((o) => ({ ...o, [x]: !isOpen(x) })), p.selectProject(x))}>
                    <IconFolder /> <span className="min-w-0 flex-1 truncate">{base(x)}</span>
                    <span onClick={(e) => (e.preventDefault(), e.stopPropagation())}>
                      <Dropdown title="Opciones de proyecto" trigger={<IconKebab />} btnClass="btn btn-ghost btn-xs btn-square" items={[{ label: 'Abrir sesión existente…', onClick: () => p.openExisting(x) }]} />
                    </span>
                  </summary>
                  <ul>
                    {(p.sessions[x] ?? []).length === 0 && <li className="menu-disabled"><span className="text-xs">Sin sesiones</span></li>}
                    {(p.sessions[x] ?? []).map((s) => (
                      <li key={`${s.accountId}${s.id}`} className={p.missing(prov(s.accountId)) ? 'menu-disabled' : ''}>
                        <div className="flex items-center gap-0 p-0">
                          <button onClick={() => p.resume(x, s)} disabled={p.missing(prov(s.accountId))} className="flex min-w-0 flex-1 flex-col items-start gap-0 px-3 py-1.5 text-left">
                            <span className="w-full truncate text-xs font-medium">{s.title}</span>
                            <span className="text-[11px] opacity-60">{label(s.accountId)} · {ago(s.mtimeMs)}{s.handoffs?.length ? ` · ↪ ${label(s.handoffs.at(-1)!.from)} → ${label(s.handoffs.at(-1)!.to)}` : ''}</span>
                          </button>
                          <Dropdown title="Opciones de sesión" trigger={<IconKebab />} btnClass="btn btn-ghost btn-xs btn-square" items={[{ label: 'Quitar del historial de Relay', onClick: () => p.forget(x, s), danger: true }]} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </Collapsible>
      </div>
      <div className="border-t border-base-300 p-2">
        <button className="btn btn-ghost w-full justify-start" onClick={p.openSettings}><IconGear /> Configuración</button>
      </div>
    </aside>
  )
}
