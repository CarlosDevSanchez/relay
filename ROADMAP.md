# Roadmap

Relay only spawns the official CLIs in a PTY. Accounts are never switched automatically: every switch is an explicit user confirmation.

- **F0 spikes** (done, docs/spikes/F0.md): `claude auth status` shape, login flow, transcript usage / rate_limit lines, no official usage command.
- **F1 base** (done): multiple terminals (tabs), official login (`claude auth login`), rename/remove account, account status cards (plan, limit, local 5h tokens).
- **F2 limit detection** (done): live detection by tailing the session transcript, reset-time parsing, system notification + modal with a confirm-only switch ("Continuar en ...") or "Esperar al reinicio" (reminder notification only), notification prefs store.
- **F3 shared global memory** (done): `~/.relay/shared` (`CLAUDE.md`, `skills/`, `agents/`, `commands/`, `projects/<enc>/memory/`) symlinked into each opted-in Claude account dir; never credentials, `.claude.json`, settings or history. Layout can take an `AGENTS.md` link for Codex in F5 (add it to `TOP` in `src/main/shared.ts`).
- **F4 settings panel** (done): accounts, notification prefs, skills/MCP read-only. Detect missing official CLI (`claude`, later `codex`) and offer an Install button that, after user confirmation, runs the provider's official installer visibly in the embedded terminal (Claude: `curl -fsSL https://claude.ai/install.sh | bash`). Relay never bundles or redistributes the CLI. **UX: onboarding + dashboard** (done): in-app modal instead of `prompt()/confirm()` (unsupported in Electron), onboarding for 0 accounts (CLI check, new login or import of `~/.claude*`, optional project), sidebar with account cards/projects/sessions, explicit "Continuar en otra cuenta" menu, `RELAY_HOME`, Playwright e2e smoke (`bun run e2e`).
- **F4.1 UI: daisyUI + auto-continue** (done): renderer on daisyUI 5 with own themes, settings as modal, guided login panel, toasts, xterm themed from the active theme; after a user-confirmed handoff the target starts with `claude --resume <id> <message>` (pref `handoff`, default on, Codex unsupported -> no message).
- **F5 Codex**: same-provider support (session listing, resume, handoff between Codex accounts); layout is unverified until installed.
- **Post-MVP**: Claude <-> Codex brief; packaging.
