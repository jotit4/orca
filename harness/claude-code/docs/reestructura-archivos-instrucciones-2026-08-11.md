---
titulo: "Reestructura de los archivos de instrucciones — estado vivo"
fecha: "2026-08-11"
sistema: "agentes-harness"
tipo: "decision"
estado: "historico"
tags: [agentes-harness, retoma]
inventariado: "2026-08-21"
---

# Reestructura de los archivos de instrucciones — estado vivo

Abierto 2026-08-11. Actualizar **en cada transición de fase**, no al final.

## Por qué

Auditoría de `CLAUDE.md`, `AGENTS.md` y `MEMORY.md` contra las buenas prácticas oficiales
(`code.claude.com/docs/en/memory`, `platform.claude.com/.../agent-skills/best-practices`, blog
*Steering Claude Code*). Hallazgos que la motivan:

1. **`AGENTS.md` nunca se carga.** "Claude Code reads `CLAUDE.md`, not `AGENTS.md`". Confirmado en
   vivo: no aparece en el contexto de sesión. `CLAUDE.md` delega en él la mecánica del repo
   (estructura multi-repo, comandos de test, reglas de VPS/Supabase/datos reales) → esa mecánica
   **no está en contexto** al arrancar.
2. **`CLAUDE.md` mide 333 líneas / 22.9 KB.** El objetivo oficial es <200; más largo reduce la
   adherencia. Importar `AGENTS.md` sin podar lo llevaría a 443.
3. **`MEMORY.md` está al 68% del corte de carga** (16.9 KB de 25 KB; el límite es 200 líneas o
   25 KB, lo que llegue primero). Al pasarlo, lo que sobra se descarta **en silencio**, empezando
   por el final: Incidentes y el índice de referencias. 235 archivos en memoria, ~90 sin puntero.
4. **Contradicción entre archivos** sobre qué se commitea: `CLAUDE.md` dice que la config del
   entorno de agentes no se commitea ("`CLAUDE.md` el primero"); `AGENTS.md` dice explícitamente lo
   contrario para `AGENTS.md`, `.claude/agents/` y `.claude/commands/`. Hoy duerme porque
   `AGENTS.md` no carga; al importarlo, se despierta.
5. **Contenido en el archivo equivocado**: prohibiciones duras como texto (van a hook), rituales
   procedurales (van a skill), reglas de un área (van a `.claude/rules/` con `paths:`),
   preferencias personales (van a `~/.claude/CLAUDE.md`).

## Orden: de aditivo a destructivo

`CLAUDE.md` se poda **al final**, cuando su contenido ya viva en otro lado. Al revés se pierde.

| # | Fase | Estado |
|---|------|--------|
| 1 | Hook `PreToolUse` que hace cumplir las prohibiciones rojas | ✅ **hecha y verificada** |
| 2 | `.claude/rules/` path-scoped (agent-service, frontend, supabase) | ✅ **hecha**, carga sin confirmar |
| 3 | Skills para los rituales (cierre de sesión, orquestación, navegador) | ✅ **hecha** |
| 4 | `~/.claude/CLAUDE.md` con las preferencias personales del usuario | pendiente |
| 5 | Reescribir `CLAUDE.md` <200 líneas con `@AGENTS.md` + resolver la contradicción | pendiente |
| 6 | Reindexar `MEMORY.md` a una línea por entrada | pendiente |

## Fase 1 — hecha (2026-08-11)

`.claude/hooks/frenar-comandos-destructivos.py`, registrado en `.claude/settings.json` como
`PreToolUse` con matcher `Bash`.

