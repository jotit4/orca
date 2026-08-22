#!/usr/bin/env bash
#
# Hook PostToolUse (matcher "*"): registra que un agente EJECUTÓ una tool. Es la
# señal de actividad real que reemplaza al `idle` del harness — `idle` significa
# "el turno visible terminó", no "el trabajo terminó": medido, el primer `idle`
# llegó 60 s ANTES del fin real de un subagente, y ya provocó que se editaran
# archivos que ese subagente seguía escribiendo. La salida que sí funciona (y que
# usan las 6 integraciones de Herdr con "full lifecycle hook authority" —
# `pi`/`omp`/`mastracode`/`opencode`/`kilo`/`kimi`, ver
# scratchpad/herdr-research/spec-comportamiento-herdr.md §2.3) es que el propio
# agente empuje estado por un hook, no que el orquestador lo adivine. Un modelo
# se olvida de reportar que sigue vivo; una tool ejecutada es un hecho que no se
# puede fingir.
#
# ── Identidad del agente: qué hay disponible y qué tan confiable es ─────────
#
# La doc oficial de hooks (code.claude.com/docs/en/hooks) dice que `agent_id`
# identifica de forma estable a un subagente y que su AUSENCIA es la señal de
# "esto es la sesión principal". Pero esa doc describe el CLI de Claude Code
# puro; acá se corre dentro del Claude Agent SDK, con subagentes lanzados como
# panes reales (procesos `claude` separados, cada uno ajeno a que lo lanzó un
# `Agent` tool). Verificado EN VIVO durante el desarrollo de este mismo hook,
# no sólo leyendo doc: un único `session_id` de subagente produjo TRES valores
# de `agent_id` nativo distintos a lo largo de ~6 tool calls del mismo turno
# (los tres quedaron en disco con `tool_count` 3/4/6 — evidencia real, no
# teórica). O sea que acá `agent_id` SÍ está presente para subagentes en panes
# (contra lo que se esperaba por doc/por cómo describe `enganchar-subagente-
# orquestacion.sh` el comportamiento de `SubagentStart`), pero rota dentro del
# mismo subagente — no sirve como clave estable.
#
# `session_id`, en cambio, se sostuvo idéntico en esa misma corrida. Es el
# único campo verificado estable, así que es la ÚNICA clave: se usa siempre
# como valor de `agent_id` en el contrato (nunca el nativo, que rota). El
# `agent_id` nativo, cuando aparece, se guarda aparte en un campo extra sólo
# informativo (`agent_id_nativo_ultimo`) — no pisa la clave. Esto es lo que
# hoy se sabe con certeza empírica; si más adelante se confirma que la
# rotación tiene un patrón (p. ej. uno por lote de tool calls paralelas), vale
# la pena revisarlo — pero mientras tanto `session_id` es lo único que no
# rompió en la prueba real.
#
# Efecto práctico: este hook escribe un archivo también para la sesión del
# COORDINADOR (todo `session_id` que pasa por acá recibe archivo, sea
# coordinador o subagente — no hay campo que distinga confiablemente ambos
# casos). Es inofensivo — el consumidor sólo mira los `session_id` que él
# mismo dispachó — y la limpieza automática de abajo evita que se acumule.
#
# ── Requisitos duros de este hook ────────────────────────────────────────────
# Corre en CADA tool call de CADA agente: tiene que ser baratísimo. Primera
# versión (sed×5 + tr + mktemp + date + stat, un fork por cada uno) medía
# ~42-45ms reales — por encima del margen aceptado. El costo no era el trabajo
# en sí, era la cantidad de procesos externos lanzados: en esta máquina cada
# fork ronda 2-3ms. La reescritura de abajo hace TODO con builtins de bash
# 5.3 — matching de campos vía `[[ =~ ]]`/`BASH_REMATCH`, timestamp vía
# `printf '%(%s)T'`, lectura de archivo vía `$(<archivo)` — y deja como únicos
# forks los imprescindibles: `mkdir` (sólo la primera vez que no existe el
# directorio) y `mv` (el rename atómico, que no tiene builtin). Medido de punta
# a punta (incluye el arranque del propio intérprete bash, ~5-9ms de eso):
# ~8-10ms, contra ~42-45ms de la primera versión. Nada de red, nada de
# payloads grandes. Si algo falla, sale 0 y sin
# ruido — un hook que se cuelga o que aborta el turno es peor que perder una
# muestra de actividad.

set -uo pipefail

# Lectura de stdin 100% builtin (sin `cat`/`timeout`): `-d ''` lee hasta EOF
# (no hay NUL en un payload JSON), `-t 2` es la misma red de seguridad de
# antes ante un stdin que no cierra.
payload=""
IFS= read -r -t 2 -d '' payload || true
[ -n "$payload" ] || exit 0

