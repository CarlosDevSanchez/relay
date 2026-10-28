# F6 · Vista enriquecida (diseño y plan)

Estado: **propuesta aprobada en concepto (2026-10-27); F6.0 (investigación) hecha, ver [docs/spikes/F6.md](../spikes/F6.md).** Se ejecuta después del MVP (F0–F5).

### Decisiones del usuario (2026-10-27)
- **Identidad visual:** lo más similar posible a la app de Claude Code, guiándonos de ella, sin ser exactamente igual ni replicarla. Relay mantiene nombre, logo y paleta propios y ninguna marca de Claude ni de Anthropic (§2 regla 1).
- **Modo por defecto para usuarios nuevos:** Conversación.
- **Markdown y resaltado de código:** se elegirán en F6.2 con criterios *ponytail* (menor tamaño y menos dependencias, ver §4).
- **Hallazgos de F6.0 que cambian el plan:** sin señal fiable de aprobaciones pendientes (se descartan los botones Aprobar/Rechazar), `quotaLimits` solo aparece al rechazar, el CLI escribe una línea por bloque, y no hay `TodoWrite` en los transcripts reales. Detalle en §3, §5.3, §5.4, §6 y §9.

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

1. **Parecido guiado, identidad propia.** Decisión del usuario: la UI debe ser lo más similar posible a la app de Claude Code, guiándonos de ella para la disposición y los patrones (chat, tarjetas de herramienta, panel de tareas, diffs, barra de estado), **sin ser exactamente igual ni replicarla**. Relay conserva su nombre, logo, paleta y tema propios (teal/navy, daisyUI); no usa nombres, logos, el destello ni arte ASCII de Claude Code o de Anthropic, y no copia sus recursos gráficos. La auditoría de F6.5 revisa que se cumpla este equilibrio con esta lista. **Se puede seguir de Claude Code**: disposición, arquitectura de información y patrones (línea de tiempo del chat, tarjetas de herramienta, diffs, barra de estado, panel lateral). **No se puede copiar**: sus glifos ni spinners, arte ASCII, wordmark o logo, paleta o tipografía copiadas, iconos copiados.
2. **La terminal oficial nunca desaparece.** Modos *Conversación* (dock compacto de terminal visible abajo), *Dividida* y *Terminal*. No existe un modo "sin terminal".
3. **Entrada siempre del usuario.** Ningún texto llega al CLI sin una acción explícita del usuario (tecla o clic). Las sugerencias **rellenan** el prompt de la terminal; el envío lo hace el usuario. Excepción ya aprobada: el mensaje de auto-continuar como argv tras un cambio de cuenta confirmado.
4. **Sin IA propia.** Sugerencias y resúmenes se generan con reglas locales sobre el transcript; Relay no llama a ningún modelo.
5. **Campos sensibles fuera, por lista blanca.** El mecanismo es una **lista blanca de campos**: el parser solo copia al modelo normalizado los campos conocidos (texto, nombre y entrada de herramienta, resultado, diff, ids, tiempos) y descarta todo lo demás por defecto, incluidos los campos nuevos que añada el CLI. Qué se ignora y por qué: spike F6 §8 (`credential_org`, `api-request*`, `prompt_snapshot`, `serverClassifierRequest/Context`, `wireToolInputs`, `wireIngestContext`, `message.diagnostics/safeguard_results/context_management`, `signature`, datos de imagen...). Nunca una lista negra.

> Antes de publicar el *Composer* (§5.4) se recomienda confirmar con Anthropic que un campo de entrada propio que reenvía las teclas del usuario a la TUI visible es aceptable. Hasta entonces va detrás de una opción, desactivada por defecto.

## 3. Fuente de datos: el transcript

Ubicación: `<configDir>/projects/<cwd codificado>/<sessionId>.jsonl` (subagentes en `<sessionId>/…`). Formato **interno y no documentado**: puede cambiar entre versiones del CLI.

Inventario verificado en F6.0 (claude 2.1.282 a 2.1.312, 462 archivos y 218 542 líneas reales; solo estructura; método y cifras en [docs/spikes/F6.md](../spikes/F6.md)). Cada fila lleva su estado:

