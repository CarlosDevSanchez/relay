# Relay

Desktop app (macOS primary, Linux second) to run several AI coding CLI accounts on the same work. When one Claude Code account runs out of quota, continue the same conversation on another account.

**ToS caveat:** using multiple accounts to get around usage limits may breach the provider's terms. Relay only spawns the official CLI binaries (`claude`, later `codex`); it never reads, extracts or forwards OAuth tokens and never calls provider APIs.

## How it works
- Each account = its own config dir (`CLAUDE_CONFIG_DIR`, default `~/.relay/accounts/<id>`) with its own login. "login" runs the official `claude auth login` in a terminal tab there. "Import dir" references an existing dir (e.g. `~/.claude-mailo`) by path; nothing is copied.
- Sessions are read from `<configDir>/projects/<cwd with every non-alphanumeric char -> '-'>/<session-id>.jsonl`.
- Click another account chip while a session is open: its JSONL is copied into the target account's project dir (never overwriting different content; an older prefix is extended by appending the tail), the pty is killed and `claude --resume <id>` starts under the target account.
- Handoff order: kill the source `claude` and wait for it to exit (SIGKILL after 3 s; the CLI appends lines on exit), copy only complete lines (plus the sibling `<id>/` dir with subagents and tool-results), then start the target. A diverged target copy is renamed to `<id>.jsonl.relay-bak-<ts>`. Sessions copied to several accounts appear once in the sidebar (newest copy).
- Limit detection: Relay tails the open session's transcript; on a `rate_limit` line it notifies and asks. Switching is always a click on "Continuar en <cuenta>"; "Esperar al reinicio" only schedules a reminder notification. Relay never types into the CLI (after a handoff, write "continúa" yourself). Reset time is parsed from the `resets ...` text; unknown formats fall back to a max-age rule. Copied handoff lines are excluded from the target's usage by byte range.
- `/clear` (new session id): while a pty runs, Relay polls its project dir cheaply (new file names only) for a transcript created after the pty started. It rebinds the tab (limit detection and handoff source) only if that tab is the ONLY live Relay terminal for that account+project, exactly one candidate exists, and the id was never bound to any Relay terminal before. In any other case (two tabs on the same project, several candidates, a hand-started `claude` that shows up as a second candidate) the tab is marked stale: handoff is disabled for it with a message, limit detection stays on the old file, and you reopen the session from the sidebar. A rebind is announced in the tab with the new session's title, and every handoff confirmation names the session. Not detected: an in-CLI `/resume` of an OLD session (its file already existed). Remaining risk: a hand-started `claude` that is the only new file would be taken for a `/clear`.
- Limitations (phase 1): file-history (`/rewind`) stays on the source account; running `/clear` or `/resume` inside the terminal changes the CLI's session id, so Relay's tracked id goes stale for handoff; a new account shows the trust dialog per folder and "Not logged in" until `/login`; project paths whose encoded name exceeds 200 chars are refused (the CLI hashes them).
- Codex (`CODEX_HOME`, `codex resume`) is modelled in `src/main/providers.ts` only. **Unverified**: not installed here; session listing and handoff are Claude-only.

## Run
```
bun install        # postinstall fetches the Electron binary and rebuilds node-pty for it
bun run dev
bun run test       # vitest (fixtures in temp dirs)
bun run coverage   # v8 coverage of the pure src/main modules
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
Several terminals at once (tabs, one pty each, keyed by id); closing a tab kills only that process. Sidebar cards show `claude auth status --json` (email, plan) and, from local transcripts only, the active rate limit and tokens used in the last 5h (approximate: copied sessions count on both accounts). See docs/spikes/F0.md.
