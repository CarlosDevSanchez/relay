import { join } from 'node:path'

/** Claude Code names a project dir after the cwd with every non-alphanumeric char replaced by `-`. */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export const claudeProjectDir = (configDir: string, cwd: string): string =>
  join(configDir, 'projects', encodeCwd(cwd))
