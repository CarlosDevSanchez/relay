import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardOptions, hasCard, labelsMatch, matchAsk, planOf, stillShows } from '../src/shared/prompt'
import { classifyScreen } from '../src/shared/screen'

const load = (name: string) => {
  const all = readFileSync(join(__dirname, 'fixtures/screens', name), 'utf8').replace(/\n$/, '').split('\n')
  const m = /^--cursor y=(\d+)/.exec(all.pop()!)!
  return { lines: all, cursorY: Number(m[1]) }
}
const card = (f: string) => {
  const d = classifyScreen(load(f)).dialog!
  return { d, ...cardOptions(d) }
}
const modes = (f: string) => card(f).options.map((o) => `${o.n}:${o.mode}`)

describe('dialog parsing for cards', () => {
  it('permission: options keep their wrapped text as `more`, body has the command', () => {
    const { d } = card('04b-permission-touch.txt')
    expect(d.options[1]).toMatchObject({ n: 2, text: 'Yes, and always allow access to', more: '/tmp/proj from this project' })
    expect(d.options[0]!.more).toBeUndefined()
    expect(d.body).toContain('touch created1.txt')
    expect(d.body).not.toContain('Do you want to proceed?')
    expect(d.question).toBe('Do you want to proceed?')
  })
  it('plan: only the decision list counts (the plan own steps 1. 2. are not options), the plan text is in the body and fingerprint', () => {
    const { d } = card('06a-plan-approval.txt')
    expect(d.options.map((o) => [o.n, o.text])).toEqual([[1, 'Yes, and use auto mode'], [2, 'Yes, manually approve edits'], [3, 'Tell Claude what to change']])
    expect(d.options[2]!.more).toBe('shift+tab to approve with this feedback')
    expect(d.question).toMatch(/Would you like to proceed\?/)
    expect(d.body).toContain('Add hello.txt')
    expect(d.fingerprint).toContain('Add a file hello.txt')
  })
  it('question: descriptions are `more`, the tab bar is in the body', () => {
    const { d } = card('05a-askuser.txt')
    expect(d.question).toBe('Which color do you prefer?')
    expect(d.options.map((o) => [o.n, o.text, o.more])).toEqual([[1, 'Red', 'Choose red'], [2, 'Blue', 'Choose blue'], [3, 'Type something.', undefined], [4, 'Chat about this', undefined]])
    expect(d.body).toEqual(['☐ Color'])
  })
})

describe('card options per dialog kind', () => {
  it('permission: every option is a digit', () => {
    expect(modes('04b-permission-touch.txt')).toEqual(['1:option', '2:option', '3:option', '4:option'])
    expect(modes('04f-permission-edit.txt')).toEqual(['1:option', '2:option', '3:option'])
  })
  it('single question: Type something is a text row, Chat about this a plain option', () => {
    expect(modes('05a-askuser.txt')).toEqual(['1:option', '2:option', '3:text', '4:option'])
    expect(card('05a-askuser.txt').multi).toBe(false)
    expect(modes('05e-askuser-tab2.txt')).toEqual(['1:option', '2:option', '3:text', '4:option'])
  })
  it('multi-select: checkboxes toggle with their state; the rest are plain options', () => {
    const c = card('05d-askuser-multi.txt')
    expect(c.multi).toBe(true)
    expect(c.options.map((o) => `${o.n}:${o.mode}:${o.label}:${o.checked}`)).toEqual(['1:toggle:Apple:false', '2:toggle:Pear:false', '3:toggle:Plum:false', '4:toggle:Type something:false', '5:option:Chat about this:undefined'])
    // a checked box changes the fingerprint (so a card is re-armed after each toggle)
    const l = load('05d-askuser-multi.txt')
    l.lines = l.lines.map((x) => x.replace('1. [ ] Apple', '1. [✔] Apple'))
    const after = classifyScreen(l).dialog!
    expect(cardOptions(after).options[0]).toMatchObject({ checked: true })
    expect(after.fingerprint).not.toBe(card('05d-askuser-multi.txt').d.fingerprint)
  })
  it('review: 1 submits, 2 cancels', () => {
    expect(card('05f-askuser-review.txt').options.map((o) => [o.n, o.label, o.mode])).toEqual([[1, 'Submit answers', 'option'], [2, 'Cancel', 'option']])
  })
  it('plan: option 3 is a text row', () => {
    expect(modes('06a-plan-approval.txt')).toEqual(['1:option', '2:option', '3:text'])
  })
  it('only permission / question / review / plan get cards', () => {
    expect(['permission', 'question', 'review', 'plan'].every((k) => hasCard(k as any))).toBe(true)
    expect(['trust', 'model', 'unknown'].some((k) => hasCard(k as any))).toBe(false)
  })
  it('options above 9 get no button (a digit cannot reach them)', () => {
    const d = classifyScreen({ lines: ['Pick', '❯ 1. a', '  2. b', ...Array.from({ length: 8 }, (_, i) => `  ${i + 3}. x`), ' Esc to cancel'].slice(0, 12).concat('  10. j'), cursorY: 12 }).dialog!
    expect(cardOptions(d).options.every((o) => o.n <= 9)).toBe(true)
  })
})

