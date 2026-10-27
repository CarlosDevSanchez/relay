# Roadmap

Relay only spawns the official CLIs in a PTY. Accounts are never switched automatically: every switch is an explicit user confirmation.

- **F0 spikes** (done, docs/spikes/F0.md): `claude auth status` shape, login flow, transcript usage / rate_limit lines, no official usage command.
- **F1 base** (done): multiple terminals (tabs), official login (`claude auth login`), rename/remove account, account status cards (plan, limit, local 5h tokens).
- **F2 limit detection** (done): live detection by tailing the session transcript, reset-time parsing, system notification + modal with a confirm-only switch ("Continuar en ...") or "Esperar al reinicio" (reminder notification only), notification prefs store.
- **F3 shared global memory**: `~/.relay/shared` symlinked into each account dir; never credentials, `.claude.json` or history.
- **F4 settings panel**: accounts, notification prefs, skills/MCP read-only. Detect missing official CLI (`claude`, later `codex`) and offer an Install button that, after user confirmation, runs the provider's official installer visibly in the embedded terminal (Claude: `curl -fsSL https://claude.ai/install.sh | bash`). Relay never bundles or redistributes the CLI.
- **F5 Codex**: same-provider support (session listing, resume, handoff between Codex accounts); layout is unverified until installed.
- **Post-MVP**: Claude <-> Codex brief; packaging.
