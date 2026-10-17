"""voxel/merge.py: streaming dedupe + sort must equal a plain global sort, with a bounded memory peak."""
import os, sys, tracemalloc, unittest
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds.voxel.merge import merge_unique


def reference(parts, nz):
    X = np.concatenate([p[0] for p in parts]).astype(np.int64)
    Y = np.concatenate([p[1] for p in parts]).astype(np.int64)
    Z = np.concatenate([p[2] for p in parts]).astype(np.int64)
    C = np.concatenate([p[3] for p in parts])
    ymin = int(Y.min()); ny = int(Y.max()) - ymin + 2
    key = (X * (nz + 1) + Z) * ny + (Y - ymin)
    order = np.argsort(key, kind="stable")
    ks = key[order]
    last = np.ones(len(ks), bool); last[:-1] = ks[1:] != ks[:-1]
    o = order[last]
    return X[o].astype(np.int32), Y[o].astype(np.int32), Z[o].astype(np.int32), C[o]


def make_parts(rng, nparts=40, nmax=3000, box=60):
    parts = []
    for i in range(nparts):
        n = int(rng.integers(0, nmax))
        parts.append([rng.integers(-5, box, n).astype(np.int64 if i % 2 else np.int32), rng.integers(0, 30, n).astype(np.int32),
                      rng.integers(0, box, n).astype(np.int32), rng.integers(0, 2 ** 20, n).astype(np.uint32)])
    return parts


class MergeTests(unittest.TestCase):
    def test_equals_global_sort_later_wins(self):
        rng = np.random.default_rng(5)
        for sv in (10 ** 9, 5000, 700):
            parts = make_parts(rng)
            ref = reference([list(p) for p in parts], 61)
            got = merge_unique(parts, 61, slice_voxels=sv)
            self.assertEqual(parts, [])
            for a, b in zip(ref, got):
                np.testing.assert_array_equal(a, b)
            self.assertEqual([a.dtype for a in got], [np.int32, np.int32, np.int32, np.uint32])

    def test_empty_and_single(self):
        e = merge_unique([[np.empty(0, np.int32)] * 3 + [np.empty(0, np.uint32)]], 10)
        self.assertEqual(len(e[0]), 0)
        got = merge_unique([[np.array([3]), np.array([1]), np.array([2]), np.array([7], np.uint32)]], 10)
        self.assertEqual([int(a[0]) for a in got], [3, 1, 2, 7])

    def test_check_called_and_cancel_propagates(self):
        rng = np.random.default_rng(1)
        n = {"i": 0}

        def chk():
            n["i"] += 1
            if n["i"] == 6:
                raise KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            merge_unique(make_parts(rng), 61, chk, slice_voxels=2000)

    def test_peak_memory_is_close_to_the_data_size(self):
        rng = np.random.default_rng(2)
        n = 1_500_000
        mk = lambda: [rng.integers(0, 400, n // 3).astype(np.int32), rng.integers(0, 40, n // 3).astype(np.int32),
                      rng.integers(0, 400, n // 3).astype(np.int32), rng.integers(0, 99, n // 3).astype(np.uint32)]
        parts = [mk(), mk(), mk()]
        tracemalloc.start()
        base = tracemalloc.get_traced_memory()[0]
        res = merge_unique(parts, 401, slice_voxels=300_000)
        peak = tracemalloc.get_traced_memory()[1] - base
        tracemalloc.stop()
        self.assertLess(peak / n, 36.0, f"{peak / n:.1f} B/voxel peak")      # 16 B data + 16 B result + keys
        self.assertGreater(len(res[0]), 0)


if __name__ == "__main__":
    unittest.main()
