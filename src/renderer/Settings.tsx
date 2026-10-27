import { type ReactNode, useEffect, useState } from 'react'
import type { Account, AccountStatus, CatalogLocation, CliStatus, McpReport, McpServer, Prefs, ProviderId } from '../shared/types'
import { NAMES, missingMsg, statusLine } from './status'
import { Dialog } from './ui'

export interface SettingsProps {
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  cli: CliStatus | null
  onClose(): void
  onDetect(): void
  onInstall(provider: ProviderId): void
  setShared(a: Account, enabled: boolean): void
  rename(a: Account): void
  remove(a: Account): void
  add(imp: boolean): void
  login(a: Account): void
}

const SECTIONS = ['Cuentas', 'Cambio de cuenta', 'Notificaciones', 'Consumo', 'Skills, agents y commands', 'Conectores (MCP)', 'CLI'] as const

/** Large modal (native dialog) with a left menu; ESC / backdrop / ✕ close it. */
export function Settings(p: SettingsProps) {
  const [sec, setSec] = useState<(typeof SECTIONS)[number]>('Cuentas')
  return (
    <Dialog label="Configuración" onClose={p.onClose} boxClass="flex h-[82vh] w-11/12 max-w-5xl gap-0 overflow-hidden p-0">
      <ul className="menu w-56 shrink-0 gap-1 border-r border-base-300 bg-base-200 p-3">
        <li className="menu-title">Configuración</li>
        {SECTIONS.map((s) => (
          <li key={s}>
            <button className={s === sec ? 'menu-active' : ''} onClick={() => setSec(s)}>{s}</button>
          </li>
        ))}
      </ul>
      <div className="relative min-w-0 flex-1 overflow-y-auto p-6">
        <button className="btn btn-ghost btn-sm btn-circle absolute right-3 top-3" aria-label="Cerrar configuración" onClick={p.onClose}>✕</button>
        <h2 className="mb-4 text-lg font-semibold">{sec}</h2>
        {sec === 'Cuentas' && <Accounts {...p} />}
        {sec === 'Cambio de cuenta' && <Handoff />}
        {sec === 'Notificaciones' && <Notifications />}
        {sec === 'Consumo' && <Consumo />}
        {sec === 'Skills, agents y commands' && <Catalog accounts={p.accounts} />}
        {sec === 'Conectores (MCP)' && <Mcp accounts={p.accounts} />}
        {sec === 'CLI' && <Cli {...p} />}
      </div>
    </Dialog>
  )
}

const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`card card-border card-sm bg-base-100 shadow-sm ${className}`}>
    <div className="card-body gap-1 text-sm">{children}</div>
  </div>
)
const Loading = () => <span className="loading loading-spinner loading-sm" aria-label="Cargando" />

function Accounts(p: SettingsProps) {
  const off = (a: Account) => p.cli?.[a.provider]?.installed === false
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" onClick={() => p.add(false)}>+ Cuenta nueva</button>
        <button className="btn btn-outline btn-sm" onClick={() => p.add(true)}>Importar carpeta</button>
      </div>
      {p.accounts.map((a) => (
        <Card key={a.id}>
          <div className="flex items-center justify-between">
            <b>{a.label}</b>
            <span className="space-x-2">
              <button className="btn btn-outline btn-xs" onClick={() => p.rename(a)}>Renombrar</button>
              <button className="btn btn-outline btn-xs" disabled={off(a)} title={off(a) ? missingMsg(a.provider) : ''} onClick={() => p.login(a)}>Login</button>
              <button className="btn btn-outline btn-error btn-xs" onClick={() => p.remove(a)}>Quitar</button>
            </span>
          </div>
          <div className="opacity-60">
            <span className="badge badge-ghost badge-sm">{a.provider}</span> {a.managed ? 'gestionada por Relay' : a.defaultInstall ? 'instalación por defecto' : 'importada'} · <span className="break-all">{a.configDir}</span>
          </div>
          <div className="opacity-60">{statusLine(p.statuses[a.id])}</div>
          {a.drift && <div className="text-warning">Memoria compartida desincronizada ({a.drift.join(', ')}); desactívala y vuelve a activarla.</div>}
          <label className="mt-1 flex cursor-pointer items-center gap-2">
            <input type="checkbox" className="toggle toggle-primary toggle-sm" checked={!!a.sharedMemory} onChange={(e) => p.setShared(a, e.target.checked)} /> Memoria compartida{a.provider === 'codex' ? ' (solo AGENTS.md)' : ''}
          </label>
        </Card>
      ))}
    </div>
  )
}

