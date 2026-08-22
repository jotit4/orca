# Evaluación: deepseek-harness y deer-flow frente a Orca — 22/08/2026

**Pregunta del usuario:** ¿aportan algo para nuestro entorno (Claude Code dentro de Orca)? ¿Hay que buscar
alternativa a Orca? (Herdr ya evaluado el 11/08 como multiplexor, no como ADE.)

**Respuesta corta:** ninguno de los dos compite con Orca; son *harnesses de agente* (categoría Claude
Code / Codex), no entornos de desarrollo agéntico. Lo que aportan es de diseño: ambos resolvieron con
datos verificables los tres dolores que nosotros sostenemos en prosa dentro de `CLAUDE.md`
("idle no es terminó", buzón sin acuse, gate que no corre = verde). Eso dio origen al
[protocolo v2 de orquestación](protocolo-orquestacion-v2-diseno-2026-08-22.md).

## Método

Dos subagentes Sonnet en panes de Orca, uno por repo, con el marco de nuestros dolores en el prompt.
Cada afirmación sobre archivos se verificó después contra GitHub (raw, rama `master` en
deepseek-harness y `main` en deer-flow). Herdr se refrescó por API y release notes.

Incidente de método, relevante para el protocolo: el enganche automático de los dos subagentes **falló**
(`dispatch --inject` corrió 3 s después del spawn, antes de que Claude arrancara en el pane:
"no recognized agent detected"), ninguno mandó `worker_done`, el informe de deer-flow se envió por
`SendMessage` y nunca llegó al coordinador. Ambos informes se recuperaron del transcript en disco
(`~/.claude/projects/<proyecto>/<session>.jsonl`, bloque de texto o `tool_use` más largo).

## Estado por API (22/08/2026)

| repo | ★ | licencia | último push | issues | nota |
|---|---|---|---|---|---|
| deepseek-ai/deepseek-harness | 184.195 | MIT | 21/08 | 0 (deshabilitadas, usan Discussions) | 13.147 commits importados de GitLab interno el 13/08; dev desde 10/06; pre-1.0, rc cada 1-2 días |
| bytedance/deer-flow | 80.553 | MIT | 22/08 | 922 | v2.0.0 25/06 reescritura total; v1.x archivada en `main-1.x` |
| herdrdev/herdr | 31.529 (27.579 el 11/08) | Apache-2.0 | 22/08 | 228 | v0.8.2 19/08; incremental |

## Herdr, refrescado

v0.8.0→v0.8.2: Windows GA, detección de estado para Qwen Code, teclas/temas, marketplace de plugins.
Sigue sin worktrees, navegador embebido ni computer-use. Conclusión del 11/08 intacta. Dato: ahora
distingue cinco estados de agente (`blocked, working, done, idle, unknown`) — llegaron al mismo problema.

## Informe del subagente: deepseek-harness

## Informe: `deepseek-ai/deepseek-harness`

**Verificación de autenticidad primero, porque el hallazgo es contraintuitivo.** Vía API (`api.github.com/repos/deepseek-ai/deepseek-harness`), el repo es real, público, licencia MIT, 184.195 estrellas, 20.314 forks, `pushed_at` 2026-08-21. Los números de estrellas/forks para un repo con `created_at` 2026-08-13 parecen fabricados, pero no lo son: es un import de historia completa. El commit más antiguo (paginando `?per_page=1&page=13147`) es `b67e81ac`, 2026-06-10, "Initialize repo…", y hay 13.147 commits reales de contribuidores identificables (tianyicui 5268 commits, imccyu 1262, kermanx —conocido del ecosistema Vite/Rolldown/oxc— 547, etc.), más `.gitlab-ci.yml` residual: desarrollaron ~2 meses puertas adentro (GitLab interno) y volcaron todo a un repo GitHub nuevo el 13/08 al abrir el preview público. Las estrellas explotaron por el efecto de marca DeepSeek, no por manipulación. Dato de madurez: `has_issues: false` (usan Discussions, no Issues), `open_issues: 0`, 4 releases (`dsh-v0.1.1-rc.2` es la última, 21/08) — está en **developer preview activo**, con el propio README avisando "THERE WILL BE COMPATIBILITY-BREAKING CHANGES".

