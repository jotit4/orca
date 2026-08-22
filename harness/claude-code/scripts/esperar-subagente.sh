#!/usr/bin/env bash
# Envuelve `orca orchestration check --wait` con dos guardas que el protocolo
# actual no tiene, tomadas del mecanismo de espera de Herdr (src/api/wait.rs):
#
#   1. GUARDA DE IDENTIDAD: antes de aceptar un worker_done, se verifica que
#      su task_id/dispatch_id sean EXACTAMENTE los que este script está
#      esperando, y además se relee el estado autoritativo con
#      `dispatch-show`/`worker-show` en vez de confiar en el payload del
#      evento que despertó la espera. Orca tiene un issue abierto (#13858)
#      donde un worker_done con identidad desajustada devuelve ok:true y la
#      tarea nunca se completa realmente — esta guarda existe para no caer
#      en ese falso positivo.
#
#   2. GUARDA DE ACTIVIDAD: `idle` (o un worker_done recién llegado) NO es
#      sinónimo de "terminó de verdad". Está medido que el primer `idle` de
#      un subagente llegó 60 segundos ANTES del fin real del trabajo. Este
#      script lee `.claude/estado-agentes/<id>.json` — que otro componente
#      escribe con la última actividad REAL derivada de tool calls, nunca de
#      lo que el modelo declara — y si esa actividad es demasiado reciente,
#      no da el trabajo por terminado todavía: espera un poco más y lo dice
#      por salida en vez de cerrar en silencio.
#
# Este script SOLO LEE .claude/estado-agentes/*.json. Ese directorio lo
# escribe otro componente del harness; si no existe, se degrada con gracia
# (aviso explícito, mismo comportamiento que el check --wait de siempre).
#
# Salidas:
#   0 = terminado con éxito       (worker_done outcome=succeeded, identidad OK)
#   1 = terminado con fallo       (worker_done outcome=failed, o escalation)
#   3 = timeout, SIGUE VIVO       (no llegó worker_done pero hay actividad reciente)
#   4 = timeout, ABANDONADO       (no llegó worker_done y no hay actividad reciente)
#   2 = INDETERMINADO             (args inválidos, CLI de Orca no disponible,
#                                   o timeout sin ninguna señal de actividad)
#
# Requiere: orca (resuelto según la skill `orchestration`, nunca el binario
# `orca` a secas fuera de una terminal de Orca — ver más abajo), y `jq`.

set -uo pipefail

# --- Resolución del binario de Orca, siguiendo la skill `orchestration` ---
# Nunca `orca` a secas fuera de una terminal de Orca: en esta máquina
# resuelve al lector de pantalla de GNOME (/usr/bin/orca) y le arranca la
# voz al usuario. Orden: ORCA_CLI_COMMAND (sesiones WSL gestionadas) >
# orca-dev (checkout de desarrollo, si ORCA_DEV_REPO_ROOT está seteado) >
# orca-ide (Linux, fuera de una terminal de Orca) > orca (dentro de Orca).
resolver_orca() {
  if [[ -n "${ORCA_CLI_COMMAND:-}" ]]; then
    echo "$ORCA_CLI_COMMAND"
    return 0
  fi
  if [[ -n "${ORCA_DEV_REPO_ROOT:-}" ]] && command -v orca-dev >/dev/null 2>&1; then
    echo "orca-dev"
    return 0
  fi
  if command -v orca-ide >/dev/null 2>&1; then
    echo "orca-ide"
    return 0
  fi
  if command -v orca >/dev/null 2>&1; then
    echo "orca"
    return 0
  fi
  return 1
}

ORCA_BIN="$(resolver_orca)" || {
  echo "ERROR: no encontré un binario de Orca resoluble (ORCA_CLI_COMMAND, orca-dev, orca-ide, orca)." >&2
  echo "No corro 'orca' a ciegas: fuera de una terminal de Orca en Linux resuelve al lector de pantalla de GNOME." >&2
  exit 2
}

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: falta 'jq'. No lo instalo (regla dura: nada de instaladores desde este script)." >&2
  exit 2
fi

