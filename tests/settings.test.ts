import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCatalog, listEntries, parseFrontmatter } from '../src/main/catalog'
import { detectCli, parseVersion } from '../src/main/cli'
import { buildEnv, plainEnv } from '../src/main/env'
import { extractServers, mcpReport } from '../src/main/mcp'
import { installCommand } from '../src/main/providers'
import { candidateDirs, canProbe, isDefaultInstall } from '../src/main/paths'
import { sharedDir } from '../src/main/shared'
import { checkInstall } from '../src/main/validate'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'relay-st-')))
const w = (p: string, c: string) => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, c))
const acct = (configDir: string, id = 'a1') => ({ id, label: id, provider: 'claude' as const, configDir })

describe('frontmatter', () => {
  it('parses simple, quoted, folded and CRLF; tolerates garbage and truncation', () => {
    expect(parseFrontmatter('---\nname: x\ndescription: "Hi: there"\n---\nbody')).toEqual({ name: 'x', description: 'Hi: there' })
    expect(parseFrontmatter('---\r\ndescription: >\r\n  one\r\n  two\r\nname: n\r\n---')).toEqual({ description: 'one two', name: 'n' })
    expect(parseFrontmatter('﻿---\ndescription: d\n')).toEqual({ description: 'd' }) // no closing fence
    expect(parseFrontmatter('no frontmatter')).toEqual({})
    expect(parseFrontmatter('')).toEqual({})
  })
})

describe('catalog', () => {
  it('lists skills/agents/commands, falls back to the filename, skips shared links and junk', () => {
    const home = tmp()
    const cfg = tmp()
    const sh = sharedDir(home)
    w(join(sh, 'skills/s1/SKILL.md'), '---\nname: shared-skill\ndescription: S\n---')
    w(join(sh, 'agents/ag.md'), '---\ndescription: shared agent\n---')
    w(join(cfg, 'skills/own/SKILL.md'), '---\ndescription: mine\n---')
    w(join(cfg, 'skills/nodoc/README.md'), 'x')
    w(join(cfg, 'agents/a.md'), 'no fm')
    w(join(cfg, 'agents/.DS_Store'), 'x')
    w(join(cfg, 'commands/c.md'), '---\ndescription: cmd\n---')
    symlinkSync(join(sh, 'skills/s1'), join(cfg, 'skills/linked')) // per-entry link into shared: skipped
    const cat = buildCatalog(home, [acct(cfg)])
    expect(cat[0]).toMatchObject({ accountId: null, skills: [{ name: 'shared-skill', description: 'S' }], agents: [{ name: 'ag', description: 'shared agent' }], commands: [] })
    expect(cat[1]!.skills).toEqual([{ name: 'own', description: 'mine' }])
    expect(cat[1]!.agents).toEqual([{ name: 'a', description: '' }])
    expect(cat[1]!.commands).toEqual([{ name: 'c', description: 'cmd' }])
  })
  it('an account dir that is itself a link to shared lists nothing; missing dirs are empty', () => {
    const home = tmp()
    const cfg = tmp()
    w(join(sharedDir(home), 'skills/s1/SKILL.md'), 'x')
    symlinkSync(join(sharedDir(home), 'skills'), join(cfg, 'skills'))
    const cat = buildCatalog(home, [acct(cfg)])
    expect(cat[1]!.skills).toEqual([])
    expect(listEntries(join(cfg, 'nope'), 'agents')).toEqual([])
  })
})

