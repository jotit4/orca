---
name: orquestar-subagentes
description: Protocolo para lanzar, supervisar y coordinar subagentes dentro de Orca. Cubre el ciclo de vida completo (lanzar con el Agent tool, verificar el enganche a la orquestación, esperar worker_done), la mensajería con acuse de recibo, la interrupción de un turno en curso, qué escribir en el prompt de cada subagente y cómo detectar un subagente abandonado.
when_to_use: Usar antes de lanzar uno o varios subagentes, cuando un subagente lleva mucho tiempo sin reportar, cuando hay que frenarlo o cambiarle el rumbo, y cuando falla la creación de un pane.
allowed-tools: [Agent, Bash, Read, Grep, Glob]
---

# Orquestar subagentes en Orca

El trabajo ocurre **dentro de Orca**: editor/runtime que gestiona worktrees, terminales, panes de
agentes y un navegador embebido. Un subagente no es una llamada a función: es un proceso vivo en un
pane, con su propio turno, su propio buzón y su propia latencia.

## Protocolo

Copiar y tildar:

```
Orquestación:
- [ ] 1. Prompt inicial completo (incluye reglas duras y el "no hagas X hasta que confirme")
- [ ] 2. Lanzado con el Agent tool
- [ ] 3. Pane nació y quedó enganchado
- [ ] 4. worker_done recibido (NO alcanza con idle)
- [ ] 5. Trabajo verificado antes de reportar
```

## Paso 1 — El prompt inicial

**Todo lo que condiciona el trabajo va en el prompt inicial.** Un subagente no hereda las reglas
duras: hay que escribírselas. Las que más caro salen si se pierden son las de datos reales de
tenants, deploys y sockets.

En cada prompt, declarar:

- **Qué puede usar y qué no debe tocar.** Rutas, tablas, servicios.
- **Las reglas duras que apliquen**: datos reales de tenants intocables; los deploys los hace el
  usuario; nada destructivo sobre el árbol de trabajo; no tocar sockets ni procesos ajenos.
- **`AskUserQuestion` prohibido.** Abre un prompt local que el coordinador no ve ni puede
  contestar, y le cuelga la sesión para siempre. Si necesita una decisión, que use `ask` de la
  orquestación, que bloquea su proceso hasta la respuesta.
- **Un "no hagas X hasta que confirme"** explícito si alguna decisión puede demorar.
- **Si toca frontend**, que verifique el render en el navegador embebido.
- **El contrato de worker**, si se lanzó con `worker-start`: mandar `worker_done` **exactamente una
  vez** con `--outcome succeeded|failed`, incluyendo **`taskId` y `dispatchId`**, un resumen breve
  y los archivos modificados; mandar `heartbeat` durante trabajo prolongado; y usar
  `orca orchestration ask` para cualquier pregunta bloqueante.

Modelo: **Sonnet por defecto**. El modelo caro se reserva para síntesis y juicio fino. Lanzar una
flota en el modelo grande por descuido cuesta plata y sesión.

Reparto: lo mecánico y voluminoso a los subagentes; **el hilo principal se reserva para decidir
rumbo con el usuario**. Mientras la flota corre, esa ventana es para discutir enfoque, no para
narrar progreso.

Dos restricciones de reparto que no se relajan: **nunca dos agentes sobre el mismo archivo**, y lo
que depende de un resultado previo va **en secuencia**. La paralelización no sustituye un gate.

## Paso 2 — Lanzar: siempre con el `Agent` tool

Un subagente lanzado así se materializa como **pane hijo**, un split dentro de la terminal propia,
colgando del que lo lanzó. Esa paternidad es el punto: el usuario supervisa un árbol, no tabs
sueltas.

**Nunca** delegar con `orca terminal create`: abre una tab *hermana* desconectada. Eso queda sólo
para cuando el usuario pida explícitamente una terminal aparte.

Si el harness falla al crear el pane, **reintentar el `Agent` y avisar que el subagente no
arrancó**. Jamás caer al otro mecanismo por lo bajo.

## Paso 3 — Verificar que nació y quedó enganchado

