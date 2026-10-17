"""Trees / lamps / barriers: determinism, tile-seam identity, scatter inside polygons."""
import os, sys, unittest
import numpy as np
from shapely.geometry import LineString, Polygon
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds.config import DEFAULT_CONFIG as cfg
from voxelworlds.voxel import props
from voxelworlds.voxel.grid import make_grid

BBOX = dict(latMin=32.8300, latMax=32.8310, lonMin=34.9770, lonMax=34.9780)


def whole(p, grid):
    return props.voxelize_prop(p, grid, None, (0, 0, grid.nx, grid.nz))


def keys(v):
    return set(zip(v[0].tolist(), v[1].tolist(), v[2].tolist()))


class PropTests(unittest.TestCase):
    def setUp(self):
        self.grid, _ = make_grid(BBOX, 0.5)
        self.e, self.n = self.grid.e0 + 40.2, self.grid.n0 - 40.7

    def test_tree_shape_and_colours(self):
        v = whole(("tree", self.e, self.n, 9.0, 5.0, False, 12345), self.grid)
        x, y, z, rgb, mat = v
        self.assertEqual(mat, 5)
        self.assertGreater(len(x), 150)
        self.assertGreaterEqual(int(y.max() - y.min()), int(8.0 / 0.5) - 3)  # ~9 m tall
        g = rgb[:, 1].astype(int)
        self.assertGreater((g > rgb[:, 0]).mean(), 0.8)  # mostly green crown

    def test_tile_seam_identity(self):
        p = ("tree", self.e, self.n, 9.0, 6.0, True, 99)
        a = whole(p, self.grid)
        cx = int((self.e - self.grid.e0) / 0.5)
        left = props.voxelize_prop(p, self.grid, None, (0, 0, cx, self.grid.nz))
        right = props.voxelize_prop(p, self.grid, None, (cx, 0, self.grid.nx, self.grid.nz))
        self.assertEqual(keys(a), keys(left) | keys(right))
        self.assertEqual(len(keys(left) & keys(right)), 0)

    def test_lamp_and_barrier(self):
        lamp = whole(("lamp", self.e, self.n, 5.0), self.grid)
        self.assertEqual(int(lamp[1].max() - lamp[1].min()) + 1, 10)
        line = LineString([(self.e, self.n), (self.e + 10, self.n)])
        poly = line.buffer(0.15, cap_style="flat")
        bar = whole(("bar", poly, 1.2, (150, 124, 92), 0.3), self.grid)
        self.assertEqual(int(bar[1].max() - bar[1].min()) + 1, int(round(1.2 / 0.5)))
        self.assertGreater(len(bar[0]), 20)

    def test_scatter_inside_polygon_and_deterministic(self):
        poly = Polygon([(0, 0), (120, 0), (120, 80), (0, 80)])
        a, b = [], []
        props._scatter(poly, 6.0, "wood", 1337, a, False)
        props._scatter(poly, 6.0, "wood", 1337, b, False)
        self.assertEqual(a, b)
        self.assertGreater(len(a), 150)
        self.assertTrue(all(0 <= t[1] <= 120 and 0 <= t[2] <= 80 for t in a))


if __name__ == "__main__":
    unittest.main()
