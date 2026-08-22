#!/usr/bin/env bash
#
# Engancha automáticamente cada subagente recién lanzado (pane hijo del `Agent`
# tool) a la capa de orquestación de Orca, para que su ciclo de vida deje señales
# confiables: `worker_done` explícito, heartbeats, `ask` bloqueante y acuse de
# recibo.
#
# Por qué existe: la notificación `idle` del harness NO significa "terminó" — el
# 07/08/2026 un agente reportó "available" 60 s ANTES de terminar realmente, se
# lo dio por cerrado y se editaron sus archivos mientras seguía escribiendo. La
# capa de orquestación sí distingue vivo / terminado / abandonado.
#
# Lo dispara el hook `SubagentStart` (.claude/settings.json). Recibe en stdin el
# JSON del hook: {session_id, agent_id, agent_type, cwd, ...}. NO trae el handle
# de la terminal de Orca, así que hay que resolverlo.
#
# 🔴 Dos cuidados que no se relajan:
#
# 1. `orca` se invoca SIEMPRE por ruta absoluta del shim. En esta máquina
#    `/usr/bin/orca` es el lector de pantalla de GNOME y ejecutarlo le arranca la
#    voz al usuario en plena sesión (ya pasó el 07/08/2026 al anteponer /usr/bin
#    al PATH). Un nombre de comando acá no promete qué se ejecuta.
#
# 2. El candidato se filtra por el `tabId` del coordinador. Los panes hijos
#    comparten tab con quien los lanzó y sólo cambian de `leafId`; otras sesiones
#    de Claude sobre el MISMO worktree viven en otra tab. Filtrar sólo por
#    worktree inyectaría el preámbulo en la sesión de al lado.
#
# Nunca falla hacia afuera: si algo no sale, sale 0 y deja rastro en el log. Un
# subagente sin enganchar es una degradación aceptable; un hook que aborta el
# lanzamiento, no.

set -uo pipefail

# ── Traza de arranque ───────────────────────────────────────────────────────
# Las salidas tempranas de abajo (sin shim, sin payload, sin session_id) son
# silenciosas y ocurren ANTES de que exista el log de la sesión, así que un hook
# que se ejecuta y aborta es indistinguible de un hook que nunca corrió. Pasó el
# 10/08/2026. Este log de arranque, a ruta fija, resuelve esa ambigüedad.
crudo="/tmp/waengine-orquestacion/_arranques.log"
mkdir -p /tmp/waengine-orquestacion 2>/dev/null || true
printf '[%s] HOOK ARRANCA pid=%s tab=%s pane=%s\n' \
  "$(date -Is)" "$$" "${ORCA_TAB_ID:-(vacío)}" "${ORCA_PANE_KEY:-(vacío)}" >> "$crudo" 2>/dev/null || true

ORCA_SHIM="/home/jot4dev/.config/orca/linux-orca-cli-shim/orca"
ORCA_FALLBACK="/home/jot4dev/.local/bin/orca-ide"
if [ -x "$ORCA_SHIM" ]; then
  ORCA="$ORCA_SHIM"
elif [ -x "$ORCA_FALLBACK" ]; then
  ORCA="$ORCA_FALLBACK"
else
  printf '[%s] ABORTA: no hay binario de orca\n' "$(date -Is)" >> "$crudo" 2>/dev/null || true
  exit 0
fi

# `timeout 5` para que un stdin que nunca cierra no cuelgue el hook los 60 s.
payload="$(timeout 5 cat)"
printf '[%s] payload %s bytes: %.400s\n' "$(date -Is)" "${#payload}" "${payload:-(vacío)}" >> "$crudo" 2>/dev/null || true
[ -n "$payload" ] || exit 0

# Acepta dos formatos de payload:
#   · `SubagentStart` → {session_id, agent_id, agent_type, ...} — sólo dispara con
#     subagentes in-process, o sea nunca cuando el harness crea panes reales.
#   · `PostToolUse` del lanzamiento → {session_id, tool_name, tool_input,
#     tool_response{...}}. Éste SÍ corre en el proceso del coordinador, que es
#     quien llama a la herramienta, y por eso es el que sirve con `claude-teams`.
campos="$(printf '%s' "$payload" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin) or {}
except Exception:
    sys.exit(0)
resp = d.get('tool_response')
if isinstance(resp, str):
    try:
        resp = json.loads(resp)
    except Exception:
        resp = {}
