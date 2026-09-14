# Auditoría de feat/agent-teams-windows — 2026-09-13

## Dictamen

**No aprobar todavía como soporte completo de Claude Agent Teams en Windows.** La integración abre panes en Windows Server 2022 con un Claude simulado, pero hay un defecto reproducido que pierde la identidad del teammate después del respawn, discrepancias entre los caminos de lanzamiento y una validación insuficiente del producto instalado y del Claude real.

Auditoría sobre `/home/jot4dev/Work/orca-fork`, HEAD `bf36396cff2c5db5009babaf4c140d303e4cbed9`. No se modificó implementación ni se ejecutaron despliegues, workflows remotos o sesiones de Claude. Se preservó el cambio previo en `config/electron-builder.config.cjs` que permite omitir el control de glibc en Linux; no pertenece al soporte Windows.

## Qué construye la rama

Orca emula el subconjunto de tmux que Claude usa para administrar teammates. El líder recibe `TMUX`, `TMUX_PANE`, un identificador/token de team y un PATH que antepone el shim. En Windows, ese shim es una copia de `orca.exe` llamada `tmux.exe`: reconoce su nombre y ejecuta la CLI con `agent-teams-tmux`. La CLI llama al runtime; el dispatcher traduce operaciones tmux a panes de Orca.

El comando POSIX que Claude proporciona se tokeniza y transforma en PowerShell, con reglas distintas para PowerShell 5.1/7.0–7.2 y 7.3+. El placeholder `cat` se convierte en `Wait-Event`; `respawn-pane` crea un pane nuevo y cierra el provisional. El catálogo de Windows lanza directamente `claude --teammate-mode auto`.

La rama incluye además trabajo anterior de identidad de panes, limpieza de terminales, auto-attach a orquestación y un harness de Claude basado en scripts Unix. Estos componentes no equivalen a soporte Windows del harness completo. Respecto del merge-base de la referencia local `origin/main`, el diff abarca 69 archivos; el tramo Windows comienza después de `4ad968e105`.

## Evidencia comprobada

