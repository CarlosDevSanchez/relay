import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { diffCounts, dur, pendingTool, relPath, toolHead } from '../src/renderer/Conversation'
import { Markdown, highlight } from '../src/renderer/md'

describe('conversation helpers', () => {
  it('markdown is inert: raw html, handlers, javascript: links and images never become elements', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '<script>alert(1)</script> <img src=x onerror="alert(2)">\n\n[x](javascript:alert(3)) ![i](http://e.com/a.png)\n\n<div onclick="x()">hi</div>' }))
    expect(html).not.toMatch(/<(script|img|iframe)|<[^>]*\s(onerror|onclick|href|src)=/)
    expect(html).toContain('&lt;script&gt;')
  })
  it('renders markdown structure and highlighted code as spans, never raw html', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '# T\n\n- a\n- b\n\n| h |\n|---|\n| c |\n\n```ts\nconst x = "<b>"\n```' }))
    expect(html).toContain('<li>')
    expect(html).toContain('<table')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
    expect(highlight('x', 'nope')).toEqual(['x'])
  })
  it('task lists draw one checkbox per item and the language label is sanitised', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '- [x] hecho\n- [ ] falta\n\n```ts{evil}"><b>\nx\n```' }))
    expect(html.match(/<input/g)).toHaveLength(2)
    expect(html).toContain('<span>ts</span>')
    expect(html).not.toContain('evil')
  })
  it('paths are shown relative to the project', () => {
    expect(relPath('/p/a/b.ts', '/p')).toBe('a/b.ts')
    expect(relPath('/q/b.ts', '/p')).toBe('/q/b.ts')
    expect(relPath('/pp/b.ts', '/p')).toBe('/pp/b.ts')
  })
  it('durations, diff counts and tool headers', () => {
    expect(dur(500)).toBe('<1 s')
    expect(dur(4000)).toBe('4 s')
    expect(dur(64000)).toBe('1 min 4 s')
    expect(diffCounts({ file: 'f', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c', ' d'] }] })).toEqual({ add: 2, del: 1 })
    const t = (name: string, input: unknown, extra = {}) => toolHead({ id: 'i', at: 0, kind: 'tool', name, input, status: 'ok', ...extra })
    expect(t('Bash', { command: 'ls\nx' }).target).toBe('ls')
    expect(t('Read', { file_path: '/a/b.ts' }, { result: 'x\ny' })).toEqual({ target: 'b.ts', note: '2 líneas' })
    expect(t('WebFetch', { url: 'https://docs.example.com/x?y=1' }).target).toBe('docs.example.com')
    expect(t('WebSearch', { query: 'q' }).target).toBe('q')
    expect(t('Glob', { pattern: '*.ts' }, { result: 'a\nb' }).note).toBe('2 archivos')
    expect(t('Agent', { description: 'D' }).target).toBe('D')
    expect(t('Mystery', {}).target).toBe('')
  })
  it('the pending tool for the activity line is the newest tool without a result', () => {
    const tool = (id: string, name: string, input: unknown, status: 'pending' | 'ok') => ({ id, at: 0, kind: 'tool' as const, name, input, status })
    expect(pendingTool([])).toBeNull()
    expect(pendingTool([tool('1', 'Bash', { command: 'ls' }, 'ok')])).toBeNull()
    expect(pendingTool([tool('1', 'Bash', { command: 'ls' }, 'ok'), tool('2', 'Bash', { command: 'bun test\nmore' }, 'pending')])).toBe('Bash · bun test')
    expect(pendingTool([tool('1', 'Mystery', {}, 'pending')])).toBe('Mystery')
  })
})
