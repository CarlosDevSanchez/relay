// The composer bridge (F6.3): the renderer sends ids and text only; every byte that reaches the CLI's pty from these paths is built here.
// Never ^C (\x03), ^D (\x04) or ^Z (\x1a): the allowlist is Enter (after a bracketed paste), ESC (Stop / close a list) and ^U (clear the box).

export const MAX_SEND = 20_000
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** Stop: a single ESC interrupts the turn. */
export const STOP = '\x1b'

/** CRLF and a lone CR become LF; then every C0 control but \n and \t, DEL and C1 go (ESC would let the text close the paste early). */
const sanitize = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')

/** The message as the CLI wants it: bracketed paste, then Enter, in ONE write. */
export function pasteBytes(text: string): string {
  const clean = sanitize(text)
  if (!clean.trim()) throw new Error('Mensaje vacío')
  return `${PASTE_START}${clean}${PASTE_END}\r`
}

/** Empties the CLI's input box: ESC first only when a `/` or `@` list is open (it leaves the character behind), then ^U. */
export const clearSteps = (overlay: boolean): string[] => (overlay ? ['\x1b', '\x15'] : ['\x15'])
