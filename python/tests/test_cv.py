"""Photo facade analysis on a synthetic wall: homography rectify + spec recovery."""
import json, os, sys, tempfile, time, unittest
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds.cv import analyze, rectify
from voxelworlds.protocol import Cancelled, PipelineError

WALL_W, WALL_H = 20.0, 10.5
WALL = (225, 205, 170)
GLASS = (60, 85, 115)
WINS = [(1.5 + 3.5 * i, 0.9 + 3.5 * f, 1.2, 1.5) for f in range(3) for i in range(5)]
DOOR = (1.5 + 3.5 * 2 + 0.1, 0.0, 1.0, 2.1)
QUAD = np.array([[130, 90], [790, 140], [770, 610], [160, 640]], float)


def is_door_window(u, v):
    return abs(u - 1.5 - 7.0) < 0.3 and v < 1.0


def elevation(ppm=30):
    """Ground-truth front elevation (windows, one door on the ground floor, mild noise)."""
    W, H = int(WALL_W * ppm), int(WALL_H * ppm)
    img = np.empty((H, W, 3), np.uint8)
    img[:] = WALL

    def paint(u, v, w, h, col):
        x0, x1 = int(round(u * ppm)), int(round((u + w) * ppm))
        y0, y1 = H - int(round((v + h) * ppm)), H - int(round(v * ppm))
        img[y0:y1, x0:x1] = col
    for (u, v, w, h) in WINS:
        if not is_door_window(u, v):
            paint(u, v, w, h, GLASS)
    paint(*DOOR, (95, 60, 40))
    rng = np.random.default_rng(1)
    return np.clip(img.astype(np.int16) + rng.integers(-4, 5, img.shape), 0, 255).astype(np.uint8)


def photo_of(elev, quad):
    """Perspective 'photo' (900x700) sampled through the inverse homography."""
    ph, pw = 700, 900
    h_, w_ = elev.shape[:2]
    src = np.array([[0, 0], [w_, 0], [w_, h_], [0, h_]], float)
    Hm = rectify.homography(quad, src)  # photo -> elevation
    ys, xs = np.mgrid[0:ph, 0:pw] + 0.5
    p = Hm[0, 0] * xs + Hm[0, 1] * ys + Hm[0, 2]
    q = Hm[1, 0] * xs + Hm[1, 1] * ys + Hm[1, 2]
    w = Hm[2, 0] * xs + Hm[2, 1] * ys + Hm[2, 2]
    u, v = p / w, q / w
    inside = (u >= 0) & (u < w_) & (v >= 0) & (v < h_)
    out = np.full((ph, pw, 3), (120, 160, 210), np.uint8)
    out[inside] = elev[np.clip(v[inside].astype(int), 0, h_ - 1), np.clip(u[inside].astype(int), 0, w_ - 1)]
    return out


class RectifyTests(unittest.TestCase):
    def test_homography_maps_corners(self):
        src = np.array([[0, 0], [10, 0], [10, 5], [0, 5]], float)
        H = rectify.homography(src, QUAD)
        for s, d in zip(src, QUAD):
            p = H @ [s[0], s[1], 1]
            np.testing.assert_allclose(p[:2] / p[2], d, atol=1e-6)

    def test_bad_quad(self):
        bow = np.array([[0, 0], [100, 100], [100, 0], [0, 100]], float)
        with self.assertRaises(PipelineError) as c:
            rectify.check_quad(bow)
        self.assertEqual(c.exception.code, "FACADE_ANALYSIS_FAILED")

    def test_mirrored_and_small_quads_rejected(self):
        mirrored = QUAD[[1, 0, 3, 2]]  # TR,TL,BL,BR: opposite winding
        with self.assertRaises(PipelineError) as c:
            rectify.check_quad(mirrored, (700, 900))
        self.assertEqual(c.exception.code, "FACADE_ANALYSIS_FAILED")
        tiny = np.array([[100, 100], [140, 100], [140, 130], [100, 130]], float)  # < 1% of 700x900
        with self.assertRaises(PipelineError):
            rectify.check_quad(tiny, (700, 900))
        sliver = np.array([[100, 100], [800, 100], [800, 130], [100, 130]], float)
        with self.assertRaises(PipelineError):
            rectify.check_quad(sliver, (700, 900))
        rectify.check_quad(QUAD, (700, 900))

    def test_giant_image_rejected(self):
        from PIL import Image
        d = tempfile.mkdtemp()
        p = os.path.join(d, "huge.png")
        Image.new("L", (12000, 12000)).save(p)  # 144 MP, compresses to almost nothing
        with self.assertRaises(PipelineError) as c:
            rectify.load_photo(p)
        self.assertEqual(c.exception.code, "PHOTO_UNREADABLE")
        g = os.path.join(d, "x.gif")
        Image.new("RGB", (50, 50)).save(g)
        with self.assertRaises(PipelineError) as c:
            rectify.load_photo(g)
        self.assertEqual(c.exception.code, "PHOTO_UNREADABLE")

    def test_rectify_recovers_elevation(self):
        ph = photo_of(elevation(), QUAD)
        rect, ppm, outside = rectify.rectify(ph, QUAD, WALL_W, WALL_H)
        self.assertLess(outside, 0.01)
        self.assertEqual(rect.shape[1], int(round(WALL_W * ppm)))
        u, v, w, h = WINS[0]
        x = int((u + w / 2) * ppm); y = rect.shape[0] - int((v + h / 2) * ppm)
        self.assertLess(np.abs(rect[y, x].astype(int) - GLASS).max(), 25)
        x = int((u + w + 1.0) * ppm)
        self.assertLess(np.abs(rect[y, x].astype(int) - WALL).max(), 25)


