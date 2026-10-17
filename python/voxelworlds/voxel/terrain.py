"""Terrain heights as a pure function of the global voxel cell, backed by a coarse UTM-aligned DEM lattice.

Because the height of a cell depends only on its global (iz, ix), every tile (and every building that
crosses a tile edge) sees identical ground heights."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .grid import Grid


@dataclass
class Terrain:
    sp: float          # lattice spacing (m)
    a0: int            # lattice index of column 0: E = (a0 + i) * sp
    b0: int            # lattice index of row 0:    N = (b0 + j) * sp
    z: np.ndarray      # (nb, na) elevations, metres
    datum: float       # elevation mapped to voxel y = 0

    def metres(self, E, N) -> np.ndarray:
        """Bilinear elevation (m) on the lattice at UTM coordinates (edge-clamped)."""
        nb, na = self.z.shape
        fa = np.clip(np.asarray(E) / self.sp - self.a0, 0.0, na - 1.0)
        fb = np.clip(np.asarray(N) / self.sp - self.b0, 0.0, nb - 1.0)
        a = np.minimum(np.floor(fa).astype(np.int64), na - 2)
        b = np.minimum(np.floor(fb).astype(np.int64), nb - 2)
        ta, tb = fa - a, fb - b
        z = self.z
        return (z[b, a] * (1 - ta) * (1 - tb) + z[b, a + 1] * ta * (1 - tb) +
                z[b + 1, a] * (1 - ta) * tb + z[b + 1, a + 1] * ta * tb)

    def points(self, grid: Grid, iz, ix) -> np.ndarray:
        """Ground voxel height (int32) for broadcastable global cell indices."""
        E = grid.e0 + (np.asarray(ix) + 0.5) * grid.vs
        N = grid.n0 - (np.asarray(iz) + 0.5) * grid.vs
        return np.rint((self.metres(E, N) - self.datum) / grid.vs).astype(np.int32)

    def crop(self, grid: Grid, core, margin_cells: int = 3) -> "Terrain":
        """Lattice sub-window covering the cells of ``core`` (+ margin) so tasks ship a small array. Values
        for any covered cell are bit-identical to the full lattice (same samples, same clamping)."""
        ix0, iz0, ix1, iz1 = core
        m = margin_cells * grid.vs
        e_lo, e_hi = grid.e0 + ix0 * grid.vs - m, grid.e0 + ix1 * grid.vs + m
        n_lo, n_hi = grid.n0 - iz1 * grid.vs - m, grid.n0 - iz0 * grid.vs + m
        nb, na = self.z.shape
        ca0 = int(np.clip(np.floor(e_lo / self.sp) - self.a0 - 1, 0, na - 2))
        ca1 = int(np.clip(np.ceil(e_hi / self.sp) - self.a0 + 2, ca0 + 2, na))
        cb0 = int(np.clip(np.floor(n_lo / self.sp) - self.b0 - 1, 0, nb - 2))
        cb1 = int(np.clip(np.ceil(n_hi / self.sp) - self.b0 + 2, cb0 + 2, nb))
        return Terrain(self.sp, self.a0 + ca0, self.b0 + cb0, self.z[cb0:cb1, ca0:ca1].copy(), self.datum)

    def block(self, grid: Grid, iz0: int, iz1: int, ix0: int, ix1: int, rows: int = 256) -> np.ndarray:
        """(iz1-iz0, ix1-ix0) int32 heights, computed in row strips to bound temporaries."""
        out = np.empty((iz1 - iz0, ix1 - ix0), np.int32)
        ix = np.arange(ix0, ix1, dtype=np.int64)[None, :]
        for r in range(iz0, iz1, rows):
            r1 = min(iz1, r + rows)
            out[r - iz0:r1 - iz0] = self.points(grid, np.arange(r, r1, dtype=np.int64)[:, None], ix)
        return out


def ground_points(terrain: Optional[Terrain], grid: Grid, iz, ix) -> np.ndarray:
    """Heights at elementwise cell indices (zeros when there is no terrain)."""
    if terrain is None:
        return np.zeros(np.broadcast(np.asarray(iz), np.asarray(ix)).shape, np.int32)
    return terrain.points(grid, iz, ix)
