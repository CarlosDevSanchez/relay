import { useState } from 'react'
import type { Account, AccountStatus, SessionInfo } from '../shared/types'
import { CLAUDE_MISSING } from './status'
import { Dot, Dropdown, IconChevron, IconFolder, IconGear, IconKebab, IconLink, IconPlus, ago } from './ui'

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
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="drag px-3 pb-3 pt-10">
        <div className="mb-3 text-sm font-semibold tracking-wide">Relay</div>
        <button className="btn-primary flex w-full items-center justify-center gap-1" disabled={p.claudeMissing} title={p.claudeMissing ? CLAUDE_MISSING : ''} onClick={p.newSession}>
          <IconPlus /> Nueva sesión
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        <Section title="Cuentas" action={<button className="btn px-1.5" title="Agregar cuenta" aria-label="Agregar cuenta" onClick={p.addAccount}><IconPlus /></button>}>
          {p.accounts.map((a) => {
            const s = p.statuses[a.id]
            const tone = s?.loggedIn === true ? (s.limited ? 'warn' : 'ok') : 'off'
            return (
              <div key={a.id} data-testid="account-card" onClick={() => p.selectAccount(a.id)} className={`mb-2 cursor-pointer rounded-card border p-2 text-xs ${a.id === p.active ? 'border-accent/60 bg-white/[0.06]' : 'border-line bg-white/[0.02] hover:bg-white/5'}`}>
                <div className="flex items-center gap-2">
                  <Dot tone={tone} />
                  <b className="min-w-0 flex-1 truncate text-sm">{a.label}</b>
                  {s?.plan && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase text-muted">{s.plan}</span>}
                  {a.sharedMemory && <span title="Memoria compartida" className="text-muted"><IconLink /></span>}
                  <span onClick={(e) => e.stopPropagation()}>
                    <Dropdown
                      title="Opciones de cuenta"
                      trigger={<IconKebab />}
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
                <div className="mt-1 truncate text-muted">{!s ? '…' : s.loggedIn === null ? 'estado desconocido' : s.loggedIn ? (s.email ?? 'sesión iniciada') : 'sin sesión'}</div>
                {s?.limited && <div className="text-warn">Limitada hasta {s.limited.resetText}</div>}
                {s && <div className="text-muted">{fmt(s.tokens5h)} tokens / 5h</div>}
                {a.drift && <div className="text-warn">Memoria compartida desincronizada; desactívala y vuelve a activarla.</div>}
              </div>
            )
          })}
        </Section>
        <Section title="Proyectos" action={<button className="btn px-1.5" title="Agregar proyecto" aria-label="Agregar proyecto" onClick={p.addProject}><IconPlus /></button>}>
          {p.projects.length === 0 && <div className="text-xs text-muted">Sin proyectos</div>}
          {p.projects.map((x) => (
            <div key={x} className="mb-1">
              <button title={x} onClick={() => (setOpen((o) => ({ ...o, [x]: !isOpen(x) })), p.selectProject(x))} className={`flex w-full items-center gap-1 rounded-card px-1 py-1 text-left text-sm hover:bg-white/5 ${x === p.cwd ? 'text-fg' : 'text-muted'}`}>
                <IconChevron open={isOpen(x)} /> <IconFolder /> <span className="truncate">{base(x)}</span>
              </button>
              {isOpen(x) && (
                <div className="ml-4">
                  {(p.sessions[x] ?? []).length === 0 && <div className="px-1 py-1 text-xs text-muted">Sin sesiones</div>}
                  {(p.sessions[x] ?? []).map((s) => (
                    <button key={`${s.accountId}${s.id}`} onClick={() => p.resume(x, s)} disabled={p.claudeMissing} className="block w-full rounded-card px-1 py-1 text-left text-xs hover:bg-white/5 disabled:opacity-50">
                      <div className="truncate">{s.title}</div>
                      <div className="text-muted">{label(s.accountId)} · {ago(s.mtimeMs)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Section>
      </div>
      <div className="border-t border-line px-3 py-2">
        <button className="btn flex w-full items-center gap-2" onClick={p.openSettings}><IconGear /> Configuración</button>
      </div>
    </aside>
  )
}

function Section({ title, action, children }: { title: string; action: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
        {title}
        {action}
      </div>
      {children}
    </div>
  )
}
