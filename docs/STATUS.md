# Relay · Estado del proyecto y traspaso

Última actualización: 2026-10-27. Documento de traspaso para que cualquier agente o persona pueda continuar el trabajo. Las reglas obligatorias están en [AGENTS.md](../AGENTS.md); el plan por fases, en [ROADMAP.md](../ROADMAP.md).

## 1. Qué es Relay (en una línea)
App de escritorio (Electron + React + daisyUI + xterm + node-pty, con Bun) que ejecuta los **CLIs oficiales** `claude` y `codex` con varias cuentas propias del usuario. Cuando una cuenta se queda sin cuota, Relay pregunta y continúa la misma sesión en otra cuenta, con el mismo contexto. Relay nunca toca credenciales ni llama a APIs.

## 2. Decisiones tomadas por el usuario (no reabrir)
| Tema | Decisión |
|---|---|
| Motor | El CLI oficial en una terminal embebida. Nada de chat sobre stream-json ni del Agent SDK con suscripción (política de Anthropic). |
| Cambio de cuenta | Nunca automático: siempre requiere un clic o confirmación del usuario. Después de confirmar, la sesión **continúa sola** con `claude --resume <id> "<mensaje>"` (preferencia, activada por defecto). |
| Login | Solo con el flujo oficial (`claude auth login` / `codex login`). Relay nunca ve credenciales. |
| Carpetas importadas | Nunca se borran. Solo se modifican con consentimiento explícito (diálogo en main), por ejemplo para la memoria compartida. |
| Instalación del CLI | Si falta, se ofrece el instalador oficial, que se ejecuta visible tras confirmar. Relay no empaqueta ningún CLI. |
| Memoria compartida | `~/.relay/shared` enlazado con symlinks: en las cuentas gestionadas por defecto, en las importadas solo con consentimiento. |
| UI | daisyUI 5 con temas propios. Inspirada en apps de agentes, **sin imitar la marca** de Claude Code ni de OpenAI. |
| Logo | **Cerebro de circuitos** en teal (`#69C4CF`) sobre azul marino (`#1A262C`), con la palabra "RELAY" en `relay-logo.svg` (`assets/brand/`). Sustituye al diseño de tarjetas (`{•}`/`>_`), que queda archivado en `assets/brand/archive/`. El acento de la app pasa de ámbar a teal. Prohibido usar el destello de Claude o la nube de Codex. |
| Consumo | Las cards muestran el % oficial de las ventanas **5h** y **7 días**, y su reinicio, tomados del JSON del status line del CLI (`rate_limits`). |
| Historial | Los proyectos muestran **solo las sesiones creadas o usadas desde Relay**. Las sesiones antiguas se traen con "Abrir sesión existente…". |
| Licencia y repo | MIT, `Copyright (c) 2026 Carlos Sánchez`. Repo público `CarlosDevSanchez/relay`, que se publica **al cerrar el MVP**. `main` protegida con PR y aprobación del dueño, sin push directo; el admin puede saltarla. |
| Ramas | Ramas de feature → `dev` → `main`. Un commit por fase. |
| Vista enriquecida (F6) | Aprobada en concepto, para después del MVP. Diseño en [docs/design/F6-vista-enriquecida.md](design/F6-vista-enriquecida.md). |

## 3. Proceso de trabajo
1. Implementa un agente (Sonnet) con el brief de la fase, aplicando la skill *ponytail*.
2. Audita un agente independiente (Opus), que lee el código y ejecuta las verificaciones: `bun run typecheck`, `bun run test`, `bun run build` y `bun run e2e`.
3. Se corrige hasta que no quede ningún BLOCKER ni MAJOR. Los MINOR que queden se anotan.
4. Un commit por fase en `feat/mvp` con `Co-Authored-By`.
5. Cada fase actualiza AGENTS.md, README, ROADMAP y este archivo.
6. La UI se verifica con el e2e de Playwright, no solo con tests unitarios. (Lección aprendida: `window.prompt()` no existe en Electron y llegó a romper todos los botones.)
7. La prueba manual del usuario se hace desde un worktree fijado a un commit, para que el HMR no la interrumpa mientras los agentes editan.

