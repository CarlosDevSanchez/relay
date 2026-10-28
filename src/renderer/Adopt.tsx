import { useEffect, useState } from 'react'
import type { Account, SessionInfo } from '../shared/types'
import { Dialog, ago } from './ui'

/** Transcripts of a project (any account / provider) that are not in Relay's history; picking one adds it and resumes it. */
export function AdoptDialog({ cwd, accounts, onPick, onClose }: { cwd: string; accounts: Account[]; onPick(s: SessionInfo): void; onClose(): void }) {
  const [list, setList] = useState<SessionInfo[] | null>(null)
  useEffect(() => void window.relay.history.candidates(cwd).then(setList).catch(() => setList([])), [cwd])
  const label = (id: string) => accounts.find((a) => a.id === id)?.label ?? id
  return (
    <Dialog label="Abrir sesión existente" onClose={onClose} boxClass="max-w-lg">
      <h3 className="text-base font-semibold">Abrir sesión existente</h3>
      <p className="mt-1 text-sm opacity-70">Sesiones de este proyecto que no se han usado desde Relay. Al abrir una, se añade al historial de Relay y se reanuda en su cuenta.</p>
      {list === null ? (
        <span className="loading loading-spinner loading-sm mt-3" aria-label="Cargando" />
      ) : list.length === 0 ? (
        <p className="mt-3 text-sm opacity-60">No hay otras sesiones en este proyecto.</p>
      ) : (
        <ul className="menu mt-3 max-h-80 w-full flex-nowrap overflow-y-auto p-0">
          {list.map((s) => (
            <li key={`${s.accountId}${s.id}`}>
              <button onClick={() => onPick(s)} className="flex-col items-start gap-0 text-left">
                <span className="w-full truncate text-sm">{s.title}</span>
                <span className="text-xs opacity-60">{label(s.accountId)} · {ago(s.mtimeMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-action">
        <button className="btn" data-autofocus onClick={onClose}>Cerrar</button>
      </div>
    </Dialog>
  )
}
