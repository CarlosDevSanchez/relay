import type { AccountStatus, ProviderId } from '../shared/types'

export const statusLine = (s?: AccountStatus): string =>
  !s ? '…' : s.unchecked && s.loggedIn === null ? 'sin comprobar' : s.loggedIn === null ? 'estado desconocido' : s.loggedIn ? `${s.email ?? 'sesión iniciada'}${s.plan ? ` · ${s.plan}` : ''}` : 'sin sesión'

export const CLAUDE_MISSING = 'Claude Code no está instalado: instálalo desde Configuración > CLI'
export const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' }
export const missingMsg = (p: ProviderId): string => `${NAMES[p]} no está instalado: instálalo desde Configuración > CLI`

/** Suggested account name for a config dir (`~/.claude-mailo` -> `mailo`). */
export const suggestLabel = (dir: string): string => (dir.split('/').filter(Boolean).pop() ?? '').replace(/^\.(claude|codex)-?/, '') || 'Principal'

/** A dir named like Codex's home (`~/.codex`, `~/.codex-work`) is most likely a Codex account. */
export const guessProvider = (dir: string): ProviderId => (/^\.codex(-|$)/.test(dir.split('/').filter(Boolean).pop() ?? '') ? 'codex' : 'claude')
