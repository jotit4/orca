#!/usr/bin/env bash
#
# Entrega al coordinador, SIN que tenga que ir a buscarlo, lo que sus subagentes
# dejaron en el mailbox de orquestación de Orca: worker_done, question (ask
# bloqueante), escalation, status y heartbeats.
#
# Por qué existe: auditado el 21/08/2026, 46 de 58 worker_done, 3 de 5 question y
# 2 de 2 escalation de todos los Runs estaban sin leer ni ackear. El enganche
# (enganchar-subagente-orquestacion.sh) escribía el lado del subagente, pero el
# lado lector dependía de que el coordinador corriera `check` a mano, y no lo
# hacía. Workers quedaron bloqueados en `ask` esperando respuestas que nunca
# llegaron.
#
# Cómo funciona: lo disparan los hooks `PostToolUse` (matcher `*`) y
# `UserPromptSubmit`. Claude Code inyecta el stdout JSON como
# `additionalContext` en el contexto del modelo EN MEDIO del turno, después de
# cada tool call — o sea, el entorno empuja el estado y el modelo no espera al
# cierre del turno para enterarse.
#
# Costo: sólo pagan las sesiones con un Run enganchado (archivo run_id). El
# resto sale en un stat. Con Run, un `check` cuesta ~0,75 s por tool call.
#
# Semántica del ack: el batch se ackea DESPUÉS de inyectarlo. Una Delivery
# ackeada no se replaya, así que cada mensaje entra al contexto una sola vez.
#
# 🔴 `orca` SIEMPRE por ruta absoluta del shim: /usr/bin/orca es el lector de
# pantalla de GNOME y le arranca la voz al usuario.
#
# Nunca falla hacia afuera: ante cualquier problema sale 0 sin stdout.

set -uo pipefail

ORCA_SHIM="/home/jot4dev/.config/orca/linux-orca-cli-shim/orca"
ORCA_FALLBACK="/home/jot4dev/.local/bin/orca-ide"
if [ -x "$ORCA_SHIM" ]; then ORCA="$ORCA_SHIM"
elif [ -x "$ORCA_FALLBACK" ]; then ORCA="$ORCA_FALLBACK"
else exit 0; fi

payload="$(timeout 5 cat)"
[ -n "$payload" ] || exit 0

leer_campo() {
  printf '%s' "$payload" | python3 -c "
import json,sys
try: d=json.load(sys.stdin) or {}
except Exception: sys.exit(0)
print(d.get(sys.argv[1]) or '')" "$1" 2>/dev/null
}
session_id="$(leer_campo session_id)"
evento="$(leer_campo hook_event_name)"
[ -n "$session_id" ] || exit 0

# No entregarse a sí mismo: el propio check/ack que corre el coordinador desde
# Bash no debe disparar otra lectura encima.
if [ "$evento" = "PostToolUse" ]; then
  cmd="$(printf '%s' "$payload" | python3 -c "
import json,sys
try: print((json.load(sys.stdin).get('tool_input') or {}).get('command') or '')
except Exception: pass" 2>/dev/null)"
  case "$cmd" in *"orchestration check"*|*"orchestration reply"*) exit 0 ;; esac
fi

run_file="/tmp/waengine-orquestacion/${session_id}/run_id"
[ -f "$run_file" ] || exit 0
run_id="$(cat "$run_file" 2>/dev/null)"
[ -n "$run_id" ] || exit 0

# Log persistente (fuera de tmpfs) para auditar qué se entregó y cuándo.
log_dir="${HOME}/.local/state/waengine-orquestacion"
mkdir -p "$log_dir" 2>/dev/null || true
log="${log_dir}/buzon-${session_id}.log"

salida="$("$ORCA" orchestration check --run "$run_id" --json 2>/dev/null)"
[ -n "$salida" ] || exit 0

vigilar=0
marca="/tmp/waengine-orquestacion/${session_id}/_vigilante.ultimo"
if [ "$evento" = "UserPromptSubmit" ]; then vigilar=1
elif [ ! -f "$marca" ] || [ "$(( $(date +%s) - $(stat -c %Y "$marca" 2>/dev/null || echo 0) ))" -ge 60 ]; then vigilar=1; fi
[ "$vigilar" = 1 ] && touch "$marca" 2>/dev/null
export EVENTO="${evento:-PostToolUse}" RUN_ID="$run_id" SALIDA="$salida" SESSION_ID="$session_id" VIGILAR="$vigilar" VIGILAR_MIN="${WAENGINE_VIGILANTE_MIN:-20}"
resultado="$(python3 - <<'PY'
import json, os, sys
try:
    d = json.loads(os.environ["SALIDA"])
except Exception:
    sys.exit(0)
if not d.get("ok"):
    sys.exit(0)
r = d.get("result") or {}
msgs = r.get("messages") or []
delivery = r.get("deliveryId") or ""

