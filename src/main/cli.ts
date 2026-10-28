import { execFile } from 'node:child_process'
import type { CliInfo } from '../shared/types'

export const parseVersion = (out: string): string | undefined => /(?<![\d.])(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(out)?.[1]

/** `<bin> --version` with the given env (PATH). Only ENOENT counts as missing; a slow or failing binary is still installed. */
export function detectCli(bin: string, env: Record<string, string>, timeout = 5000, args = ['--version']): Promise<CliInfo> {
  return new Promise((res) =>
    execFile(bin, args, { env, timeout }, (err, out) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return res({ installed: false })
      const version = err ? undefined : parseVersion(String(out))
      res({ installed: true, ...(version ? { version } : {}) })
    })
  )
}
