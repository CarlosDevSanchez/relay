import { type Mode, modeFromFooter } from '../shared/controls'
import { type Screen, classifyScreen } from '../shared/screen'

interface Frame { lines: string[]; cursorY: number; /** last output chunk (pty:data seq) xterm has parsed */ seq: number; bracketed: boolean }
interface Source { read(): Frame; /** resolves once xterm has parsed everything already written to it */ flush(): Promise<void> }

/** Each TerminalPane registers a reader of its xterm viewport; the chat classifies it (the terminal may be hidden, its buffer is not). */
const sources = new Map<number, Source>()
export function registerScreen(ptyId: number, src: Source): () => void {
  sources.set(ptyId, src)
  return () => void sources.delete(ptyId)
}
export type Snap = Screen & { blank: boolean; seq: number; bracketed: boolean; /** permission mode named by the CLI footer (undefined = unreadable) */ mode: Mode | undefined }
/** Classifies the frame xterm holds right now. */
export function readScreen(ptyId: number, exited = false): Snap {
  const f = sources.get(ptyId)?.read() ?? { lines: [], cursorY: 0, seq: 0, bracketed: false }
  return { ...classifyScreen({ ...f, exited }), blank: f.lines.every((l) => !l.trim()), seq: f.seq, bracketed: f.bracketed, mode: modeFromFooter(f.lines) }
}
/** Same, after xterm parsed all the output it received (its write() parses on a later tick): the frame a write decision may rely on. */
export async function freshScreen(ptyId: number, exited = false): Promise<Snap> {
  await sources.get(ptyId)?.flush()
  return readScreen(ptyId, exited)
}
