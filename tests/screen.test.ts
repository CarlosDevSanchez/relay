import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyScreen } from '../src/shared/screen'

const dir = join(__dirname, 'fixtures/screens')
/** fixture file -> { lines, cursor, exited } (the last line is harness metadata) */
function load(name: string) {
  const all = readFileSync(join(dir, name), 'utf8').replace(/\n$/, '').split('\n')
  const meta = all.pop()!
  const m = /^--cursor y=(\d+) x=(\d+) bracketedPaste=\w+ exited=(.*)$/.exec(meta)!
  return { lines: all, cursorY: Number(m[1]), exited: m[3] !== 'null' }
}
const oracle = Object.fromEntries(
  readFileSync(join(dir, 'README.md'), 'utf8')
    .split('\n')
    .map((l) => /^\| `([^`]+)` \| (\S+) \|$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!])
)

describe('screen classifier vs the fixture oracle', () => {
  it('the oracle lists every fixture (a new fixture must get a row)', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()
    expect(Object.keys(oracle).sort()).toEqual(files)
  })
  for (const [file, state] of Object.entries(oracle)) {
    it(`${file} -> ${state}`, () => {
      expect(classifyScreen(load(file)).state).toBe(state)
    })
  }
})

describe('classifier details', () => {
  const rule = '─'.repeat(100)
  const box = (inner: string, footer = '  ⏸ manual mode on · ? for shortcuts') => [rule, `❯ ${inner}`, rule, footer]
  it('anchors on the last non-blank row, not on the last N rows', () => {
    expect(classifyScreen({ lines: ['', '', ...box(''), '', '', ''], cursorY: 3 }).state).toBe('idle')
  })
  it('the cursor row can be below the last text row', () => {
    expect(classifyScreen({ lines: box(''), cursorY: 3 }).state).toBe('idle')
  })
  it('matches the NBSP after the prompt glyph and a plain space alike', () => {
    expect(classifyScreen({ lines: [rule, '❯ hola', rule, ' f'], cursorY: 1 }).state).toBe('input-pending')
    expect(classifyScreen({ lines: box('hola'), cursorY: 1 }).state).toBe('input-pending')
  })
  it('the placeholder is not pending input', () => {
    expect(classifyScreen({ lines: box('Try "otra cosa"'), cursorY: 1 }).state).toBe('idle')
  })
  it('the lowest pair of rules is the box (an older pair above is history)', () => {
    const up = [rule, '❯ old', rule, 'salida', ...box('')]
    expect(classifyScreen({ lines: up, cursorY: 5 }).state).toBe('idle')
  })
  it('esc to interrupt in the footer or a spinner line means working', () => {
    expect(classifyScreen({ lines: box('', '  ⏸ manual mode on · esc to interrupt'), cursorY: 1 }).state).toBe('working')
    expect(classifyScreen({ lines: ['✽ Pensando…', ...box('')], cursorY: 2 }).state).toBe('working')
    expect(classifyScreen({ lines: ['✻ Baked for 2s · done 9:41 AM', ...box('')], cursorY: 2 }).state).toBe('idle')
  })
  it('exited wins over everything', () => {
    expect(classifyScreen({ lines: box(''), cursorY: 1, exited: true }).state).toBe('exited')
  })
  it('a blank screen and a screen without a box are unknown', () => {
    expect(classifyScreen({ lines: [], cursorY: 0 }).state).toBe('unknown')
    expect(classifyScreen({ lines: ['Algo inesperado', 'sin caja'], cursorY: 1 }).state).toBe('unknown')
  })
  it('changed interface strings degrade to unknown, never to idle', () => {
    const l = load('02-idle.txt').lines.map((x) => x.replaceAll('─', '='))
    expect(classifyScreen({ lines: l, cursorY: 37 }).state).toBe('unknown')
  })
  it('an unknown dialog (two options, no known anchor) is dialog:unknown', () => {
    const r = classifyScreen({ lines: ['Pick one', ' ❯ 1. A', '   2. B', ' Enter to select'], cursorY: 3 })
    expect(r.state).toBe('dialog:unknown')
  })
  it('an anchor text alone never opens the dialog gate', () => {
    expect(classifyScreen({ lines: ['Do you want to proceed?', ...box('')], cursorY: 3 }).state).toBe('idle')
  })
  it('extracts question, options, selection and a fingerprint of the permission dialog', () => {
    const r = classifyScreen(load('04b-permission-touch.txt'))
    expect(r.dialog?.kind).toBe('permission')
    expect(r.dialog?.question).toBe('Do you want to proceed?')
    expect(r.dialog?.options.map((o) => [o.n, o.text, o.selected])).toEqual([
      [1, 'Yes', true],
      [2, 'Yes, and always allow access to', false],
      [3, 'Yes, and switch to auto mode · auto mode handles these prompts for you', false],
      [4, 'No', false]
    ])
    expect(r.dialog?.fingerprint).toContain('touch created1.txt')
    // same screen -> same fingerprint; a different command -> different
    expect(classifyScreen(load('04b-permission-touch.txt')).dialog?.fingerprint).toBe(r.dialog?.fingerprint)
    const other = load('04b-permission-touch.txt')
    other.lines = other.lines.map((x) => x.replace('touch created1.txt', 'rm -rf x'))
    expect(classifyScreen(other).dialog?.fingerprint).not.toBe(r.dialog?.fingerprint)
  })
  it('non-dialog states carry no dialog info', () => {
    expect(classifyScreen(load('02-idle.txt')).dialog).toBeUndefined()
  })
  it('busy: a working footer is reported even when a list is open or the box has text', () => {
    expect(classifyScreen({ lines: ['  ❯ /debug    algo', ...box('/', '  esc to interrupt')], cursorY: 3 })).toMatchObject({ state: 'overlay', busy: true })
    expect(classifyScreen({ lines: box('hola', '  esc to interrupt'), cursorY: 1 })).toMatchObject({ state: 'input-pending', busy: true })
    expect(classifyScreen({ lines: box('hola'), cursorY: 1 }).busy).toBe(false)
  })
  it('known limit: a numbered list typed into the CLI box reads as dialog:unknown (the safe direction: blocked, terminal opens)', () => {
    expect(classifyScreen({ lines: [rule, '❯ 1. uno', '  2. dos', rule, '  ⏸ manual mode on'], cursorY: 1 }).state).toBe('dialog:unknown')
  })
})
