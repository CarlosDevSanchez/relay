// Pure screen classifier (F6.3): the xterm viewport as text + the cursor row -> what the official CLI is showing. Rules: docs/spikes/F6b.md section 11;
// oracle: tests/fixtures/screens/README.md. Interface strings are the CLI's and may change between versions: anything not recognised degrades to
// `unknown` (the terminal is the fallback), never to `idle`.
// Known limits: a numbered list typed into the CLI's own box reads as `dialog:unknown` (blocked, the terminal opens): the safe direction. A command or plan that itself contains a
// full-width `─` rule line evades `truncated` (the card would show only the part after that line, and its fingerprint covers only that part).

export type DialogKind = 'permission' | 'plan' | 'review' | 'question' | 'model' | 'trust' | 'unknown'
export type ScreenState = 'idle' | 'working' | 'overlay' | 'input-pending' | 'exited' | 'unknown' | `dialog:${DialogKind}`
export interface ScreenInput {
  /** viewport rows, top to bottom (trailing blank rows may be missing) */
  lines: string[]
  /** 0-based viewport row of the cursor */
  cursorY: number
  exited?: boolean
  /** same rows with every dim/faint cell replaced by a space (the CLI's ghost suggestion in an empty box is dim, not typed). Only the input-box content check reads it; absent = lines */
  dim?: string[]
}
/** `more` = the indented lines under the option (a wrapped path, an AskUserQuestion description) */
export interface DialogOption { n: number; text: string; selected: boolean; more?: string }
export interface DialogInfo {
  kind: DialogKind
  question: string
  /** non-blank lines between the dialog's top rule and the options, minus the question and `╌` rows (the command, the file, the tab bar, the plan) */
  body: string[]
  options: DialogOption[]
  /** kind + body + options: a card is only valid while the live screen still yields the same fingerprint (F6.4) */
  fingerprint: string
  /** the dialog's top rule is not on screen (a long command or plan scrolled off): the card must not offer answers for what it cannot show */
  truncated?: boolean
}
export interface Screen {
  state: ScreenState
  dialog?: DialogInfo
  /** the footer / spinner say the CLI is mid-turn (also reported under an open list or pending text); only set when an input box is visible */
  busy?: boolean
}

const WINDOW = 20
const RULE = /^\s*─{20,}\s*$/
/** 1 = prefix up to the digit, 2 = `❯` marker, 3 = n, 4 = text */
const OPTION = /^(\s*(❯\s*)?)(\d+)\.\s+(\S.*)$/
const NUMBERED_MARK = /^\s*❯\s*\d+\./
const SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S.*…/
const TRUST = /Accessing workspace/
const ANCHORS: [DialogKind, RegExp][] = [
  ['review', /Review your answers|Ready to submit your answers\?/],
  ['plan', /Would you like to proceed\?|Ready to code\?/],
  ['permission', /Do you want to/],
  ['model', /Select model/],
  ['question', /Chat about this/],
  ['trust', TRUST]
]
const QUESTION = /(Do you want to|Would you like to|Ready to submit your answers|Is this a project)[^\n]*\?/

const blank = (l: string) => !l.trim()