resp = resp if isinstance(resp, dict) else {}
inp = d.get('tool_input') if isinstance(d.get('tool_input'), dict) else {}
agent_id = d.get('agent_id') or resp.get('agent_id') or resp.get('agentId') or resp.get('name') or inp.get('name') or ''
agent_type = d.get('agent_type') or inp.get('subagent_type') or resp.get('agent_type') or 'general-purpose'
print(d.get('session_id') or '')
print(agent_id)
print(agent_type)
print(d.get('tool_name') or '')
" 2>/dev/null)"

session_id="$(printf '%s' "$campos" | sed -n '1p')"
agent_id="$(printf '%s' "$campos" | sed -n '2p')"
agent_type="$(printf '%s' "$campos" | sed -n '3p')"
tool_name="$(printf '%s' "$campos" | sed -n '4p')"

# En PostToolUse el hook ve TODAS las herramientas si el matcher es amplio: salir
# barato en cuanto no sea un lanzamiento de subagente.
case "$tool_name" in
  ''|Agent|Task) : ;;
  *) exit 0 ;;
esac
if [ -z "$session_id" ] || [ -z "$agent_id" ]; then
  printf '[%s] ABORTA: session_id="%s" agent_id="%s"\n' "$(date -Is)" "$session_id" "$agent_id" >> "$crudo" 2>/dev/null || true
  exit 0
fi

estado="/tmp/waengine-orquestacion/${session_id}"
mkdir -p "$estado" 2>/dev/null || exit 0
log="${estado}/enganche.log"
enganchados="${estado}/handles-enganchados.txt"
mapa="${estado}/mapa.tsv"
touch "$enganchados" "$mapa" 2>/dev/null || exit 0