**Qué resuelve.** Las reglas `deny` de `.claude/settings.local.json` matchean por **prefijo**, así
que `cd sub && git stash` las esquiva — el propio `CLAUDE.md` lo admitía ("la regla la sostengo yo,
no el archivo"). El hook inspecciona el comando **completo**, en cualquier posición.

**Tres familias cubiertas:** destructivo sobre el árbol del usuario (`git stash`, `reset --hard`,
`checkout --force/-f`, `clean -f/-d`); sockets y procesos ajenos (`rm` sobre `/tmp/tmux-*`,
`/tmp/orca-*`, `$TMUX`; `tmux kill-server`; `pkill` sin `-F`; `killall`); escrituras en perfiles de
shell (redirección, `tee` o `sed -i` sobre `~/.bashrc`, `.profile`, `.bash_profile`, `.zshrc`,
`.zprofile`).

**Verificación.** Autotest embebido: `python3 .claude/hooks/frenar-comandos-destructivos.py --test`
→ **26/26 casos**, con lecturas inocuas permitidas (`git stash list`, `git clean -n`, `cat
~/.bashrc`, `pkill -F <pidfile>`). Probado end-to-end con el JSON del harness (deny / passthrough /
tool no-Bash / stdin ilegible) y **bloqueando en vivo**: `echo "git stash"` devolvió el deny con su
alternativa.

**Dos cosas encontradas al construirlo**, ambas arregladas:
- `\b-F\b` no matchea en `pkill -F` (entre espacio y `-` no hay frontera de palabra) → `\s-F(?!\w)`.
  Lo cazó el autotest; sin baseline habría pasado como verde.
- `${CLAUDE_PROJECT_DIR}` **no expande dentro de comillas simples** y la ruta del repo tiene
  espacios → comillas dobles en el `command` de `settings.json`.

**Trade-off asumido:** el hook matchea el texto del comando, así que frena también menciones
inocuas (`echo "git stash"`). Preferible a un falso negativo destructivo.

**Fail-open:** ante error interno o entrada ilegible sale 0 y se hace a un lado; un hook roto que
bloquee todo `Bash` es peor que el riesgo que cubre.

## Contradicción sobre qué se commitea — RESUELTA (2026-08-11)

El usuario aclaró que su preocupación no es el acto de commitear sino que **su config personal
termine en un repo**. Verificado contra git: `.claude/settings.local.json` (con `service_role_key` y
tokens) **no está trackeado** y figura en `.gitignore` con ese motivo escrito; el remote es
`innovateai2025/AI-Host-ERP-v1`, repo **privado**. Trackeados hay 17 archivos: 4 subagentes, 10
slash commands, 2 scripts, `settings.json`, `CLAUDE.md` y `AGENTS.md` — ninguno con secretos.

**Criterio que reemplaza a las dos reglas en conflicto:**

- **Config de proyecto** (`AGENTS.md`, `.claude/agents/`, `commands/`, `scripts/`, `hooks/`,
  `rules/`, `skills/`, `settings.json`) → **se commitea**. Es lo que hace que el próximo agente
  arranque sabiendo dónde está parado.
- **Secretos y config de máquina** (`settings.local.json`) → gitignored. Ya lo está.
- **Preferencias personales del usuario** → `~/.claude/CLAUDE.md`, fuera del árbol. No se puede
  commitear ni queriendo. Es la fase 4.

Lo único personal que hoy viaja al repo está **dentro** de `CLAUDE.md` (jornada, cómo reportar, cómo
decide); sale en la fase 4. La regla "`CLAUDE.md` no se commitea" queda sin objeto.

## Fase 2 — hecha (2026-08-11)

Cuatro reglas path-scoped en `.claude/rules/`, todas bajo 50 líneas:

| Archivo | `paths` | Contenido |
|---|---|---|
| `agent-service.md` | `packages/agent-service/**` | repo git separado, suite offline, `guards/nodes/config` ⇒ suite completa, `conversations/` no es semáforo, timeouts acoplados, modelo real `gpt-4.1-mini`, trampa del `AGENT_FAILURE` mudo |
| `frontend.md` | `src/**`, `admin-console/**`, `packages/waengine-os/apps/frontend/**` | verificar render en el navegador embebido, refs `@eN` se invalidan, typecheck aparte del build, gate de `org_id` en server actions |
| `datos-y-supabase.md` | `supabase/**`, `**/*.sql` | datos reales intocables, MCP self-hosted siempre, esquema híbrido de 3 generaciones, edge functions sin auto-deploy |
| `waengine-os.md` | `packages/waengine-os/**` | `Bun.which` devuelve el shim, resolver por PATH/ruta absoluta, no tocar sockets ajenos |

**Verificado:** frontmatter YAML válido en las 4 y **todos los globs matchean archivos reales**
(883 / 178+283 / 155+100+130 / 210). Sin braces, así que no consumen el budget de expansión.

⚠️ **Sin verificar:** que la regla efectivamente **entre en contexto** al leer un archivo que
matchea. Leí `packages/agent-service/pyproject.toml` y no observé la inyección desde adentro; puede
ser que las reglas se descubran al arrancar sesión, o que no sea observable para mí. Formas de
confirmarlo: correr `/context` en una sesión nueva y mirar **Memory files**, o montar el hook
`InstructionsLoaded`, que loguea qué instrucciones se cargan y por qué.

El solapamiento entre `frontend.md` y `waengine-os.md` en `packages/waengine-os/apps/frontend/**` es
intencional: ahí aplican las dos.

## Fase 3 — hecha (2026-08-11)

### Criterio de reparto (corregido a pedido del usuario)

La orquestación **no tiene un path que la gatille**, a diferencia de las reglas de área. Mandarla
entera a un skill on-demand arriesga tomar la decisión equivocada *antes* de que algo recuerde que
el skill existe. Criterio final:

> **Si olvidarlo cambia una decisión que se toma ANTES de invocar el skill, se queda en
> `CLAUDE.md`. Si es el "cómo" de algo que ya se decidió hacer, va a skill.**

Gatillos que se quedan en `CLAUDE.md` (fase 5): que el trabajo ocurre dentro de Orca; que los
subagentes se lanzan **siempre** con el `Agent` tool y nunca con `orca terminal create`; que `idle`
NO es "terminó"; que el canal confiable es `orca orchestration`; subagentes en **Sonnet**; nunca dos
agentes sobre el mismo archivo; los panes los cierra el usuario; `orca` fuera de la terminal de Orca
es el lector de pantalla.

### Skills creados

| Skill | Contenido |
|---|---|
| `orquestar-subagentes` | Protocolo completo con checklist: prompt inicial (reglas duras + contrato de worker + `AskUserQuestion` prohibido), lanzamiento con `Agent`, verificación del enganche vía hook `PostToolUse`, detección de degradación a in-process, espera del `worker_done`, modelo Run/Task/Dispatch, liberación con `worker-release`, agente abandonado, mensajería, `--interrupt`, fragilidad de panes, cuándo NO orquestar |
| `entorno-orca` | Sólo los gotchas de esta máquina: `orca` vs `orca-ide` y el PATH, computer-use (índices que caducan, el error de python3-gi que miente, wrapper en `~/.local/bin/python3`), estado del worktree, prohibición sobre perfiles de shell |

**No se duplicó nada que ya existiera**: el ritual de cierre ya está en `/cerrar-sesion` (28 líneas)
y la apertura en `/nueva-sesion` (31); el bucle del navegador embebido quedó en `frontend.md` de la
fase 2. En la fase 5, esas secciones de `CLAUDE.md` se podan a un puntero.

**Verificado:** frontmatter válido en los 3 skills, `name` dentro de las reglas (minúsculas, sin
palabras reservadas), `description + when_to_use` bajo el corte de 1.536 caracteres en los tres
(466 / 532 / 460), cuerpos bajo 500 líneas. Los tres aparecen cargados en la sesión, así que la
detección de cambios en vivo funciona para skills.

### Skills de Orca: referenciadas, no duplicadas

`orca skills list` devuelve 8: `orca-cli`, `orchestration`, `computer-use`, `orca-per-workspace-env`,
`orca-linear`, `linear-tickets`, `orca-emulator`, `orca-emulator-android`. **Tres de ellas
(`orca-emulator`, `orca-emulator-android`, `linear-tickets`) no están cargadas en la sesión de
Claude Code** — sólo accesibles vía `orca skills get <nombre>`.

`entorno-orca` apunta a las genéricas en vez de reescribirlas, y recuerda que la guía versionada la
sirve el binario con `orca skills get orca-cli`.

### Qué aportó la documentación de Orca

La doc de Orca **no opina sobre `CLAUDE.md`/`AGENTS.md`/reglas**: es agnóstica al agente (corre
Claude Code, Codex, Cursor CLI en paralelo), así que esa capa es enteramente de Claude Code. No hay
mejores prácticas de Orca que aplicar a esos archivos.

Lo que sí aportó, y se incorporó a `orquestar-subagentes` desde `/docs/cli/orchestration`:

1. **El modelo formal** Run / Task / Dispatch / Message / Decision gate con sus estados, y que *"la
   autoridad de completitud viene del dispatch activo"* — respalda con vocabulario propio la regla
   de que `idle` no es "terminó".
2. **El contrato del worker**, que ahora va en el prompt inicial: `worker_done` exactamente una vez
   con `--outcome`, incluyendo `taskId` **y** `dispatchId`, resumen y archivos modificados;
   `heartbeat` en trabajo largo; `ask` para preguntas bloqueantes.
3. **`worker-release` + `worker-read`** como forma correcta de liberar un worker terminado, y
   respetar `release_pending`/`release_unknown` sin forzar. Coincide con la regla del usuario: la
   doc también desaconseja `terminal close` genérico.

También: `worker-start` es para trabajo con seguimiento por ID; para un prompt liviano alcanza
`orca terminal send`.

## Evals — primera corrida (2026-08-11)

`.claude/evals/` con 9 escenarios derivados de incidentes reales + `correr-evals.py`, que mide
baseline (sandbox sin nada) contra con-skill y juzga contra `expected_behavior`.

| skill | baseline | con skill | delta | ¿señal válida? |
|---|---|---|---|---|
| `entorno-orca` | 2/14 | 6/14 | **+4** | ✅ sí |
| `verificar-subagente` | 3/14 | 6/14 | **+3** | ⚠️ parcial |
| `orquestar-subagentes` | 2/15 | 0/15 | **−2** | ❌ no, corrida inválida |

### Por qué `orquestar-subagentes` no midió nada

Sus tres escenarios son **situados**: presuponen un estado —un subagente corriendo— que el sandbox
vacío no tiene. Verificado leyendo la respuesta de `os-3`: el sujeto contestó *"no encuentro ningún
subagente en curso… `TaskList` vacío… no lancé ningún subagente en esta conversación"*. Respondió
bien a la realidad que veía; el escenario era el que no existía.

Se suman dos defectos propios:

1. **`os-1` es imposible por construcción**: le pido lanzar subagentes después de prohibirle `Agent`
   y `Task` en la lista de herramientas vedadas.
2. **El sandbox no aísla del entorno**: el sujeto vio por `ListAgents` dos sesiones reales
   (`la-cabrera-sistema-dc`, `la-cabrera-sistema-28`). El aislamiento es de directorio, no de
   entorno.

`entorno-orca` midió bien porque sus escenarios son **de conocimiento** ("cómo arreglo este error"),
no requieren estado. Es la distinción que hay que respetar al rediseñar: para escenarios situados
hace falta un fixture que monte el estado, o convertirlos en preguntas de conocimiento.

### La señal válida, y es mala para el skill

`entorno-orca` mejora en total, pero desagregado muestra que **no previene los dos incidentes más
caros**:

- `eo-2` (anteponer `/usr/bin` arranca el lector de pantalla): **1/4 → 1/4, sin mejora.** El skill
  no logra que se advierta sobre `/usr/bin/orca` ni que se generalice la regla.
- `eo-3` (instalador que rompe los perfiles de shell): **0/5 → 1/5.** Sólo consigue que no corra el
  instalador; no logra que proponga `--no-modify-path` ni que exporte en su propio comando.
- `eo-1` (el error que miente sobre `python3-gi`): 1/5 → **4/5.** Acá sí funciona, y es el único.

O sea: sin evals habría dado por bueno un skill que falla justo donde más caro sale. Ese es el
retorno del ejercicio.

### Pendiente de esta fase

Rediseñar los escenarios situados (fixture o reconversión), arreglar `os-1`, y reescribir las
secciones de `eo-2`/`eo-3` en imperativo más directo. Recién después, fases 4 y 5.

## Decisión pendiente antes de la fase 5

El reparto línea por línea de `CLAUDE.md` (qué queda, qué va a `rules/`, qué a skill, qué a user
scope) tiene que verlo el usuario antes de tocar el archivo: es el que define cómo trabajo.

## Sin tocar todavía

`AGENTS.md` (110 líneas, bien dimensionado — el problema es que nadie lo lee), `MEMORY.md`, y los
4 subagentes de `.claude/agents/`.
