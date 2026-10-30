# F6.0b spike: las pantallas y teclas reales de la TUI de `claude` (diseño chat-first)

Fecha: 2026-10-28. CLI: `claude` 2.1.312 (Haiku 5.5 para los turnos, cuenta de prueba autorizada por el usuario). Base: [docs/design/F6-vista-enriquecida.md](../design/F6-vista-enriquecida.md) y [F6.md](F6.md). Fixtures en `tests/fixtures/screens/` (texto plano, anonimizado; la última línea de cada uno es `--cursor y= x= bracketedPaste= exited=`, metadatos del arnés, no de la pantalla).

## 0. Método y límites
- Arnés en el scratchpad (no en el repo): `node-pty` del repo + `@xterm/headless` (120x40) que renderiza la pantalla igual que xterm; se vuelca el **viewport** (`buffer.active`, filas `baseY..baseY+rows`) y la posición del cursor cada 150 ms. Control por archivos (sin sockets).
- Entorno del hijo del arnés: se eliminan las variables `CLAUDE_*`/`ANTHROPIC_*` heredadas salvo `CLAUDE_CONFIG_DIR`. Con `CLAUDE_CODE_CHILD_SESSION` heredado el CLI muestra "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker" y no escribe transcript. `src/main/env.ts` **ya** quita `^CLAUDE_CODE_` (y `CLAUDECODE`, `CLAUDE_PID`, `ANTHROPIC_`); el test de `tests/relay.test.ts` ahora afirma también `CLAUDE_CODE_CHILD_SESSION`.
- **Nivel de evidencia**: no se guardó un registro de las entradas enviadas. Lo marcado "observado por el implementador" (que el dígito confirma, el pegado + `\r` en una sola escritura, el ciclo de Shift+Tab, el código de salida 1 de la confianza) se vio en la pantalla durante la sesión pero no hay log de entrada que lo respalde; los fixtures solo prueban las pantallas. Repetirlo con un log de entrada en F6.3 si alguna decisión depende de ello.
- Coste: unos 18 turnos de Haiku, todos de una línea (ningún turno de Opus). Un `/compact` pequeño.
- Efectos laterales en la cuenta de prueba (los hizo el CLI, no se editó nada a mano): `/model <nombre>` y la tecla de dígito del selector **guardan el modelo como predeterminado de la cuenta** (ver 8); se terminó con `/model default`. Se crearon 3 directorios de prueba confiados, 2 sesiones y 1 archivo de plan en esa cuenta.
- Terminal: la TUI usa el **buffer normal** (no la pantalla alternativa) y se repinta en sitio; el historial sube al scrollback. Todo lo importante está en las **últimas ~15 filas del viewport**. La caja de entrada está anclada abajo.
- No verificado en este spike (marcado en cada caso): modal de límite de cuota, errores de red, ≥30 s de trabajo (el contador de segundos/tokens del spinner solo se vio en `/compact`), selección por dígito en el plan, el modo `bypassPermissions`.

## 1. Anatomía de la pantalla (verificado)
Reposo (`02-idle.txt`, `01b-idle-fresh-auto-default.txt`), de arriba abajo:
```
 ▐▛███▛█   Claude Code v2.1.312          <- cabecera (sube al scrollback)
▝▜██████▀  Haiku 5.5 · Claude <Plan>
 ▝▝   ▝▝   /…/tmp/proj
                       ◐ medium · /effort   <- derecha, encima de la caja
──────────────────────────────────────────  <- regla (U+2500 x ancho)
❯ Try "refactor <filepath>"                 <- línea de entrada; el cursor está aquí (x>=2)
──────────────────────────────────────────  <- regla
  ⏸ manual mode on · ? for shortcuts        <- pie: modo de permisos + pista
```
- El texto del placeholder (`Try "..."`) cambia: **no** usarlo para detectar nada. El texto escrito aparece tras `❯` + U+00A0 (espacio de no separación): casar con `\s`, no con un espacio literal.
- El modelo solo está en la cabecera (que se va al scrollback) y en `⎿ Set model to ...`; para saber el modelo actual Relay no debe leer la pantalla (usar el transcript, `attachment` de tipo `model`, o su propio estado).
- Con un diálogo abierto (permiso, pregunta, plan, selector) **desaparece la caja de entrada** (no hay las dos reglas con una línea `❯` en medio; la opción marcada de un diálogo también lleva `❯`, pero sin reglas alrededor). Eso es el discriminador principal entre "caja de entrada" y "diálogo" (ver §11).

