# Relay

Desktop app (macOS primary, Linux second) to run several AI coding CLI accounts on the same work. When one Claude Code account runs out of quota, continue the same conversation on another account.

**ToS caveat:** using multiple accounts to get around usage limits may breach the provider's terms. Relay only spawns the official CLI binaries (`claude`, later `codex`); it never reads, extracts or forwards OAuth tokens and never calls provider APIs.

## How it works
- Each account = its own config dir (`CLAUDE_CONFIG_DIR`, default `~/.relay/accounts/<id>`) with its own login. "login" opens a terminal running `claude` there; run `/login`. "Import dir" references an existing dir (e.g. `~/.claude-mailo`) by path; nothing is copied.
- Sessions are read from `<configDir>/projects/<cwd with every non-alphanumeric char -> '-'>/<session-id>.jsonl`.
- Click another account chip while a session is open: its JSONL is copied into the target account's project dir (never overwriting different content; an older prefix is extended by appending the tail), the pty is killed and `claude --resume <id>` starts under the target account.
- Codex (`CODEX_HOME`, `codex resume`) is modelled in `src/main/providers.ts` only. **Unverified**: not installed here; session listing and handoff are Claude-only.

## Run
```
bun install        # postinstall fetches the Electron binary and rebuilds node-pty for it
bun run dev
bun run test       # vitest (fixtures in temp dirs)
bun run typecheck
bun run build
```
Bun is used: `trustedDependencies` + a `postinstall` (`node node_modules/electron/install.js && electron-rebuild -f -w node-pty`) were needed because Bun did not run Electron's own download script. Needs Node >= 22.12.

## Architecture
```
src/main/      pure logic (paths, store, env, sessions, handoff, providers), no Electron imports
               pty.ts (node-pty), index.ts (Electron window + typed IPC)
src/preload/   contextBridge exposing RelayApi (src/shared/types.ts)
src/renderer/  React + Tailwind + xterm (contextIsolation, sandbox, no nodeIntegration)
tests/         vitest
```
One terminal at a time; starting another kills the previous process.