export function classifyScreen({ lines, cursorY, exited, dim }: ScreenInput): Screen {
  if (exited) return { state: 'exited' }
  let last = lines.length - 1
  while (last >= 0 && blank(lines[last]!)) last--
  const end = Math.max(last, cursorY)
  const start = Math.max(0, end - WINDOW + 1)
  const w = lines.slice(start, end + 1)
  // lowest pair of rules whose first inner line is a non-numbered `❯` row and with only footer rows below: the input box
  const rules = w.flatMap((l, i) => (RULE.test(l) ? [i] : []))
  const bot = rules.at(-1) ?? -1
  const top = rules.at(-2) ?? -1
  const below = w.slice(bot + 1).filter((l) => !blank(l))
  const first = w[top + 1] ?? ''
  const hasBox = rules.length >= 2 && bot - top > 1 && /^\s*❯/.test(first) && !NUMBERED_MARK.test(first) && below.length <= 3
  const { options, first: firstOpt, ok } = parseOptions(w)

  if (!hasBox && (options.length >= 2 || w.some((l) => TRUST.test(l)))) {
    // a final group that is not 1..k in a row cannot be mapped to digits: unknown (terminal), never a card
    const kind = !ok ? 'unknown' : ANCHORS.find(([, re]) => w.some((l) => re.test(l)))?.[0] ?? 'unknown'
    // the whole screen, not the 20-row window: the command / plan text may sit above it (and the viewport pads with blank rows)
    return { state: `dialog:${kind}`, dialog: dialogInfo(kind, lines.slice(0, end + 1), options, firstOpt < 0 ? -1 : firstOpt + start) }
  }
  if (w.some((l) => /\/keybindings to customize/.test(l))) return { state: 'overlay' }
  if (!hasBox) return { state: 'unknown' }
  const busy = below.some((l) => /esc to interrupt/.test(l)) || w.slice(Math.max(0, top - 4), top).some((l) => SPINNER.test(l) && !/ for \d+s/.test(l))
  if (w.slice(Math.max(0, top - 6), top).some((l) => /^\s+(❯ )?\/\w[\w-]*\s{2,}\S/.test(l) || /^\s+[+◇] \S/.test(l))) return { state: 'overlay', busy }
  const inner = (dim ? dim.slice(start, end + 1) : w).slice(top + 1, bot).map((l, i) => (i ? l : l.replace(/^\s*❯\s?/, '')).trim()).join('\n').trim()
  if (inner && !/^Try "/.test(inner)) return { state: 'input-pending', busy }
  return { state: busy ? 'working' : 'idle', busy }
}

/**
 * The LAST numbered group (a plan's own steps `1. 2.` precede the decision `1. 2. 3.`: an unindented `1.` restarts the list). Rows indented to the option's text
 * column or deeper (also ones that look like `1. x`) are its `more`. `ok` = the group counts up one by one (it may start above 1 when the list scrolled).
 */
function parseOptions(w: string[]): { options: DialogOption[]; first: number; ok: boolean } {
  let options: DialogOption[] = []
  let first = -1
  let col = -1 // text column of the last option
  w.forEach((l, i) => {
    const m = OPTION.exec(l)
    if (m && !(col >= 0 && m[1]!.length >= col)) {
      const n = Number(m[3])
      if (n === 1) ((options = []), (first = i))
      else if (first < 0) first = i
      options.push({ n, text: m[4]!.trim(), selected: !!m[2] })
      col = l.length - m[4]!.length
    } else if (col >= 0 && l.trim() && !RULE.test(l) && l.search(/\S/) >= col) {
      const o = options.at(-1)!
      o.more = o.more ? `${o.more} ${l.trim()}` : l.trim()
    } else col = -1
  })
  return { options, first, ok: options.every((o, i) => !i || o.n === options[i - 1]!.n + 1) }
}

function dialogInfo(kind: DialogKind, all: string[], options: DialogOption[], firstOpt: number): DialogInfo {
  const head = firstOpt < 0 ? all : all.slice(0, firstOpt)
  const question = (head.findLast((l) => QUESTION.test(l)) ?? head.findLast((l) => !blank(l)) ?? '').trim()
  // the plan dialog has two rules (above its title, below the plan text): keep the plan text in the fingerprint
  const rules = head.flatMap((l, i) => (RULE.test(l) ? [i] : []))
  const from = (kind === 'plan' ? rules.at(-2) : rules.at(-1)) ?? -1
  const lines = head.slice(from + 1).filter((l) => !blank(l) && !/^[╌\s]+$/.test(l) && !RULE.test(l) && !/^Tip:/.test(l.trim())).map((l) => l.trim())
  const body = lines.filter((l) => l !== question)
  return {
    kind, question, body, options,
    fingerprint: [kind, ...lines, ...options.map((o) => `${o.n}. ${o.text}${o.more ? ` ${o.more}` : ''}`)].join('\n'),
    ...(from < 0 && kind !== 'trust' ? { truncated: true } : {})
  }
}

export interface Cell { ch: string; dim: boolean; inverse: boolean }
/**
 * One row's dim mask, placeholder shape only: the row's content (after the `❯` prompt) is blanked when all its non-space cells are dim, or it is one inverse cell
 * (the cursor over the suggestion's first char) followed only by dim cells. Anything else (typed text with a dim tail, e.g. voice-dictation interim text) is returned as is.
 */
export const maskDim = (cells: Cell[]): string => {
  const at = cells.flatMap((c, i) => (c.ch.trim() ? [i] : []))
  const p = cells[at[0] ?? 0]?.ch === '❯' ? at.shift() : -1
  const body = at.map((i) => cells[i]!)
  const ghost = body.every((c) => c.dim) || (body[0]!.inverse && body.length > 1 && body.slice(1).every((c) => c.dim))
  return cells.map((c, i) => (ghost && i !== p ? ' ' : c.ch || ' ')).join('').trimEnd()
}
