import { useEffect, useState } from 'react'
import type { Account, AccountStatus, CatalogLocation, CliStatus, McpReport, McpServer, Prefs } from '../shared/types'
import { CLAUDE_MISSING, statusLine } from './status'


export interface SettingsProps {
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  cli: CliStatus | null
  error: string
  onClose(): void
  onDetect(): void
  onInstall(): void
  setShared(a: Account, enabled: boolean): void
  rename(a: Account): void
  remove(a: Account): void
  add(imp: boolean): void
  login(a: Account): void
}

const SECTIONS = ['Cuentas', 'Notificaciones', 'Skills, agents y commands', 'Conectores (MCP)', 'CLI'] as const

export function Settings(p: SettingsProps) {
  const [sec, setSec] = useState<(typeof SECTIONS)[number]>('Cuentas')
  return (
    <div className="absolute inset-0 z-10 flex bg-bg">
      <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-line bg-surface px-2 pt-10 text-sm">
        <button className={`btn mb-2 self-start`} onClick={p.onClose}>← Volver</button>
        {SECTIONS.map((s) => (
          <button key={s} onClick={() => setSec(s)} className={`rounded px-2 py-1.5 text-left ${s === sec ? 'bg-white/10 text-white' : 'text-muted hover:bg-white/5'}`}>
            {s}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-6 pt-10">
        <h2 className="mb-4 text-base font-semibold">{sec}</h2>
        {p.error && <p className="mb-3 text-xs text-bad">{p.error}</p>}
        {sec === 'Cuentas' && <Accounts {...p} />}
        {sec === 'Notificaciones' && <Notifications />}
        {sec === 'Skills, agents y commands' && <Catalog accounts={p.accounts} />}
        {sec === 'Conectores (MCP)' && <Mcp accounts={p.accounts} />}
        {sec === 'CLI' && <Cli {...p} />}
      </div>
    </div>
  )
}

function Accounts(p: SettingsProps) {
  const off = p.cli?.claude.installed === false
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button className="btn" onClick={() => p.add(false)}>+ Cuenta nueva</button>
        <button className="btn" onClick={() => p.add(true)}>Importar carpeta</button>
      </div>
      {p.accounts.map((a) => (
        <div key={a.id} className="card">
          <div className="flex items-center justify-between">
            <b className="text-sm text-fg">{a.label}</b>
            <span className="space-x-2">
              <button className="btn" onClick={() => p.rename(a)}>Renombrar</button>
              <button className="btn" disabled={off && a.provider === 'claude'} title={off && a.provider === 'claude' ? CLAUDE_MISSING : ''} onClick={() => p.login(a)}>Login</button>
              <button className="btn" onClick={() => p.remove(a)}>Quitar</button>
            </span>
          </div>
          <div className="mt-1 text-muted">
            {a.provider} · {a.managed ? 'gestionada por Relay' : a.defaultInstall ? 'instalación por defecto' : 'importada'} · <span className="break-all">{a.configDir}</span>
          </div>
          <div className="text-muted">{statusLine(p.statuses[a.id])}</div>
          {a.drift && <div className="text-warn">Memoria compartida desincronizada ({a.drift.join(', ')}); desactívala y vuelve a activarla.</div>}
          {a.provider === 'claude' && (
            <label className="mt-1 flex items-center gap-1 text-muted">
              <input type="checkbox" checked={!!a.sharedMemory} onChange={(e) => p.setShared(a, e.target.checked)} /> Memoria compartida
            </label>
          )}
        </div>
      ))}
    </div>
  )
}

function Notifications() {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => void window.relay.prefs.get().then(setPrefs), [])
  if (!prefs) return null
  const set = (k: 'system' | 'sound', v: boolean) => window.relay.prefs.set({ notifications: { ...prefs.notifications, [k]: v } }).then(setPrefs)
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.notifications.system} onChange={(e) => void set('system', e.target.checked)} /> Notificación del sistema</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.notifications.sound} onChange={(e) => void set('sound', e.target.checked)} /> Sonido</label>
      <button className="btn" onClick={() => void window.relay.notifyTest().then((ok) => setMsg(ok ? 'Enviada (si no la ves, revisa los permisos de notificaciones del sistema).' : 'Las notificaciones no están disponibles en este sistema.'))}>
        Probar notificación
      </button>
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  )
}

function Catalog({ accounts }: { accounts: Account[] }) {
  const [locs, setLocs] = useState<CatalogLocation[]>([])
  useEffect(() => void window.relay.catalog.list().then(setLocs), [accounts])
  const kinds = [['Skills', 'skills'], ['Agents', 'agents'], ['Commands', 'commands']] as const
  return (
    <div className="space-y-3">
      {locs.map((l) => (
        <div key={l.accountId ?? 'shared'} className="card">
          <div className="mb-2 flex items-center justify-between">
            <b className="text-sm text-fg">{l.label}</b>
            <button className="btn" onClick={() => void (l.accountId ? window.relay.catalog.open(l.accountId) : window.relay.shared.open())}>Abrir carpeta</button>
          </div>
          {kinds.map(([title, k]) => (
            <div key={k} className="mb-1">
              <div className="text-muted">{title} ({l[k].length})</div>
              {l[k].map((e) => (
                <div key={e.name} className="pl-3">
                  <span className="text-fg">{e.name}</span> <span className="text-muted">{e.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const Servers = ({ list }: { list: McpServer[] }) =>
  list.length === 0 ? (
    <div className="text-muted">Sin servidores</div>
  ) : (
    <>
      {list.map((s, i) => (
        <div key={i} className="pl-3">
          <span className="text-fg">{s.name}</span> <span className="text-muted">{s.scope} · {s.transport}{s.target ? ` · ${s.target}` : ''}{s.project ? ` · ${s.project}` : ''}</span>
        </div>
      ))}
    </>
  )

function Mcp({ accounts }: { accounts: Account[] }) {
  const [r, setR] = useState<McpReport | null>(null)
  useEffect(() => void window.relay.mcp.list().then(setR), [accounts])
  if (!r) return null
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Solo lectura. Relay muestra nombre, ámbito, tipo y comando/origen; nunca env, cabeceras ni argumentos.</p>
      {r.accounts.map((a) => (
        <div key={a.accountId} className="card">
          <b className="text-sm text-fg">{accounts.find((x) => x.id === a.accountId)?.label ?? a.accountId}</b>
          <Servers list={a.servers} />
        </div>
      ))}
      {r.projects.filter((x) => x.servers.length).map((x) => (
        <div key={x.cwd} className="card">
          <b className="break-all text-sm text-fg">{x.cwd} (.mcp.json)</b>
          <Servers list={x.servers} />
        </div>
      ))}
    </div>
  )
}

function Cli(p: SettingsProps) {
  useEffect(p.onDetect, [])
  const row = (name: string, i?: { installed: boolean; version?: string }, extra?: string) => (
    <div className="card">
      <b className="text-sm text-fg">{name}</b>{' '}
      <span className="text-muted">{!i ? '…' : i.installed ? `instalado${i.version ? ` · ${i.version}` : ''}` : 'no instalado'}</span>
      {extra && <span className="text-muted"> · {extra}</span>}
    </div>
  )
  return (
    <div className="space-y-3">
      {row('Claude Code', p.cli?.claude)}
      {p.cli?.claude.installed === false && (
        <button className="btn" onClick={p.onInstall}>Instalar Claude Code</button>
      )}
      {row('Codex', p.cli?.codex, 'soporte en F5')}
      <button className="btn" onClick={p.onDetect}>Volver a detectar</button>
    </div>
  )
}
