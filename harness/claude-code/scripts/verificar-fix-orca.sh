#!/usr/bin/env bash
# Verifica que el AppImage de Orca EN USO (el que está montado y corriendo ahora
# mismo) tenga aplicado el fix de paneo de subagentes (forgetTerminalHandle).
#
# Por qué existe: el usuario corre un AppImage de Orca parcheado a mano
# (~/Descargas/orca-linux.AppImage, ver docs/agentes/cerrar-panes-de-subagentes-
# rompe-el-harness). El 11/08/2026 una actualización pisó ese binario y el fix
# desapareció EN SILENCIO: nadie se enteró hasta horas después, cuando volvió a
# aparecer "Failed to create teammate pane: tmux: terminal_exited". Este script
# convierte ese fallo silencioso en un chequeo explícito, corrible a demanda o
# antes de lanzar una flota de subagentes.
#
# Método (verificado en vivo el 11/08/2026, Orca 1.4.180):
#   - Los procesos de Orca corren desde un mount tipo /tmp/.mount_orca-XXXXXX/,
#     uno por cada proceso que ejecutó el AppImage (la app principal Y cada CLI
#     `orca ...` que lanza un subagente). El bundle vive en
#     <mount>/resources/app.asar (asar sin empaquetar comprimido: es legible
#     con grep -a directo, sin extraer).
#   - grep -a -c forgetTerminalHandle cuenta las ocurrencias del símbolo del fix.
#     Con el fix: >0. Sin el fix (medido hoy sobre el binario pisado): 0.
#   - Control de sanidad: removeTeamForLeaderHandle es un símbolo vecino que
#     SIEMPRE debería estar (con o sin fix) y dio 6 ocurrencias en la medición de
#     hoy. Si este control también da 0, los símbolos no están legibles como
#     texto plano (asar reempaquetado, ofuscado, etc.) y el método de detección
#     dejó de servir — hay que decirlo en vez de reportar un falso negativo.
#
# Salida: 0 = fix presente, 1 = fix ausente, 2 = no se pudo determinar
# (Orca cerrado, o el control de sanidad falló).

set -uo pipefail

# Un símbolo por fix del fork, en orden cronológico. Todos deben estar para que el veredicto sea ✅.
#   forgetTerminalHandle    aef3a445b9 (10/08) panes muertos fuera del shim
#   withLiveHandle          56483dc9   (11/08) re-resolución de handles por paneKey
#   waitForTerminalAgent    2b5e8565a6 (22/08) readiness al adjuntarse a un pane existente
#   autoAttachTeammateToRun (22/08) dispatch automático al nacer el pane del teammate
SIMBOLOS_FIX=(forgetTerminalHandle withLiveHandle waitForTerminalAgent autoAttachTeammateToRun)
SIMBOLO_FIX="${SIMBOLOS_FIX[*]}"
SIMBOLO_CONTROL="removeTeamForLeaderHandle"
APPIMAGE_DESCARGADO="$HOME/Descargas/orca-linux.AppImage"

echo "== Verificación del fix de panes de subagentes en el Orca en uso =="
echo

# --- 1. Detectar mounts activos del AppImage ------------------------------
mapfile -t mounts < <(
  ps -eo args 2>/dev/null \
    | grep -oE '/tmp/\.mount_orca-[A-Za-z0-9]+' \
    | sort -u
)

if [[ "${#mounts[@]}" -eq 0 ]]; then
  echo "Orca no parece estar corriendo ahora mismo (no encontré ningún proceso"
  echo "orca-ide con mount /tmp/.mount_orca-*)."
  echo
  echo "No se puede verificar el fix sin un proceso vivo. Abrí Orca y reintentá."
  exit 2
fi

echo "Mounts activos encontrados: ${#mounts[@]}"
for m in "${mounts[@]}"; do
  echo "  - $m"
done
echo

# --- 2. Elegir el asar a inspeccionar --------------------------------------
# Todos los mounts activos son instancias del MISMO AppImage (la app principal
# y cada CLI que lanzaron los subagentes), así que en condiciones normales dan
# el mismo resultado. Se verifican TODOS por si alguno quedó de una versión
# vieja a medio desmontar, y se avisa si no coinciden.
asares=()
for m in "${mounts[@]}"; do
  asar="$m/resources/app.asar"
  if [[ -f "$asar" ]]; then
    asares+=("$asar")
  else
    echo "⚠️  $m no tiene resources/app.asar (mount parcial o en desmontaje). Se ignora."
  fi
done

if [[ "${#asares[@]}" -eq 0 ]]; then
  echo
  echo "Ninguno de los mounts activos tiene un app.asar legible."
  echo "No se puede determinar el estado del fix."
  exit 2