## 2. Caso 1: arranque (verificado)
- **Diálogo de confianza** (`01-trust.txt`), solo en un directorio nuevo: título `Accessing workspace:`, frase `Quick safety check: Is this a project you created or one you trust?`, opciones `❯ No, exit` / `  Yes, I trust this folder`, pie `Enter to confirm · Esc to cancel`. **La opción por defecto es "No, exit"**: Enter solo **sale del CLI** (código de salida 1 observado por el implementador en el arnés, no capturado en ningún archivo). Para aceptar: `\x1b[B` (flecha abajo) y `\r`. Las opciones **no** están numeradas (los dígitos no valen). Tras aceptar, el prompt aparece a ~0,5 s.
- No apareció selector de tema ni onboarding en esta cuenta (ya configurada); en cuentas nuevas el selector de tema sigue pendiente de verificar (F6.md §8).
- Primera vez que se pasa a modo auto: aviso de una sola vez en el historial (`Auto mode lets Claude handle permission prompts automatically ...`), no bloquea.
- **Listo para entrada (idle)**: definición completa en §11 (caja de entrada visible y vacía o con el placeholder, sin spinner ni `esc to interrupt`, sin lista superpuesta). Tiempo de arranque normal: ~1 s hasta el primer prompt.
- Bracketed paste está activado por el CLI (`?2004h`; `term.modes.bracketedPasteMode === true`); al salir se desactiva.

## 3. Caso 2: trabajando frente a reposo (verificado; ≥30 s no verificado)
- **Trabajando** (`02b-working.txt`, `02d-working-streaming.txt`): línea de spinner `<glifo> <Palabra>…` encima de la caja (`· Sublimating…`, `✽ Fiddle-faddling…`; el glifo cambia entre `· ✢ ✳ ✻ ✽`, la palabra varía por turno) y, debajo, `⎿  Tip: ...`. El pie pasa a `... · esc to interrupt`. Con texto en streaming (`02e`) la línea del spinner puede estar en blanco unos instantes, pero el pie sigue diciendo `esc to interrupt`. `/compact` muestra `✳ Compacting conversation… (9s · ↓ 762 tokens)` (con segundos y tokens).
- **Reposo tras el turno**: línea de cierre `✻ <Verbo> for 2s · done 9:41 AM` (p. ej. `✻ Baked for 2s`, `✻ Cogitated for 4s`; el verbo varía, el patrón `for <n>s · done <hora>` no) y el pie vuelve a `? for shortcuts`.
- **Fragilidad**: el pie a veces muestra otra pista (`paste again to expand`, `Press Ctrl-C again to exit`) y oculta `esc to interrupt`; el glifo `✻` se usa tanto en el spinner como en la línea de cierre (se distinguen por `…` frente a `for <n>s`). Por eso la regla "working" es una **disyunción**: `esc to interrupt` en el pie **o** una línea `^\s*[·✢✳✶✻✽*] \S.*…` sin `for <n>s`. Reposo = (a)+(b) del caso 1 y ninguna de las dos señales de trabajo, **estable durante ≥300 ms** (un cambio de frame puede dejar un instante sin spinner).
- Señal complementaria fiable del **transcript** (F6.1): una línea `system/turn_duration` marca el fin del turno; `queue-operation` `enqueue`/`dequeue` aparece al enviar mientras trabaja.
- **Esc para interrumpir** (`02f-after-interrupt.txt`): una pulsación de `\x1b` durante el turno; la pantalla muestra `⎿  Interrupted · What should Claude do instead?` y vuelve a reposo al instante. No pide confirmación.