## 4. Hecho (rama `feat/mvp`, base `main`/`dev` = `0b76f82`)
| Commit | Fase | Contenido |
|---|---|---|
| `5bd0f10` | F0 + F1 | Investigación del CLI (`docs/spikes/F0.md`), pestañas multi-PTY, login oficial, renombrar y quitar cuentas, cards de estado |
| `5ad00dc` | F2 | Detección del límite en vivo, notificaciones, diálogo de cambio solo con confirmación, "esperar al reinicio" |
| `61ba578` | F2 fix | Seguimiento de `/clear` sin ambigüedad (estado *stale*), cwd de la pestaña, cola de avisos, recordatorios |
| `1911b67` | F3 | Memoria compartida con symlinks, backups, consentimiento en main para carpetas importadas, detección de deriva |
| `b0a83f7` | F4 | Configuración, catálogo de skills, MCP redactado, detección e instalación del CLI, onboarding, dashboard, `RELAY_HOME`, e2e |
| `b81f068` | F4 fix | Override del instalador solo en desarrollo; MCP de la instalación por defecto en `~/.claude.json` |
| `14427b9` | docs | LICENSE, AGENTS.md, CLAUDE.md (`@AGENTS.md`), README reescrito |
| `1a87166` | F4.1 | UI daisyUI, Configuración como modal, login guiado, terminal con tema, auto-continuar, foco seguro en los diálogos |
| `25b1e55` | F5 | Codex del mismo proveedor: cuentas, login, sesiones (solo hilos `codex-tui`), handoff, límite, `AGENTS.md` compartido; restos de F4.1 |
| `63fb289` | F5.1 | Barras de consumo oficial (status line), historial solo de Relay, logo conectado |
| `ab08f7a` | F5.2 | Cards compactas y secciones plegables (+ restos de F5.1) |
| `3fa471f` | F5.2 fix | Desbordes del sidebar con datos reales de cuentas |
| `3b3fa80` | F5.2 fix | Badge de proveedor corto, truncado en el área principal, contornos de foco |

Estado al cierre de F5: 100 tests y e2e con 5 escenarios en verde; auditoría PASS.

