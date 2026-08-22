---
titulo: "La mensajería con subagentes: mecanismo encontrado y verificado"
fecha: "2026-08-10"
sistema: "agentes-harness"
tipo: "incidente"
estado: "historico"
tags: [agentes-harness, incidente]
inventariado: "2026-08-21"
---

# La mensajería con subagentes: mecanismo encontrado y verificado

**Fecha:** lunes 10 de agosto de 2026
**Estado:** mecanismo VERIFICADO de punta a punta a mano. Automatización ESCRITA pero **sin validar
end-to-end** — falta que el harness vuelva a crear panes hijos.
**Antecedente:** `URGENTE-mensajeria-subagentes-desincronizada-2026-08-07.md`, cuyo §6 ("qué falta
investigar") queda contestado acá.

---

## 1. El hallazgo central

Orca tiene una **capa de orquestación** (`orca orchestration ...`) que ya estaba habilitada en esta
máquina y que no estábamos usando. Provee exactamente las garantías que faltaban.

Lo importante, y lo que hacía parecer que había que elegir entre dos mundos: **un subagente lanzado
con el `Agent` tool —o sea, un pane hijo dentro de la propia terminal— aparece en
`orca terminal list` con un handle direccionable, y puede engancharse a la orquestación con
`dispatch --inject --to <handle>`.** No hace falta abrir una terminal nueva ni usar `worker-start`.
Se conservan los panes hijos (la supervisión en árbol que pide `CLAUDE.md`) y se gana el ciclo de
vida con garantías.

## 2. Qué garantiza, medido

| Pregunta abierta del §6 | Respuesta verificada |
|---|---|
| ¿Hay acuse de recibo? | **Sí.** Los mensajes llegan como *Deliveries* FIFO que se **re-entregan enteras** hasta que el receptor las acusa con `check --ack <delivery_id>`. Nada se pierde en silencio. |
| ¿Se puede interrumpir a un subagente? | **No, pero se lo puede bloquear**, que es mejor. `orca orchestration ask` frena el proceso del worker hasta que el coordinador responde. |
| ¿Señal de "terminé" distinguible de `idle`? | **Sí:** `worker_done` (obligatorio, exactamente una vez, con `outcome succeeded\|failed`), más `heartbeat` cada 5 min y `escalation` para bloqueos. |
| ¿Por qué `ListAgents` no veía agentes vivos? | Son **dos registros distintos**. La documentación de la skill lo dice: las herramientas genéricas de subagentes "no crean provenance de task/dispatch de Orca, ni preámbulos de ciclo de vida, ni autoridad de `worker_done`". |

### Mediciones concretas del 10/08

**`ask` bloquea de verdad.** Una sonda corrió `orca orchestration ask` y quedó frenada **10,7 s
reales** (`0m10.676s`, medidos por ella) hasta que el coordinador respondió `segundos`. Recibió la
respuesta textual y recién entonces siguió. Es la contracara exacta del incidente del SDK del 07/08.

**La muerte sin reportar no dispara alarma, pero deja huella inequívoca.** Una sonda lanzada con
instrucción explícita de terminar sin avisar dejó esto:

```
task_4f92477a648a | dispatched     ← nunca pasó a completed
dispatch ctx_0c81021ed75f
  status: dispatched
  last_heartbeat_at: None          ← nunca latió
```

y el `check --wait` del coordinador devolvió `count: 0, timedOut: true` tras 90 s. **Nadie avisa**,
pero los tres estados (vivo / terminado / abandonado) ahora son consultables y distinguibles, cosa
que con `idle` era imposible.

### La evidencia más contundente: `idle` miente, y se puede fechar

Notificaciones reales de la sonda `sonda-panes` contra su `worker_done`:

```
15:28:06  idle_notification "available"   ← el harness la da por libre
15:29:06  worker_done (succeeded)         ← recién ACÁ terminó de verdad
15:29:11  idle_notification "available"
15:29:43  idle_notification "available"
15:29:46  idle_notification "available"
15:37:16  idle_notification "available"   ← ocho minutos después
```

**El primer "available" llegó 60 segundos antes de que la agente terminara.** Es el incidente #2 del
07/08 (dar por cerrado a un agente que seguía escribiendo, y editarle los archivos) reproducido con
reloj. Entre las tres sondas, el canal `idle` emitió nueve avisos no verificables; el de
orquestación, dos `worker_done` exactos y un silencio con estado consultable.

## 3. El flujo verificado, paso a paso

```bash
orca orchestration run-create --objective "<objetivo>" --json
orca orchestration task-create --spec "<spec>" --json
orca orchestration dispatch --task <task_id> --to <handle-del-pane-hijo> --inject --json
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms <n> --json
orca orchestration reply --id <msg_id> --body "<respuesta>" --json      # si llega un question
orca orchestration check --ack <delivery_id> --json
```

Resultado observado: `dispatch` → `worker_done` en 47 s → `ack` → task en `completed`.

El preámbulo que `--inject` mete en el pane le impone al subagente: `worker_done` exactamente una vez
("nunca codifiques el fracaso sólo en prosa y nunca salgas en silencio"), heartbeat cada 5 minutos,
`ask` para preguntas — y **prohíbe explícitamente `AskUserQuestion`**, porque abre un prompt local
que el coordinador no ve ni puede responder y cuelga la sesión para siempre.

## 4. La automatización (escrita, sin validar end-to-end)

Un slash command no servía: lo tendría que tipear el usuario. Corresponde un **hook**, que ejecuta el
harness solo.

- **`.claude/settings.json`** — hook `SubagentStart`, validado con `jq -e`.
- **`.claude/scripts/enganchar-subagente-orquestacion.sh`** — hace el enganche completo.

El payload de `SubagentStart` trae `session_id`, `agent_id`, `agent_type`, `cwd`, `transcript_path`.
**No trae el handle de Orca**, así que el script lo resuelve.

### Dos cuidados que no se relajan (están comentados en el script)

1. **`orca` siempre por ruta absoluta del shim**
   (`/home/jot4dev/.config/orca/linux-orca-cli-shim/orca`). Se verificó que `/usr/bin/orca` **existe**
   en esta máquina: es el lector de pantalla de GNOME, y ejecutarlo le arranca la voz al usuario.

2. **El candidato se filtra por el `tabId` del coordinador.** En este mismo worktree corre **otra
   sesión de Claude** (la de Cloudflare OS). Filtrar sólo por `worktreePath` le habría inyectado el
   preámbulo a la sesión de al lado. Los panes hijos comparten `tabId` con quien los lanzó y sólo
   cambian de `leafId`.

### Dos cosas que se aprendieron depurándolo

- **El `coordinator_pane_key` de un Run creado desde el hook viene VACÍO**, porque el proceso del
  hook no es una terminal registrada de Orca. La identidad hay que sacarla del entorno, que sí la
  publica: **`ORCA_PANE_KEY`** y **`ORCA_TAB_ID`** (el hook las hereda).
- **El handle de terminal NO es identidad estable.** El del coordinador cambió de `term_66891d79` a
  `term_cdffe830` en mitad de la sesión sin que pasara nada raro. Lo estable es `tabId:leafId`.

## 5. 🔴 Por qué quedó sin validar: el harness dejó de crear panes

A mitad de sesión, un lanzamiento falló con
`Failed to create teammate pane: Timed out waiting for the Orca runtime to respond`. Se corrió
`.claude/scripts/verificar-perfiles-shell.sh` y dio **sano** (no era la causa del 07/08). El
reintento funcionó.

Pero **desde ese fallo el harness degradó a subagentes in-process y no volvió a crear panes**.
Verificado en disco: `orca terminal list` muestra **una sola terminal en la tab del coordinador, la
propia**. Se nota hasta en cómo se anuncian los lanzamientos: los primeros decían "recibirá
instrucciones por su buzón" (pane real); los últimos, "async agent launched" (in-process).

Sin pane no hay handle, y sin handle el hook no tiene a qué engancharse: su log dice
`no apareció ningún pane nuevo en la tab <id>`, que es el comportamiento correcto.

`teammateMode` está en `auto`. Forzarlo a `tmux` devolvería los panes, **pero tmux es justo el
terreno donde el 07/08 se rompió el harness** (se borró el socket del agent team y quedó sin poder
crear panes por el resto de la jornada). Decisión del usuario: **reiniciar Orca primero**, a ver si
los panes vuelven solos sin tocar configuración.

## 6. Estado y próximo paso

**Lo primero al retomar:** con Orca reiniciado, lanzar **un** subagente cualquiera y mirar
`/tmp/waengine-orquestacion/<session_id>/enganche.log`. Si dice `enganchado ... → term_...`, el
automatismo quedó validado y sólo falta el segundo hook (el vigilante de abandonados). Si vuelve a
decir `no apareció ningún pane nuevo`, el problema es el modo del harness y ahí sí hay que decidir
sobre `teammateMode`.

**Lo que falta, en orden:**

1. Validar el enganche automático con panes reales (arriba).
2. **Hook vigilante de abandonados** (evento `Stop`): listar dispatches en `dispatched` sin
   heartbeat fresco y avisar por `systemMessage`. Es el agujero conocido — nadie avisa solo.
3. Actualizar `CLAUDE.md`: las cinco mitigaciones del doc URGENTE eran parches por falta de un
   mecanismo confiable. Ahora el protocolo es lanzar con el `Agent` tool, enganchar, y esperar
   `worker_done` en vez de adivinar por notificaciones. Lo de no pisar archivos ajenos sigue valiendo.

**Basura que quedó:** varios Runs de prueba (`run_33c20325d21b`, `run_d92182d2cc49`,
`run_c0f45dfedd7a`, y alguno más de las pruebas secas) y sus tasks. No molestan, pero conviene
saber que están.
