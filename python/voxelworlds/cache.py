"""Small shared on-disk cache for OSM / DEM / Mapillary responses (atomic writes, optional TTL)."""
from __future__ import annotations

import hashlib
import io
import os
import pickle
import tempfile
import time
from typing import Any, Optional

import numpy as np

_VERSION = "v1"


_ROOT: Optional[tuple] = None  # (env value, resolved dir)


def _private(d: str) -> bool:
    """Directory is ours (owner == current user) and not accessible to group/other (POSIX; always true elsewhere)."""
    if not hasattr(os, "getuid"):
        return True
    st = os.stat(d)
    return st.st_uid == os.getuid() and (st.st_mode & 0o077) == 0


def cache_root() -> str:
    """Cache directory, created 0o700. If an existing directory is owned by someone else or is group/world
    accessible (pickled values are read back), a fresh private temp directory is used instead."""
    global _ROOT
    env = os.environ.get("VOXEL_CACHE_DIR")
    if _ROOT is not None and _ROOT[0] == env:
        return _ROOT[1]
    d = env or os.path.join(tempfile.gettempdir(), "voxelworlds-cache")
    try:
        os.makedirs(d, mode=0o700, exist_ok=True)
        ok = _private(d)
        if not ok and hasattr(os, "getuid") and os.stat(d).st_uid == os.getuid():
            os.chmod(d, 0o700)
            ok = _private(d)
    except OSError:
        ok = False
    if not ok:
        d = tempfile.mkdtemp(prefix="voxelworlds-cache-")  # mode 0o700
    _ROOT = (env, d)
    return d


def delete(kind: str, key: str) -> None:
    try:
        os.remove(_path(kind, key))
    except OSError:
        pass


def _path(kind: str, key: str) -> str:
    d = os.path.join(cache_root(), kind)
    os.makedirs(d, mode=0o700, exist_ok=True)
    return os.path.join(d, hashlib.sha1(f"{_VERSION}|{key}".encode("utf-8")).hexdigest())


def get_bytes(kind: str, key: str, ttl_s: float) -> Optional[bytes]:
    """Cached bytes or None (missing/expired/unreadable). Keys must never contain secrets."""
    p = _path(kind, key)
    try:
        if time.time() - os.path.getmtime(p) > ttl_s:
            return None
        with open(p, "rb") as f:
            return f.read()
    except OSError:
        return None


def put_bytes(kind: str, key: str, data: bytes) -> None:
    p = _path(kind, key)
    tmp = f"{p}.{os.getpid()}.{time.monotonic_ns()}.part"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
    except OSError:
        pass
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def has(kind: str, key: str, ttl_s: float) -> bool:
    """True when a non-expired cache entry exists (cheap: no read / unpickle)."""
    try:
        return time.time() - os.path.getmtime(_path(kind, key)) <= ttl_s
    except OSError:
        return False


def mtime(kind: str, key: str) -> Optional[float]:
    """Write time of a cache entry (expired or not), None when absent."""
    try:
        return os.path.getmtime(_path(kind, key))
    except OSError:
        return None


def get_obj(kind: str, key: str, ttl_s: float) -> Optional[Any]:
    b = get_bytes(kind, key, ttl_s)
    if b is None:
        return None
    try:
        return pickle.loads(b)  # local cache written by this app only
    except Exception:
        return None


def put_obj(kind: str, key: str, obj: Any) -> None:
    put_bytes(kind, key, pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL))


def get_array(kind: str, key: str, ttl_s: float) -> Optional[np.ndarray]:
    b = get_bytes(kind, key, ttl_s)
    if b is None:
        return None
    try:
        return np.load(io.BytesIO(b), allow_pickle=False)
    except Exception:
        return None


def put_array(kind: str, key: str, arr: np.ndarray) -> None:
    buf = io.BytesIO()
    np.save(buf, arr, allow_pickle=False)
    put_bytes(kind, key, buf.getvalue())
