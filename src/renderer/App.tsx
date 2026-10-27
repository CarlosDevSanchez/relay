import { useCallback, useEffect, useRef, useState } from 'react'
import type { Account, AccountStatus, LimitHit, SessionInfo } from '../shared/types'
import { TerminalPane } from './Terminal'

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const btn = 'nodrag rounded px-2 py-1 text-xs border border-white/10 hover:bg-white/10'
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

interface Tab {
  ptyId: number
  accountId: string
  title: string
  sessionId?: string
  login?: boolean
  exited?: boolean
  hint?: string
}

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [statuses, setStatuses] = useState<Record<string, AccountStatus>>({})
  const [projects, setProjects] = useState<string[]>([])
  const [cwd, setCwd] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [active, setActive] = useState<string | null>(null) // selected account id
  const [tabs, setTabs] = useState<Tab[]>([])
  const [cur, setCur] = useState<number | null>(null) // active tab ptyId
  const [error, setError] = useState('')
  const [hit, setHit] = useState<LimitHit | null>(null)
  const tab = tabs.find((t) => t.ptyId === cur)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts

  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadStatus = useCallback(
    (id: string, refresh = false) =>
      window.relay.accounts
        .status(id, refresh)
        .then((s) => setStatuses((m) => ({ ...m, [id]: s })))
        .catch(() => setStatuses((m) => ({ ...m, [id]: { accountId: id, loggedIn: null, tokens5h: 0 } }))),
    []
  )

  const refresh = useCallback(async (dir: string | null) => {
    const list = await window.relay.accounts.list()
    setAccounts(list)
    if (dir) setSessions(await window.relay.sessions(dir))
    return list
  }, [])

  useEffect(() => {
    void window.relay.projects.list().then(setProjects)
    void refresh(null).then((l) => l.forEach((a) => void loadStatus(a.id)))
  }, [refresh, loadStatus])
  useEffect(() => {
    if (!active && accounts[0]) setActive(accounts[0].id)
  }, [accounts, active])
  useEffect(() => {
    if (cwd) void window.relay.sessions(cwd).then(setSessions)
  }, [cwd])
  // a finished login changes the account's auth status
  useEffect(
    () =>
      window.relay.pty.onExit((id) => {
        setTabs((ts) => ts.map((t) => (t.ptyId === id ? { ...t, exited: true } : t)))
        const t = tabsRef.current.find((x) => x.ptyId === id)
        if (t?.login) void loadStatus(t.accountId, true)
      }),
    [loadStatus]
  )

  // quota hit on a live session: ask the user (never switch by itself)
  useEffect(() => {
    const offHit = window.relay.onLimit((h) => {
      setHit(h)
      accountsRef.current.forEach((a) => void loadStatus(a.id, true))
    })
    const offFocus = window.relay.onFocusTab((id) => setCur(id))
    return () => (offHit(), offFocus())
  }, [loadStatus])

  const open = (t: Tab, replace?: number) => {
    setTabs((ts) => (replace === undefined ? [...ts, t] : ts.map((x) => (x.ptyId === replace ? t : x))))
    setCur(t.ptyId)
  }

  const start = (mode: 'new' | 'resume' | 'login', accountId: string, s?: SessionInfo) =>
    run(async () => {
      if (!cwd && mode !== 'login') throw new Error('Pick a project first')
      setActive(accountId)
      const r = await window.relay.pty.start({ accountId, cwd: cwd ?? '', mode, ...(s ? { sessionId: s.id } : {}) })
      const label = accounts.find((a) => a.id === accountId)?.label ?? accountId
      open({
        ptyId: r.ptyId,
        accountId,
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        ...(mode === 'login' ? { login: true } : {}),
        title: mode === 'login' ? `login · ${label}` : (s?.title ?? 'new session').slice(0, 24)
      })
    })

  const closeTab = (t: Tab) =>
    run(async () => {
      await window.relay.pty.kill(t.ptyId)
      setTabs((ts) => ts.filter((x) => x.ptyId !== t.ptyId))
      setCur((c) => (c === t.ptyId ? (tabsRef.current.filter((x) => x.ptyId !== t.ptyId).at(-1)?.ptyId ?? null) : c))
    })

  const addAccount = (imp: boolean) =>
    run(async () => {
      const label = prompt('Account label')
      if (!label) return
      const dir = imp ? await window.relay.accounts.pickDir() : undefined
      if (imp && !dir) return
      const a = await window.relay.accounts.add(label, 'claude', dir ?? undefined)
      await refresh(cwd)
      void loadStatus(a.id)
    })

  const rename = (a: Account) =>
    run(async () => {
      const label = prompt('New label', a.label)
      if (label) setAccounts(await window.relay.accounts.rename(a.id, label))
    })

  const remove = (a: Account) =>
    run(async () => {
      const msg = a.managed
        ? `Delete account "${a.label}" and its config dir ${a.configDir}? This logs it out and removes its sessions.`
        : `Remove "${a.label}" from Relay? Its directory ${a.configDir} is left untouched.`
      if (!confirm(msg)) return
      setAccounts(await window.relay.accounts.remove(a.id))
      setTabs((ts) => ts.filter((t) => t.accountId !== a.id))
      if (tab?.accountId === a.id) setCur(null)
      if (active === a.id) setActive(null)
      await refresh(cwd)
    })

  // `ask`: the chip click needs a confirm(); the limit modal button is itself the confirmation
  const handoff = (to: Account, t: Tab | undefined = tab, ask = true) =>
    run(async () => {
      if (!cwd || !t?.sessionId) throw new Error('Open a Claude session first')
      if (to.id === t.accountId) return
      if (ask && !confirm(`Continue this session on "${to.label}"? The current process will be stopped.`)) return
      const r = await window.relay.handoff({ ptyId: t.ptyId, fromAccountId: t.accountId, toAccountId: to.id, cwd, sessionId: t.sessionId })
      // nothing is typed into the new session
      open({ ptyId: r.ptyId, accountId: to.id, title: t.title, hint: `Sesión continuada en ${to.label}. Escribe "continúa" para seguir.`, ...(r.sessionId ? { sessionId: r.sessionId } : {}) }, t.ptyId)
      setActive(to.id)
      await refresh(cwd)
      void loadStatus(to.id, true)
      void loadStatus(t.accountId, true)
    })

  const wait = () =>
    run(async () => {
      if (hit?.resetAt) await window.relay.remindReset(hit.accountId, hit.resetAt)
      setHit(null)
    })

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-[#262624] pt-10">
        <div className="space-y-2 border-b border-white/10 px-3 pb-3">
          {accounts.map((a) => {
            const s = statuses[a.id]
            return (
              <div key={a.id} className="rounded border border-white/10 bg-white/[0.03] p-2 text-xs">
                <div className="flex items-center justify-between">
                  <b className="truncate text-white/90">{a.label}</b>
                  <span className="shrink-0 text-white/40">
                    <button title="Refresh" onClick={() => loadStatus(a.id, true)}>↻</button>{' '}
                    <button title="Rename" onClick={() => rename(a)}>✎</button>{' '}
                    <button title="Remove" onClick={() => remove(a)}>✕</button>
                  </span>
                </div>
                <div className="truncate text-white/50">
                  {!s ? '…' : s.loggedIn === null ? 'status unknown' : s.loggedIn ? `${s.email ?? 'logged in'}${s.plan ? ` · ${s.plan}` : ''}` : 'not logged in'}
                </div>
                {s?.limited && <div className="text-red-400">Limitada hasta {s.limited.resetText}</div>}
                {s && <div className="text-white/40">{fmt(s.tokens5h)} tokens / 5h (local)</div>}
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between px-3 py-2 text-xs uppercase text-white/50">
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
                      onClick={() => start('resume', s.accountId, s)}
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
                onClick={() => (tab?.sessionId ? handoff(a) : setActive(a.id))}
                title={tab?.sessionId ? 'Continue this session on this account' : 'Select account'}
                className={`rounded-full px-3 py-1 text-xs ${a.id === (tab?.accountId ?? active) ? 'bg-[#d97757] text-black' : 'border border-white/20 text-white/70 hover:bg-white/10'}`}
              >
                {a.label}
              </button>
              <button className="text-xs text-white/40 hover:text-white" title="Login (claude auth login)" onClick={() => start('login', a.id)}>
                login
              </button>
            </span>
          ))}
          <button className={btn} onClick={() => addAccount(false)}>+ Account</button>
          <button className={btn} onClick={() => addAccount(true)}>Import dir</button>
          {error && <span className="ml-2 truncate text-xs text-red-400">{error}</span>}
        </header>
        <div className="flex border-b border-white/10 text-xs">
          {tabs.map((t) => (
            <div key={t.ptyId} className={`flex items-center gap-2 border-r border-white/10 px-3 py-1.5 ${t.ptyId === cur ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
              <button onClick={() => setCur(t.ptyId)} className={t.exited ? 'line-through' : ''}>{t.title}</button>
              <button title="Close" onClick={() => closeTab(t)}>✕</button>
            </div>
          ))}
        </div>
        {tab?.hint && (
          <div className="flex justify-between border-b border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
            {tab.hint}
            <button onClick={() => setTabs((ts) => ts.map((x) => (x.ptyId === tab.ptyId ? { ...x, hint: '' } : x)))}>✕</button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tabs.map((t) => (
            <TerminalPane key={t.ptyId} ptyId={t.ptyId} visible={t.ptyId === cur} />
          ))}
          {!tab && <p className="p-6 text-sm text-white/40">Add an account, pick a project, start or resume a session. Click another account chip to continue the open session there.</p>}
        </div>
      </main>
      {hit && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
          <div className="w-96 rounded border border-white/10 bg-[#262624] p-4 text-sm">
            <b>{accounts.find((a) => a.id === hit.accountId)?.label} llegó a su límite ({hit.kind})</b>
            <p className="mb-3 text-xs text-white/50">Se reinicia {hit.resetText}. Relay no cambia de cuenta por sí solo.</p>
            <div className="space-y-1">
              {accounts
                .filter((a) => a.id !== hit.accountId && a.provider === accounts.find((x) => x.id === hit.accountId)?.provider)
                .map((a) => {
                  const s = statuses[a.id]
                  const off = s?.loggedIn !== true || !!s.limited
                  return (
                    <button
                      key={a.id}
                      disabled={off}
                      onClick={() => {
                        const t = tabs.find((x) => x.ptyId === hit.ptyId)
                        setHit(null)
                        void handoff(a, t, false)
                      }}
                      className="block w-full rounded border border-white/10 px-3 py-2 text-left enabled:hover:bg-white/10 disabled:opacity-40"
                    >
                      Continuar en {a.label}
                      <span className="block text-xs text-white/50">
                        {!s ? '…' : s.loggedIn !== true ? 'sin sesión' : s.limited ? `limitada hasta ${s.limited.resetText}` : 'disponible'}
                      </span>
                    </button>
                  )
                })}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button className={btn} onClick={wait}>Esperar al reinicio</button>
              <button className={btn} onClick={() => setHit(null)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
