#!/usr/bin/env bash
# Envoltorio de gates del entorno: corre el comando real SIN alterar stdin, stdout ni el código de
# salida (un hook PreToolUse que deniega tiene que seguir denegando), y deja un marker con fecha y
# resultado en /tmp/waengine-orquestacion/_gates/<nombre>.ran.
#
# Por qué existe: "un gate que no corre = un gate en verde" (waengine-stagging, 13/08; el enganche
# de subagentes que falló 13 de 15 veces en silencio, 22/08). Con el marker, verificar-gates.sh puede
# distinguir "corrió y pasó", "corrió y falló" y "no corrió" — tres estados, no uno.
#
# Uso: gate.sh <nombre> -- <comando...>
set -uo pipefail
nombre="${1:?nombre del gate}"; shift
[ "${1:-}" = "--" ] && shift
dir="/tmp/waengine-orquestacion/_gates"
mkdir -p "$dir" 2>/dev/null || true
inicio="$(date +%s)"
# stdin llega entero al comando real; el marker no lo consume
"$@"
rc=$?
printf '{"gate":"%s","at":"%s","epoch":%s,"exit":%s,"dur_s":%s,"session":"%s","pid":%s}\n' \
  "$nombre" "$(date -Is)" "$(date +%s)" "$rc" "$(( $(date +%s) - inicio ))" "${CLAUDE_SESSION_ID:-}" "$$" \
  > "${dir}/${nombre}.ran" 2>/dev/null || true
exit $rc