- Run de GitHub consultado por API y logs: [34734403880](https://github.com/jotit4/orca/actions/runs/34734403880), SHA `afad6a3770d587e4b34021545189517d300d6b60`. HEAD agrega solamente documentación respecto de ese SHA.
- Job Windows: typecheck, build y packaging exitosos; **120 tests passed, 2 skipped, 8 archivos**.
- E2E específicos: **3 passed**: RPC con pwsh, RPC con Windows PowerShell, menú Claude Agent Teams.
- Canary de UI del mismo run: **8 failed, 1 passed**; no bloqueó por `continue-on-error: true`. El estado global success no significa que todos los tests del workflow pasaron.
- Verificación focal local en Linux/Node 25.8.0: **7 archivos passed; 51 tests passed, 2 skipped**, 21.51 s. Incluyó pane-command, shim-env, service, tmux-compat, core CLI, detection y PTY exit leak. No se ejecutó suite completa ni un nuevo typecheck local.
- Reproducciones adicionales en memoria con las clases TypeScript reales, transpileModule y callbacks mínimos: pérdida de pane al respawn y fallback que conserva auto. No requirieron Windows ni cambios de código.

Comando focal ejecutado:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/claude-agent-teams-pane-command.test.ts \
  src/main/runtime/claude-agent-teams-shim-env.test.ts \
  src/main/runtime/claude-agent-teams-service.test.ts \
  src/shared/claude-agent-teams-tmux-compat.test.ts \
  src/cli/handlers/core.test.ts \
  src/main/ipc/tui-agent-detection-commands.test.ts \
  src/main/runtime/claude-agent-teams-pty-exit-leak.test.ts
```

## Hallazgos

### A1 — P1: respawn elimina el pane del registro del team

Referencias: `src/main/runtime/claude-agent-teams-tmux-dispatcher.ts:179`, `src/main/runtime/orca-runtime.ts:27141`, `src/main/runtime/claude-agent-teams-service.ts:102`.

`respawnPane` conserva una referencia al objeto pane, crea el reemplazo y llama a `api.closeTerminal(previousHandle)`. El runtime llama a `forgetTerminalHandle`, que elimina ese pane de `team.panes` y `paneOrder`. Después, el dispatcher modifica `pane.handle`, pero el objeto ya está fuera del registro. La aparición visual del reemplazo puede funcionar mientras falla su control por tmux.

Reproducción: servicio real, `paneShell: powershell`, splitTerminal devolviendo handles distintos y closeTerminal invocando `service.forgetTerminalHandle(handle)`, igual que el runtime. Resultado literal:

```text
split-window -h -P -- cat              -> stdout %2, exitCode 0
respawn-pane -k -t %2 -- claude ...     -> exitCode 0
list-panes -F #{pane_id}               -> %1 solamente
send-keys -t %2 hello                  -> tmux: unknown pane: %2, exitCode 1
kill-pane -t %2                        -> tmux: unknown pane: %2, exitCode 1
```

El test del servicio simula closeTerminal sin su efecto de limpieza; el E2E no llama a list-panes/send-keys/kill-pane después del respawn. Es una interacción del trabajo de limpieza anterior incluido en la rama, no un fallo exclusivo de PowerShell.

Corrección propuesta: tratar la sustitución de handle/identidad como una transición explícita, con rollback y protección frente al evento de salida del placeholder. No basta con reasignar un objeto ya eliminado. Probar también salida tardía, cierre fallido, dos respawns y dos teammates simultáneos.

### A2 — P1: el menú no aplica los gates de disponibilidad

Referencias: `src/main/ipc/pty.ts:6112`, `src/main/runtime/orca-runtime.ts:27439`, `src/main/runtime/claude-agent-teams-shim-env.ts:84`.

El camino de `terminal.create` usa `buildClaudeAgentTeamsLaunchPlan`, que comprueba shell y existencia de tmux.exe. El renderer detecta `--teammate-mode auto` y llama directamente a `prepareClaudeAgentTeamsLeaderForHandle`, que instala el shim y crea el team sin esos controles. El catálogo ahora hace accesible este camino en Windows.

Consecuencia: con cmd/Git Bash configurado, o launcher no disponible, el menú puede inyectar un entorno de team nativo inviable. La promesa documental de degradación a in-process no está implementada uniformemente. Evidencia por recorrido de código; no se ejecutó el menú con esas configuraciones en Windows durante esta auditoría.

Corrección propuesta: un único plan de lanzamiento consumido por RPC y renderer; resolver el shell efectivo del pane, contemplando overrides/runtime del proyecto, y devolver al caller comando, entorno y motivo de degradación.

### A3 — P2: el fallback no sustituye el modo solicitado

Referencias: `src/shared/claude-agent-teams-tmux-compat.ts:188`, `src/main/runtime/claude-agent-teams-shim-env.ts:93`.

`addClaudeTeammateModeInProcess` devuelve el comando intacto si ya contiene cualquier `--teammate-mode`. Reproducción con `command: 'claude --teammate-mode auto'`, modo nativo y shell cmd:

```json
{"command":"claude --teammate-mode auto","env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"},"fallbackReason":"pane-shell-unsupported"}
```

El log afirma in-process; el comando sigue en auto. Sin tmux heredado Claude podría degradar por su cuenta, pero no es una garantía del plan. Un modo explícito tmux tampoco se reemplaza. El fallback debería fijar in-process y limpiar variables nativas incompatibles.

### A4 — P2: el cambio de directorio pierde semántica

Referencia: `src/shared/claude-agent-teams-pane-command.ts:98`.

`cd 'C:\missing[1]' && claude` se transforma literalmente en `Set-Location 'C:\missing[1]'; & 'claude'`. El `;` permite continuar tras un error no terminante, a diferencia de `&&`. Además, el parámetro posicional Path interpreta comodines como corchetes: las comillas no equivalen a LiteralPath. Puede ejecutarse en el directorio anterior o uno diferente.

La transformación se reprodujo localmente; su ejecución Windows no se probó aquí. [Microsoft documenta Path y LiteralPath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-location?view=powershell-7.5). Propuesta: `Set-Location -LiteralPath ... -ErrorAction Stop` dentro de un bloque que aborte el lanzamiento completo si falla, con pruebas que demuestren que no se crea el proceso hijo.

### A5 — P2: existe todavía un gate win32 en launchConfig

Referencia: `src/main/runtime/orca-runtime.ts:25562`.

Al reconstruir `effectiveLaunchConfig.agentCommand`, `process.platform === 'win32'` sigue seleccionando `addClaudeTeammateModeInProcess`, aunque el plan haya elegido panes nativos. Con un comando simple sin flag y modo global native-panes-shim puede añadirse in-process. Los E2E usan auto explícito y el helper lo conserva, por lo que no ejercitan este caso. Hallazgo estático, pendiente de reproducción integrada con launchConfig/secuenciación.

### A6 — P2: el artefacto no está condicionado al E2E ni probado instalado

Referencias: `.github/workflows/fork-windows-build.yml:120` y `:135`; `tests/e2e/claude-agent-teams-windows-native-panes.spec.ts:159`.

Los jobs de build y E2E son independientes; el instalador se sube aunque el job E2E falle. La comprobación post-packaging verifica archivos, no instala ni abre el producto. El E2E usa Electron de desarrollo y reemplaza el ejecutable que hospeda la CLI por una copia de node.exe, además de inyectar rutas y un stub de orca-dev. Eso deja sin probar resolución automática del launcher instalado, ASAR/unpacked efectivo y ejecución de la CLI bajo el Electron distribuido.

Tres rutas de tests del workflow no existen: `claude-agent-teams-tmux-dispatcher.test.ts`, `preflight-agent-detection.test.ts` y `local-pty-provider-windows-shell-launch.test.ts`. Vitest ejecuta los filtros que sí coinciden; no exige que exista cada ruta pedida.

Propuesta: producir un candidato, probar ese mismo artefacto con el Electron empaquetado y sin overrides artificiales de launcher, y promoverlo como validado solamente después del gate. Verificar existencia del manifiesto de tests y conservar resultados también al pasar.

## Límites y riesgos adicionales

- El env de team no cruza el split del renderer (`orca-runtime.ts:27243`); el E2E deja explícitamente de exigirlo. No se ha demostrado con Claude real que sea innecesario para todos sus flujos o para el auto-attach del fork.
- El tokenizer convierte `claude ab` + barra invertida + salto de línea + `cd` en dos argumentos `ab`, `cd`; POSIX concatena a `abcd`. Reproducido. Debe preservar la semántica o rechazar la forma. No se demostró que Claude emita esa forma actualmente.
- El helper legacy devuelve cadena vacía para un argumento vacío. PowerShell legacy no garantiza preservarla; los E2E no incluyen argumentos vacíos. Tampoco ejecutan al teammate mediante el wrapper npm `claude.cmd`: usan node.exe directamente. No certificar npm como equivalente al binario nativo sin pruebas de cmd.exe. [Microsoft describe estas diferencias](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-7.5).
- Aumentar a 60 s el timeout del shim y 45 s el split no acota la espera en cola de splits simultáneos. Faltan pruebas de timeouts, cancelación y panes tardíos para evitar huérfanos. Riesgo estático, sin reproducción de timeout en esta auditoría.
- Comentarios y documentación aún muestran `--%`, aunque la implementación final usa ramas de PowerShell. Actualizarlos después de corregir y verificar.
- El updater está desactivado al compilar el workflow del fork. Debe comprobarse en el artefacto instalado y existir un procedimiento de actualización del fork; los fixes futuros de upstream no llegarán automáticamente.

## Cómo cerrar la aceptación de Windows

1. Corregir A1 y convertir la secuencia reproducida en regresión: después de respawn deben funcionar listado, captura, envío y cierre con el mismo ID; el runtime debe ejecutar su limpieza real.
2. Unificar planes y corregir A2/A3/A5. Matriz de menú/RPC, auto explícito/modo global, PS 5.1/PS 7, shell no soportado, shim ausente y perfil existente.
3. Corregir A4 y probar rutas con espacios, apóstrofes, Unicode, corchetes, directorio inexistente y acceso denegado. Probar argv vacío, comillas, barra final, metacaracteres y wrapper npm por separado.
4. Extender E2E Windows: dos teammates simultáneos, control posterior al respawn, cierre manual, recreación, liderazgo intacto y ausencia de panes huérfanos. No limitar la aserción al segundo pane visible.
5. Instalar el candidato en Windows 10/11 de escritorio y abrirlo desde su instalación real; verificar perfil nuevo y actualización sobre perfil existente. Ejecutar primero el protocolo determinista usando la CLI empaquetada real.
6. Validar Claude Code nativo real y autenticado en sesión interactiva, registrando versión y hash del instalador: dos teammates con nombres, respuesta identificable al líder, segundo mensaje al mismo teammate, trabajo nuevo, cierre y creación posterior. No usar `claude -p` como sustituto: la documentación vigente indica que no crea teammates. [Contrato oficial de Agent Teams](https://code.claude.com/docs/en/agent-teams).
7. Mantener fixture/protocolo ligado a la versión de Claude probada y repetir la aceptación al actualizarla. La existencia de un shim que anuncia tmux 3.4 no garantiza compatibilidad con cualquier versión futura.

Las PRs upstream [15753](https://github.com/stablyai/orca/pull/15753) y [16116](https://github.com/stablyai/orca/pull/16116) seguían abiertas y sin merge al consultarlas durante esta auditoría. No conviene esperar su merge para resolver A1–A6; tampoco asumir que se pueden aplicar sobre este fork sin revisar compatibilidad.
