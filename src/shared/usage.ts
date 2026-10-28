import type { AccountStatus, UsageWindow } from './types'

/** Bar colour: error from `warnAt`, warning from 20 points below it. */
export const usageLevel = (pct: number, warnAt: number): 'ok' | 'warning' | 'error' => (pct >= warnAt ? 'error' : pct >= warnAt - 20 ? 'warning' : 'ok')

export const windowTitle = (id: string): string => (id === '5h' ? 'Sesión 5h' : id === '7d' ? 'Semana' : id)

/** Windows still running (the CLIs drop a window once its reset time passes). */
export const liveWindows = (ws: UsageWindow[], now = Date.now()): UsageWindow[] => ws.filter((w) => now < w.resetsAt)

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

/** "3:10pm" today, "lun 3:10pm" another day (with the date when it is 6+ days away). */
export function fmtReset(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const h = d.getHours()
  const t = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
  if (d.toDateString() === new Date(now).toDateString()) return t
  return `${DAYS[d.getDay()]}${ms - now >= 6 * 86400_000 ? ` ${d.getDate()}/${d.getMonth() + 1}` : ''} ${t}`
}

/** "lleva 90% de su sesión de 5h · se reinicia 3:10pm" */
export const warnText = (label: string, w: UsageWindow, now = Date.now()): string =>
  `${label} lleva ${Math.round(w.pct)}% de su ${w.id === '5h' ? 'sesión de 5h' : w.id === '7d' ? 'semana' : `ventana de ${w.id}`} · se reinicia ${fmtReset(w.resetsAt, now)}`

/** A window at 100% means the account is out of quota: same `limited` shape the transcript scan produces (the one that resets last binds). */
export function limitedFromUsage(ws: UsageWindow[], now = Date.now()): AccountStatus['limited'] | undefined {
  const w = liveWindows(ws, now).filter((x) => x.pct >= 100).sort((a, b) => b.resetsAt - a.resetsAt)[0]
  return w && { kind: w.id === '5h' ? 'session' : 'weekly', resetText: fmtReset(w.resetsAt, now), resetAt: w.resetsAt }
}
