# Protocolo de orquestación v2 — diseño (22/08/2026)

**Estado:** diseño aprobado el 22/08 (confirmado por repregunta). **S1 ejecutado el mismo día: ver §8.**
Decisión resultante: camino **A** (`Agent` tool + enganche endurecido); 4.3 ya existía. Origen: [evaluación de deepseek-harness y deer-flow](evaluacion-deepseek-harness-y-deer-flow-2026-08-22.md).

**Tesis:** el peaje que Orca cobra en `CLAUDE.md` (~165 de 333 líneas son workarounds del entorno) no
es por falta de primitivas —Orca ya tiene casi todo— sino porque nuestro protocolo guarda en prosa lo
que debería ser dato verificable, y porque la pieza que sí es nuestra (el enganche automático) falla
casi siempre sin que nadie lo note.

## 1. Diagnóstico del protocolo actual, medido en disco

Fuente: `/tmp/waengine-orquestacion/*/enganche.log` (todas las sesiones en esta máquina) y
`orca orchestration task-list / inbox / worker-list` del 22/08.

- **13 enganches fallidos contra 2 exitosos.** 9 por "no apareció ningún pane nuevo en la tab" (el
  hook espera 15 s; el pane tarda más o el harness degradó a in-process), y los de hoy por una
  **carrera**: `dispatch --inject` corre ~3 s después del `Agent` tool, antes de que Claude arranque en
  el pane → `"no recognized agent detected"`.
- **El fallo no se registra como fallo.** Si el inject falla, el handle no se agrega a
  `handles-enganchados.txt`, así que el *siguiente* subagente elige el mismo pane (hoy el segundo
  intentó inyectarse en el pane del primero). Y la task creada queda en `ready` para siempre: de ahí
  los 54/110 tasks en `ready` del censo del 21/08.
- **El coordinador nunca lee el buzón.** `check --ack` es el mecanismo de acuse de Orca y no lo
  invoca nadie: 46/58 `worker_done` y 3/5 `ask` jamás leídos ([[buzon-orca-nunca-leido-ni-ackeado-2026-08-21]]).
  Hoy el informe de deer-flow llegó por `SendMessage` y tampoco entró; se recuperó del transcript.
  Después SÍ entró: el `SendMessage` emitido a las 15:52 UTC se entregó al coordinador recién al
  turno siguiente del usuario (más de 20 min después), idéntico al texto ya recuperado de disco.
  Confirma que la entrega es en límite de turno y que el canal no sirve para cierre ni para esperas.
- **Yo reporté "los dos subagentes arrancaron como panes reales y quedaron enganchados"** sobre la
  base de que el `Agent` tool devolvió "will receive instructions via mailbox". Es el "gate que no corre
  = gate en verde" aplicado a mi propio protocolo.

Consecuencia: todo lo que `CLAUDE.md` dice sobre `worker_done`, `heartbeat` y `ask` describe un
protocolo que **en la práctica casi nunca está activo**. Lo que funciona es lo otro que dice: "el estado
real se verifica en disco".

## 2. Lo que Orca ya provee (verificado en `orca skills get orchestration` y `--help`, 22/08)

| necesidad | primitiva de Orca | observación |
|---|---|---|
| arranque sin carrera | `worker-start --task --agent claude [--model --effort] --worktree current` | "exits 0 only for ready"; falla explícita con `stage/failedStage` y comandos de recuperación |
| fase de vida vs estado de turno | `worker-show --dispatch` → `workerState` + `dispatchStatus`; `TeammateIdle` hook → turno | ya separados; somos nosotros los que los mezclamos |
| recovery mailbox | `check --wait` entrega una Delivery FIFO y **la replaya hasta `--ack <delivery_id>`** | es exactamente queued − delivered de deepseek-harness |
| fin con razón legible | `worker_done` trae `succeeded|failed`; `worker-stop`, `worker-abandon` (fence sin afirmar que paró), `outcome_unknown` | falta nuestro `stop_reason` encima |
| transcript del worker | `worker-read --source auto` devuelve el transcript reportado por hooks, no sólo el scrollback | resuelve el "25 líneas retenidas" de hoy |
| DAG | `task-create --deps <json_array> --parent`; `gate-create/resolve` | existe; nunca lo usamos |
| mensaje dirigido y estable | `dispatch:<id>` como dirección | los handles de terminal son "routing metadata, not durable identity" |

