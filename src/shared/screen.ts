// Pure screen classifier (F6.3): the xterm viewport as text + the cursor row -> what the official CLI is showing. Rules: docs/spikes/F6b.md section 11;
// oracle: tests/fixtures/screens/README.md. Interface strings are the CLI's and may change between versions: anything not recognised degrades to
// `unknown` (the terminal is the fallback), never to `idle`.
// Known limit: a numbered list typed into the CLI's own box reads as `dialog:unknown` (blocked, the terminal opens): the safe direction.

export type DialogKind = 'permission' | 'plan' | 'review' | 'question' | 'model' | 'trust' | 'unknown'
export type ScreenState = 'idle' | 'working' | 'overlay' | 'input-pending' | 'exited' | 'unknown' | `dialog:${DialogKind}`
export interface ScreenInput {
  /** viewport rows, top to bottom (trailing blank rows may be missing) */
  lines: string[]
  /** 0-based viewport row of the cursor */
  cursorY: number
  exited?: boolean
}
export interface DialogOption { n: number; text: string; selected: boolean }
export interface DialogInfo {
  kind: DialogKind
  question: string
  options: DialogOption[]
  /** kind + body + options: a card is only valid while the live screen still yields the same fingerprint (F6.4) */
  fingerprint: string
}
export interface Screen {
  state: ScreenState
  dialog?: DialogInfo
  /** the footer / spinner say the CLI is mid-turn (also reported under an open list or pending text); only set when an input box is visible */
  busy?: boolean
}

const WINDOW = 20
const RULE = /^\s*─{20,}\s*$/
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(\S.*)$/
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

export function classifyScreen({ lines, cursorY, exited }: ScreenInput): Screen {
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
  const options = w.flatMap((l) => {
    const m = OPTION.exec(l)
    return m ? [{ n: Number(m[2]), text: m[3]!.trim(), selected: !!m[1] }] : []
  })

  if (!hasBox && (options.length >= 2 || w.some((l) => TRUST.test(l)))) {
    const kind = ANCHORS.find(([, re]) => w.some((l) => re.test(l)))?.[0] ?? 'unknown'
    return { state: `dialog:${kind}`, dialog: dialogInfo(kind, w, options) }
  }
  if (w.some((l) => /\/keybindings to customize/.test(l))) return { state: 'overlay' }
  if (!hasBox) return { state: 'unknown' }
  const busy = below.some((l) => /esc to interrupt/.test(l)) || w.slice(Math.max(0, top - 4), top).some((l) => SPINNER.test(l) && !/ for \d+s/.test(l))
  if (w.slice(Math.max(0, top - 6), top).some((l) => /^\s+(❯ )?\/\w[\w-]*\s{2,}\S/.test(l) || /^\s+[+◇] \S/.test(l))) return { state: 'overlay', busy }
  const inner = w.slice(top + 1, bot).map((l, i) => (i ? l : l.replace(/^\s*❯\s?/, '')).trim()).join('\n').trim()
  if (inner && !/^Try "/.test(inner)) return { state: 'input-pending', busy }
  return { state: busy ? 'working' : 'idle', busy }
}

function dialogInfo(kind: DialogKind, w: string[], options: DialogOption[]): DialogInfo {
  const firstOpt = w.findIndex((l) => OPTION.test(l))
  const head = firstOpt < 0 ? w : w.slice(0, firstOpt)
  const question = (head.findLast((l) => QUESTION.test(l)) ?? head.findLast((l) => !blank(l)) ?? '').trim()
  const from = head.findLastIndex((l) => RULE.test(l))
  const body = head.slice(from + 1).filter((l) => !blank(l) && !/^[╌\s]+$/.test(l)).map((l) => l.trim())
  return { kind, question, options, fingerprint: [kind, ...body, ...options.map((o) => `${o.n}. ${o.text}`)].join('\n') }
}