# --- Argumentos --------------------------------------------------------
TASK_ID=""
DISPATCH_ID=""
AGENT_ID=""
ESTADO_FILE=""
TIMEOUT_MS=900000            # 15 min por defecto, igual que el ejemplo de la skill
POLL_MS=60000                # cuánto dura cada llamada a `check --wait` antes de re-evaluar
UMBRAL_ACTIVIDAD_SEG="${ESPERAR_SUBAGENTE_UMBRAL_ACTIVIDAD_SEG:-90}"
REPO_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESTADO_DIR="${ESPERAR_SUBAGENTE_ESTADO_DIR:-$REPO_ROOT_DEFAULT/.claude/estado-agentes}"
MAX_REINTENTOS_GRACIA=3

uso() {
  cat >&2 <<EOF
Uso: $(basename "${BASH_SOURCE[0]}") --task <task_id> --dispatch <dispatch_id> [opciones]

Obligatorios:
  --task <id>          Task ID de la orquestación (orca orchestration task-create).
  --dispatch <id>       Dispatch ID (orca orchestration dispatch / worker-start).

Opcionales:
  --agent-id <id>       Nombre del archivo de estado a leer: .claude/estado-agentes/<id>.json
  --estado-file <ruta>  Ruta explícita al archivo de estado (tiene prioridad sobre --agent-id).
  --timeout-ms <n>      Timeout total de la espera. Default: 900000 (15 min).
  --poll-ms <n>         Duración de cada tramo de 'check --wait' antes de reevaluar. Default: 60000.
  --umbral-actividad-seg <n>
                        Si la última actividad registrada es más reciente que esto, no se da
                        el trabajo por terminado sin una re-verificación. Default: 90
                        (env ESPERAR_SUBAGENTE_UMBRAL_ACTIVIDAD_SEG).

Sin --agent-id ni --estado-file, intenta heurísticamente
.claude/estado-agentes/<dispatch_id>.json; si tampoco existe, degrada con
aviso (sin guarda de actividad, igual que un check --wait común).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK_ID="${2:-}"; shift 2 ;;
    --dispatch) DISPATCH_ID="${2:-}"; shift 2 ;;
    --agent-id) AGENT_ID="${2:-}"; shift 2 ;;
    --estado-file) ESTADO_FILE="${2:-}"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="${2:-}"; shift 2 ;;
    --poll-ms) POLL_MS="${2:-}"; shift 2 ;;
    --umbral-actividad-seg) UMBRAL_ACTIVIDAD_SEG="${2:-}"; shift 2 ;;
    -h|--help) uso; exit 2 ;;
    *) echo "Argumento desconocido: $1" >&2; uso; exit 2 ;;
  esac
done

if [[ -z "$TASK_ID" || -z "$DISPATCH_ID" ]]; then
  echo "ERROR: --task y --dispatch son obligatorios (guarda de identidad: sin ellos no hay" >&2
  echo "contra qué comparar un worker_done entrante)." >&2
  uso
  exit 2
fi

if [[ -z "$ESTADO_FILE" ]]; then
  if [[ -n "$AGENT_ID" ]]; then
    ESTADO_FILE="$ESTADO_DIR/$AGENT_ID.json"
  else
    # Heurística: si no se dio agent-id, probar con el dispatch_id como nombre
    # de archivo. Es sólo una conveniencia; si no existe, se degrada abajo.
    ESTADO_FILE="$ESTADO_DIR/$DISPATCH_ID.json"
  fi
fi

echo "== Espera guardada de subagente =="
echo "  Orca CLI:        $ORCA_BIN"
echo "  task_id:          $TASK_ID"
echo "  dispatch_id:      $DISPATCH_ID"
echo "  timeout total:    ${TIMEOUT_MS} ms"
echo "  tramo de poll:     ${POLL_MS} ms"
echo "  umbral actividad: ${UMBRAL_ACTIVIDAD_SEG} s"
echo "  archivo de estado: $ESTADO_FILE"
echo

if [[ -f "$ESTADO_FILE" ]]; then
  echo "  (guarda de actividad ACTIVA: el archivo de estado existe)"
else
  echo "  ⚠️  El archivo de estado no existe todavía. Degrado con gracia: sin guarda de"
  echo "      actividad hasta que aparezca (comportamiento clásico de check --wait)."
