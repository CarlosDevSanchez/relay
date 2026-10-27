import { useCallback, useEffect, useRef, useState } from 'react'
import { type Account, type AccountStatus, type CliStatus, CROSS_PROVIDER, type LimitHit, type ProviderId, type SessionInfo, type SharedReport } from '../shared/types'
import { LoginPanel } from './Login'
import { Onboarding } from './Onboarding'
import { Settings } from './Settings'
import { Sidebar } from './Sidebar'
import { NAMES, guessProvider, missingMsg, suggestLabel } from './status'
import { TerminalPane } from './Terminal'
import { Dialog, Dot, Dropdown, IconChevron, IconFolder, ToastStack, ago, useModal, useToasts } from './ui'

interface Tab {
  ptyId: number
  accountId: string
  cwd: string
  title: string
  sessionId?: string
  login?: boolean
  /** login tab: auth status re-read after the pty exited */
  checked?: boolean
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
  const toasts = useToasts()
  const setError = (m: string) => m && toasts.push('error', m)
  const [autoCont, setAutoCont] = useState(true)
  const [hits, setHits] = useState<LimitHit[]>([]) // queue, one per pty
  const [modalError, setModalError] = useState('')
  const [, setExitedCount] = useState(0) // bumps on every exit so Onboarding re-renders
  const exitedRef = useRef(new Set<number>())
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [cli, setCli] = useState<CliStatus | null>(null)
  const missing = (p: ProviderId | undefined) => !!p && cli?.[p]?.installed === false
  const provOf = (id: string) => accounts.find((a) => a.id === id)?.provider
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
    toasts.push(r.errors.length ? 'error' : 'success', [`Memoria compartida · ${label}: ${r.linked.length} enlace(s) creado(s)`, ...r.notes, ...(r.backups.length ? ['Copias de seguridad:', ...r.backups] : []), ...r.errors.map((e) => `ERROR ${e}`)].join('\n'), r.errors.length > 0 || r.backups.length > 0)

  const setShared = (a: Account, enabled: boolean) =>
    run(async () => {
      const r = await window.relay.shared.set(a.id, enabled)
      setAccounts(r.accounts)
      showShared(a.label, r.report)
    })

  const detect = useCallback(() => void window.relay.cli.detect().then(setCli).catch(() => undefined), [])
  useEffect(detect, [detect])
  // the limit modal states whether the target session will continue by itself
  useEffect(() => {
    if (hit) void window.relay.prefs.get().then((x) => setAutoCont(x.handoff.autoContinue))
  }, [hit?.ptyId])

  const loadStatus = useCallback(
    (id: string, refresh = false): Promise<AccountStatus | undefined> =>
      window.relay.accounts
        .status(id, refresh)
        .catch((): AccountStatus => ({ accountId: id, loggedIn: null, tokens5h: 0 }))
        .then((s) => (setStatuses((m) => ({ ...m, [id]: s })), s)),
    []
  )

