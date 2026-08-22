#!/usr/bin/env python3
"""
Único escritor de /tmp/waengine-orquestacion/<session>/estado.json.

Modela por subagente dos cosas que NUNCA se pisan (principio 1 del protocolo v2,
docs/agentes/protocolo-orquestacion-v2-diseno-2026-08-22.md):
  - phase  (durable): provisioning -> active -> settled
  - turn   (derivado): running | idle | blocked | unknown
y la razón de cierre como enum cerrado:
  settled_reason: completed | failed | timed_out | abandoned | interrupted | unhooked

Subcomandos (todos reciben --session <id>):
  upsert   --agent ID [--k v ...]         crea/actualiza campos sueltos
  heartbeat --handle H                     marca last_heartbeat_at=ahora y turn=running
  settle   --handle H --reason R [--outcome O]   phase=settled (idempotente)
  vigilar  [--minutos N]                   imprime avisos de abandonados (no muta fase)
  resumen                                  una línea por agente no settled
  dump                                     el JSON entero
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

BASE = "/tmp/waengine-orquestacion"
ORCA = next(
    (p for p in ("/home/jot4dev/.config/orca/linux-orca-cli-shim/orca", "/home/jot4dev/.local/bin/orca-ide") if os.access(p, os.X_OK)),
    None,
)
REASONS = {"completed", "failed", "timed_out", "abandoned", "interrupted", "unhooked"}


def ahora():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ruta(session):
    d = os.path.join(BASE, session)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "estado.json")


class Estado:
    """Abre con lock exclusivo; escribe atómico al salir si hubo cambios."""

    def __init__(self, session):
        self.path = ruta(session)
        self.lock = open(self.path + ".lock", "w")
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        try:
            with open(self.path) as f:
                self.data = json.load(f)
        except Exception:
            self.data = {"agentes": {}}
        self.dirty = False

    def agentes(self):
        return self.data.setdefault("agentes", {})

    def por_handle(self, handle):
        for a in self.agentes().values():
            if a.get("handle") == handle:
                return a
        return None

    def guardar(self):
        if not self.dirty:
            return
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def cerrar(self):
        self.guardar()
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()


def orca_json(*args):
    if not ORCA:
        return None
    try:
        out = subprocess.run([ORCA, *args, "--json"], capture_output=True, text=True, timeout=20).stdout
        d = json.loads(out)
        return d.get("result") if d.get("ok") else None
    except Exception:
        return None


def cmd_upsert(e, ns):
    a = e.agentes().setdefault(ns.agent, {"agent_id": ns.agent, "phase": "provisioning", "turn": "unknown", "settled_reason": None, "hook_attempts": [], "created_at": ahora()})
    for kv in ns.set or []:
        k, _, v = kv.partition("=")
        if k == "phase" and a.get("phase") == "settled" and v != "settled":
            continue  # el turno/hook nunca reabre una fase terminal
        if k == "hook_attempt":
            a.setdefault("hook_attempts", []).append({"at": ahora(), "outcome": v})
        elif k == "write_scopes":
            a[k] = [s for s in v.split(",") if s]
        else:
            a[k] = v if v != "" else None
    a["updated_at"] = ahora()
    e.dirty = True


def cmd_heartbeat(e, ns):
    a = e.por_handle(ns.handle)
    if not a or a.get("phase") == "settled":
        return
    a["last_heartbeat_at"] = ahora()
    a["turn"] = "running"
    e.dirty = True


def cmd_settle(e, ns):
    if ns.reason not in REASONS:
        sys.exit(f"reason inválida: {ns.reason} (válidas: {sorted(REASONS)})")
    a = e.por_handle(ns.handle) if ns.handle else e.agentes().get(ns.agent or "")
    if not a:
        return
    if a.get("phase") == "settled":
        return  # idempotente: el primer cierre gana
    a.update({"phase": "settled", "settled_reason": ns.reason, "outcome": ns.outcome, "settled_at": ahora(), "turn": "idle"})
    e.dirty = True


def cmd_vigilar(e, ns):
    """Avisa; no decide. La decisión de worker-abandon es del coordinador con el usuario."""
    terms = {}
    r = orca_json("terminal", "list")
    for t in (r or {}).get("terminals", []):
        terms[t.get("handle")] = t
    avisos = []
    limite = ns.minutos * 60
    now = datetime.now(timezone.utc)
    for a in e.agentes().values():
        if a.get("phase") != "active":
            continue
        h = a.get("handle")
        d = a.get("dispatch_id")
        # 1) Orca ya lo dio por settled y nosotros no: sincronizar (no es abandono)
        if d:
            ws = orca_json("orchestration", "worker-show", "--dispatch", d)
            if ws:
                st = (ws.get("worker") or {}).get("state")
                if st in ("succeeded", "failed"):
                    a.update({"phase": "settled", "settled_reason": "completed" if st == "succeeded" else "failed", "outcome": st, "settled_at": ahora(), "turn": "idle"})
                    e.dirty = True
                    continue
                hb = (ws.get("dispatch") or {}).get("last_heartbeat_at")
                if hb and hb > (a.get("last_heartbeat_at") or ""):
                    a["last_heartbeat_at"] = hb
                    e.dirty = True
        # 2) señales de vida: heartbeat o salida en el pane
        ultimo = a.get("last_heartbeat_at") or a.get("updated_at") or a.get("created_at")
        t = terms.get(h)
        if t is None:
            a["turn"] = "unknown"
            e.dirty = True
            avisos.append(f"⚠ {a['agent_id']}: su pane {h} ya no existe y no hay worker_done — posible abandono (decidir worker-abandon --dispatch {d})")
            continue
        lo = t.get("lastOutputAt")
        try:
            lo_dt = datetime.fromtimestamp(lo / 1000, tz=timezone.utc) if isinstance(lo, (int, float)) else datetime.fromisoformat(str(lo).replace("Z", "+00:00"))
        except Exception:
            lo_dt = None
        try:
            u_dt = datetime.fromisoformat(ultimo.replace("Z", "+00:00"))
        except Exception:
            u_dt = now
        ultima_senal = max([x for x in (lo_dt, u_dt) if x])
        seg = (now - ultima_senal).total_seconds()
        if seg > limite:
            a["turn"] = "unknown"
            e.dirty = True
            avisos.append(f"⚠ {a['agent_id']}: sin heartbeat ni salida hace {int(seg // 60)} min (dispatch {d}) — consultar antes de suponer")
    print("\n".join(avisos))


def cmd_resumen(e, ns):
    for a in e.agentes().values():
        if a.get("phase") == "settled" and not ns.todos:
            continue
        print(f"{a['agent_id']} phase={a.get('phase')} turn={a.get('turn')} reason={a.get('settled_reason')} dispatch={a.get('dispatch_id')} hb={a.get('last_heartbeat_at')}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--session", required=True)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("upsert"); s.add_argument("--agent", required=True); s.add_argument("--set", action="append")
    s = sub.add_parser("heartbeat"); s.add_argument("--handle", required=True)
    s = sub.add_parser("settle"); s.add_argument("--handle"); s.add_argument("--agent"); s.add_argument("--reason", required=True); s.add_argument("--outcome")
    s = sub.add_parser("vigilar"); s.add_argument("--minutos", type=int, default=20)
    s = sub.add_parser("resumen"); s.add_argument("--todos", action="store_true")
    sub.add_parser("dump")
    ns = p.parse_args()
    e = Estado(ns.session)
    try:
        if ns.cmd == "dump":
            print(json.dumps(e.data, ensure_ascii=False, indent=1))
        else:
            globals()["cmd_" + ns.cmd](e, ns)
    finally:
        e.cerrar()


if __name__ == "__main__":
    main()
