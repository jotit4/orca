#!/usr/bin/env bash
# Detecta líneas rotas en los perfiles de shell del usuario.
#
# Por qué existe: el 07/08/2026 un agente instaló Deno DENTRO de su scratchpad
# (efímero) y el instalador escribió `. "<ruta>/deno/env"` en ~/.bashrc, ~/.profile
# y ~/.bash_profile. Al morir esa sesión la ruta desapareció y TODO shell nuevo
# empezó a fallar al arrancar. El harness de subagentes crea panes con shells que
# leen esos perfiles, y el ruido en el arranque es candidato directo al
# "Failed to create teammate pane: tmux: Timed out waiting for split pane handle".
#
# El síntoma es feo de diagnosticar (un pane que no aparece) y la causa es trivial,
# así que conviene verla al instante. Correr antes de lanzar una flota de subagentes.
#
# Sale con 0 si todo está sano, 1 si encontró referencias rotas.

set -uo pipefail

PERFILES=(
  "$HOME/.bashrc"
  "$HOME/.profile"
  "$HOME/.bash_profile"
  "$HOME/.bash_login"
  "$HOME/.zshrc"
  "$HOME/.zprofile"
)

rotas=0

for perfil in "${PERFILES[@]}"; do
  [[ -f "$perfil" ]] || continue

  # Sólo las líneas que cargan otro archivo: `. ruta` o `source ruta`.
  # Se ignoran comentarios y se resuelve $HOME para poder comprobar la existencia.
  while IFS=: read -r numero resto; do
    [[ -n "$resto" ]] || continue

    # Quitar el `.`/`source` inicial y quedarse con el primer argumento,
    # sin comillas. Se hace con expansiones de bash, no evaluando la línea:
    # evaluarla sería ejecutar el contenido del perfil.
    ruta="${resto#"${resto%%[! ]*}"}"        # sin espacios a la izquierda
    ruta="${ruta#source }"
    ruta="${ruta#. }"
    ruta="${ruta#"${ruta%%[! ]*}"}"
    ruta="${ruta%% *}"                        # sólo el primer argumento
    ruta="${ruta%\"}"; ruta="${ruta#\"}"      # sin comillas dobles
    ruta="${ruta%\'}"; ruta="${ruta#\'}"      # sin comillas simples
    [[ -n "$ruta" ]] || continue

    resuelta="${ruta/#\$HOME/$HOME}"
    resuelta="${resuelta/#\~/$HOME}"

    # Una ruta con variables sin resolver no se puede comprobar sin evaluarla,
    # y evaluar contenido del perfil sería ejecutar código: se declara y se sigue.
    if [[ "$resuelta" == *'$'* ]]; then
      continue
    fi

    if [[ ! -e "$resuelta" ]]; then
      echo "ROTA  $perfil:$numero"
      echo "      carga «$resuelta», que no existe"
      if [[ "$resuelta" == /tmp/* ]]; then
        echo "      ⚠️  apunta a /tmp: casi seguro un instalador que corrió dentro de un scratchpad efímero"
      fi
      rotas=$((rotas + 1))
    fi
  done < <(grep -nE '^[[:space:]]*(\.|source)[[:space:]]+[^[:space:]]' "$perfil" 2>/dev/null)
done

if [[ "$rotas" -eq 0 ]]; then
  echo "Perfiles de shell sanos: ninguna referencia rota."
  exit 0
fi

echo
echo "$rotas referencia(s) rota(s). Cada shell nuevo va a escribir un error al arrancar,"
echo "y eso puede impedir que el harness cree el pane de un subagente."
echo "Arreglo: borrar esas líneas (con backup) y reinstalar el runtime fuera del scratchpad."
exit 1
