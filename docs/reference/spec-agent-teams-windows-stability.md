---
title: Estabilizar Claude Agent Teams con panes en Windows
type: bugfix
created: 2026-09-13
status: in-review
baseline_commit: bf36396cff2c5db5009babaf4c140d303e4cbed9
context: [AGENTS.md, docs/reference/audit-agent-teams-windows-2026-09-13.md]
---

<frozen-after-approval reason="Delegación del usuario: tomar las riendas y ejecutar la propuesta de estabilización">

## Intent

**Problem:** El fork abre panes en Windows pero puede perder su identidad después de respawn; los caminos de lanzamiento divergen y el workflow no valida el producto empaquetado. Esto impide confiar en él para trabajo diario.

**Approach:** Endurecer el ciclo de vida, compartir la decisión de lanzamiento y validar el contrato completo con pruebas de regresión y un gate sobre el artefacto real. Mantener explícita la diferencia entre corrección local, evidencia Windows y aceptación con Claude autenticado.

## Boundaries & Constraints

**Always:** Preservar el cambio previo en config/electron-builder.config.cjs. Respetar AGENTS.md. Mantener comportamiento POSIX y aislamiento de hosts. Usar pruebas significativas con limpieza realista. Registrar límites de verificación. Mantener compatibilidad de wire para clientes remotos.

**Ask First:** Uso de credenciales personales para una sesión de Claude real, publicación o instalación sobre el entorno laboral. Mientras el usuario está ausente, completar todo el trabajo local independiente de estas acciones y documentar la aceptación pendiente.

**Never:** Sobrescribir trabajo ajeno, empujar o desplegar cambios, desactivar reglas lint, certificar Windows sin evidencia Windows. No agregar un framework general de orquestación ni rehacer componentes sin necesidad.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Respawn | Placeholder registrado y reemplazo nuevo | Mismo ID lógico, nuevo handle; listado/env/control correctos | Salida del proceso anterior no elimina el nuevo |
| Respawn fallido | Split o limpieza fallan | Identidad consistente y proceso controlable | Rollback acotado y error explícito |
| Lanzamiento | Menú/RPC con auto, shell efectivo compatible | Un único plan nativo con launcher válido | Fallo de disponibilidad degrada de forma coherente |
| Fallback | Modo auto/tmux solicitado con shell incompatible | in-process efectivo; variables propias incompatibles retiradas | Motivo explícito |
| CWD | Espacios, apóstrofes, corchetes o ruta ausente | Directorio literal o ningún hijo | Nunca continuar en otro directorio |
| Concurrencia | Varias creaciones o salida tardía | IDs inequívocos, sin pane adoptado por otra operación | Tiempo y limpieza acotados |
| Packaging | Candidato construido | Validación del mismo Electron/CLI distribuido | Artefacto no promovido si falla el gate |

</frozen-after-approval>

## Code Map

- `src/main/runtime/claude-agent-teams-{service,tmux-dispatcher,types,pane-layout}.ts`: registro y transición de panes.
- `src/main/runtime/claude-agent-teams-shim-env.ts`: disponibilidad, instalación y plan de lanzamiento.
- `src/main/runtime/orca-runtime.ts`, `src/main/ipc/pty.ts`: lanzamientos RPC y renderer; creación y cierre real de terminales.
- `src/shared/claude-agent-teams-{pane-command,tmux-compat}.ts`: semántica POSIX/PowerShell y flags del modo.
- `tests/e2e/claude-agent-teams-windows-native-panes.spec.ts`: fixture determinista existente y su ciclo incompleto.
- `.github/workflows/fork-windows-build.yml`: compilación, pruebas y artefacto.
- `docs/reference/fork-agent-teams-windows.md`: contrato y aceptación del fork.

## Tasks & Acceptance

**Execution:**
- [x] Servicio/dispatcher/types y tests: reproducir pérdida después del respawn y corregir con identidad estable, rollback y eventos tardíos; probar listado, envío, cierre y recreación.
- [x] Shim-env, runtime, IPC y tests: unificar planes entre renderer y RPC, contemplar shell efectivo, retirar gate win32 residual y validar shim sin crear teams inviables.
- [x] Tmux-compat y tests: reemplazar flags existentes al degradar, conservar otros argumentos, limpiar solo entorno gestionado incompatible.
- [x] Pane-command y tests: cwd literal con fallo que aborte el lanzamiento; corregir continuaciones POSIX; no ejecutar texto POSIX rechazado como PowerShell accidentalmente; revisar argv vacío y wrapper npm sin certificar compatibilidad no probada.
- [x] Runtime y tests: evaluar correlación y cola de splits; corregir fallos demostrables y cubrir creación concurrente/salida tardía sin ampliar innecesariamente el protocolo.
- [x] E2E y workflow: verificar control del pane después del respawn y limpieza; hacer verificable el artefacto empaquetado real, impedir promoción antes del gate y detectar tests ausentes del manifiesto.
- [x] Documentación: actualizar contrato, evidencia, configuración soportada y procedimiento de aceptación/retroceso; distinguir candidato de versión laboral validada.

**Acceptance Criteria:**
- Given un team vivo, when se reemplaza o termina un teammate, then los IDs del resto siguen controlando sus panes correctos y el líder permanece intacto.
- Given los mismos requisitos de lanzamiento, when se entra por menú o RPC, then modo y disponibilidad coinciden.
- Given un fallo de cwd o de traducción, when se solicita un teammate, then no se ejecuta en una ubicación o shell accidental.
- Given un artefacto candidato, when su validación falla o falta, then no se presenta como Windows certificado.
- Given este entorno Linux sin sesión Windows autenticada, when concluyen las pruebas locales, then el informe describe esa limitación sin sustituirla por mocks.

## Spec Change Log

- 2026-09-13: plan derivado de auditoría y propuesta aceptada mediante delegación autónoma. El fork carece de config BMad; los artefactos quedan en docs/reference del propio fork.

## Design Notes

El ID tmux es estable durante la sustitución de un proceso. Los handles son transitorios y los eventos deben corresponder al proceso que terminó. Mantener la operación pequeña y probada: no convertir cada cierre en eliminación del ID sin distinguir reemplazo. Los lanzamientos deben decidir su modo una vez; IPC y runtime consumen esa decisión. Las mejoras de wire deben ser aditivas y mantener aislamiento local/remoto.

## Verification

- Vitest focal de archivos modificados, con regresiones fallando antes del arreglo y aprobadas después.
- Typecheck del repo y lint focal sin desactivar reglas; distinguir fallos heredados.
- Workflow Windows preparado localmente; no dispararlo ni publicar sin autorización adicional.
- Pruebas Windows/Claude real y aceptación de escritorio permanecen pendientes hasta ejecutarse; dejar instrucciones concretas y candidato reproducible.

Evidencia local 2026-09-14: typecheck completo verde; lint focal verde; suite focal en curso de cierre tras 1.617 tests verdes y una expectativa histórica ajustada al nuevo fail-closed. El smoke empaquetado sólo puede ejecutarse en Windows y queda como gate obligatorio del workflow, no como evidencia local.