**El enganche a la orquestación es automático**: lo dispara el hook `PostToolUse` con matcher
`Agent|Task` de `.claude/settings.json`. Es el evento correcto porque corre en el proceso del
coordinador, que es quien llama a la herramienta. (`SubagentStart` pertenece al ciclo del subagente
in-process y con panes reales no dispara nunca; queda configurado por si el harness degrada.)

**El harness puede degradar a subagentes in-process sin decirlo.** Se nota en cómo se anuncia el
lanzamiento: *"recibirá instrucciones por su buzón"* es pane real, *"async agent launched"* es
in-process. Se confirma con `orca terminal list`: si en la tab hay una sola terminal, no hubo pane.
Lo devuelve **reiniciar Orca**, no tocar `teammateMode` — forzarlo a `tmux` es meterse justo donde
ya se rompió el harness una vez.

Si el enganche falla tras un reinicio de Orca, el motivo suele ser el Run: sobrevive en disco pero
pierde el binding y `task-create` responde `run_required`. El script ya re-bindea con `run-use`.

## Paso 4 — Esperar el `worker_done`

🔴 **`idle` NO es "terminó".** La notificación de que un subagente quedó libre dice *disponible*, no
*terminado*: puede estar pensando y seguir escribiendo. Está terminado cuando manda su
`worker_done` —o, si no quedó enganchado, cuando entrega su reporte final—, y no antes. Medido: el
primer `idle` llegó **60 segundos antes** del fin real.

Ante un `idle` sin reporte: pedírselo y **esperar**. Si no contesta, avisarle al usuario y que
decida.

**Jamás empezar a editar los archivos que ese subagente tenía asignados.** Ya pasó que se dio por
terminado a uno que seguía trabajando y ambos editaron los mismos archivos; lo detectó el usuario.
Verificar su trabajo leyendo está bien; escribir sobre él, no.

Las tres señales de la orquestación: `worker_done` llega **exactamente una vez** y trae
`succeeded|failed`; `heartbeat` dice que sigue viva; `ask` bloquea su proceso hasta la respuesta en
lugar de seguir adivinando.

### El modelo de la orquestación

Vocabulario de `orca orchestration`, que conviene usar con precisión porque los comandos lo asumen:

- **Run**: espacio de nombres duradero, con la bandeja del coordinador.
- **Task**: unidad de trabajo con spec y dependencias. Estados: `pending`, `ready`, `dispatched`,
  `completed`, `failed`, `blocked`.
- **Dispatch**: **un** intento de una tarea en una terminal. La autoridad para dar algo por
  terminado viene del dispatch activo, no del pane ni de la notificación.
- **Message**: `status`, `dispatch`, `worker_done`, `escalation`, `question`, `heartbeat`.
- **Decision gate**: pregunta que bloquea una tarea hasta resolverse.

Flujo supervisado: crear el Run con su objetivo → definir las Tasks → `worker-start` asignando
subagente a tarea → `check --wait` → recibir `worker_done`.

`worker-start` es para trabajo que necesita reporte y seguimiento por ID de tarea; para un prompt
liviano alcanza `orca terminal send`. Los IDs de task son enlaces clicables que enfocan la terminal
asignada, así que nombrarlos en el reporte le sirve al usuario.

### Liberar un subagente terminado

No dejar abiertas las terminales de subagentes ya completados. El camino correcto es
**`worker-release` y después `worker-read`** — nunca `orca terminal close` genérico, que es el que
se llevó puesta una sesión entera.

Si la liberación vuelve `release_pending` o `release_unknown`, **respetarlo y no forzar**: significa
que el subagente todavía no está en condiciones de soltarse. El cierre del pane en sí lo hace el
usuario con la X.

### El subagente abandonado

Nadie avisa de uno. Un subagente que muere sin reportar deja su dispatch en `dispatched` sin
heartbeat. Los tres estados —viva, terminada, abandonada— son consultables y distinguibles, pero
hay que **ir a mirarlos**: el `check --wait` simplemente expira. Ante un silencio largo, consultar
el dispatch antes de suponer nada.

El estado real se verifica **en disco** (`git status`, fechas, `grep`), nunca por notificaciones ni
por `ListAgents`, que ya pasó una jornada entera sin ver agentes vivos.

## Mensajería: por qué la orquestación y no las notificaciones