## 4. Caso 3: enviar entrada (verificado)
- **Bracketed paste funciona** y el texto multilínea sobrevive. Un pegado de más de unas líneas se **colapsa** en la caja a `[Pasted text #1 +3 lines]` (`03a`), con el pie `paste again to expand`; al enviar, el mensaje real (con sus saltos de línea y la sangría) llega entero: el eco `❯ ...` lo muestra completo.
- Enviar = `\x1b[200~<texto>\x1b[201~` y `\r`. Observado por el implementador, sin log de entrada: probado **tanto en una sola escritura** (`...\x1b[201~\r`, usado en la mayoría de los envíos) **como separado** 1,5 s después: ambos envían. Recomendación: una sola escritura, con `\r` después del `\x1b[201~`.
- El texto no debe llevar `\x1b` (se puede inyectar el cierre `\x1b[201~` y salir del pegado): quitar caracteres de control salvo `\n` y `\t`.
- Salto de línea sin pegado: `\` + `\r` (`03c`) inserta un salto en la caja (`line1`/`line2` en dos filas).
- **Enviar mientras trabaja**: el CLI **encola**. Se vio `queue-operation enqueue` y, 0,4 s después, `dequeue`; el segundo mensaje se ejecuta al terminar el primero (`03b`: eco `❯ Then reply only with QUEUED.` y spinner continuo). El Composer puede dejar enviar en cualquier momento; mostrar "en cola" es opcional.
- **Pegar sin estar en reposo real es peligroso**: un dígito enviado cuando no hay diálogo se escribe en la caja de entrada (`❯ 1`). Relay solo debe enviar teclas de tarjeta si la pantalla **actual** muestra ese diálogo.
- Borrar la entrada pendiente: `\x15` (Ctrl+U) borra la línea (se usó para limpiar `/` y `@` sin Esc).

## 5. Caso 4: permisos de herramienta, modo `default` (verificado)
`04b-permission-touch.txt` (Bash), `04f-permission-edit.txt` (Edit). `ls` **no** pregunta (solo lectura, auto-permitido); `touch` sí.
```
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below   (opcional)
 Create empty file created1.txt              <- descripción
╌╌╌╌╌╌...
 touch created1.txt                          <- comando
