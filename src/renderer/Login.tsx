import { useEffect, useState } from 'react'
import type { AccountStatus } from '../shared/types'
import { TerminalPane } from './Terminal'

export interface LoginPanelProps {
  ptyId: number
  /** the login pty is still alive */
  running: boolean
  /** auth status after the login pty exited; undefined while it is being checked */
  status?: AccountStatus
  onRetry(): void
  onContinue?(): void
  continueLabel?: string
}

/** Friendly front for `claude auth login`. The CLI still does the login; the only thing typed is the code the user pastes here. */
export function LoginPanel(p: LoginPanelProps) {
  const [code, setCode] = useState('')
  const [term, setTerm] = useState(false)
  const [out, setOut] = useState(false) // the CLI has printed something
  const [sent, setSent] = useState(false)
  const [late, setLate] = useState(false)
  useEffect(() => window.relay.pty.onData((id) => id === p.ptyId && setOut(true)), [p.ptyId])
  // output but no code after a few seconds: the CLI may be asking something interactive, so surface the real terminal
  useEffect(() => {
    if (!out || sent) return
    const t = setTimeout(() => setLate(true), 3000)
    return () => clearTimeout(t)
  }, [out, sent])
  const send = () => {
    if (!code.trim()) return
    setSent(true)
    setLate(false)
    window.relay.pty.write(p.ptyId, `${code.trim()}\r`)
    setCode('')
  }
  const ok = p.status?.loggedIn === true
  return (
    <div className="card card-border bg-base-100 shadow-sm">
      <div className="card-body gap-4 p-5">
        {p.running ? (
          <>
            <h3 className="card-title text-base">Inicia sesión en tu cuenta</h3>
            <ul className="steps steps-vertical text-sm">
              <li className="step step-primary">Se abrirá tu navegador</li>
              <li className="step step-primary">Inicia sesión</li>
              <li className="step step-primary">Copia el código y pégalo aquí</li>
            </ul>
            <form className="join w-full" onSubmit={(e) => (e.preventDefault(), send())}>
              <input className="input join-item w-full" placeholder="Pega aquí el código" aria-label="Pega aquí el código" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn btn-primary join-item" type="submit" disabled={!code.trim()}>Enviar código</button>
            </form>
            <p className="flex items-center gap-2 text-xs opacity-60"><span className="loading loading-dots loading-xs" /> Esperando el inicio de sesión…</p>
            {late && !term && (
              <div role="status" className="alert alert-info alert-soft text-xs">
                <span>Si el CLI te pide algo más (tema, confirmaciones...), respóndelo en la terminal.</span>
                <button className="btn btn-sm btn-info" onClick={() => setTerm(true)}>Mostrar terminal</button>
              </div>
            )}
          </>
        ) : p.status === undefined ? (
          <p className="flex items-center gap-2 text-sm"><span className="loading loading-spinner loading-sm" /> Comprobando…</p>
        ) : ok ? (
          <div role="alert" className="alert alert-success alert-soft">
            <div>
              <b>Sesión iniciada</b>
              <div className="text-xs opacity-80">{p.status.email ?? 'cuenta verificada'}{p.status.plan ? ` · ${p.status.plan}` : ''}</div>
            </div>
          </div>
        ) : (
          <div role="alert" className="alert alert-warning alert-soft">
            <span>No se detectó una sesión iniciada. Revisa la terminal y vuelve a intentarlo.</span>
          </div>
        )}
        {!p.running && p.status !== undefined && (
          <div className="flex gap-2">
            {ok ? (
              p.onContinue && <button className="btn btn-primary" onClick={p.onContinue}>{p.continueLabel ?? 'Continuar'}</button>
            ) : (
              <>
                <button className="btn btn-primary" onClick={p.onRetry}>Reintentar inicio de sesión</button>
                {p.onContinue && <button className="btn btn-ghost" onClick={p.onContinue}>{p.continueLabel ?? 'Continuar'} de todas formas</button>}
              </>
            )}
          </div>
        )}
        {/* the real CLI output, for transparency; kept mounted so the pty is never re-created */}
        <div className="collapse collapse-arrow rounded-box border border-base-300 bg-base-200">
          <input type="checkbox" aria-label="Ver terminal" checked={term} onChange={(e) => setTerm(e.target.checked)} />
          <div className="collapse-title text-sm font-medium">Ver terminal</div>
          <div className="collapse-content">
            <div className="h-64 overflow-hidden rounded-field border border-base-300">
              <TerminalPane ptyId={p.ptyId} visible={term} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
