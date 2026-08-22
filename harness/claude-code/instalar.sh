#!/usr/bin/env bash
# Instala el harness de Claude Code para Orca en un proyecto.
#
# Uso: harness/claude-code/instalar.sh <ruta-absoluta-del-proyecto>
#
# Qué hace: copia hooks/, scripts/, skills/ y gates.manifest a <proyecto>/.claude/, reemplazando el
# marcador __PROYECTO__ por la ruta real; mezcla la sección "hooks" en <proyecto>/.claude/settings.json
# (reemplaza esa clave, conserva el resto) y las reglas "permissions.deny" en settings.local.json
# (unión, no duplica). No toca nada fuera de .claude/. Es idempotente: correrlo dos veces da lo mismo.
#
# Qué NO hace: no commitea nada (la config del entorno de agentes la commitea el usuario), no instala
# Orca ni reemplaza el AppImage (ver docs/ y verificar-fix-orca.sh), no toca perfiles de shell.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROY="${1:?ruta absoluta del proyecto destino}"
[ -d "$PROY" ] || { echo "no existe: $PROY" >&2; exit 1; }
case "$PROY" in /*) ;; *) echo "la ruta debe ser absoluta" >&2; exit 1 ;; esac
DEST="$PROY/.claude"
mkdir -p "$DEST"/{hooks,scripts,skills}
copiar() { # origen destino — copia reemplazando el marcador
  sed "s#__PROYECTO__#${PROY}#g" "$1" > "$2"; chmod --reference="$1" "$2" 2>/dev/null || true
}
for f in "$AQUI"/hooks/*; do copiar "$f" "$DEST/hooks/$(basename "$f")"; done
for f in "$AQUI"/scripts/*; do copiar "$f" "$DEST/scripts/$(basename "$f")"; done
copiar "$AQUI/gates.manifest" "$DEST/gates.manifest"
for d in "$AQUI"/skills/*/; do n="$(basename "$d")"; mkdir -p "$DEST/skills/$n"; for f in "$d"*; do copiar "$f" "$DEST/skills/$n/$(basename "$f")"; done; done
python3 - "$AQUI" "$DEST" "$PROY" <<'PY'
import json, os, sys
aqui, dest, proy = sys.argv[1:4]
def cargar(p):
    try: return json.load(open(p))
    except Exception: return {}
def guardar(p, d):
    json.dump(d, open(p, "w"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
hooks = json.loads(open(f"{aqui}/settings/hooks.json").read().replace("__PROYECTO__", proy))["hooks"]
p = f"{dest}/settings.json"; s = cargar(p); s["hooks"] = hooks; guardar(p, s)
deny = cargar(f"{aqui}/settings/permissions-deny.json")["permissions"]["deny"]
p = f"{dest}/settings.local.json"; l = cargar(p)
perm = l.setdefault("permissions", {}); actual = perm.setdefault("deny", [])
for r in deny:
    if r not in actual: actual.append(r)
guardar(p, l)
print(f"hooks: {sum(len(e['hooks']) for v in hooks.values() for e in v)} comandos en {len(hooks)} eventos; deny: {len(actual)} reglas")
PY
echo "instalado en $DEST. Siguiente: correr los gates manuales por gate.sh, p. ej.:"
echo "  bash '$DEST/scripts/gate.sh' verificar-fix-orca -- bash '$DEST/scripts/verificar-fix-orca.sh'"
