import { describe, expect, it } from 'vitest'
import { MAX_SEND, STOP, clearSteps, pasteBytes } from '../src/main/bridge'
import { checkClaudePty, checkClear, checkPtyId, checkSendText, checkSeq } from '../src/main/validate'

const PS = '\x1b[200~'
const PE = '\x1b[201~'

describe('composer bridge bytes (built in main)', () => {
  it('wraps the text in a bracketed paste followed by Enter, in one write', () => {
    expect(pasteBytes('hola')).toBe(`${PS}hola${PE}\r`)
  })
  it('keeps multi-line text and tabs', () => {
    expect(pasteBytes('a\n\tb\nc')).toBe(`${PS}a\n\tb\nc${PE}\r`)
  })
  it('hostile input: no ^C, ^D, ESC (paste-end injection) or CR survives', () => {
    const out = pasteBytes('a\x03b\x1b[201~c\x04d\re\x1a\x7f\x1b')
    expect(out).toBe(`${PS}ab[201~cd\ne${PE}\r`)
    const inner = out.slice(PS.length, -(PE.length + 1))
    expect(inner).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    expect(out.match(/\x1b\[201~/g)).toHaveLength(1) // only the real terminator
    for (const b of ['\x03', '\x04', '\x1a']) expect(out).not.toContain(b)
  })
  it('CRLF text becomes LF text and a lone CR becomes a newline', () => {
    expect(pasteBytes('a\r\nb')).toBe(`${PS}a\nb${PE}\r`)
    expect(pasteBytes('a\rb')).toBe(`${PS}a\nb${PE}\r`)
  })
  it('C1 controls are stripped too', () => {
    expect(pasteBytes('a\u009bb')).toBe(`${PS}ab${PE}\r`)
  })
  it('refuses text that is empty once cleaned', () => {
    expect(() => pasteBytes('\x03\x1b')).toThrow()
    expect(() => pasteBytes(' \n ')).toThrow()
  })
  it('Stop is exactly ESC', () => {
    expect(STOP).toBe('\x1b')
  })
  it('clear sequences come from a fixed allowlist', () => {
    expect(clearSteps(false)).toEqual(['\x15'])
    expect(clearSteps(true)).toEqual(['\x1b', '\x15'])
  })
})

describe('IPC input checks', () => {
  it('send text: a non-empty string without NUL, up to the limit', () => {
    expect(checkSendText('hi')).toBe('hi')
    for (const bad of [1, null, undefined, '', 'a\0b', 'x'.repeat(MAX_SEND + 1), {}]) expect(() => checkSendText(bad)).toThrow()
    expect(checkSendText('x'.repeat(MAX_SEND))).toHaveLength(MAX_SEND)
  })
  it('pty id: an integer', () => {
    expect(checkPtyId(3)).toBe(3)
    for (const bad of ['3', 1.5, null, NaN]) expect(() => checkPtyId(bad)).toThrow()
  })
  it('clear options: a real boolean overlay flag', () => {
    expect(checkClear({ overlay: true })).toBe(true)
    expect(checkClear({ overlay: false })).toBe(false)
    for (const bad of [undefined, {}, { overlay: 'yes' }, 'x']) expect(() => checkClear(bad)).toThrow()
  })
  it('seq: a non-negative safe integer', () => {
    expect(checkSeq(0)).toBe(0)
    for (const bad of [-1, 1.5, '1', null, undefined, NaN]) expect(() => checkSeq(bad)).toThrow()
  })
  it('composer IPC only reaches a live Claude session pty', () => {
    const acc = [{ id: 'a', label: 'A', provider: 'claude', configDir: '/x' }, { id: 'c', label: 'C', provider: 'codex', configDir: '/y' }] as any
    expect(() => checkClaudePty({ accountId: 'a', sessionId: 's'}, acc)).not.toThrow()
    for (const bad of [undefined, { accountId: 'a', sessionId: undefined}, { accountId: 'c', sessionId: 's'}, { accountId: '__install__', sessionId: undefined}]) expect(() => checkClaudePty(bad, acc)).toThrow()
  })
})
