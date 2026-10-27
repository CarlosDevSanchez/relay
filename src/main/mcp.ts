import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isDefaultInstall } from './paths'
import type { Account, McpReport, McpServer } from '../shared/types'

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * REDACTION BOUNDARY: only name, scope, transport and command basename / URL origin are extracted.
 * env, headers, args, URL path/query/userinfo and every other field are never copied.
 */
export function extractServers(raw: unknown, scope: McpServer['scope'], project?: string): McpServer[] {
  return Object.entries(obj(raw) ?? {}).map(([name, v]) => {
    const s = obj(v) ?? {}
    const command = str(s.command)
    const url = str(s.url)
    const t = str(s.type)
    const transport: McpServer['transport'] = t === 'stdio' || t === 'http' || t === 'sse' ? t : command ? 'stdio' : url ? 'http' : 'unknown'
    let target = ''
    if (transport === 'stdio') target = command ? basename(command.trim().split(/\s/)[0]!) : ''
    else if (url)
      try {
        target = new URL(url).origin
      } catch {}
    return { name: name.slice(0, 80), scope, transport, target, ...(project ? { project } : {}) }
  })
}

/** Reads `<configDir>/.claude.json` (`~/.claude.json` for the default install; user + per-project local scope) and `<project>/.mcp.json`; never starts a server. */
export function mcpReport(accounts: Account[], projects: string[], home: string): McpReport {
  return {
    accounts: accounts
      .filter((a) => a.provider === 'claude')
      .map((a) => {
        const j = obj(readJson(join(isDefaultInstall(a.configDir, home) ? home : a.configDir, '.claude.json')))
        const byProject = obj(j?.projects)
        return {
          accountId: a.id,
          servers: [...extractServers(j?.mcpServers, 'user'), ...projects.flatMap((p) => extractServers(obj(byProject?.[p])?.mcpServers, 'local', p))]
        }
      }),
    projects: projects.map((cwd) => ({ cwd, servers: extractServers(obj(readJson(join(cwd, '.mcp.json')))?.mcpServers, 'project') }))
  }
}
