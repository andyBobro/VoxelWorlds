"""Weighted median-cut palette quantization."""
from __future__ import annotations

import numpy as np


def median_cut(colors: np.ndarray, weights: np.ndarray, k: int):
    """colors (N,3) uint8, weights (N,). Returns (centroids (m,3) uint8, mapping (N,) int)."""
    n = len(colors)
    if n <= k:
        return colors.astype(np.uint8).copy(), np.arange(n)
    col = colors.astype(np.float64)
    w = weights.astype(np.float64) + 1e-9
    boxes = [np.arange(n)]

    def score(idx):
        return float(np.ptp(col[idx], axis=0).max() * w[idx].sum()) if len(idx) >= 2 else 0.0

    scores = [score(boxes[0])]
    while len(boxes) < k:
        # split the box with the largest weighted range (first one on ties; scores are cached per box)
        best, best_score = -1, 0.0
        for i, sc in enumerate(scores):
            if sc > best_score:
                best, best_score = i, sc
        if best < 0:
            break
        idx = boxes.pop(best)
        scores.pop(best)
        ch = int(np.argmax(np.ptp(col[idx], axis=0)))
        idx = idx[np.argsort(col[idx, ch], kind="stable")]
        cum = np.cumsum(w[idx])
        cut = int(np.searchsorted(cum, cum[-1] / 2.0)) + 1
        cut = min(max(cut, 1), len(idx) - 1)
        boxes.append(idx[:cut])
        boxes.append(idx[cut:])
        scores.append(score(boxes[-2]))
        scores.append(score(boxes[-1]))
    cents = np.zeros((len(boxes), 3), np.uint8)
    mapping = np.zeros(n, np.int64)
    for i, idx in enumerate(boxes):
        cents[i] = np.clip(np.rint((col[idx] * w[idx, None]).sum(0) / w[idx].sum()), 0, 255)
        mapping[idx] = i
    return cents, mapping
