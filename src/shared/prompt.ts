// Prompt cards (F6.4): which buttons a classified CLI dialog gets, and the closed set of actions a button may ask main to send (bytes: main/bridge.ts).
import type { DialogInfo, DialogKind, Screen } from './screen'

/** What a card button asks for. Main turns it into keys (digit / Tab / ESC / digit + line + Enter); nothing else can reach the dialog. */
export type AnswerAction =
  | { kind: 'option' | 'toggle'; n: number }
  | { kind: 'next' }
  | { kind: 'cancel' }
  | { kind: 'text'; n: number } // only the digit: the row takes focus, then the renderer checks the screen before sending the line
  | { kind: 'line'; text: string } // the typed line + Enter, accepted by main only right after a `text` digit

/** Dialog kinds that get a card; trust / model / unknown keep the F6.3 behaviour (notice + terminal opens). */
export const hasCard = (k: DialogKind): boolean => k === 'permission' || k === 'question' || k === 'review' || k === 'plan'

/** option = a digit selects and confirms; toggle = a digit flips a checkbox; text = the digit moves focus to a text row (then the line and Enter). */
/** `risky` = the option changes settings or the permission mode ("always allow", "switch to auto mode"). */
export interface CardOption { n: number; label: string; more?: string; mode: 'option' | 'toggle' | 'text'; checked?: boolean; risky?: boolean }
const RISKY = /always allow|switch to|auto mode|accept edits/i
const BOX = /^\[(.)\]\s*/

export function cardOptions(d: DialogInfo): { options: CardOption[]; multi: boolean } {
  const multi = d.kind === 'question' && d.options.some((o) => BOX.test(o.text))
  const options = d.options.filter((o) => o.n >= 1 && o.n <= 9).map((o): CardOption => {
    const box = BOX.exec(o.text)
    const label = o.text.replace(BOX, '')
    const text = (d.kind === 'question' && !multi && /^Type something/i.test(label)) || (d.kind === 'plan' && /^Tell Claude what to change/i.test(label))
    return { n: o.n, label, ...(o.more ? { more: o.more } : {}), mode: text ? 'text' : multi && box ? 'toggle' : 'option', ...(RISKY.test(label) ? { risky: true } : {}), ...(multi && box ? { checked: box[1] !== ' ' } : {}) }
  })
  return { options, multi }
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * The pending `AskUserQuestion` tool_use input (from the transcript) matched to the question on screen: the full question text, its option labels and descriptions.
 * Exact text first; a partial screen text (a wrapped or cut question) only when it identifies ONE question. Null = no match, the screen text stands.
 */
export function matchAsk(input: unknown, screenQuestion: string): { question: string; labels: string[]; desc: Record<string, string> } | null {
  const qs = (Array.isArray(rec(input).questions) ? (rec(input).questions as unknown[]) : []).map(rec).filter((x): x is Record<string, unknown> & { question: string } => typeof x.question === 'string')
  const sq = norm(screenQuestion)
  if (!sq) return null
  const exact = qs.filter((x) => norm(x.question) === sq)
  const part = qs.filter((x) => norm(x.question).startsWith(sq) || norm(x.question).endsWith(sq))
  const q = exact.length === 1 ? exact[0] : exact.length === 0 && part.length === 1 ? part[0] : undefined
  if (!q) return null
  const opts = Array.isArray(q.options) ? q.options.map(rec) : []
  const desc: Record<string, string> = {}
  for (const o of opts) if (typeof o.label === 'string' && typeof o.description === 'string') desc[norm(o.label)] = o.description
  return { question: q.question, labels: opts.flatMap((o) => (typeof o.label === 'string' ? [norm(o.label)] : [])), desc }
}
/** The screen's option n must carry the transcript's label n (a card whose digits do not map to the options the model asked is refused). */
export const labelsMatch = (options: CardOption[], labels: string[]): boolean => labels.every((l, i) => norm(options.find((o) => o.n === i + 1)?.label ?? '') === l)
/** The plan markdown of a pending `ExitPlanMode` tool_use. */
export const planOf = (input: unknown): string => (typeof rec(input).plan === 'string' ? (rec(input).plan as string) : '')

/** The live frame still shows the card's dialog: same kind and same fingerprint. Anything else (another dialog, none) and the card is dropped, nothing is sent. */
export const stillShows = (card: DialogInfo, live: Pick<Screen, 'state' | 'dialog'>): boolean => live.state === `dialog:${card.kind}` && live.dialog?.fingerprint === card.fingerprint
