import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadPrefs, savePrefs } from '../src/main/prefs'
import { checkUpdate, isNewer, parseVersion, releaseUrl } from '../src/main/updates'
import { checkVersion } from '../src/main/validate'

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch
const rel = (o: object = {}) => ({ tag_name: 'v0.2.0', html_url: 'https://evil.example/x', name: 'Relay v0.2.0', body: 'notes', published_at: '2026-01-01T00:00:00Z', ...o })

describe('versions', () => {
  it('parses strict x.y.z with optional v', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('0.10.0')).toEqual([0, 10, 0])
    for (const bad of ['1.2', 'v1.2.3-rc.1', '1.2.3+b', 'latest', '', ' 1.2.3', '1.2.3\n', '99999999999999999999.0.0', null, 5]) expect(parseVersion(bad)).toBeNull()
  })
  it('compares numerically', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
    expect(isNewer('x', '0.1.0')).toBe(false)
  })
  it('release URL is built from the version', () => expect(releaseUrl('1.2.3')).toBe('https://github.com/CarlosDevSanchez/relay/releases/tag/v1.2.3'))
})

describe('checkUpdate', () => {
  it('reports a newer release, never trusting html_url, truncating notes', async () => {
    const f = reply(200, rel({ body: 'x'.repeat(5000) }))
    const r = await checkUpdate('0.1.0', 'http://u/x', f)
    expect(r).toEqual({ status: 'available', info: { version: '0.2.0', notes: 'x'.repeat(2000) } })
    expect(JSON.stringify(r)).not.toContain('evil')
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('http://u/x')
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'Relay' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
  it('current when equal or older; tolerates missing fields', async () => {
    expect(await checkUpdate('0.2.0', undefined, reply(200, rel()))).toEqual({ status: 'current' })
    expect(await checkUpdate('0.3.0', undefined, reply(200, rel()))).toEqual({ status: 'current' })
    expect(await checkUpdate('0.1.0', undefined, reply(200, { tag_name: '0.2.0', name: 5, body: null }))).toEqual({ status: 'available', info: { version: '0.2.0', notes: '' } })
  })
  it('errors: prerelease tag, garbage, 403, 500, bad JSON, network, timeout', async () => {
    const err = { status: 'error' }
    expect(await checkUpdate('0.1.0', undefined, reply(200, rel({ tag_name: 'v0.2.0-beta.1' })))).toEqual(err)
    expect(await checkUpdate('0.1.0', undefined, reply(200, rel({ tag_name: 7 })))).toEqual(err)
    expect(await checkUpdate('0.1.0', undefined, reply(200, 'null'))).toEqual(err)
    expect(await checkUpdate('0.1.0', undefined, reply(403, { message: 'rate limit' }))).toEqual(err)
    expect(await checkUpdate('0.1.0', undefined, vi.fn(async () => new Response(JSON.stringify(rel()), { status: 200, headers: { 'content-length': String((1 << 20) + 1) } })) as unknown as typeof fetch)).toEqual(err) // declared size too big
    expect(await checkUpdate('0.1.0', undefined, reply(500, ''))).toEqual(err)
    expect(await checkUpdate('0.1.0', undefined, reply(200, JSON.stringify(rel({ body: 'x'.repeat(1 << 20) }))))).toEqual(err) // > 1 MB
    expect(await checkUpdate('0.1.0', undefined, reply(200, '{nope'))).toEqual(err)
    expect(await checkUpdate('0.1.0', undefined, vi.fn(async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toEqual(err)
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch
    expect(await checkUpdate('0.1.0', undefined, hang, 20)).toEqual(err)
  })
})

describe('updates prefs and validation', () => {
  const h = () => mkdtempSync(join(tmpdir(), 'relay-up-'))
  it('defaults, merges check and skipped, rejects bad versions', () => {
    const d = h()
    expect(loadPrefs(d).updates).toEqual({ check: true, skipped: '' })
    expect(savePrefs(d, { updates: { check: false, skipped: '0.2.0' } }).updates).toEqual({ check: false, skipped: '0.2.0' })
    expect(loadPrefs(d).updates).toEqual({ check: false, skipped: '0.2.0' })
    expect(savePrefs(d, { updates: { check: true } }).updates).toEqual({ check: true, skipped: '0.2.0' }) // toggling check keeps skipped
    expect(savePrefs(d, { updates: { check: false } }).updates.skipped).toBe('0.2.0')
    expect(savePrefs(d, { updates: { check: 'x' } }).updates.check).toBe(false)
    expect(savePrefs(d, { updates: { skipped: '' } }).updates.skipped).toBe('')
    for (const bad of ['v1.2.3', '1.2', '1.2.3-rc1', 5, null, '../x']) expect(() => savePrefs(d, { updates: { skipped: bad } })).toThrow(/Versión/)
    writeFileSync(join(d, 'prefs.json'), JSON.stringify({ updates: { check: 1, skipped: 'junk' } }))
    expect(loadPrefs(d).updates).toEqual({ check: true, skipped: '' })
  })
  it('checkVersion accepts only plain x.y.z', () => {
    expect(checkVersion('1.2.3')).toBe('1.2.3')
    for (const bad of ['v1.2.3', '', '1.2', {}, undefined, '1.2.3 ']) expect(() => checkVersion(bad)).toThrow()
  })
})