describe('mcp', () => {
  const SECRET = 'SECRET-TOKEN-123'
  it('extracts only safe fields and never leaks env, headers, args or url secrets', () => {
    const raw = {
      fs: { command: '/usr/bin/npx', args: ['-y', `--token=${SECRET}`], env: { API_KEY: SECRET } },
      web: { type: 'http', url: `https://user:${SECRET}@api.example.com:8443/mcp?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
      ev: { type: 'sse', url: 'https://sse.example.com/s' },
      odd: { command: `/opt/bin/run ${SECRET}` },
      bad: 'str'
    }
    const out = extractServers(raw, 'user')
    expect(out).toEqual([
      { name: 'fs', scope: 'user', transport: 'stdio', target: 'npx' },
      { name: 'web', scope: 'user', transport: 'http', target: 'https://api.example.com:8443' },
      { name: 'ev', scope: 'user', transport: 'sse', target: 'https://sse.example.com' },
      { name: 'odd', scope: 'user', transport: 'stdio', target: 'run' },
      { name: 'bad', scope: 'user', transport: 'unknown', target: '' }
    ])
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(extractServers([], 'user')).toEqual([])
    expect(extractServers({ x: { url: 'not a url' } }, 'user')[0]!.target).toBe('')
  })
  it('reads user + local scopes from .claude.json and project .mcp.json; tolerates missing/invalid files', () => {
    const cfg = tmp()
    const proj = tmp()
    const other = tmp()
    w(join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { token: SECRET }, mcpServers: { u: { command: 'a' } }, projects: { [proj]: { mcpServers: { l: { url: 'http://h:1/x', env: { K: SECRET } } } } } }))
    w(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { p: { command: '/x/y', env: { K: SECRET } } } }))
    w(join(other, '.mcp.json'), '{not json')
    const broken = tmp()
    w(join(broken, '.claude.json'), 'nope')
    const r = mcpReport([acct(cfg), acct(broken, 'b'), acct(tmp(), 'c'), { ...acct(cfg, 'x'), provider: 'codex' }], [proj, other])
    expect(r.accounts.map((a) => a.accountId)).toEqual(['a1', 'b', 'c'])
    expect(r.accounts[0]!.servers).toEqual([
      { name: 'u', scope: 'user', transport: 'stdio', target: 'a' },
      { name: 'l', scope: 'local', transport: 'http', target: 'http://h:1', project: proj }
    ])
    expect(r.accounts[1]!.servers).toEqual([])
    expect(r.projects).toEqual([
      { cwd: proj, servers: [{ name: 'p', scope: 'project', transport: 'stdio', target: 'y' }] },
      { cwd: other, servers: [] }
    ])
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
})

describe('cli', () => {
  it('parses versions', () => {
    expect(parseVersion('2.1.123 (Claude Code)')).toBe('2.1.123')
    expect(parseVersion('codex-cli 0.5.0-beta.1\n')).toBe('0.5.0-beta.1')
    expect(parseVersion('v22.1.0')).toBe('22.1.0')
    expect(parseVersion('nothing')).toBeUndefined()
  })
  it('detects installed, failing-but-present and missing binaries', async () => {
    expect(await detectCli(process.execPath, {}, 5000, ['--version'])).toMatchObject({ installed: true, version: expect.stringMatching(/^\d+\.\d+\.\d+/) })
    expect(await detectCli(process.execPath, {}, 5000, ['-e', 'process.exit(1)'])).toEqual({ installed: true })
    expect(await detectCli('relay-no-such-bin-xyz', { PATH: '/nonexistent' })).toEqual({ installed: false })
  })
})

describe('install command', () => {
  it('is chosen from the provider constant only', () => {
    const c = installCommand('claude')!
    expect(c.bin).toBe('/bin/bash')
    expect(c.args).toEqual(['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'])
    expect(c.display).toBe(`/bin/bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'`)
    expect(checkInstall('claude')).toEqual(c)
    for (const bad of ['codex', 'rm -rf /', '__proto__', 'toString', undefined, 5, { id: 'claude' }]) {
      expect(installCommand(bad)).toBeUndefined()
      expect(() => checkInstall(bad)).toThrow(/instalador/)
    }
  })
})

describe('plainEnv / open target', () => {
  it('has no credentials or account dir vars and keeps the PATH fix', () => {
    const e = plainEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x', CLAUDE_CONFIG_DIR: '/old', CODEX_HOME: '/h', FOO: '1' })
    expect(e).toMatchObject({ FOO: '1' })
    expect(e.ANTHROPIC_API_KEY ?? e.CLAUDE_CONFIG_DIR ?? e.CODEX_HOME).toBeUndefined()
    expect(e.PATH).toContain('/opt/homebrew/bin')
    expect(buildEnv(acct('/c'), { CLAUDE_CONFIG_DIR: '/old' }).CLAUDE_CONFIG_DIR).toBe('/c')
  })
})

describe('candidate dirs', () => {
  it('finds ~/.claude and ~/.claude-*, skips files, other names and registered dirs', () => {
    const h = tmp()
    for (const d of ['.claude', '.claude-mailo', '.claude-work', '.config']) mkdirSync(join(h, d))
    writeFileSync(join(h, '.claude-file'), 'x')
    expect(candidateDirs(h, [join(h, '.claude-work')])).toEqual([join(h, '.claude'), join(h, '.claude-mailo')])
    expect(candidateDirs(join(h, 'nope'), [])).toEqual([])
  })
})

describe('default install', () => {
  it('buildEnv unsets CLAUDE_CONFIG_DIR only for ~/.claude (also through a symlink)', () => {
    const h = tmp()
    mkdirSync(join(h, '.claude'))
    symlinkSync(join(h, '.claude'), join(h, 'alias'))
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/parent' }
    for (const dir of [join(h, '.claude'), join(h, 'alias')]) {
      expect(isDefaultInstall(dir, h)).toBe(true)
      expect('CLAUDE_CONFIG_DIR' in buildEnv(acct(dir), base, h)).toBe(false)
    }
    expect(isDefaultInstall(join(h, '.claude-x'), h)).toBe(false)
    expect(buildEnv(acct(join(h, '.claude-x')), base, h).CLAUDE_CONFIG_DIR).toBe(join(h, '.claude-x'))
    expect(buildEnv({ ...acct(join(h, '.claude')), provider: 'codex' }, base, h).CODEX_HOME).toBe(join(h, '.claude')) // only claude has the quirk
  })
  it('only probes dirs that already have .claude.json (the default install keeps it in HOME)', () => {
    const h = tmp()
    for (const d of ['.claude', '.claude-a', '.claude-b']) mkdirSync(join(h, d))
    writeFileSync(join(h, '.claude-b/.claude.json'), '{}')
    expect(canProbe(join(h, '.claude'), h)).toBe(false)
    writeFileSync(join(h, '.claude.json'), '{}')
    expect(canProbe(join(h, '.claude'), h)).toBe(true)
    expect(canProbe(join(h, '.claude-a'), h)).toBe(false)
    expect(canProbe(join(h, '.claude-b'), h)).toBe(true)
  })
})