# Extracción de campos top-level con regex de bash: 0 forks (ni siquiera un
# subshell — asigna por nameref, no por `$(...)`, porque una sustitución de
# comando SÍ forkea aunque llame a una función). Los campos que importan
# (session_id, agent_id, tool_name, agent_type) son UUIDs o identificadores
# simples que Claude Code siempre emite como `"campo":"valor"` sin escapes —
# de sobra para este uso interno.
extraer() {
  local -n _destino="$2"
  if [[ "$payload" =~ \"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    _destino="${BASH_REMATCH[1]}"
  else
    _destino=""
  fi
}

extraer session_id session_id
extraer agent_id agent_id_nativo
extraer agent_type agent_type
extraer tool_name tool_name

[ -n "$session_id" ] || exit 0

# Verificado EN VIVO, no sólo por doc: en una corrida real de este mismo hook
# durante el desarrollo, un único `session_id` de subagente produjo TRES
# valores de `agent_id` nativo distintos a lo largo de ~6 tool calls (evidencia
# en el reporte de la sesión que implementó este hook). La doc de Claude Code
# CLI describe `agent_id` como estable por subagente, pero acá — corriendo
# dentro del Claude Agent SDK, no del CLI puro — rota dentro de un mismo
# `session_id`. Usarlo como clave partiría la actividad de un mismo subagente
# en varios archivos y el `tool_count` dejaría de significar nada.
#
# `session_id` sí se sostuvo estable en esa misma corrida (idéntico en los 3
# archivos). Es, por lejos, el campo más confiable de los dos, así que es la
# ÚNICA clave: se usa siempre como valor de `agent_id` en el contrato (nunca el
# nativo). El `agent_id` nativo, cuando aparece, se guarda aparte en un campo
# extra sólo informativo — no pisa la clave.
agent_id="$session_id"
if [ -n "$agent_id_nativo" ]; then
  origen="session_id_estable_agent_id_nativo_rota"
else
  origen="session_id_unico_disponible"
fi

# JSON-escape barato con substitución de parámetros de bash. Asigna por
# nameref en vez de `$(escapar ...)`: una sustitución de comando forkea un
# subshell aunque adentro sólo haya una función, y hacerlo 5 veces (una por
# campo) fue la diferencia entre ~24ms y lo que sigue midiéndose más abajo.
# La barra invertida va primero, si no se duplicarían las que introduce el
# propio escape de comillas.
escapar() {
  local -n _dst="$2"
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  _dst="$v"
}

# Validar en vez de sanear: si `session_id` no tiene la pinta de un id/UUID
# simple, se descarta la muestra en lugar de mutilarlo con `tr` (que además
# forkea). Todo `session_id` real de Claude Code cumple esto sobrado.
[[ "$agent_id" =~ ^[A-Za-z0-9_.-]+$ ]] || exit 0
agent_id_fs="$agent_id"

estado_dir="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/estado-agentes"
[ -d "$estado_dir" ] || mkdir -p "$estado_dir" 2>/dev/null || exit 0

archivo="${estado_dir}/${agent_id_fs}.json"
# Temp file sin `mktemp` (fork): PID + RANDOM alcanzan para unicidad dentro de
# un directorio que sólo este hook escribe.
tmp="${archivo}.tmp.$$.${RANDOM}"
trap 'rm -f "$tmp" 2>/dev/null' EXIT

# Timestamp por builtin (`printf '%(%s)T'`, bash ≥4.2), sin forkear `date`.
printf -v ahora '%(%s)T' -1

# tool_count acumulado: leer el valor previo (si lo hay) y sumar 1. Best-effort
# — si dos tool calls en paralelo pisan la lectura, el peor caso es un conteo
# aproximado, no un archivo corrupto (la escritura sigue siendo atómica).
# `$(<archivo)` es la forma que documenta el propio manual de bash para leer
# un archivo entero sin invocar `cat`.
prev_count=0
if [ -f "$archivo" ]; then
  contenido_previo="$(<"$archivo")" 2>/dev/null || contenido_previo=""
  if [[ "$contenido_previo" =~ \"tool_count\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
    prev_count="${BASH_REMATCH[1]}"
  fi
fi
tool_count=$((prev_count + 1))

escapar "$agent_id" agent_id_esc
escapar "$session_id" session_id_esc
escapar "$agent_type" agent_type_esc
escapar "$tool_name" tool_name_esc
escapar "$agent_id_nativo" agent_id_nativo_esc

printf '{"agent_id":"%s","ultima_actividad":%s,"tool_count":%s,"session_id":"%s","agent_type":"%s","tool_name":"%s","agent_id_nativo_ultimo":"%s","identidad_origen":"%s"}\n' \
  "$agent_id_esc" "$ahora" "$tool_count" "$session_id_esc" "$agent_type_esc" \
  "$tool_name_esc" "$agent_id_nativo_esc" "$origen" > "$tmp" 2>/dev/null || exit 0

mv -f "$tmp" "$archivo" 2>/dev/null || exit 0
trap - EXIT

# ── Limpieza sin acumulación indefinida ──────────────────────────────────────
# No hacer un `find` completo en cada invocación (barrer el directorio en cada
# tool call no es "barato"). Se dispara como mucho una vez por hora; el costo
# el resto de las veces es leer un archivo marcador de unos bytes (builtin,
# sin `stat`), y la limpieza en sí se manda a segundo plano para no sumar
# latencia al hook.
marcador="${estado_dir}/.ultima-limpieza"
necesita_limpieza=1
if [ -f "$marcador" ]; then
  marca_previa="$(<"$marcador")" 2>/dev/null || marca_previa=0
  [[ "$marca_previa" =~ ^[0-9]+$ ]] || marca_previa=0
  if [ $(( ahora - marca_previa )) -lt 3600 ]; then
    necesita_limpieza=0
  fi
fi
if [ "$necesita_limpieza" -eq 1 ]; then
  printf '%s' "$ahora" > "$marcador" 2>/dev/null || true
  ( find "$estado_dir" -maxdepth 1 -name '*.json' -mmin +720 -delete 2>/dev/null & disown ) 2>/dev/null || true
fi

exit 0