function Notifications() {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => void window.relay.prefs.get().then(setPrefs), [])
  if (!prefs) return <Loading />
  const set = (k: 'system' | 'sound', v: boolean) => window.relay.prefs.set({ notifications: { ...prefs.notifications, [k]: v } }).then(setPrefs)
  return (
    <div className="space-y-3 text-sm">
      <label className="flex cursor-pointer items-center gap-3"><input type="checkbox" className="toggle toggle-primary" checked={prefs.notifications.system} onChange={(e) => void set('system', e.target.checked)} /> Notificación del sistema</label>
      <label className="flex cursor-pointer items-center gap-3"><input type="checkbox" className="toggle toggle-primary" checked={prefs.notifications.sound} onChange={(e) => void set('sound', e.target.checked)} /> Sonido</label>
      <button className="btn btn-outline btn-sm" onClick={() => void window.relay.notifyTest().then((ok) => setMsg(ok ? 'Enviada (si no la ves, revisa los permisos de notificaciones del sistema).' : 'Las notificaciones no están disponibles en este sistema.'))}>
        Probar notificación
      </button>
      {msg && <p className="text-xs opacity-60">{msg}</p>}
    </div>
  )
}

const rpcError = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

function Consumo() {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null)
  useEffect(() => void window.relay.prefs.get().then((x) => (setPrefs(x), setText(String(x.usage.warnAt)))), [])
  if (!prefs) return <Loading />
  const save = (patch: Partial<Prefs['usage']>) =>
    window.relay.prefs
      .set({ usage: { ...prefs.usage, ...patch } })
      .then((x) => (setPrefs(x), setText(String(x.usage.warnAt)), setMsg({ ok: true, t: 'Guardado' })))
      .catch((e) => setMsg({ ok: false, t: rpcError(e) }))
  return (
    <div className="space-y-4 text-sm">
      <p className="opacity-70">Relay muestra en cada cuenta el consumo oficial de su sesión de 5 h y de la semana (el que informa el propio CLI) y te avisa una vez por ventana al llegar al umbral.</p>
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" className="toggle toggle-primary" checked={prefs.usage.statusLine} onChange={(e) => void save({ statusLine: e.target.checked })} /> Mostrar el consumo oficial de las cuentas Claude
      </label>
      <p className="text-xs opacity-60">
        Para leerlo, Relay arranca cada sesión de Claude con su propia línea de estado (opción oficial <code className="kbd kbd-xs">--settings</code>; no modifica ningún archivo de ajustes). Mientras está activo, esa línea reemplaza las pistas del pie del CLI (por ejemplo «esc to interrupt»). Si ya tienes una línea de estado propia en los ajustes de la cuenta, Relay la sigue ejecutando y muestra su salida. Solo afecta a las sesiones que abras después de cambiarlo. Codex muestra el consumo cuando sus transcripciones lo incluyen.
      </p>
      <fieldset className="fieldset">
        <legend className="fieldset-legend">Avisar al llegar a (%)</legend>
        <div className="join">
          <input className="input join-item w-24" type="number" min={50} max={100} step={1} aria-label="Umbral de aviso" value={text} onChange={(e) => (setText(e.target.value), setMsg(null))} />
          <button className="btn join-item" disabled={text.trim() === String(prefs.usage.warnAt)} onClick={() => void save({ warnAt: Number(text) })}>Guardar</button>
        </div>
        <p className="label">Entero entre 50 y 100. La barra se pone amarilla 20 puntos antes y roja desde el umbral.</p>
      </fieldset>
      {msg && <div role="alert" className={`alert alert-soft ${msg.ok ? 'alert-success' : 'alert-error'} py-2`}>{msg.t}</div>}
    </div>
  )
}

function Handoff() {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null)
  useEffect(() => void window.relay.prefs.get().then((x) => (setPrefs(x), setText(x.handoff.message))), [])
  if (!prefs) return <Loading />
  const save = (patch: Partial<Prefs['handoff']>) =>
    window.relay.prefs
      .set({ handoff: { ...prefs.handoff, ...patch } })
      .then((x) => (setPrefs(x), setText(x.handoff.message), setMsg({ ok: true, t: 'Guardado' })))
      .catch((e) => setMsg({ ok: false, t: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e) }))
  return (
    <div className="space-y-4 text-sm">
      <p className="opacity-70">Tras confirmar tú un cambio de cuenta, Relay reanuda la sesión en la otra cuenta y le pasa un mensaje inicial al CLI para que siga sin que tengas que escribir nada. Nunca cambia de cuenta por sí solo.</p>
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" className="toggle toggle-primary" checked={prefs.handoff.autoContinue} onChange={(e) => void save({ autoContinue: e.target.checked })} /> Continuar automáticamente tras el cambio
      </label>
      <fieldset className="fieldset">
        <legend className="fieldset-legend">Mensaje inicial</legend>
        <div className="join w-full">
          <input className="input join-item w-full" aria-label="Mensaje inicial" maxLength={500} disabled={!prefs.handoff.autoContinue} value={text} onChange={(e) => (setText(e.target.value), setMsg(null))} />
          <button className="btn join-item" disabled={!prefs.handoff.autoContinue || text.trim() === prefs.handoff.message} onClick={() => void save({ message: text })}>Guardar</button>
        </div>
        <p className="label">1 a 500 caracteres, sin saltos de línea; no puede empezar por "-".</p>
      </fieldset>
      {msg && <div role="alert" className={`alert alert-soft ${msg.ok ? 'alert-success' : 'alert-error'} py-2`}>{msg.t}</div>}
    </div>
  )
}

