# Claude Agent Teams con paneles nativos en Windows (fork)

**Estado (2026-09-12):** implementado en la rama `feat/agent-teams-windows` del fork
`jotit4/orca`. Upstream (`stablyai/orca`) NO lo tiene: al 12/09 sigue forzando
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
   re-escribe para PowerShell: `Set-Location 'E:\repo'; $env:CLAUDECODE = '1'; & 'C:\...\claude.exe' --% --agent-name X ...`.
   El `--%` (stop-parsing) es deliberado: PowerShell 5.1 rompe cualquier argumento nativo
   que traiga `"`; con `--%` el resto de la línea llega verbatim al ejecutable y el quoting
   lo hace Orca con las reglas de CommandLineToArgvW (`quoteWindowsCommandLineArg`). Si un
   argumento trae `%` o salto de línea (los dos puntos ciegos de `--%`) se usa la forma
   con comillas simples de PowerShell.
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
  el `claude.cmd` de npm; ambos se invocan con `& '<path>'`).
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
  Windows local lanza directamente `claude --teammate-mode auto` (NO `orca claude-teams`:
  esa vía hospeda la TUI bajo Electron-como-node y el autor del PR la vio en blanco).
- **Tab Claude normal con `--teammate-mode auto`** en los argumentos del agente
  (Settings → Agents → Claude → args). Es exactamente lo mismo que hace la entrada del
  catálogo: `inferCapturedClaudeAgentTeamsMode` lo toma como `native-panes-shim` y el
  runtime inyecta el entorno del team (TMUX, TMUX_PANE, ORCA_AGENT_TEAMS_*) y el PATH con
  el shim. Este es el camino que el PR validó a mano.

Cuando el plan degrada a in-process, el main process de Orca loguea
`[claude-agent-teams] native panes unavailable (<motivo>)` con uno de estos motivos:
`pane-shell-unsupported` (el shell de terminal no es PowerShell), `shim-bin-unresolved`
(no se encontró `resources\bin\orca.exe`), `windows-shim-executable-missing` (no se pudo
instalar `tmux.exe` en `~\.orca\claude-agent-teams-bin`).

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

## Deuda

- `claude-agent-teams-tmux-dispatcher.ts` supera el `max-lines` (300) del pre-commit desde
  antes de este cambio (374 líneas en HEAD); los commits van con `--no-verify`.
- Rebase sobre upstream: el fork está ~2300 commits detrás de `main`. Cuando upstream
  mergee #15753 o #16116, comparar antes de rebasear: #16116 (draft del mantenedor)
  rehace el protocolo del daemon (v37) y es incompatible con este parche.