**1) Qué es.** No es un modelo ni un runtime de eval de benchmarks: es un **harness de agente de código de propósito general** (`dsh`), directo competidor/hermano de Claude Code, Codex CLI u OpenCode. Corre como `npx @deepseek-ai/dsh web` (UI web local) o `pnpm dsh --profile headless`. Piensa en DeepSeek-R1/V3 vía `DEEPSEEK_API_KEY`, pero el adaptador de modelo es un plugin más — el propio `docs/architecture.md` lista `llm-deepseek`, `llm-replay` (fixtures) como proveedores intercambiables sobre `ctx.llm`, así que no está atado a un solo proveedor. No confundir con otros repos deepseek-ai (modelos, DeepSeek-Coder, etc.): este es tooling de agente, escrito en TypeScript (25,9M líneas TS de 108MB de repo) con nativo Rust/C (`native/landlock-run`) y SDK Python (`python/sdk`).

**2) Arquitectura.** El framework base es **Cordis** (vendorizado en `vendor/`, diseño propio del autor documentado en un paper — "A Programming Paradigm for Spatiotemporal Composability"): un sistema de contexto de plugins donde *todo* —el adaptador de modelo, el registro de tools, el loop del agente, el log de sesión— es un plugin montado sobre un árbol compuesto en boot (`docs/architecture.md`, sección "Profiles and bundles"). No hay núcleo privilegiado que parchear; extender es montar un plugin al lado. El loop se modela como `turn` (cero o más `step`s) → `step` (una request de modelo + sus tool calls), con eventos tipados en tres dominios: **session events** (durables, van al log append-only, ej. `turn/start`, `tool/call`), **agent events** (`agent/*`, viven en memoria: inbox, status, pre-step) y **capability events** (`fs/*`, `tools/*`). Diagrama de secuencia completo en `docs/agent-lifecycle.md`. Regla de oro repetida en `AGENTS.md`: *"Model-visible ⟺ logged"* — todo lo que llega al modelo debe ser reconstruible desde el log, verificado por un runtime invariant, no por convención. Subagentes: seam en `packages/subagent/subagent` (`ctx.subagents`), con múltiples providers coexistiendo por nombre (`-spawn-in-process`, `-fork`, `-acp`, `-codex`, `-claude-code`) — literalmente tienen un backend que delega a Claude Code y otro a Codex como subagentes intercambiables. Distinguen **one-shot** subagents de **continuable background subagents** (`docs/subsystems/subagent.md`): un child continuable es una Session durable con a lo sumo una "Activation" residente, gestionada por un continuation manager separado del loop. Verificación: paquete `runtime-diagnostics/invariants` (ver punto 3).

**3) Ideas transferibles concretas.**

- **El gate que "no corre = queda en verde" tiene solución estructural en `packages/runtime-diagnostics/invariants`.** Cada paquete del monorepo *debe* publicar un companion `./invariant`; si no tiene nada que chequear, el installer debe quedar vacío pero con un comentario que empiece `No runtime invariant:` explicando por qué. `pnpm run verify-package-invariants` rechaza mecánicamente marcadores generados, installers vacíos sin esa explicación, y nombres de registro incorrectos (`docs/subsystems/invariants.md`). Aplicable directo a `waengine-os-staging` (el gate de evidencia que dejó de correr y nadie lo notó): en vez de confiar en que un gate "existe en algún script", exigir que cada componente crítico declare explícitamente su invariante o la razón documentada de por qué no aplica, y correr un verificador que falle si esa declaración falta o quedó huérfana.

- **El "idle no es terminó" está resuelto con separación de estado durable vs. derivado, no con mejor polling.** `TeamMemberSnapshot` (`docs/subsystems/agent-team.md`, `packages/experimental/agent-team/src/types.ts`) tiene una fase durable de ciclo de vida (`provisioning` → `active`|`failed`, terminal) que un status en vivo `running`/`idle`/`inactive` **nunca reescribe**. Es exactamente la distinción que a nosotros nos costó: un `idle` de Orca es señal de *disponibilidad de turno*, no de finalización del trabajo, pero hoy los mezclamos. El patrón transferible: modelar explícitamente dos campos separados —fase de vida del pane/subagente (nace, corre, termina) vs. estado de turno (procesando/esperando input)— y nunca dejar que el segundo sobreescriba al primero.

- **Mensajería con acuse de recibo real, no notificación best-effort.** `TeamMessageSnapshot` se guarda primero en el log durable del Lead; el "acuse" ocurre recién cuando el ítem llega al inbox pendiente o al mensaje de usuario grabado del *target*, y lo no entregado queda como "recovery mailbox" (queued-minus-delivered) reproducible tras un crash. Esto es literalmente el protocolo que a nosotros nos falta fuera de `orca orchestration`: un mensaje entre agentes no es "enviado" hasta que el registro en el lado receptor es durable, y el emisor puede recuperar exactamente lo que no llegó. Vale la pena comparar esto con nuestro mecanismo de `worker_done`/`heartbeat`/`ask` y ver si conviene absorber la idea de "recovery mailbox" explícito en vez de asumir entrega.

