import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Prefs } from '../shared/types'

export const DEFAULT_CONTINUE = 'Continúa exactamente donde lo dejaste.'

/** Initial prompt after a handoff: trimmed, 1-500 chars, no control characters, no leading dash (a CLI flag) and not a single ASCII word (a CLI subcommand such as `update`). */
export function checkContinueMessage(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (m.length < 1 || m.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(m) || m.startsWith('-') || /^[a-z][a-z-]*$/i.test(m)) throw new Error('Mensaje inválido: 1 a 500 caracteres, sin saltos de línea ni caracteres de control, sin empezar por "-" y no una sola palabra ASCII (podría tomarse por un subcomando del CLI)')
  return m
}

export function loadPrefs(home: string): Prefs {
  let d: any
  try {
    d = JSON.parse(readFileSync(join(home, 'prefs.json'), 'utf8'))
  } catch {
    d = {}
  }
  const n = d?.notifications
  const h = d?.handoff
  let message = DEFAULT_CONTINUE
  try {
    message = checkContinueMessage(h?.message)
  } catch {
    /* default */
  }
  return {
    notifications: { system: typeof n?.system === 'boolean' ? n.system : true, sound: typeof n?.sound === 'boolean' ? n.sound : true },
    handoff: { autoContinue: typeof h?.autoContinue === 'boolean' ? h.autoContinue : true, message }
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
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'prefs.json'), JSON.stringify(cur, null, 2))
  return cur
}
