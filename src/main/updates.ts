import type { UpdateInfo } from '../shared/types'

const REPO = 'CarlosDevSanchez/relay'
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const MAX_NOTES = 2000
const MAX_BODY = 1 << 20

/** `x.y.z` (optional `v`), nothing else: prereleases and garbage are not versions. */
export function parseVersion(tag: unknown): [number, number, number] | null {
  const m = typeof tag === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag) : null
  const v = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  return v && v.every(Number.isSafeInteger) ? (v as [number, number, number]) : null
}

/** Plain `x.y.z` (no `v`), as stored in prefs and sent over IPC. */
export function checkVersion(v: unknown): string {
  if (typeof v !== 'string' || v.startsWith('v') || !parseVersion(v)) throw new Error('Versión inválida')
  return v
}

/** True when `a` is a strictly newer version than `b` (both must be valid). */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!
  return false
}

/** Built from the validated version, never from the `html_url` GitHub returns. */
export const releaseUrl = (version: string): string => `https://github.com/${REPO}/releases/tag/v${version}`

export type UpdateCheck = { status: 'current' } | { status: 'available'; info: UpdateInfo } | { status: 'error' }

/** Asks the GitHub Releases API (latest = newest published, no drafts or prereleases) whether a version newer than `current` exists. Any failure is `error`. */
export async function checkUpdate(current: string, url = LATEST, doFetch: typeof fetch = fetch, timeoutMs = 10_000): Promise<UpdateCheck> {
  try {
    const res = await doFetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Relay' }, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return { status: 'error' }
    if (Number(res.headers.get('content-length')) > MAX_BODY) return { status: 'error' }
    const text = await res.text()
    if (text.length > MAX_BODY) return { status: 'error' }
    const d = JSON.parse(text) as Record<string, unknown>
    const v = parseVersion(d?.tag_name)
    if (!v) return { status: 'error' }
    const version = v.join('.')
    if (!isNewer(version, current)) return { status: 'current' }
    const str = (x: unknown): string => (typeof x === 'string' ? x : '')
    return { status: 'available', info: { version, notes: str(d.body).slice(0, MAX_NOTES) } }
  } catch {
    return { status: 'error' }
  }
}