  const markChecked = (accountId: string, ptyId: number) => loadStatus(accountId, true).then(() => setTabs((ts) => ts.map((x) => (x.ptyId === ptyId ? { ...x, checked: true } : x))))

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
        for (const a of l.filter((x) => x.managed && x.sharedMemory === undefined)) {
          const on = await modal.confirm('Memoria compartida', `¿Compartir la memoria global (${a.provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md, skills, agents, commands'}) de "${a.label}" con tus otras cuentas de ${NAMES[a.provider]}? Su contenido se mueve a ~/.relay/shared; lo que choque se guarda en ~/.relay/backups.`, 'Compartir', false, true)
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
        setExitedCount((n) => n + 1)
        setTabs((ts) => ts.map((t) => (t.ptyId === id ? { ...t, exited: true } : t)))
        setHits((hs) => hs.filter((h) => h.ptyId !== id))
        const t = tabsRef.current.find((x) => x.ptyId === id)
        if (t?.login) void markChecked(t.accountId, id)
        if (t?.install) detect()
        setTick((n) => n + 1)
      }),
    [loadStatus, detect]
  )

  // quota hit on a live session: ask the user (never switch by itself)
  useEffect(() => {
    const offHit = window.relay.onLimit((h) => {
      if (h.modelSpecific) {
        toasts.push('info', 'Se agotó el límite de uso de este modelo (no el de la cuenta): cambia de modelo con /model en el CLI. Relay no ofrece cambiar de cuenta.')
        return
      }
      setHits((hs) => [...hs.filter((x) => x.ptyId !== h.ptyId), h])
      accountsRef.current.forEach((a) => void loadStatus(a.id, true))
    })
    const offFocus = window.relay.onFocusTab((id) => {
      if (tabsRef.current.some((t) => t.ptyId === id)) setCur(id)
    })
    const offStale = window.relay.onStale((id) => setTabs((ts) => ts.map((t) => (t.ptyId === id ? { ...t, stale: true, hint: STALE } : t))))
    const offSession = window.relay.onSession((id, sessionId) => {
      const t = tabsRef.current.find((x) => x.ptyId === id)
      const first = !t?.sessionId // Codex assigns the id of a new session: found from its transcript, not a change
      setTabs((ts) => ts.map((x) => (x.ptyId === id ? { ...x, sessionId, hint: first ? '' : 'Sesión cambiada dentro del CLI.' } : x)))
      // the title is only known once the new transcript has a first prompt
      if (t) setTimeout(() => void window.relay.sessions(t.cwd).then((l) => {
        const title = (l.find((x) => x.id === sessionId)?.title ?? '(nueva sesión)').slice(0, 24)
        setTabs((ts) => ts.map((x) => (x.ptyId === id && x.sessionId === sessionId ? { ...x, title, ...(first ? {} : { hint: `Sesión cambiada a ${title}` }) } : x)))
      }), 3000)
    })
    const offSh = window.relay.onShared((m) => toasts.push('info', m))
    const offRem = window.relay.onReminder((id) => {
      const label = accountsRef.current.find((a) => a.id === id)?.label ?? id
      toasts.push('success', `${label} ya tiene cuota disponible`)
      void loadStatus(id, true)
    })
    return () => (offHit(), offFocus(), offStale(), offSession(), offRem(), offSh())
  }, [loadStatus])

  const open = (t: Tab, replace?: number) => {
    if (exitedRef.current.has(t.ptyId)) (t = { ...t, exited: true }), t.install && detect(), t.login && void markChecked(t.accountId, t.ptyId) // exited before the tab existed
    setTabs((ts) => (replace === undefined ? [...ts, t] : ts.map((x) => (x.ptyId === replace ? t : x))))
    setCur(t.ptyId)
    setView('main')
  }

  const start = (mode: 'new' | 'resume' | 'login', accountId: string, s?: SessionInfo, dir: string | null = cwd) =>
    run(async () => {
      if (missing(provOf(accountId))) throw new Error(missingMsg(provOf(accountId)!))
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

  const install = (provider: ProviderId = 'claude') =>
    run(async () => {
      const ptyId = await window.relay.cli.install(provider)
      if (ptyId !== null) open({ ptyId, accountId: '', cwd: '', install: true, title: `instalar ${provider}` })
    })

  const closeTab = (t: Tab) =>
    run(async () => {
      await window.relay.pty.kill(t.ptyId)
      setTabs((ts) => ts.filter((x) => x.ptyId !== t.ptyId))
      setCur((c) => (c === t.ptyId ? (tabsRef.current.filter((x) => x.ptyId !== t.ptyId).at(-1)?.ptyId ?? null) : c))
    })

  /** managed accounts get shared memory by default; imported dirs are only referenced */
  const createAccount = async (label: string, dir?: string, provider: ProviderId = 'claude'): Promise<Account | undefined> => {
    setError('')
    try {
      const a = await window.relay.accounts.add(label, provider, dir)
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
      const r = await modal.account('Nombre de la cuenta', imp && dir ? suggestLabel(dir) : '', dir ? guessProvider(dir) : 'claude')
      if (!r?.text) return
      const a = await createAccount(r.text, dir ?? undefined, r.choice)
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
      if (!t?.sessionId || !t.cwd) throw new Error('Abre primero una sesión con transcripción')
      if (t.stale) throw new Error(STALE)
      if (to.id === t.accountId) return
      if (ask) {
        const auto = (await window.relay.prefs.get()).handoff.autoContinue
        const msg = `Sesión "${t.title}" → cuenta "${to.label}". El proceso actual se detendrá y se reanudará la misma conversación en la otra cuenta.${auto ? `\nLa sesión continuará automáticamente en ${to.label}.` : ''}`
        if (!(await modal.confirm('Continuar en otra cuenta', msg, `Continuar en ${to.label}`, false, true))) return
      }
      const r = await window.relay.handoff({ ptyId: t.ptyId, fromAccountId: t.accountId, toAccountId: to.id, cwd: t.cwd, sessionId: t.sessionId })
      // the only thing sent to the new session is the CLI's initial prompt (argv), and only if the user enabled auto-continue
      open({ ptyId: r.ptyId, accountId: to.id, cwd: t.cwd, title: t.title, hint: r.autoContinued ? `Sesión continuada automáticamente en ${to.label}.` : `Sesión continuada en ${to.label}. Escribe "continúa" para seguir.`, ...(r.sessionId ? { sessionId: r.sessionId } : {}) }, t.ptyId)
      toasts.push('success', `Sesión "${t.title}" continúa en ${to.label}`)
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


  if (!loaded) return <div className="grid h-full place-items-center"><span className="loading loading-spinner loading-lg text-primary" />{modal.node}</div>
  if (ob)
    return (
      <>
        <Onboarding
          step={ob}
          cli={cli}
          statuses={statuses}
          projects={projects}
          modal={modal}
          onInstall={() => void install('claude')}
          installTab={tabs.find((t) => t.install)}
          isExited={(id) => exitedRef.current.has(id)}
          createAccount={createAccount}
          checkStatus={(id) => loadStatus(id, true)}
          next={() => setOb('project')}
          addProject={addProject}
          finish={() => (setTabs((ts) => ts.filter((t) => !t.install)), setOb(null))}
        />
        <ToastStack t={toasts} />
        {modal.node}
      </>
    )

  const targets = tab ? accounts.filter((a) => a.id !== tab.accountId && a.provider === accounts.find((x) => x.id === tab.accountId)?.provider) : []
  const canHand = !!tab?.sessionId && !tab.stale
  const tabStatus = (t: Tab) => {
    const lim = statuses[t.accountId]?.limited
    return t.exited ? { c: 'badge-ghost', l: 'finalizada', tone: 'off' as const } : t.stale ? { c: 'badge-warning', l: 'sesión cambiada', tone: 'warn' as const } : lim ? { c: 'badge-warning', l: 'cuenta limitada', tone: 'warn' as const } : { c: 'badge-success', l: t.login ? 'inicio de sesión' : t.install ? 'instalador' : 'activa', tone: 'ok' as const }
  }
  const hitAcc = hit && accounts.find((a) => a.id === hit.accountId)

  return (
    <div className="flex h-full">
      <Sidebar
        accounts={accounts}
        statuses={statuses}
        active={active}
        projects={projects}
        cwd={cwd}
        sessions={sessMap}
        missing={missing}
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
      <main className="relative flex min-w-0 flex-1 flex-col bg-base-100">
        <header className="drag flex items-end gap-2 border-b border-base-300 bg-base-200 pr-3 pt-9">
          <div role="tablist" className="tabs tabs-lift nodrag min-w-0 flex-1 flex-nowrap overflow-x-auto">
            {tabs.map((t) => (
              <div key={t.ptyId} role="presentation" className={`tab shrink-0 gap-2 text-xs ${t.ptyId === cur ? 'tab-active' : 'opacity-70'} ${t.exited ? 'line-through' : ''}`}>
                <button role="tab" aria-selected={t.ptyId === cur} onClick={() => setCur(t.ptyId)} className="flex items-center gap-2">
                  {t.accountId && <span className="badge badge-soft badge-sm">{accLabel(t.accountId)}</span>}
                  <span className="max-w-40 truncate">{t.title}</span>
                </button>
                <button className="btn btn-ghost btn-xs btn-circle" title="Cerrar pestaña" aria-label={`Cerrar pestaña ${t.title}`} onClick={(e) => (e.stopPropagation(), void closeTab(t))}>✕</button>
              </div>
            ))}
          </div>
          {tab?.accountId && !tab.login && (
            <div className="pb-1">
              <Dropdown
                title={canHand ? 'Continuar esta sesión en otra cuenta' : 'Necesitas una sesión abierta y con transcripción'}
                trigger={<>Continuar en otra cuenta <IconChevron open /></>}
                btnClass="btn btn-sm btn-soft btn-primary"
                items={[
                  ...targets.map((a) => {
                    const s = statuses[a.id]
                    const off = !canHand || s?.loggedIn !== true || !!s.limited
                    return { label: `${a.label}${!s ? '' : s.loggedIn !== true ? ' (sin sesión)' : s.limited ? ` (limitada hasta ${s.limited.resetText})` : ''}`, disabled: off, onClick: () => void handoff(a) }
                  }),
                  ...(accounts.some((a) => a.provider !== provOf(tab.accountId)) ? [{ label: CROSS_PROVIDER, disabled: true, onClick: () => undefined }] : [])
                ]}
              />
            </div>
          )}
        </header>
        {tab?.accountId && (
          <div className="flex items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1.5 text-xs">
            <IconFolder /> <b className="truncate">{tab.cwd ? base(tab.cwd) : tab.login ? 'inicio de sesión' : '—'}</b>
            <span className="opacity-40">·</span>
            <span className="badge badge-soft badge-primary badge-sm">{accLabel(tab.accountId)}</span>
            <span className={`badge badge-soft badge-sm gap-1 ${tabStatus(tab).c}`}><Dot tone={tabStatus(tab).tone} />{tabStatus(tab).l}</span>
            <span className="flex-1" />
            <button className="btn btn-ghost btn-xs" onClick={() => void closeTab(tab)} title="Cierra la pestaña y detiene su proceso">Cerrar pestaña</button>
          </div>
        )}
        {(['claude', 'codex'] as const).filter((p) => missing(p) && (p === 'claude' || accounts.some((a) => a.provider === p))).map((p) => (
          <div key={p} role="alert" className="alert alert-warning alert-soft rounded-none py-1 text-xs">
            <span>{NAMES[p]} no está instalado.</span>
            <button className="btn btn-xs" onClick={() => void install(p)}>Instalar {NAMES[p]}</button>
          </div>
        ))}
        {tab?.hint && (
          <div role="status" className="alert alert-soft rounded-none py-1 text-xs">
            <span>{tab.hint}</span>
            <button className="btn btn-ghost btn-xs btn-circle" aria-label="Descartar" onClick={() => setTabs((ts) => ts.map((x) => (x.ptyId === tab.ptyId ? { ...x, hint: '' } : x)))}>✕</button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tabs.map((t) =>
            t.login ? (
              <div key={t.ptyId} className={`h-full overflow-y-auto p-6 ${t.ptyId === cur ? 'fade-in' : 'hidden'}`}>
                <div className="mx-auto max-w-xl">
                  <LoginPanel
                    ptyId={t.ptyId}
                    provider={provOf(t.accountId) ?? 'claude'}
                    running={!t.exited}
                    {...(t.exited && t.checked ? { status: statuses[t.accountId] ?? { accountId: t.accountId, loggedIn: null, tokens5h: 0 } } : {})}
                    onRetry={() => void closeTab(t).then(() => start('login', t.accountId))}
                    onContinue={() => void closeTab(t)}
                    continueLabel="Cerrar"
                  />
                </div>
              </div>
            ) : (
              <TerminalPane key={t.ptyId} ptyId={t.ptyId} visible={t.ptyId === cur} />
            )
          )}
          {!tab && (
            <div className="mx-auto max-w-lg p-8">
              <div className="card card-border bg-base-100 shadow-sm">
                <div className="card-body gap-4">
                  <h2 className="card-title">Nueva sesión</h2>
                  <div className="grid grid-cols-2 gap-3">
                    <fieldset className="fieldset">
                      <legend className="fieldset-legend">Proyecto</legend>
                      <select className="select w-full" aria-label="Proyecto" value={cwd ?? ''} onChange={(e) => setCwd(e.target.value || null)}>
                        <option value="">Elige un proyecto…</option>
                        {projects.map((p) => <option key={p} value={p}>{base(p)}</option>)}
                      </select>
                    </fieldset>
                    <fieldset className="fieldset">
                      <legend className="fieldset-legend">Cuenta</legend>
                      <select className="select w-full" aria-label="Cuenta" value={active ?? ''} onChange={(e) => setActive(e.target.value)}>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                    </fieldset>
                  </div>
                  <div className="card-actions">
                    <button className="btn btn-primary" disabled={missing(provOf(active ?? ''))} title={missing(provOf(active ?? '')) ? missingMsg(provOf(active ?? '')!) : ''} onClick={() => void newSession()}>Nueva sesión</button>
                    <button className="btn btn-ghost" onClick={addProject}>Agregar proyecto…</button>
                  </div>
                </div>
              </div>
              {recent.length > 0 && (
                <ul className="menu mt-4 w-full p-0">
                  <li className="menu-title">Sesiones recientes</li>
                  {recent.map(({ p, s }) => (
                    <li key={`${s.accountId}${s.id}`} className={missing(provOf(s.accountId)) ? 'menu-disabled' : ''}>
                      <button disabled={missing(provOf(s.accountId))} onClick={() => (setCwd(p), void start('resume', s.accountId, s, p))} className="flex-col items-start gap-0 text-left">
                        <span className="w-full truncate text-sm">{s.title}</span>
                        <span className="text-xs opacity-60">{base(p)} · {accLabel(s.accountId)} · {ago(s.mtimeMs)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </main>
      {view === 'settings' && (
        <Settings
          accounts={accounts}
          statuses={statuses}
          cli={cli}
          onClose={() => setView('main')}
          onDetect={detect}
          onInstall={(p) => void install(p)}
          setShared={setShared}
          rename={rename}
          remove={remove}
          add={addAccount}
          login={(a) => start('login', a.id)}
        />
      )}
      {hit && (
        <Dialog key={hit.ptyId} label="Límite alcanzado" onClose={() => dropHit()} boxClass="max-w-md">
          <h3 className="text-base font-semibold">{hitAcc?.label} llegó a su límite ({hit.kind})</h3>
          <p className="mt-1 text-sm opacity-70">Se reinicia {hit.resetText}. Relay no cambia de cuenta por sí solo.</p>
          <p className="mt-2 truncate text-xs opacity-60">Sesión: {hitTab?.title ?? '(pestaña cerrada)'}</p>
          {hitTab?.stale && <div role="alert" className="alert alert-error alert-soft mt-2 text-xs">{STALE}</div>}
          {modalError && <div role="alert" className="alert alert-error alert-soft mt-2 text-xs">{modalError}</div>}
          <div className="mt-3 space-y-2">
            {accounts
              .filter((a) => a.id !== hit.accountId && a.provider === hitAcc?.provider)
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
                    className="btn btn-outline h-auto w-full flex-col items-start gap-0 py-2 text-left font-normal"
                  >
                    <span className="font-medium">Continuar en {a.label}</span>
                    <span className="text-xs opacity-60">
                      {!s ? '…' : s.loggedIn !== true ? 'sin sesión' : s.limited ? `limitada hasta ${s.limited.resetText}` : 'disponible'}
                    </span>
                    {autoCont && !off && <span className="text-xs text-primary">La sesión continuará automáticamente en {a.label}</span>}
                  </button>
                )
              })}
          </div>
          {!hit.resetAt && <p className="mt-2 text-xs opacity-60">No se pudo interpretar la hora de reinicio, así que no se puede programar un recordatorio.</p>}
          {hits.length > 1 && <p className="mt-2 text-xs opacity-60">{hits.length - 1} aviso(s) más en cola.</p>}
          <div className="modal-action">
            <button className="btn btn-ghost" disabled={!hit.resetAt} title={hit.resetAt ? '' : 'No se pudo leer la hora de reinicio; no hay recordatorio posible'} onClick={wait}>Esperar al reinicio</button>
            <button className="btn" data-autofocus onClick={() => dropHit()}>Cerrar</button>
          </div>
        </Dialog>
      )}
      <ToastStack t={toasts} />
      {modal.node}
    </div>
  )
}
