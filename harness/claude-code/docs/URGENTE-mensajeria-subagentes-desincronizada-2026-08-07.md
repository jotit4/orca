---
titulo: "🔴 URGENTE — La mensajería con subagentes está desincronizada"
fecha: "2026-08-07"
sistema: "agentes-harness"
tipo: "incidente"
estado: "superado"
tags: [agentes-harness, incidente]
inventariado: "2026-08-21"
---

# 🔴 URGENTE — La mensajería con subagentes está desincronizada

> **⚠️ ACTUALIZACIÓN 10/08/2026 — el §6 de este documento ya está contestado.**
> Orca tiene una capa de orquestación (`orca orchestration ...`), habilitada y sin usar, que provee
> acuse de recibo, `ask` bloqueante y una señal de "terminé" distinguible de `idle`. Y se puede
> enganchar a los **panes hijos del `Agent` tool**, sin abrir terminales nuevas. Todo verificado y
> medido en `mensajeria-subagentes-mecanismo-resuelto-2026-08-10.md` — **leer ese documento antes
> que éste**. Lo de acá sigue valiendo como diagnóstico del problema y como historia de lo que costó.

**Fecha:** 7 de agosto de 2026
**Estado:** diagnosticado con evidencia de una sesión completa. **MECANISMO RESUELTO EL 10/08**
(automatización escrita, sin validar end-to-end).
**Prioridad:** alta — costó trabajo duplicado, un archivo roto y una decisión del usuario ignorada
en una sola jornada.

> Planteado por el usuario al cierre: *"todos estos errores que hemos tenido hoy sobre los mensajes
> cruzados, mensajes que se pisan, trabajo en paralelo con comunicación desincronizada… creo que hay
> una cola de mensajes, como que lo que vos enviés espera a que el proceso actual de ese pane hijo
> agente termine la tarea actual para meter el mensaje que enviaste, y viceversa cuando te envían
> mensajes a vos: si estás en algo, no te llega o interrumpe en el momento. Puede derivar a que
> sigamos teniendo estos errores si no lo investigamos y corregimos."*

**La hipótesis del usuario coincide con todo lo observado.** Este documento reúne la evidencia.

---

## 1. El mecanismo, según lo observado

La mensajería entre el orquestador y los subagentes **no interrumpe**: se entrega en los límites de
turno del receptor. Un mensaje enviado mientras el receptor está ejecutando una tarea larga queda
encolado y se procesa recién cuando ese receptor termina el paso en curso. Lo mismo en la dirección
inversa: los reportes de los subagentes llegan al orquestador junto al resultado de su próxima
llamada a herramienta, no en el instante en que se emiten.

Consecuencia directa: **entre que se manda una instrucción y que el destinatario la lee pueden pasar
minutos**, y durante esa ventana ambos siguen actuando sobre premisas distintas.

## 2. Evidencia medida (todo del 07/08)

| # | Qué pasó | Costo |
|---|---|---|
| 1 | El subagente pidió OK para instalar `@modelcontextprotocol/sdk`. El usuario decidió **no**. Se le mandó la decisión. Él ya había instalado: *"esperé una respuesta razonable sin que llegara"* | Una pasada entera de trabajo rehecha |
| 2 | Un subagente quedó `idle` sin reportar el fix de seguridad. Se asumió que no lo había encarado y **se editó su archivo**. Lo estaba escribiendo | `debugger.service.ts` con dos implementaciones pisadas y sin compilar |
| 3 | Ese subagente detectó el archivo pisado y preguntó si había otro agente. La respuesta ya estaba enviada | Bloqueo hasta que se cruzaron los mensajes |
| 4 | Se le pidieron 3 cosas al agente de UI; su reporte con 2 de ellas ya estaba en camino. Pasó dos veces seguidas | Dos rondas de "esto ya estaba hecho" |
| 5 | `ListAgents` no mostraba subagentes que estaban vivos y trabajando | Imposible verificar el estado real por esa vía |

## 3. Los dos agravantes