anotar() { printf '[%s] %s\n' "$(date -Is)" "$*" >> "$log" 2>/dev/null || true; }
ESTADO="__PROYECTO__/.claude/scripts/orquestacion-estado.py"
estado_set() { python3 "$ESTADO" --session "$session_id" upsert --agent "$agent_id" "$@" >/dev/null 2>&1 || true; }
# Lo que el coordinador ve en su turno (stdout JSON del hook = additionalContext).
reportar() {
  python3 - "$1" <<'PY'
import json,sys
print(json.dumps({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":sys.argv[1]}},ensure_ascii=False))
PY
}
# Espejo en la ruta fija: un fallo tardío (después del arranque) también debe
# quedar visible sin tener que conocer de antemano el session_id. El log de
# arranque ya cumplía este rol para las salidas tempranas; esto lo extiende a
# todo el resto del script.
fallo() {
  anotar "SIN ENGANCHAR ${agent_type}/${agent_id}: $*"
  printf '[%s] SIN ENGANCHAR session=%s %s/%s: %s\n' \
    "$(date -Is)" "$session_id" "$agent_type" "$agent_id" "$*" >> "$crudo" 2>/dev/null || true
}

anotar "arranca ${agent_type}/${agent_id}"

# ── 0. Idempotencia ─────────────────────────────────────────────────────────
# Un mismo agent_id puede volver a pasar por este hook (reintento del harness,
# o el propio PostToolUse disparando más de una vez para el mismo lanzamiento).
# Si ya tiene fila en el mapa, el enganche anterior ya resolvió handle+task —
# no hay que crear una task/dispatch nueva, que además le duplicaría el
# preámbulo de reporte al subagente.
if [ -f "$mapa" ] && awk -F'\t' -v id="$agent_id" '$1==id{found=1; exit} END{exit !found}' "$mapa" 2>/dev/null; then
  anotar "ya enganchado ${agent_type}/${agent_id} (idempotente, no se repite)"
  exit 0
fi

# ── 1. Identidad del coordinador ────────────────────────────────────────────
# Orca la publica en el entorno de la terminal, y el hook lo hereda. NO sirve
# sacarla del Run: un Run creado desde este hook viene con `coordinator_pane_key`
# vacío, porque el proceso del hook no es una terminal registrada de Orca.
coord_tab="${ORCA_TAB_ID:-}"
coord_leaf=""
if [ -n "${ORCA_PANE_KEY:-}" ]; then
  coord_tab="${ORCA_PANE_KEY%%:*}"
  coord_leaf="${ORCA_PANE_KEY#*:}"
fi
if [ -z "$coord_tab" ]; then
  fallo "el entorno no trae ORCA_TAB_ID/ORCA_PANE_KEY"
  exit 0
fi
anotar "coordinador tab=${coord_tab} leaf=${coord_leaf:-(desconocido)}"

# ── 2. Run de la sesión (uno solo, reutilizado) ─────────────────────────────
# El Run guardado en disco sobrevive a un reinicio de Orca, pero el *binding* del
# coordinador no: el runtime nuevo no lo tiene bindeado y `task-create` falla con
# `run_required`. Por eso se re-bindea siempre con `run-use`, y si eso falla se
# descarta el id viejo y se crea uno nuevo. Pasó el 10/08/2026.
run_file="${estado}/run_id"
run_id=""
[ -f "$run_file" ] && run_id="$(cat "$run_file" 2>/dev/null)"
if [ -n "$run_id" ]; then
  run_use_out="$("$ORCA" orchestration run-use --id "$run_id" --json 2>&1)"
  if ! printf '%s' "$run_use_out" | python3 -c "
import json,sys
try: sys.exit(0 if json.load(sys.stdin).get('ok') else 1)
except Exception: sys.exit(1)" 2>/dev/null; then
    anotar "el Run ${run_id} ya no se puede bindear (run-use: ${run_use_out}); creando uno nuevo"
    run_id=""
    rm -f "$run_file" 2>/dev/null || true
  fi
fi
if [ -z "$run_id" ]; then
  run_create_out="$("$ORCA" orchestration run-create --objective "Sesión ${session_id} — subagentes enganchados automáticamente" --json 2>&1)"
  run_id="$(printf '%s' "$run_create_out" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['result']['run']['id'])
except Exception: pass" 2>/dev/null)"
  if [ -n "$run_id" ]; then
    printf '%s' "$run_id" > "$run_file"
  else
    anotar "run-create no devolvió id: ${run_create_out}"
  fi
fi
if [ -z "$run_id" ]; then
  fallo "no hay Run bindeable ni creable"
  exit 0
fi

anotar "run ${run_id}"

# ── 3. Resolver el handle del pane recién nacido ────────────────────────────
# El hook dispara al arrancar el subagente y el pane puede tardar en registrarse,
# así que se reintenta. Candidato válido = misma tab que el coordinador, distinto
# leaf, y todavía no enganchado.
export COORD_TAB="$coord_tab" COORD_LEAF="$coord_leaf" ENGANCHADOS="$enganchados"
handle=""
for _ in $(seq 1 45); do
  handle="$("$ORCA" terminal list --json 2>/dev/null | python3 -c "
import json, sys, os
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not d.get('ok'):
    sys.exit(0)
tab = os.environ['COORD_TAB']
leaf = os.environ['COORD_LEAF']
try:
    ya = set(open(os.environ['ENGANCHADOS']).read().split())
except Exception:
    ya = set()
cands = []
for t in d.get('result', {}).get('terminals', []):
    h = t.get('handle', '')
    if not h or h in ya:
        continue
    if t.get('tabId') != tab or t.get('leafId') == leaf:
        continue
    cands.append((t.get('lastOutputAt') or 0, h))
if cands:
    # El pane recién nacido es el de actividad más reciente entre los no enganchados.
    cands.sort()
    print(cands[-1][1])
" 2>/dev/null)"
  [ -n "$handle" ] && break
  sleep 1
done

if [ -z "$handle" ]; then
  fallo "no apareció ningún pane nuevo en la tab ${coord_tab}"
  estado_set --set "agent_type=${agent_type}" --set "hook_attempt=no apareció pane en 45 s"
  python3 "$ESTADO" --session "$session_id" settle --agent "$agent_id" --reason unhooked >/dev/null 2>&1 || true
  reportar "🔌 ENGANCHE FALLÓ ${agent_id}: no apareció ningún pane nuevo en 45 s (¿el harness degradó a in-process? mirá orca terminal list). Corre SIN dispatch: no va a haber worker_done."
  exit 0
fi

# ── 4. Task + dispatch ──────────────────────────────────────────────────────
# La spec es DEFERENTE a propósito: el subagente ya recibió su trabajo real en el
# prompt inicial. El preámbulo que inyecta Orca sólo agrega el protocolo de
# reporte; si la spec describiera otra tarea, competiría con la verdadera.
# Registrar el handle YA, aunque después falle: el siguiente lanzamiento no debe volver a elegir este pane.
printf '%s\n' "$handle" >> "$enganchados"
estado_set --set "agent_type=${agent_type}" --set "handle=${handle}" --set "phase=provisioning" --set "run_id=${run_id}"
spec="Seguí exactamente la tarea que ya recibiste en tu prompt inicial — este bloque no la reemplaza ni la modifica. Lo único que agrega es el protocolo de reporte: mandá worker_done cuando termines, heartbeat mientras trabajás, y usá ask (nunca AskUserQuestion) si necesitás una decisión del orquestador. (subagente ${agent_type}, id ${agent_id})"

crear_task() {
  "$ORCA" orchestration task-create --spec "$spec" --json 2>&1
}

task_out="$(crear_task)"
task_id="$(printf '%s' "$task_out" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['result']['task']['id'])
except Exception: pass" 2>/dev/null)"

# El binding del Run puede perderse ENTRE el `run-use` de más arriba y este
# `task-create` (p. ej. Orca se reinició en el medio), y ahí `task-create`
# responde `run_required` aunque el paso 2 haya salido bien. Un solo reintento
# recreando el Run desde cero cubre esa ventana sin meter un loop infinito.
if [ -z "$task_id" ] && printf '%s' "$task_out" | grep -qi "run_required"; then
  anotar "task-create devolvió run_required pese al run-use previo; recreando Run y reintentando una vez"
  run_create_out="$("$ORCA" orchestration run-create --objective "Sesión ${session_id} — subagentes enganchados automáticamente (re-bind)" --json 2>&1)"
  run_id="$(printf '%s' "$run_create_out" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['result']['run']['id'])
except Exception: pass" 2>/dev/null)"
  if [ -n "$run_id" ]; then
    printf '%s' "$run_id" > "$run_file"
    task_out="$(crear_task)"
    task_id="$(printf '%s' "$task_out" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['result']['task']['id'])
except Exception: pass" 2>/dev/null)"
  else
    anotar "el reintento de run-create tampoco devolvió id: ${run_create_out}"
  fi
fi

if [ -z "$task_id" ]; then
  fallo "no se pudo crear la task en ${handle} (task-create: ${task_out})"
  estado_set --set "hook_attempt=task-create falló" 
  python3 "$ESTADO" --session "$session_id" settle --agent "$agent_id" --reason unhooked >/dev/null 2>&1 || true
  reportar "🔌 ENGANCHE FALLÓ ${agent_id} (${handle}): no se pudo crear la task. El subagente corre SIN dispatch: no va a haber worker_done; verificá su trabajo en disco."
  exit 0
fi

estado_set --set "task_id=${task_id}"
# worker-start sobre el pane que YA creó el Agent tool (S1b, 22/08): readiness real y dispatch nativo
# sin perder el pane hijo. Reintenta mientras Claude todavía no arrancó en el pane (la carrera que
# hizo fallar 13 de 15 enganches con dispatch --inject).
dispatch_id=""; motivo=""
for intento in $(seq 1 20); do
  ws_out="$("$ORCA" orchestration worker-start --task "$task_id" --terminal "$handle" --timeout-ms 15000 --json 2>&1)"
  leido="$(printf '%s' "$ws_out" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin); r=d.get("result") or {}; e=d.get("error") or {}
    print((r.get("dispatchId") or "") if r.get("state")=="ready" else "")
    print(" ".join(str(x) for x in (r.get("state"),r.get("stage") or r.get("failedStage"),e.get("code"),(e.get("message") or "")[:160]) if x))
except Exception:
    print(""); print("salida no JSON")
' 2>/dev/null)"
  dispatch_id="$(printf '%s' "$leido" | sed -n 1p)"
  motivo="$(printf '%s' "$leido" | sed -n 2p)"
  [ -n "$dispatch_id" ] && break
  estado_set --set "hook_attempt=intento ${intento}: ${motivo}"
  sleep 3
done
if [ -z "$dispatch_id" ]; then
  fallo "worker-start no llegó a ready en ${handle} tras ${intento} intentos (task ${task_id}; último: ${motivo})"
  "$ORCA" orchestration task-update --id "$task_id" --status failed --result '{"reason":"unhooked"}' --json >/dev/null 2>&1 || true
  python3 "$ESTADO" --session "$session_id" settle --agent "$agent_id" --reason unhooked >/dev/null 2>&1 || true
  reportar "🔌 ENGANCHE FALLÓ ${agent_id} (${handle}) tras ${intento} intentos: ${motivo}. Task ${task_id} marcada failed. El subagente corre SIN dispatch: no va a haber worker_done; verificá su trabajo en disco."
  exit 0
fi
printf '%s\t%s\t%s\t%s\n' "$agent_id" "$agent_type" "$handle" "$task_id" >> "$mapa"
estado_set --set "dispatch_id=${dispatch_id}" --set "phase=active" --set "turn=running" --set "hook_attempt=ready en intento ${intento}"
anotar "enganchado ${agent_type}/${agent_id} → ${handle} (task ${task_id}, dispatch ${dispatch_id}, intento ${intento})"
reportar "🔗 ENGANCHADO ${agent_id} → ${handle} (dispatch ${dispatch_id}, intento ${intento}). Su fin real es el worker_done; el buzón lo entrega solo."
exit 0
