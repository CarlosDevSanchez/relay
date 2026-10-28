import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import { registerScreen } from './screens'

const FONT = 'ui-monospace, "SF Mono", Menlo, monospace'

/** Resolves any CSS color (oklch included) of the active daisyUI theme to #rrggbb through a canvas. */
const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
function hex(cssColor: string): string {
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000'
  ctx.fillStyle = cssColor
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`
}

/** xterm palette derived from the active theme variables (background, foreground, status colors). */
export function termTheme(): ITheme {
  const probe = document.createElement('i')
  document.body.append(probe)
  const c = (v: string): string => ((probe.style.color = `var(--color-${v})`), hex(getComputedStyle(probe).color))
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const bg = c('base-100')
  const fg = c('base-content')
  const mute = c('base-300')
  const t: ITheme = {
    background: bg,
    foreground: fg,
    cursor: c('primary'),
    cursorAccent: bg,
    selectionBackground: mute,
    black: dark ? mute : fg,
    red: c('error'),
    green: c('success'),
    yellow: c('warning'),
    blue: c('info'),
    magenta: c('secondary'),
    cyan: c('accent'),
    white: dark ? fg : mute,
    brightBlack: dark ? c('neutral') : mute,
    brightRed: c('error'),
    brightGreen: c('success'),
    brightYellow: c('warning'),
    brightBlue: c('info'),
    brightMagenta: c('secondary'),
    brightCyan: c('accent'),
    brightWhite: fg
  }
  probe.remove()
  return t
}

/**
 * Mount once per pty (parent keys it by ptyId); hidden, never unmounted, when its tab is inactive.
 * `keep`: hidden with `visibility` instead of `display:none`, so it keeps its size (fit, pty size) and its buffer while the chat covers it.
 */
export function TerminalPane({ ptyId, visible, keep }: { ptyId: number; visible: boolean; keep?: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  const sync = useRef<() => void>(() => undefined)
  const focus = useRef<() => void>(() => undefined)
  useEffect(() => {
    const theme = termTheme()
    const term = new Terminal({ fontSize: 13, fontFamily: FONT, theme, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el.current!)
    el.current!.style.backgroundColor = theme.background!
    sync.current = () => {
      if (!el.current?.clientWidth || !el.current.clientHeight) return // hidden tab
      fit.fit()
      term.refresh(0, term.rows - 1) // output written while hidden is painted now
      window.relay.pty.resize(ptyId, term.cols, term.rows)
    }
    focus.current = () => term.focus()
    sync.current()
    let parsed = 0
    const unreg = registerScreen(ptyId, {
      read: () => {
        const b = term.buffer.active
        return { lines: Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? ''), cursorY: b.cursorY, seq: parsed, bracketed: term.modes.bracketedPasteMode }
      },
      flush: () => new Promise<void>((r) => term.write('', r))
    })
    const ro = new ResizeObserver(() => sync.current())
    ro.observe(el.current!)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const retheme = () => {
      const t = termTheme()
      term.options.theme = t
      el.current!.style.backgroundColor = t.background!
    }
    mq.addEventListener('change', retheme)
    const offData = window.relay.pty.onData((id, d, seq) => id === ptyId && term.write(d, () => (parsed = seq)))
    const offExit = window.relay.pty.onExit((id, code) => id === ptyId && term.write(`\r\n[process exited: ${code}]\r\n`))
    const onKey = term.onData((d) => window.relay.pty.write(ptyId, d))
    return () => {
      unreg()
      ro.disconnect()
      mq.removeEventListener('change', retheme)
      offData()
      offExit()
      onKey.dispose()
      term.dispose()
    }
  }, [ptyId])
  // refit when the pane is shown again (tab switch, collapsed login terminal opened)
  useEffect(() => {
    if (visible)
      requestAnimationFrame(() => {
        sync.current()
        focus.current()
      })
  }, [visible])
  return <div ref={el} className={`h-full w-full px-3 py-2 ${visible ? 'fade-in' : keep ? 'invisible' : 'hidden'}`} />
}