const RULE = '─'.repeat(100)
const DASH = '╌'.repeat(100)
const perm = (cmd: string[], hist: string[] = ['⏺ hola', '✻ Baked for 2s']) => {
  const lines = [...hist, RULE, ' Bash command', ' Tip: auto mode handles these prompts', ' Run it', DASH, ...cmd, DASH, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend']
  return { lines, cursorY: lines.length - 1 }
}

describe('long commands (M2)', () => {
  const long = (head: string) => [head, ...Array.from({ length: 20 }, (_, i) => ` echo line-${i}`)]
  it('a 21-line command shows its FIRST line in the body (the window of 20 rows used to cut it)', () => {
    const d = classifyScreen(perm(long(' rm -rf ~/important'))).dialog!
    expect(d.body).toContain('rm -rf ~/important')
    expect(d.truncated).toBeUndefined()
  })
  it('two commands with the same tail have different fingerprints', () => {
    const a = classifyScreen(perm(long(' rm -rf ~/important'))).dialog!.fingerprint
    const b = classifyScreen(perm(long(' ls'))).dialog!.fingerprint
    expect(a).not.toBe(b)
  })
  it('the dialog top rule scrolled off the screen: truncated (the card offers no answers)', () => {
    const l = perm(long(' rm -rf ~/important')).lines
    const cut = l.slice(l.indexOf(' echo line-3')) // viewport starts inside the command
    const d = classifyScreen({ lines: cut, cursorY: cut.length - 1 }).dialog!
    expect(d.truncated).toBe(true)
    expect(d.kind).toBe('permission')
  })
  it('the CLI Tip lines are not part of the body or the fingerprint', () => {
    const d = classifyScreen(perm([' ls'])).dialog!
    expect(d.body.some((l) => l.startsWith('Tip:'))).toBe(false)
    expect(d.fingerprint).not.toContain('Tip:')
  })
  it('a plan whose first rule is off screen is truncated; the real plan fixture is not', () => {
    expect(card('06a-plan-approval.txt').d.truncated).toBeUndefined()
    const l = load('06a-plan-approval.txt')
    const i = l.lines.findIndex((x) => /Ready to code/.test(x))
    const cut = l.lines.slice(i)
    expect(classifyScreen({ lines: cut, cursorY: cut.length - 1 }).dialog?.truncated).toBe(true)
  })
})

describe('option mapping (M3a)', () => {
  const q = (extra: string[]) => {
    const lines = [RULE, ' ☐ Color', 'Which color do you prefer?', '❯ 1. Red', ...extra, '  2. Blue', '  3. Type something.', RULE, '  4. Chat about this', 'Enter to select · Esc to cancel']
    return { lines, cursorY: lines.length - 1 }
  }
  it('an indented `1. x` under an option is its description, not a new list (the button must keep sending the real digit)', () => {
    for (const probe of ['     1. first do this', '      1. weird']) {
      const d = classifyScreen(q([probe])).dialog!
      expect(d.options.map((o) => [o.n, o.text])).toEqual([[1, 'Red'], [2, 'Blue'], [3, 'Type something.'], [4, 'Chat about this']])
      expect(d.options[0]!.more).toBe(probe.trim())
    }
  })
  it('a final group that does not count 1..k in a row is dialog:unknown (terminal), never a card', () => {
    const lines = [RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   3. No', ' Esc to cancel']
    expect(classifyScreen({ lines, cursorY: 4 }).state).toBe('dialog:unknown')
    const dup = [RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes', '   2. No', ' Esc to cancel']
    expect(classifyScreen({ lines: dup, cursorY: 5 }).state).toBe('dialog:unknown')
  })
  it('a scrolled list may start above 1', () => {
    const lines = [RULE, ' Do you want to proceed?', ' ❯ 4. d', '   5. e', ' Esc to cancel']
    expect(classifyScreen({ lines, cursorY: 4 }).dialog?.options.map((o) => o.n)).toEqual([4, 5])
  })
})

describe('transcript matching', () => {
  const input = { questions: [{ question: 'Which color do you prefer?', options: [{ label: 'Red', description: 'rojo' }, { label: 'Blue' }] }, { question: 'Which size do you want to use today?', options: [{ label: 'Big', description: 'grande' }] }, 7, { question: 5 }] }
  it('prefers the exact question; a partial screen text only when it identifies ONE question', () => {
    expect(matchAsk(input, 'Which color do you prefer?')).toEqual({ question: 'Which color do you prefer?', labels: ['Red', 'Blue'], desc: { Red: 'rojo' } })
    expect(matchAsk(input, 'you want to use today?')?.question).toBe('Which size do you want to use today?') // wrapped: the screen shows the tail
    expect(matchAsk(input, 'Which size do')?.question).toBe('Which size do you want to use today?') // cut: the head
    expect(matchAsk(input, 'Which')).toBeNull() // two questions start so
    expect(matchAsk(input, 'Something else')).toBeNull()
    expect(matchAsk(input, '  ')).toBeNull()
    expect(matchAsk(null, 'x')).toBeNull()
    expect(matchAsk({ questions: 'no' }, 'x')).toBeNull()
    const dup = { questions: [{ question: 'Same?' }, { question: 'Same?' }] }
    expect(matchAsk(dup, 'Same?')).toBeNull() // identical questions: cannot tell which is on screen
    expect(matchAsk({ questions: [{ question: 'Same? yes' }, { question: 'Same?' }] }, 'Same?')?.question).toBe('Same?') // exact beats prefix
  })
  it('the screen labels must carry the transcript labels at the same digits', () => {
    const o = cardOptions(card('05a-askuser.txt').d).options
    expect(labelsMatch(o, ['Red', 'Blue'])).toBe(true)
    expect(labelsMatch(o, ['Blue', 'Red'])).toBe(false)
    expect(labelsMatch(o, ['Red', 'Blue', 'Green', 'x', 'y'])).toBe(false)
    expect(labelsMatch(o, [])).toBe(true)
  })
  it('plan text of an ExitPlanMode input', () => {
    expect(planOf({ plan: '# P' })).toBe('# P')
    for (const bad of [null, {}, { plan: 3 }, 'x']) expect(planOf(bad)).toBe('')
  })
})

describe('risky options', () => {
  it('"always allow" and "switch to auto mode" are flagged, Yes / No are not', () => {
    expect(card('04b-permission-touch.txt').options.map((o) => !!o.risky)).toEqual([false, true, true, false])
    expect(card('04f-permission-edit.txt').options.map((o) => !!o.risky)).toEqual([false, true, false])
  })
})

describe('stillShows (the card guard)', () => {
  it('same kind and fingerprint only', () => {
    const a = classifyScreen(load('04b-permission-touch.txt'))
    const edit = classifyScreen(load('04f-permission-edit.txt'))
    expect(stillShows(a.dialog!, a)).toBe(true)
    expect(stillShows(a.dialog!, classifyScreen(load('04b-permission-touch.txt')))).toBe(true)
    expect(stillShows(a.dialog!, edit)).toBe(false) // another permission dialog
    expect(stillShows(a.dialog!, classifyScreen(load('05a-askuser.txt')))).toBe(false) // another kind
    expect(stillShows(a.dialog!, classifyScreen(load('02-idle.txt')))).toBe(false) // no dialog
    expect(stillShows(a.dialog!, { state: 'dialog:permission' })).toBe(false)
  })
})