fi
echo

# --- Helpers -------------------------------------------------------------

epoch_ahora() { date +%s; }

# Lee ultima_actividad (epoch, segundos) del archivo de estado. Vacío si no
# existe o no se puede parsear. Sólo LEE — nunca escribe este archivo.
leer_ultima_actividad() {
  [[ -f "$ESTADO_FILE" ]] || return 1
  jq -r '.ultima_actividad // empty' "$ESTADO_FILE" 2>/dev/null
}

leer_tool_count() {
  [[ -f "$ESTADO_FILE" ]] || return 1
  jq -r '.tool_count // empty' "$ESTADO_FILE" 2>/dev/null
}

# Devuelve 0 (hay actividad reciente) / 1 (no hay, o no se pudo leer) por
# código de salida; imprime el detalle a stdout para que el llamador lo loguee.
hay_actividad_reciente() {
  local ultima ahora edad
  ultima="$(leer_ultima_actividad)"
  if [[ -z "$ultima" || ! "$ultima" =~ ^[0-9]+$ ]]; then
    echo "sin dato de actividad utilizable"
    return 1
  fi
  ahora="$(epoch_ahora)"
  edad=$(( ahora - ultima ))
  if [[ "$edad" -lt 0 ]]; then edad=0; fi
  if [[ "$edad" -lt "$UMBRAL_ACTIVIDAD_SEG" ]]; then
    echo "actividad hace ${edad}s (< umbral ${UMBRAL_ACTIVIDAD_SEG}s), tool_count=$(leer_tool_count 2>/dev/null || echo '?')"
    return 0
  fi
  echo "actividad hace ${edad}s (>= umbral ${UMBRAL_ACTIVIDAD_SEG}s)"
  return 1
}

# Relee el estado AUTORITATIVO del dispatch, en vez de confiar en el payload
# del mensaje que despertó la espera. Devuelve el JSON crudo por stdout.
releer_estado_autoritativo() {
  "$ORCA_BIN" orchestration dispatch-show --task "$TASK_ID" --json 2>/dev/null
}

# --- Loop principal --------------------------------------------------------

deadline_ms=$(( $(date +%s%3N) + TIMEOUT_MS ))
terminado=0
resultado_final=""   # succeeded | failed | escalation
grace_rounds=0

