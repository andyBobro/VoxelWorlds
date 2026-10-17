"""'analyzeFacade' request handler."""
from __future__ import annotations

import os
import uuid
from typing import Optional

import numpy as np

from ..protocol import Cancelled, Job, PipelineError
from . import analyze, rectify


def _out_dir() -> str:
    from ..pipeline import out_dir
    return out_dir()


def parse_params(p: dict):
    try:
        path = p["photoPath"]
        corners = np.asarray(p["corners"], np.float64)
        ww, wh = float(p["wallWidthM"]), float(p["wallHeightM"])
        hint = p.get("floorsHint")
        hint = int(hint) if hint is not None else None
    except Exception as e:
        raise PipelineError("BAD_REQUEST", f"Invalid analyzeFacade params: {type(e).__name__}: {e}")
    if not isinstance(path, str) or corners.shape != (4, 2):
        raise PipelineError("BAD_REQUEST", "analyzeFacade needs photoPath and 4 corners [[x,y] x4]")
    if not (np.isfinite(ww) and np.isfinite(wh) and 0.5 <= ww <= 300 and 0.5 <= wh <= 300):
        raise PipelineError("BAD_REQUEST", "wallWidthM / wallHeightM must be within 0.5..300 metres")
    if hint is not None and not (1 <= hint <= 250):
        hint = None
    return path, corners, ww, wh, hint


_last_png: Optional[str] = None  # only the most recent rectified PNG of this process is kept on disk


def _write_png(rect: np.ndarray) -> str:
    """Cheap (zlib level 1) PNG as vw-rect-*.png in VOXEL_TMP_DIR; the previous one is deleted."""
    global _last_png
    from PIL import Image
    out = os.path.join(_out_dir(), f"vw-rect-{uuid.uuid4().hex[:12]}.png")
    tmp = out + ".part"
    try:
        with open(tmp, "wb") as f:
            Image.fromarray(rect).save(f, "PNG", compress_level=1)
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    if _last_png and _last_png != out:
        try:
            os.remove(_last_png)
        except OSError:
            pass
    _last_png = out
    return out


def analyze_facade(job: Job, p: dict) -> None:
    path, corners, ww, wh, hint = parse_params(p)
    job.progress("analyze", 0, "Reading photo")
    if not os.path.isfile(path):
        raise PipelineError("PHOTO_UNREADABLE", f"Photo not found: {path}")
    img, sx, sy = job.run_blocking(lambda: rectify.load_photo(path), "Reading photo", poll=0.02)
    quad = corners * np.array([sx, sy])
    job.progress("analyze", 25, "Rectifying wall")
    try:
        rect, ppm, outside = rectify.rectify(img, quad, ww, wh, job.check)
    except (PipelineError, Cancelled):
        raise
    except Exception as e:
        raise PipelineError("FACADE_ANALYSIS_FAILED", f"Rectification failed: {type(e).__name__}: {str(e)[:160]}")
    del img
    if outside > 0.25:
        raise PipelineError("FACADE_ANALYSIS_FAILED", f"{outside * 100:.0f}% of the marked wall lies outside "
                            "the photo")
    job.progress("analyze", 50, "Analysing facade")
    try:
        spec = analyze.analyze_rectified(rect, ppm, ww, wh, hint, job.check)
    except (PipelineError, Cancelled):
        raise
    except Exception as e:
        raise PipelineError("FACADE_ANALYSIS_FAILED", f"{type(e).__name__}: {str(e)[:160]}")
    if outside > 0.05:
        job.warning("PHOTO_QUAD_OUTSIDE", f"{outside * 100:.0f}% of the marked wall lies outside the photo")
    job.check()
    job.progress("analyze", 90, "Saving rectified image")
    try:
        out = _write_png(rect)
    except Exception as e:
        raise PipelineError("FACADE_ANALYSIS_FAILED", f"Cannot save rectified image: {type(e).__name__}: {e}")
    job.progress("analyze", 100, "Done")
    job.result({"kind": "analyzeFacade", "spec": spec, "rectifiedPath": out})