function Catalog({ accounts }: { accounts: Account[] }) {
  const [locs, setLocs] = useState<CatalogLocation[] | null>(null)
  useEffect(() => void window.relay.catalog.list().then(setLocs), [accounts])
  if (!locs) return <Loading />
  const kinds = [['Skills', 'skills'], ['Agents', 'agents'], ['Commands', 'commands']] as const
  return (
    <div className="space-y-3">
      {locs.map((l) => (
        <Card key={l.accountId ?? 'shared'}>
          <div className="mb-2 flex items-center justify-between">
            <b>{l.label}</b>
            <button className="btn btn-outline btn-xs" onClick={() => void (l.accountId ? window.relay.catalog.open(l.accountId) : window.relay.shared.open())}>Abrir carpeta</button>
          </div>
          {kinds.map(([title, k]) => (
            <div key={k} className="mb-1">
              <div className="opacity-60">{title} ({l[k].length})</div>
              {l[k].map((e) => (
                <div key={e.name} className="pl-3">
                  <span>{e.name}</span> <span className="opacity-60">{e.description}</span>
                </div>
              ))}
            </div>
          ))}
        </Card>
      ))}
    </div>
  )
}

const Servers = ({ list }: { list: McpServer[] }) =>
  list.length === 0 ? (
    <div className="opacity-60">Sin servidores</div>
  ) : (
    <>
      {list.map((s, i) => (
        <div key={i} className="pl-3">
          <span>{s.name}</span> <span className="opacity-60">{s.scope} · {s.transport}{s.target ? ` · ${s.target}` : ''}{s.project ? ` · ${s.project}` : ''}</span>
        </div>
      ))}
    </>
  )

function Mcp({ accounts }: { accounts: Account[] }) {
  const [r, setR] = useState<McpReport | null>(null)
  useEffect(() => void window.relay.mcp.list().then(setR), [accounts])
  if (!r) return <Loading />
  return (
    <div className="space-y-3">
      <p className="text-xs opacity-60">Solo lectura. Relay muestra nombre, ámbito, tipo y comando/origen; nunca env, cabeceras ni argumentos.</p>
      {r.accounts.map((a) => (
        <Card key={a.accountId}>
          <b>{accounts.find((x) => x.id === a.accountId)?.label ?? a.accountId}</b>
          <Servers list={a.servers} />
        </Card>
      ))}
      {r.projects.filter((x) => x.servers.length).map((x) => (
        <Card key={x.cwd}>
          <b className="break-all">{x.cwd} (.mcp.json)</b>
          <Servers list={x.servers} />
        </Card>
      ))}
    </div>
  )
}

function Cli(p: SettingsProps) {
  useEffect(p.onDetect, [])
  const row = (name: string, i?: { installed: boolean; version?: string }, extra?: string) => (
    <Card>
      <div className="flex items-center gap-2">
        <b>{name}</b>
        {!i ? <Loading /> : <span className={`badge badge-soft ${i.installed ? 'badge-success' : 'badge-warning'}`}>{i.installed ? `instalado${i.version ? ` · ${i.version}` : ''}` : 'no instalado'}</span>}
        {extra && <span className="opacity-60">{extra}</span>}
      </div>
    </Card>
  )
  return (
    <div className="space-y-3">
      {(['claude', 'codex'] as const).map((id) => (
        <div key={id} className="space-y-3">
          {row(NAMES[id], p.cli?.[id])}
          {p.cli?.[id]?.installed === false && <button className="btn btn-primary btn-sm" onClick={() => p.onInstall(id)}>Instalar {NAMES[id]}</button>}
        </div>
      ))}
      <button className="btn btn-outline btn-sm" onClick={p.onDetect}>Volver a detectar</button>
    </div>
  )
}
