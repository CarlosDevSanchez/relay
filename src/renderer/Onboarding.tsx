import { useEffect, useState } from 'react'
import type { Account, AccountStatus, Candidate, CliStatus } from '../shared/types'
import { TerminalPane } from './Terminal'
import { CLAUDE_MISSING, suggestLabel } from './status'
import type { Modal } from './ui'

interface Props {
  step: 'account' | 'project'
  cli: CliStatus | null
  statuses: Record<string, AccountStatus>
  projects: string[]
  error: string
  modal: Modal
  onInstall(): void
  /** the installer tab (App owns it), shown here while it runs */
  installTab?: { ptyId: number; exited?: boolean }
  /** every pty that has exited (App subscribes for the whole app life, so a fast exit cannot be missed) */
  exitedPtys: number[]
  createAccount(label: string, dir?: string): Promise<Account | undefined>
  checkStatus(id: string): Promise<AccountStatus | undefined>
  next(): void
  addProject(): void
  finish(): void
}

export function Onboarding(p: Props) {
  return (
    <div className="drag h-full overflow-y-auto bg-bg">
      <div className="nodrag mx-auto max-w-xl px-6 py-14">
        <h1 className="text-2xl font-semibold">Bienvenido a Relay</h1>
        <p className="mt-2 text-sm text-muted">
          Relay ejecuta el CLI oficial <code>claude</code> con tus propias cuentas, cada una con su carpeta de configuración, y te deja continuar la misma conversación en otra cuenta cuando una se queda sin cuota. Relay nunca ve ni guarda tus credenciales: el inicio de sesión lo hace el propio CLI.
        </p>
        <CliRow cli={p.cli} onInstall={p.onInstall} installTab={p.installTab} />
        {p.error && <p className="mt-3 text-xs text-bad">{p.error}</p>}
        {p.step === 'account' ? <AccountStep {...p} /> : <ProjectStep {...p} />}
      </div>
    </div>
  )
}

function CliRow({ cli, onInstall, installTab }: { cli: CliStatus | null; onInstall(): void; installTab: Props['installTab'] }) {
  const c = cli?.claude
  const showTerm = installTab && (!installTab.exited || c?.installed === false)
  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between">
      <span>
        <b className="text-sm">Claude Code</b>{' '}
        <span className="text-muted">{!c ? 'comprobando…' : c.installed ? `instalado${c.version ? ` · ${c.version}` : ''}` : 'no instalado'}</span>
      </span>
      {c?.installed === false && !(installTab && !installTab.exited) && <button className="btn" onClick={onInstall}>Instalar Claude Code</button>}
      </div>
      {showTerm && (
        <div className="mt-3 h-64 overflow-hidden rounded-card border border-line">
          <TerminalPane key={installTab.ptyId} ptyId={installTab.ptyId} visible />
        </div>
      )}
    </div>
  )
}

