"""Lane markings: dashes along ordinary roads, clear of junctions, deterministic."""
import os, sys, unittest
from shapely.geometry import LineString
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds import layers


def way(coords, w=7.0):
    ln = LineString(coords)
    return (ln, w, ln.buffer(w / 2.0, cap_style="flat"))


class MarkingTests(unittest.TestCase):
    def test_dashes_along_straight_road(self):
        src = [way([(0, 0), (100, 0)])]
        m = layers.lane_markings(src, 0.5)
        self.assertGreaterEqual(len(m), 10)
        for p in m:
            minx, miny, maxx, maxy = p.bounds
            self.assertLess(maxy - miny, 0.6)           # thin
            self.assertAlmostEqual(maxx - minx, layers.MARK_DASH_M, places=1)
            self.assertGreaterEqual(minx, layers.MARK_END_CLEAR_M - 0.01)
            self.assertLessEqual(maxx, 100 - layers.MARK_END_CLEAR_M + 0.01)

    def test_no_dashes_across_junction(self):
        src = [way([(0, 0), (100, 0)]), way([(50, -60), (50, 60)])]
        m = layers.lane_markings(src, 0.5)
        # no dash from the horizontal road may touch the vertical road's polygon, and vice versa
        horiz = [p for p in m if p.bounds[2] - p.bounds[0] > 2]
        vert = [p for p in m if p.bounds[3] - p.bounds[1] > 2]
        self.assertTrue(horiz and vert)
        self.assertTrue(all(not src[1][2].intersects(p) for p in horiz))
        self.assertTrue(all(not src[0][2].intersects(p) for p in vert))

    def test_deterministic_and_short_roads(self):
        src = [way([(0, 0), (60, 10)]), way([(0, 20), (4, 20)])]
        a, b = layers.lane_markings(src, 0.5), layers.lane_markings(src, 0.5)
        self.assertEqual([p.wkt for p in a], [p.wkt for p in b])
        self.assertFalse(any(p.bounds[1] > 15 for p in a))  # 4 m road: shorter than end clearance, no dash


if __name__ == "__main__":
    unittest.main()
