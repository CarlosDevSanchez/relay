// Pure rules of the `/` palette and the `@` autocomplete (F6.5, design 5.8). Both only fill the composer: the final text is pasted in one piece,
// a bare `/` or `@` is never typed into the CLI (docs/spikes/F6b.md 9).
import type { CatalogLocation } from './types'

export interface Cmd {
  name: string
  desc: string
  /** opens a picker or screen in the CLI when run without arguments: Relay switches to the terminal after sending it */
  tui?: boolean
  src: 'cli' | 'command' | 'skill'
}

const b = (name: string, desc: string, tui = false): Cmd => ({ name, desc, tui, src: 'cli' })
/** Curated list of the CLI's own commands (names are the CLI's, descriptions are Relay's). */
export const BUILTIN: Cmd[] = [
  b('compact', 'Resume la conversación para liberar contexto'),
  b('clear', 'Empieza una conversación nueva (cambia la sesión)'),
  b('model', 'Elige el modelo (guarda el predeterminado de la cuenta)', true),
  b('permissions', 'Revisa y edita las reglas de permisos', true),
  b('cost', 'Muestra el coste y los tokens de la sesión'),
  b('usage', 'Muestra el uso del plan y los límites', true),
  b('memory', 'Edita los archivos de memoria (CLAUDE.md)', true),
  b('agents', 'Gestiona los subagentes', true),
  b('mcp', 'Gestiona los servidores MCP', true),
  b('config', 'Abre los ajustes del CLI', true),
  b('help', 'Muestra la ayuda y los comandos', true),
  b('review', 'Revisa un pull request o los cambios actuales'),
  b('resume', 'Reanuda otra conversación', true),
  b('init', 'Crea un CLAUDE.md para este proyecto')
]

/** The palette is open while the draft is `/` plus the start of a name; any space (arguments) closes it. */
export const slashQuery = (draft: string): string | null => /^\/([\w:.-]*)$/.exec(draft)?.[1] ?? null

/** Prefix matches first, then name or description substrings; the list keeps its own order inside each group. */
export function filterCmds(list: Cmd[], q: string): Cmd[] {
  const s = q.toLowerCase()
  if (!s) return list
  const pre = list.filter((c) => c.name.toLowerCase().startsWith(s))
  return [...pre, ...list.filter((c) => !pre.includes(c) && (c.name.toLowerCase().includes(s) || c.desc.toLowerCase().includes(s)))]
}

/** A bare interactive built-in (`/model`, not `/model opus`). */
export const opensTui = (text: string): boolean => {
  const m = /^\/([\w:.-]+)$/.exec(text.trim())
  return !!m && BUILTIN.some((c) => c.tui && c.name === m[1])
}

/** Custom commands and skills visible to a tab: the shared store (only when the account linked it) plus the tab's account (never another account's); a built-in name is never shadowed. */
export function mergeCmds(catalog: CatalogLocation[], accountId: string, shared: boolean): Cmd[] {
  const seen = new Set(BUILTIN.map((c) => c.name))
  const out: Cmd[] = []
  for (const loc of catalog) {
    if (loc.accountId === null ? !shared : loc.accountId !== accountId) continue
    for (const [src, list] of [['command', loc.commands], ['skill', loc.skills]] as const) {
      for (const e of list) {
        if (seen.has(e.name) || !/^[\w:.-]+$/.test(e.name)) continue
        seen.add(e.name)
        out.push({ name: e.name, desc: e.description, src })
      }
    }
  }
  return out
}

/** The `@token` right before the caret (it must start the text or follow whitespace: `me@x.com` is not a mention). */
export function atToken(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[1]!.length - 1, query: m[1]! } : null
}

/** Replaces the token by `@path ` (one space; an existing one after it is reused) and returns the caret after it. */
export function insertAt(text: string, tok: { start: number; query: string }, path: string): { text: string; caret: number } {
  const before = text.slice(0, tok.start)
  const rest = text.slice(tok.start + 1 + tok.query.length).replace(/^ /, '')
  return { text: `${before}@${path} ${rest}`, caret: before.length + path.length + 2 }
}

/** Files whose base name starts with the query first, then any path containing it (case-insensitive); at most `max`. */
export function filterFiles(files: string[], q: string, max = 50): string[] {
  const s = q.toLowerCase()
  if (!s) return files.slice(0, max)
  const base = (f: string) => f.slice(f.lastIndexOf('/') + 1).toLowerCase()
  const pre = files.filter((f) => base(f).startsWith(s))
  return [...pre, ...files.filter((f) => !pre.includes(f) && f.toLowerCase().includes(s))].slice(0, max)
}
