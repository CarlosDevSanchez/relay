import { useCallback, useEffect, useState } from 'react'
import type { Account, SessionInfo } from '../shared/types'
import { TerminalPane } from './Terminal'

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const btn = 'nodrag rounded px-2 py-1 text-xs border border-white/10 hover:bg-white/10'

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [cwd, setCwd] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [active, setActive] = useState<string | null>(null) // active account id
  const [term, setTerm] = useState<{ ptyId: number; sessionId?: string } | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async (dir: string | null) => {
    setAccounts(await window.relay.accounts.list())
    if (dir) setSessions(await window.relay.sessions(dir))
  }, [])

  useEffect(() => {
    void window.relay.projects.list().then(setProjects)
    void refresh(null)
  }, [refresh])
  useEffect(() => {
    if (!active && accounts[0]) setActive(accounts[0].id)
  }, [accounts, active])
  useEffect(() => {
    if (cwd) void window.relay.sessions(cwd).then(setSessions)
  }, [cwd])

  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const start = (mode: 'new' | 'resume' | 'login', accountId: string, sessionId?: string) =>
    run(async () => {
      if (!cwd && mode !== 'login') throw new Error('Pick a project first')
      setActive(accountId)
      setTerm(await window.relay.pty.start({ accountId, cwd: cwd ?? '', mode, ...(sessionId ? { sessionId } : {}) }))
    })

  const addAccount = (imp: boolean) =>
    run(async () => {
      const label = prompt('Account label')
      if (!label) return
      const dir = imp ? await window.relay.accounts.pickDir() : undefined
      if (imp && !dir) return
      await window.relay.accounts.add(label, 'claude', dir ?? undefined)
      await refresh(cwd)
    })

  const handoff = (to: Account) =>
    run(async () => {
      if (!cwd || !active || !term?.sessionId) throw new Error('Open a Claude session first')
      if (to.id === active) return
      setTerm(await window.relay.handoff({ fromAccountId: active, toAccountId: to.id, cwd, sessionId: term.sessionId }))
      setActive(to.id)
      await refresh(cwd)
    })

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-[#262624] pt-10">
        <div className="flex items-center justify-between px-3 pb-2 text-xs uppercase text-white/50">
          Projects
          <button className={btn} onClick={() => run(async () => setProjects(await window.relay.projects.add()))}>
            + Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto text-sm">
          {projects.map((p) => (
            <div key={p}>
              <button
                title={p}
                onClick={() => setCwd(p)}
                className={`w-full truncate px-3 py-1 text-left hover:bg-white/5 ${p === cwd ? 'text-white' : 'text-white/70'}`}
              >
                {base(p)}
              </button>
              {p === cwd && (
                <div className="pb-1 pl-4">
                  <button className={`${btn} mb-1 ml-2`} onClick={() => active && start('new', active)}>
                    + New session
                  </button>
                  {sessions.map((s) => (
                    <button
                      key={`${s.accountId}${s.id}`}
                      onClick={() => start('resume', s.accountId, s.id)}
                      className="block w-full px-2 py-1 text-left text-xs text-white/70 hover:bg-white/5"
                    >
                      <div className="truncate">{s.title}</div>
                      <div className="text-white/40">
                        {accounts.find((a) => a.id === s.accountId)?.label} · {new Date(s.mtimeMs).toLocaleString()}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex items-center gap-2 border-b border-white/10 px-3 py-2 pl-24">
          {accounts.map((a) => (
            <span key={a.id} className="nodrag flex items-center gap-1">
              <button
                onClick={() => (term?.sessionId ? handoff(a) : setActive(a.id))}
                title={term?.sessionId ? 'Continue this session on this account' : 'Select account'}
                className={`rounded-full px-3 py-1 text-xs ${a.id === active ? 'bg-[#d97757] text-black' : 'border border-white/20 text-white/70 hover:bg-white/10'}`}
              >
                {a.label}
              </button>
              <button className="text-xs text-white/40 hover:text-white" title="Login (runs claude, use /login)" onClick={() => start('login', a.id)}>
                login
              </button>
            </span>
          ))}
          <button className={btn} onClick={() => addAccount(false)}>+ Account</button>
          <button className={btn} onClick={() => addAccount(true)}>Import dir</button>
          {error && <span className="ml-2 truncate text-xs text-red-400">{error}</span>}
        </header>
        <div className="min-h-0 flex-1">
          {term ? <TerminalPane key={term.ptyId} ptyId={term.ptyId} /> : <p className="p-6 text-sm text-white/40">Add an account, pick a project, start or resume a session. Click another account chip to continue the open session there.</p>}
        </div>
      </main>
    </div>
  )
}
