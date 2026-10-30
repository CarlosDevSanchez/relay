// Pure rules of the chat composer (F6.3, design 5.4 / 5.6); the screen state comes from screen.ts.
import { hasCard } from './prompt'
import type { DialogKind, ScreenState } from './screen'

/** send = write now (only from `idle`: a working CLI may raise a permission dialog any moment and `\r` would confirm it); confirm = the CLI's box is not empty, ask before clearing it; blocked = never write. */
export type SendPlan = 'send' | 'confirm' | 'blocked'
export const sendPlan = (s: ScreenState, bracketed = true): SendPlan => (!bracketed ? 'blocked' : s === 'idle' ? 'send' : s === 'overlay' || s === 'input-pending' ? 'confirm' : 'blocked')
/** The textarea stays usable while the CLI works (the draft can be prepared); not on dialogs, unknown screens or a finished session. */
export const canType = (s: ScreenState): boolean => s === 'working' || sendPlan(s) !== 'blocked'

export const isDialog = (s: ScreenState): boolean => s.startsWith('dialog:')

/** Relay's own wording for the line under the chat (never the CLI's verbs or glyphs). */
export function activityText(s: ScreenState, tool?: string | null): string {
  if (s === 'working') return tool ? `Trabajando… · ${tool}` : 'Trabajando…'
  if (s === 'idle') return 'Listo'
  if (s === 'overlay' || s === 'input-pending') return 'Listo · hay texto sin enviar en el CLI'
  if (isDialog(s)) return 'Esperando tu respuesta'
  if (s === 'exited') return 'Sesión finalizada'
  return 'El CLI necesita tu atención'
}

/** One-line hint under the composer explaining why it is limited ('' = nothing to say). */
export function composerHint(s: ScreenState, bracketed = true): string {
  if (!bracketed && s !== 'exited') return 'El CLI no acepta pegado: escribe en la terminal.'
  if (s === 'working') return 'Espera a que el CLI termine o pulsa Parar.'
  if (s === 'overlay' || s === 'input-pending') return 'La entrada del CLI no está vacía: te pediré confirmación para vaciarla.'
  if (isDialog(s)) return hasCard(s.slice(7) as DialogKind) ? 'Responde a la tarjeta o abre la terminal.' : 'El CLI espera una respuesta en la terminal; el chat no envía mientras tanto.'
  if (s === 'exited') return 'La sesión terminó.'
  if (s === 'unknown') return 'Relay no reconoce la pantalla del CLI: usa la terminal.'
  return ''
}

/** ↑/↓ over the sent messages: `pos` is an index into `hist`, `hist.length` = the draft being typed. */
export const browse = (len: number, pos: number, dir: -1 | 1): number => Math.min(len, Math.max(0, pos + dir))

/** Toast shown when Relay opens the terminal by itself; chosen from the state at the moment it fires (a redraw passes through partial `unknown` frames). */
export const autoOpenMessage = (s: ScreenState): string =>
  s === 'unknown' ? 'Relay no reconoce lo que muestra el CLI: se abrió la terminal para que lo veas y contestes.' : 'El CLI espera una respuesta que el chat aún no muestra: se abrió la terminal para que contestes.'