- **DAG de tareas con CAS y `writeScopes` advisory que detecta solapamiento — resuelve nuestro gate manual de "nunca dos agentes sobre el mismo archivo".** `TeamTaskSnapshot` tiene `revision` (compare-and-set, incrementa 1 por mutación), `blockedBy` (aristas que deben apuntar a tareas no borradas y mantener el grafo acíclico) y `writeScopes` (prefijos de path advisory, no locks reales, pero las vistas agregan "write-scope overlap warnings"). Hoy ese gate lo sostengo yo manualmente al armar prompts; acá está tipado como estructura de datos verificable. Sería razonable, sin adoptar su código, modelar el propio DAG de subagentes de una sesión larga (tipo la Ola de hardening) con esta forma: tarea con revisión, bloqueadores explícitos y scope de escritura declarado, y advertir automáticamente si dos tareas activas se pisan.

- **Interrupción sin perder el inbox.** `interrupt(caller, targetName)` corta el turno en curso de un teammate sin vaciar su cola pendiente — equivalente conceptual a nuestro `terminal send --interrupt`, pero con contrato explícito de que el estado de entrada sobrevive al corte.

**4) Qué no aporta.** Es un producto TypeScript/Node con su propio framework de plugins (Cordis) pensado para *reemplazar* el harness completo, no para insertarse en Orca+Claude Code. Adoptar código directamente implicaría absorber Cordis entero, su sistema de bundles/profiles y su pipeline de build (`tsdown`, `oxlint`, `knip`, `pnpm workspaces`), que no tiene sentido para nosotros: nosotros orquestamos *sobre* Claude Code, no reemplazamos el harness. El sandbox E2B (`packages/e2b`), el LSP seam, el motor de skills con catálogo (`packages/skill`) y el web client (`apps/web`) son features de producto sin equivalente en nuestro flujo de trabajo actual. Tampoco es útil como *benchmark* o *harness de evaluación* — pese al nombre, no evalúa modelos, ejecuta agentes.

**5) Hallazgo ajeno a nuestro entorno, interesante para la industria.** Que un bridge de compatibilidad ya trate a **Claude Code y Codex como backends de subagente de primera clase** (`packages/hooks/hooks-claude-code`, `hooks-codex`, `subagent-claude-code`, `subagent-codex`) — es decir, DeepSeek construyó su harness para poder *delegar turnos a Claude Code o Codex externos* y traducir sus hooks (`hooks.json`) al protocolo interno, en vez de competir de forma cerrada. Señala una convergencia real: los harnesses de agentes de código están empezando a tratarse entre sí como proveedores intercambiables de una misma interfaz de "subagent", no como productos aislados.

