import { describe, expect, it } from 'vitest'
import { ago } from '../src/renderer/ui'

describe('ago', () => {
  it('formats relative time', () => {
    const now = 10_000_000_000
    expect(ago(now, now)).toBe('ahora')
    expect(ago(now - 5 * 60000, now)).toBe('hace 5 min')
    expect(ago(now - 3 * 3600000, now)).toBe('hace 3 h')
    expect(ago(now - 2 * 86400000, now)).toBe('hace 2 d')
  })
})
