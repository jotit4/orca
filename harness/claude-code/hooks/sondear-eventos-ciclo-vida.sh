#!/usr/bin/env bash
# Sondeo temporal: registra QUÉ eventos del ciclo de vida de subagentes disparan
# de verdad, y con qué payload, distinguiendo subagentes in-process de panes reales.
#
# Por qué existe: el harness notifica "idle" hasta 60 s ANTES de que el subagente
# termine de trabajar, y ya provocó que se editaran archivos que otro agente seguía
# escribiendo. Si SubagentStop / TeammateIdle / TaskCompleted disparan con panes
# reales, hay señal explícita de fin y sobra la heurística de actividad.
#
# Ya sabemos que SubagentStart NO dispara con panes reales (sólo in-process). Esto
# mide el resto sin suponer nada.
#
# BORRAR cuando el sondeo esté concluido: desenganchar de settings.json y borrar
# este archivo. No es infraestructura permanente.
#
# Uso como hook: recibe el JSON del evento por stdin. Nunca falla: sale 0 siempre.

set -u

LOG="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/estado-agentes/_sondeo-eventos.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || exit 0

# Timeout defensivo: si stdin nunca cierra, no colgamos el turno del usuario.
payload=""
IFS= read -r -t 2 -d '' payload 2>/dev/null || true

# El nombre del evento viene en el payload; el matcher no lo pasa por argumento.
SONDEO_LOG="$LOG" SONDEO_PAYLOAD="$payload" python3 <<'PY' 2>/dev/null || true
import json, os, sys, time

log = os.environ["SONDEO_LOG"]
raw = os.environ.get("SONDEO_PAYLOAD", "")
try:
    d = json.loads(raw) if raw.strip() else {}
except Exception:
    d = {}

# Qué distingue un pane real de un subagente in-process: el pane corre en su propio
# proceso, con su propio $TMUX / handle de terminal. Registramos ambas pistas.
campos = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "evento": d.get("hook_event_name", "?"),
    "session_id": (d.get("session_id") or "")[:8],
    "agent_id": (d.get("agent_id") or "")[:12],
    "agent_type": d.get("agent_type") or "",
    "claves": ",".join(sorted(d.keys()))[:300],
    "tmux": os.environ.get("TMUX", "")[:40],
    "pane": os.environ.get("TMUX_PANE", ""),
}
linea = " | ".join(f"{k}={v}" for k, v in campos.items())
with open(log, "a", encoding="utf-8") as fh:
    fh.write(linea + "\n")
PY

exit 0