| Línea / campo | Uso en la vista |
|---|---|
| `user` / `assistant` con `message.content[]`: `text`, `thinking`, `tool_use`, `tool_result` (+ `image`; `content` puede ser un string) | Burbujas, "pensando" plegable, tarjetas de herramienta con su resultado. **Verificado.** El `thinking` está vacío en el 99 % (solo `signature`): se muestra la duración (`thinkingDurationMs`), no el texto. **Una línea por bloque**: agrupar por `message.id`, ordenar por `apiBlockIndex` |
| `toolUseResult` (`stdout`, `stderr`, `interrupted`, `structuredPatch`, `filePath`, `originalFile`, `status`, `agentId`…) | Salida de comandos, **diffs**, estado de subagentes. **Verificado.** Forma distinta por herramienta y puede ser un string; `structuredPatch` = hunks `{oldStart,oldLines,newStart,newLines,lines[]}` (vacío en Write nuevo: usar `content`); Bash trae `bashEditDiff` |
| `isSidechain`, `parentUuid`, `uuid` | Árbol de subagentes y orden causal. **Verificado.** Los `timestamp` no son monótonos (24 % fuera de orden): ordenar por posición en el archivo |
| `aiTitle` / línea `ai-title`, `cwd`, `gitBranch`, `timestamp`, `version` | Título, contexto y línea de tiempo. **Verificado.** `ai-title` se repite (usar la última); las líneas sueltas no llevan `timestamp` ni `version` |
| `message.usage`, `requestId`, `message.id` | Tokens por respuesta (deduplicados por id, como ya hace `usage.ts`). **Verificado**; en el 7 % de los ids el `usage` difiere entre líneas: tomar la última |
| `system` subtipos `turn_duration`, `local_command`, `informational` | Duración de turno, comandos locales, avisos. **Verificado** (más: `stop_hook_summary`, `away_summary`, `compact_boundary`, `model_refusal_no_fallback`) |
| `permission-mode` (`auto`, `plan`) y `permissionDecision` (objeto) | Modo de permisos en la barra de estado; decisión de cada herramienta. **Verificado** (solo `auto` y `plan` en el corpus; `permissionDecision` desde 2.1.293 y siempre **después** de decidir, no sirve para detectar la espera) |
| `quotaLimits` (`status`, `resetsAt`, `rateLimitType`…) | **Verificado: solo en el error de límite** (92 de 92 líneas, `status:"rejected"`, `five_hour` 87 / `seven_day` 5). No aparece antes del límite (`allowed_warning` existe en el binario pero nunca se escribe en el transcript): sin avisos preventivos desde el transcript; esos siguen viniendo del status line (F5.1). Útil: `resetsAt` numérico |
| `attachment` (`edited_text_file`, `queued_command`, `skill_listing`, …) | Archivos editados; el resto se ignora (los prompts en cola no se muestran). **Verificado**; 34 subtipos distintos, varios sensibles o enormes (`credential_org`, `prompt_snapshot`, `instructions`...): lista blanca |
| `isApiErrorMessage` + `error:"rate_limit"` | Ya usado por F2 para detectar el límite. **Verificado**; existe también la variante "weekly" (5 casos) y otros errores (`server_error`, `authentication_failed`...) |
| Copias registradas en `copies.json` (F2) | Marcas "↪ continuó en la cuenta B" |

Filas nuevas verificadas en F6.0: **subagentes** en `<sessionId>/subagents/agent-<hex>.jsonl` enlazados por `toolUseResult.agentId` (369 de 369), en el corpus todos asíncronos (`async_launched`; el parser acepta también un resultado final en el `tool_result`); **compactación** = `system/compact_boundary` + `user` con `isCompactSummary` (el archivo conserva lo anterior); **imágenes** = bloque `image` base64 (no enviarlo al renderer); **`TodoWrite`: no verificado** (0 usos en 462 transcripts; forma tomada de los strings del binario, y existe también la familia `TaskCreate/Update/List`); líneas de hasta 1,4 MB y archivos de hasta 22 MB.

