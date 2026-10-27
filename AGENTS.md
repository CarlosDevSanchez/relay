# AGENTS.md

Canonical guide for any coding agent (Claude, Codex, ...) and human contributors. Keep it current: every phase updates AGENTS.md, README.md and ROADMAP.md (and CLAUDE.md if needed).

## What Relay is
Electron + React + Tailwind + xterm + node-pty desktop app (macOS primary, Linux second, bun). It runs the OFFICIAL `claude` CLI in a PTY per account so a developer can continue the same session on another of their own accounts when one runs out of quota (handoff of the session transcript). Codex support is planned (F5).

## Non-negotiable rules
1. Only spawn the official CLIs, in a PTY. No chat UI on stream-json / Agent SDK.
2. Never read, extract, forward or log credentials, tokens or secrets. Never call undocumented endpoints or provider APIs.
3. Never switch accounts automatically. Every switch is an explicit user click/confirm. Relay never sends input on its own initiative except the auto-continue prompt (pref `handoff.autoContinue`, default on) as argv after a user-confirmed handoff (`claude --resume <id> <message>`, message a separate argv element, no shell; `providers.*.resumeArgs`; message validated by `checkContinueMessage`: 1-500 chars, no control chars, no leading `-`, not a single ASCII word). User keystrokes and the user-pasted login code are forwarded to the pty. Dialogs that can appear on their own (limit modal) focus the safe button (`data-autofocus`), never a switch.
4. Imported dirs are never deleted and are only modified through the explicit consent flows (shared-memory link, with a dialog naming the dir).
5. Never bundle or redistribute the CLI. Install only through the official installer, after a main-side confirmation showing the exact command; Relay downloads nothing itself.
6. The MCP view never exposes env, headers, args, tokens or URL userinfo/path/query (redaction happens in main, `src/main/mcp.ts`; tested with planted secrets).
7. Never lose user data: back up before replacing, move atomically, never overwrite differing content.
8. No `window.prompt/confirm/alert` (Electron does not implement them): use the in-app modal (renderer) or main-side `dialog.showMessageBox`.
9. The renderer only sends ids/intent; commands, paths and env are built in main (`validate.ts` checks every IPC input).

## Architecture
- `src/main/` (pure logic, no Electron imports unless noted): `paths` (cwd encoding, default-install detection, candidate dirs), `store` (accounts/projects/copies JSON), `env` (CLAUDE_CONFIG_DIR / plain env, PATH fix), `providers` (claude/codex definitions, official install command), `sessions` (transcript listing), `handoff` (copy a session to another account, terminate source), `limit` (tail transcript, detect `rate_limit`, parse reset), `usage` (auth status + local 5h tokens), `shared` (global memory symlinks), `catalog` (skills/agents/commands listing), `mcp` (redacted MCP report), `cli` (version detection), `prefs` (notification + handoff prefs, `checkContinueMessage`), `validate` (IPC input checks), `pty` (node-pty, Electron-free), `index.ts` (Electron window + typed IPC; only place using `app`/`dialog`).
- `src/preload/index.ts`: contextBridge exposing `RelayApi`.
- `src/shared/types.ts`: types shared by main, preload and renderer.
- `src/renderer/`: `App` (state, tabs, modals), `Onboarding`, `Login` (login panel), `Sidebar` (account cards, projects, sessions), `Settings` (large modal), `Terminal` (xterm, theme derived from the daisyUI theme), `ui` (Dialog with `data-autofocus`, modal helpers, Dropdown, toasts as a top-layer popover; errors and backup-path toasts stay until dismissed), `status`. UI stack: Tailwind 4 + daisyUI 5 (`@plugin "daisyui"` with our own `relay-light`/`relay-dark` themes in `styles.css`; no custom .btn/.card CSS, use daisyUI components and theme colors). All dialogs are native `<dialog>` via `ui.Dialog`; CSP allows `data:` images (daisyUI icons). xterm 6 draws on a canvas, so e2e cannot assert terminal text from the DOM. contextIsolation + sandbox, no nodeIntegration.
- `tests/` vitest (fixtures in temp dirs); `e2e/smoke.mjs` Playwright-Electron smoke.

## Data locations
`~/.relay` (override with `RELAY_HOME`): `accounts.json`, `projects.json`, `prefs.json` (`notifications: {system, sound}`, `handoff: {autoContinue, message}`), `copies.json` (handoff copy records), `shared/` (global memory: `CLAUDE.md`, `skills/`, `agents/`, `commands/`, `projects/<encoded cwd>/memory/`), `backups/<account>/<timestamp>/` (content replaced by linking), `accounts/<id>/` (managed account config dirs).

Accounts map to `CLAUDE_CONFIG_DIR=<account configDir>`. Exception: a dir resolving to `~/.claude` is the default install (`defaultInstall`): plain `claude` keeps config in `~/.claude.json` with its own keychain entry, so Relay runs it WITHOUT `CLAUDE_CONFIG_DIR` (data paths still use `~/.claude`; MCP config is read from `~/.claude.json`).

Transcripts: `<configDir>/projects/<cwd with every non-alphanumeric char -> '-'>/<session-id>.jsonl` (+ sibling `<id>/` dir). Rate-limit line: `{"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,"message":{"model":"<synthetic>","content":[{"text":"You've hit your session limit · resets 1:10am (America/Bogota)"}]}}`. Details: docs/spikes/F0.md.

## Commands
```
bun install          # postinstall fetches Electron and rebuilds node-pty
bun run dev          # electron-vite dev
bun run typecheck
bun run test         # vitest
bun run coverage     # v8 coverage of pure src/main modules
bun run build
bun run e2e          # builds, then drives the app with Playwright against a stub `claude` in a temp RELAY_HOME/HOME; never touches real data
```

## Workflow
- Work on feature branches merged into `dev`; `main` is protected (PR + owner approval).
- Each phase: implement -> independent audit -> fix, repeat until no BLOCKER/MAJOR. One commit per phase.
- Bug fix = failing regression test first; new code = tests. Never lower coverage thresholds.
- Verify GUI changes with the e2e smoke, not only unit tests (the `window.prompt` bug shipped because unit tests could not see it).
- Before pushing, reproduce CI locally.

## Status
F0-F4 and F4.1 (daisyUI UI + auto-continue) done (spikes, tabs/login/status, limit detection, shared memory, settings/onboarding/installer). Next: F5 Codex, then post-MVP (Claude <-> Codex brief, packaging). See ROADMAP.md and docs/spikes/F0.md.

Known limitations (details in README): `/rewind` file-history stays on the source account; in-CLI `/clear` / `/resume` can make the tracked session id stale; shared-memory symlink behaviour of the CLI is unverified by hand; Codex layout unverified; project paths whose encoded name exceeds 200 chars are refused.
