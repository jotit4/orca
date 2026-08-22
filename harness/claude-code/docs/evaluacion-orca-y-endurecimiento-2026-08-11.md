---
titulo: "Evaluación de Orca como entorno de agentes, y endurecimiento del harness"
fecha: "2026-08-11"
sistema: "agentes-harness"
tipo: "explicacion"
estado: "historico"
tags: [agentes-harness, informe-sesion]
inventariado: "2026-08-21"
---

# Evaluación de Orca como entorno de agentes, y endurecimiento del harness

**Fecha:** 11/08/2026
**Sesión:** ejecutada **fuera de Orca**, desde la Terminal normal (relevante: los subagentes de esta
sesión fueron in-process, sin panes).
**Pedido original:** evaluar si un entorno de agentes como Orca potencia el trabajo o no, investigar
Herdr y Xirp como alternativas, y comparar — con preferencia declarada por open source.

---

## 1. La evaluación: qué se midió y qué se pudo concluir

### El hallazgo metodológico que ordena todo lo demás

**No hay datos para responder si Orca mejoró la productividad.** La adopción se fechó con evidencia
en el **07/08/2026** (commit `bbd1ef2`, "el entorno Orca en las reglas, con el navegador embebido
para verificar UI"). Contra eso, la ventana post-adopción tiene **4 días de calendario y 2 días con
commits** — el 8 y 9 fueron fin de semana. La ventana previa comparable tiene **82 commits en 22
días activos**. Cualquier tasa semanal derivada de dos días es extrapolación, no medición.

Factor de confusión adicional que conviene no perder: el **31/07** se adoptó el modo orquestador
supervisado con subagentes de Claude Code **sin Orca**. Buena parte de lo que se percibe como "el
cambio" (delegar barridos, verificar lo que vuelve, decidir por selector) es de esa semana. Orca
agregó cuatro capacidades encima: panes hijos, worktrees, navegador embebido y computer-use.

### Lo que sí es sólido, porque no depende de la ventana temporal

**El impuesto de configuración.** De las **333 líneas de `CLAUDE.md`** que se cargan en cada sesión,
alrededor de **165 (la mitad)** no hablan del negocio sino de cómo no romper la herramienta:
sockets, tmux, PATH, el shim, perfiles de shell, ciclo de vida de panes, desfase de mensajería.
Además, **9 de los 22 commits (41%)** desde el 07/08 son exclusivamente ediciones de ese archivo.

> Corrección sobre el análisis delegado: reportó 27 commits y 59%. La verificación directa dio
> **22 commits y 9 que tocan sólo `CLAUDE.md`**. El resto de sus números se sostuvo.

**Seis incidentes autoinfligidos en dos días activos de uso** (07/08 y 10/08), ninguno relacionado
con el dominio de negocio: socket de tmux borrado, instalador de Deno que rompió los tres perfiles
de shell, `PATH` que activó el lector de pantalla de GNOME, cierre de pane que mataba el harness
(2 sesiones perdidas), mensajería desincronizada (1 jornada, 1 archivo pisado, 1 decisión ignorada).
Cinco de los seis están mitigados; el sexto se arregló en el código de Orca.

**Sobre calidad, señal levemente positiva pero no utilizable.** El ratio fix:feat bajó en ambos
repos (1,16→0,71 en el panel; 2,36→1,75 en agent-service), pero coincide con el cierre de la
auditoría de flota del 31/07, que ya venía bajando el caudal de bugs. No se pueden separar los dos
efectos con este dataset.

### Veredicto

Orca no está probado como acelerador ni desmentido: no transcurrió tiempo suficiente. Lo que está
probado es que **cobra un peaje del orden de la mitad del contexto de sesión** y costó seis
incidentes en dos días, casi todos concentrados en la curva de adopción.

La pregunta útil no es "¿Orca o alternativa?" sino **cuál de las cuatro capacidades exclusivas de
Orca se usa de verdad**. Si el navegador embebido y computer-use ahorran trabajo semana a semana, el
peaje se justifica y no hay reemplazo. Si en la práctica sólo se usan panes y worktrees, se está
pagando la complejidad de un IDE completo por su parte más inestable.

**Eso es medible, pero no con el historial de git: hace falta que pasen dos o tres semanas de
trabajo normal.** Repetir esta misma medición con una ventana comparable es el pendiente real.

---

## 2. Herdr y Xirp

### Herdr — existe, es OSS real, y es la alternativa seria

Multiplexor de terminal en Rust con conciencia de agentes. **Apache-2.0** verificado contra la API
de GitHub, 27.579★, push diario, binario único de ~10 MB sin Electron, Linux como soporte de primera
clase. Entró a YC ("the runtime stays open").

Resuelve **exactamente el subconjunto que más caro salió**: panes con estado visible
(working/idle/blocked), servidor persistente que sobrevive a cerrar la laptop y reattach por SSH, y
espera bloqueante hasta que otro agente termine de verdad.

**No tiene** worktrees, sandboxing, navegador embebido ni computer-use. Y tiene su propia lista de
fallas serias abiertas: live-lock quemando CPU, un compositor que re-emite estado muerto y sobrevive
al reinicio, y —irónicamente— `Claude Code pane reports idle while a run_in_background shell tool
call is still running`, el mismo falso `idle` que sufrimos acá.

### Xirp — descartado

De Spotify, beta pública desde el 10/08/2026. **Cerrado, sólo macOS, requiere cuenta de Spotify.**
Lo único que vale robarle conceptualmente: worktree por sesión + inyección automática de contexto
organizacional (catálogo de servicios, ownership, decisiones) en cada sesión de agente.

### Alternativas OSS de la categoría (verificadas por API, no por blogs)

| Herramienta | Licencia | Estado al 11/08/2026 |
|---|---|---|
| `anomalyco/opencode` (ex `sst/opencode`) | MIT | 196.172★, push hoy. **Agente propio**, no orquestador |
| `herdrdev/herdr` | Apache-2.0 | 27.579★, push hoy |
| `BloopAI/vibe-kanban` | Apache-2.0 | 27.743★, **sin push desde el 24/04** |
| `smtg-ai/claude-squad` | AGPL-3.0 | 8.278★, push 30/07 |
| `dagger/container-use` | Apache-2.0 | 4.004★, push hoy. Sandboxing real por contenedor |
| `stravu/crystal` → **Nimbalyst** | MIT | 3.108★, **sin push desde el 26/02**. Cambió de nombre |

**Ninguna cubre el conjunto completo.** La combinación panes + worktrees + navegador embebido +
computer-use + mensajería con acuse de recibo no existe en ningún otro producto, abierto o cerrado.

---

## 3. El giro: la abstracción que se iba a buscar afuera ya estaba adentro

La hipótesis de trabajo era portar de Herdr su modelo de identidad, porque cuatro issues abiertos de
Orca parecían el mismo bug de fondo: **usar el handle de terminal como identidad del agente**
(#11739, #9163, #13858, #10673).

**La hipótesis resultó parcialmente cierta, y de la forma más conveniente.** Orca ya tiene identidad
estable de panes en `src/shared/stable-pane-id.ts` (`makePaneKey(tabId, leafId)`, `parsePaneKey`) y
la usa en su orquestación general, con un comentario explícito en `db.ts` sobre que el pane key es
"la identidad estable detrás del handle" para que la propiedad de un `worker_done` sobreviva al
remint.

**El shim de agent-teams simplemente no la usa.** Verificado por conteo directo: `paneKey` y
`leafId` aparecen **cero veces** en `claude-agent-teams-service.ts` (116 líneas) y en
`claude-agent-teams-tmux-dispatcher.ts` (306). Toda la identidad vive en un
`private readonly teams = new Map<string, AgentTeam>()` en memoria, y cada `TeamPane` es
`{ fakePaneId, handle, index }` con el handle capturado una vez en el split y usado sin revalidar en
los ~9 call-sites del dispatcher.

**Conclusión: no hizo falta Herdr para este problema.** De Herdr quedó una sola pieza que vale (§5).

Aclaración sobre #10673 (`worker_done` no enviado): según el mantenedor **no es un bug de
identidad**, es no-determinismo del modelo que no ejecuta el comando. Es ortogonal.

---

## 4. El fix perdido, recuperado y ampliado

### Qué pasó

Una actualización pisó `~/Descargas/orca-linux.AppImage` a las **13:00 del 11/08** y el parche del
10/08 **desapareció en silencio**. Se detectó desempacando el `app.asar` en ejecución: el manejador
de muerte de terminal era el original con el bug, y `forgetTerminalHandle` no existía en el binario.
El bug de cerrar panes estuvo activo toda la tarde sin que nadie lo supiera.

### Qué existe ahora

- **Fork estable en `~/Work/orca-fork`**, rama `fix/agent-teams-identidad`. En disco, no en
  scratchpad: `/tmp` en esta máquina es **tmpfs (RAM)**, que es exactamente por qué se perdió el
  clon anterior.
- **Dos commits**, firmados sólo con la autoría del usuario, sin trailers:
  - `aef3a445` — parche original (limpiar panes hijos cuyo terminal murió).
  - `56483dc9` — **causa raíz**: `TeamPane` lleva su `paneKey` y los call-sites re-resuelven el
    handle una vez ante `terminal_handle_stale`. 5 archivos, +224/-41, con **sólo 14 líneas fuera de
    `claude-agent-teams-*`** (inevitables: el mapeo handle↔paneKey vive en el estado privado del
    runtime). Ningún PR abierto toca esos archivos ⇒ rebasable.
- **Respaldos** en `~/Work/orca-aporte`: `0001-…patch` y `0002-…patch`, reaplicables con `git am`.
  `COMO-PUBLICAR.md` actualizado con los dos parches, la rama correcta y el estado del build.
- **AppImage buildeado y en uso**, verificado en vivo: `forgetTerminalHandle: 7` en los dos mounts,
  con `removeTeamForLeaderHandle` bajando de 6 a 1 como control de sanidad.

### Los tres gotchas del rebuild (ninguno es obvio; los tres costaron tiempo)

1. **Hace falta Node 24** — instalado aislado en
   `~/Work/.toolchain/node-v24.19.0-linux-x64`, se antepone al `PATH` **sólo dentro del comando**,
   nunca en un perfil. Con Node 22 el empaquetado muere con
   `bare runtime imports … node:sqlite`, porque `builtinModules` lista `node:sqlite` **con el
   prefijo** recién en 24, y `config/packaged-runtime-node-modules.cjs` construye su allowlist desde
   ahí. El import es real y viene de `src/main/browser/browser-cookie-import.ts`.
   ⚠️ **`builtinModules.includes('sqlite')` da `false` en ambas versiones.** Hay que chequear la
   cadena con prefijo o el diagnóstico sale invertido — me pasó y descarté la hipótesis correcta.
2. **El gate de glibc hay que saltearlo.** `afterPack` exige que los binarios nativos carguen en
   Ubuntu 20.04 (glibc 2.31) y esta máquina compila contra 2.42. Quedó condicionado a
   `ORCA_SKIP_GLIBC_FLOOR` como **cambio local sin commitear**. **No debe ir al PR upstream**, y el
   AppImage resultante **no es distribuible** a distros más viejas.
3. **El target `.deb` falla** (`fpm` sale 127) y da igual: el AppImage se genera antes.

Comando completo:
```
cd ~/Work/orca-fork && PATH="$HOME/Work/.toolchain/node-v24.19.0-linux-x64/bin:$PATH" \
  ORCA_SKIP_GLIBC_FLOOR=1 pnpm run build:linux
```

### Contrapartida asumida

El fork sale de `main`, que va detrás del canal de release: el binario propio quedó en
**1.4.178-rc.2** contra la **1.4.180** oficial. Se recupera rebasando. Respaldos en `~/Descargas`:
`orca-linux-1.4.180-SIN-FIX.AppImage` y `orca-linux-ORIGINAL.AppImage`.

**El PR upstream sigue sin enviarse**, por decisión explícita del usuario ("quiero seguir trabajando
antes"). Mientras no entre, **cada actualización vuelve a pisar el fix**.

---

## 5. Piezas nuevas en `.claude/` (ninguna commiteada)

| Archivo | Qué hace | Estado |
|---|---|---|
| `scripts/verificar-fix-orca.sh` | Desempaca el `app.asar` del mount vivo y cuenta `forgetTerminalHandle` (7 = con fix, 0 = pisado), con `removeTeamForLeaderHandle` como control de sanidad. Sale 0/1/2 | ✅ **probado en vivo, en rojo y en verde** |
| `scripts/esperar-subagente.sh` (406 líneas) | Espera con las **guardas de identidad de Herdr**: verifica el emisor del `worker_done`, **relee el dispatch autoritativo** en vez de confiar en el evento, y distingue por código de salida terminado / sigue-vivo / abandonado | ⚠️ probado con stub en 5 caminos, **nunca contra un `worker_done` real** |
| `hooks/registrar-actividad-agente.sh` | Estampa actividad **derivada de tool calls** (un hecho) en vez de estado declarado por el modelo (que se olvida). 7-10 ms medidos, escritura atómica, a prueba de payload basura y de path traversal | ✅ funcionando; **contrato roto, ver §7** |
| `hooks/sondear-eventos-ciclo-vida.sh` | **TEMPORAL.** Registra qué eventos disparan y con qué payload | ✅ dio resultados, ver §6 |
| `scripts/enganchar-subagente-orquestacion.sh` | Mejorado: idempotencia por columna exacta, `stderr` real de los comandos (antes se descartaba con `2>/dev/null`), y recuperación cuando `task-create` responde `run_required` pese al `run-use` previo | ✅ |

**Lo que se trajo de Herdr fue una sola pieza**, de `src/api/wait.rs`: releer el estado autoritativo
ante cualquier evento en vez de creerle al payload, y verificar identidad antes de aceptar un match.
Nada de código; el diseño descrito en prosa, para mantener limpia la opción de upstreamear.

**Lo que NO se trajo, y por qué:** la detección de estado de Herdr para Claude Code es 100%
heurística (screen-scraping del título OSC contra un manifiesto TOML), su hook de Claude Code sólo
maneja la acción `session` y llama únicamente `pane.report_agent_session` — verificado en su código.
Acumula cuatro issues abiertos con nuestro mismo síntoma (#2241, #1630, #1217, #1653). Portar eso
sería portar un fracaso mejor instrumentado.

---

## 6. Sondeo de eventos del ciclo de vida (con panes reales)

Ejecutado desde una sesión dentro de Orca, con pane real confirmado por `orca terminal list`.

**Dispara:** `TeammateIdle` y `SubagentStop`.
**No dispara nunca:** `TaskCreated`, `TaskCompleted` (cero apariciones), y `SubagentStart` (ya
sabido).

| Evento | Cuándo | Payload útil |
|---|---|---|
| `TeammateIdle` | Al **cerrar el turno visible**. En la prueba, desfase **cero** con el fin del trabajo | `teammate_name`, `team_name`, `session_id`, `agent_type`, `transcript_path` |
| `SubagentStop` | **218 s tarde**, colgado del evento de inactividad (`away_summary`), no del fin del trabajo | `agent_id`, **`last_assistant_message`** (el reporte final completo), `agent_transcript_path` |

### El hallazgo mayor: el desfase es de entrega, no de emisión

El `TeammateIdle` se emitió a las 19:24:18, **exactamente** cuando el subagente escribió su reporte
final, y el hook lo estampó en disco al instante. Los ~60 s que veníamos midiendo son de
**entrega**: la notificación del harness espera al límite de turno del coordinador.

**Consultar el disco en lugar de esperar la notificación elimina el desfase entero.** Es justo el
patrón que se copió de Herdr, y ahora tiene una fuente inmediata de la que leer.

### Lo que el sondeo NO probó

El subagente resolvió todo **en un solo turno**, así que no se pudo separar "cerró un turno" de
"terminó el trabajo". Con un subagente multi-turno, `TeammateIdle` va a disparar en cada cierre y el
falso `idle` reaparece. **Medir eso es requisito antes de confiar en `TeammateIdle` como fin.**

### Anomalías registradas, sin explicación

- Hubo **4 `SubagentStop`**, dos de ellos de la sesión coordinadora de la Terminal (`ec139b74`), que
  no había lanzado subagentes en esa ventana.
- **Un registro trajo `TMUX=/tmp/orca-claude-agent-teams/team-1727d1` y `TMUX_PANE=%1`** — y fue el
  del coordinador, no el del subagente. Contradice la nota de `CLAUDE.md` que dice que dentro del
  pane `$TMUX` viene vacío. No apoyarse en esa variable sin más casos.

### Lectura operativa

Ninguno de los dos eventos significa "terminó el trabajo". `worker_done` sigue siendo el único fin
verificable. Pero **`TeammateIdle` es un disparador barato e inmediato para ir a consultarlo**, y
**`SubagentStop` es el detector de abandonado** —con el reporte final en el payload— que es
exactamente el agujero que hoy no cubre nadie.

---

## 7. Estado reanudable: qué queda abierto

### 🔴 1. La brecha del contrato — bloquea la guarda de actividad

`registrar-actividad-agente.sh` nombra sus archivos por **`session_id`**; `esperar-subagente.sh` los
busca por **`agent_id`**. **Nunca se encuentran, así que la guarda contra el falso `idle` hoy no
protege nada.**

El motivo por el que quedó así es un hallazgo real y va contra la documentación oficial: se observó
en vivo que **un mismo `session_id` produjo tres `agent_id` nativos distintos en seis tool calls del
mismo turno**. La doc dice que `agent_id` es estable por subagente; con panes, no lo fue.

**La solución la destapó el sondeo:** `TeammateIdle` trae `teammate_name` **y** el `session_id` del
subagente en el mismo payload. Ese es el puente. El hook de sondeo puede convertirse en el que
escribe el alias, y el wrapper encuentra el estado sin inventar nada.

### 2. Medir `TeammateIdle` con un subagente multi-turno

Requisito antes de confiar en él (§6). El hook de sondeo **quedó instalado a propósito** para que
acumule datos solo; hay que **desengancharlo y borrarlo** cuando el sondeo concluya — no es
infraestructura permanente.

### 3. Probar `esperar-subagente.sh` contra un `worker_done` real

Nunca se ejecutó contra la orquestación viva, sólo con un stub.

### 4. El PR upstream

Preparado desde el 10/08 y sin enviar. Es lo único que haría que el fix deje de perderse en cada
actualización. Además funciona como **sonda barata**: cuánto tardan en responder decide si vale la
pena invertir sesiones en aportes de fondo.

### 5. Repetir la medición de productividad

Con 2-3 semanas de ventana, que es lo que falta para que la pregunta original tenga respuesta.

---

## Nada de esto está commiteado

Ni las piezas de `.claude/` (config del entorno de agentes) ni esta documentación. El fork de Orca
sí tiene sus dos commits, en su propio repo, y respaldados como parches.
