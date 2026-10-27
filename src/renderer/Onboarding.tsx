import { useEffect, useState } from 'react'
import type { Account, AccountStatus, Candidate, CliStatus } from '../shared/types'
import { LoginPanel } from './Login'
import { TerminalPane } from './Terminal'
import { CLAUDE_MISSING, suggestLabel } from './status'
import type { Modal } from './ui'

interface Props {
  step: 'account' | 'project'
  cli: CliStatus | null
  statuses: Record<string, AccountStatus>
  projects: string[]
  modal: Modal
  onInstall(): void
  /** the installer tab (App owns it), shown here while it runs */
  installTab?: { ptyId: number; exited?: boolean }
  /** every pty that has exited (App subscribes for the whole app life, so a fast exit cannot be missed) */
  isExited(ptyId: number): boolean
  createAccount(label: string, dir?: string): Promise<Account | undefined>
  checkStatus(id: string): Promise<AccountStatus | undefined>
  next(): void
  addProject(): void
  finish(): void
}

export function Onboarding(p: Props) {
  const c = p.cli?.claude
  const stepNo = p.step === 'project' ? 2 : c?.installed ? 1 : 0
  return (
    <div className="drag h-full overflow-y-auto bg-base-200">
      <div className="nodrag mx-auto max-w-2xl px-6 py-14">
        <h1 className="text-3xl font-semibold">Bienvenido a Relay</h1>
        <p className="mt-2 text-sm opacity-70">
          Relay ejecuta el CLI oficial <code className="kbd kbd-sm">claude</code> con tus propias cuentas, cada una con su carpeta de configuración, y te deja continuar la misma conversación en otra cuenta cuando una se queda sin cuota. Relay nunca ve ni guarda tus credenciales: el inicio de sesión lo hace el propio CLI.
        </p>
        <ul className="steps mt-8 w-full text-xs">
          {['CLI', 'Cuenta', 'Proyecto'].map((l, i) => (
            <li key={l} className={`step ${i <= stepNo ? 'step-primary' : ''}`} aria-current={i === stepNo ? 'step' : undefined}>{l}</li>
          ))}
        </ul>
        <CliRow cli={p.cli} onInstall={p.onInstall} installTab={p.installTab} />
        {p.step === 'account' ? <AccountStep {...p} /> : <ProjectStep {...p} />}
      </div>
    </div>
  )
}

function CliRow({ cli, onInstall, installTab }: { cli: CliStatus | null; onInstall(): void; installTab: Props['installTab'] }) {
  const c = cli?.claude
  const showTerm = installTab && (!installTab.exited || c?.installed === false)
  return (
    <div className="card card-border mt-6 bg-base-100 shadow-sm">
      <div className="card-body gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <b className="text-sm">Claude Code</b>
            {!c ? <span className="loading loading-spinner loading-xs" /> : <span className={`badge badge-soft ${c.installed ? 'badge-success' : 'badge-warning'}`}>{c.installed ? `instalado${c.version ? ` · ${c.version}` : ''}` : 'no instalado'}</span>}
          </span>
          {c?.installed === false && !(installTab && !installTab.exited) && <button className="btn btn-primary btn-sm" onClick={onInstall}>Instalar Claude Code</button>}
        </div>
        {showTerm && (
          <div className="h-64 overflow-hidden rounded-field border border-base-300">
            <TerminalPane key={installTab.ptyId} ptyId={installTab.ptyId} visible />
          </div>
        )}
      </div>
    </div>
  )
}

