# Claude Agent Teams con paneles nativos en Windows (fork)

**Estado del candidato actual (2026-09-14):** estabilización implementada y **el workflow
fail-closed completo en verde en `windows-2022`** (run 27,
https://github.com/jotit4/orca/actions/runs/34859228096): E2E de tres caminos, tests
unitarios en Windows, build, y **gate sobre el `Orca.exe` empaquetado real con PowerShell
5.1 y 7** (dos panes visibles, `list/send/capture/kill` sobre el pane tras el respawn, cwd
literal con corchetes y apóstrofe, argv con argumento vacío, `orca.exe` empaquetado como
shim). **Candidato para la notebook: artefacto `orca-windows-setup-unsigned-27` de ese run.**
Lo que falta para llamarlo versión laboral certificada es la aceptación manual en Windows
10/11 con una sesión de Claude autenticada (ver "Criterio de promoción y rollback"). Rama
`feat/agent-teams-windows` del fork `jotit4/orca`.

El artefacto histórico `orca-windows-setup-unsigned-25` del run
https://github.com/jotit4/orca/actions/runs/34734403880 demostró la integración base, pero
la auditoría posterior encontró fallos de ciclo de vida, fallback y cobertura del artefacto
que este candidato corrige. Upstream (`stablyai/orca`) NO lo tiene: al 12/09 sigue forzando
`--teammate-mode in-process` en `win32` (issues #15503 y #15751; PRs #15753 y #16116
abiertos sin merge desde el 23/08).

## Qué hace

En Windows nativo, un teammate de Claude Code (Agent tool con nombre y en background)
se abre como **pane hijo de Orca**, igual que en Linux/macOS. Antes todos los teammates
corrían dentro de la TUI del líder (modo in-process).

Tres cosas lo impedían y las tres están resueltas (base: PR upstream #15753):

1. **El shim `tmux.cmd` no se podía spawnear.** Claude Code lanza `tmux` sin shell y Node
   se niega a ejecutar `.cmd` así (CVE-2024-27980). Ahora Orca instala una copia del
   launcher `orca.exe` como `%USERPROFILE%\.orca\claude-agent-teams-bin\tmux.exe`; el
   launcher, al verse llamado `tmux`, antepone `agent-teams-tmux` y reenvía a la CLI.
2. **El comando del pane venía escrito para `/bin/sh`.** Claude Code emite
   `cd 'E:\repo' && env CLAUDECODE=1 'C:\...\claude.exe' --agent-name X ...`. Orca lo
   re-escribe para PowerShell con `Set-Location -LiteralPath ... -ErrorAction Stop` dentro
   de un bloque; si el cwd no existe, el hijo no se ejecuta.
   Los argumentos se pasan según la generación de PowerShell que ejecuta el comando (ver
   "Validado en Windows real"): en 7.3+ con `$PSNativeCommandArgumentPassing = 'Standard'` y
   valores reales; en 5.1 pre-escapados (`legacyPowerShellNativeArg`), porque 5.1 sólo envuelve
   en comillas si hay espacios y nunca escapa `"` internas.
   El `cat` que Claude usa como placeholder pasa a `Wait-Event` (en PowerShell `cat` es
   `Get-Content` y pide un path).
3. **`orca claude-teams` tiraba `unsupported_platform`.** Quitado, y `win32` ya no está en
   `detectUnsupportedRuntimes` del catálogo (WSL sí sigue excluido).

Cambio propio del fork (no está en el PR upstream): el PR dependía de `parsed.spans`,
que upstream agregó en #14615 y **revirtió** en #15295. Se reemplazó por un tokenizer
POSIX propio en `src/shared/claude-agent-teams-pane-command.ts`
(`tokenizePosixPaneCommand`) que recuerda si un carácter especial estaba entre comillas.

## Requisitos en la notebook

- **PowerShell como shell de terminal de Orca** (Settings → Terminal → Windows shell).
  Vale Windows PowerShell 5.1 (`powershell.exe`, el default) o PowerShell 7 (`pwsh`).
  Con **cmd.exe, Git Bash o WSL** cae a in-process a propósito: cmd no puede llevar el
  quoting, y Git Bash/WSL no pueden ejecutar el shim `tmux.exe` ni el path Windows del
  launcher. En Windows el modo nativo es PowerShell-only por diseño.
- Claude Code instalado nativo en Windows (`claude.exe` en `%USERPROFILE%\.local\bin` o
  el `claude.cmd` de npm. El smoke cubre el wrapper controlado del fixture; la distribución
  npm real queda dentro de la aceptación manual.
- El build del fork. **Los builds de upstream no sirven** (traen el gate).

## Instalación

1. Bajar el artefacto `orca-windows-setup-unsigned-<n>` del workflow
   *Fork Windows build (unsigned)* en `https://github.com/jotit4/orca/actions`.
2. Ejecutar `orca-windows-setup.exe`. SmartScreen va a avisar "editor desconocido"
   (no está firmado por SignPath): *Más información → Ejecutar de todas formas*.
3. **El updater está apagado en este build** (`ORCA_FORK_DISABLE_UPDATER=1` al compilar).
   Si no, el primer chequeo en background lo pisaría con la 1.4.200 de upstream y se
   perderían los parches. Actualizar = bajar otro artefacto e instalar encima.

## Cómo activarlo

Dos caminos, cualquiera sirve:

- **Tab "Claude Agent Teams"** del catálogo de agentes (ahora aparece en Windows). En
  Windows local lanza directamente `claude --teammate-mode auto`.
- **Tab Claude normal con `--teammate-mode auto`** en los argumentos del agente
  (Settings → Agents → Claude → args). Es exactamente lo mismo que hace la entrada del
  catálogo: `inferCapturedClaudeAgentTeamsMode` lo toma como `native-panes-shim` y el
  runtime inyecta el entorno del team (TMUX, TMUX_PANE, ORCA_AGENT_TEAMS_*) y el PATH con
  el shim. Este es el camino que el PR validó a mano.

Menú, runtime y `orca claude-teams` consumen el mismo plan efectivo. Cuando degrada a
in-process, reemplaza cualquier `--teammate-mode auto|tmux`, retira sólo las variables
gestionadas por Orca y el main process loguea
`[claude-agent-teams] native panes unavailable (<motivo>)` con uno de estos motivos:
`pane-shell-unsupported` (el shell de terminal no es PowerShell), `shim-bin-unresolved`
(no se encontró `resources\bin\orca.exe`), `shim-install-failed` (no se pudo escribir o
actualizar el directorio privado) o `windows-shim-executable-missing` (no quedó un
`tmux.exe` válido en `~\.orca\claude-agent-teams-bin`).

La CLI nueva anuncia la versión del contrato dentro del env del request. Si una CLI vieja
se conecta a un runtime nuevo y éste necesita fallback, el runtime falla con
`claude_agent_teams_cli_upgrade_required_for_fallback` en vez de dejar que la CLI vieja
ignore `mode/envToDelete` y cree una sesión híbrida. El camino nativo conserva
compatibilidad con la CLI anterior.

En cualquier caso hace falta `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (Orca lo pone solo
en el plan de lanzamiento).

## Verificación en la notebook (hacerla en este orden)

1. Abrir una terminal de Orca y confirmar que existe
   `%USERPROFILE%\.orca\claude-agent-teams-bin\tmux.exe` después del primer lanzamiento de
   Claude. Si sólo está `tmux.cmd`, el launcher empaquetado no se encontró
   (`resources\bin\orca.exe`) y el plan cayó a in-process.
2. En la sesión de Claude: `echo $env:TMUX` / `echo $env:TMUX_PANE` deben estar seteados
   (`Get-ChildItem env:ORCA_AGENT_TEAMS_*`).
3. Pedirle a Claude: *"Spawn a teammate named WinProbe that prints
   ORCA_NATIVE_OK and reports back"*. Debe aparecer un **split nuevo en Orca** con una
   sesión de Claude real, y el líder tiene que recibir el reporte.
4. Si el split aparece pero muestra un error de PowerShell (`env: The term 'env' is not
   recognized`), la re-escritura no se aplicó: el shell del pane no se resolvió como
   PowerShell. Revisar Settings → Terminal → Windows shell.
5. Si Claude cae a in-process (teammates dentro de la TUI del líder), revisar 1 y que el
   shell no sea cmd.exe.

### Criterio de promoción y rollback

Un build sólo puede marcarse apto para uso laboral cuando: el job E2E no empaquetado está
verde; el gate empaquetado está verde para PowerShell 5.1 y 7; se instaló el mismo
artefacto en Windows 10 u 11; y una sesión Claude real creó al menos dos teammates,
intercambió mensajes, cerró/recreó uno y dejó líder y pane restante operables. Registrar
SHA, run, nombre del artefacto, Windows y versión de Claude.

Si falla cualquiera de esos puntos, no reemplazar el instalador laboral. Reinstalar el
último artefacto aceptado (el updater del fork permanece desactivado), conservar el perfil
y adjuntar la evidencia del gate. El fallback automático `in-process` es una degradación
segura para esa sesión, no una certificación de panes nativos.

## Qué NO cubre

- WSL como runtime del agente (sigue in-process).
- cmd.exe como shell del pane.
- Hosts SSH/remotos desde Windows (los panes de teammates se lanzan siempre en el host
  local; el shell remoto no se re-escribe).

## Archivos

- `src/shared/claude-agent-teams-pane-command.ts` — re-escritura sh → PowerShell + tokenizer.
- `src/main/runtime/claude-agent-teams-shim-env.ts` — instalación de `tmux.exe`, gates.
- `src/main/runtime/claude-agent-teams-tmux-dispatcher.ts` — aplica la re-escritura en los
  dos sitios de split (split-window directo y cat→respawn-pane).
- `native/windows-cli-launcher/OrcaCliLauncher.cs` — modo shim cuando se llama `tmux`.
- `src/shared/tui-agent-config.ts` — `detectUnsupportedRuntimes: ['wsl']`.
- `src/cli/handlers/core.ts` — `orca claude-teams` sin gate de plataforma.
- `.github/workflows/fork-windows-build.yml` — build del instalador (manual).
- `src/main/updater.ts` + `electron.vite.config.ts` — `ORCA_FORK_DISABLE_UPDATER`.

## Tests

`pnpm exec vitest run --config config/vitest.config.ts src/shared/claude-agent-teams-pane-command.test.ts src/main/runtime/claude-agent-teams-shim-env.test.ts src/main/runtime/claude-agent-teams-service.test.ts src/cli/handlers/core.test.ts src/main/ipc/tui-agent-detection-commands.test.ts`

El test `forwards tmux argv to the CLI when copied into the Agent Teams shim dir`
(`config/scripts/build-windows-cli-launcher.test.mjs`) sólo corre en Windows: compila el
launcher con `csc.exe` y verifica que `tmux.exe` reenvíe `['agent-teams-tmux', ...]`.

## Validado en Windows real (runner windows-2022, 2026-09-13)

El E2E `tests/e2e/claude-agent-teams-windows-native-panes.spec.ts` pasa en la VM de GitHub
para **pwsh 7, Windows PowerShell 5.1 y el camino del menú New tab → "Claude Agent Teams"**
(run 25 del workflow, los tres en verde): Orca real, un
`claude` falso que replica las llamadas tmux de Claude Code 2.1.270, y un teammate falso que
deja por escrito lo que recibió. El argv llega intacto en las dos generaciones, incluidos
`say "hi" | a;b` y `C:\a b\`, y el teammate aparece como segundo pane del tab del líder.

Tres arreglos que salieron de esa validación y que aplican también al instalador:

- `prepareClaudeAgentTeamsLeaderForHandle` (camino de lanzamiento desde el renderer) no
  instalaba `tmux.exe`; ahora usa el mismo contrato que el plan de lanzamiento.
- El shim `agent-teams-tmux` tenía 10 s de espera al runtime; en Windows `split-window`
  espera la carga del perfil de PowerShell y superaba ese presupuesto (upstream #13050). Ahora 60 s.
- El runtime esperaba 10 s a que el renderer materializara la hoja del split; ahora 45 s.

Dos hallazgos más:

- **`--%` NO sirve en pwsh 7.** El diseño inicial usaba el stop-parsing token; en 7.3+ el
  texto posterior se parte por espacios y se vuelve a citar (se vio en la línea de comandos
  cruda del hijo). La versión final emite el comando dos veces y el shell elige:
  `if ([version](...) -ge [version]'7.3.0') { $PSNativeCommandArgumentPassing = 'Standard'; & exe 'a' … } else { & exe 'a-preescapado' … }`.
- **El pane del teammate ahora hereda su identidad de team** (`TMUX_PANE`,
  `ORCA_AGENT_TEAMS_*`): el split correlacionado transporta `command`, `env` y
  `envToDelete`. Los mensajes tardíos llevan un `leafId` explícito y no pueden apropiarse
  del pane de otra creación concurrente.

## Gotcha: "Claude Agent Teams" oculto en perfiles viejos

`persistence.ts` migra los perfiles anteriores al default-on agregando `claude-agent-teams`
a `disabledTuiAgents`. Si Orca ya había corrido alguna vez en la notebook (aunque fuera la
versión de upstream), la entrada no aparece en el menú New tab aunque esté detectada:
**Settings → Agents → habilitar Claude Agent Teams**. En una instalación limpia viene
habilitado.

## E2E en la VM de Windows de GitHub Actions

El job `e2e-windows-agent-teams` de `fork-windows-build.yml` corre
`tests/e2e/claude-agent-teams-windows-native-panes.spec.ts` en un runner `windows-2022`:
Orca real (build e2e), un `claude` falso en el PATH que replica los comandos tmux exactos
de Claude Code 2.1.270, y un teammate falso que deja por escrito el argv, cwd y env que
recibió. Verifica la cadena completa: plan de lanzamiento → `tmux.exe` → CLI → runtime →
dispatcher → re-escritura PowerShell → segundo pane con el comando corriendo. No necesita
cuenta de Claude. Después, `build-windows` empaqueta el candidato y ejecuta
`tests/tools/win-agent-teams-packaged/run.mjs` contra `dist/win-unpacked/Orca.exe`: exige
dos panes visibles, controla el pane tras `respawn` con `list/send/capture/kill`, verifica
cwd/argv/env, y recién entonces permite subir el instalador. Lo único que no cubre es el
propio binario de Claude Code ni una interacción humana prolongada.

## Regresión heredada que dejaba Orca sin ventana en Windows (resuelta)

La base del fork (upstream del 12/08, `d6e1d84`) tiene un bug que upstream arregló ese
mismo día en #14173: en un perfil nuevo de Windows, `writeProfileIndex` hace `fsync` sobre
un descriptor abierto en modo lectura y Windows responde `EPERM`; queda como unhandled
rejection en el bootstrap y **el main process sigue vivo pero nunca abre la ventana**. Se
vio primero en el runner de GitHub (Playwright: "firstWindow: Timeout 120000ms") y aplica
igual a un instalador del fork en una máquina donde Orca nunca corrió. Cherry-pickeados
#14173 entero y el hunk de `secure-file.ts` de #14235. **Los instaladores de los runs 1 a 3
del workflow tienen el bug; usar el del run 25 o posterior.**

Cómo se diagnosticó: lanzando Electron a mano en el runner con `ORCA_STARTUP_DIAGNOSTICS=1`
y el home aislado que exige `configureDevUserDataPath` (`ORCA_E2E_USER_DATA_DIR`,
`ORCA_E2E_HOME_DIR`, `USERPROFILE`/`HOME` apuntando a `<userData>\home`). Ese paso quedó en
el job E2E del workflow.

## Deuda

- Rebase sobre upstream: el fork está ~2300 commits detrás de `main`. Cuando upstream
  mergee #15753 o #16116, comparar antes de rebasear: #16116 (draft del mantenedor)
  rehace el protocolo del daemon (v37) y es incompatible con este parche.