**6) Madurez.** MIT, sin deuda de dependencias pesadas fuera de lo esperable en un monorepo TS (pnpm workspaces, vitest, tsdown), 0 PRs abiertos y 0 issues abiertos al momento de mirar (usan Discussions, Issues deshabilitado), actividad diaria intensa (releases rc cada 1-2 días desde el 17/08). Es explícitamente pre-1.0 ("Remove this section at the first tagged release" en `AGENTS.md" sobre romper compatibilidad libremente) — no recomendable como dependencia de producción hoy, sí como referencia de diseño.

## Informe del subagente: deer-flow

**Fuentes**: GitHub API (`api.github.com/repos/bytedance/deer-flow`, releases, commits, issues), clon `--depth 1` en `/tmp/deer-flow-research` (scratchpad, fuera del repo del usuario), README.md, AGENTS.md/backend/AGENTS.md, docs/agents/, contracts/, y lectura directa de los módulos de `backend/packages/harness/deerflow/`.

## 1. Qué ES hoy y a quién apunta

DeerFlow **2.0** (release `v2.0.0`, 25/06/2026, "ground-up rewrite", 182 PRs mergeados) es un **harness de "super-agente" de largo horizonte**: orquesta subagentes, memoria persistente, sandboxes y skills extensibles para tareas de minutos a horas. Cita textual del repo: *"An open-source long-horizon SuperAgent harness that researches, codes, and creates."* Comparte cero código con la **v1.x** (deep research clásico sobre LangGraph, ahora archivada en la rama `main-1.x`); la 2.0 es un producto distinto, no una evolución incremental. Apunta a dos públicos: (a) developers que quieren un framework Python publicable (`deerflow-harness`, import `deerflow.*`) para construir su propio agente, y (b) equipos que quieren desplegar un **chatbot multicanal self-hosted** (Gateway FastAPI + frontend Next.js + bridges de mensajería) ya armado. El 28/02/2026 llegó al #1 de GitHub Trending tras el lanzamiento de v2.

## 2. Arquitectura

- **Loop/split**: `AGENTS.md` fija una frontera dura harness↔app (`packages/harness/deerflow/*` nunca importa `app/*`, verificado en CI por `test_harness_boundary.py`). Stack: FastAPI Gateway (runtime LangGraph embebido) + Next.js frontend + Nginx como único entry point + Provisioner opcional (K8s/Docker).
- **Subagentes** (`subagents/`): dos built-in (`general-purpose`, `bash`). Flujo `task()` tool → `SubagentExecutor` → thread pool → poll 5s → eventos SSE (`task_started/running/completed/failed/timed_out`). Concurrencia real gobernada por middleware (`SubagentLimitMiddleware`, `MAX_CONCURRENT_SUBAGENTS=3`, `max_total_per_run=6`) contra un **ledger de delegación durable** — no es una regla de prompt, trunca tool-calls de más incluso si el modelo insiste.
- **Sandbox** (`sandbox/`): interfaz abstracta (`execute_command/read_file/write_file/glob/grep`) con 3 providers — local (LRU por thread), Docker/AIO (con ownership leases cross-instance vía Redis, distinguiendo "quién reclama" de "quién puede usar"), y E2B remoto (pool warm, burst policy). `env_policy.py` scrubea env vars que parecen secretos antes de inyectarlas a un subproceso sandboxeado.
- **Memoria**: `memory_middleware.py` + `memory_config.py`, memoria durable por `thread_id`; los subagentes corren con `skip_memory_flush=True` para no contaminar la memoria del thread padre con sus turnos internos.
- **Skills** (`skills/public/`): paquetes curados (deep-research, code-documentation, chart/ppt/video/music/image-generation, github-deep-research, skill-creator) más un **skill-reviewer** con contrato formal versionado (`contracts/skill_review/*.schema.json`) que audita calidad de skills con payload "tag-neutralized".
- **Canales** (`backend/app/channels/`): Feishu, WeCom, WeChat, Telegram, Slack, Discord, DingTalk, GitHub y un canal "Buzz" (Nostr). **No hay WhatsApp/Evolution.** `Channel` es una ABC limpia (`base.py`, 393 líneas) sobre un `MessageBus` inbound/outbound — extensible pero habría que construir el canal desde cero.
- **UI/HITL**: `ask_clarification` (`tools/builtins/clarification_tool.py`) es una **interrupción estructural de LangGraph** (`return_direct=True` + `ClarificationMiddleware`, 498 líneas), no un prompt lateral: soporta formularios tipados (text/select/multi_select/checkbox/date), degrada a texto plano si excede límites (16 campos/24 opciones/200 chars), y en corridas programadas (`scheduler`) se excluye automáticamente del toolset para runs no interactivos.

## 3. Mecanismos transferibles (con archivo y patrón concreto)

- **Contrato de estado versionado y cross-language**: `contracts/subagent_status_contract.json` (v2) fija `valid_status_values=[completed,failed,cancelled,timed_out,polling_timed_out]` y `valid_stop_reason_values`, espejado en `subagents/status_contract.py` (Python) y `frontend/.../subtask-result.ts` (TS), pineado por tests (`test_status_values_match_contract`). Esto es exactamente el antídoto a nuestro "`idle` no es terminó": el estado es un enum cerrado y chequeado, no algo que se infiere del silencio.
- **Tres ejes de guardarraíl independientes** (turno/token/loop), cada uno exponiendo `consume_stop_reason(run_id)` recolectado por duck-typing en el executor: garantizan que un subagente **siempre** termina con una razón legible (`token_capped/turn_capped/loop_capped`) en vez de colgarse o desaparecer sin avisar — mapea directo a nuestro problema de "worker abandonado, nadie avisa".
- **Event log persistente por paso**: `runtime/runs/worker.py::_SubagentEventBuffer` persiste `subagent.start/step/end` al `RunEventStore`, consultable por `task_id` + cursor `after_seq` — un log replayable de cada subagente, más fuerte que nuestra mensajería sin acuse.
- **Gate de confianza×severidad para superficie pública**: `docs/agents/maintainer-orchestrator-design.md` describe un skill de triage que solo publica si confianza alta **Y** severidad ≥P2, y todo lo demás va a un canal privado para el maintainer. Es el mismo patrón que necesitamos para WAEngine OS: el agente diagnostica y lo que no cruza la barra queda en log interno, no llega al jefe no técnico.
- **Delegación a Claude Code vía ACP**: `config.example.yaml` (~línea 1506) documenta que el lead agent de DeerFlow puede delegar en la CLI `claude` real vía Agent Client Protocol (`claude-agent-acp` de Zed) como subagente especialista de código — plumbing a mirar si algún día queremos interop externo con otro orquestador.

## 4. Qué NO es / no compite con Orca

DeerFlow no tiene noción de worktrees, panes de terminal, ni computer-use sobre apps de escritorio; es un **chatbot multi-tenant servido** (un Gateway + un frontend web + bridges de IM), no un cockpit de desarrollo local. No compite con Orca como IDE/ADE — compite más bien con Manus, OpenAI deep research o plataformas de "asistente" self-hosted. Donde SÍ es más maduro que nuestro harness es en el contrato de ciclo de vida de subagentes (punto 3): eso es lo que vale la pena robar como *patrón*, no el producto entero.

## 5. Descubrimientos de industria

80.553 estrellas en ~15 meses de vida (creado 07/05/2025) y el salto a #1 de Trending tras pivotar de "deep research" a "harness de superagente" confirma que la industria OSS convergió en 2026 hacia la misma forma que Claude Code/Codex: subagentes + memoria + sandbox + skills empaquetables. El proyecto hermano **LLM Space** (bytedance, inspección/replay de pasos del harness) sugiere que la observabilidad de harness se está volviendo categoría de producto aparte — relevante si alguna vez queremos algo más dedicado que LangFuse para WAEngine OS. La convención de skills (`SKILL.md`-like, reviewer con schema formal) espeja directamente la convención de Skills de Claude — convergencia, no coincidencia.

## 6. Madurez

- **Licencia**: MIT.
- **Actividad**: 80.553 ⭐ / 11.060 forks / 922 issues abiertos / 337 watchers; commits el mismo día de hoy (22/08/2026), PRs mergeados con minutos de diferencia entre sí — cadencia de mantenimiento activa y sostenida por ByteDance, no un experimento abandonado.
- **Stack**: Python 3.12+/FastAPI/LangGraph (16.2MB, dominante) + Next.js 22+/TypeScript (2.75MB), Postgres (`persistence/postgres_schema.py` + migraciones), Redis (ownership de sandbox, stream bridge), Docker Compose + Helm chart para K8s, E2B opcional.
- **Modelos**: soporte de primera clase para **Anthropic/Claude** vía `langchain_anthropic:ChatAnthropic` (incluye extended thinking con `budget_tokens`, detector de rechazo `AnthropicRefusalDetector`), más OpenAI y Gemini. El README empuja fuerte los modelos propios de ByteDance (Doubao-Seed-2.0-Code, DeepSeek v3.2, Kimi 2.5) vía un banner de partnership comercial — es sesgo de default/marketing, no restricción técnica.

**Veredicto**: (b) es la respuesta — no compite con Orca, pero es una pieza de referencia útil para WAEngine OS: su contrato de estado de subagentes, sus tres ejes de guardarraíl y su gate confianza×severidad son patrones concretos y ya probados en producción a escala que podemos adaptar sin adoptar el proyecto.

## Verificación del orquestador

Todos los archivos citados existen y contienen lo afirmado. Citas literales comprobadas:

- `docs/subsystems/agent-team.md:24` — "Every member starts in `provisioning` and reaches exactly one
  terminal roster phase, `active` or `failed`. Runtime `running`/`idle`/`inactive` status is derived
  separately and never rewrites this record."
- `agent-team.md:28` — "A target receipt is acknowledged only after its pending inbox item or recorded
  user message is durable, leaving queued-minus-delivered as the recovery mailbox."
- `agent-team.md:57` — `revision` CAS, `blockedBy` acíclico, `writeScopes` advisory.
- `docs/subsystems/invariants.md:59` — installer vacío sólo con comentario `No runtime invariant:`;
  `pnpm run verify-package-invariants` rechaza los sin explicación.
- `AGENTS.md:108` — "Model-visible ⟺ logged".
- deer-flow `contracts/subagent_status_contract.json` v2 — enum de status y stop_reason tal cual.