Codex: los rollouts (`sessions/YYYY/MM/DD/rollout-*.jsonl`, eventos `session_meta`, `item_completed`, `task_complete`…) alimentan la misma vista mediante un adaptador (F6.6). **Parcialmente verificado**: mensajes y fin de turno sí; llamadas a herramientas, parches, planes y aprobaciones **no** (esta máquina no tiene rollouts reales de Codex; ver el spike §9).

## 4. Arquitectura

```
CLI oficial ──escribe──▶ transcript.jsonl
                              │ tail incremental (ya existe en limit.ts)
                              ▼
main: parser tolerante (lista blanca) ──▶ agrupa por message.id ──▶ modelo normalizado
                              │ IPC por lotes (session:events)
                              ▼
renderer: store por sesión ──▶ ConversationView / StatusBar / TaskPanel / TerminalDock
```

- **Parser** (`src/main/transcript/`): puro y testeable. Una línea del CLI es **un bloque**, no un mensaje: el parser agrupa por `message.id` (orden `apiBlockIndex`) y ordena por posición en el archivo, no por `timestamp`. Tolera líneas de más de 1 MB y una última línea cortada. Convierte líneas a eventos normalizados: `Turn`, `Message{role,text,thinking}`, `ToolCall{id,name,input,result,status,durationMs}`, `Diff{file,hunks}`, `Todo[]`, `Subagent{id,parent,calls}`, `Notice`, `Quota`, `Handoff`. Ignora lo desconocido y registra la versión del CLI; si un tipo crítico no se entiende, la vista muestra "formato no reconocido, usa la terminal" sin romper nada.
- **Lectura**: reutiliza el `tailFile` de F2 (offsets, UTF-8 partido, truncado). La carga inicial de sesiones largas va paginada desde el final. Un `worker_thread` solo se añade si una medición lo exige.
- **IPC**: eventos en lotes con un número de secuencia; el renderer reconstruye el estado de forma idempotente.
- **Renderer**: lista virtualizada; markdown y resaltado de código con dependencias pequeñas y fijadas (decisión del usuario: elección final en F6.2, con criterio *ponytail*).

## 5. Experiencia (pantallas y componentes)

### 5.1 Layout y modos
- **Conversación** (**modo por defecto para usuarios nuevos**, decisión del usuario): chat a pantalla completa + **dock de terminal** abajo (2–6 líneas en vivo, spinner de actividad, botón para expandir). El dock es la "terminal interna" visible: muestra el progreso real del CLI.
- **Dividida**: chat a la izquierda, terminal completa a la derecha.
- **Terminal**: solo la TUI (comportamiento actual).
- Selector de modo en la barra de la sesión; se recuerda por usuario. Sin preferencia guardada se abre en Conversación.

### 5.2 Línea de tiempo del chat
- Mensajes del usuario y del agente con markdown, código resaltado y botón copiar.
- "Pensando…" plegable con duración.
- **Tarjetas por herramienta**:
  - `Bash`: comando, salida plegable (stdout/stderr), código de salida, duración, interrumpido.
  - `Read`/`Grep`/`Glob`: archivo o patrón, número de resultados, abrir en el editor.
  - `Edit`/`Write`: **diff** coloreado por archivo, +/−, abrir el archivo.
  - `WebFetch`/`WebSearch`: dominio/consulta y resumen.
  - `Agent`: subagente como hilo anidado con sus propias herramientas, cargado de `<sessionId>/subagents/agent-<agentId>.jsonl`; en el corpus el `tool_result` del padre solo dice `async_launched`.
  - `TodoWrite` y `TaskCreate/Update/List`: solo tarjeta genérica (nombre y JSON plegado). **El panel de Tareas se oculta hasta tener una muestra real**; no se modelan las dos familias.
  - `AskUserQuestion` / `ExitPlanMode`: tarjeta propia con las preguntas o el plan (solo lectura).
  - Desconocidas: tarjeta genérica con nombre y JSON plegado.
- Auto-scroll que sigue el final, con botón "Ir al último" si el usuario sube.
- Animaciones sutiles al aparecer cada bloque (respetando reduced-motion).
- Marcas de sistema: duración de turno, compactación, cambio de cuenta, límite alcanzado.

