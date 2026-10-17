"""Tiny synthetic .osm.pbf (pyosmium SimpleWriter) around Zurich for the pbf source tests."""
import math

LON0, LAT0 = 8.5400, 47.3660
BBOX = dict(latMin=47.3650, lonMin=8.5390, latMax=47.3680, lonMax=8.5420)
HEADER_BOX = (8.50, 47.30, 8.60, 47.40)       # west, south, east, north


def _m(dx: float, dy: float):
    """Offset in metres from the origin -> (lon, lat)."""
    return (LON0 + dx / (111_320.0 * math.cos(math.radians(LAT0))), LAT0 + dy / 111_320.0)


def _square(x: float, y: float, s: float):
    return [(x, y), (x + s, y), (x + s, y + s), (x, y + s)]


def write_pbf(path: str, header_box=HEADER_BOX) -> dict:
    """Writes the file; returns {name: id} of the interesting objects."""
    import osmium
    M = osmium.osm.mutable
    nodes = {}            # id -> (lon, lat, tags)
    ways = {}             # id -> (node ids, tags)
    rels = {}             # id -> (members, tags)
    nid = [1000]

    def pts(coords, closed=False):
        ids = []
        for c in coords:
            nid[0] += 1
            nodes[nid[0]] = (*_m(*c), {})
            ids.append(nid[0])
        if closed:
            ids.append(ids[0])
        return ids

    ids = {}
    ways[101] = (pts(_square(0, 0, 20), True), {"building": "yes", "building:levels": "4"})
    ways[102] = (pts(_square(40, 0, 15), True), {"building": "house", "height": "12.5", "roof:shape": "gabled"})
    ways[110] = (pts(_square(0, 40, 40), True), {})                      # outer of the multipolygon building
    ways[111] = (pts(_square(10, 50, 15), True), {})                     # its hole
    rels[900] = ([("w", 110, "outer"), ("w", 111, "inner")],
                 {"type": "multipolygon", "building": "apartments", "building:levels": "6"})
    ways[120] = (pts(_square(0, 0, 20), True), {"building:part": "yes", "height": "20", "building:colour": "red"})
    ways[130] = (pts([(-50, -20), (0, -20), (60, -20)]), {"highway": "residential", "name": "Teststrasse",
                                                          "lanes": "2"})
    ways[131] = (pts([(-50, 80), (0, 80), (60, 80)]), {"highway": "primary", "bridge": "yes", "layer": "1"})
    ways[140] = (pts([(-50, 100), (0, 110), (60, 100)]), {"waterway": "river", "width": "12"})
    ways[141] = (pts(_square(70, 40, 30), True), {"natural": "water"})
    ways[142] = (pts(_square(70, -30, 25), True), {"landuse": "forest"})
    ways[150] = (pts(_square(-40, 30, 10), True), {"highway": "residential", "junction": "roundabout"})
    ways[160] = (pts([(-30, 60), (-30, 70), (-20, 70), (-30, 60)]), {"barrier": "fence"})        # closed, stays a line
    ways[170] = (pts(_square(3000, 3000, 20), True), {"building": "yes"})                           # far outside BBOX
    ways[180] = (pts(_square(-20, -20, 8), True), {"building": "yes", "area": "no"})                # closed, area=no
    ways[190] = (pts([(5, 5), (6, 5), (6, 6)]), {"note": "untagged-for-us"})                       # not a feature
    nodes[2001] = (*_m(10, 0), {"entrance": "main"})
    nodes[2002] = (*_m(-30, -10), {"man_made": "street_lamp"})
    nodes[2003] = (*_m(80, 60), {"natural": "tree"})
    nodes[2004] = (*_m(15, 15), {"amenity": "bench"})                                               # not matching
    ids.update(entrance=2001, lamp=2002, tree=2003, bld_levels=101, bld_height=102, mp=900, part=120,
               road=130, bridge=131, river=140, lake=141, forest=142, roundabout=150, fence=160, far=170,
               area_no=180)

    hdr = osmium.io.Header()
    if header_box:
        hdr.add_box(osmium.osm.Box(header_box[0], header_box[1], header_box[2], header_box[3]))
    with osmium.SimpleWriter(path, header=hdr, overwrite=True) as w:
        for i in sorted(nodes):
            lon, lat, tags = nodes[i]
            w.add_node(M.Node(id=i, location=(lon, lat), tags=tags))
        for i in sorted(ways):
            n, tags = ways[i]
            w.add_way(M.Way(id=i, nodes=n, tags=tags))
        for i in sorted(rels):
            m, tags = rels[i]
            w.add_relation(M.Relation(id=i, members=m, tags=tags))
    return ids