La mensajería del harness **no interrumpe**: se entrega en los límites de turno, así que entre
mandar algo y que el otro lo lea pasan minutos en ambas direcciones, y en esa ventana los dos
trabajan sobre premisas distintas. Eso costó, en una jornada, una decisión del usuario que llegó
tarde y se ignoró, un archivo con dos implementaciones pisadas y sin compilar, y dos rondas de "eso
ya estaba hecho".

La salida no es escribir mejores mensajes: es usar `orca orchestration`, que da **acuse de recibo,
bloqueo real y una señal de fin verificable**. Mecanismo completo en
`docs/agentes/mensajeria-subagentes-mecanismo-resuelto-2026-08-10.md`.

## Frenar a un subagente YA: `--interrupt`

Un mensaje a un subagente inactivo llega en 4 s, pero si está ocupado espera **todo lo que le falte
para cerrar su turno** — minutos, con turnos largos. La causa no es Orca sino Claude Code, que
procesa el buzón al cerrar turno; es binario propietario y no hay nada que parchear.

Lo que sí hay:

```bash
orca terminal send --terminal <handle> --text "CORTE: ..." --interrupt --enter
```

**Corta el turno en curso en 4 s.** Usarlo cuando el usuario cambia de rumbo o cuando la premisa de
un subagente dejó de valer, **nunca por impaciencia**: pierde lo que estaba produciendo. Medición en
`docs/agentes/desfase-mensajeria-medido-2026-08-10.md`.

## Panes: arreglados, pero frágiles

Cerrar panes es seguro **mientras el AppImage parcheado siga en su lugar**:
`~/Descargas/orca-linux.AppImage` (el oficial quedó como `orca-linux-ORIGINAL.AppImage`). **Si una
actualización lo pisa, el bug vuelve**, y el síntoma es siempre
`Failed to create teammate pane: tmux: terminal_exited` de forma permanente, sin más salida que
reiniciar Orca.

<details>
<summary>El bug original, ya corregido</summary>

Un pane hijo cerrado por cualquier vía quedaba registrado contra un handle muerto; `list-panes` lo
seguía informando y el `split-window` siguiente lo elegía como origen. La causa raíz estaba en Orca
—`claude-agent-teams-service.ts` sólo limpiaba el registro al morir el líder— y la arreglamos
nosotros. Vuelve si una actualización pisa el binario parcheado, hasta que el PR entre upstream.

</details>

Aun arreglado, dos cosas siguen valiendo:

- **Los panes los cierra el usuario con la X.** El cierre por CLI (`orca terminal close`) se llevó
  puesta una sesión entera y no se volvió a probar.
- **El shim se lee, no se sondea.** El backend de panes no es tmux sino un script en
  `~/.orca/claude-agent-teams-bin/tmux` que hace `exec` de `orca-ide agent-teams-tmux` e implementa
  un subconjunto mínimo. `list-panes` y `display-message` son seguros; probar sus comandos de
  escritura (`split-window`, `kill-pane`) costó otra sesión la misma tarde.

Ante cualquier pane que no arranque, y **antes de lanzar una flota**, correr
`.claude/scripts/verificar-perfiles-shell.sh`: cada pane arranca un shell que lee los perfiles del
usuario, así que una referencia rota ahí se manifiesta como
`Failed to create teammate pane: tmux: Timed out waiting for split pane handle` — una causa trivial
disfrazada de fallo del harness.

## Cuándo NO orquestar

Si el trabajo entra en una cabeza y se resuelve en tres tool calls, se hace directo. Orquestar lo
trivial es tan malo como no orquestar lo grande.

**Dynamic Workflows** (autorización permanente, no hace falta pedirla) se justifican con fan-out
real sobre una lista descubierta —auditar N tenants, migrar N call-sites, N dimensiones de
revisión— o cuando conviene verificación adversarial por ítem. Para una sola fase, un `Agent`
alcanza y cuesta menos.

## Al volver: verificar

Un "listo" no cierra nada. El trabajo que devuelve un subagente se verifica antes de reportarlo:
leer el diff real, correr la verificación del área, contrastar contra el sistema vivo. Ese
procedimiento vive en el skill `verificar-subagente`.
