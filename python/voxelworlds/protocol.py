"""stdio JSON-lines protocol helpers. stdout carries only Event lines."""
from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any, Callable, Dict, Optional


class PipelineError(Exception):
    """Failure mapped to a contract ErrorCode."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class Cancelled(Exception):
    """Raised cooperatively when a job's cancel flag is set."""


def _clean(o: Any) -> Any:
    """JSON-safe copy: numpy scalars/arrays -> Python, tuples -> lists, non-finite floats -> null."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    try:
        import numpy as np
        if isinstance(o, np.ndarray):
            return _clean(o.tolist())
        if isinstance(o, np.generic):
            o = o.item()
    except ImportError:
        pass
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    return o


def encode_event(obj: Dict[str, Any]) -> str:
    """One protocol line (no newline); raises TypeError/ValueError when the payload is not serialisable."""
    return json.dumps(_clean(obj), separators=(",", ":"), allow_nan=False)


class Emitter:
    """Thread-safe writer of Event lines to the real stdout."""

    def __init__(self, stream) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, obj: Dict[str, Any]) -> None:
        self.send_line(encode_event(obj))

    def send_line(self, line: str) -> None:
        with self._lock:
            try:
                self._stream.write(line + "\n")
                self._stream.flush()
            except (BrokenPipeError, ValueError):
                pass


class Job:
    """Per-request context: event helpers and cancel flag.

    Terminal events (result/error) first call ``release`` (frees the server's job slot) and then close
    the job: any later event from abandoned worker threads is dropped.
    """

    HEARTBEAT_S = 1.0
    POLL_S = 0.25

    def __init__(self, req_id: str, emitter: Emitter, release: Optional[Callable[[], None]] = None) -> None:
        self.id = req_id
        self.emitter = emitter
        self.cancel_event = threading.Event()
        self._release = release
        self._closed = False
        self._lock = threading.Lock()
        self._last = ("init", 0.0, "", None)

    def check(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled()

    def _send(self, obj: Dict[str, Any], terminal: bool = False) -> None:
        with self._lock:
            if self._closed:
                return
            try:
                line = encode_event(obj)       # serialise BEFORE closing the job: a bad payload must not hang the host
            except (TypeError, ValueError) as e:
                if not terminal:
                    print(f"[protocol] dropped unserialisable {obj.get('type')} event: {e}", file=sys.stderr, flush=True)
                    return
                obj = {"id": self.id, "type": "error", "code": "INTERNAL",
                       "message": f"Result could not be serialised: {type(e).__name__}: {e}"}
                line = encode_event(obj)
            if terminal:
                self._closed = True
                if self._release:
                    try:
                        self._release()
                    except Exception:
                        pass
            self.emitter.send_line(line)

    def progress(self, stage: str, pct: float, message: str = "", _beat: bool = False,
                 tile: Optional[Dict[str, int]] = None) -> None:
        self.check()
        pct = round(max(0.0, min(100.0, float(pct))), 1)
        if not _beat:
            self._last = (stage, pct, message, tile)
        msg: Dict[str, Any] = {"id": self.id, "type": "progress", "stage": stage, "pct": pct,
                               "message": message}
        if tile:
            msg["tile"] = {"done": int(tile["done"]), "total": int(tile["total"])}
        self._send(msg)

    def warning(self, code: str, message: str) -> None:
        if self._closed:
            return
        print(f"[warn] {code}: {message}", file=sys.stderr, flush=True)
        self._send({"id": self.id, "type": "warning", "code": code, "message": message})

    def error(self, code: str, message: str) -> None:
        self._send({"id": self.id, "type": "error", "code": code, "message": message}, terminal=True)

    def result(self, payload: Dict[str, Any]) -> None:
        msg: Dict[str, Any] = {"id": self.id, "type": "result"}
        msg.update(payload)
        self._send(msg, terminal=True)

    def run_blocking(self, fn: Callable[[], Any], label: str, note: str = "", poll: Optional[float] = None,
                     unwind: float = 0.0) -> Any:
        """Run blocking ``fn`` on a daemon thread; poll cancel every POLL_S and emit a heartbeat
        progress (same stage/pct, message with elapsed seconds) every HEARTBEAT_S. On cancel the worker
        is abandoned (its late result/exception is swallowed; events from it are dropped once the job
        is closed) and Cancelled is raised immediately. With ``unwind`` > 0 a cancelled job first waits up to that
        many seconds for the worker to finish unwinding (e.g. delete its temp files) before raising."""
        box: Dict[str, Any] = {}
        done = threading.Event()

        def target() -> None:
            try:
                box["v"] = fn()
            except BaseException as e:  # noqa: BLE001 - delivered to the waiter or swallowed
                box["e"] = e
            finally:
                done.set()

        threading.Thread(target=target, daemon=True).start()
        t0 = time.monotonic()
        next_beat = t0 + self.HEARTBEAT_S
        def checked() -> None:
            try:
                self.check()
            except Cancelled:
                if unwind > 0:
                    done.wait(unwind)
                raise

        while not done.wait(poll or self.POLL_S):
            checked()
            now = time.monotonic()
            if now >= next_beat:
                next_beat = now + self.HEARTBEAT_S
                stage, pct, base, tile = self._last
                msg = f"{label}\u2026 {int(now - t0)} s" + (f" ({note})" if note else "")
                self.progress(stage, pct, msg, _beat=True, tile=tile)
        checked()
        if "e" in box:
            raise box["e"]
        return box.get("v")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