## 5. En curso
- **MVP cerrado y publicado** en https://github.com/CarlosDevSanchez/relay. El PR #1 (`feat/mvp` → `dev`) está **fusionado** (`6044db6`). El PR #2 (`dev` → `main`) está **abierto**, sin conflictos (`gh pr view 2`: OPEN, CLEAN), a la espera de la aprobación del dueño.
- **F6.0 · Investigación de la vista enriquecida (rama `feat/f6`)**: hecha (commit `1fd7eff`). Informe en [docs/spikes/F6.md](spikes/F6.md) (462 transcripts reales de Claude, 24 versiones del CLI; fixtures sintéticos en `tests/fixtures/transcript/`) y plan actualizado en [docs/design/F6-vista-enriquecida.md](design/F6-vista-enriquecida.md). Hallazgos: el CLI escribe una línea por bloque; no hay señal fiable de aprobaciones pendientes (se descartan los botones Aprobar/Rechazar); `quotaLimits` solo aparece al rechazar; `TodoWrite` sin datos reales; Codex sin rollouts reales en esta máquina. Decisiones del usuario: identidad visual lo más similar posible a la app de Claude Code sin replicarla ni usar sus marcas, modo por defecto Conversación, markdown/resaltado a elegir en F6.1. Siguiente: F6.1 (parser y modelo).
- **F6.0b · Pantallas y teclas reales de la TUI (rama `feat/f6`)**: investigación hecha, sin commitear. [docs/spikes/F6b.md](spikes/F6b.md) (claude 2.1.312 real, ~18 turnos de Haiku) y 41 fixtures anonimizados (con README) en `tests/fixtures/screens/`; diseño chat-first en [docs/design/F6-vista-enriquecida.md](design/F6-vista-enriquecida.md). Hallazgos: bracketed paste soportado (multilínea intacta, `\r` envía, se encola si trabaja); reposo/trabajo por `esc to interrupt` o spinner `<glifo> <Palabra>…`; en los permisos el dígito selecciona y confirma al instante (opciones variables, se parsean de la pantalla); en multi-select alterna casillas y "Type something" / "Tell Claude what to change" solo mueven el foco; `/model <nombre>` y la tecla de dígito del selector guardan el modelo predeterminado de la cuenta; `/` y `@` abren listas de la TUI (Relay hará la suya y no las escribirá). Sin verificar: modal de límite de cuota, errores, aprobar el plan con 1/2. La regla 3 de AGENTS.md debe enmendarse en F6.3/F6.4 (no se ha tocado).
- **F6.1 · Parser y modelo de eventos (rama `feat/f6`)**: implementado y corregido tras la auditoría (refcount por cuenta+sesión, páginas acotadas a 1 MB; una reescritura del archivo reinicia el flujo); commit `9a15070`. `src/main/transcript/` (parser con lista blanca, paginación desde el final, cola en vivo con `tailFile(…, from)`), IPC `session:subscribe/unsubscribe/older/subagent` + `session:events` con `seq`, `src/shared/transcript.ts` (`applyBatch`). Archivo de 69 MB: primera página ~1,3 ms, peor página (mejor de 3) <2 ms, sin worker. Sin UI (F6.2).
- **F6.2 · Vista de conversación (rama `feat/f6`)**: implementada; commit `80c31a5`. `Conversation.tsx` + `md.tsx` (marked 18.1.2 solo el lexer, highlight.js 11.12.0 core con 9 lenguajes; todo se pinta como elementos React, nunca HTML), `createFeed` (estado por pestaña, búfer hasta el snapshot, descarta `older` obsoletos), reset por reescritura con snapshot acotado, tarjetas por herramienta, diffs, subagentes perezosos, avisos, `content-visibility: auto` + paginación en lugar de una librería de virtualización (decisión deliberada, ver el diseño §6), layout Terminal/Dividida (Claude abre en Dividida; Codex solo terminal). e2e con `claude` falso que escribe un transcript guionizado (escenario 9, capturas `chat-light/dark.png`).
- **F6.3 · Chat-first core (rama `feat/f6`)**: implementada, sin commitear. Clasificador puro `src/shared/screen.ts` (41/41 fixtures contra el oráculo del README, también devuelve pregunta, opciones y huella del diálogo), `src/main/bridge.ts` + IPC `pty:send/stop/clear` (bytes construidos en main, test con entrada hostil), `Chat.tsx` (composer en pastilla, línea de actividad, fila de info de solo lectura), terminal viva oculta con `visibility` (no `display:none`), interruptor Chat/Terminal, respaldo (diálogo = aviso + abrir terminal; `unknown` >1,5 s = terminal automática + toast). Regla 3 de AGENTS.md enmendada. e2e con una TUI falsa (`e2e/fake-claude-tui.mjs`). Tras la auditoría: solo se envía desde `idle`, guarda de frame obsoleto (flush de xterm + `seq` verificado en main), IPC solo para ptys Claude con sesión, cualquier `dialog:*` abre la terminal a los 1,5 s (hasta F6.4), bloqueo sin bracketed paste. **Para verificar con el CLI real en F6.4**: vaciar con `^U` una caja multilínea, `Esc` sobre una lista `/` mientras trabaja (por eso el vaciado se rechaza si el pie dice `esc to interrupt`), y que `\r` tras un pegado largo (`[Pasted text…]`) envía. Límite conocido: una lista numerada tecleada en la caja del CLI se clasifica `dialog:unknown` (lado seguro: bloquea y abre la terminal sola a los 1,5 s; aceptado por ahora).
- **F5.2 · Cards compactas y secciones plegables**: hecho y auditado (PASS). MINOR abierto: la línea corta del status line puede tomar un % ajeno si el CLI cambia el orden de las claves (solo afecta al texto del CLI, no a las cards).
  - Card compacta por defecto (punto de estado, nombre, badges de plan y proveedor, dos barras finas 5h/7d con el % y el reinicio en tooltip); clic o chevron la expande (email, filas "Sesión 5h"/"Semana", tokens, notas de memoria compartida). Cuenta limitada o sobre el umbral: punto y barra en warning/error aunque esté compacta.
  - "Cuentas" y "Proyectos" se pliegan (plegado de cuentas = un punto por cuenta con tooltip). Estado en `localStorage` (preferencia de UI, con try/catch). El e2e comprueba que ningún elemento del sidebar se sale de su caja (compacto, expandido, plegado y ventana mínima de 900 px).
  - Restos de la auditoría F5.1: escrituras al registro best-effort, listado filtrado por el registro y títulos en caché (tamaño+mtime), `auth status` solo cuando cambia el estado 100%, el status line del usuario conserva `refreshInterval`/`padding` (se ejecuta con `/bin/sh`), un umbral cruzado con Relay cerrado no se avisa (a propósito), `chmod 0700` del dir de estado, ruta del icono empaquetado, `preview.png` a 1200 px, colores de marca teal `#69C4CF` / navy `#1A262C`.
  - Seguimiento (commit `3b3fa80`): badge de proveedor corto "CC"/"CX" siempre visible (nombre completo en el tooltip); los badges de cuenta en las pestañas y en la franja de la sesión se truncan con elipsis conservando el inicio; las sesiones recientes apilan el título sobre los metadatos; contorno de foco en los kebabs y los puntos; el e2e `mainFits` también comprueba con una pestaña abierta.
  - NITs abiertos: el select "Cuenta" del estado vacío mete las etiquetas largas bajo su flecha; `min-w-0` en el li/button de la lista de recientes puede no hacer nada.
  - Para la fase de empaquetado: el icono de la ventana empaquetada se busca en `process.resourcesPath/icon.png` (hay que copiarlo allí con `extraResources`); en desarrollo, `<proyecto>/build/icon.png`.