function AccountStep(p: Props) {
  const [accId, setAccId] = useState<string | null>(null)
  const [pty, setPty] = useState<number | null>(null)
  const [checked, setChecked] = useState(false) // status re-read after the login pty exited
  const [busy, setBusy] = useState(false)
  const [cands, setCands] = useState<Candidate[] | null>(null)
  const [msg, setMsg] = useState('')
  const missing = p.cli?.claude.installed === false
  const st = accId ? p.statuses[accId] : undefined

  // re-fetched when the CLI state changes (e.g. right after the installer finished)
  useEffect(() => void window.relay.accounts.candidates().then(setCands).catch(() => setCands([])), [p.cli?.claude.installed])
  const exited = pty !== null && p.isExited(pty)
  useEffect(() => {
    if (!exited || !accId) return
    void p.checkStatus(accId).then(() => setChecked(true))
  }, [exited])
  useEffect(() => () => void (pty !== null && window.relay.pty.kill(pty)), [pty])

  const login = async (id: string) => {
    setMsg('')
    try {
      setChecked(false)
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
      else {
        await p.checkStatus(a.id)
        setChecked(true)
      }
    } finally {
      setBusy(false)
    }
  }

  const ok = st?.loggedIn === true
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Agrega tu primera cuenta de Claude</h2>
      {!accId && (
        <div className="mt-3 space-y-4">
          <div className="card card-border bg-base-100 shadow-sm">
            <div className="card-body gap-2 p-4">
              <b className="text-sm">Iniciar sesión con una cuenta nueva</b>
              <p className="text-sm opacity-70">Crea una carpeta de configuración propia y abre aquí el inicio de sesión oficial de Claude.</p>
              <div className="card-actions">
                <button className="btn btn-primary" disabled={missing || busy} title={missing ? CLAUDE_MISSING : ''} onClick={async () => create(await p.modal.prompt('Nombre de la cuenta', 'Personal'), undefined, true)}>
                  {busy && <span className="loading loading-spinner loading-xs" />}Iniciar sesión con una cuenta nueva
                </button>
              </div>
            </div>
          </div>
          <div className="card card-border bg-base-100 shadow-sm">
            <div className="card-body gap-2 p-4">
              <b className="text-sm">Usar una carpeta existente</b>
              <p className="text-sm opacity-70">Se referencia la carpeta tal cual; Relay no la copia ni la borra.</p>
              <div className="space-y-2">
                {cands === null && <div className="flex items-center gap-2 text-sm opacity-70"><span className="loading loading-spinner loading-xs" /> Buscando carpetas…</div>}
                {cands?.length === 0 && <div className="text-sm opacity-70">No se encontró ninguna carpeta ~/.claude*.</div>}
                {cands?.map((c) => (
                  <div key={c.dir} className="lift flex items-center justify-between gap-3 rounded-box border border-base-300 px-3 py-2 hover:border-primary/50">
                    <span className="min-w-0 text-sm">
                      <span className="block truncate font-medium">{c.dir}</span>
                      <span className="text-xs opacity-60">{c.default ? 'Instalación por defecto · ' : ''}{c.unchecked ? 'sin comprobar (se comprueba al importar)' : c.loggedIn === null ? 'desconocido' : c.loggedIn ? `${c.email ?? 'sesión iniciada'}${c.plan ? ` · ${c.plan}` : ''}` : 'sin sesión'}</span>
                    </span>
                    <button className="btn btn-outline btn-sm shrink-0" disabled={missing || busy} onClick={async () => create(await p.modal.prompt('Nombre de la cuenta', suggestLabel(c.dir)), c.dir)}>
                      Importar
                    </button>
                  </div>
                ))}
              </div>
              <div className="card-actions">
                <button
                  className="btn btn-ghost btn-sm"
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
          </div>
        </div>
      )}
      {accId && pty !== null && (
        <div className="mt-3">
          <LoginPanel key={pty} ptyId={pty} running={!exited} {...(exited && checked ? { status: st ?? { accountId: accId, loggedIn: null, tokens5h: 0 } } : {})} onRetry={() => void login(accId)} onContinue={p.next} />
        </div>
      )}
      {accId && pty === null && (
        <div className="mt-3">
          {!checked ? (
            <div className="flex items-center gap-2 text-sm"><span className="loading loading-spinner loading-sm" /> Comprobando…</div>
          ) : ok ? (
            <div className="card card-border border-success/40 bg-base-100 shadow-sm">
              <div className="card-body gap-2 p-4">
                <b className="text-sm text-success">Sesión iniciada</b>
                <div className="text-sm opacity-70">{st?.email}{st?.plan ? ` · ${st.plan}` : ''}</div>
                <div className="card-actions"><button className="btn btn-primary" onClick={p.next}>Continuar</button></div>
              </div>
            </div>
          ) : (
            <div className="card card-border bg-base-100 shadow-sm">
              <div className="card-body gap-3 p-4">
                <b className="text-sm">No se detectó una sesión iniciada</b>
                <div className="card-actions">
                  <button className="btn btn-primary" disabled={missing} onClick={() => login(accId)}>Reintentar inicio de sesión</button>
                  <button className="btn btn-ghost" onClick={p.next}>Continuar de todas formas</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <div role="alert" className="alert alert-error alert-soft mt-3 text-sm">{msg}</div>}
    </section>
  )
}

function ProjectStep(p: Props) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Agrega un proyecto</h2>
      <p className="mt-1 text-sm opacity-70">Una carpeta de código donde trabajar con Claude. Puedes omitir este paso y agregarlo después.</p>
      <div className="mt-3 space-y-2">
        {p.projects.map((x) => (
          <div key={x} className="card card-border card-sm bg-base-100"><div className="card-body truncate py-2">{x}</div></div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn btn-outline" onClick={p.addProject}>Elegir carpeta…</button>
        <button className="btn btn-primary" onClick={p.finish}>{p.projects.length ? 'Continuar' : 'Omitir'}</button>
      </div>
    </section>
  )
}
