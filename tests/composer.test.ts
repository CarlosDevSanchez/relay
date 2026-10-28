import { describe, expect, it } from 'vitest'
import { activityText, autoOpenMessage, browse, canType, composerHint, sendPlan } from '../src/shared/composer'
import type { ScreenState } from '../src/shared/screen'

describe('composer rules', () => {
  const plans: [ScreenState, string][] = [
    ['idle', 'send'], ['working', 'blocked'], ['overlay', 'confirm'], ['input-pending', 'confirm'],
    ['dialog:permission', 'blocked'], ['dialog:unknown', 'blocked'], ['unknown', 'blocked'], ['exited', 'blocked']
  ]
  it.each(plans)('%s -> %s', (s, p) => expect(sendPlan(s)).toBe(p))
  it('activity wording is Relay\'s own and includes the pending tool', () => {
    expect(activityText('working')).toBe('Trabajando…')
    expect(activityText('working', 'Bash · bun test')).toBe('Trabajando… · Bash · bun test')
    expect(activityText('idle')).toBe('Listo')
    expect(activityText('dialog:plan')).toBe('Esperando tu respuesta')
    expect(activityText('unknown')).toBe('El CLI necesita tu atención')
    expect(activityText('exited')).toBe('Sesión finalizada')
    expect(activityText('input-pending')).toMatch(/sin enviar/)
  })
  it('hints only where the composer is limited', () => {
    expect(composerHint('idle')).toBe('')
    for (const s of ['working', 'overlay', 'dialog:permission', 'exited', 'unknown'] as const) expect(composerHint(s)).not.toBe('')
  })
  it('a dialog with a card points at the card, one without at the terminal', () => {
    expect(composerHint('dialog:permission')).toBe('Responde a la tarjeta o abre la terminal.')
    expect(composerHint('dialog:trust')).toMatch(/en la terminal/)
    expect(composerHint('dialog:unknown')).toMatch(/en la terminal/)
  })
  it('history browsing clamps at both ends', () => {
    expect(browse(3, 3, -1)).toBe(2)
    expect(browse(3, 0, -1)).toBe(0)
    expect(browse(3, 2, 1)).toBe(3)
    expect(browse(3, 3, 1)).toBe(3)
    expect(browse(0, 0, -1)).toBe(0)
  })
  it('without bracketed paste nothing is sent', () => {
    expect(sendPlan('idle', false)).toBe('blocked')
    expect(sendPlan('input-pending', false)).toBe('blocked')
    expect(composerHint('idle', false)).toMatch(/terminal/)
  })
  it('working: typing is allowed, sending is not, and the hint says to wait or stop', () => {
    expect(canType('working')).toBe(true)
    expect(canType('dialog:plan')).toBe(false)
    expect(canType('unknown')).toBe(false)
    expect(canType('idle')).toBe(true)
    expect(composerHint('working')).toBe('Espera a que el CLI termine o pulsa Parar.')
  })
  it('the auto-open toast follows the state at fire time (unknown -> dialog while redrawing)', () => {
    expect(autoOpenMessage('unknown')).toMatch(/no reconoce/)
    expect(autoOpenMessage('dialog:permission')).toMatch(/espera una respuesta/)
  })
})