function AccountStep(p: Props) {
  const [accId, setAccId] = useState<string | null>(null)
  const [pty, setPty] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [cands, setCands] = useState<Candidate[] | null>(null)
  const [msg, setMsg] = useState('')
  const missing = p.cli?.claude.installed === false
  const st = accId ? p.statuses[accId] : undefined

  // re-fetched when the CLI state changes (e.g. right after the installer finished)
  useEffect(() => void window.relay.accounts.candidates().then(setCands).catch(() => setCands([])), [p.cli?.claude.installed])
  const exited = pty !== null && p.exitedPtys.includes(pty)
  useEffect(() => {
    if (!exited) return
    setPty(null)
    if (accId) void p.checkStatus(accId)
  }, [exited])
  useEffect(() => () => void (pty !== null && window.relay.pty.kill(pty)), [pty])

  const login = async (id: string) => {
    setMsg('')
    try {
      setPty((await window.relay.pty.start({ accountId: id, cwd: '', mode: 'login' })).ptyId)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }
  const create = async (label: string | null, dir?: string, thenLogin = false) => {
    if (!label) return
    setBusy(true)
    try {
      const a = await p.createAccount(label, dir)
      if (!a) return
      setAccId(a.id)
      if (thenLogin) await login(a.id)
      else await p.checkStatus(a.id)
    } finally {
      setBusy(false)
    }
  }

  const ok = st?.loggedIn === true
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Agrega tu primera cuenta de Claude</h2>
      {!accId && (
        <div className="mt-3 space-y-4">
          <div className="card">
            <b className="text-sm">Iniciar sesión con una cuenta nueva</b>
            <p className="mt-1 text-muted">Crea una carpeta de configuración propia y abre aquí el inicio de sesión oficial de Claude.</p>
            <button className="btn-primary mt-3" disabled={missing || busy} title={missing ? CLAUDE_MISSING : ''} onClick={async () => create(await p.modal.prompt('Nombre de la cuenta', 'Personal'), undefined, true)}>
              Iniciar sesión con una cuenta nueva
            </button>
          </div>
          <div className="card">
            <b className="text-sm">Usar una carpeta existente</b>
            <p className="mt-1 text-muted">Se referencia la carpeta tal cual; Relay no la copia ni la borra.</p>
            <div className="mt-2 space-y-1">
              {cands === null && <div className="text-muted">Buscando carpetas…</div>}
              {cands?.length === 0 && <div className="text-muted">No se encontró ninguna carpeta ~/.claude*.</div>}
              {cands?.map((c) => (
                <div key={c.dir} className="flex items-center justify-between rounded-card border border-line px-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate">{c.dir}</span>
                    <span className="text-muted">{c.default ? 'Instalación por defecto · ' : ''}{c.unchecked ? 'sin comprobar (se comprueba al importar)' : c.loggedIn === null ? 'desconocido' : c.loggedIn ? `${c.email ?? 'sesión iniciada'}${c.plan ? ` · ${c.plan}` : ''}` : 'sin sesión'}</span>
                  </span>
                  <button className="btn shrink-0" disabled={missing || busy} onClick={async () => create(await p.modal.prompt('Nombre de la cuenta', suggestLabel(c.dir)), c.dir)}>
                    Importar
                  </button>
                </div>
              ))}
            </div>
            <button
              className="btn mt-3"
              disabled={missing || busy}
              onClick={async () => {
                const dir = await window.relay.accounts.pickDir()
                if (dir) await create(await p.modal.prompt('Nombre de la cuenta', suggestLabel(dir)), dir)
              }}
            >
              Elegir otra carpeta…
            </button>
          </div>
        </div>
      )}
      {accId && (
        <div className="mt-3 space-y-3">
          {pty !== null && (
            <div className="h-72 overflow-hidden rounded-card border border-line">
              <TerminalPane ptyId={pty} visible />
            </div>
          )}
          {pty !== null && <p className="text-muted">Completa el inicio de sesión en la terminal. Al terminar se comprobará la cuenta.</p>}
          {pty === null && ok && (
            <div className="card border-ok/40">
              <b className="text-sm text-ok">Sesión iniciada</b>
              <div className="text-muted">{st?.email}{st?.plan ? ` · ${st.plan}` : ''}</div>
              <button className="btn-primary mt-3" onClick={p.next}>Continuar</button>
            </div>
          )}
          {pty === null && !ok && (
            <div className="card">
              <b className="text-sm">{st ? 'No se detectó una sesión iniciada' : 'Comprobando…'}</b>
              <div className="mt-3 flex gap-2">
                <button className="btn-primary" disabled={missing} onClick={() => login(accId)}>Reintentar inicio de sesión</button>
                <button className="btn" onClick={p.next}>Continuar de todas formas</button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-bad">{msg}</p>}
    </section>
  )
}

function ProjectStep(p: Props) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Agrega un proyecto</h2>
      <p className="mt-1 text-muted">Una carpeta de código donde trabajar con Claude. Puedes omitir este paso y agregarlo después.</p>
      <div className="mt-3 space-y-1">
        {p.projects.map((x) => (
          <div key={x} className="card truncate py-1.5">{x}</div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn" onClick={p.addProject}>Elegir carpeta…</button>
        <button className="btn-primary" onClick={p.finish}>{p.projects.length ? 'Continuar' : 'Omitir'}</button>
      </div>
    </section>
  )
}
