# F6 · Vista enriquecida (diseño y plan)

Estado: **propuesta aprobada en concepto (2026-10-27), sin implementar.** Se ejecuta después del MVP (F0–F5).

## 1. Qué es y qué no es

Relay sigue ejecutando el **binario oficial de `claude` sin modificar**, en una terminal real (PTY), con el login del propio usuario. La vista enriquecida es una **capa de lectura**: convierte el transcript `.jsonl` que el CLI ya escribe en disco en una interfaz de chat limpia y dinámica (mensajes, herramientas, diffs, tareas, progreso).

- No usa el Agent SDK ni `--output-format stream-json`.
- No hace peticiones a Anthropic ni consume cuota por sí misma.
- No lee, guarda ni intermedia credenciales.
- No oculta el CLI: la terminal oficial siempre está presente (como panel o dock) y es la experiencia de uso real.

Objetivo de producto: quien no se siente cómodo con la TUI tiene una forma menos intrusiva de **seguir y revisar** lo que hace el agente, con la misma calidad de experiencia que una app de escritorio.

## 2. Marco de política (no negociable)

Fuente: [Claude Code · Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) y [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

| Permitido | No permitido sin aprobación de Anthropic |
|---|---|
| El usuario inicia sesión en el binario **sin modificar** con su propia suscripción | Ofrecer el login de claude.ai / los límites de suscripción para impulsar un producto propio (incl. Agent SDK = binario vía stream-json) |
| Leer archivos locales del usuario (transcripts) | Recolectar, guardar o intermediar credenciales o tokens de sesión |
| Decir en texto plano que Relay "ejecuta Claude Code" | Usar nombres/logos de Claude Code o Anthropic como marca propia, o **elementos visuales que imiten Claude Code** |

Reglas de diseño derivadas:

1. **Identidad propia.** La UI se inspira en *patrones* de una app de agente de código (chat, tarjetas de herramienta, panel de tareas, diffs, barra de estado) pero con nombre, logo, paleta, tipografía e iconografía propias de Relay. No se replica pixel a pixel la app de Claude Code ni su arte ASCII.
2. **La terminal oficial nunca desaparece.** Modos *Conversación* (dock compacto de terminal visible abajo), *Dividida* y *Terminal*. No existe un modo "sin terminal".
3. **Entrada siempre del usuario.** Ningún texto llega al CLI sin una acción explícita del usuario (tecla o clic). Las sugerencias **rellenan** el prompt de la terminal; el envío lo hace el usuario. Excepción ya aprobada: el mensaje de auto-continuar como argv tras un cambio de cuenta confirmado.
4. **Sin IA propia.** Sugerencias y resúmenes se generan con reglas locales sobre el transcript; Relay no llama a ningún modelo.
5. **Campos sensibles fuera.** El parser ignora y nunca envía al renderer adjuntos de credenciales/organización (p. ej. `attachment.type === "credential_org"`), cabeceras, ni contenido de `api-request*`.

> Antes de publicar el *Composer* (§5.4) se recomienda confirmar con Anthropic que un campo de entrada propio que reenvía las teclas del usuario a la TUI visible es aceptable. Hasta entonces va detrás de una opción, desactivada por defecto.

## 3. Fuente de datos: el transcript

Ubicación: `<configDir>/projects/<cwd codificado>/<sessionId>.jsonl` (subagentes en `<sessionId>/…`). Formato **interno y no documentado**: puede cambiar entre versiones del CLI.

Inventario observado (claude 2.1.311, una sesión real; solo nombres de campos y valores enumerados):

| Línea / campo | Uso en la vista |
|---|---|
| `user` / `assistant` con `message.content[]`: `text`, `thinking`, `tool_use`, `tool_result` | Burbujas, "pensando" plegable, tarjetas de herramienta con su resultado |
| `toolUseResult` (`stdout`, `stderr`, `interrupted`, `structuredPatch`, `filePath`, `originalFile`, `status`, `agentId`…) | Salida de comandos, **diffs**, estado de subagentes |
| `isSidechain`, `parentUuid`, `uuid` | Árbol de subagentes y orden causal |
| `aiTitle` / línea `ai-title`, `cwd`, `gitBranch`, `timestamp`, `version` | Título, contexto y línea de tiempo |
| `message.usage`, `requestId`, `message.id` | Tokens por respuesta (deduplicados por id, como ya hace `usage.ts`) |
| `system` subtipos `turn_duration`, `local_command`, `informational` | Duración de turno, comandos locales, avisos |
| `permission-mode` (`auto`, …) y `permissionDecision` (objeto) | Modo de permisos en la barra de estado; decisión de cada herramienta |
| `quotaLimits` (`status`, `resetsAt`, `rateLimitType`…) | Estado de cuota. Observado solo en el error de límite (`status:"rejected"`, `rateLimitType:"five_hour"`); **pendiente verificar** si aparece antes del límite para avisos preventivos |
| `attachment` (`edited_text_file`, `queued_command`, `skill_listing`, …) | Archivos editados, mensajes en cola; el resto se ignora |
| `isApiErrorMessage` + `error:"rate_limit"` | Ya usado por F2 para detectar el límite |
| Copias registradas en `copies.json` (F2) | Marcas "↪ continuó en la cuenta B" |

Codex: los rollouts (`sessions/YYYY/MM/DD/rollout-*.jsonl`, eventos `session_meta`, `item_completed`, `task_complete`…) alimentan la misma vista mediante un adaptador (F6.6).

## 4. Arquitectura

```
CLI oficial ──escribe──▶ transcript.jsonl
                              │ tail incremental (ya existe en limit.ts)
                              ▼
main: parser tolerante (por versión) ──▶ modelo normalizado (eventos)
                              │ IPC por lotes (session:events)
                              ▼
renderer: store por sesión ──▶ ConversationView / StatusBar / TaskPanel / TerminalDock
```

- **Parser** (`src/main/transcript/`): puro y testeable. Convierte líneas a eventos normalizados: `Turn`, `Message{role,text,thinking}`, `ToolCall{id,name,input,result,status,durationMs}`, `Diff{file,hunks}`, `Todo[]`, `Subagent{id,parent,calls}`, `Notice`, `Quota`, `Handoff`. Ignora lo desconocido y registra la versión del CLI; si un tipo crítico no se entiende, la vista muestra "formato no reconocido, usa la terminal" sin romper nada.
- **Lectura**: reutiliza el `tailFile` de F2 (offsets, UTF-8 partido, truncado). La carga inicial de sesiones largas va paginada desde el final; se hace en un `worker_thread` si supera un umbral.
- **IPC**: eventos en lotes con un número de secuencia; el renderer reconstruye el estado de forma idempotente.
- **Renderer**: lista virtualizada; markdown y resaltado de código con dependencias pequeñas y fijadas (elección final en F6.1, con criterio *ponytail*).

## 5. Experiencia (pantallas y componentes)

### 5.1 Layout y modos
- **Conversación**: chat a pantalla completa + **dock de terminal** abajo (2–6 líneas en vivo, spinner de actividad, botón para expandir). El dock es la "terminal interna" visible: muestra el progreso real del CLI.
- **Dividida**: chat a la izquierda, terminal completa a la derecha (por defecto).
- **Terminal**: solo la TUI (comportamiento actual).
- Selector de modo en la barra de la sesión; se recuerda por usuario.

### 5.2 Línea de tiempo del chat
- Mensajes del usuario y del agente con markdown, código resaltado y botón copiar.
- "Pensando…" plegable con duración.
- **Tarjetas por herramienta**:
  - `Bash`: comando, salida plegable (stdout/stderr), código de salida, duración, interrumpido.
  - `Read`/`Grep`/`Glob`: archivo o patrón, número de resultados, abrir en el editor.
  - `Edit`/`Write`: **diff** coloreado por archivo, +/−, abrir el archivo.
  - `WebFetch`/`WebSearch`: dominio/consulta y resumen.
  - `Agent`: subagente como hilo anidado con sus propias herramientas.
  - `TodoWrite`: actualiza el panel de tareas.
  - Desconocidas: tarjeta genérica con nombre y JSON plegado.
- Auto-scroll que sigue el final, con botón "Ir al último" si el usuario sube.
- Animaciones sutiles al aparecer cada bloque (respetando reduced-motion).
- Marcas de sistema: duración de turno, compactación, cambio de cuenta, límite alcanzado.

### 5.3 Paneles y barra de estado
- **Barra de estado**: cuenta, modelo, modo de permisos, rama git, tokens del turno y de la sesión, cuota (cuando se conozca) y estado "trabajando / esperando tu respuesta en la terminal".
- **Panel lateral derecho (plegable)**: Tareas (de `TodoWrite`), Archivos tocados (de diffs y `edited_text_file`) y Subagentes.
- **Aviso de atención**: cuando el CLI espera una aprobación o una respuesta, banner "Claude espera tu respuesta en la terminal" y foco al dock. *Cómo detectarlo: pendiente de la investigación en F6.0.*

### 5.4 Interacción (dentro de las reglas del §2)
- **Botones solo de Relay** (sin tocar el CLI): copiar, abrir diff o archivo, filtrar, buscar, plegar o desplegar, saltar a un turno.
- **Sugerencias** (chips sobre el dock): se generan con reglas locales, por ejemplo tareas pendientes del `TodoWrite`, "repetir el último comando que falló", prompts recientes y comandos oficiales (`/compact`, `/model`, `/clear`). Al hacer clic **rellenan** el prompt de la terminal visible y le dan el foco; el usuario pulsa Enter.
- **Composer (opcional, desactivado por defecto)**: un campo de texto con mejor edición (multilínea, adjuntar ruta, historial) que **reenvía las teclas del usuario** a la TUI visible cuando el usuario envía. Requiere la confirmación del aviso del §2 antes de activarse por defecto.
- **Aprobaciones**: los botones Aprobar/Rechazar enviarían la tecla correspondiente a la TUI tras un clic del usuario. Solo se implementan si F6.0 encuentra una forma fiable de saber qué está preguntando el CLI; si no, el banner remite a la terminal.

## 6. Plan de implementación

Cada etapa sigue el flujo del proyecto: Sonnet implementa → Opus audita → correcciones hasta que no quede BLOCKER/MAJOR → un commit por etapa → actualizar AGENTS.md, README y ROADMAP.

| Etapa | Alcance | Criterios de aceptación | Tamaño |
|---|---|---|---|
| **F6.0 Investigación** | Catálogo de tipos de línea en varias sesiones y versiones del CLI; valores de `quotaLimits` antes y en el límite; granularidad de escritura (por bloque o por turno); rastro de aprobaciones pendientes (transcript o buffer de xterm); estructura de subagentes, compactación e imágenes; equivalentes en rollouts de Codex. Se documenta en `docs/spikes/F6.md` con fixtures anonimizados. | Cada campo del §3 marcado como verificado o no verificado; fixtures listos para los tests | S |
| **F6.1 Parser y modelo** | `src/main/transcript/` (parser tolerante y versionado), lectura incremental con paginación desde el final, IPC `session:events`, filtrado de campos sensibles. | Tests con fixtures reales anonimizados, incluido un formato desconocido que no rompe nada; sesión de 50 MB cargada sin bloquear la UI | M |
| **F6.2 Vista de conversación** | Línea de tiempo virtualizada, markdown y código, tarjetas por herramienta, diffs, "pensando", subagentes anidados, auto-scroll. | e2e con un `claude` falso que va escribiendo un transcript guionizado; capturas en tema claro y oscuro | M–L |
| **F6.3 Layout y dock** | Modos Conversación, Dividida y Terminal; dock de terminal en vivo; barra de estado; panel de Tareas, Archivos y Subagentes. | La terminal siempre visible en cualquier modo (el e2e lo comprueba); el modo se recuerda | M |
| **F6.4 Interacción** | Botones solo de Relay, chips de sugerencias que rellenan sin enviar, aviso de atención; composer detrás de una opción desactivada. | El e2e demuestra que nada se envía sin una tecla o clic del usuario; las sugerencias no incluyen `\r` | M |
| **F6.5 Pulido** | Animaciones, estados vacíos, atajos de teclado, accesibilidad, rendimiento (virtualización y memoria), revisión visual de identidad propia. | Auditoría visual: sin elementos que imiten la marca de Claude Code | S–M |
| **F6.6 Codex** | Adaptador de rollouts al mismo modelo de eventos. | Las mismas vistas funcionan con una sesión de Codex | M |

Orden recomendado: F6.0 → F6.1 → F6.2 → F6.3 (ya utilizable) → F6.4 → F6.5 → F6.6.

## 7. Pruebas
- **Unitarias**: parser contra fixtures reales anonimizados de cada versión del CLI disponible, más casos sintéticos (líneas cortadas, campos nuevos, tipos desconocidos).
- **e2e (Playwright + Electron)**: un `claude` falso que reproduce un transcript guionizado con tiempos reales. Comprueba que aparecen las tarjetas, los diffs y las tareas, que la terminal sigue visible, que las sugerencias no envían nada y que hay capturas por modo y tema.
- **Rendimiento**: sesión sintética grande (50 MB o más); medir el tiempo hasta el primer contenido y que el event loop no se bloquee más de 16 ms seguidos.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| El formato del transcript cambia | Parser tolerante y versionado; fixtures por versión; la terminal siempre queda como respaldo |
| Retraso frente a la terminal (escritura por bloque) | El dock muestra el progreso en vivo; la vista se completa al escribirse cada bloque |
| Interpretación de política sobre el Composer o las aprobaciones | Desactivado por defecto; consulta a Anthropic antes de activarlo |
| Parecerse demasiado a Claude Code (marca) | Identidad visual propia y revisión en la auditoría de F6.5 |
| Filtrar datos sensibles del transcript a la UI | Lista blanca de campos en el parser y tests que siembran secretos (como en MCP) |

## 9. Preguntas abiertas
1. ¿`quotaLimits` aparece antes del límite (por ejemplo `allowed_warning`)? Si sí, se pueden dar avisos preventivos de cuota.
2. ¿Hay alguna señal fiable de "esperando aprobación" sin interpretar la pantalla?
3. ¿Qué dependencias usar para markdown y resaltado (tamaño frente a calidad)?
4. ¿El modo por defecto para usuarios nuevos es Dividida o Conversación?
