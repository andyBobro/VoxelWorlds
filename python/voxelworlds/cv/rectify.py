"""Photo loading and homography rectification of a user-marked wall quad to a metric front elevation."""
from __future__ import annotations

import math
from typing import Callable, Optional, Sequence, Tuple

import numpy as np

from ..protocol import PipelineError

MAX_PIXELS = 100_000_000   # reject larger photos (decompression-bomb guard) before decoding
MAX_DECODE_SIDE = 4096     # JPEGs are decoded with DCT scaling to about this side (draft mode)
MAX_PPM = 64.0             # rectified pixels per metre (cap)
MIN_PPM = 4.0
MAX_OUT_SIDE = 3072        # rectified image side cap in pixels
STRIP_ROWS = 48            # rows warped between cancel checks


def load_photo(path: str) -> Tuple[np.ndarray, float, float]:
    """Decode ``path`` (JPEG / PNG / WebP only) to an RGB uint8 array.

    COORDINATE FRAME: the EXIF-ORIENTED original image is the contract frame: callers send corners in the
    pixels of the photo as displayed after applying its EXIF orientation. Returns (array, sx, sy) where sx, sy
    convert those oriented-original pixel coordinates to array coordinates (the array is oriented and may be
    downscaled). Raises PipelineError(PHOTO_UNREADABLE), also for images over MAX_PIXELS."""
    try:
        from PIL import Image, ImageOps
    except Exception as e:  # pragma: no cover - Pillow is a pinned dependency
        raise PipelineError("PHOTO_UNREADABLE", f"Image decoder unavailable: {e}")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(path, formats=["JPEG", "PNG", "WEBP"]) as im:
            ow, oh = im.size
            if ow * oh > MAX_PIXELS:  # header only, nothing decoded yet
                raise PipelineError("PHOTO_UNREADABLE", f"Photo is too large ({ow}x{oh} px, limit "
                                    f"{MAX_PIXELS // 1_000_000} MP)")
            try:
                orient = int(im.getexif().get(0x0112, 1))
            except Exception:
                orient = 1
            if orient in (5, 6, 7, 8):
                ow, oh = oh, ow
            if im.format == "JPEG":
                im.draft("RGB", (MAX_DECODE_SIDE, MAX_DECODE_SIDE))
            im.load()
            if orient != 1:
                im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                im = Image.alpha_composite(bg, im)
            im = im.convert("RGB")
            if max(im.size) > MAX_DECODE_SIDE:
                k = MAX_DECODE_SIDE / max(im.size)
                im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.BILINEAR)
            arr = np.asarray(im, dtype=np.uint8)
    except PipelineError:
        raise
    except Exception as e:  # unreadable, truncated, bomb, unsupported format
        raise PipelineError("PHOTO_UNREADABLE", f"Cannot read photo: {type(e).__name__}: {str(e)[:160]}")
    if arr.ndim != 3 or arr.shape[0] < 8 or arr.shape[1] < 8:
        raise PipelineError("PHOTO_UNREADABLE", "Photo is too small")
    return arr, arr.shape[1] / float(ow), arr.shape[0] / float(oh)


def homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """3x3 H with dst ~ H @ src (DLT, 4 point pairs, float64)."""
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = np.asarray(dst, np.float64).reshape(-1)
    h = np.linalg.solve(np.asarray(A, np.float64), b)
    return np.append(h, 1.0).reshape(3, 3)


