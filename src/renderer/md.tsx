import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { Lexer, type Token, type Tokens } from 'marked'
import { type ReactNode, useMemo, useState } from 'react'

for (const [n, l, a] of [['bash', bash, ['sh', 'shell', 'zsh']], ['css', css, []], ['diff', diff, ['patch']], ['javascript', javascript, ['js', 'jsx']], ['json', json, []], ['python', python, ['py']], ['typescript', typescript, ['ts', 'tsx']], ['xml', xml, ['html', 'svg']], ['yaml', yaml, ['yml']]] as const) {
  hljs.registerLanguage(n, l)
  if (a.length) hljs.registerAliases([...a], { languageName: n })
}

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" }
const unent = (s: string): string => s.replace(/&(amp|lt|gt|quot|#x27);/g, (m) => ENT[m] ?? m)

/**
 * Highlighted code as React nodes, never as HTML: hljs only emits <span class="hljs-..."> and escaped text, which is parsed back
 * into elements here, so the source can never become markup. Unknown language = plain text.
 */
export function highlight(code: string, lang?: string): ReactNode[] {
  const l = (lang ?? '').toLowerCase().split(/\s/)[0] ?? ''
  if (!l || !hljs.getLanguage(l) || code.length > 50_000) return [code]
  const root: ReactNode[] = []
  const stack: { cls: string; kids: ReactNode[] }[] = []
  const cur = (): ReactNode[] => stack.at(-1)?.kids ?? root
  let k = 0
  for (const m of hljs.highlight(code, { language: l, ignoreIllegals: true }).value.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (m[1] !== undefined) stack.push({ cls: m[1], kids: [] })
    else if (m[2] !== undefined) cur().push(unent(m[2]))
    else {
      const s = stack.pop()
      if (s) cur().push(<span key={k++} className={s.cls}>{s.kids}</span>)
    }
  }
  return root
}

export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn btn-ghost btn-xs"
      aria-label={label}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        }, () => undefined)
      }
    >
      {done ? 'Copiado' : 'Copiar'}
    </button>
  )
}

/** Code block with a language label and a copy button. */
export function Code({ code, lang }: { code: string; lang?: string }) {
  const nodes = useMemo(() => highlight(code, lang), [code, lang])
  return (
    <div className="my-2 overflow-clip rounded-box border border-base-300 bg-base-200">
      <div className="flex items-center justify-between border-b border-base-300 px-2 py-0.5 text-xs opacity-70">
        <span>{/^[\w+#.-]+/.exec(lang ?? '')?.[0] ?? 'texto'}</span>
        <CopyButton text={code} label="Copiar código" />
      </div>
      <pre data-scroll className="m-0 overflow-x-auto p-3 text-xs leading-relaxed"><code className="hljs-code font-mono">{nodes}</code></pre>
    </div>
  )
}

// ---- markdown -> React elements (marked's lexer only). Nothing is ever set as HTML: raw HTML tokens are shown as text, images as their alt text and links are inert (the app opens no URLs), so transcript content cannot inject markup or navigate. ----
const inline = (ts: Token[] | undefined): ReactNode[] => (ts ?? []).map((t, i) => <Inline key={i} t={t} />)

function Inline({ t }: { t: Token }): ReactNode {
  switch (t.type) {
    case 'strong': return <strong>{inline((t as Tokens.Strong).tokens)}</strong>
    case 'em': return <em>{inline((t as Tokens.Em).tokens)}</em>
    case 'del': return <del>{inline((t as Tokens.Del).tokens)}</del>
    case 'codespan': return <code className="rounded bg-base-200 px-1 py-0.5 font-mono text-[0.92em]">{(t as Tokens.Codespan).text}</code>
    case 'br': return <br />
    case 'link': return <span className="text-primary underline decoration-dotted" title={(t as Tokens.Link).href}>{inline((t as Tokens.Link).tokens)}</span>
    case 'image': return <span className="opacity-70">[{(t as Tokens.Image).text}]</span>
    case 'text': case 'escape': return (t as Tokens.Text).tokens ? <>{inline((t as Tokens.Text).tokens)}</> : (t as Tokens.Text).text
    default: return (t as { raw?: string }).raw ?? '' // html, tag, anything else: literal text
  }
}

function Block({ t }: { t: Token }): ReactNode {
  switch (t.type) {
    case 'paragraph': return <p className="my-2">{inline((t as Tokens.Paragraph).tokens)}</p>
    case 'heading': return <p className="mb-1 mt-3 font-semibold" role="heading" aria-level={(t as Tokens.Heading).depth}>{inline((t as Tokens.Heading).tokens)}</p>
    case 'code': return <Code code={(t as Tokens.Code).text} {...((t as Tokens.Code).lang ? { lang: (t as Tokens.Code).lang } : {})} />
    case 'blockquote': return <blockquote className="my-2 border-l-2 border-base-300 pl-3 opacity-80">{blocks((t as Tokens.Blockquote).tokens)}</blockquote>
    case 'hr': return <hr className="my-3 border-base-300" />
    case 'list': {
      const l = t as Tokens.List
      const Tag = l.ordered ? 'ol' : 'ul'
      return (
        <Tag className={`my-2 pl-8 ${l.ordered ? 'list-decimal' : 'list-disc'}`} {...(l.ordered && l.start !== '' ? { start: l.start } : {})}>
          {l.items.map((it, i) => <li key={i}>{it.task && <input type="checkbox" className="checkbox checkbox-xs mr-1 align-middle" checked={!!it.checked} readOnly />}{blocks(it.tokens)}</li>)}
        </Tag>
      )
    }
    case 'table': {
      const tb = t as Tokens.Table
      return (
        <div data-scroll className="my-2 overflow-x-auto">
          <table className="table table-xs">
            <thead><tr>{tb.header.map((c, i) => <th key={i}>{inline(c.tokens)}</th>)}</tr></thead>
            <tbody>{tb.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c.tokens)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    }
    case 'space': case 'def': case 'checkbox': return null // checkbox: the list item draws its own
    case 'text': return <>{(t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens) : (t as Tokens.Text).text}</>
    default: return <p className="my-2 whitespace-pre-wrap">{(t as { raw?: string }).raw ?? ''}</p> // html block: literal text
  }
}
const blocks = (ts: Token[]): ReactNode[] => ts.map((t, i) => <Block key={i} t={t} />)

export function Markdown({ text }: { text: string }) {
  const tree = useMemo(() => blocks(new Lexer({ gfm: true }).lex(text)), [text])
  return <div className="break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0">{tree}</div>
}