fi

# --- 3. Grep del fix + control de sanidad en cada asar ----------------------
resultado_general=""   # "presente" | "ausente" | "" (indeterminado)
huboIndeterminado=0
huboAusente=0
huboPresente=0

for asar in "${asares[@]}"; do
  n_control=$(grep -a -c "$SIMBOLO_CONTROL" "$asar" 2>/dev/null || true)
  n_control=${n_control:-0}
  n_fix=1; faltan=()
  echo "-- $asar --"
  for simbolo in "${SIMBOLOS_FIX[@]}"; do
    n=$(grep -a -c "$simbolo" "$asar" 2>/dev/null || true); n=${n:-0}
    echo "   $simbolo: $n ocurrencia(s)"
    [[ "$n" -eq 0 ]] && { n_fix=0; faltan+=("$simbolo"); }
  done
  [[ ${#faltan[@]} -gt 0 ]] && echo "   faltan: ${faltan[*]}"
  echo "   $SIMBOLO_CONTROL (control de sanidad): $n_control ocurrencia(s)"

  if [[ "$n_control" -eq 0 ]]; then
    echo "   ⚠️  El control de sanidad también da 0: el método grep -a sobre el asar"
    echo "       dejó de servir para este binario (¿asar reempaquetado/ofuscado/comprimido"
    echo "       de otra forma?). Este mount queda como INDETERMINADO, no como 'sin fix'."
    huboIndeterminado=1
  elif [[ "$n_fix" -eq 0 ]]; then
    echo "   ❌ FIX AUSENTE en este mount."
    huboAusente=1
  else
    echo "   ✅ Fix presente en este mount."
    huboPresente=1
  fi
  echo
done

# --- 4. Info del AppImage descargado ----------------------------------------
echo "== AppImage en disco =="
if [[ -f "$APPIMAGE_DESCARGADO" ]]; then
  fecha_mod=$(date -r "$APPIMAGE_DESCARGADO" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "desconocida")
  echo "  $APPIMAGE_DESCARGADO"
  echo "  Última modificación: $fecha_mod"
else
  echo "  No se encontró $APPIMAGE_DESCARGADO (¿está en otra ruta?)."
fi

# Versión de la app: preferir el argumento --app-version del proceso daemon
# vivo (más confiable que buscar texto en el asar), con fallback a grep.
version=""
version=$(ps -eo args 2>/dev/null | grep -oE -- '--app-version [0-9]+\.[0-9]+\.[0-9]+' | head -1 | awk '{print $2}')
if [[ -z "$version" ]]; then
  version=$(grep -a -o -m1 -E '"version": ?"[0-9]+\.[0-9]+\.[0-9]+"' "${asares[0]}" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
fi
if [[ -n "$version" ]]; then
  echo "  Versión de la app en ejecución: $version"
else
  echo "  No pude determinar la versión de la app en ejecución."
fi
echo

# --- 5. Veredicto final -------------------------------------------------
echo "== Veredicto =="
if [[ "$huboIndeterminado" -eq 1 && "$huboAusente" -eq 0 && "$huboPresente" -eq 0 ]]; then
  echo "INDETERMINADO: el método de detección (grep de símbolos en texto plano del"
  echo "asar) no sirve para el binario actual. No asumas que el fix falta ni que está:"
  echo "revisá a mano (por ejemplo abriendo un pane de subagente y viendo si sobrevive"
  echo "al cierre de otro) o actualizá este script con otro método de detección."
  exit 2
fi

if [[ "$huboAusente" -eq 1 ]]; then
  echo "❌ FIX AUSENTE: al menos un mount activo de Orca NO tiene forgetTerminalHandle."
  echo "   Esto es lo que pasó el 11/08/2026: una actualización pisó"
  echo "   ~/Descargas/orca-linux.AppImage y el parche manual se perdió."
  echo
  echo "   Acción: volver a aplicar el parche sobre el AppImage actual (o restaurar"
  echo "   el AppImage parcheado desde el backup si existe uno con otro nombre, p.ej."
  echo "   orca-linux-ORIGINAL.AppImage era el SIN parchear — no lo confundas) y"
  echo "   reiniciar Orca. Hasta entonces, cerrar un pane de subagente por cualquier"
  echo "   vía puede dejar el harness sin poder crear panes nuevos."
  exit 1
fi

echo "✅ FIX PRESENTE: forgetTerminalHandle está en el binario en ejecución."
if [[ "$huboIndeterminado" -eq 1 ]]; then
  echo "   (con al menos un mount indeterminado — revisar el detalle arriba)."
fi
exit 0
