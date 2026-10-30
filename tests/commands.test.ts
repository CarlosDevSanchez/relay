import { describe, expect, it } from 'vitest'
import { BUILTIN, atToken, filterCmds, filterFiles, insertAt, mergeCmds, opensTui, slashQuery } from '../src/shared/commands'

describe('slash palette rules', () => {
  it('opens only while the draft is `/` plus a name (no space, no newline)', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/com')).toBe('com')
    expect(slashQuery('/compact ')).toBeNull()
    expect(slashQuery('hola /com')).toBeNull()
    expect(slashQuery('/a\nb')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })
  it('the built-in list has the required commands, with Spanish descriptions', () => {
    const names = BUILTIN.map((c) => c.name)
    for (const n of ['compact', 'clear', 'model', 'permissions', 'cost', 'usage', 'memory', 'agents', 'mcp', 'config', 'help', 'review', 'resume', 'init']) expect(names).toContain(n)
    expect(new Set(names).size).toBe(names.length)
    expect(BUILTIN.every((c) => c.desc.length > 5)).toBe(true)
  })
  it('filters by prefix first, then by substring, case-insensitive', () => {
    const l = [{ name: 'compact', desc: 'a' }, { name: 'clear', desc: 'b' }, { name: 'recompile', desc: 'c' }, { name: 'x', desc: 'compacta algo' }].map((c) => ({ ...c, src: 'cli' as const }))
    expect(filterCmds(l, 'CO').map((c) => c.name)).toEqual(['compact', 'recompile', 'x'])
    expect(filterCmds(l, '').map((c) => c.name)).toEqual(['compact', 'clear', 'recompile', 'x'])
    expect(filterCmds(l, 'zzz')).toEqual([])
  })
  it('marks the commands that open a TUI picker when run without args', () => {
    for (const t of ['/model', '/permissions', '/config', '/agents', '/mcp', '/resume', '/memory', ' /model ']) expect(opensTui(t), t).toBe(true)
    for (const t of ['/model opus', '/compact', '/clear', '/review', 'model', 'hola /model', '/custom-cmd']) expect(opensTui(t), t).toBe(false)
  })
  it('merges custom commands and skills (shared + the tab account), never shadowing a built-in', () => {
    const loc = (accountId: string | null, commands: string[], skills: string[]) => ({ accountId, label: 'x', agents: [{ name: 'ag', description: '' }], commands: commands.map((name) => ({ name, description: `d-${name}` })), skills: skills.map((name) => ({ name, description: '' })) })
    const out = mergeCmds([loc(null, ['deploy'], ['tdd']), loc('A', ['deploy', 'compact', 'bad name'], ['mine']), loc('B', ['other'], [])], 'A', true)
    expect(out.map((c) => `${c.src}:${c.name}`)).toEqual(['command:deploy', 'skill:tdd', 'skill:mine'])
    expect(out[0]!.desc).toBe('d-deploy')
    expect(mergeCmds([], 'A', true)).toEqual([])
    // an account that never linked the shared store does not see its entries
    expect(mergeCmds([loc(null, ['deploy'], ['tdd']), loc('A', ['own'], [])], 'A', false).map((c) => c.name)).toEqual(['own'])
  })
})

describe('@ file autocomplete rules', () => {
  it('finds the @ token before the caret', () => {
    expect(atToken('@', 1)).toEqual({ start: 0, query: '' })
    expect(atToken('mira @src/a', 11)).toEqual({ start: 5, query: 'src/a' })
    expect(atToken('mira @src/a y más', 11)).toEqual({ start: 5, query: 'src/a' })
    expect(atToken('mail me@x.com', 13)).toBeNull() // an @ glued to a word is not a mention
    expect(atToken('hola', 4)).toBeNull()
    expect(atToken('@a b', 4)).toBeNull() // the token ended at the space
  })
  it('filters files: base-name prefix first, then path substring, capped', () => {
    const f = ['docs/readme.md', 'src/app.ts', 'src/Readme.txt', 'lib/x.ts']
    expect(filterFiles(f, 'READ')).toEqual(['src/Readme.txt', 'docs/readme.md'].sort((a, b) => f.indexOf(a) - f.indexOf(b)))
    expect(filterFiles(f, 'src/')).toEqual(['src/app.ts', 'src/Readme.txt'])
    expect(filterFiles(f, '')).toHaveLength(4)
    expect(filterFiles(f, '', 2)).toEqual(['docs/readme.md', 'src/app.ts'])
    expect(filterFiles(f, 'zzz')).toEqual([])
  })
  it('inserts @path plus a space in place of the token and moves the caret after it', () => {
    expect(insertAt('mira @sr y más', { start: 5, query: 'sr' }, 'src/a.ts')).toEqual({ text: 'mira @src/a.ts y más', caret: 15 })
    expect(insertAt('@', { start: 0, query: '' }, 'a.md')).toEqual({ text: '@a.md ', caret: 6 })
  })
})
