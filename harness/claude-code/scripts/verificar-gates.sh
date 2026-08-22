#!/usr/bin/env bash
# Verifica que cada gate declarado en .claude/gates.manifest haya corrido de verdad.
#
# Tres estados por gate: CORRIÓ-OK, CORRIÓ-FALLÓ (exit != 0 en el marker), NO-CORRIÓ (marker ausente
# o más viejo que la última actividad de su disparador menos la tolerancia). Un gate "-" sin
# "No runtime invariant:" es un error del manifiesto, no un gate verde.
#
# Referencia de actividad (fuente independiente de los hooks: el transcript que escribe Claude Code):
#   PreToolUse/PostToolUse → último tool_use del transcript de la sesión
#   UserPromptSubmit       → último mensaje de usuario del transcript
#   manual                 → ahora (el marker debe tener menos de <tolerancia> segundos)
#
# Uso: como hook UserPromptSubmit (stdin JSON; imprime additionalContext SÓLO si hay fallos, exit 0)
#      o manual: verificar-gates.sh [--session <id>] [--transcript <ruta>]  (exit 1 si hay fallos)
set -uo pipefail
ROOT="__PROYECTO__"
MANIFEST="${ROOT}/.claude/gates.manifest"
GATES="/tmp/waengine-orquestacion/_gates"
modo="manual"; session=""; transcript=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) session="$2"; shift 2 ;;
    --transcript) transcript="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ ! -t 0 ]; then
  payload="$(timeout 3 cat 2>/dev/null || true)"
  if [ -n "$payload" ]; then
    modo="hook"
    eval "$(printf '%s' "$payload" | python3 -c '
import json,sys
try: d=json.load(sys.stdin) or {}
except Exception: d={}
print("session=%r; transcript=%r" % (d.get("session_id") or "", d.get("transcript_path") or ""))' 2>/dev/null)"
  fi
fi
if [ -z "$transcript" ]; then
  # Slug de Claude Code para el directorio de transcripts: la ruta del proyecto con todo lo no alfanumérico → "-"
  proj="${HOME}/.claude/projects/$(printf '%s' "$ROOT" | sed 's#[^A-Za-z0-9]#-#g')"
  if [ -n "$session" ] && [ -f "${proj}/${session}.jsonl" ]; then transcript="${proj}/${session}.jsonl"
  else transcript="$(ls -t "${proj}"/*.jsonl 2>/dev/null | head -1)"; fi
fi
export MANIFEST GATES TRANSCRIPT="$transcript" SESSION="$session" MODO="$modo"
python3 - <<'PY'
import json, os, sys, time
from datetime import datetime, timezone

def iso_a_epoch(s):
    try: return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception: return None

# --- referencia de actividad desde el transcript (fuente independiente de los hooks)
ult_tool = ult_user = None
try:
    with open(os.environ["TRANSCRIPT"], "rb") as f:
        f.seek(0, 2); tam = f.tell(); f.seek(max(0, tam - 400_000))
        for linea in f.read().decode("utf-8", "ignore").splitlines():
            try: j = json.loads(linea)
            except Exception: continue
            ts = iso_a_epoch(j.get("timestamp") or "")
            if not ts: continue
            m = j.get("message") or {}
            c = m.get("content")
            if j.get("type") == "assistant" and isinstance(c, list) and any(x.get("type") == "tool_use" for x in c if isinstance(x, dict)):
                ult_tool = max(ult_tool or 0, ts)
            if j.get("type") == "user" and isinstance(c, str):
                ult_user = max(ult_user or 0, ts)
except Exception:
    pass
ahora = time.time()
ref = {"PreToolUse": ult_tool, "PostToolUse": ult_tool, "UserPromptSubmit": ult_user or ahora, "manual": ahora}

