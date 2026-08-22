---
titulo: "El desfase de mensajes con subagentes: medido y resuelto"
fecha: "2026-08-10"
sistema: "agentes-harness"
tipo: "incidente"
estado: "historico"
tags: [agentes-harness, incidente]
inventariado: "2026-08-21"
---

# El desfase de mensajes con subagentes: medido y resuelto

**Fecha:** lunes 10 de agosto de 2026
**Estado:** DIAGNOSTICADO con mediciones propias. La causa no es de Orca y no se puede arreglar,
pero **existe una mitigación real y verificada** que no estábamos usando.
**Antecedente:** `mensajeria-subagentes-mecanismo-resuelto-2026-08-10.md` y el incidente del
07/08/2026, donde una decisión del usuario llegó tarde y se ignoró.

---

## 1. La pregunta

Desde el 07/08 arrastrábamos la idea de que "la mensajería del harness no interrumpe: se entrega en
los límites de turno, así que entre mandar algo y que el otro lo lea pasan minutos". Nunca se había
medido, ni se sabía **de qué lado** estaba la demora.

## 2. Lo que se midió

Todas las marcas salen de ejecutar `date -Is` en cada punta.

| Escenario | Envío | Lectura | Latencia |
|---|---|---|---|
| Receptor **inactivo** | 18:33:58 | 18:34:02 | **4 s** |
| Receptor **ocupado** (turno de 37 s) | 18:35:12 | 18:35:33 | **21 s** |
| Receptor ocupado + **`--interrupt`** | 18:42:39 | 18:42:43 | **4 s** ✅ |

En el caso ocupado, la propia sonda lo confirmó: *"no llegó nada al buzón mientras redactaba el
texto de 900+ palabras entre 18:34:48 y 18:35:25"*. El mensaje esperó a que cerrara el turno.

## 3. La causa, con el código a la vista

Orca **no** retiene nada. Leyendo su fuente (`stablyai/orca`):

- `sendKeys` del shim (`src/main/runtime/claude-agent-teams-tmux-dispatcher.ts`) **escribe directo**
  en la terminal destino: sin cola, sin debounce, sin agrupar. Sólo verifica que el pty esté vivo.
- El único gate de "readiness" que existe (`terminal-agent-send-guard.ts`,
  `active-agent-terminal-send-readiness.ts`) **no está en ese camino**: es opt-in de otro RPC.
- No hay ningún retraso configurable aplicable, ni logger que registre la entrega.

O sea que **la demora es enteramente de Claude Code**, que procesa su buzón al cerrar turno. Es un
binario propietario: no hay nada que parchear, a diferencia del bug de panes que sí arreglamos.

**Pero hay un riesgo distinto del retraso: un `send-keys` puede perderse en silencio.** El camino
sólo comprueba liveness del pty (`orca-runtime.ts:16511-16567`): si `leaf.writable` es falso o el
pty está *probado* ausente, el envío muere con `terminal_not_writable` y **nadie reintenta**. Un
estado "desconocido", en cambio, deja pasar la escritura. Como **no existe ningún log de entrega**
—se buscó y no hay—, un mensaje perdido no deja rastro en ninguna parte. Conclusión operativa: no
dar por recibido un mensaje porque el `send` haya devuelto ok; si algo importa, se confirma por la
orquestación (acuse) o leyendo el pane.

Detalle menor pero útil si algún día se toca ese código: `writeTerminalAction:17079` espera 500 ms
entre texto y suffix cuando vienen juntos, pero **no aplica acá**, porque el shim traduce el token
`Enter` a `\r` dentro del mismo string (`claude-agent-teams-tmux-compat.ts:116-136`).

**Corolario:** la latencia de un mensaje **no es un valor fijo**, es *lo que le falte al receptor
para terminar lo que está haciendo*. Con un turno de 37 s fueron 21 s; con un agente razonando y
escribiendo código durante cinco minutos, son cinco minutos. Eso explica el 07/08 sin misterio.

## 4. La mitigación que faltaba: `--interrupt`

`orca terminal send` acepta `--interrupt`, y **corta el turno en curso**:

```bash
orca terminal send --terminal <handle-del-pane> \
  --text "CORTE: dejá de escribir. <nueva instrucción>" --interrupt --enter --json
```

Verificado: la sonda estaba escribiendo un texto de 3500 palabras, se le mandó el corte a los 25
segundos, y **paró a mitad de una oración** con ~950 palabras escritas, reportando el corte 4
segundos después. No es un mensaje que espera: es una interrupción real.

**Cuándo usarlo:** cuando el usuario cambia de rumbo, cuando un agente arrancó con una premisa que
dejó de valer, o cuando hay que frenar algo antes de que toque archivos. Para todo lo demás, el
mensaje normal alcanza.

**Cuidado:** interrumpe de verdad, o sea que el agente pierde el hilo de lo que estaba produciendo.
No usarlo por impaciencia con un agente que está trabajando bien.

## 5. El cuadro completo del ciclo de vida

- **Coordinador → hijo, urgente:** `terminal send --interrupt` (4 s).
- **Coordinador → hijo, normal:** `SendMessage`, que espera al fin del turno.
- **Hijo → coordinador, necesita decisión:** `orca orchestration ask`, que **bloquea al hijo**
  hasta la respuesta (10,7 s medidos el 10/08).
- **Hijo → coordinador, terminé:** `worker_done`, exacto y una sola vez.
- **Nunca:** creerle al `idle`. Se midió llegando hasta 60 s antes del fin real, y también sobre
  agentes cuyo pane ya no existía.

## 6. Notas metodológicas (para no repetir errores)

- **`terminal read` no muestra el texto mientras se genera.** El pane se ve vacío durante todo el
  turno y el contenido aparece de golpe al final. Por eso no sirve para detectar "está trabajando":
  hay que disparar a ciegas sabiendo cuánto tarda la tarea.
- **`Worked for 39s` es un turno TERMINADO**, no "lleva 39 s trabajando". Confundirlo invalidó la
  primera prueba de `--interrupt`: se le escribió a un agente ya inactivo y pareció una
  interrupción. Lo detectó el usuario.
- Un subagente en pane **no puede mandar a `main`** (él mismo es la sesión principal de su pane):
  debe dirigirse a `team-lead`.
