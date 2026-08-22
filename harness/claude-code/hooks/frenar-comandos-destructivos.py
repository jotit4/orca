#!/usr/bin/env python3
"""Hook PreToolUse: frena los comandos que CLAUDE.md marca como prohibidos.

Las reglas `deny` de `.claude/settings.local.json` matchean por PREFIJO, así que
`cd sub && git stash` las esquiva. Este hook inspecciona el comando completo, en
cualquier posición, y por eso es la capa que realmente sostiene la regla.

Tres familias, cada una con su incidente detrás:

1. Destructivo sobre el árbol de trabajo del usuario. Casi siempre tiene cambios
   sin commitear y un conflicto al restaurar se los enreda.
2. Sockets y procesos que el agente no creó. Un spike de tmux borró el socket del
   agent team de Orca y dejó al harness sin poder crear panes por el resto de la
   sesión; `pkill -f "bun run"` mató el shell que lo ejecutaba.
3. Escrituras en los perfiles de shell. Un instalador dejó un `source` de un
   scratchpad efímero en los tres perfiles y, al morir esa sesión, todo shell
   nuevo de la máquina falló al arrancar.

Ante cualquier error interno el hook se hace a un lado (exit 0): un hook roto que
bloquea todo Bash es peor que el riesgo que cubre.

Autotest: `python3 frenar-comandos-destructivos.py --test`
"""

import json
import re
import sys

# (regex, motivo, alternativa). El motivo se le muestra a Claude al bloquear.
REGLAS = [
    # ---- 1. Árbol de trabajo del usuario ----
    (
        r"\bgit\s+stash\b(?!\s+(list|show))",
        "`git stash` sobre el árbol del usuario",
        "Para comparar contra el árbol limpio: worktree aparte o checkout temporal "
        "en el scratchpad. `git stash list` y `git stash show` sí están permitidos.",
    ),
    (
        r"\bgit\s+reset\s+.*--hard\b",
        "`git reset --hard` sobre el árbol del usuario",
        "Usar `git reset` sin --hard, o un worktree aparte si hace falta un árbol limpio.",
    ),
    (
        r"\bgit\s+checkout\s+.*(--force|(?<!\w)-f)(?!\w)",
        "`git checkout --force` sobre el árbol del usuario",
        "Checkout sin --force, o un worktree aparte.",
    ),
    (
        r"\bgit\s+clean\s+-[a-z]*[fd][a-z]*\b",
        "`git clean` con -f/-d sobre el árbol del usuario",
        "Listar primero con `git clean -n` y borrar a mano lo que corresponda.",
    ),
    # ---- 2. Sockets y procesos ajenos ----
    (
        r"\brm\b[^|;&]*(/tmp/tmux-|/tmp/orca-|\$TMUX|\$\{TMUX)",
        "borrado de un socket de tmux/Orca que este agente no creó",
        "No se tocan sockets ajenos. Para limpiar lo propio: crear el socket con nombre "
        "distintivo y cerrar con `kill-session -t <nombre>` sobre ese socket.",
    ),
    (
        r"\btmux\b[^|;&]*\bkill-server\b",
        "`tmux kill-server` mata también los panes del harness",
        "Cerrar sólo la sesión propia: `kill-session -t <nombre>` sobre el socket propio.",
    ),
    (
        r"\bpkill\b(?![^|;&]*\s-F(?!\w))",
        "`pkill` mata por patrón y alcanza procesos que este agente no creó",
        "Matar por PID conocido (`kill <pid>`) o con `pkill -F <pidfile>` de un pidfile propio.",
    ),
    (
        r"\bkillall\b",
        "`killall` alcanza procesos que este agente no creó",
        "Matar por PID conocido (`kill <pid>`).",
    ),
    # ---- 3. Perfiles de shell ----
    (
        # Escritura por redirección, tee o edición in-place sobre un perfil.
        r"(>>?\s*|(\btee\b|\bsed\b)[^|;&]*)(~|\$HOME)/\.(bashrc|profile|bash_profile|zshrc|zprofile)",
        "escritura en un perfil de shell del usuario",
        "Ningún instalador puede tocar los perfiles. Instalar con prefijo propio y "
        "`--no-modify-path` (o equivalente), exportando las variables en el propio comando. "
        "Si el instalador no lo ofrece, pedírselo al usuario.",
    ),
]

COMPILADAS = [(re.compile(p), motivo, alt) for p, motivo, alt in REGLAS]


def evaluar(comando):
    """Devuelve (motivo, alternativa) si hay que frenar, o None."""
    for patron, motivo, alt in COMPILADAS:
        if patron.search(comando):
            return motivo, alt
    return None


def main():
    try:
        entrada = json.load(sys.stdin)
    except Exception:
        return 0  # entrada ilegible: hacerse a un lado

    if entrada.get("tool_name") not in ("Bash", "BashOutput"):
        return 0

    comando = (entrada.get("tool_input") or {}).get("command") or ""
    veredicto = evaluar(comando)
    if not veredicto:
        return 0

    motivo, alternativa = veredicto
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"Frenado por regla dura del proyecto: {motivo}. {alternativa}"
                ),
            }
        },
        sys.stdout,
    )
    return 0


CASOS = [
    # (comando, debe_frenarse)
    ("git stash", True),
    ("cd packages/agent-service && git stash", True),          # el bypass del prefijo
    ("git stash push -u", True),
    ("git stash list", False),
    ("git stash show -p", False),
    ("git reset --hard HEAD~1", True),
    ("git reset HEAD~1", False),
    ("git checkout --force main", True),
    ("git checkout -f main", True),
    ("git checkout -b rama-nueva", False),
    ("git clean -fd", True),
    ("git clean -n", False),
    ("rm /tmp/tmux-1000/default", True),
    ("rm -f $TMUX", True),
    ("ls /tmp/tmux-1000", False),
    ("tmux kill-server", True),
    ("tmux kill-session -t mio", False),
    ('pkill -f "bun run"', True),
    ("pkill -F /tmp/mio.pid", False),
    ("killall node", True),
    ("echo 'export PATH=x' >> ~/.bashrc", True),
    ("sed -i s/a/b/ $HOME/.zshrc", True),
    ("cat ~/.bashrc", False),
    ("grep -n orca ~/.bashrc", False),
    ("npm test", False),
    (".venv/bin/python -m pytest tests/ --ignore=tests/e2e -q", False),
]


def autotest():
    fallos = 0
    for comando, esperado in CASOS:
        obtenido = evaluar(comando) is not None
        if obtenido != esperado:
            fallos += 1
            estado = "FRENÓ pero no debía" if obtenido else "NO frenó y debía"
            print(f"FALLO  {estado}: {comando}")
    total = len(CASOS)
    print(f"\n{total - fallos}/{total} casos OK")
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(autotest() if "--test" in sys.argv else main())