while true; do
  ahora_ms=$(date +%s%3N)
  restante_ms=$(( deadline_ms - ahora_ms ))
  if [[ "$restante_ms" -le 0 ]]; then
    break
  fi
  tramo_ms=$POLL_MS
  if [[ "$restante_ms" -lt "$tramo_ms" ]]; then
    tramo_ms=$restante_ms
  fi

  echo "-- esperando hasta ${tramo_ms} ms más (restan $((restante_ms/1000))s de timeout total) --"

  salida_check="$("$ORCA_BIN" orchestration check --wait \
      --types worker_done,escalation,question \
      --timeout-ms "$tramo_ms" --json 2>/tmp/esperar-subagente-check.stderr.$$)"
  rc_check=$?
  rm -f "/tmp/esperar-subagente-check.stderr.$$" 2>/dev/null

  if [[ "$rc_check" -ne 0 ]]; then
    echo "  aviso: 'orchestration check' salió con código $rc_check (puede ser timeout normal del tramo)."
  fi

  if [[ -z "$salida_check" ]]; then
    echo "  sin mensajes en este tramo, sigo esperando."
    continue
  fi

  # Schema real verificado en vivo el 11/08/2026 contra esta instalación de
  # Orca (orchestration check --wait --json):
  #   { ok, result: { runId, deliveryId, messages: [ { id, type, subject,
  #     body, payload: "<json-string>", ... } ], count, timedOut, ... } }
  # `payload` es un STRING con JSON adentro (taskId/dispatchId/outcome en
  # camelCase), no un objeto — hay que parsearlo aparte con `fromjson`.
  mensajes="$(echo "$salida_check" | jq -c '.result.messages[]? // empty' 2>/dev/null)"

  if [[ -z "$mensajes" ]]; then
    echo "  la respuesta de 'check' no trajo mensajes (timeout del tramo o {count:0}), sigo esperando."
    continue
  fi

  delivery_id="$(echo "$salida_check" | jq -r '.result.deliveryId // empty' 2>/dev/null)"

  aceptado_este_tramo=0

  while IFS= read -r msg; do
    [[ -n "$msg" ]] || continue
    tipo="$(echo "$msg" | jq -r '.type // empty')"
    # `payload` es un string JSON-encoded (ver comentario de schema arriba);
    # si no parsea como JSON (mensaje sin payload, u otro formato), se
    # degrada a vacío en vez de romper el script.
    payload_json="$(echo "$msg" | jq -r '.payload // empty' 2>/dev/null)"
    if [[ -n "$payload_json" ]]; then
      msg_task="$(echo "$payload_json" | jq -r '.taskId // .task_id // empty' 2>/dev/null)"
      msg_dispatch="$(echo "$payload_json" | jq -r '.dispatchId // .dispatch_id // empty' 2>/dev/null)"
      outcome="$(echo "$payload_json" | jq -r '.outcome // empty' 2>/dev/null)"
    else
      msg_task=""; msg_dispatch=""; outcome=""
    fi

    echo "  mensaje recibido: type=$tipo task_id=$msg_task dispatch_id=$msg_dispatch outcome=$outcome"

    case "$tipo" in
      worker_done|escalation)
        # --- GUARDA DE IDENTIDAD ---
        if [[ -n "$msg_task" && "$msg_task" != "$TASK_ID" ]] || \
           [[ -n "$msg_dispatch" && "$msg_dispatch" != "$DISPATCH_ID" ]]; then
          echo "  ❌ IDENTIDAD DESAJUSTADA: esperaba task=$TASK_ID dispatch=$DISPATCH_ID," \
               "llegó task=$msg_task dispatch=$msg_dispatch."
          echo "     NO se acepta este $tipo (ver Orca #13858: un worker_done con identidad" \
               "desajustada puede devolver ok:true y no completar nada). Sigo esperando."
          continue
        fi

        if [[ "$tipo" == "escalation" ]]; then
          echo "  🚨 ESCALATION con identidad OK: el subagente pide intervención, no es un cierre normal."
          terminado=1
          resultado_final="escalation"
          aceptado_este_tramo=1
          continue
        fi

        # --- RELECTURA DE ESTADO AUTORITATIVO ---
        # Schema real verificado en vivo (dispatch-show --json):
        #   { result: { dispatch: { id, run_id, task_id, status, ... } } }
        estado_json="$(releer_estado_autoritativo)"
        estado_dispatch_id="$(echo "$estado_json" | jq -r '.result.dispatch.id // empty' 2>/dev/null)"
        estado_task="$(echo "$estado_json" | jq -r '.result.dispatch.status // empty' 2>/dev/null)"
        if [[ -z "$estado_json" || -z "$estado_task" ]]; then
          echo "  ⚠️  No pude releer el estado autoritativo con dispatch-show. No cierro sobre" \
               "el solo payload del mensaje: sigo esperando y reintento."
          continue
        fi
        if [[ -n "$estado_dispatch_id" && "$estado_dispatch_id" != "$DISPATCH_ID" ]]; then
          echo "  ❌ IDENTIDAD DESAJUSTADA en la relectura autoritativa: dispatch-show del" \
               "task esperado devuelve dispatch.id=$estado_dispatch_id, no $DISPATCH_ID." \
               "No cierro sobre esto: sigo esperando."
          continue
        fi
        echo "  estado autoritativo (dispatch-show): status=$estado_task"

        if [[ "$estado_task" != "completed" && "$estado_task" != "failed" ]]; then
          echo "  ⚠️  El mensaje dice $tipo pero dispatch-show todavía informa '$estado_task'." \
               "No lo doy por terminado hasta que el estado autoritativo lo confirme."
          continue
        fi

        # --- GUARDA DE ACTIVIDAD ---
        detalle_actividad="$(hay_actividad_reciente)"
        if [[ $? -eq 0 ]]; then
          grace_rounds=$((grace_rounds + 1))
          if [[ "$grace_rounds" -le "$MAX_REINTENTOS_GRACIA" ]]; then
            echo "  ⏳ worker_done con identidad y estado OK, pero hay $detalle_actividad." \
                 "No lo doy por terminado todavía (reintento $grace_rounds/$MAX_REINTENTOS_GRACIA):" \
                 "sigo esperando unos segundos más para no repetir el patrón medido de" \
                 "'idle' 60s antes del fin real."
            sleep 5
            continue
          else
            echo "  ⏳ Actividad reciente persiste tras $MAX_REINTENTOS_GRACIA reintentos de gracia;" \
                 "acepto igual el worker_done porque el estado autoritativo ya confirma '$estado_task'."
          fi
        else
          echo "  ($detalle_actividad — no bloquea el cierre)"
        fi

        terminado=1
        resultado_final="${outcome:-$estado_task}"
        aceptado_este_tramo=1
        ;;
      question)
        echo "  (mensaje 'question' — no es responsabilidad de este script; que lo atienda" \
             "el coordinador con 'orca orchestration reply'. Sigo esperando el worker_done.)"
        ;;
      *)
        echo "  (tipo de mensaje no manejado por esta guarda: $tipo. Se ignora.)"
        ;;
    esac
  done <<< "$mensajes"

  if [[ -n "$delivery_id" ]]; then
    "$ORCA_BIN" orchestration check --ack "$delivery_id" --json >/dev/null 2>&1 || \
      echo "  aviso: no pude confirmar el --ack de $delivery_id (no crítico, se reintentará en el próximo check)."
  fi

  if [[ "$terminado" -eq 1 ]]; then
    break
  fi