### 5.3 Paneles y barra de estado
- **Barra de estado**: cuenta, modelo, modo de permisos, rama git, tokens del turno y de la sesión, cuota (cuando se conozca) y estado "trabajando / esperando tu respuesta en la terminal".
- **Panel lateral derecho (plegable)**: Tareas (oculto hasta tener una muestra real de `TodoWrite`/`TaskCreate`), Archivos tocados (de diffs y `edited_text_file`) y Subagentes.
- **Aviso de atención** (resultado de F6.0, spike §7): **no existe señal fiable de aprobaciones pendientes en el transcript** (el CLI no escribe nada mientras espera; `permissionDecision` llega después y un `tool_use` huérfano también ocurre con un Bash largo). El banner "Claude espera tu respuesta en la terminal" con foco al dock se muestra con certeza razonable solo cuando hay un `tool_use` pendiente de **`AskUserQuestion` o `ExitPlanMode`** con la sesión viva. Para el resto de aprobaciones, como máximo un aviso suave (sesión viva, `tool_use` pendiente y pty sin salida N segundos) redactado como posibilidad ("puede que esté esperando…"), nunca como hecho.

### 5.4 Interacción (dentro de las reglas del §2)
- **Botones solo de Relay** (sin tocar el CLI): copiar, abrir diff o archivo, filtrar, buscar, plegar o desplegar, saltar a un turno.
- **Sugerencias** (chips sobre el dock): se generan con reglas locales, por ejemplo tareas pendientes del `TodoWrite`, "repetir el último comando que falló", prompts recientes y comandos oficiales (`/compact`, `/model`, `/clear`). Al hacer clic **rellenan** el prompt de la terminal visible y le dan el foco; el usuario pulsa Enter.
- **Composer (opcional, desactivado por defecto)**: un campo de texto con mejor edición (multilínea, adjuntar ruta, historial) que **reenvía las teclas del usuario** a la TUI visible cuando el usuario envía. Requiere la confirmación del aviso del §2 antes de activarse por defecto.
- **Aprobaciones**: **descartado.** F6.0 no encontró una forma fiable de saber qué pregunta el CLI sin interpretar la pantalla, así que **no hay botones Aprobar/Rechazar**; el banner remite a la terminal y da el foco al dock. Se reabre solo si una versión futura del CLI escribe una señal explícita.

## 6. Plan de implementación

Cada etapa sigue el flujo del proyecto: Sonnet implementa → Opus audita → correcciones hasta que no quede BLOCKER/MAJOR → un commit por etapa → actualizar AGENTS.md, README y ROADMAP.

| Etapa | Alcance | Criterios de aceptación | Tamaño |
|---|---|---|---|
| **F6.0 Investigación** | **Hecha (2026-10-27)**: [docs/spikes/F6.md](../spikes/F6.md) (462 transcripts reales, 24 versiones del CLI) y fixtures sintéticos en `tests/fixtures/transcript/`. Pendiente solo para F6.6: rollouts reales de Codex con herramientas. | Cada campo del §3 marcado como verificado o no verificado; fixtures listos para los tests | S |
| **F6.1 Parser y modelo** | `src/main/transcript/` (parser tolerante con lista blanca de campos), agrupación por `message.id` y orden por posición (no por `timestamp`), lectura incremental con paginación desde el final (líneas de hasta 1,4 MB, archivos de hasta 22 MB, última línea posiblemente cortada), IPC `session:events`, filtrado de campos sensibles por lista blanca, subagentes cargados desde `<sessionId>/subagents/`. | Tests con los fixtures sintéticos de `tests/fixtures/transcript/` (spike §10), incluido un formato desconocido que no rompe nada; **ningún marcador plantado (`PLANTED-SECRET-DO-NOT-FORWARD`, `claude-sensitive.jsonl`) aparece en ningún payload IPC**; sesión sintética grande (50 MB) cargada sin bloquear la UI (sin bloqueos de más de 16 ms) | M |
| **F6.2 Vista de conversación** | Línea de tiempo ("virtualizada" = decisión deliberada: `content-visibility: auto` + paginación desde el final, sin librería; solo se añade una si una medición la exige), markdown y código, tarjetas por herramienta, diffs (`structuredPatch`, `bashEditDiff`; Write nuevo desde `content`), "pensando" solo con duración, subagentes anidados, marcas de compactación, auto-scroll. | e2e con un `claude` falso que va escribiendo un transcript guionizado; capturas en tema claro y oscuro | M–L |
| **F6.3 Layout y dock** | Modos Conversación, Dividida y Terminal; dock de terminal en vivo; barra de estado; paneles de Archivos y Subagentes (Tareas oculto hasta tener una muestra real). | La terminal siempre visible en cualquier modo (el e2e lo comprueba); el modo se recuerda | M |
| **F6.4 Interacción** | Botones solo de Relay, chips de sugerencias que rellenan sin enviar (los chips son una vía nueva de entrada: F6.4 **debe enmendar la regla 3 de AGENTS.md**), aviso de atención (firme solo para `AskUserQuestion` / `ExitPlanMode`; **sin botones Aprobar/Rechazar**); composer detrás de una opción desactivada. | El e2e demuestra que nada se envía sin una tecla o clic del usuario; el texto de cada chip pasa una comprobación tipo `checkContinueMessage` sin ningún carácter de control (`\r`, `\n`, ESC, secuencias de bracketed-paste) | M |
| **F6.5 Pulido** | Animaciones, estados vacíos, atajos de teclado, accesibilidad, rendimiento (virtualización y memoria), revisión visual de identidad propia. | Auditoría visual: sin elementos que imiten la marca de Claude Code | S–M |
| **F6.6 Codex** | Adaptador de rollouts al mismo modelo de eventos. Primero hay que obtener un rollout real (o simulado) con herramientas, parches y planes: en F6.0 solo se verificaron mensajes y fin de turno. | Las mismas vistas funcionan con una sesión de Codex | M |

