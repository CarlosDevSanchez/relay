# F6 · Vista enriquecida (diseño y plan)

Estado: **propuesta aprobada en concepto (2026-10-27); dirección revisada a *chat-first* el 2026-10-28 (§0b). F6.0 (transcript) hecha, ver [docs/spikes/F6.md](../spikes/F6.md); F6.0b (pantallas y teclas reales de la TUI) hecha, ver [docs/spikes/F6b.md](../spikes/F6b.md).** Se ejecuta después del MVP (F0–F5).

### Decisiones del usuario (2026-10-27)
- **Identidad visual:** lo más similar posible a la app de Claude Code, guiándonos de ella, sin ser exactamente igual ni replicarla. Relay mantiene nombre, logo y paleta propios y ninguna marca de Claude ni de Anthropic (§2 regla 1).
- **Modo por defecto para usuarios nuevos:** Conversación.
- **Markdown y resaltado de código:** se elegirán en F6.2 con criterios *ponytail* (menor tamaño y menos dependencias, ver §4).
- **Hallazgos de F6.0 que cambian el plan:** sin señal fiable de aprobaciones pendientes (F6.0 descartó los botones Aprobar/Rechazar; F6.0b los reabre por lectura de pantalla, §5.5), `quotaLimits` solo aparece al rechazar, el CLI escribe una línea por bloque, y no hay `TodoWrite` en los transcripts reales. Detalle en §3, §5.3, §5.4, §6 y §9.

### Nueva dirección (decisiones del usuario, 2026-10-28) · chat-first
- **El chat es la interfaz principal.** El `claude` oficial sigue corriendo en su PTY, **oculto por defecto**, y el usuario puede pasar a la terminal completa en cualquier momento.
- **El puente (composer):** al enviar desde el composer de Relay, Relay escribe el texto en el PTY (bracketed paste) y pulsa Enter. Sin SDK, sin stream-json, sin API.
- **Lectura de pantalla:** Relay lee la pantalla de la terminal (el buffer de xterm, en local) para detectar los prompts interactivos del CLI y los muestra como **tarjetas del chat con botones**; un botón envía la tecla correspondiente. La **línea de actividad** también sale de la pantalla.
- El detalle verificado (patrones, teclas, fragilidad) está en [docs/spikes/F6b.md](../spikes/F6b.md); los fixtures en `tests/fixtures/screens/`.

## 1. Qué es y qué no es

Relay sigue ejecutando el **binario oficial de `claude` sin modificar**, en una terminal real (PTY), con el login del propio usuario. La vista enriquecida es una **capa de lectura**: convierte el transcript `.jsonl` que el CLI ya escribe en disco en una interfaz de chat limpia y dinámica (mensajes, herramientas, diffs, tareas, progreso).

- No usa el Agent SDK ni `--output-format stream-json`.
- No hace peticiones a Anthropic ni consume cuota por sí misma.
- No lee, guarda ni intermedia credenciales.
- No sustituye al CLI: el binario oficial sigue corriendo en el PTY. **La terminal está siempre viva y a un clic**; está oculta por defecto en modo chat y se abre sola cuando Relay no sabe representar un prompt (§5.5).

Objetivo de producto: quien no se siente cómodo con la TUI tiene una forma menos intrusiva de **seguir y revisar** lo que hace el agente, con la misma calidad de experiencia que una app de escritorio.

## 2. Marco de política (no negociable)