## 6. Pendiente para cerrar el MVP
1. F5.1 (`63fb289`) y F5.2 (`ab08f7a`, `3fa471f`, `3b3fa80`) ya están en commit; el repo está publicado y el PR #1 fusionado.
2. **Aprobación y merge del PR #2** (`dev` → `main`) por el dueño (rama protegida: PR más aprobación del dueño; admin puede saltarla, `enforce_admins` desactivado).
3. **Prueba manual del usuario** desde un worktree fijado al último commit. Puntos clave que solo se pueden comprobar con cuentas reales:
   - Claude: que `claude --resume <id> "<msg>"` continúe solo; que la memoria compartida funcione por symlink (`/memory`, `/skills`, auto-memory en `~/.relay/shared`); que el login guiado y el campo del código funcionen; que las barras de consumo aparezcan.
   - Codex: login interactivo, `codex login status` con sesión iniciada, texto real del 429 y del reinicio, `token_count.rate_limits` real.
   - Tema oscuro, y avisos por encima de los diálogos.
4. Reproducir la CI en local si se añade (por ahora el repo no tiene workflows).

## 7. Después del MVP
- **F6 · Vista enriquecida** (lectura del transcript, chat dinámico, terminal viva a un clic; el chat es la interfaz principal): [plan](design/F6-vista-enriquecida.md), etapas F6.0–F6.7.
- Handoff Claude ↔ Codex mediante un brief (transcript más git diff).
- Empaquetado: `.dmg`, firma y notarización (requiere Apple Developer).
- Opción C: chat propio solo para cuentas con API key de Console (permitido).

## 8. Riesgos y cosas no verificadas
- El formato del transcript y de los rollouts es interno y puede cambiar. Los parsers son tolerantes y la terminal siempre queda como respaldo.
- Codex: el formato del 429 y de los rollouts de sub-agentes viene de los *strings* del binario y de un backend falso, no de una cuenta real.
- El CLI no tiene un comando oficial para fijar el tema: las cuentas nuevas muestran el selector de tema del CLI la primera vez.
- Política: varias suscripciones de la misma persona para ampliar el uso podrían chocar con "uso ordinario e individual" (aviso en el README).
- `~/.claude/.claude.json` (423 B) lo creó la investigación de F0. Es inofensivo y puede borrarse con permiso del usuario.

## 9. Entorno y comandos
- Requisitos: macOS, Bun, Node ≥ 22.12 y Xcode CLT (para node-pty). `claude` 2.1.312 en `~/.local/bin`; `codex` 0.164.0 en `/opt/homebrew/bin` (instalado con `brew install --cask codex`).
- `bun install` · `bun run dev` · `bun run typecheck` · `bun run test` · `bun run coverage` · `bun run build` · `bun run e2e` (stubs de `claude` y `codex`, HOME temporal; nunca toca datos reales).
- Iconos: `node_modules/.bin/electron scripts/build-icons.mjs`.
- Datos de la app: `~/.relay/` (`accounts.json`, `projects.json`, `prefs.json`, `copies.json`, `sessions.json`, `shared/`, `backups/`, `accounts/<id>/`, `status/`, `bin/`). Se puede cambiar con `RELAY_HOME`.
- Worktree de prueba manual: `../relay-manual-test` (fijado a `ef7cb95`, que **precede a la reescritura del historial**; el usuario lo eliminará, pendiente). Debe retirarse siguiendo la regla de limpieza de worktrees.