╌╌╌╌╌╌...
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to <dir> from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
```
- Edición (`04f`): título `Edit file`, nombre del archivo, **diff** (`1 -dummy` / `1 +changed`) entre líneas `╌`, pregunta `Do you want to make this edit to <archivo>?` y **solo 3 opciones**: `1. Yes`, `2. Yes, and switch to accept edits (...)`, `3. No`. **El número de opciones y el índice de "No" varían** (4 en Bash, 3 en Edit): hay que parsear las opciones de la pantalla, no asumir posiciones.
- **Teclas** (observado por el implementador, sin log de entrada): el **dígito selecciona y confirma al instante** (sin Enter): `4` = No, `1` = Yes. Flechas `\x1b[B`/`\x1b[A` mueven `❯` (no confirman); `\r` confirma la opción marcada. `Esc` = cancelar (equivale a No).
- Efecto de No/Esc (`04c`, tras `04b`): `Ran 1 shell command` + `⎿  Interrupted · What should Claude do instead?`; **el turno termina** (reposo). Yes (`04e`): el comando se ejecuta (el archivo `yes1.txt` se creó) y el modelo contesta. Las opciones "always allow" y "switch to auto mode" **cambian configuración o modo**: Relay debe mostrarlas con su texto exacto y nunca ponerlas como botón por defecto.
- Detección: línea `Do you want to ...?` (o `Would you like to ...?`) seguida de líneas `^\s*(❯\s*)?\d+\. ` y el pie `Esc to cancel`. Las opciones se leen con `^\s*(❯)?\s*(\d+)\. (.+)$`; la opción seleccionada es la que lleva `❯`. Las opciones largas se parten en varias filas (la continuación no empieza por dígito).
- Observación: tras rechazar varias veces, el modelo a veces responde sin volver a pedir permiso (no hubo diálogo en el tercer intento): una tarjeta no se puede dar por segura con solo "el usuario pidió una herramienta".

## 6. Caso 5: `AskUserQuestion` (verificado)
- **Una pregunta** (`05a`): pestaña `☐ Color` (cabecera corta), pregunta `Which color do you prefer?`, opciones `❯ 1. Red` con su descripción en la fila de abajo (`Choose red`), `2. Blue`, `3. Type something.` y **tras una regla** `4. Chat about this`; pie `Enter to select · ↑/↓ to navigate · Esc to cancel`.
  - Dígito de opción normal: selecciona (se comprobó `2` en la segunda pregunta del flujo de varias preguntas; en la de una sola pregunta se probó solo `3`).
  - **"Otra / Type something"**: `3` mueve el foco a esa fila (no confirma); aparece `ctrl+g to edit in Vim` en el pie; se escribe el texto en esa fila (`3. Green`, `05b`) y **`\r` envía**. El modelo recibe la respuesta libre (`05c`: `⎿  · Which color do you prefer? → Green`).
  - `Chat about this` es la última opción (cierra el cuestionario para hablar).
  - **Esc** (`05g`): `User declined to answer questions`; el turno termina.
- **Varias preguntas / multi-select** (`05d`–`05f`): barra de pestañas `←  ☐ Fruits  ☐ Size  ✔ Submit  →`; en multi-select las opciones son `1. [ ] Apple` y **el dígito alterna la casilla** (`[✔]`), sin avanzar; hay una fila `Type something` y `Next` bajo ella. `\t` (o `→`) pasa a la siguiente pestaña (`05e`); en la pregunta de selección única, el dígito **selecciona y avanza solo** hasta `Review your answers` (`05f`: lista las respuestas, `1. Submit answers` / `2. Cancel`; `1` envía). Las pestañas respondidas pasan a `☒`.
- Detección: línea de pestañas `^[←\s]*[☐☒✔]` con `Submit`, o `Enter to select` en el pie junto a opciones numeradas; la barra de pestañas existe solo con 2+ preguntas. En una sola pregunta no hay barra de pestañas con `Submit`: se detecta por `☐ <Cabecera>` + `Enter to select`.
- Más fiable aún: el `tool_use` `AskUserQuestion` ya está en el transcript con las preguntas y opciones completas (F6.0 §7); la pantalla solo debe usarse para saber **que está esperando** y para el cursor. Relay puede construir la tarjeta del transcript y mandar las teclas.
- No verificado: más de 4 opciones, descripciones largas con scroll, `preview` en las opciones.

## 7. Caso 6: modo plan y `ExitPlanMode` (verificado)
Se llegó con Shift+Tab (también existe `--permission-mode plan`). `06a-plan-approval.txt`:
```
   Ready to code?
   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌ ... plan en markdown ... ╌╌╌╌╌╌╌╌╌
  ──────────────────────────────
   Claude has written up a plan and is ready to execute. Would you like to proceed?
   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback
   ctrl+g to edit in Vim · ~/.claude/plans/<nombre>.md
```
- `3` **mueve el foco a la fila de feedback** (no confirma; hay que escribir el texto y `\r`); **Esc** cancela: `User rejected Claude's plan:` en el historial y se **queda en modo plan** (`06c`). Los dígitos `1` y `2` **no se probaron** (ejecutarían el plan: no verificado, se presumen inmediatos como en los permisos).
- El plan se puede leer de la pantalla pero es mejor del transcript (`tool_use` `ExitPlanMode`, campo `plan`) y del archivo `plans/<nombre>.md` que cita el pie; las opciones y su número **varían con la configuración** (la opción 1 depende de si el auto está disponible): parsear las líneas `N. texto`.
- Aparece también `⏺ Updated plan` + `⎿  /plan to preview` en el historial.

## 8. Caso 7 y 8: modos, `/model`, `/compact`, `/clear`
**Ciclo de Shift+Tab** (`\x1b[Z`; observado por el implementador, sin log de entrada; las pantallas de pie están en `07`, `07b`): `manual → accept edits → plan → auto → manual`. Texto del pie (siempre en la última fila no vacía):

| Modo (transcript `permission-mode`) | Pie |
|---|---|
| `default` | `⏸ manual mode on` (+ ` · ? for shortcuts` en reposo vacío) |
| `acceptEdits` | `⏵⏵ accept edits on (shift+tab to cycle)` |
| `plan` | `⏸ plan mode on (shift+tab to cycle)` |
| `auto` | `⏵⏵ auto mode on (shift+tab to cycle)` |
| `bypassPermissions` | no verificado (no está en el ciclo sin `--allow-dangerously-skip-permissions`) |

El sufijo `(shift+tab to cycle)` desaparece cuando hay otra pista o texto en la caja (`⏸ manual mode on`), así que el patrón es `(manual|accept edits|plan|auto) mode on` / `accept edits on`. `07-mode-plan.txt`. El número de pulsaciones para llegar a un modo se calcula del ciclo y del modo actual (leído del pie, no supuesto). Con 4 estados, una pulsación perdida deja otro modo: **verificar el pie tras cada pulsación**.

**`/model`** (`08a-model-picker.txt`): selector con `Select model`, lista numerada `1. Default (recommended)  Opus 5.5 ...` ... `5. Haiku 5.5 ✔`, `↓ 10. ...`, `… +3 models`, `◐ Medium effort (default) ←/→ to adjust` y el pie `Enter to set as default · s to use this session only · Esc to cancel`.
- **Efecto secundario**: `Enter` y la tecla de dígito **guardan el modelo como predeterminado de la cuenta** (`Set model to Haiku 5.5 and saved as your default for new sessions`). `s` aplica solo a esta sesión (no se probó la tecla `s` por el riesgo de dejar la cuenta en otro modelo; está en el pie impreso). `Esc` cancela (`⎿  Kept model as Haiku 5.5`, `08b-model-esc.txt`; no guarda).
- **`/model <nombre>` no abre el selector** (`08c`): cambia al instante y **también guarda el predeterminado** (`Set model to Sonnet 5.5 and saved as your default for new sessions`). `/model default` vuelve al recomendado (`Set model to Opus 5.5 (default)`).
- Consecuencia para Relay: cambiar de modelo desde la barra de controles **modifica la configuración de la cuenta del usuario** salvo que se use `s` en el selector. Hay que avisarlo en la UI o abrir el selector y enviar `s` tras el dígito (a confirmar en F6.4).

**`/compact`** (`08e`, `08f`): línea `✳ Compacting conversation… (9s · ↓ 762 tokens)`, pie con `esc to interrupt`; resultado `⎿  Compacted (ctrl+o to see full summary)` + `⎿  Read <archivo> (n lines)`. Tardó ~25 s con un contexto mínimo. Escribe `compact_boundary` en el transcript. Sin pregunta de confirmación.

**`/clear`** (`08g`): repinta cabecera y deja el historial vacío (el `❯ /clear` queda visible); el CLI **abre otro archivo de sesión** (`<id>.jsonl` nuevo con `local_command`): el id rastreado cambia (el rebind ya lo detecta Relay, AGENTS.md "limitaciones"). Sin confirmación.

## 9. Caso 9: `/`, `@` y `?` (verificado)
- **`/` abre una lista superpuesta** (`09-slash.txt`) encima de la caja: 5 filas `  ❯ /debug    descripción`, `/add-dir`, ...; sigue habiendo una caja de entrada con `❯ /` debajo. **Hay que descartarla**: `Esc` la cierra pero **deja el `/` en la caja**; hay que limpiar con `\x15` (Ctrl+U). Las coincidencias se filtran al escribir. Enter ejecuta la sugerencia resaltada (con `/model\r` se ejecutó `/model`).
- **`@` abre sugerencias de archivos y recursos MCP** (`09c-at.txt`): filas `+ notes.txt` (archivos), `◇ <servidor>:<uri> – <descripción>` (recursos MCP). `Tab` completa el elemento (dejó `@notes.txt`); las sugerencias se actualizan con retraso (~1 s) al seguir escribiendo.
- Cualquier tecla escrita mientras hay una lista abierta va a la caja y la filtra. Por tanto: **el compositor de Relay debe enviar al PTY solo el mensaje final** (con los `/comando` y `@archivo` ya compuestos como texto) y nunca escribir `/` o `@` sueltos al PTY para "abrir" nada; si se usan para ejecutar un comando (`/compact\r`), el texto completo va en una sola escritura.
- **`?` con la caja vacía** abre el panel de atajos (`10a`), no escribe `?`; `Esc` lo cierra. Un `!` al inicio activa el modo shell (según el panel `10a`) y un `?` en una caja vacía abre el panel. **No verificado** si lo mismo ocurre cuando el texto llega por bracketed paste (un pegado probablemente no dispara los atajos de tecla): se anota como riesgo y Relay **no altera el texto del usuario** por esto; se comprobará con el CLI real en F6.3.
- `ctrl+g` abre el editor externo, `ctrl+z` suspende el proceso, `ctrl+o` alterna la vista verbosa: no reenviar estas teclas desde Relay.

## 10. Caso 10: otros bloqueos
- **`/exit`** (`10b`): sale **al instante, sin confirmación**; imprime `Resume this session with:` y `claude --resume <id>`; el pty termina con código 0 y se desactiva el bracketed paste.
- **Ctrl+C** (`10c`): con texto, borra la caja; con la caja vacía muestra el pie `Press Ctrl-C again to exit`; la segunda pulsación en ese plazo **sale**. Relay no debe reenviar Ctrl+C como "cancelar" (Esc es el botón de parar). 
- **Diálogo de confianza**: ver caso 1. Enter sobre la opción por defecto **sale**.
- **Modal de límite de cuota, errores de red/autenticación**: **no verificado** (no se quiso gastar la cuota de la cuenta hasta el límite). Del transcript: `isApiErrorMessage` + `error:"rate_limit"` ya es la señal (F2); en pantalla se vio el aviso `You've hit your session limit · resets ...` en F0. Todo texto de pantalla desconocido que bloquee la entrada debe tratarse con la regla de abrir la terminal (diseño §5.4).
- Un estado desconocido = **no es reposo y no coincide con ningún diálogo conocido** durante más de ~1,5 s: abrir la terminal.

## 11. Recomendación de detección (pantalla -> estado)
Entrada: el viewport completo como texto plano (`translateToString(true)`) + `cursorY`/`cursorX`. **Ventana**: no se asume que lo útil esté abajo (el diálogo de confianza `01-trust` ocupa las filas 0-13 y deja el resto en blanco). Se toma la **última fila no vacía** (o la fila del cursor si está más abajo) y se examinan las ~20 filas que terminan ahí. Se evalúa 150-300 ms después del último byte del pty y se exige estabilidad ≥300 ms antes de pasar a reposo o de emitir una tarjeta.

Auxiliares:
- **Caja de entrada válida** = la pareja **más baja** de reglas `─{20,}` cuya primera línea interior empieza por `❯` y **no** casa `^\s*❯\s*\d+\.` (esa es una opción marcada de un diálogo), con **solo filas de pie (≤3) por debajo** de la regla inferior. Las líneas interiores adicionales son continuación (texto multilínea).
- **Opciones** = líneas que casan `^\s*(❯\s*)?(\d+)\.\s+\S`.
- **Ancla** (una por tipo, sobre la ventana): revisión `Review your answers|Ready to submit your answers\?`; plan `Would you like to proceed\?|Ready to code\?`; permiso `Do you want to`; modelo `Select model`; pregunta `Chat about this`; confianza `Accessing workspace`.

Orden de evaluación (el primero que cumpla gana):
1. **Salida**: `exited={...}` no nulo en el estado del pty -> `exited`.
2. **Diálogo** (se evalúa **antes** que la clasificación de la caja, pero la puerta solo se abre si **no hay caja de entrada válida** y (≥2 opciones **o** ancla de confianza)). **El ancla nunca abre la puerta**: solo elige el tipo (`dialog:unknown` si no hay ancla conocida: tarjeta genérica y abrir la terminal). Así una respuesta del modelo con `Do you want to pick one?` y una lista numerada sobre una caja visible sigue siendo `idle` (`11`, `11b`). Las pantallas de `AskUserQuestion` dibujan reglas `─` a todo el ancho encima de las pestañas y antes de `Chat about this`, y la opción marcada `❯ 1. Red` es la única línea `❯` entre ellas; la definición de caja válida (primera línea interior no numerada, pareja más baja, solo pie debajo) evita confundirlo con una caja. **`05a`, `05b`, `05d` y `05e` se clasifican como `dialog:question`**, `05f` como `dialog:review`.
3. **Panel de atajos** (`?`): la línea `/keybindings to customize` en la ventana -> `overlay` (el panel se dibuja *debajo* de la caja, `10a`, así que la caja no tiene solo pie debajo).
4. Sin caja de entrada válida -> `unknown` (abrir la terminal tras ~1,5 s).
5. **Lista superpuesta** (`overlay`): sobre la regla superior (6 filas) hay filas `^\s+(❯ )?/\w[\w-]*\s{2,}\S` (sugerencias `/`) o `^\s+[+◇] \S` (sugerencias `@`) (`09`, `09c`).
6. **Entrada pendiente** (`input-pending`): el contenido de la caja no está vacío y no es el placeholder `Try "…"` (incluye `[Pasted text #n +m lines]`, un `/` suelto tras Esc `09b`, texto multilínea `03c`). El composer no envía a ciegas (diseño §5.4).
7. **Trabajando** (`working`): `esc to interrupt` en el pie **o** línea de spinner (`^[·✢✳✶✻✽*] \S.*…`) en las 3 filas sobre la caja.
8. **Reposo** (`idle`): ninguno de los anteriores.

El oráculo completo fixture -> estado está en `tests/fixtures/screens/README.md` (una versión de referencia del clasificador, en Python, lo reproduce para los 41 fixtures). Pruebas negativas: `11` y `11b` (reposo con una lista numerada y un texto ancla en la salida del modelo, justo sobre la caja y dentro de la ventana) deben ser **idle**, precisamente porque la caja de entrada válida está visible.

Dónde es frágil:
- Las **cadenas del pie, del spinner y de las anclas son texto de interfaz** que Anthropic puede cambiar en cualquier versión (los verbos y glifos del spinner ya varían entre turnos); registrar la versión del CLI y probar con los fixtures; si no clasifica, el respaldo es la terminal.
- Un aviso transitorio puede aparecer en la fila sobre la caja (`You've used N% of your weekly limit · resets <hora> (<zona>)`, visto en el log crudo de tres arranques, `02g-idle-weekly-notice`): no es spinner ni diálogo.
- Las opciones largas se parten en filas; el ancho cambia el parseo (usar las columnas reales del xterm).
- Los diálogos con scroll interno (`↓ 10.`, `… +3 models`) ocultan opciones.
- Solo el viewport se lee: no depender del scrollback.

## 12. Recomendación de envío
- **Mensaje**: `\x1b[200~` + texto (sin `\x1b`, sin `\x03`/`\x04` ni otros controles; `\n` y `\t` permitidos) + `\x1b[201~` + `\r`, en **una** escritura, solo cuando la pantalla esté en reposo o en trabajo (se encola) y **no** con un diálogo abierto (un `\r` o un dígito ahí contestaría el diálogo). Comprobar `term.modes.bracketedPasteMode`; si fuera falso, escribir el texto de una línea y `\r`.
- **Tarjetas**: dígito (para permisos y selecciones de opción única) **o** `\x1b[B` x(n-1) + `\r` (para tarjetas con las que no se fíe del dígito, p. ej. pregunta libre `Type something`: dígito + texto + `\r`). Cancelar = `\x1b`. Aceptar la confianza = `\x1b[B\r`.
- Después de cada tecla de tarjeta, esperar al siguiente frame estable y verificar que el diálogo desapareció (o cambió) antes de enviar otra tecla.
- Parar el turno: `\x1b` (una vez). Cambiar de modo: `\x1b[Z` verificando el pie. Limpiar la caja: `\x15`. Nunca `\x03`, `\x04`, `\x1a`.
- Comandos de barra desde la barra de controles: `/compact\r`, `/clear\r`, `/model <nombre>\r` solo en reposo con la caja vacía (si la caja no está vacía, `\x15` antes) y avisando de que `/model` guarda el predeterminado de la cuenta.

## 13. Resumen de verificación
| Caso | Estado |
|---|---|
| 1 Arranque, confianza, reposo | verificado (onboarding/tema de cuenta nueva: no) |
| 2 Trabajando/reposo, Esc | verificado (≥30 s y contadores de tokens: solo en `/compact`) |
| 3 Bracketed paste, multilínea, `\r`, cola | verificado |
| 4 Permiso Bash y Edit | verificado (Write/otras herramientas: no) |
| 5 AskUserQuestion simple, otra, multi, esc | verificado (>4 opciones/preview: no) |
| 6 Plan: pantalla, feedback, esc | verificado; aprobar 1/2: no probado |
| 7 Ciclo de modos | verificado (`bypassPermissions`: no) |
| 8 `/model`, `/compact`, `/clear` | verificado (`s` en el selector: no probado) |
| 9 `/`, `@`, `?` | verificado |
| 10 `/exit`, Ctrl+C, confianza | verificado; límite de cuota/errores: no verificado |

## 11b. Texto fantasma (sugerencia dim) en la caja (sin verificar con el CLI real)

Tras un turno el CLI oficial puede mostrar en la caja vacía una sugerencia gris (SGR dim/faint) que no es texto escrito. `classifyScreen` acepta `dim` (las mismas filas con las celdas dim sustituidas por espacios, `Terminal.tsx` vía `cell.isDim()`) y lo usa SOLO para decidir si la caja tiene contenido; sin `dim` (fixtures .txt) se comporta como antes, y la regla `Try "` queda como respaldo. Test sintético en `tests/screen.test.ts`. Sin verificar: que la sugerencia real use SGR dim (y no solo color gris) y que un paste con ella visible la sustituya (el paste vuelve la caja no vacía, la sugerencia desaparece. El Enter va en la misma escritura que el paste: el envío usa el valor escrito, y una sugerencia solo cuenta tras aceptarla explícitamente (estado `accepted`, strings del bundle); sin verificar en vivo).

Evidencia (strings del bundle del CLI 2.1.312, nunca ejecutado; sin verificar en pantalla): la sugerencia se pinta `he.dim(t)` (SGR dim), pero con el cursor visible el PRIMER carácter va con el estilo del cursor (probablemente inverso) y NO dim. `maskDim` (`src/shared/screen.ts`) también blanquea una celda inversa seguida de una dim; un carácter inverso solo, o seguido de uno normal (texto escrito bajo el cursor), se conserva (dirección segura).

La máscara solo cubre la forma del placeholder: el contenido de la fila (tras `❯`) se blanquea si todas sus celdas no vacías son dim, o es una celda inversa seguida solo de dim (saltando celdas de continuación de ancho 0). Texto escrito con cola dim (p. ej. texto interino del dictado por voz, `interimRange` → dim) NO se enmascara y sigue siendo `input-pending`.