def check_quad(q: np.ndarray, img_shape: Optional[Tuple[int, ...]] = None) -> None:
    """Quad (x right, y down pixels) must be finite, ordered TL,TR,BR,BL (all edge cross products > 0, which
    rejects mirrored / flipped / bow-tie quads), at least 1% of the image area, with no sliver edges or extreme
    opposite-edge ratios."""
    if q.shape != (4, 2) or not np.all(np.isfinite(q)):
        raise PipelineError("BAD_REQUEST", "corners must be 4 finite [x, y] points")
    cr = []
    for i in range(4):
        a, b, c = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        cr.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
    if not all(c > 0 for c in cr):
        raise PipelineError("FACADE_ANALYSIS_FAILED", "Marked corners must go top-left, top-right, bottom-right, "
                            "bottom-left and form a convex quadrilateral (mirrored or twisted order rejected)")
    area = 0.5 * abs(sum(q[i, 0] * q[(i + 1) % 4, 1] - q[(i + 1) % 4, 0] * q[i, 1] for i in range(4)))
    ih, iw = (img_shape[0], img_shape[1]) if img_shape is not None else (None, None)
    if iw is not None and area < 0.01 * iw * ih:
        raise PipelineError("FACADE_ANALYSIS_FAILED", "Marked wall covers less than 1% of the photo")
    if area < 100.0:
        raise PipelineError("FACADE_ANALYSIS_FAILED", "Marked wall area is too small")
    e = [float(np.hypot(*(q[(i + 1) % 4] - q[i]))) for i in range(4)]
    diag = float(np.hypot(*(q.max(0) - q.min(0))))
    if min(e) < 0.05 * diag or e[0] > 8 * e[2] or e[2] > 8 * e[0] or e[1] > 8 * e[3] or e[3] > 8 * e[1]:
        raise PipelineError("FACADE_ANALYSIS_FAILED", "Marked quadrilateral is degenerate (sliver or extreme "
                            "perspective)")


def output_size(q: np.ndarray, wall_w: float, wall_h: float) -> Tuple[int, int, float]:
    """(width px, height px, px/m): up to MAX_PPM, but no finer than the source resolution of the quad."""
    top, bot = np.hypot(*(q[1] - q[0])), np.hypot(*(q[2] - q[3]))
    lef, rig = np.hypot(*(q[3] - q[0])), np.hypot(*(q[2] - q[1]))
    src_ppm = max(float(max(top, bot)) / wall_w, float(max(lef, rig)) / wall_h)
    ppm = float(np.clip(src_ppm, MIN_PPM, MAX_PPM))
    ppm = min(ppm, MAX_OUT_SIDE / max(wall_w, wall_h))
    return max(8, int(round(wall_w * ppm))), max(8, int(round(wall_h * ppm))), ppm


def rectify(img: np.ndarray, quad: np.ndarray, wall_w: float, wall_h: float,
            check: Optional[Callable[[], None]] = None) -> Tuple[np.ndarray, float, float]:
    """Warp the quad (array pixel coordinates, TL,TR,BR,BL) to a front elevation of wall_w x wall_h metres.
    Returns (RGB uint8 (H, W, 3), px/m, fraction of output pixels that fell outside the photo)."""
    check_quad(quad, img.shape)
    W, H, ppm = output_size(quad, wall_w, wall_h)
    dst = np.array([[0, 0], [W, 0], [W, H], [0, H]], np.float64)
    Hinv = homography(dst, quad)  # output pixel -> photo pixel
    out = np.empty((H, W, 3), np.uint8)
    xs = np.arange(W) + 0.5
    ih, iw = img.shape[:2]
    outside = 0
    for r0 in range(0, H, STRIP_ROWS):
        if check:
            check()
        r1 = min(H, r0 + STRIP_ROWS)
        ys = np.arange(r0, r1) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        p = Hinv[0, 0] * gx + Hinv[0, 1] * gy + Hinv[0, 2]
        q_ = Hinv[1, 0] * gx + Hinv[1, 1] * gy + Hinv[1, 2]
        w = Hinv[2, 0] * gx + Hinv[2, 1] * gy + Hinv[2, 2]
        w = np.where(np.abs(w) < 1e-12, 1e-12, w)
        sx, sy = p / w - 0.5, q_ / w - 0.5
        outside += int(((sx < -1) | (sx > iw) | (sy < -1) | (sy > ih)).sum())
        sx = np.clip(sx, 0, iw - 1.0001)
        sy = np.clip(sy, 0, ih - 1.0001)
        x0, y0 = sx.astype(np.int64), sy.astype(np.int64)
        fx, fy = (sx - x0)[..., None], (sy - y0)[..., None]
        a = img[y0, x0].astype(np.float32)
        b = img[y0, x0 + 1].astype(np.float32)
        c = img[y0 + 1, x0].astype(np.float32)
        d = img[y0 + 1, x0 + 1].astype(np.float32)
        out[r0:r1] = np.clip((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy + 0.5,
                             0, 255).astype(np.uint8)
    return out, ppm, outside / float(W * H)
