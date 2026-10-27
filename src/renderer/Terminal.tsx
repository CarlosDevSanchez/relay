import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'

/** Mount once per pty (parent keys it by ptyId); hidden, never unmounted, when its tab is inactive. */
export function TerminalPane({ ptyId, visible }: { ptyId: number; visible: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const term = new Terminal({ fontSize: 13, theme: { background: '#1f1e1d' }, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el.current!)
    const sync = () => {
      if (!el.current?.clientWidth) return // hidden tab
      fit.fit()
      window.relay.pty.resize(ptyId, term.cols, term.rows)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el.current!)
    const offData = window.relay.pty.onData((id, d) => id === ptyId && term.write(d))
    const offExit = window.relay.pty.onExit((id, code) => id === ptyId && term.write(`\r\n[process exited: ${code}]\r\n`))
    const onKey = term.onData((d) => window.relay.pty.write(ptyId, d))
    term.focus()
    return () => {
      ro.disconnect()
      offData()
      offExit()
      onKey.dispose()
      term.dispose()
    }
  }, [ptyId])
  return <div ref={el} className={`h-full w-full p-2 ${visible ? '' : 'hidden'}`} />
}