Fuente: [Claude Code · Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) y [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

| Permitido | No permitido sin aprobación de Anthropic |
|---|---|
| El usuario inicia sesión en el binario **sin modificar** con su propia suscripción | Ofrecer el login de claude.ai / los límites de suscripción para impulsar un producto propio (incl. Agent SDK = binario vía stream-json) |
| Leer archivos locales del usuario (transcripts) | Recolectar, guardar o intermediar credenciales o tokens de sesión |
| Decir en texto plano que Relay "ejecuta Claude Code" | Usar nombres/logos de Claude Code o Anthropic como marca propia, o **elementos visuales que imiten Claude Code** |

Reglas de diseño derivadas:

1. **Parecido guiado, identidad propia.** Decisión del usuario: la UI debe ser lo más similar posible a la app de Claude Code, guiándonos de ella para la disposición y los patrones (chat, tarjetas de herramienta, panel de tareas, diffs, barra de estado), **sin ser exactamente igual ni replicarla**. Relay conserva su nombre, logo, paleta y tema propios (teal/navy, daisyUI); no usa nombres, logos, el destello ni arte ASCII de Claude Code o de Anthropic, y no copia sus recursos gráficos. La auditoría de F6.6 revisa que se cumpla este equilibrio con esta lista. **Se puede seguir de Claude Code**: disposición, arquitectura de información y patrones (línea de tiempo del chat, tarjetas de herramienta, diffs, barra de estado, panel lateral). **No se puede copiar**: sus glifos ni spinners, arte ASCII, wordmark o logo, paleta o tipografía copiadas, iconos copiados.
2. **La terminal está siempre viva y a un clic; se abre sola cuando Relay no puede representar un prompt.** (Sustituye a "la terminal oficial nunca desaparece".) El PTY del CLI oficial nunca se detiene ni se sustituye; en modo Conversación está oculto, en *Dividida* y *Terminal* visible. Si la pantalla muestra un estado que no se reconoce (§5.5), o hay un prompt sin tarjeta, Relay muestra la terminal y le da el foco.
3. **Entrada siempre del usuario.** Ningún texto ni tecla llega al CLI sin una acción explícita del usuario: pulsar Enviar en el composer, pulsar el botón de una tarjeta o de la barra de controles, o teclear en la terminal. Una sugerencia o una entrada de la paleta **rellena el composer**; no envía. Relay nunca contesta un prompt por su cuenta (ni siquiera "el más seguro") y las opciones que cambian configuración ("always allow", "switch to auto mode", `/model`) se muestran con su texto exacto y nunca son el botón por defecto. Excepción ya aprobada: el mensaje de auto-continuar como argv tras un cambio de cuenta confirmado. **Esto exige enmendar la regla 3 de AGENTS.md en F6.3/F6.4** (hoy dice que las pulsaciones del usuario y el código de login son lo único que se reenvía al pty); la enmienda no se hace en esta etapa.
4. **Sin IA propia.** Sugerencias y resúmenes se generan con reglas locales sobre el transcript; Relay no llama a ningún modelo.
5. **Campos sensibles fuera, por lista blanca.** El mecanismo es una **lista blanca de campos**: el parser solo copia al modelo normalizado los campos conocidos (texto, nombre y entrada de herramienta, resultado, diff, ids, tiempos) y descarta todo lo demás por defecto, incluidos los campos nuevos que añada el CLI. Qué se ignora y por qué: spike F6 §8 (`credential_org`, `api-request*`, `prompt_snapshot`, `serverClassifierRequest/Context`, `wireToolInputs`, `wireIngestContext`, `message.diagnostics/safeguard_results/context_management`, `signature`, datos de imagen...). Nunca una lista negra.

> Antes de publicar el *Composer* (§5.4) se recomienda confirmar con Anthropic que un campo de entrada propio que reenvía el texto del usuario a la TUI del binario oficial (que sigue corriendo, aunque oculta) es aceptable. Con la dirección chat-first el composer es el camino principal, no una opción: hasta tener esa confirmación se mantiene una preferencia para volver al modo terminal-primero. Ver también la nota de política del §8.

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

Codex: los rollouts (`sessions/YYYY/MM/DD/rollout-*.jsonl`, eventos `session_meta`, `item_completed`, `task_complete`…) alimentan la misma vista mediante un adaptador (F6.7). **Parcialmente verificado**: mensajes y fin de turno sí; llamadas a herramientas, parches, planes y aprobaciones **no** (esta máquina no tiene rollouts reales de Codex; ver el spike §9).

## 4. Arquitectura

```
CLI oficial ──escribe──▶ transcript.jsonl
                              │ tail incremental (ya existe en limit.ts)
                              ▼
main: parser tolerante (lista blanca) ──▶ agrupa por message.id ──▶ modelo normalizado
                              │ IPC por lotes (session:events)
                              ▼
renderer: store por sesión ──▶ ConversationView / StatusBar / TaskPanel / Composer / PromptCards (terminal oculta pero viva)
```

- **Parser** (`src/main/transcript/`): puro y testeable. Una línea del CLI es **un bloque**, no un mensaje: el parser agrupa por `message.id` (orden `apiBlockIndex`) y ordena por posición en el archivo, no por `timestamp`. Tolera líneas de más de 1 MB y una última línea cortada. Convierte líneas a eventos normalizados: `Turn`, `Message{role,text,thinking}`, `ToolCall{id,name,input,result,status,durationMs}`, `Diff{file,hunks}`, `Todo[]`, `Subagent{id,parent,calls}`, `Notice`, `Quota`, `Handoff`. Ignora lo desconocido y registra la versión del CLI; si un tipo crítico no se entiende, la vista muestra "formato no reconocido, usa la terminal" sin romper nada.
- **Lectura**: reutiliza el `tailFile` de F2 (offsets, UTF-8 partido, truncado). La carga inicial de sesiones largas va paginada desde el final. Un `worker_thread` solo se añade si una medición lo exige.
- **IPC**: eventos en lotes con un número de secuencia; el renderer reconstruye el estado de forma idempotente.
- **Renderer**: lista virtualizada; markdown y resaltado de código con dependencias pequeñas y fijadas (decisión del usuario: elección final en F6.2, con criterio *ponytail*).

## 5. Experiencia (pantallas y componentes)

### 5.1 Layout y modos
- **Conversación** (**modo por defecto para usuarios nuevos**, decisión del usuario): chat a pantalla completa con el composer abajo y la **terminal oculta pero viva** (el PTY y su xterm siguen recibiendo salida; el xterm sin visibilidad es la fuente de la lectura de pantalla, §5.5). Un interruptor "Ver terminal" la muestra a pantalla completa o como panel. La **línea de actividad** (§5.6) sustituye al dock de 2–6 líneas del plan anterior.
- **Dividida**: descartada en F6.3 (chat o terminal, con interruptor).
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
- **Aviso de atención** (chat-first): ya no se remite al usuario a la terminal para contestar. Cuando el clasificador de pantalla (§5.5) detecta un diálogo, el chat muestra la tarjeta con botones y la línea de actividad dice "Esperando tu respuesta"; solo si el diálogo es de un tipo desconocido se abre la terminal con el foco. Del transcript sigue sin haber señal fiable de aprobaciones pendientes (spike F6 §7); `AskUserQuestion`/`ExitPlanMode` pendientes sirven de confirmación cruzada.

### 5.4 Interacción (dentro de las reglas del §2) · rediseñada en chat-first
- **Composer (principal)**: campo multilínea que, al pulsar Enviar, escribe en el PTY `\x1b[200~<texto>\x1b[201~\r` en una sola escritura (el texto se valida como `checkContinueMessage` pero sin el límite de una palabra: sin `\x1b` ni controles salvo `\n`/`\t`; spike F6b §12). **Solo se envía desde `idle`** (decisión F6.3 tras la auditoría): mientras el CLI trabaja pueden aparecer diálogos de permiso en cualquier momento y el `\r` confirmaría la opción preseleccionada, así que el composer deja escribir el borrador pero no enviar ("Espera a que el CLI termine o pulsa Parar"). Antes de escribir se lee el frame tras vaciar el parseo de xterm y main rechaza la escritura si llegó más salida de la que el renderer había parseado (guarda `seq`). **Nunca a ciegas**: justo antes de escribir se clasifica el frame actual (§5.5). Si el estado es *diálogo*, el composer se bloquea (hay una tarjeta o se abre la terminal). Si es *overlay* (lista `/` o `@` abierta) o *input-pending* (la caja del CLI no está vacía: texto tecleado en la terminal, un pegado colapsado), Relay **no envía**: pide confirmación en la app (`ui.Dialog`, botón seguro por defecto) para limpiar la caja con `\x15` (y `\x1b` antes si hay lista) y luego envía, o abre la terminal para que el usuario decida. Relay nunca escribe `\x03`, `\x04` ni `\x1a`.
- **Tarjetas de prompt** (§5.5) y **barra de controles** (§5.7) son los otros dos puntos de salida de teclas. Todo lo demás (botones de copiar, abrir diff, filtrar...) es solo de Relay.
- **Paleta `/` y autocompletado `@`** (§5.8): propios de Relay, rellenan el composer.
- **Sugerencias** (chips): reglas locales (tareas pendientes, "repetir el último comando que falló", prompts recientes); al clic **rellenan el composer**, el usuario pulsa Enviar.
- **Aprobaciones**: la decisión de F6.0 ("sin botones Aprobar/Rechazar") queda **revertida por la lectura de pantalla** (§5.5). Lo que no cambia: no hay señal fiable en el *transcript*; solo se sabe que hay un prompt porque se ve en la pantalla, y si no se reconoce se abre la terminal.

### 5.5 Clasificador de pantalla y tarjetas de prompt
- Fuente: el viewport de xterm (no el scrollback) y el cursor, evaluado ~200 ms después del último byte y con estabilidad ≥300 ms. La ventana se ancla en la **última fila no vacía o la fila del cursor** (el diálogo de confianza se dibuja en las filas 0-13), no en "las últimas N filas". Al renderer solo llega el texto del prompt detectado. Estados: `idle`, `working`, `overlay`, `input-pending`, `dialog:<tipo>` y `unknown`; patrones, anclas por tipo y fragilidad en spike F6b §11. El diálogo se evalúa **antes** que la caja de entrada: la puerta se abre solo si **no hay caja de entrada válida** (la pareja de reglas más baja, con primera línea `❯` no numerada y solo pie debajo; así `AskUserQuestion` no se confunde con una caja) y hay ≥2 opciones numeradas o la ancla de confianza. **El ancla de texto solo elige el tipo, nunca abre la puerta** (una respuesta del modelo con "Do you want to…?" y una lista sobre una caja visible es `idle`; fixtures `11` y `11b`). El oráculo fixture -> estado está en `tests/fixtures/screens/README.md`.
- Tarjetas (botón -> tecla): **permiso de herramienta** (cada opción -> su dígito; Esc -> cancelar; las opciones se parsean de la pantalla, su número varía), **`AskUserQuestion`** (opción -> dígito; "otra" -> campo de texto: dígito + texto + `\r`; multi-select con casillas, cada dígito alterna) y su **tarjeta de revisión** (`Review your answers`: lista de respuestas + `Enviar` -> `1` y `Cancelar` -> `2`), y **aprobación de plan** (opciones -> dígito, "decir qué cambiar" -> campo de texto + `\r`). Confianza de carpeta y selector de `/model` quedan fuera de F6.4 (diferidos).
- Para `AskUserQuestion` y `ExitPlanMode` el contenido completo (preguntas, plan) sale del transcript (más fiable); la pantalla confirma que se está esperando y dónde está el foco.
- **Implementado en F6.4 (detalles que fijan el diseño)**: la tarjeta se construye de la pantalla **completa** (no de la ventana de 20 filas); si la regla superior del diálogo (dos para el plan) no está en pantalla, la tarjeta es `truncated` y solo ofrece Cancelar y Abrir terminal ("no cabe: revísalo en la terminal"). Las opciones son el último grupo numerado y deben contar 1..k seguidas (o k..m si hay scroll), si no el diálogo es `dialog:unknown`; una fila sangrada que parece `1. x` es continuación (`more`) de la opción. Para `AskUserQuestion`, si el `tool_use` pendiente coincide (pregunta exacta; parcial solo si identifica una), las etiquetas de la pantalla deben coincidir con las suyas dígito a dígito, o la tarjeta se rechaza. Los botones se activan tras **400 ms** con la misma huella (estabilidad, §5.5); cada tarjeta nueva (otra pestaña, otra casilla marcada) vuelve a armarse. Las filas de texto ("Type something", "Tell Claude what to change") son **dos pasos**: se envía solo el dígito (`{kind:'text', n}`), el renderer relee la pantalla y comprueba que sigue el mismo diálogo con esa opción seleccionada y nada más cambiado, y solo entonces envía la línea + `\r` (`{kind:'line'}`); main solo la acepta justo tras ese dígito (cualquier otra escritura en el pty cancela la espera) y permite **una respuesta por frame** (`seq`). Si la comprobación falla no se envía nada más, se muestra la nota y se abre la terminal. Las opciones que cambian ajustes ("always allow", "switch to auto mode", "accept edits") llevan un borde de aviso.
- **Huella y tarjetas de un solo uso (guarda anti-obsoleto)**: cada tarjeta guarda una huella = tipo + pregunta + líneas del cuerpo/comando + textos de las opciones. **Inmediatamente antes de escribir** una tecla se vuelve a clasificar el frame actual y se compara la huella; si no coincide (el diálogo cambió o se cerró), la tarjeta se descarta y **no se envía nada**. Las tarjetas son de un solo uso: sin teclas en cola ni reintentos, y tras cada tecla se espera un frame estable y se comprueba que el diálogo cambió (si no, "sin respuesta" y se abre la terminal).
- **Respaldo**: cualquier diálogo de tipo desconocido, o un estado que bloquee la entrada y no coincida con un patrón durante ~1,5 s, **abre la terminal automáticamente con el foco** y muestra una tarjeta genérica con el texto de la pantalla. Los textos de interfaz del CLI cambian entre versiones: `tests/fixtures/screens/` (con su README) y la versión del CLI son la red de seguridad.

### 5.6 Línea de actividad
Una línea sobre el composer con **texto propio de Relay** (no se muestran el verbo ni el glifo del spinner del CLI, por la regla de identidad): "Trabajando…" más la herramienta o el comando en curso si se conocen (del transcript), "Esperando tu respuesta" (hay tarjeta), "Compactando…", "Listo · 2 s", "Interrumpido". Estado working/reposo desde la pantalla (spike F6b §3 y §11); duración y fin de turno confirmados con `system/turn_duration` del transcript.

### 5.7 Barra de controles (F6.5)
- **Parar** (en F6.3: un solo `\x1b`, solo cuando trabaja), **modelo** (`/model <nombre>`; **avisa de que guarda el predeterminado de la cuenta**; la tecla `s` del selector, que lo evitaría, no está verificada), **modo de permisos** (Shift+Tab verificando el pie tras cada pulsación), **compactar**, **limpiar** (`ui.Dialog` de confirmación), **tokens/contexto** (del transcript) y **cuenta** (flujo de handoff existente, con confirmación).
- Cada botón es una acción explícita del usuario (regla 3) y pasa por la misma comprobación de estado que el composer (§5.4): solo en reposo y con la caja vacía. **Excepción: Parar** (`\x1b` único) se permite mientras trabaja y no exige caja vacía. **Relay nunca escribe `\x03`, `\x04` ni `\x1a`**; Parar es siempre un único `\x1b`.

### 5.8 Paleta `/` y autocompletado `@`
- Propios de Relay: nunca se escribe `/` o `@` sueltos en el PTY (abrirían las listas de la TUI, que se descartan con Esc y dejan el carácter en la caja; spike F6b §9). El composer compone el texto final (`/compact`, `@ruta`) y se envía de una vez.
- `/`: comandos oficiales y los de `catalog` (skills, agents, commands). `@`: archivos del proyecto (listado local desde main, sin seguir symlinks fuera del proyecto).
- Un `!` o `?` iniciales podrían activar el modo shell o el panel de atajos del CLI, pero **no está verificado** que lo hagan cuando el texto llega por bracketed paste (spike F6b §9). Relay **no altera el texto del usuario**; se comprobará con el CLI real en F6.3.

## 6. Plan de implementación

Cada etapa sigue el flujo del proyecto: Sonnet implementa → Opus audita → correcciones hasta que no quede BLOCKER/MAJOR → un commit por etapa → actualizar AGENTS.md, README y ROADMAP.

| Etapa | Alcance | Criterios de aceptación | Tamaño |
|---|---|---|---|
| **F6.0 Investigación** | **Hecha (2026-10-27)**: [docs/spikes/F6.md](../spikes/F6.md) (462 transcripts reales, 24 versiones del CLI) y fixtures sintéticos en `tests/fixtures/transcript/`. Pendiente solo para F6.7: rollouts reales de Codex con herramientas. | Cada campo del §3 marcado como verificado o no verificado; fixtures listos para los tests | S |
| **F6.0b Pantallas y teclas** | **Hecha (2026-10-28)**: [docs/spikes/F6b.md](../spikes/F6b.md) (CLI 2.1.312 real: confianza, reposo/trabajo, bracketed paste, permisos, AskUserQuestion, plan, modos, `/model`, `/compact`, `/clear`, `/`, `@`, `/exit`) y 41 fixtures de pantalla anonimizados de pantalla en `tests/fixtures/screens/`. Sin verificar: modal de límite de cuota, errores, aprobar el plan con 1/2, `bypassPermissions`. | Cada caso del encargo marcado como verificado o no verificado, con patrones y teclas | S |
| **F6.1 Parser y modelo** | `src/main/transcript/` (parser tolerante con lista blanca de campos), agrupación por `message.id` y orden por posición (no por `timestamp`), lectura incremental con paginación desde el final (líneas de hasta 1,4 MB, archivos de hasta 22 MB, última línea posiblemente cortada), IPC `session:events`, filtrado de campos sensibles por lista blanca, subagentes cargados desde `<sessionId>/subagents/`. | Tests con los fixtures sintéticos de `tests/fixtures/transcript/` (spike §10), incluido un formato desconocido que no rompe nada; **ningún marcador plantado (`PLANTED-SECRET-DO-NOT-FORWARD`, `claude-sensitive.jsonl`) aparece en ningún payload IPC**; sesión sintética grande (50 MB) cargada sin bloquear la UI (sin bloqueos de más de 16 ms) | M |
| **F6.2 Vista de conversación** | Línea de tiempo ("virtualizada" = decisión deliberada: `content-visibility: auto` + paginación desde el final, sin librería; solo se añade una si una medición la exige), markdown y código, tarjetas por herramienta, diffs (`structuredPatch`, `bashEditDiff`; Write nuevo desde `content`), "pensando" solo con duración, subagentes anidados, marcas de compactación, auto-scroll. | e2e con un `claude` falso que va escribiendo un transcript guionizado; capturas en tema claro y oscuro | M–L |
| **F6.3 Chat-first: terminal oculta, clasificador y composer** | Terminal viva pero oculta con interruptor a la vista completa del CLI (el chat es la vista por defecto de las pestañas Claude, sustituye a la Dividida provisional de F6.2); clasificador de pantalla `src/shared/screen.ts` (puro, lee el xterm del renderer: `idle` / `working` / `overlay` / `input-pending` / tipos de diálogo / `unknown`, contra `tests/fixtures/screens/`); composer con el puente (bracketed paste, comprobación de estado, confirmación para limpiar la caja); **Parar** (un solo `\x1b`); línea de actividad. **Enmienda de la regla 3 de AGENTS.md** (el composer y los botones son acciones explícitas del usuario que escriben en el pty). | Los fixtures se clasifican como se espera (incluida la lista numerada en la salida = idle, y una versión con las cadenas cambiadas = unknown); e2e con un `claude` falso que pinta esas pantallas; el PTY sigue vivo y visible con un clic; el texto enviado no contiene `\x1b`/controles; nada se envía con diálogo/overlay/input-pending | L |
| **F6.4 Tarjetas de prompt** (hecha 2026-10-28, pendiente de auditoría) | Permiso, `AskUserQuestion` (con su revisión) y plan, con la huella y la guarda de un solo uso (§5.5); desconocido -> abre la terminal. | El e2e demuestra que ninguna tecla sale sin clic, que una tarjeta con huella distinta no envía nada y que un prompt desconocido abre la terminal | M–L |
| **F6.5 Barra de controles y paletas** (hecha 2026-10-28, pendiente de auditoría) | Modelo (con el aviso), ciclo de modo de permisos con comprobación por pulsación, compactar, limpiar (`ui.Dialog`), tokens/contexto, paleta `/` y autocompletado `@` (rellenan el composer). Diferidos u opcionales: tarjeta de confianza, chips de sugerencias, paneles de Archivos y Subagentes. | Cada control solo actúa en reposo con la caja vacía; el texto de la paleta no contiene `\r`, `\n`, ESC ni secuencias de bracketed paste | M–L |
| **F6.6 Pulido** | Animaciones, estados vacíos, atajos de teclado, accesibilidad, rendimiento (virtualización y memoria), revisión visual de identidad propia. | Auditoría visual: sin elementos que imiten la marca de Claude Code | S–M |
| **F6.7 Codex** | Adaptador de rollouts al mismo modelo de eventos. Primero hay que obtener un rollout real (o simulado) con herramientas, parches y planes: en F6.0 solo se verificaron mensajes y fin de turno. | Las mismas vistas funcionan con una sesión de Codex | M |

Orden recomendado: F6.0 → F6.0b → F6.1 → F6.2 → F6.3 (ya utilizable) → F6.4 → F6.5 → F6.6 → F6.7.

## 7. Pruebas
- **Unitarias**: parser contra fixtures sintéticos con la estructura observada (spike §10; el repo es público, no se suben transcripts reales), más casos (líneas cortadas, campos nuevos, tipos desconocidos).
- **e2e (Playwright + Electron)**: un `claude` falso que reproduce un transcript guionizado con tiempos reales. Comprueba que aparecen las tarjetas, los diffs y las tareas, que la terminal sigue viva (visible con un clic), que ninguna tecla sale sin una acción del usuario y que una tarjeta obsoleta no envía nada y que hay capturas por modo y tema.
- **Rendimiento**: sesión sintética grande (50 MB o más); medir el tiempo hasta el primer contenido y que el event loop no se bloquee más de 16 ms seguidos.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| El formato del transcript cambia | Parser tolerante con lista blanca; fixtures sintéticos; la terminal siempre queda como respaldo |
| Retraso frente a la terminal (escritura por bloque) | La línea de actividad sale de la pantalla en vivo; la vista se completa al escribirse cada bloque |
| Interpretación de política sobre el Composer o las aprobaciones | Desactivado por defecto; consulta a Anthropic antes de activarlo |
| La TUI cambia sus textos entre versiones y la lectura de pantalla deja de reconocer prompts | Fixtures por versión, clasificador con "desconocido" como estado de primera clase y apertura automática de la terminal; la versión del CLI se registra |
| Una tecla de tarjeta llega a la caja de entrada (el diálogo ya se cerró) y escribe un dígito o responde otra cosa | Verificar la pantalla actual justo antes de enviar y el siguiente frame después; nunca teclas en cola |
| Política: el chat de Relay reenvía mensajes a la TUI oficial y lee su pantalla | Es el binario oficial sin modificar, con el login del propio usuario y todo en local; sigue pendiente la consulta a Anthropic (§2); sin SDK ni stream-json |
| Cambiar de modelo guarda el predeterminado de la cuenta (spike F6b §8) | Avisar en la UI; preferir el selector con `s` (solo esta sesión) tras verificarlo en F6.5 |
| Parecerse demasiado a Claude Code (marca) | Identidad visual propia y revisión en la auditoría de F6.6 |
| Filtrar datos sensibles del transcript a la UI | Lista blanca de campos en el parser y tests que siembran secretos (como en MCP) |

## 9. Preguntas abiertas y respuestas de F6.0
1. ¿`quotaLimits` aparece antes del límite? **Respondida: no.** Solo en el error `rate_limit` con `status:"rejected"` (92 de 92). Los avisos preventivos siguen viniendo del status line (F5.1).
2. ¿Hay alguna señal fiable de "esperando aprobación" sin interpretar la pantalla? **Respondida: no** para permisos. Solo `AskUserQuestion` / `ExitPlanMode` pendientes indican espera. Se descartaron Aprobar/Rechazar en F6.0; **F6.0b los reabre** leyendo la pantalla (§5.5).
3. ¿Qué dependencias usar para markdown y resaltado? **Abierta, a decidir en F6.2** con criterio *ponytail* (decisión del usuario).
4. ¿Modo por defecto para usuarios nuevos? **Decidido: Conversación.**
5. (Nueva) ¿Forma real de `TodoWrite` / `TaskCreate`? **Abierta**: 0 usos en el corpus. Verificar con una sesión real que los use antes de F6.2 o dejar el panel como opcional.
6. (Nueva) ¿Qué persiste Codex de herramientas, parches, planes y aprobaciones? **Abierta**, para F6.7.
7. (F6.0b) ¿La TUI admite bracketed paste y cómo se distingue reposo de trabajo? **Respondida: sí** (activado por el CLI, multilínea intacta, `\r` envía, se encola si trabaja); reposo/trabajo por `esc to interrupt` o spinner con `…`. Detalle y fragilidad en el spike F6b.
8. (F6.0b) ¿Qué teclas contestan los prompts? **Respondida**: el dígito selecciona y confirma al instante en permisos; "otra" mueve el foco al campo de texto (escribir y `\r`); Esc cancela; las opciones varían en número y se parsean de la pantalla. Aprobar el plan con 1/2, el modal de límite de cuota y los errores: **abiertas**.