Orden recomendado: F6.0 → F6.1 → F6.2 → F6.3 (ya utilizable) → F6.4 → F6.5 → F6.6.

## 7. Pruebas
- **Unitarias**: parser contra fixtures sintéticos con la estructura observada (spike §10; el repo es público, no se suben transcripts reales), más casos (líneas cortadas, campos nuevos, tipos desconocidos).
- **e2e (Playwright + Electron)**: un `claude` falso que reproduce un transcript guionizado con tiempos reales. Comprueba que aparecen las tarjetas, los diffs y las tareas, que la terminal sigue visible, que las sugerencias no envían nada y que hay capturas por modo y tema.
- **Rendimiento**: sesión sintética grande (50 MB o más); medir el tiempo hasta el primer contenido y que el event loop no se bloquee más de 16 ms seguidos.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| El formato del transcript cambia | Parser tolerante con lista blanca; fixtures sintéticos; la terminal siempre queda como respaldo |
| Retraso frente a la terminal (escritura por bloque) | El dock muestra el progreso en vivo; la vista se completa al escribirse cada bloque |
| Interpretación de política sobre el Composer o las aprobaciones | Desactivado por defecto; consulta a Anthropic antes de activarlo |
| Parecerse demasiado a Claude Code (marca) | Identidad visual propia y revisión en la auditoría de F6.5 |
| Filtrar datos sensibles del transcript a la UI | Lista blanca de campos en el parser y tests que siembran secretos (como en MCP) |

## 9. Preguntas abiertas y respuestas de F6.0
1. ¿`quotaLimits` aparece antes del límite? **Respondida: no.** Solo en el error `rate_limit` con `status:"rejected"` (92 de 92). Los avisos preventivos siguen viniendo del status line (F5.1).
2. ¿Hay alguna señal fiable de "esperando aprobación" sin interpretar la pantalla? **Respondida: no** para permisos. Solo `AskUserQuestion` / `ExitPlanMode` pendientes indican espera. Se descartan Aprobar/Rechazar (§5.4).
3. ¿Qué dependencias usar para markdown y resaltado? **Abierta, a decidir en F6.2** con criterio *ponytail* (decisión del usuario).
4. ¿Modo por defecto para usuarios nuevos? **Decidido: Conversación.**
5. (Nueva) ¿Forma real de `TodoWrite` / `TaskCreate`? **Abierta**: 0 usos en el corpus. Verificar con una sesión real que los use antes de F6.2 o dejar el panel como opcional.
6. (Nueva) ¿Qué persiste Codex de herramientas, parches, planes y aprobaciones? **Abierta**, para F6.6.
