"""Memory-lean merge of voxel parts: dedupe (later part wins) and sort by (x, z, y).

Streaming design: the parts are first routed, one at a time and released right after, into buckets of consecutive
x columns of about ``SLICE_VOXELS`` voxels; every bucket is then deduped/sorted on its own (int64 keys only for
that bucket) and its input is released before the next one starts. Peak memory is therefore about
16 B/voxel (the data itself, int32 x/y/z + uint32 code) + 4 B/voxel while the final columns are concatenated
+ the temporaries of one bucket and of the largest single part - not 2 x 16 B + keys as a global sort needs."""
from __future__ import annotations

from typing import Callable, List, Optional, Tuple

import numpy as np

SLICE_VOXELS = 1_000_000
BATCH_VOXELS = 1_000_000


def merge_unique(parts: List[list], nz: int, check: Optional[Callable[[], None]] = None,
                 slice_voxels: int = SLICE_VOXELS) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """parts: list of [x, y, z, code] LISTS (the list is emptied and the arrays released while it is consumed).
    Returns x, y, z (int32) and code (uint32), sorted by (x, z, y), one voxel per position, the LAST part wins."""
    check = check or (lambda: None)
    n = sum(len(p[0]) for p in parts)
    if n == 0:
        parts.clear()
        e = np.empty(0, np.int32)
        return e, e.copy(), e.copy(), np.empty(0, np.uint32)
    # ---- pass 1: extents + x histogram (cheap, no copies)
    xmin = min(int(p[0].min()) for p in parts if len(p[0]))
    xmax = max(int(p[0].max()) for p in parts if len(p[0]))
    ymin = min(int(p[1].min()) for p in parts if len(p[1]))
    ymax = max(int(p[1].max()) for p in parts if len(p[1]))
    ny = ymax - ymin + 2
    hist = np.zeros(xmax - xmin + 1, np.int64)
    for p in parts:
        if len(p[0]):
            hist += np.bincount(p[0] - xmin, minlength=len(hist))
    check()
    edges = [0]                    # bucket b holds x - xmin in [edges[b], edges[b + 1])
    acc = 0
    for i, h in enumerate(hist.tolist()):
        acc += h
        if acc >= slice_voxels:
            edges.append(i + 1)
            acc = 0
    if edges[-1] != len(hist):
        edges.append(len(hist))
    ub = np.asarray(edges[1:], np.int64)           # exclusive upper bound of every bucket
    nb = len(ub)
    buckets: List[List[list]] = [[] for _ in range(nb)]
    del hist

    def route(x, y, z, c):
        sid = np.searchsorted(ub, x.astype(np.int64) - xmin, side="right")
        if nb == 1:
            buckets[0].append([x.astype(np.int32), y.astype(np.int32), z.astype(np.int32), c.astype(np.uint32)])
            return
        order = np.argsort(sid, kind="stable")
        cnt = np.bincount(sid, minlength=nb)
        del sid
        pos = 0
        for b in range(nb):
            k = int(cnt[b])
            if k:
                o = order[pos:pos + k]
                buckets[b].append([x[o].astype(np.int32), y[o].astype(np.int32), z[o].astype(np.int32),
                                   c[o].astype(np.uint32)])
            pos += k

    # ---- pass 2: route parts (in order, so 'later wins' survives), batching the many tiny ones
    pend: List[list] = []
    pend_n = 0

    def flush():
        nonlocal pend, pend_n
        if not pend:
            return
        if len(pend) == 1:
            route(*pend[0])
        else:
            route(*[np.concatenate([q[i] for q in pend]) for i in range(4)])
        for q in pend:
            q[:] = [None] * 4
        pend, pend_n = [], 0
    while parts:
        check()
        p = parts.pop(0)
        k = len(p[0])
        if k == 0:
            continue
        if k >= BATCH_VOXELS:
            flush()
            for o in range(0, k, slice_voxels):         # bounded work between cancel checks
                check()
                route(p[0][o:o + slice_voxels], p[1][o:o + slice_voxels], p[2][o:o + slice_voxels],
                      p[3][o:o + slice_voxels])
            p[:] = [None] * 4
        else:
            pend.append(p)
            pend_n += k
            if pend_n >= BATCH_VOXELS:
                flush()
        del p
    flush()
    # ---- pass 3: dedupe + sort bucket by bucket, releasing the input as we go
    outs: List[Tuple[np.ndarray, ...]] = []
    for b in range(nb):
        check()
        pieces = buckets[b]
        buckets[b] = []
        if not pieces:
            continue
        X, Y, Z, C = (np.concatenate([q[i] for q in pieces]) for i in range(4))
        del pieces
        key = (X.astype(np.int64) * (nz + 1) + Z) * ny + (Y - ymin)
        order = np.argsort(key, kind="stable")
        ks = key[order]
        del key
        last = np.ones(len(ks), bool)
        last[:-1] = ks[1:] != ks[:-1]
        sel = order[last]
        del order, ks, last
        outs.append((X[sel], Y[sel], Z[sel], C[sel]))
        del X, Y, Z, C, sel
    # ---- final columns, releasing slice columns as they are consumed
    res = []
    for ci in range(4):
        check()
        res.append(np.concatenate([o[ci] for o in outs]))
        outs = [o[:ci] + (None,) + o[ci + 1:] for o in outs]
    return res[0], res[1], res[2], res[3]