def corto(s, n):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"

def payload(m):
    p = m.get("payload")
    if isinstance(p, str):
        try: p = json.loads(p)
        except Exception: p = {}
    return p if isinstance(p, dict) else {}

lineas = []
heartbeats = []
for m in msgs:
    t = m.get("type") or "?"
    p = payload(m)
    origen = m.get("from_handle") or "?"
    if t == "heartbeat":
        heartbeats.append(origen)
        continue
    ref = []
    if p.get("taskId"): ref.append(f"task {p['taskId']}")
    if p.get("dispatchId"): ref.append(f"dispatch {p['dispatchId']}")
    if p.get("outcome"): ref.append(f"outcome {p['outcome']}")
    cab = f"[{t.upper()}] {m.get('id')} de {origen}" + (f" ({', '.join(ref)})" if ref else "")
    if m.get("subject"):
        cab += f" — {corto(m['subject'], 120)}"
    cuerpo = corto(m.get("body"), 1200 if t in ("question", "escalation") else 700)
    lineas.append(cab + "\n  " + cuerpo)
    if t == "question":
        lineas.append(f"  → Contestar con: orca orchestration reply --id {m.get('id')} --run {os.environ['RUN_ID']} --body \"...\"  (el worker está BLOQUEADO esperando)")

if heartbeats:
    vivos = sorted(set(heartbeats))
    lineas.append(f"[HEARTBEAT] {len(heartbeats)} latido(s) de {len(vivos)} worker(s) vivo(s): {', '.join(vivos)}")

# Estado por subagente: heartbeat -> last_heartbeat_at; worker_done -> settle con outcome
import subprocess
ESTADO = "__PROYECTO__/.claude/scripts/orquestacion-estado.py"
SESSION = os.environ.get("SESSION_ID", "")
def estado(*args):
    try:
        return subprocess.run(["python3", ESTADO, "--session", SESSION, *args], capture_output=True, text=True, timeout=40).stdout.strip()
    except Exception:
        return ""
for m in msgs:
    t = m.get("type"); origen = m.get("from_handle") or ""
    if t == "heartbeat" and origen:
        estado("heartbeat", "--handle", origen)
    elif t == "worker_done" and origen:
        oc = (payload(m).get("outcome") or "").lower()
        estado("settle", "--handle", origen, "--reason", "completed" if oc in ("succeeded", "success", "ok") else "failed", "--outcome", oc or "desconocido")
# Vigilante de abandonados: avisa, no decide
if os.environ.get("VIGILAR") == "1":
    avisos = estado("vigilar", "--minutos", os.environ.get("VIGILAR_MIN", "20"))
    if avisos:
        lineas.append("[VIGILANTE]\n  " + avisos.replace("\n", "\n  "))
if not lineas:
    print(json.dumps({"delivery": delivery, "n": len(msgs), "out": None}))
    sys.exit(0)

texto = (
    f"📬 Buzón de orquestación Orca (run {os.environ['RUN_ID']}, {len(msgs)} mensaje(s), entregados y ackeados automáticamente):\n"
    + "\n".join(lineas)
    + "\nUn worker_done con outcome es el fin REAL del subagente; verificá su trabajo en disco antes de darlo por cerrado."
)
out = {"hookSpecificOutput": {"hookEventName": os.environ["EVENTO"], "additionalContext": texto}}
print(json.dumps({"delivery": delivery, "n": len(msgs), "out": out}))
PY
)"
[ -n "$resultado" ] || exit 0

delivery="$(printf '%s' "$resultado" | python3 -c "import json,sys; print(json.load(sys.stdin)['delivery'])" 2>/dev/null)"
n="$(printf '%s' "$resultado" | python3 -c "import json,sys; print(json.load(sys.stdin)['n'])" 2>/dev/null)"

# Primero inyectar, después ackear: si el ack falla, el batch se replaya y se
# vuelve a entregar en el próximo tool call (duplicado, pero nunca perdido).
printf '%s' "$resultado" | python3 -c "
import json,sys; o=json.load(sys.stdin)['out']
if o: print(json.dumps(o, ensure_ascii=False))"

if [ -n "$delivery" ] && [ "${n:-0}" != "0" ]; then
  ack_out="$("$ORCA" orchestration check --run "$run_id" --ack "$delivery" --peek --json 2>&1)"
  ack_ok="$(printf '%s' "$ack_out" | python3 -c "
import json,sys
try: print('ok' if json.load(sys.stdin).get('ok') else 'fallo')
except Exception: print('fallo')" 2>/dev/null)"
else
  ack_ok="sin-delivery"
fi
printf '[%s] %s run=%s delivery=%s mensajes=%s ack=%s\n' "$(date -Is)" "${evento:-?}" "$run_id" "$delivery" "$n" "$ack_ok" >> "$log" 2>/dev/null || true
exit 0
