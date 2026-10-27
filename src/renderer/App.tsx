import { useCallback, useEffect, useRef, useState } from 'react'
import type { Account, AccountStatus, CliStatus, LimitHit, SessionInfo, SharedReport } from '../shared/types'
import { Onboarding } from './Onboarding'
import { Settings } from './Settings'
import { Sidebar } from './Sidebar'
import { CLAUDE_MISSING, suggestLabel } from './status'
import { TerminalPane } from './Terminal'
import { Dropdown, IconChevron, ago, useModal } from './ui'

interface Tab {
  ptyId: number
  accountId: string
  cwd: string
  title: string
  sessionId?: string
  login?: boolean
  install?: boolean
  exited?: boolean
  hint?: string
  /** session id changed inside the CLI and could not be tied to this tab: no handoff */
  stale?: boolean
}
const STALE = 'Sesión cambiada dentro del CLI; vuelve a abrirla desde el sidebar para poder continuarla en otra cuenta'
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export function App() {
  const modal = useModal()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loaded, setLoaded] = useState(false)
  const [ob, setOb] = useState<'account' | 'project' | null>(null) // onboarding step
  const [statuses, setStatuses] = useState<Record<string, AccountStatus>>({})
  const [projects, setProjects] = useState<string[]>([])
  const [cwd, setCwd] = useState<string | null>(null)
  const [sessMap, setSessMap] = useState<Record<string, SessionInfo[]>>({})
  const [tick, setTick] = useState(0)
  const [active, setActive] = useState<string | null>(null) // selected account id
  const [tabs, setTabs] = useState<Tab[]>([])
  const [cur, setCur] = useState<number | null>(null) // active tab ptyId
  const [error, setError] = useState('')
  const [hits, setHits] = useState<LimitHit[]>([]) // queue, one per pty
  const [modalError, setModalError] = useState('')
  const [exitedPtys, setExitedPtys] = useState<number[]>([])
  const exitedRef = useRef(new Set<number>())
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [cli, setCli] = useState<CliStatus | null>(null)
  const claudeMissing = cli?.claude.installed === false
  const [notices, setNotices] = useState<string[]>([])
  const hit = hits[0]
  const hitTab = hit && tabs.find((x) => x.ptyId === hit.ptyId)
  const dropHit = (ptyId?: number) => {
    setModalError('')
    setHits((hs) => (ptyId === undefined ? hs.slice(1) : hs.filter((h) => h.ptyId !== ptyId)))
  }
  const tab = tabs.find((t) => t.ptyId === cur)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const bump = () => setTick((t) => t + 1)

  const run = async (fn: () => Promise<unknown>, sink: (m: string) => void = setError) => {
    sink('')
    try {
      await fn()
    } catch (e) {
      sink(e instanceof Error ? e.message : String(e))
    }
  }

  const showShared = (label: string, r: SharedReport) =>
    setNotices((n) => [
      ...n,
      [`Memoria compartida · ${label}: ${r.linked.length} enlace(s) creado(s)`, ...r.notes, ...(r.backups.length ? ['Copias de seguridad:', ...r.backups] : []), ...r.errors.map((e) => `ERROR ${e}`)].join('\n')
    ])

  const setShared = (a: Account, enabled: boolean) =>
    run(async () => {
      const r = await window.relay.shared.set(a.id, enabled)
      setAccounts(r.accounts)
      showShared(a.label, r.report)
    })

  const detect = useCallback(() => void window.relay.cli.detect().then(setCli).catch(() => undefined), [])
  useEffect(detect, [detect])
  useEffect(() => {
    if (view !== 'settings') return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setView('main')
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [view])

  const loadStatus = useCallback(
    (id: string, refresh = false): Promise<AccountStatus | undefined> =>
      window.relay.accounts
        .status(id, refresh)
        .catch((): AccountStatus => ({ accountId: id, loggedIn: null, tokens5h: 0 }))
        .then((s) => (setStatuses((m) => ({ ...m, [id]: s })), s)),
    []
  )

  const refresh = useCallback(async () => {
    const list = await window.relay.accounts.list()
    setAccounts(list)
    return list
  }, [])

  useEffect(() => {
    void window.relay.projects.list().then(setProjects)
    void refresh().then((l) => {
      setLoaded(true)
      if (l.length === 0) return setOb('account')
      l.forEach((a) => void loadStatus(a.id))
      // offered once: answering "no" persists sharedMemory=false
      void (async () => {
        for (const a of l.filter((x) => x.managed && x.provider === 'claude' && x.sharedMemory === undefined)) {
          const on = await modal.confirm('Memoria compartida', `¿Compartir la memoria global (CLAUDE.md, skills, agents, commands) de "${a.label}" con tus otras cuentas? Su contenido se mueve a ~/.relay/shared; lo que choque se guarda en ~/.relay/backups.`, 'Compartir')
          try {
            const r = await window.relay.shared.set(a.id, on)
            setAccounts(r.accounts)
            if (on) showShared(a.label, r.report)
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          }
        }
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, loadStatus])
  useEffect(() => {
    if (!active && accounts[0]) setActive(accounts[0].id)
  }, [accounts, active])
  useEffect(() => {
    if (!cwd && projects[0]) setCwd(projects[0])
  }, [projects, cwd])
  useEffect(() => {
    void Promise.all(projects.map((p) => window.relay.sessions(p).then((l) => [p, l] as const))).then((e) => setSessMap(Object.fromEntries(e)))
  }, [projects, accounts, tick])
  // a finished login changes the account's auth status
  useEffect(
    () =>
      window.relay.pty.onExit((id) => {
        exitedRef.current.add(id)
        setExitedPtys((e) => [...e, id])
        setTabs((ts) => ts.map((t) => (t.ptyId === id ? { ...t, exited: true } : t)))
        setHits((hs) => hs.filter((h) => h.ptyId !== id))
        const t = tabsRef.current.find((x) => x.ptyId === id)
        if (t?.login) void loadStatus(t.accountId, true)
        if (t?.install) detect()
        setTick((n) => n + 1)
      }),
    [loadStatus, detect]
  )

  // quota hit on a live session: ask the user (never switch by itself)
  useEffect(() => {
    const offHit = window.relay.onLimit((h) => {
      setHits((hs) => [...hs.filter((x) => x.ptyId !== h.ptyId), h])
      accountsRef.current.forEach((a) => void loadStatus(a.id, true))
    })
    const offFocus = window.relay.onFocusTab((id) => {
      if (tabsRef.current.some((t) => t.ptyId === id)) setCur(id)
    })
    const offStale = window.relay.onStale((id) => setTabs((ts) => ts.map((t) => (t.ptyId === id ? { ...t, stale: true, hint: STALE } : t))))
    const offSession = window.relay.onSession((id, sessionId) => {
      const t = tabsRef.current.find((x) => x.ptyId === id)
      setTabs((ts) => ts.map((x) => (x.ptyId === id ? { ...x, sessionId, hint: 'Sesión cambiada dentro del CLI.' } : x)))
      // the title is only known once the new transcript has a first prompt
      if (t) setTimeout(() => void window.relay.sessions(t.cwd).then((l) => {
        const title = (l.find((x) => x.id === sessionId)?.title ?? '(nueva sesión)').slice(0, 24)
        setTabs((ts) => ts.map((x) => (x.ptyId === id && x.sessionId === sessionId ? { ...x, title, hint: `Sesión cambiada a ${title}` } : x)))
      }), 3000)
    })
    const offSh = window.relay.onShared((m) => setNotices((n) => [...n, m]))
    const offRem = window.relay.onReminder((id) => {
      const label = accountsRef.current.find((a) => a.id === id)?.label ?? id
      setNotices((n) => [...n, `${label} ya tiene cuota disponible`])
      void loadStatus(id, true)
    })
    return () => (offHit(), offFocus(), offStale(), offSession(), offRem(), offSh())
  }, [loadStatus])

  const open = (t: Tab, replace?: number) => {
    if (exitedRef.current.has(t.ptyId)) (t = { ...t, exited: true }), t.install && detect() // exited before the tab existed
    setTabs((ts) => (replace === undefined ? [...ts, t] : ts.map((x) => (x.ptyId === replace ? t : x))))
    setCur(t.ptyId)
    setView('main')
  }

  const start = (mode: 'new' | 'resume' | 'login', accountId: string, s?: SessionInfo, dir: string | null = cwd) =>
    run(async () => {
      if (claudeMissing && accounts.find((a) => a.id === accountId)?.provider === 'claude') throw new Error(CLAUDE_MISSING)
      if (!dir && mode !== 'login') throw new Error('Elige un proyecto primero')
      setActive(accountId)
      const r = await window.relay.pty.start({ accountId, cwd: dir ?? '', mode, ...(s ? { sessionId: s.id } : {}) })
      const label = accounts.find((a) => a.id === accountId)?.label ?? accountId
      open({
        ptyId: r.ptyId,
        accountId,
        cwd: dir ?? '',
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        ...(mode === 'login' ? { login: true } : {}),
        title: mode === 'login' ? `login · ${label}` : (s?.title ?? 'nueva sesión').slice(0, 24)
      })
      bump()
    })

  const install = () =>
    run(async () => {
      const ptyId = await window.relay.cli.install('claude')
      if (ptyId !== null) open({ ptyId, accountId: '', cwd: '', install: true, title: 'instalar claude' })
    })

  const closeTab = (t: Tab) =>
    run(async () => {
      await window.relay.pty.kill(t.ptyId)
      setTabs((ts) => ts.filter((x) => x.ptyId !== t.ptyId))
      setCur((c) => (c === t.ptyId ? (tabsRef.current.filter((x) => x.ptyId !== t.ptyId).at(-1)?.ptyId ?? null) : c))
    })

  /** managed accounts get shared memory by default; imported dirs are only referenced */
  const createAccount = async (label: string, dir?: string): Promise<Account | undefined> => {
    setError('')
    try {
      const a = await window.relay.accounts.add(label, 'claude', dir)
      await refresh()
      if (a.managed) await setShared(a, true)
      setActive(a.id)
      void loadStatus(a.id, true)
      return a
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }
  }

  const addAccount = (imp: boolean) =>
    run(async () => {
      const dir = imp ? await window.relay.accounts.pickDir() : undefined
      if (imp && !dir) return
      const label = await modal.prompt('Nombre de la cuenta', imp && dir ? suggestLabel(dir) : '')
      if (!label) return
      const a = await createAccount(label, dir ?? undefined)
      if (a?.managed) await start('login', a.id)
    })

  const addProject = () =>
    run(async () => {
      const before = projects
      const all = await window.relay.projects.add()
      setProjects(all)
      const added = all.find((x) => !before.includes(x))
      if (added) setCwd(added)
    })

  const rename = (a: Account) =>
    run(async () => {
      const label = await modal.prompt('Renombrar cuenta', a.label)
      if (label) setAccounts(await window.relay.accounts.rename(a.id, label))
    })

  const remove = (a: Account) =>
    run(async () => {
      const msg = a.managed
        ? `Se eliminará la cuenta "${a.label}" y su carpeta ${a.configDir}. Esto cierra su sesión y borra sus sesiones.`
        : `Se quitará "${a.label}" de Relay. Su carpeta ${a.configDir} no se toca${a.sharedMemory ? ', salvo que sus enlaces de memoria compartida se sustituyen antes por copias reales de ~/.relay/shared' : ''}.`
      if (!(await modal.confirm('Quitar cuenta', msg, a.managed ? 'Eliminar' : 'Quitar', true))) return
      setAccounts(await window.relay.accounts.remove(a.id))
      setTabs((ts) => ts.filter((t) => t.accountId !== a.id))
      if (tab?.accountId === a.id) setCur(null)
      if (active === a.id) setActive(null)
      await refresh()
    })

  // `ask`: the menu needs an in-app confirmation; the limit modal button is itself the confirmation
  const handoff = (to: Account, t: Tab | undefined = tab, ask = true, sink: (m: string) => void = setError) =>
    run(async () => {
      if (!t?.sessionId || !t.cwd) throw new Error('Abre primero una sesión de Claude')
      if (t.stale) throw new Error(STALE)
      if (to.id === t.accountId) return
      if (ask && !(await modal.confirm('Continuar en otra cuenta', `Sesión "${t.title}" → cuenta "${to.label}". El proceso actual se detendrá y se reanudará la misma conversación en la otra cuenta.`, `Continuar en ${to.label}`))) return
      const r = await window.relay.handoff({ ptyId: t.ptyId, fromAccountId: t.accountId, toAccountId: to.id, cwd: t.cwd, sessionId: t.sessionId })
      // nothing is typed into the new session
      open({ ptyId: r.ptyId, accountId: to.id, cwd: t.cwd, title: t.title, hint: `Sesión continuada en ${to.label}. Escribe "continúa" para seguir.`, ...(r.sessionId ? { sessionId: r.sessionId } : {}) }, t.ptyId)
      setActive(to.id)
      dropHit(t.ptyId)
      await refresh()
      bump()
      void loadStatus(to.id, true)
      void loadStatus(t.accountId, true)
    }, sink)

  const wait = () =>
    run(async () => {
      if (hit?.resetAt) await window.relay.remindReset(hit.accountId, hit.resetAt)
      dropHit()
    }, setModalError)

  const accLabel = (id: string) => accounts.find((a) => a.id === id)?.label ?? ''
  const newSession = () => active && start('new', active)
  const recent = Object.entries(sessMap).flatMap(([p, l]) => l.map((s) => ({ p, s }))).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs).slice(0, 8)

  if (!loaded) return <>{modal.node}</>
  if (ob)
    return (
      <>
        <Onboarding
          step={ob}
          cli={cli}
          statuses={statuses}
          projects={projects}
          error={error}
          modal={modal}
          onInstall={install}
          installTab={tabs.find((t) => t.install)}
          exitedPtys={exitedPtys}
          createAccount={createAccount}
          checkStatus={(id) => loadStatus(id, true)}
          next={() => setOb('project')}
          addProject={addProject}
          finish={() => setOb(null)}
        />
        {modal.node}
      </>
    )

  const targets = tab ? accounts.filter((a) => a.id !== tab.accountId && a.provider === accounts.find((x) => x.id === tab.accountId)?.provider) : []
  const canHand = !!tab?.sessionId && !tab.stale

  return (
    <div className="flex h-full">
      <Sidebar
        accounts={accounts}
        statuses={statuses}
        active={active}
        projects={projects}
        cwd={cwd}
        sessions={sessMap}
        claudeMissing={claudeMissing}
        newSession={() => void newSession()}
        selectAccount={setActive}
        selectProject={setCwd}
        addProject={addProject}
        addAccount={() => void addAccount(false)}
        resume={(p, s) => (setCwd(p), void start('resume', s.accountId, s, p))}
        rename={rename}
        remove={remove}
        login={(a) => void start('login', a.id)}
        setShared={setShared}
        refreshStatus={(id) => void loadStatus(id, true)}
        openSettings={() => setView('settings')}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="drag flex items-center border-b border-line pr-3">
          <div className="flex min-w-0 flex-1 overflow-x-auto pt-8 text-xs">
            {tabs.map((t) => (
              <div key={t.ptyId} className={`nodrag flex shrink-0 items-center gap-2 border-r border-line px-3 py-1.5 ${t.ptyId === cur ? 'bg-white/10 text-fg' : 'text-muted hover:bg-white/5'}`}>
                <button onClick={() => setCur(t.ptyId)} className={`flex items-center gap-2 ${t.exited ? 'line-through' : ''}`}>
                  {t.accountId && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px]">{accLabel(t.accountId)}</span>}
                  {t.title}
                </button>
                <button title="Cerrar" aria-label="Cerrar pestaña" onClick={() => closeTab(t)}>✕</button>
              </div>
            ))}
          </div>
          {tab?.accountId && (
            <div className="pt-8">
              <Dropdown
                title={canHand ? 'Continuar esta sesión en otra cuenta' : 'Necesitas una sesión de Claude abierta y con transcripción'}
                trigger={<>Continuar en otra cuenta <IconChevron open /></>}
                items={targets.map((a) => {
                  const s = statuses[a.id]
                  const off = !canHand || s?.loggedIn !== true || !!s.limited
                  return { label: `${a.label}${!s ? '' : s.loggedIn !== true ? ' (sin sesión)' : s.limited ? ` (limitada hasta ${s.limited.resetText})` : ''}`, disabled: off, onClick: () => void handoff(a) }
                })}
              />
            </div>
          )}
        </header>
        {error && (
          <div className="flex justify-between border-b border-line bg-bad/10 px-3 py-1 text-xs text-bad">
            <span>{error}</span>
            <button onClick={() => setError('')}>✕</button>
          </div>
        )}
        {claudeMissing && (
          <div className="flex items-center justify-between border-b border-line bg-warn/10 px-3 py-1 text-xs text-warn">
            <span>Claude Code no está instalado.</span>
            <button className="btn" onClick={install}>Instalar Claude Code</button>
          </div>
        )}
        {notices.map((n, i) => (
          <div key={i} className="flex justify-between border-b border-line bg-ok/10 px-3 py-1 text-xs text-ok">
            <span className="whitespace-pre-wrap break-all">{n}</span>
            <button onClick={() => setNotices((ns) => ns.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {tab?.hint && (
          <div className="flex justify-between border-b border-line bg-white/5 px-3 py-1 text-xs text-muted">
            {tab.hint}
            <button onClick={() => setTabs((ts) => ts.map((x) => (x.ptyId === tab.ptyId ? { ...x, hint: '' } : x)))}>✕</button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tabs.map((t) => (
            <TerminalPane key={t.ptyId} ptyId={t.ptyId} visible={t.ptyId === cur} />
          ))}
          {!tab && (
            <div className="mx-auto max-w-lg space-y-4 p-8">
              <h2 className="text-lg font-semibold">Nueva sesión</h2>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-muted">
                  Proyecto
                  <select className="input mt-1" value={cwd ?? ''} onChange={(e) => setCwd(e.target.value || null)}>
                    <option value="">Elige un proyecto…</option>
                    {projects.map((p) => <option key={p} value={p}>{base(p)}</option>)}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  Cuenta
                  <select className="input mt-1" value={active ?? ''} onChange={(e) => setActive(e.target.value)}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex gap-2">
                <button className="btn-primary" disabled={claudeMissing} title={claudeMissing ? CLAUDE_MISSING : ''} onClick={() => void newSession()}>Nueva sesión</button>
                <button className="btn" onClick={addProject}>Agregar proyecto…</button>
              </div>
              {recent.length > 0 && (
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted">Sesiones recientes</div>
                  {recent.map(({ p, s }) => (
                    <button key={`${s.accountId}${s.id}`} disabled={claudeMissing} onClick={() => (setCwd(p), void start('resume', s.accountId, s, p))} className="block w-full rounded-card px-2 py-1.5 text-left text-xs hover:bg-white/5 disabled:opacity-50">
                      <div className="truncate text-sm">{s.title}</div>
                      <div className="text-muted">{base(p)} · {accLabel(s.accountId)} · {ago(s.mtimeMs)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {view === 'settings' && (
          <Settings
            accounts={accounts}
            statuses={statuses}
            cli={cli}
            error={error}
            onClose={() => setView('main')}
            onDetect={detect}
            onInstall={install}
            setShared={setShared}
            rename={rename}
            remove={remove}
            add={addAccount}
            login={(a) => start('login', a.id)}
          />
        )}
      </main>
      {hit && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
          <div className="w-96 rounded border border-line bg-surface p-4 text-sm">
            <b>{accounts.find((a) => a.id === hit.accountId)?.label} llegó a su límite ({hit.kind})</b>
            <p className="mb-3 text-xs text-muted">Se reinicia {hit.resetText}. Relay no cambia de cuenta por sí solo.</p>
            <p className="mb-2 truncate text-xs text-muted">Sesión: {hitTab?.title ?? '(pestaña cerrada)'}</p>
            {hitTab?.stale && <p className="mb-2 text-xs text-bad">{STALE}</p>}
            {modalError && <p className="mb-2 text-xs text-bad">{modalError}</p>}
            <div className="space-y-1">
              {accounts
                .filter((a) => a.id !== hit.accountId && a.provider === accounts.find((x) => x.id === hit.accountId)?.provider)
                .map((a) => {
                  const s = statuses[a.id]
                  const off = s?.loggedIn !== true || !!s.limited
                  return (
                    <button
                      key={a.id}
                      disabled={off || !hitTab || hitTab.stale}
                      onClick={() =>
                        run(async () => {
                          // the click is the confirmation, but the target may have changed since the card was drawn
                          const f = await window.relay.accounts.status(a.id, true)
                          setStatuses((m) => ({ ...m, [a.id]: f }))
                          if (f.loggedIn !== true || f.limited) throw new Error(`${a.label} ya no está disponible (${f.limited ? 'limitada' : 'sin sesión'})`)
                          await handoff(a, hitTab, false, setModalError)
                        }, setModalError)
                      }
                      className="block w-full rounded border border-line px-3 py-2 text-left enabled:hover:bg-white/10 disabled:opacity-40"
                    >
                      Continuar en {a.label}
                      <span className="block text-xs text-muted">
                        {!s ? '…' : s.loggedIn !== true ? 'sin sesión' : s.limited ? `limitada hasta ${s.limited.resetText}` : 'disponible'}
                      </span>
                    </button>
                  )
                })}
            </div>
            {!hit.resetAt && <p className="mt-2 text-xs text-muted">No se pudo interpretar la hora de reinicio, así que no se puede programar un recordatorio.</p>}
            {hits.length > 1 && <p className="mt-2 text-xs text-muted">{hits.length - 1} aviso(s) más en cola.</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn" disabled={!hit.resetAt} title={hit.resetAt ? '' : 'No se pudo leer la hora de reinicio; no hay recordatorio posible'} onClick={wait}>Esperar al reinicio</button>
              <button className="btn" onClick={() => dropHit()}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
      {modal.node}
    </div>
  )
}
