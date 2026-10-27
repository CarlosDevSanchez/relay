# Roadmap

Relay only spawns the official CLIs in a PTY. Accounts are never switched automatically: every switch is an explicit user confirmation.

- **F0 spikes** (done, docs/spikes/F0.md): `claude auth status` shape, login flow, transcript usage / rate_limit lines, no official usage command.
- **F1 base**: multiple terminals (tabs), official login (`claude auth login`), rename/remove account, account status cards (plan, limit, local 5h tokens).
- **F2 limit detection**: detect the quota hit, notify, offer a confirm-only switch to another account (plus a "wait for reset" option).
  F1 audit follow-ups: parse the reset time/timezone so "limited" clears at the real reset; track copied lines by byte offset or uuid instead of a `copiedAt` timestamp (ping-pong hides the target's own earlier usage/limit) and skip recording when nothing was appended; handoff check must match the pty's session id, not just the account; evict usage cache entries not seen in a scan; anchor the session-id regex; dedupe keeps the max usage per message; realpath the import-under-accounts check.
- **F3 shared global memory**: `~/.relay/shared` symlinked into each account dir; never credentials, `.claude.json` or history.
- **F4 settings panel**: accounts, notification prefs, skills/MCP read-only. Detect missing official CLI (`claude`, later `codex`) and offer an Install button that, after user confirmation, runs the provider's official installer visibly in the embedded terminal (Claude: `curl -fsSL https://claude.ai/install.sh | bash`). Relay never bundles or redistributes the CLI.
- **F5 Codex**: same-provider support (session listing, resume, handoff between Codex accounts); layout is unverified until installed.
- **Post-MVP**: Claude <-> Codex brief; packaging.
