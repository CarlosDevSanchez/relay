import type { AccountStatus } from '../shared/types'

export const statusLine = (s?: AccountStatus): string =>
  !s ? '…' : s.loggedIn === null ? 'estado desconocido' : s.loggedIn ? `${s.email ?? 'sesión iniciada'}${s.plan ? ` · ${s.plan}` : ''}` : 'sin sesión'

export const CLAUDE_MISSING = 'Claude Code no está instalado: instálalo desde Configuración > CLI'

/** Suggested account name for a config dir (`~/.claude-mailo` -> `mailo`). */
export const suggestLabel = (dir: string): string => (dir.split('/').filter(Boolean).pop() ?? '').replace(/^\.claude-?/, '') || 'Principal'
