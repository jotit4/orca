# Harness de Claude Code para Orca

Todo lo que hace falta, además del binario de Orca de este fork, para reproducir el entorno de trabajo
"orquestador supervisado" con Claude Code dentro de Orca: hooks, scripts, skills, manifiesto de gates,
reglas de permisos y la documentación de cómo se llegó a cada pieza. Vive en el fork porque varias
piezas son **workarounds de defectos de Orca** y cambian con cada fix de `src/`: cuando un fix entra,
el script que lo rodeaba se borra de acá en el mismo commit.

`src/` contiene lo que va a upstream; `harness/` contiene lo que no. Los commits de `harness/` nunca
se incluyen en un PR a `stablyai/orca`.

## Instalar en un proyecto

```bash
harness/claude-code/instalar.sh /ruta/absoluta/al/proyecto
```

Copia a `<proyecto>/.claude/` y reemplaza el marcador `__PROYECTO__` por la ruta real. Mezcla la
sección `hooks` en `settings.json` y las reglas `permissions.deny` en `settings.local.json`. La
instalación es la copia; **la fuente es este directorio**: editar acá, reinstalar, y el usuario decide
qué commitear en el proyecto.

## Piezas

| pieza | qué resuelve | se borra cuando… |
|---|---|---|
| `scripts/enganchar-subagente-orquestacion.sh` | engancha el pane hijo del `Agent` tool a `orca orchestration` con `worker-start --terminal`, reintentando mientras Orca no reconoce al agente; registra el handle aunque falle y cierra la task como `failed/unhooked` | Orca cree el Dispatch al nacer el pane (fix 2) |
| `scripts/entregar-buzon-orca.sh` | lee y ackea el buzón en cada turno (worker_done, ask, heartbeat), alimenta `estado.json` y corre el vigilante de abandonados | Orca notifique al coordinador y marque `stale` sola (fix 3) |
| `scripts/orquestacion-estado.py` | único escritor de `/tmp/waengine-orquestacion/<session>/estado.json`: fase durable ≠ estado de turno, enum cerrado de cierre | — (política nuestra) |
| `scripts/gate.sh`, `gates.manifest`, `scripts/verificar-gates.sh` | cada gate deja marker; el verificador distingue corrió-ok / corrió-falló / no-corrió usando el transcript como referencia | — (política nuestra) |
| `scripts/verificar-fix-orca.sh` | comprueba que el AppImage en ejecución tiene los fixes del fork | los fixes entren upstream |
| `scripts/verificar-perfiles-shell.sh` | detecta `source` rotos en `~/.bashrc` y compañía (un instalador efímero los dejó y rompió todos los panes) | — |
| `scripts/esperar-subagente.sh` | `check --wait` con guardas de identidad (releer estado autoritativo, verificar emisor) | — |
| `hooks/frenar-comandos-destructivos.py` | PreToolUse: operaciones destructivas de git sobre el árbol del usuario, matanza de procesos por patrón amplio, borrado de sockets | — |
| `hooks/registrar-actividad-agente.sh`, `hooks/sondear-eventos-ciclo-vida.sh` | trazas de actividad y de qué eventos del ciclo de vida disparan de verdad | — |
| `skills/` | `entorno-orca`, `orquestar-subagentes`, `verificar-subagente` | — |
| `settings/` | la sección `hooks` y las reglas `deny` | — |
| `docs/` | la crónica: evaluación de Orca y alternativas, mensajería desincronizada y su mecanismo, diseño del protocolo v2 y la evaluación de deepseek-harness/deer-flow que lo originó | — |

## Gates manuales

`verificar-fix-orca` y `verificar-perfiles-shell` no tienen disparador automático: hay que correrlos
**a través de `gate.sh`** para que el verificador los cuente (tolerancia 24 h):

```bash
bash .claude/scripts/gate.sh verificar-fix-orca -- bash .claude/scripts/verificar-fix-orca.sh
bash .claude/scripts/gate.sh verificar-perfiles-shell -- bash .claude/scripts/verificar-perfiles-shell.sh
```

## Estado y logs en tiempo de ejecución

`/tmp/waengine-orquestacion/<session>/estado.json`, `enganche.log`, `_gates/*.ran`;
`~/.local/state/waengine-orquestacion/buzon-<session>.log`.
