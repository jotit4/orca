---
name: entorno-orca
description: Gotchas de esta máquina al operar Orca, que las skills genéricas de Orca no cubren. Incluye el arranque de computer-use sobre apps de escritorio, el estado visible del worktree en la tarjeta del workspace, y por qué un nombre de comando no garantiza qué binario se ejecuta.
when_to_use: Usar al operar apps de escritorio con computer-use, al actualizar el estado de un worktree, cuando un comando de Orca falla por dependencias o PATH, y antes de improvisar subcomandos de la CLI.
allowed-tools: [Bash, Read]
---

# Entorno Orca — gotchas de esta máquina

Para lo genérico están las skills propias de Orca: `orca-cli` (worktrees, terminales, navegador
embebido), `computer-use` (apps de escritorio) y `orchestration`. La guía versionada la sirve el
binario con `orca skills get orca-cli`: **leerla antes de usar subcomandos, no inventarlos de
memoria.** Acá va sólo lo que esas skills no saben porque es específico de esta máquina.

## 🔴 Antes de modificar el `PATH`

**Nunca invocar `orca` por nombre después de tocar el `PATH`.** Resolver la ruta **antes** del
cambio y usar esa:

```bash
ORCA_BIN="$(command -v orca)"        # ANTES de tocar el PATH
export PATH="/usr/bin:$PATH"         # el cambio que hacía falta
"$ORCA_BIN" snapshot --json          # por ruta absoluta — nunca `orca snapshot`
```

**Por qué:** anteponer `/usr/bin` pone **`/usr/bin/orca`, el lector de pantalla de GNOME**, delante
del shim de la CLI. Ejecutarlo **le arranca la voz al usuario en su máquina**, y ya pasó en plena
sesión.

Fuera de una terminal de Orca el binario de la CLI es **`orca-ide`**, no `orca`.

**Generalización que vale para todo comando acá: en esta máquina un nombre no promete qué binario se
ejecuta.** Mismo patrón con `Bun.which`, que devuelve el shim y no el binario. Ante la duda, resolver
con `command -v` y guardar la ruta.

## Computer Use

`orca computer ...` lee y opera **apps de escritorio** por su árbol de accesibilidad: lo que el
navegador embebido no cubre — Chrome externo, la propia app de Orca, cualquier ventana GTK/Electron.

Bucle: `list-apps` → `get-app-state --app <sel>` → `click --element-index N`.

Los índices salen de `result.snapshot.treeText`, **caducan ante cualquier cambio de la UI** (releer
el estado antes de cada acción) y **nunca se infieren de `elementCount`**.

Requiere `gsettings set org.gnome.desktop.interface toolkit-accessibility true`, y las apps abiertas
antes de activarlo pueden no exponer su árbol hasta reiniciarse.

### Si falla con "requires python3-gi and AT-SPI packages", el error miente

Los paquetes están y AT-SPI funciona. Es el `PATH` del daemon de Orca, que prioriza un `python3` de
Homebrew sin PyGObject. Lo resuelve el wrapper **ya instalado** en `~/.local/bin/python3`.

**No reinstalar nada ni hacer un symlink** — rompe los paquetes de Homebrew.

## Estado del worktree

```bash
orca worktree set --worktree active --comment "..."
orca worktree set --workspace-status todo|in-progress|in-review|completed
```

Deja el estado visible en la tarjeta del workspace. Actualizarlo en los **hitos reales**
—reproducción, fix, validación, bloqueo—, no al final.

## Runtimes por workspace

La skill `orca-per-workspace-env` crea **runtimes desechables por workspace** desde cero: es justo
lo que se construyó a mano para WAEngine OS. Mirarla antes de improvisar un entorno.

## 🔴 Instalar un runtime sin tocar los perfiles de shell

**Prohibido** correr cualquier instalador que escriba en `~/.bashrc`, `~/.profile`,
`~/.bash_profile` o `~/.zshrc`.

**Procedimiento obligatorio**, en tres partes: prefijo propio, bandera de no-modificar-PATH, y
export en el propio comando.

```bash
# La bandera exacta cambia según el instalador; el principio no. Ejemplo con rustup:
curl --proto '=https' -sSf https://sh.rustup.rs | sh -s -- --no-modify-path -y

# Prefijo propio dentro del proyecto, nunca en un scratchpad efímero:
export RUNTIME_DIR="$PWD/.runtime"

# El PATH se exporta en ESTE comando, jamás en un perfil:
export PATH="$RUNTIME_DIR/bin:$PATH" && mi-comando
```

**Si el instalador no ofrece una bandera equivalente, pedírselo al usuario. No improvisar.**

**Por qué:** un agente instaló Deno en su scratchpad y el instalador dejó un `source` de esa ruta en
los **tres** perfiles. El scratchpad es efímero: al morir esa sesión, *todo* shell nuevo de la
máquina falló al arrancar. Y como **cada pane de subagente arranca un shell que lee esos perfiles**,
el síntoma visible fue `Failed to create teammate pane: tmux: Timed out waiting for split pane
handle` — una causa trivial disfrazada de fallo del harness.

**Verificar después, y antes de lanzar una flota:**

```bash
.claude/scripts/verificar-perfiles-shell.sh    # sale 1 si hay referencias rotas
```

El hook `PreToolUse` frena las escrituras a los perfiles, pero **no repara** lo que ya quedó roto.
