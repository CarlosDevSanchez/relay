import { useState } from 'react'
import type { Account, AccountStatus, SessionInfo } from '../shared/types'
import { CLAUDE_MISSING } from './status'
import { Dot, Dropdown, IconFolder, IconGear, IconKebab, IconLink, IconPlus, ago } from './ui'

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

export interface SidebarProps {
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  active: string | null
  projects: string[]
  cwd: string | null
  sessions: Record<string, SessionInfo[]>
  claudeMissing: boolean
  newSession(): void
  selectAccount(id: string): void
  selectProject(p: string): void
  addProject(): void
  addAccount(): void
  resume(p: string, s: SessionInfo): void
  rename(a: Account): void
  remove(a: Account): void
  login(a: Account): void
  setShared(a: Account, on: boolean): void
  refreshStatus(id: string): void
  openSettings(): void
}

export function Sidebar(p: SidebarProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (x: string) => open[x] ?? x === p.cwd
  const label = (id: string) => p.accounts.find((a) => a.id === id)?.label ?? id
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-base-300 bg-base-200">
      <div className="drag px-3 pb-3 pt-10">
        <div className="mb-3 flex items-center gap-2 px-1 text-base font-semibold tracking-wide"><span className="status status-primary" aria-hidden="true" /> Relay</div>
        <button className="btn btn-primary nodrag w-full" disabled={p.claudeMissing} title={p.claudeMissing ? CLAUDE_MISSING : ''} onClick={p.newSession}>
          <IconPlus /> Nueva sesión
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ul className="menu w-full p-0">
          <li className="menu-title flex-row items-center justify-between pr-1">
            Cuentas
            <span className="tooltip tooltip-left" data-tip="Agregar cuenta">
              <button className="btn btn-ghost btn-xs btn-square" aria-label="Agregar cuenta" onClick={p.addAccount}><IconPlus /></button>
            </span>
          </li>
        </ul>
        <div className="space-y-2 px-1">
          {p.accounts.map((a) => {
            const s = p.statuses[a.id]
            const tone = s?.loggedIn === true ? (s.limited ? 'warn' : 'ok') : 'off'
            return (
              <div key={a.id} data-testid="account-card" onClick={() => p.selectAccount(a.id)} className={`card card-border card-sm lift cursor-pointer shadow-sm hover:shadow-md ${a.id === p.active ? 'border-primary bg-base-100' : 'bg-base-100/60 hover:bg-base-100'}`}>
                <div className="card-body gap-1 p-3">
                  <div className="flex items-center gap-2">
                    <Dot tone={tone} />
                    <b className="min-w-0 flex-1 truncate text-sm">{a.label}</b>
                    {s?.plan && <span className="badge badge-soft badge-primary badge-sm uppercase">{s.plan}</span>}
                    {a.sharedMemory && <span className="tooltip tooltip-left opacity-60" data-tip="Memoria compartida"><IconLink /></span>}
                    <span onClick={(e) => e.stopPropagation()}>
                      <Dropdown
                        title="Opciones de cuenta"
                        trigger={<IconKebab />}
                        btnClass="btn btn-ghost btn-xs btn-square"
                        items={[
                          { label: 'Renombrar', onClick: () => p.rename(a) },
                          { label: 'Iniciar sesión', onClick: () => p.login(a), disabled: p.claudeMissing && a.provider === 'claude', title: p.claudeMissing ? CLAUDE_MISSING : '' },
                          ...(a.provider === 'claude' ? [{ label: a.sharedMemory ? 'Desactivar memoria compartida' : 'Activar memoria compartida', onClick: () => p.setShared(a, !a.sharedMemory) }] : []),
                          { label: 'Actualizar estado', onClick: () => p.refreshStatus(a.id) },
                          { label: 'Quitar', onClick: () => p.remove(a), danger: true }
                        ]}
                      />
                    </span>
                  </div>
                  {!s ? (
                    <div className="space-y-1.5 pt-1" aria-label="Cargando estado">
                      <div className="skeleton h-3 w-3/4" />
                      <div className="skeleton h-3 w-1/2" />
                    </div>
                  ) : (
                    <div className="text-xs">
                      <div className="truncate opacity-70">{s.loggedIn === null ? 'estado desconocido' : s.loggedIn ? (s.email ?? 'sesión iniciada') : 'sin sesión'}</div>
                      {s.limited && <div className="text-warning">Limitada hasta {s.limited.resetText}</div>}
                      <div className="opacity-60">{fmt(s.tokens5h)} tokens / 5h</div>
                    </div>
                  )}
                  {a.drift && <div className="text-xs text-warning">Memoria compartida desincronizada; desactívala y vuelve a activarla.</div>}
                </div>
              </div>
            )
          })}
        </div>
        <ul className="menu mt-3 w-full p-0">
          <li className="menu-title flex-row items-center justify-between pr-1">
            Proyectos
            <span className="tooltip tooltip-left" data-tip="Agregar proyecto">
              <button className="btn btn-ghost btn-xs btn-square" aria-label="Agregar proyecto" onClick={p.addProject}><IconPlus /></button>
            </span>
          </li>
          {p.projects.length === 0 && <li className="menu-disabled"><span>Sin proyectos</span></li>}
          {p.projects.map((x) => (
            <li key={x}>
              <details open={isOpen(x)}>
                <summary title={x} className={x === p.cwd ? 'menu-active' : ''} onClick={(e) => (e.preventDefault(), setOpen((o) => ({ ...o, [x]: !isOpen(x) })), p.selectProject(x))}>
                  <IconFolder /> <span className="truncate">{base(x)}</span>
                </summary>
                <ul>
                  {(p.sessions[x] ?? []).length === 0 && <li className="menu-disabled"><span className="text-xs">Sin sesiones</span></li>}
                  {(p.sessions[x] ?? []).map((s) => (
                    <li key={`${s.accountId}${s.id}`} className={p.claudeMissing ? 'menu-disabled' : ''}>
                      <button onClick={() => p.resume(x, s)} disabled={p.claudeMissing} className="flex-col items-start gap-0 text-left">
                        <span className="w-full truncate text-xs font-medium">{s.title}</span>
                        <span className="text-[11px] opacity-60">{label(s.accountId)} · {ago(s.mtimeMs)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-base-300 p-2">
        <button className="btn btn-ghost w-full justify-start" onClick={p.openSettings}><IconGear /> Configuración</button>
      </div>
    </aside>
  )
}