**Lo que Orca no provee** (y los harnesses sí): `writeScopes` con aviso de solapamiento; invariantes
declaradas por componente; `stop_reason` tipado; un vigilante de abandonados ("el `check --wait`
simplemente expira").

## 3. Principios del v2 (tomados de los harnesses, adaptados)

1. **Fase ≠ turno, y el turno nunca reescribe la fase.** `provisioning → active → settled(succeeded|failed|abandoned|interrupted)` es durable; `running/idle/blocked` es derivado. Un `idle` no muta la fase. (deepseek `agent-team.md:24`)
2. **Un mensaje no existe hasta que se acusó.** El coordinador consume con `check --ack`; lo no acusado se replaya. `SendMessage` queda sólo para texto libre, nunca para cierre. (deepseek `agent-team.md:28`)
3. **Todo cierre tiene razón de un enum cerrado**: `completed | failed | timed_out | abandoned | interrupted | unhooked`. `unhooked` es nuevo y nuestro: "nunca quedó enganchado", hoy invisible. (deer-flow `subagent_status_contract.json`)
4. **Cada gate del entorno deja marca de que corrió**, y un verificador falla si la marca falta o quedó vieja. Un gate sin marca no es verde: es desconocido. (deepseek `invariants.md:59`)
5. **Solapamiento de escritura declarado, no recordado.** Cada lanzamiento declara prefijos de path; se advierte antes de lanzar si dos activos se pisan. (deepseek `agent-team.md:57`)
6. **Model-visible ⟺ logged.** Lo que el coordinador "sabe" del estado de la flota tiene que poder reconstruirse de `estado.json` + los logs de Orca; si lo sé por una notificación, no lo sé. (deepseek `AGENTS.md:108`)

## 4. El contrato

### 4.1 Archivo de estado por sesión: `/tmp/waengine-orquestacion/<session>/estado.json`

Reemplaza `mapa.tsv` + `handles-enganchados.txt`. Una entrada por subagente:

```json
{
  "agent_id": "rev-deer-flow@session-…",
  "agent_type": "general-purpose",
  "launched_at": "2026-08-22T12:48:25-03:00",
  "phase": "active",                      // provisioning|active|settled
  "settled_reason": null,                 // completed|failed|timed_out|abandoned|interrupted|unhooked
  "turn": "idle",                         // running|idle|blocked|unknown — derivado, nunca pisa phase
  "handle": "term_b232…",                 // routing, puede cambiar
  "task_id": "task_be7a…", "dispatch_id": "ctx_…",
  "write_scopes": ["docs/agentes/"],      // advisory
  "last_heartbeat_at": null, "last_delivery_acked": null,
  "hook_attempts": [{"at":"…","outcome":"no recognized agent detected"}]
}
```

Toda transición la escribe **un solo script** (`orquestacion-estado.sh set <agent_id> <campo> <valor>`)
con lock de archivo; los hooks y yo pasamos por él. Nada más escribe ese archivo.

### 4.2 Lanzamiento

Dos caminos posibles; el experimento de la sesión 1 decide:

- **A — `Agent` tool + enganche endurecido.** Mantiene la paternidad del pane (el usuario supervisa un
  árbol). El hook `PostToolUse Agent|Task` pasa a: (1) crear la entrada en `provisioning` *antes* de
  buscar el pane; (2) esperar hasta 60 s a que `orca terminal list` muestre un pane nuevo **con agente
  detectado** (no sólo existente) — reintentando `dispatch --inject` cada 3 s hasta que deje de
  responder "no recognized agent"; (3) registrar el handle **aunque falle**, para que el siguiente
  lanzamiento no lo vuelva a elegir; (4) si no engancha, `task-update --status failed` y
  `settled_reason=unhooked` — nunca una task `ready` huérfana; (5) emitir al stdout del hook una línea
  que Claude Code inyecta como contexto: `ENGANCHE rev-x: ok dispatch ctx_… | FALLÓ: <motivo>`. Así el
  coordinador se entera en el mismo turno, no al leer un log.
- **B — `worker-start --agent claude --worktree current --model sonnet`.** Orca crea el pane, espera
  `ready` y devuelve `agentTerminalHandle` + `dispatchId`: sin carrera, sin hook. Pregunta abierta y
  decisiva: **¿el pane nace como hijo del coordinador o como tab hermana?** `CLAUDE.md` dice que sólo el
  `Agent` tool da panes hijos, pero eso se midió antes de que existiera `worker-start`. Si nace hijo,
  B reemplaza A y borra el hook entero.

En ambos casos el prompt del subagente se ensambla desde una plantilla única que ya incluye las reglas
duras (datos reales, sockets, perfiles de shell, sin `AskUserQuestion`, `ask` para decisiones) y el
comando `pytest` corregido — la regla de [[pytest-filtro-tambien-en-historias-2026-08-15]] deja de
depender de que yo la recuerde.

### 4.3 Lectura del buzón — CORRECCIÓN: ya existe desde el 21/08

`.claude/scripts/entregar-buzon-orca.sh` (21/08 17:44, posterior al censo de 46/58) corre en `PostToolUse *`
y `UserPromptSubmit`, entrega y **ackea automáticamente** worker_done/question/escalation/status/heartbeat.
En S1 funcionó: el heartbeat llegó como contexto del hook a los 9 s del lanzamiento. Lo que sigue abajo
era el diseño previo a descubrirlo; queda como referencia de lo que el script ya cubre. Lo que sí falta
es que el script actualice `estado.json` (fase/turno/heartbeat) y el vigilante de 4.4.

(diseño original:)

Un hook **`UserPromptSubmit`** del coordinador (ya hay uno configurado; se extiende) que en cada turno
mío haga `orca orchestration check --peek --types worker_done,escalation,question,heartbeat --json`,
actualice `estado.json` (fase/turno/heartbeat) y escriba al stdout un resumen de una línea por agente
con novedades. Claude Code inyecta ese stdout como contexto del turno: **el buzón pasa a leerse sin que
nadie se acuerde**. El `--ack` lo hago yo explícitamente cuando procesé la Delivery (principio 2), con
`orquestacion-estado.sh ack <delivery_id>`, que también lo registra.

Para esperas largas sin turno del usuario, `check --ack --wait --timeout-ms` en primer plano sigue
siendo el mecanismo; el hook cubre el caso real de uso, que es "el usuario volvió y preguntó cómo va".

### 4.4 Vigilante de abandonados

Mismo hook: por cada entrada en `active`, consultar `worker-show --dispatch`; si `dispatchStatus` es
`dispatched` y `last_heartbeat_at` tiene más de N minutos (propuesta: 20) **y** el pane no muestra
actividad (`lastOutputAt`), marcar `turn=unknown` y avisar en el resumen: `⚠ rev-x sin señales hace
23 min`. No toma acción: la decisión de `worker-abandon` es mía con el usuario. Cierra el agujero
"nadie avisa de un abandonado".

### 4.5 Solapamiento de escritura

`orquestacion-estado.sh lanzar … --write-scopes a/,b/` compara contra los activos y, si hay prefijo
común, imprime `SOLAPAMIENTO con rev-y en docs/agentes/` antes de lanzar. Advisory, como en
deepseek-harness: no bloquea, pero hace visible lo que hoy sostengo de memoria.

### 4.6 Invariantes declaradas: "el gate corrió"

Cada hook y cada script de verificación del entorno (`enganchar-…`, `sondear-eventos-…`,
`verificar-fix-orca.sh`, `verificar-perfiles-shell.sh`, `frenar-comandos-destructivos.py`) deja al
terminar un marker `/tmp/waengine-orquestacion/_gates/<nombre>.ran` con timestamp y resultado. Un
`verificar-gates.sh` al abrir sesión (y dentro del hook `UserPromptSubmit`, barato) lista los gates
declarados en un manifiesto `.claude/gates.manifest` y falla por cada uno sin marker reciente o sin la
línea `No runtime invariant:` que explique por qué no aplica. Un gate que dejó de correr se ve en el
primer turno, no en el incidente.

### 4.7 Enum de cierre y `stop_reason`

`worker_done` de Orca trae `succeeded|failed`. Encima, `settled_reason` del estado toma
`completed|failed|timed_out|abandoned|interrupted|unhooked`, y lo fija siempre el coordinador (o el
vigilante), nunca el worker. Es lo que deer-flow llama `subagent_stop_reason`: la razón de cierre
es un dato, no una interpretación del silencio.

## 5. Qué líneas de `CLAUDE.md` se vuelven verificables (y podrían salir)

- "`idle` NO es terminó… medido 60 s antes" → `estado.json` tiene `phase` y `turn` separados; sobra la prosa.
- "ante un `idle` sin reporte: pedírselo y esperar… jamás editar sus archivos" → `write_scopes` + `phase=active` lo hacen visible; queda una línea.
- "El agujero que queda: nadie avisa de un abandonado… hay que ir a mirarlos" → vigilante. Sale entera.
- "el enganche es automático… si falla tras un reinicio de Orca… `run_required`" → el hook reporta su resultado en el turno; sale el relato.
- "el estado real se verifica en disco, nunca por notificaciones ni por `ListAgents`" → sigue, pero apunta a un archivo y un comando concretos.
- "Nunca dos agentes sobre el mismo archivo" → advisory automática; queda la regla, sale la explicación.
- "pytest sin `-m 'not conversation'`" (memoria) → plantilla de prompt; sale de la memoria.
- "Prohibirle `AskUserQuestion`", reglas de datos reales/sockets/perfiles en cada prompt → plantilla.

Estimación honesta: entre 40 y 60 líneas de las ~165. El resto (tmux, PATH/screen reader, AppImage
parcheado, navegador embebido) es conocimiento del entorno, no protocolo, y no lo toca este diseño.

## 6. Plan por sesiones de orquestación

1. **S1 — Experimento decisivo + enganche endurecido.** Probar `worker-start --agent claude --worktree
   current` con una task trivial y ver dónde nace el pane (hijo o hermana) y si `worker_done` llega a
   `check`. Según el resultado, implementar 4.2-A o 4.2-B. Entregable: 0 tasks huérfanas en una sesión
   con ≥3 subagentes; `hook_attempts` visible en `estado.json`.
2. **S2 — Lector de buzón + vigilante** (4.3, 4.4). Entregable: un `worker_done` real leído y acusado
   sin intervención manual; un abandono simulado (matar el pane) detectado en el siguiente turno.
3. **S3 — Gates con marker + manifiesto** (4.6) y solapamiento (4.5). Entregable: apagar un hook a
   propósito y que `verificar-gates.sh` lo diga en el primer turno.
4. **S4 — Poda de `CLAUDE.md`** contra lo que ya es verificable, con el usuario decidiendo línea por
   línea (es su archivo; no se commitea por mí).

Bloqueos externos: ninguno. Riesgo principal: que `worker-start` cree tabs hermanas (entonces A, con
más código nuestro) y que el hook `UserPromptSubmit` agregue latencia perceptible por turno (medir;
si pasa de ~1 s, el `worker-show` por agente se hace en background y el hook sólo lee el archivo).

## 7. Lo que este diseño no hace a propósito

No reemplaza Orca, no toca el shim de tmux ni `teammateMode`, no cierra panes por CLI, no usa
`SendMessage` como canal de cierre, y no intenta arreglar la entrega de notificaciones de Claude Code
(binario propietario): la rodea leyendo disco en cada turno, que es lo único que siempre funcionó.

## 8. S1 ejecutado (22/08, 16:07 UTC) — resultado

Comando: `task-create` + `orca orchestration worker-start --task task_1f464a9fb2e4 --agent claude
--worktree current --model sonnet --timeout-ms 120000`. Task: ejecutar un `echo`, heartbeat, `worker_done`.

- **Arranque:** `state: ready`, `stage: input_accepted` en **4 s**, dispatch `ctx_9894d473b7d7`,
  terminal `term_3c2e5aa2` creada con `dispatch_input: accepted`. Sin carrera, sin hook.
- **Heartbeat** a los 9 s, entregado y ackeado por `entregar-buzon-orca.sh` en el siguiente tool call.
- **`worker_done` succeeded** a los 18 s (`completed_at 16:07:26`), recibido con
  `check --wait --types worker_done` y ackeado con `check --ack delivery_3c279842373d`.
- **`worker-show`** después: `dispatch.status=completed`, `worker.state=succeeded`,
  `worker.stage=settled`, `last_heartbeat_at` poblado, `terminalResource.ownershipState=user_owned`,
  `releaseState=retained`. Fase de vida y estado de turno vienen separados, como pedía el principio 1.
- **Topología (la pregunta decisiva):** el pane nació en una **tab nueva `b5943c5a`** titulada
  `worker-task_1f464a9fb2e4`, con un solo pane; mi tab `33748620` quedó intacta. Es una **tab hermana,
  no un pane hijo**. `worker-start` no preserva la paternidad que el usuario supervisa.
- No se corrió `worker-release`: cerraría la terminal por CLI, que es lo que `CLAUDE.md` prohíbe por
  el incidente del 10/08. La tab la cierra el usuario con la X.

**Decisión:** camino **A**. `worker-start` es técnicamente superior en todo (readiness real, dispatch
nativo, estado completo) pero sacrifica el árbol de panes. Lo que sí se toma de él: el hook endurecido
debe imitar su contrato — esperar *agente detectado* antes de inyectar, registrar handle en cualquier
resultado, cerrar la task como `failed/unhooked` si no engancha, y reportar al turno del coordinador.

**Alternativa a validar en S1b (barata):** `worker-start --task <id> --terminal <handle>` sobre el pane
que YA creó el `Agent` tool. Si acepta un terminal existente con Claude corriendo, se obtiene el
dispatch nativo (con `worker-show`, heartbeat y readiness) **sin perder el pane hijo**, y el hook se
reduce a "esperar agente detectado → worker-start --terminal". La ayuda dice "a fresh agent terminal is
created unless --terminal is explicit", así que es plausible.

## 9. S1b + implementación (22/08, 16:12–16:20 UTC)

**S1b positivo.** `worker-start --task <id> --terminal <handle>` sobre el pane hijo que creó el `Agent`
tool devolvió `ready/input_accepted` en 2 s con `terminal: reused` (dispatch `ctx_1028f33b65f9`);
el worker mandó `worker_done`, la task pasó sola a `completed`. Dispatch nativo **sin perder el pane hijo**.

**Dato nuevo que explica los 13 fallos:** Claude tarda **~40 s** en ser "recognized agent" dentro del
pane (`agent_unconfigured` en los intentos 1-10, `ready` en el 11, a los 44 s del spawn). El hook viejo
inyectaba a los 3 s. No era flakiness: era determinista.

**Implementado (tres archivos, ninguno commiteado por ser config del entorno de agentes):**
- `.claude/scripts/orquestacion-estado.py` — único escritor de `estado.json` (lock + escritura
  atómica). `upsert / heartbeat / settle / vigilar / resumen / dump`. Fase terminal no se reabre;
  `settle` idempotente; `settled_reason` validada contra el enum cerrado.
- `.claude/scripts/enganchar-subagente-orquestacion.sh` — espera del pane 15→45 s; registra el handle
  en `handles-enganchados.txt` y `estado.json` **antes** de intentar nada; reemplaza
  `dispatch --inject` por `worker-start --terminal` con hasta 20 intentos cada 3 s; si no llega a
  `ready`, `task-update --status failed` + `settle unhooked`; en todos los caminos imprime
  `additionalContext` (🔗 ENGANCHADO / 🔌 ENGANCHE FALLÓ) que el coordinador lee en el mismo turno.
- `.claude/scripts/entregar-buzon-orca.sh` — ya no sale temprano sin mensajes; heartbeat →
  `last_heartbeat_at`, `worker_done` → `settle` con outcome; **vigilante** (`[VIGILANTE]` en el
  contexto) en cada `UserPromptSubmit` y como máximo una vez por minuto en `PostToolUse`; umbral
  `WAENGINE_VIGILANTE_MIN` (20 min). Sincroniza contra `worker-show` antes de acusar abandono.

**Verificado en vivo:** `prueba-enganche-v2` enganchado en intento 11, reporte 🔗 recibido en el
turno, `worker_done` entregado por el hook, `estado.json` → `settled/completed`, buzón en 0, task
`completed`. Prueba unitaria del vigilante con pane inexistente → aviso correcto. Tasks huérfanas
`task_a6fe69c8acd6` y `task_be7afeb39d92` cerradas a mano como `failed/unhooked`.

**Pendiente del diseño:** 4.5 (write_scopes: el campo existe en `estado.json`, falta el aviso de
solapamiento al lanzar) y 4.6 (gates con marker + manifiesto). S4 (poda de `CLAUDE.md`) es del usuario.

## 10. 4.6 implementado: gates con marker + manifiesto (22/08, 17:50–18:00 UTC)

- `.claude/scripts/gate.sh <nombre> -- <cmd>`: envoltorio que corre el hook real sin tocar stdin,
  stdout ni exit code (probado: exit 2 de un PreToolUse que deniega pasa intacto) y escribe
  `/tmp/waengine-orquestacion/_gates/<nombre>.ran` con `{at, epoch, exit, dur_s, session}`.
- `.claude/gates.manifest`: `nombre | disparador | tolerancia_seg | archivo`. Un gate con `-` debe
  llevar `No runtime invariant: <por qué>` (regla de deepseek-harness); hoy son `enganchar-subagente`
  (se verifica por agente en `estado.json`) y `sondear-eventos` (sondeo de diagnóstico).
- `.claude/scripts/verificar-gates.sh`: tres estados por gate (corrió-ok / corrió-falló / no-corrió).
  La referencia de actividad sale del **transcript de Claude Code** (último `tool_use` para
  Pre/PostToolUse, último mensaje de usuario para UserPromptSubmit), fuente independiente de los
  hooks: si todos los hooks murieran, el transcript seguiría diciendo que hubo actividad. Los gates
  `manual` (`verificar-fix-orca`, `verificar-perfiles-shell`) exigen marker de menos de 24 h. Invariante
  extra: ningún agente en `provisioning` más de 5 min. Como hook `UserPromptSubmit` imprime
  `🚧 GATES DEL ENTORNO` **sólo si hay fallos**; manual, reporte completo y exit 1.
- `settings.json`: los 13 comandos de hook quedaron envueltos; `verificar-gates` agregado al final de
  `UserPromptSubmit`. Claude Code recargó los hooks en vivo (marker de `frenar-comandos-destructivos`
  apareció en el siguiente tool call, sin reiniciar).

**Verificado:** antes de envolver, 7 fallos "NO CORRIÓ nunca" (detección correcta del estado inicial);
después, 3 OK en el primer tool call; prueba negativa envejeciendo un marker 1 h → acusado en ambos
modos. Los dos manuales corridos por el envoltorio: fix de Orca presente (app 1.4.178), perfiles sanos.

**Queda:** 4.5 (aviso de solapamiento de `write_scopes`) y S4 (poda de `CLAUDE.md`, del usuario).

## 11. Integración en el fork de Orca (decidido 22/08: fixes 1 + 2)

**Pregunta del usuario:** en vez de `/abrir-sesion`, ¿integrar el trabajo en nuestro fork de Orca?
**Respuesta:** sólo la mitad que son defectos de Orca; `estado.json`/gates/markers son política nuestra
y quedan en `.claude/`. Informe del fork (explorador, verificado a mano):
`~/Work/orca-fork`, `origin=stablyai/orca`, rama `fix/agent-teams-identidad` con DOS commits propios
(`aef3a445b9` forgetTerminalHandle, `56483dc9` re-resolución por paneKey); build `pnpm run build:linux`
≈ 1 h, AppImage ok, `.deb` falla por `fpm` (irrelevante); `~/Descargas/orca-linux.AppImage` es el
artefacto del 11/08 byte a byte.

**Causa raíz del `agent_unconfigured` (confirmada en código):**
- `src/shared/agent-title-status.ts` `detectAgentStatusFromTitle`: Claude sólo por prefijo `✳`
  (ocioso). `◑ Explore` → `null` → `classifyAgentTitle` = `neutral`. **Reconoce ociosidad, no vida.**
- fallback por proceso: `comm` del binario es `2.1.240` (`~/.local/share/claude/versions/2.1.240`),
  que `recognizeAgentProcess` no conoce.
- tres call sites sin espera: `orchestration-workers.ts:87`, `orchestration.ts:1258`,
  `orchestration-federation.ts:150`. El camino que crea terminal (`orchestration-worker-topology.ts:56`)
  no la necesita. Evidencia viva: el Explore de las 18:05 no enganchó en 80 s y sí apenas quedó `✳`.
- `getStaleDispatches` (`orchestration/db.ts:6540`) sólo lo consume el `Coordinator` opcional
  (`coordinator.ts:214`), que nadie arranca. Agent-teams y orquestación: desacoplados a nivel módulo,
  misma instancia `OrcaRuntimeService` (`orca-runtime.ts:3257`) → punto natural para el fix 2.

**Plan (secuencial, ambos tocan `orca-runtime.ts`):**
- **Ola 1** — rama `fix/orchestration-attach-readiness`: (A) glifos de trabajo de Claude como
  `working`; (B) semver + `/claude/versions/` → claude; (C) `waitForTerminalAgent` en las 3 call sites
  (`worker-start --terminal` usa su `timeoutMs`; `dispatch --inject` gana `--wait-for-agent-ms`, default 0).
  Subagente `orca-fix-readiness` (Sonnet) lanzado 22/08 ~18:30 UTC. Sin commit hasta verificar.
- **Ola 2** — Dispatch automático al nacer el pane hijo: en el `handleSplit` del dispatcher de
  agent-teams (`claude-agent-teams-tmux-dispatcher.ts`) o su callback en `orca-runtime.ts`, si el líder
  tiene Run bindeado → `task-create` + `dispatch` para el pane nuevo, con el preamble de coordinación.
  Borra nuestro hook de enganche. Pendiente de diseño fino tras la ola 1.
- Después: tests + typecheck → build (1 h, lo decide el usuario) → reemplazar AppImage → reiniciar
  Orca → repetir el experimento S1b y el Explore ocupado → PRs upstream.
