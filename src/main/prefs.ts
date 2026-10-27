import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Prefs } from '../shared/types'


export function loadPrefs(home: string): Prefs {
  let d: any
  try {
    d = JSON.parse(readFileSync(join(home, 'prefs.json'), 'utf8'))
  } catch {
    d = {}
  }
  const n = d?.notifications
  return { notifications: { system: typeof n?.system === 'boolean' ? n.system : true, sound: typeof n?.sound === 'boolean' ? n.sound : true } }
}

/** Renderer input is untrusted: only known boolean keys are merged. */
export function savePrefs(home: string, patch: unknown): Prefs {
  const cur = loadPrefs(home)
  const n = (patch as any)?.notifications
  for (const k of ['system', 'sound'] as const) if (typeof n?.[k] === 'boolean') cur.notifications[k] = n[k]
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'prefs.json'), JSON.stringify(cur, null, 2))
  return cur
}

