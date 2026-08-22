---
titulo: "Los mensajes de agentes que no existían — evals fuera de su sandbox (2026-08-11)"
fecha: "2026-08-11"
sistema: "agentes-harness"
tipo: "incidente"
estado: "historico"
tags: [agentes-harness, incidente]
inventariado: "2026-08-21"
---

# Los mensajes de agentes que no existían — evals fuera de su sandbox (2026-08-11)

## El síntoma

El usuario recibía notificaciones de Orca sobre **mensajes de agentes que no podía encontrar**. No
había ningún subagente corriendo. La sospecha natural —el harness de mensajería, que ya había fallado
antes— era falsa.

## Qué pasó realmente

El 11/08 a las **14:29**, la sesión `23643b5b` recibió un `cross-session-message` real, entregado por
el socket `uds:/run/user/1000/cc-socks/50771.sock`:

> STOP INMEDIATO: la premisa del storefront cambió y ya no es válida. Frená cualquier trabajo/código…

Nadie lo escribió. Es **texto literal del escenario `os-3-frenarlo-ya`** de
`.claude/evals/orquestar-subagentes.json`, un escenario que justamente prueba si el sujeto sabe
frenar a un subagente cuando cambia el rumbo.

## El mecanismo

`.claude/evals/correr-evals.py` lanza un "sujeto" por escenario y lo sandboxea con
`--disallowed-tools`. La lista original vetaba **escritura y ejecución**:

```
Write,Edit,NotebookEdit,Bash,Agent,Task
```

El sujeto leyó su consigna —mandale un corte al subagente— y **la cumplió de verdad**: con permisos
reales, contra el socket verdadero de otra sesión del usuario. El sandbox le impedía romper archivos,
pero no hablarle a otro agente.

Que el sujeto haya hecho eso no es un bug del sujeto: hizo exactamente lo que el escenario pedía. El
bug es del arnés, que le dio un teléfono real para una llamada de simulacro.

## Cómo se resolvió

En la misma sesión: se frenó la corrida (`TaskStop bxpag9o1t`), se parchó el runner y se **movieron**
—no se borraron— los resultados corridos sin candado a `orquestar-subagentes.SIN-CANDADO-descartado`.

`correr-evals.py:46` ahora también veta:

```
SendMessage,PushNotification,RemoteTrigger,CronCreate,CronDelete
```

**Verificado el 11/08** que el fix sigue aplicado y que no hay procesos de eval vivos.

## Por qué costó tanto encontrarlo

Tres cosas se sumaron:

1. **El síntoma no se parece a la causa.** "Notificaciones de agentes fantasma" apunta al harness de
   mensajería, no a un archivo JSON de pruebas.
2. **Había tres sesiones solapadas** (`dbebf4df`, `23643b5b`, `514ed3b6`), y las notificaciones no
   dicen de qué tab vienen. Dos de ellas murieron abruptamente con cuatro minutos de diferencia,
   dejando notificaciones sueltas de tabs que ya no existían.
3. **Un huérfano real convivía con el falso positivo**: la sesión `6476e890`, un `supabase-ops` que a
   las 16:07 recibió "reportá al orquestador" y nunca contestó porque su coordinadora ya había
   muerto. Y del run de `dbebf4df` quedó un dispatch en `dispatched` sin cerrar (`censo-flota`).

## Reglas que deja

- **Al sandboxear un sujeto de prueba, vetar comunicación además de escritura y ejecución.** Un
  agente de prueba con acceso al canal real puede actuar sobre sesiones reales.
- **Ante una notificación de un agente que no aparece, grepear el texto en `.claude/evals/*.json`**
  antes de investigar el harness.
- **El aislamiento del sandbox es de directorio, no de entorno.** Ya se había observado que el sujeto
  veía sesiones reales por `ListAgents`; esto es la misma falla, con consecuencias.

## Material rescatado

Los resultados de las evals vivían en el scratchpad de una sesión muerta y se copiaron a
`.claude/evals/resultados/` (86 archivos, 368 KB). Es la única medición existente de si los skills
sirven — y midió, entre otras cosas, que **`entorno-orca` no previene los dos incidentes más caros**
(`eo-2` sin mejora alguna, `eo-3` de 0/5 a 1/5). Esa conclusión está en
`docs/agentes/reestructura-archivos-instrucciones-2026-08-11.md`.
