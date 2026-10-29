import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Prefs } from '../shared/types'
import { checkVersion } from './updates'

export const DEFAULT_CONTINUE = 'Continúa exactamente donde lo dejaste.'

/** Initial prompt after a handoff: trimmed, 1-500 chars, no control characters, no leading dash (a CLI flag) and not a single ASCII word (a CLI subcommand such as `update`). */
export function checkContinueMessage(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (m.length < 1 || m.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(m) || m.startsWith('-') || /^[a-z][a-z-]*$/i.test(m)) throw new Error('Mensaje inválido: 1 a 500 caracteres, sin saltos de línea ni caracteres de control, sin empezar por "-" y no una sola palabra ASCII (podría tomarse por un subcomando del CLI)')
  return m
}

/** Warning threshold: integer 50-100. */
export const checkWarnAt = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 50 || v > 100) throw new Error('Umbral inválido: un número entero entre 50 y 100')
  return v
}

/** Version the user skips: '' (none) or x.y.z. */
export const checkSkipped = (v: unknown): string => (v === '' ? '' : checkVersion(v))

export function loadPrefs(home: string): Prefs {
  let d: any
  try {
    d = JSON.parse(readFileSync(join(home, 'prefs.json'), 'utf8'))
  } catch {
    d = {}
  }
  const n = d?.notifications
  const h = d?.handoff
  const u = d?.usage
  let warnAt = 90
  try {
    warnAt = checkWarnAt(u?.warnAt)
  } catch {
    /* default */
  }
  let message = DEFAULT_CONTINUE
  try {
    message = checkContinueMessage(h?.message)
  } catch {
    /* default */
  }
  let skipped = ''
  try {
    skipped = checkSkipped(d?.updates?.skipped)
  } catch {
    /* default */
  }
  return {
    notifications: { system: typeof n?.system === 'boolean' ? n.system : true, sound: typeof n?.sound === 'boolean' ? n.sound : true },
    handoff: { autoContinue: typeof h?.autoContinue === 'boolean' ? h.autoContinue : true, message },
    usage: { statusLine: typeof u?.statusLine === 'boolean' ? u.statusLine : true, warnAt },
    updates: { check: typeof d?.updates?.check === 'boolean' ? d.updates.check : true, skipped }
  }
}

/** Renderer input is untrusted: only known keys are merged; an invalid message throws. */
export function savePrefs(home: string, patch: unknown): Prefs {
  const cur = loadPrefs(home)
  const n = (patch as any)?.notifications
  for (const k of ['system', 'sound'] as const) if (typeof n?.[k] === 'boolean') cur.notifications[k] = n[k]
  const h = (patch as any)?.handoff
  if (typeof h?.autoContinue === 'boolean') cur.handoff.autoContinue = h.autoContinue
  if (typeof h === 'object' && h && 'message' in h) cur.handoff.message = checkContinueMessage(h.message)
  const u = (patch as any)?.usage
  if (typeof u?.statusLine === 'boolean') cur.usage.statusLine = u.statusLine
  if (typeof u === 'object' && u && 'warnAt' in u) cur.usage.warnAt = checkWarnAt(u.warnAt)
  const up = (patch as any)?.updates
  if (typeof up?.check === 'boolean') cur.updates.check = up.check
  if (typeof up === 'object' && up && 'skipped' in up) cur.updates.skipped = checkSkipped(up.skipped)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'prefs.json'), JSON.stringify(cur, null, 2))
  return cur
}