done

echo

if [[ "$terminado" -eq 1 ]]; then
  if [[ "$resultado_final" == "escalation" ]]; then
    echo "== RESULTADO: ESCALATION =="
    echo "El subagente pidió intervención del coordinador (identidad verificada). No es un" \
         "cierre exitoso ni un fallo silencioso: hay que atenderlo."
    exit 1
  elif [[ "$resultado_final" == "succeeded" || "$resultado_final" == "completed" ]]; then
    echo "== RESULTADO: TERMINADO CON ÉXITO =="
    echo "worker_done aceptado: identidad verificada (task=$TASK_ID dispatch=$DISPATCH_ID)," \
         "estado autoritativo confirmado, sin actividad reciente bloqueante."
    exit 0
  else
    echo "== RESULTADO: TERMINADO CON FALLO =="
    echo "worker_done aceptado con outcome/estado '$resultado_final' (identidad verificada)."
    exit 1
  fi
fi

# --- Timeout: distinguir sigue-vivo vs abandonado -------------------------
echo "== RESULTADO: TIMEOUT sin worker_done aceptado =="
detalle_actividad="$(hay_actividad_reciente)"
rc_actividad=$?

if [[ ! -f "$ESTADO_FILE" ]]; then
  echo "INDETERMINADO: no hay archivo de estado ($ESTADO_FILE) para distinguir 'sigue vivo'" \
       "de 'abandonado'. Es el mismo comportamiento ciego de un 'check --wait' sin esta guarda:" \
       "hay que ir a mirar el dispatch a mano."
  echo "  orca orchestration dispatch-show --task $TASK_ID --json"
  echo "  orca orchestration worker-show --dispatch $DISPATCH_ID --json"
  exit 2
fi

if [[ "$rc_actividad" -eq 0 ]]; then
  echo "SIGUE VIVO: expiró el timeout total (${TIMEOUT_MS}ms) sin worker_done, pero hay $detalle_actividad."
  echo "No lo doy por abandonado. Recomendación: volver a correr este script con un timeout mayor," \
       "no matar ni reiniciar el subagente."
  exit 3
else
  echo "ABANDONADO (probable): expiró el timeout total (${TIMEOUT_MS}ms) sin worker_done, y $detalle_actividad."
  echo "El dispatch puede haber quedado en 'dispatched' sin heartbeat. Antes de asumir nada," \
       "confirmar con:"
  echo "  orca orchestration worker-show --dispatch $DISPATCH_ID --json"
  exit 4
fi
