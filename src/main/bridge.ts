// The composer bridge (F6.3): the renderer sends ids and text only; every byte that reaches the CLI's pty from these paths is built here.
// Never ^C (\x03), ^D (\x04) or ^Z (\x1a): the allowlist is Enter (after a bracketed paste), ESC (Stop / close a list), ^U (clear the box) and Shift+Tab (KEYS).

import type { AnswerAction } from '../shared/prompt'

export const MAX_SEND = 20_000
export const MAX_ANSWER = 1000
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** Stop: a single ESC interrupts the turn. */
export const STOP = '\x1b'
/** `pty:key` allowlist (F6.5): a name from the renderer, the bytes from here. Shift+Tab cycles the permission mode. */
export const KEYS = { 'shift-tab': '\x1b[Z' } as const
export type KeyName = keyof typeof KEYS

/** CRLF and a lone CR become LF; then every C0 control but \n and \t, DEL and C1 go (ESC would let the text close the paste early). */
const sanitize = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')

/** The message as the CLI wants it: bracketed paste, then Enter, in ONE write. */
export function pasteBytes(text: string): string {
  const clean = sanitize(text).trimEnd() // the palette leaves `/name ` in the composer: the trailing space is not part of the command
  if (!clean.trim()) throw new Error('Mensaje vacío')
  return `${PASTE_START}${clean}${PASTE_END}\r`
}

/** Empties the CLI's input box: ESC first only when a `/` or `@` list is open (it leaves the character behind), then ^U. */
export const clearSteps = (overlay: boolean): string[] => (overlay ? ['\x1b', '\x15'] : ['\x15'])

/** A card answer as the writes to make, in order (each its own write: the CLI reads a digit and a text row differently). Allowlist: a digit 1-9, Tab, ESC, and for a text row the digit alone, then (verified by the renderer) one clean line + Enter. */
export function answerSteps(a: AnswerAction): string[] {
  switch (a.kind) {
    case 'option':
    case 'toggle':
      return [String(a.n)]
    case 'next':
      return ['\t']
    case 'cancel':
      return [STOP]
    case 'text':
      return [String(a.n)]
    case 'line': {
      const line = a.text.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim() // no bracketed paste inside a dialog (unverified): plain characters
      if (!line) throw new Error('Respuesta vacía')
      return [line, '\r']
    }
  }
}
