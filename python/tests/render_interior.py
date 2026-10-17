"""Debug renderer for interior output: top-down cutaway per storey and a vertical section (PNG via Pillow)."""
import numpy as np
from PIL import Image


def _scene(b, xyz, codes, g):
    ex = np.column_stack([b.wx, b.wy, b.wz]).astype(np.int64)
    ec = np.tile(np.array([[205, 190, 170]], np.int64), (len(ex), 1))
    rf = np.column_stack([b.rx, b.ry, b.rz]).astype(np.int64) if len(b.rx) else np.empty((0, 3), np.int64)
    rc = np.tile(np.array([[150, 80, 70]], np.int64), (len(rf), 1))
    ic = np.column_stack([(codes >> 19) & 255, (codes >> 11) & 255, (codes >> 3) & 255]).astype(np.int64)
    P = np.concatenate([ex, rf, xyz.astype(np.int64)])
    C = np.concatenate([ec, rc, ic])
    return P, C


def top_down(b, xyz, codes, g, y_cut, path, scale=6, pad=6):
    P, C = _scene(b, xyz, codes, g)
    m = P[:, 1] <= y_cut
    P, C = P[m], C[m]
    x0, x1 = P[:, 0].min() - pad, P[:, 0].max() + pad
    z0, z1 = P[:, 2].min() - pad, P[:, 2].max() + pad
    key = ((P[:, 0] - x0) * (z1 - z0 + 1) + (P[:, 2] - z0)) * 100000 + P[:, 1]
    o = np.argsort(key, kind="stable")
    k2 = key[o] // 100000
    last = np.ones(len(o), bool)
    last[:-1] = k2[1:] != k2[:-1]
    sel = o[last]
    img = np.full((int(z1 - z0 + 1), int(x1 - x0 + 1), 3), 34, np.uint8)
    ylo = P[:, 1].min()
    sh = 0.72 + 0.28 * np.clip((P[sel, 1] - ylo) / max(1, y_cut - ylo), 0, 1)
    img[P[sel, 2] - z0, P[sel, 0] - x0] = np.clip(C[sel] * sh[:, None], 0, 255).astype(np.uint8)
    Image.fromarray(img).resize((img.shape[1] * scale, img.shape[0] * scale), Image.NEAREST).save(path)


def section(b, xyz, codes, g, z_cut, path, scale=6, pad=6, ymax=None):
    P, C = _scene(b, xyz, codes, g)
    m = (P[:, 2] >= z_cut) & (P[:, 2] < z_cut + 400)
    P, C = P[m], C[m]
    if ymax is not None:
        keep = P[:, 1] <= ymax
        P, C = P[keep], C[keep]
    x0, x1 = P[:, 0].min() - pad, P[:, 0].max() + pad
    y0, y1 = P[:, 1].min(), P[:, 1].max() + pad
    key = ((P[:, 0] - x0) * (y1 - y0 + 1) + (P[:, 1] - y0)) * 100000 + (P[:, 2] - z_cut)
    o = np.argsort(key, kind="stable")
    k2 = key[o] // 100000
    first = np.ones(len(o), bool)
    first[1:] = k2[1:] != k2[:-1]
    sel = o[first]
    img = np.full((int(y1 - y0 + 1), int(x1 - x0 + 1), 3), 34, np.uint8)
    d = (P[sel, 2] - z_cut)
    sh = 1.0 - 0.45 * np.clip(d / max(1, np.percentile(d, 95)), 0, 1)
    img[(y1 - P[sel, 1]).astype(int), P[sel, 0] - x0] = np.clip(C[sel] * sh[:, None], 0, 255).astype(np.uint8)
    Image.fromarray(img).resize((img.shape[1] * scale, img.shape[0] * scale), Image.NEAREST).save(path)
