"""Terminal events must always reach the host, whatever the payload contains."""
import io, json, os, sys, unittest
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds.protocol import Emitter, Job


def make():
    buf, released = io.StringIO(), []
    return Job("r1", Emitter(buf), lambda: released.append(1)), buf, released


def events(buf):
    return [json.loads(l) for l in buf.getvalue().splitlines()]


class TerminalEventTests(unittest.TestCase):
    def test_numpy_payload_is_serialised(self):
        j, buf, rel = make()
        j.result({"kind": "detail", "stats": {"rooms": np.int64(3), "f": np.float32(1.5), "nan": float("nan"),
                                               "arr": np.arange(3, dtype=np.int32), "t": (1, 2)}})
        ev = events(buf)
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["type"], "result")
        self.assertEqual(ev[0]["stats"], {"rooms": 3, "f": 1.5, "nan": None, "arr": [0, 1, 2], "t": [1, 2]})
        self.assertEqual(rel, [1])

    def test_detail_entrances_round_trip_as_camel_case_json(self):
        ent = {"edge": 0, "city": [np.int64(42), 1, np.int32(77)], "cityDir": [-0.0059, 1.0],
               "inside": [np.float64(8.625), 0.15, 12.225], "outside": [8.625, 0.15, 14.025],
               "dir": [0.0059, -1.0], "widthM": 0.9}
        j, buf, rel = make()
        j.result({"kind": "detail", "vwgPath": "x.vwg",
                  "stats": {"voxelCount": 1, "floorYs": [0], "entrances": [ent]}})
        ev = events(buf)
        self.assertEqual([e["type"] for e in ev], ["result"])
        got = ev[0]["stats"]["entrances"]
        self.assertEqual(got, [{**ent, "city": [42, 1, 77], "inside": [8.625, 0.15, 12.225]}])
        self.assertEqual(set(got[0]), {"edge", "city", "cityDir", "inside", "outside", "dir", "widthM"})

    def test_unserialisable_result_becomes_internal_error(self):
        j, buf, rel = make()
        j.result({"kind": "detail", "stats": {"bad": {1, 2, 3}}})        # a set: json.dumps raises TypeError
        ev = events(buf)
        self.assertEqual([e["type"] for e in ev], ["error"])
        self.assertEqual(ev[0]["code"], "INTERNAL")
        self.assertEqual(ev[0]["id"], "r1")
        self.assertEqual(rel, [1])           # the slot is released exactly once and the job is closed
        j.progress("x", 5)
        j.error("INTERNAL", "again")
        self.assertEqual(len(events(buf)), 1)
        self.assertEqual(rel, [1])

    def test_unserialisable_progress_is_dropped_without_closing(self):
        j, buf, rel = make()
        j.warning("W", "ok")
        j._send({"id": "r1", "type": "progress", "stage": object()})
        j.result({"kind": "k"})
        self.assertEqual([e["type"] for e in events(buf)], ["warning", "result"])


if __name__ == "__main__":
    unittest.main()