class AnalyzeTests(unittest.TestCase):
    def setUp(self):
        self.photo = photo_of(elevation(), QUAD)
        self.rect, self.ppm, _ = rectify.rectify(self.photo, QUAD, WALL_W, WALL_H)

    def test_spec_matches_ground_truth(self):
        spec = analyze.analyze_rectified(self.rect, self.ppm, WALL_W, WALL_H)
        self.assertEqual(spec["floors"], 3)
        self.assertEqual(len(spec["floorLinesV"]), 2)
        fl = spec["floorLinesV"]
        self.assertTrue(0 < fl[0] < fl[1] < WALL_H)
        self.assertAlmostEqual(fl[1] - fl[0], 3.5, delta=0.4)
        self.assertEqual(len(spec["windows"]), 14)
        self.assertEqual(len(spec["doors"]), 1)
        d = spec["doors"][0]
        self.assertEqual(d["v"], 0)
        self.assertAlmostEqual(d["u"], DOOR[0], delta=0.3)
        self.assertAlmostEqual(d["h"], 2.1, delta=0.3)
        for (u, v, w, h) in WINS:
            if is_door_window(u, v):
                continue
            best = min(spec["windows"], key=lambda r: abs(r["u"] - u) + abs(r["v"] - v))
            self.assertAlmostEqual(best["u"], u, delta=0.25)
            self.assertAlmostEqual(best["v"], v, delta=0.25)
            self.assertAlmostEqual(best["w"], w, delta=0.3)
            self.assertAlmostEqual(best["h"], h, delta=0.3)
        self.assertLess(np.abs(np.array(spec["wallColour"]) - WALL).max(), 12)
        self.assertLess(np.abs(np.array(spec["glassColour"]) - GLASS).max(), 15)
        self.assertEqual(spec["material"], "plaster")
        self.assertGreater(spec["confidence"]["windows"], 0.5)

    # ---- facade2 layout: red wall, cyan SQUARE-ish door far left at the street, bays that exist on one floor only
    F2_W, F2_H = 15.0, 7.0
    F2_WINS = [(4.5, 4.0, 2.25, 2.0), (8.1, 4.0, 2.25, 2.0), (11.7, 4.0, 2.25, 2.0),      # top floor: 3 windows
               (8.1, 0.5, 2.25, 2.0), (11.7, 0.5, 2.25, 2.0)]                              # ground floor: 2 + door
    F2_DOOR = (0.75, 0.0, 2.25, 2.85)

    def facade2(self, ppm=30, lift=0.0):
        W, H = int(self.F2_W * ppm), int(self.F2_H * ppm)
        img = np.empty((H, W, 3), np.uint8)
        img[:] = (200, 40, 40)

        def paint(u, v, w, h, col):
            img[H - int(round((v + h) * ppm)):H - int(round(v * ppm)), int(round(u * ppm)):int(round((u + w) * ppm))] = col
        for (u, v, w, h) in self.F2_WINS:
            paint(u - 0.2, v - 0.2, w + 0.4, h + 0.4, (250, 220, 0))        # frame
            paint(u, v, w, h, (250, 250, 250))
        paint(self.F2_DOOR[0], lift, self.F2_DOOR[2], self.F2_DOOR[3], (0, 200, 220))
        if lift:
            img[H - int(lift * ppm):] = (200, 40, 40)                          # the quad stops above street level
        return img

    def check_facade2(self, spec):
        self.assertEqual(len(spec["windows"]), 5, spec["windows"])
        self.assertEqual(len(spec["doors"]), 1, spec["doors"])
        for (u, v, w, h) in self.F2_WINS:
            best = min(spec["windows"], key=lambda r: abs(r["u"] - u) + abs(r["v"] - v))
            self.assertAlmostEqual(best["u"], u, delta=0.45)
            self.assertAlmostEqual(best["v"], v, delta=0.45)
        d = spec["doors"][0]
        self.assertAlmostEqual(d["u"], self.F2_DOOR[0], delta=0.4)
        self.assertEqual(d["v"], 0)
        self.assertGreater(d["h"], 2.4)

    def test_facade2_door_and_one_floor_bays(self):
        for ww in (15.0, 12.0):                  # wrong wall sizes squeeze the door aspect: still a door
            img = self.facade2()
            spec = analyze.analyze_rectified(img, img.shape[1] / ww, ww, ww * img.shape[0] / img.shape[1])
            self.assertEqual(len(spec["doors"]), 1, ww)
            self.assertEqual(len(spec["windows"]), 5, ww)
        img = self.facade2()
        self.check_facade2(analyze.analyze_rectified(img, img.shape[1] / self.F2_W, self.F2_W, self.F2_H))

    def test_door_when_quad_stops_above_street(self):
        img = self.facade2(lift=0.45)
        spec = analyze.analyze_rectified(img, img.shape[1] / self.F2_W, self.F2_W, self.F2_H)
        self.assertEqual(len(spec["doors"]), 1, spec)
        self.assertEqual(len(spec["windows"]), 5)

    def test_facade2_through_perspective_photo(self):
        el = self.facade2()
        quad = np.array([[140, 80], [800, 130], [780, 600], [150, 640]], float)
        ph = photo_of(el, quad)
        rect, ppm, _ = rectify.rectify(ph, quad, self.F2_W, self.F2_H)
        spec = analyze.analyze_rectified(rect, ppm, self.F2_W, self.F2_H)
        self.assertEqual(len(spec["doors"]), 1, spec["doors"])
        self.assertEqual(len(spec["windows"]), 5, spec["windows"])

    def test_door_not_confused_with_ground_floor_windows(self):
        spec = analyze.analyze_rectified(self.rect, self.ppm, WALL_W, WALL_H)
        for wi in spec["windows"]:                   # windows with sills are never doors
            self.assertGreater(wi["v"], 0.3)

    def test_deterministic(self):
        a = analyze.analyze_rectified(self.rect, self.ppm, WALL_W, WALL_H)
        b = analyze.analyze_rectified(self.rect.copy(), self.ppm, WALL_W, WALL_H)
        self.assertEqual(a, b)

    def test_blank_fails(self):
        blank = np.full((300, 400, 3), 128, np.uint8)
        with self.assertRaises(PipelineError) as c:
            analyze.analyze_rectified(blank, 20.0, 20.0, 15.0)
        self.assertEqual(c.exception.code, "FACADE_ANALYSIS_FAILED")

    def test_noise_does_not_crash(self):
        noise = np.random.default_rng(3).integers(0, 256, (300, 400, 3), dtype=np.uint8)
        spec = analyze.analyze_rectified(noise, 20.0, 20.0, 15.0)
        self.assertGreaterEqual(spec["floors"], 1)

    def test_cancel_latency(self):
        n = {"i": 0}

        def chk():
            n["i"] += 1
            if n["i"] == 3:
                raise Cancelled()
        with self.assertRaises(Cancelled):
            analyze.analyze_rectified(self.rect, self.ppm, WALL_W, WALL_H, None, chk)
        gaps, last = [], [time.monotonic()]

        def chk2():
            now = time.monotonic(); gaps.append(now - last[0]); last[0] = now
        analyze.analyze_rectified(self.rect, self.ppm, WALL_W, WALL_H, None, chk2)
        self.assertLess(max(gaps), 0.1)  # longest stretch between cancel checks
        gaps.clear(); last[0] = time.monotonic()
        rectify.rectify(self.photo, QUAD, WALL_W, WALL_H, chk2)
        self.assertLess(max(gaps), 0.1)

    def test_service_end_to_end(self):
        from PIL import Image
        from voxelworlds.cv import service
        from voxelworlds.protocol import Emitter, Job
        d = tempfile.mkdtemp()
        os.environ["VOXEL_TMP_DIR"] = d
        path = os.path.join(d, "p.jpg")
        Image.fromarray(self.photo).save(path, quality=92)
        ev = []

        class S:
            def write(s, l): ev.append(l)
            def flush(s): pass
        service.analyze_facade(Job("x", Emitter(S())), dict(photoPath=path, corners=QUAD.tolist(),
                                                            wallWidthM=WALL_W, wallHeightM=WALL_H))
        res = [json.loads(e) for e in ev if '"result"' in e][0]
        self.assertEqual(res["kind"], "analyzeFacade")
        self.assertTrue(os.path.basename(res["rectifiedPath"]).startswith("vw-"))
        self.assertTrue(os.path.isfile(res["rectifiedPath"]))
        self.assertEqual(res["spec"]["floors"], 3)
        bad = os.path.join(d, "bad.jpg")
        open(bad, "wb").write(b"not an image")
        with self.assertRaises(PipelineError) as c:
            service.analyze_facade(Job("y", Emitter(S())), dict(photoPath=bad, corners=QUAD.tolist(),
                                                               wallWidthM=WALL_W, wallHeightM=WALL_H))
        self.assertEqual(c.exception.code, "PHOTO_UNREADABLE")


if __name__ == "__main__":
    unittest.main()