**`idle` no significa "terminó".** La notificación dice `idleReason: "available"` — el agente no
tiene nada en curso *en ese instante*. La interfaz lo muestra como *finished*. Un agente puede
quedar idle entre dos pasos, esperando una respuesta, o justo antes de retomar. La única señal
confiable de que terminó es **su reporte final**, o el par `shutdown_approved` +
`teammate_terminated` tras un pedido de cierre.

**No hay acuse de recibo.** Quien manda un mensaje no sabe si llegó, si fue leído, ni si el
destinatario ya actuó en sentido contrario. Toda la coordinación descansa en suponer.

## 4. Por qué importa más de lo que parece

El modo de trabajo del repo es orquestación con subagentes en paralelo. Si la coordinación entre
ellos es asíncrona sin garantías, **el paralelismo introduce exactamente los errores que venía a
evitar**: dos agentes sobre el mismo archivo, decisiones del usuario que llegan tarde, trabajo
duplicado. Hoy no se perdió nada grave porque se detectó a tiempo — dos de las cinco veces lo
detectó el usuario, no el orquestador.

## 5. Mitigaciones inmediatas (aplicables sin cambiar el harness)

1. **Todo lo que condiciona el trabajo va en el prompt inicial, no en un mensaje posterior.** Si una
   decisión puede tardar, el prompt debe decir explícitamente *"no hagas X hasta que yo confirme;
   si no llega respuesta, esperá"* — nunca dejar que el subagente resuelva la ambigüedad por su
   cuenta, como pasó con el SDK.
2. **Nunca dos agentes sobre el mismo archivo.** El reparto por archivos disjuntos funcionó todo el
   día; el único incidente fue el orquestador entrando al archivo de un agente.
3. **Nunca editar un archivo asignado a un agente que no entregó su reporte final.** Verificar
   leyendo está bien; escribir, no.
4. **Verificar el estado en disco, no por `ListAgents` ni por notificaciones.** `git status`, fechas
   de modificación y `grep` dicen la verdad; las notificaciones no.
5. **Al frenar algo, asumir latencia**: dar por hecho que el agente sigue trabajando varios minutos
   más y que puede haber avanzado en la dirección que se quiere frenar.

## 6. Qué falta investigar (el trabajo real) — ✅ CONTESTADO EL 10/08/2026

Detalle completo y mediciones en `mensajeria-subagentes-mecanismo-resuelto-2026-08-10.md`.

- ~~**Confirmar el mecanismo en el harness**~~ → los mensajes del canal `idle`/notificaciones son
  ruidosos y llegan desalineados; los de la capa de orquestación llegan una vez y son exactos.
  Medido: `idle "available"` llegó **60 s antes** del `worker_done` real de la misma agente.
- ~~**¿Existe forma de interrumpir de verdad a un subagente?**~~ → No, pero **sí de bloquearlo**:
  `orca orchestration ask` frena al worker hasta la respuesta del coordinador. Medido: 10,7 s.
- ~~**Acuse de recibo**~~ → Sí: *Deliveries* FIFO que se re-entregan hasta `check --ack <id>`.
- ~~**Por qué `ListAgents` no ve agentes vivos**~~ → No es un bug: son dos registros distintos. Los
  subagentes del `Agent` tool no crean provenance de task/dispatch en Orca **hasta que se los
  engancha** con `dispatch --inject --to <handle>`.
- ~~**Señal explícita de "terminé"**~~ → `worker_done` (obligatorio, una sola vez, con `outcome`),
  más `heartbeat` y `escalation`. Un worker abandonado queda visible como `dispatched` sin heartbeat.

## 7. Relación con WAEngine OS

No es sólo un problema del entorno de trabajo: **WAEngine OS orquesta agentes** (Módulo 4, el
pipeline de `01-agentes-pipeline.md`, con seis agentes coordinados y gates entre etapas). Si el
mecanismo de coordinación tiene estas propiedades, el pipeline las hereda. Vale resolverlo antes de
construir esa parte, no después.
