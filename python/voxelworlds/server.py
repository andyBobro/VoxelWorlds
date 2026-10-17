"""stdio JSON-lines server: reads Requests on stdin, writes Events on stdout."""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
import traceback
from typing import Dict, Optional

from . import __version__
from .protocol import Cancelled, Emitter, Job, PipelineError, log


def _run_export(job: Job, req: dict) -> None:
    fmt, inp, outp = req.get("format"), req.get("inputPath"), req.get("outputPath")
    if fmt not in ("vox", "schem", "json") or not isinstance(inp, str) or not isinstance(outp, str):
        raise PipelineError("BAD_REQUEST", "export requires format (vox|schem|json), inputPath, outputPath")
    if not os.path.isfile(inp):
        raise PipelineError("EXPORT_FAILED", f"Input file not found: {inp}")
    job.progress("export", 0, f"Exporting {fmt}")
    try:
        if fmt == "vox":
            from .export.vox import export_vox as fn
        elif fmt == "schem":
            from .export.schem import export_schem as fn
        else:
            from .export.jsonx import export_json as fn
        os.makedirs(os.path.dirname(os.path.abspath(outp)), exist_ok=True)
        job.check()
        fn(inp, outp)
    except (Cancelled, PipelineError):
        raise
    except Exception as e:
        raise PipelineError("EXPORT_FAILED", f"{type(e).__name__}: {e}")
    job.progress("export", 100, "Done")
    job.result({"kind": "export", "outputPath": outp})


def _worker(job: Job, req: dict, jobs: Dict[str, Job], lock: threading.Lock) -> None:
    try:
        if req["type"] == "generate":
            from .pipeline import generate
            p = req.get("params")
            if not isinstance(p, dict):
                raise PipelineError("BAD_REQUEST", "generate requires params")
            generate(job, p)
        elif req["type"] == "analyzeFacade":
            from .cv.service import analyze_facade
            p = req.get("params")
            if not isinstance(p, dict):
                raise PipelineError("BAD_REQUEST", "analyzeFacade requires params")
            analyze_facade(job, p)
        elif req["type"] == "detail":
            from .voxel.detail_scene import run_detail
            p = req.get("params")
            if not isinstance(p, dict):
                raise PipelineError("BAD_REQUEST", "detail requires params")
            run_detail(job, p)
        else:
            _run_export(job, req)
    except Cancelled:
        job.error("CANCELLED", "Operation cancelled")
    except PipelineError as e:
        job.error(e.code, e.message)
    except Exception as e:
        log(traceback.format_exc())
        job.error("INTERNAL", f"{type(e).__name__}: {e}")
    finally:
        with lock:  # no-op if the slot was already released before the terminal event
            jobs.pop(job.id, None)


def main() -> None:
    out = Emitter(sys.stdout)
    sys.stdout = sys.stderr  # stray prints from libraries go to stderr
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    jobs: Dict[str, Job] = {}
    lock = threading.Lock()
    threads = []

    def on_term(*_a):
        with lock:
            for j in jobs.values():
                j.cancel_event.set()
        if not jobs:
            os._exit(0)
        t = threading.Timer(1.5, lambda: os._exit(0))  # cancel is now prompt; don't linger
        t.daemon = True
        t.start()

    try:
        signal.signal(signal.SIGTERM, on_term)
    except Exception:
        pass

    out.send({"id": "boot", "type": "ready", "version": __version__})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = "unknown"
        try:
            req = json.loads(line)
            if not isinstance(req, dict) or not isinstance(req.get("id"), str):
                raise ValueError("request must be an object with string id")
            rid = req["id"]
            t = req.get("type")
            if t == "ping":
                out.send({"id": rid, "type": "pong"})
            elif t == "cancel":
                with lock:
                    j = jobs.get(req.get("target"))
                if j:
                    j.cancel_event.set()
            elif t in ("generate", "export", "analyzeFacade", "detail"):
                def release(rid=rid):
                    with lock:
                        jobs.pop(rid, None)
                with lock:
                    busy = len(jobs) > 0
                    if not busy:
                        job = Job(rid, out, release)
                        jobs[rid] = job
                if busy:
                    out.send({"id": rid, "type": "error", "code": "BAD_REQUEST",
                              "message": "Another job is already running"})
                    continue
                th = threading.Thread(target=_worker, args=(job, req, jobs, lock), daemon=True)
                th.start()
                threads.append(th)
            else:
                out.send({"id": rid, "type": "error", "code": "BAD_REQUEST",
                          "message": f"Unknown request type: {t!r}"})
        except (ValueError, json.JSONDecodeError) as e:
            out.send({"id": rid, "type": "error", "code": "BAD_REQUEST", "message": str(e)})
        except Exception as e:
            log(traceback.format_exc())
            out.send({"id": rid, "type": "error", "code": "INTERNAL", "message": f"{type(e).__name__}: {e}"})
    # stdin closed: cancel and wait briefly
    with lock:
        for j in jobs.values():
            j.cancel_event.set()
    for th in threads:
        th.join(timeout=10)
