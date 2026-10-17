"""Facade detail on a synthetic 14x9 m, 4-floor apartment block."""
import os, sys, unittest
import numpy as np
from shapely.geometry import Polygon
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds.config import DEFAULT_CONFIG as cfg
from voxelworlds.voxel import details, facade, roofs
from voxelworlds.voxel.buildings import Building, voxelize_building
from voxelworlds.voxel.grid import make_grid

BBOX = dict(latMin=32.8300, latMax=32.8310, lonMin=34.9770, lonMax=34.9780)
WALL, WIN = (200, 190, 170), (62, 84, 108)


def make(vs, kind="residential", ents=None, mat=None):
    grid, to_utm = make_grid(BBOX, vs)
    cx, cy = grid.e0 + 40.0, grid.n0 - 40.0
    poly = Polygon([(cx, cy), (cx + 14, cy), (cx + 14, cy + 9), (cx, cy + 9)])
    b = Building("t#0", poly, 13.0, 0.0, kind, None, None, "apartments", roofs.RoofSpec(), mat, None)
    if ents:
        b.entrances = [(cx + dx, cy + dy) for dx, dy in ents]
    voxelize_building(b, grid, None, cfg)
    return b, grid


class DetailTests(unittest.TestCase):
    def test_details_colours_and_balconies(self):
        b, grid = make(0.5)
        n0 = len(b.wx)
        details.apply_details(b, grid, 0.5, 3.5, WALL, WIN, facade.seed_for(b.key, 1))
        self.assertEqual(len(b.wall_rgb), len(b.wx))
        cols = {tuple(c) for c in b.wall_rgb}
        for want in (WIN, tuple(int(c * 0.72) for c in WALL)):
            self.assertIn(want, cols)
        self.assertGreaterEqual(len(cols), 4)  # wall, windows, plinth, door (+ balcony; no cornice on flat roofs)
        self.assertTrue(any(c in cols for c in details.DOOR_COLOURS))

    def test_balconies_added_outside_footprint(self):
        found = False
        for seed in range(12):  # 70 % chance per seed
            b, grid = make(0.5)
            n0 = len(b.wx)
            details.apply_details(b, grid, 0.5, 3.5, WALL, WIN, seed)
            if len(b.wx) > n0:
                found = True
                import shapely
                e, nn = grid.centers_e(b.wx[n0:]), grid.centers_n(b.wz[n0:])
                self.assertFalse(shapely.contains_xy(b.poly, e, nn).any())  # all outside the walls
                break
        self.assertTrue(found)

    def test_entrance_node_places_door(self):
        b, grid = make(0.5, ents=[(7.0, 0.0)])
        details.apply_details(b, grid, 0.5, 3.5, WALL, WIN, 3)
        door = [c for c in details.DOOR_COLOURS if (b.wall_rgb == np.array(c, np.uint8)).all(1).any()]
        self.assertTrue(door)
        m = (b.wall_rgb == np.array(door[0], np.uint8)).all(1)
        e = grid.centers_e(b.wx[m]); nn = grid.centers_n(b.wz[m])
        self.assertLess(abs(float(np.mean(nn)) - (grid.n0 - 40.0)), 1.0)  # on the entrance's wall
        self.assertLess(abs(float(np.mean(e)) - (grid.e0 + 40.0 + 7.0)), 1.0)

    def test_deterministic_and_glass(self):
        b1, g = make(0.5); b2, _ = make(0.5)
        details.apply_details(b1, g, 0.5, 3.5, WALL, WIN, 9); details.apply_details(b2, g, 0.5, 3.5, WALL, WIN, 9)
        self.assertTrue((b1.wall_rgb == b2.wall_rgb).all() and len(b1.wx) == len(b2.wx))
        bg, gg = make(0.5, mat="glass")
        details.apply_details(bg, gg, 0.5, 3.5, WALL, WIN, 9)  # must not raise


if __name__ == "__main__":
    unittest.main()
