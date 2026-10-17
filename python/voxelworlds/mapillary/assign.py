"""Global (tile-independent) Mapillary image assignment per wall segment, and per-building photo sampling.

Assignment runs once in the parent over ALL buildings, so a building spanning several tiles gets exactly the
same images / colours whichever tile voxelizes it. Each wall segment gets up to `mapillary_images_per_segment`
images (best first); per wall voxel the colour is the median over all samples of all its images."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import numpy as np
import shapely

from .. import cache
from ..config import Config
from ..protocol import Job, log
from ..voxel.buildings import Building, wall_segments
from ..voxel.grid import Grid
from . import sampling


@dataclass
class PhotoData:
    cam_e: np.ndarray
    cam_n: np.ndarray
    cam_h: np.ndarray                      # heading (rad, clockwise from north)
    thumbs: Dict[int, np.ndarray] = field(default_factory=dict)   # uint8 (h, w, 4): RGB + facade alpha
    res: int = 256


def _drop_occluded(cand: np.ndarray, mid: np.ndarray, nrm: np.ndarray, imgs, btree, n_keep: int) -> np.ndarray:
    """Remove candidates whose line of sight to the wall passes through any building footprint; keep the first
    `n_keep` survivors per segment (order preserved), -1 padded."""
    k, m = cand.shape
    rows, cols = np.nonzero(cand >= 0)
    if len(rows) == 0:
        return cand[:, :n_keep]
    ci = cand[rows, cols]
    a = np.stack([imgs.e[ci], imgs.n[ci]], 1)
    b = mid[rows] + 0.4 * nrm[rows]  # end just in front of the wall so the building's own footprint is not hit
    lines = shapely.linestrings(np.stack([a, b], 1))
    li, _ = btree.query(lines, predicate="intersects")
    blocked = np.zeros(len(rows), bool)
    blocked[li] = True
    ok = np.zeros((k, m), bool)
    ok[rows[~blocked], cols[~blocked]] = True
    order = np.argsort(~ok, axis=1, kind="stable")
    cand2 = np.take_along_axis(cand, order, 1)
    ok2 = np.take_along_axis(ok, order, 1)
    cand2 = np.where(ok2, cand2, -1)
    return cand2[:, :n_keep]


def assign_photos(job: Job, buildings: List[Building], imgs, token: str, cfg: Config, vs: float,
                  tick_for: Callable[[float, float, str], Callable[[float], None]]) -> Optional[PhotoData]:
    """Sets b.seg_sel ((n_segments, images_per_segment) camera indices, -1 padded) on every building that
    has no explicit colour tag. Returns PhotoData (maybe without thumbs), or None if no thumbnails could be
    obtained. Voxel sizes <= cfg.mapillary_hires_vs use the 1024 px thumbnails."""
    from . import client as mc

    fine = vs <= cfg.mapillary_hires_vs
    res = 1024 if fine else 256
    max_imgs = cfg.mapillary_max_images_fine if fine else cfg.mapillary_max_images
    max_side = cfg.mapillary_thumb_fine_px if fine else 256
    nbest = max(1, cfg.mapillary_images_per_segment)
    kind = f"mly-t{res}"

    ranges, mids, nrms = [], [], []
    off = 0
    for b in buildings:
        if b.wall_tag is not None:  # explicit building:colour beats photos
            p0 = np.empty((0, 2))
            mids.append(p0), nrms.append(p0)
            ranges.append((off, off))
            continue
        p0, p1, nrm = wall_segments(b.poly, vs)
        mids.append((p0 + p1) / 2)
        nrms.append(nrm)
        ranges.append((off, off + len(p0)))
        off += len(p0)
    mid, nrm = np.concatenate(mids), np.concatenate(nrms)
    if len(mid) == 0:
        return PhotoData(np.empty(0), np.empty(0), np.empty(0))
    btree = shapely.STRtree([b.poly for b in buildings]) if cfg.mapillary_occlusion_check else None

    def select(im):
        out = np.full((len(mid), nbest), -1, np.int64)
        for s in range(0, len(mid), 1500):
            job.check()
            e = min(len(mid), s + 1500)
            if btree is not None:
                cand = mc.select_images(im, mid[s:e], nrm[s:e], cfg, n_best=2 * nbest)
                out[s:e] = _drop_occluded(cand, mid[s:e], nrm[s:e], im, btree, nbest)
            else:
                out[s:e] = mc.select_images(im, mid[s:e], nrm[s:e], cfg, n_best=nbest)
        return out

    sel = select(imgs)
    used, cnt = np.unique(sel[sel >= 0], return_counts=True)
    if len(used) == 0:
        return PhotoData(np.empty(0), np.empty(0), np.empty(0))
    top = used[np.argsort(-cnt, kind="stable")[:max_imgs]]
    ids = [imgs.ids[i] for i in top]
    cap = imgs.captured[top] if imgs.captured is not None else None
    cached: Dict[int, np.ndarray] = {}
    for j, iid in enumerate(ids):
        arr = cache.get_array(kind, iid, cfg.mapillary_thumb_ttl_s)
        if arr is not None and arr.ndim == 3 and arr.shape[2] == 4:
            cached[j] = arr
    urls = [""] * len(ids)
    need = [j for j in range(len(ids)) if j not in cached]
    if need:
        nimg = mc.Images([ids[j] for j in need], imgs.e[top][need], imgs.n[top][need],
                         imgs.heading[top][need], [""] * len(need))
        tick1 = tick_for(50, 75, "Resolving Mapillary images")
        job.run_blocking(lambda: mc.resolve_urls(nimg, token, tick1, res), "Resolving Mapillary images")
        for k, j in enumerate(need):
            urls[j] = nimg.urls[k]
    avail = [j for j in range(len(ids)) if j in cached or urls[j]]
    if not avail:
        job.warning("NO_MAPILLARY_COVERAGE", "Mapillary found nearby images but the Graph API would not "
                    "return thumbnails for this token; using procedural facades")
        return None
    tj = top[avail]
    sub = mc.Images([ids[j] for j in avail], imgs.e[tj], imgs.n[tj], imgs.heading[tj],
                    [urls[j] for j in avail], cap[avail] if cap is not None else None)
    sel = select(sub)
    wanted = [int(i) for i in np.unique(sel[sel >= 0])]
    thumbs: Dict[int, np.ndarray] = {}
    missing = []
    for w in wanted:
        j = avail[w]
        if j in cached:
            thumbs[w] = cached[j]
        else:
            missing.append(w)
    if missing:
        tick2 = tick_for(75, 100, "Downloading Mapillary thumbnails")
        got = job.run_blocking(lambda: mc.download_thumbs(sub, missing, tick2, max_side),
                               "Downloading Mapillary thumbnails")
        for w, arr in got.items():
            thumbs[w] = arr
            cache.put_array(kind, sub.ids[w], arr)
    for b, (a, e) in zip(buildings, ranges):
        b.seg_sel = sel[a:e].copy() if e > a else None
    return PhotoData(sub.e, sub.n, sub.heading, thumbs, res)


def apply_photos(b: Building, grid: Grid, vs: float, cfg: Config, photo: PhotoData) -> bool:
    """Overwrite b.wall_rgb with photo-sampled colours where cameras see the wall. Sets b.photo.

    Per wall voxel: nearest wall segment -> point on that wall plane + wall tangent -> pinhole projection into
    each of the segment's selected images (3x3 sample patch across the voxel face) -> median over all valid
    samples (sky / vegetation / hood pixels and the lowest strip are invalid) with Lab outlier rejection.
    Voxels with too few valid samples keep their tag / procedural colour."""
    if b.seg_sel is None or len(b.wx) == 0 or not photo.thumbs or not (b.seg_sel >= 0).any():
        return False
    pa, pb, _ = wall_segments(b.poly, vs)
    if len(pa) == 0 or len(pa) != len(b.seg_sel):
        return False
    ce = grid.centers_e(b.wx)
    cn = grid.centers_n(b.wz)
    ab = pb - pa
    ab2 = (ab ** 2).sum(1) + 1e-9
    t = np.clip(((ce[:, None] - pa[None, :, 0]) * ab[None, :, 0] +
                 (cn[:, None] - pa[None, :, 1]) * ab[None, :, 1]) / ab2[None, :], 0, 1)
    qe = pa[None, :, 0] + t * ab[None, :, 0]
    qn = pa[None, :, 1] + t * ab[None, :, 1]
    d2 = (qe - ce[:, None]) ** 2 + (qn - cn[:, None]) ** 2
    nearest = np.argmin(d2, axis=1)
    rows = np.arange(len(ce))
    pe, pn = qe[rows, nearest], qn[rows, nearest]  # voxel centre snapped onto its wall plane
    L = np.sqrt(ab2)[nearest]
    te, tn = ab[nearest, 0] / L, ab[nearest, 1] / L
    hm = (b.wy - b.base_y + 0.5) * vs
    vimg = b.seg_sel[nearest]  # (n_vox, n_slots)
    n, slots = vimg.shape
    P = len(sampling.PATTERN)
    CH = 100_000  # voxels per chunk: bounds the (n, slots*P, 3) sample tensor
    for c0 in range(0, n, CH):
        c1 = min(n, c0 + CH)
        vi = vimg[c0:c1]
        samples = np.zeros((c1 - c0, slots * P, 3), np.uint8)
        valid = np.zeros((c1 - c0, slots * P), bool)
        for im in np.unique(vi[vi >= 0]):
            arr = photo.thumbs.get(int(im))
            if arr is None:
                continue
            r_idx, s_idx = np.nonzero(vi == im)
            g_idx = r_idx + c0
            rgb, ok = sampling.sample_voxels(arr, float(photo.cam_e[im]), float(photo.cam_n[im]),
                                             float(photo.cam_h[im]), pe[g_idx], pn[g_idx], te[g_idx],
                                             tn[g_idx], hm[g_idx], vs, cfg)
            cols = s_idx[:, None] * P + np.arange(P)[None, :]
            samples[r_idx[:, None], cols] = rgb
            valid[r_idx[:, None], cols] = ok
        med, good = sampling.median_colour(samples, valid, cfg.mapillary_min_samples)
        if good.any():
            b.wall_rgb[c0:c1][good] = med[good]
            b.photo = True
    return b.photo