fallos, ok, sin_chequeo = [], [], []
for linea in open(os.environ["MANIFEST"], encoding="utf-8"):
    linea = linea.strip()
    if not linea or linea.startswith("#"): continue
    partes = [p.strip() for p in linea.split("|", 3)]
    if len(partes) < 4:
        fallos.append(f"manifiesto: línea mal formada: {linea[:80]}"); continue
    nombre, evento, tol, resto = partes
    archivo = resto.split()[0] if resto else ""
    ruta = os.path.join(os.path.dirname(os.path.dirname(os.environ["MANIFEST"])), archivo)
    if archivo and not os.path.exists(ruta):
        fallos.append(f"{nombre}: el archivo declarado no existe ({archivo})"); continue
    if tol == "-":
        if "No runtime invariant:" not in resto:
            fallos.append(f"{nombre}: sin tolerancia y sin 'No runtime invariant:' que explique por qué")
        else:
            sin_chequeo.append(nombre)
        continue
    try: tol = int(tol)
    except ValueError:
        fallos.append(f"{nombre}: tolerancia no numérica '{tol}'"); continue
    marker = os.path.join(os.environ["GATES"], nombre + ".ran")
    try:
        m = json.load(open(marker)); m_epoch = float(m.get("epoch") or 0); m_exit = int(m.get("exit") or 0)
    except Exception:
        m_epoch, m_exit = None, None
    referencia = ref.get(evento)
    if referencia is None:
        sin_chequeo.append(f"{nombre} (sin actividad {evento} en el transcript)"); continue
    if m_epoch is None:
        if referencia > ahora - tol or evento == "manual":
            fallos.append(f"{nombre}: NO CORRIÓ nunca (sin marker) aunque hubo actividad {evento}")
        else:
            sin_chequeo.append(f"{nombre} (sin marker, sin actividad reciente)")
        continue
    if evento == "manual":
        if ahora - m_epoch > tol:
            fallos.append(f"{nombre}: marker de hace {int((ahora - m_epoch) // 3600)} h (tolerancia {tol // 3600} h) — correrlo")
        elif m_exit != 0:
            fallos.append(f"{nombre}: CORRIÓ y FALLÓ (exit {m_exit}) hace {int((ahora - m_epoch) // 60)} min")
        else:
            ok.append(nombre)
        continue
    if m_epoch < referencia - tol:
        fallos.append(f"{nombre}: NO CORRIÓ — última actividad {evento} hace {int((ahora - referencia) // 60)} min, último marker hace {int((ahora - m_epoch) // 60)} min")
    elif m_exit not in (0, 2):  # exit 2 en PreToolUse = denegó a propósito: es el gate funcionando
        fallos.append(f"{nombre}: CORRIÓ y FALLÓ (exit {m_exit}) hace {int((ahora - m_epoch) // 60)} min")
    else:
        ok.append(nombre)

# --- invariante del enganche: ningún agente clavado en provisioning
try:
    est = json.load(open(f"/tmp/waengine-orquestacion/{os.environ['SESSION']}/estado.json"))
    for a in est.get("agentes", {}).values():
        if a.get("phase") == "provisioning":
            c = iso_a_epoch(a.get("created_at") or "") or ahora
            if ahora - c > 300:
                fallos.append(f"enganchar-subagente: {a['agent_id']} lleva {int((ahora - c) // 60)} min en provisioning sin resolverse")
except Exception:
    pass

if os.environ["MODO"] == "hook":
    if fallos:
        texto = "🚧 GATES DEL ENTORNO: " + str(len(fallos)) + " problema(s) — un gate que no corre NO es un gate verde:\n  " + "\n  ".join(fallos)
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": texto}}, ensure_ascii=False))
    sys.exit(0)
print(f"transcript: {os.environ['TRANSCRIPT']}")
print(f"OK ({len(ok)}): {', '.join(ok) or '-'}")
print(f"sin chequeo de frescura ({len(sin_chequeo)}): {', '.join(sin_chequeo) or '-'}")
if fallos:
    print(f"FALLOS ({len(fallos)}):"); [print("  ✗ " + f) for f in fallos]; sys.exit(1)
print("FALLOS (0)")
PY
