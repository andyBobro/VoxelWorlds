"""Central tunables for the pipeline (single config object)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Tuple

RGB = Tuple[int, int, int]


@dataclass(frozen=True)
class Config:
    seed: int = 1337
    overpass_timeout_s: int = 90
    # tiling / parallelism
    default_tile_size_m: float = 500.0
    max_tile_cells: int = 4096  # per tile edge (memory bound)
    max_workers_auto: int = 8
    overpass_concurrency: int = 2
    overpass_chunk_m: float = 2500.0  # max edge of one Overpass query
    overpass_retries: int = 6
    overpass_mirror_cooldown_s: float = 120.0  # a mirror that failed (5xx / 403 / network) is skipped this long
    # rotated on failure; overpass.openstreetmap.fr is whitelist-only (403) and overpass.osm.ch is Swiss-only
    overpass_urls: Tuple[str, ...] = ("https://overpass-api.de/api", "https://lz4.overpass-api.de/api",
                                      "https://z.overpass-api.de/api", "https://overpass.private.coffee/api",
                                      "https://overpass.kumi.systems/api")
    osm_cache_ttl_s: float = 7 * 86400
    dem_cache_ttl_s: float = 90 * 86400
    mapillary_cache_ttl_s: float = 86400
    mapillary_thumb_ttl_s: float = 30 * 86400
    # roads: width in metres per highway class
    road_widths: Dict[str, float] = field(default_factory=lambda: {
        "motorway": 12.0, "motorway_link": 6.0, "trunk": 11.0, "trunk_link": 6.0,
        "primary": 9.0, "primary_link": 5.0, "secondary": 8.0, "secondary_link": 5.0,
        "tertiary": 7.0, "tertiary_link": 4.5, "unclassified": 6.0, "residential": 6.0,
        "living_street": 5.0, "service": 3.5, "pedestrian": 4.0, "footway": 2.0,
        "path": 1.5, "cycleway": 2.0, "steps": 2.0, "track": 3.0, "bridleway": 2.0,
    })
    default_road_width: float = 4.0
    lane_width: float = 3.2
    min_building_voxels: int = 2
    # colours
    ground_color: RGB = (122, 134, 98)
    urban_ground_color: RGB = (142, 140, 134)
    road_color: RGB = (62, 62, 66)
    path_color: RGB = (170, 160, 148)
    water_color: RGB = (52, 102, 160)
    grass_color: RGB = (86, 130, 68)
    forest_color: RGB = (52, 96, 52)
    sand_color: RGB = (214, 200, 150)
    window_color: RGB = (62, 84, 108)
    environment_props: bool = True        # trees, street lamps, fences/hedges/walls
    props_max_voxel_size: float = 2.0     # skip props at coarser voxel sizes (a tree is smaller than a voxel)
    facade_details: bool = True           # grouped windows, plinth, cornice, shopfronts, doors, balconies (vs <= 1 m)
    roof_details: bool = True             # parapets, rooftop equipment, chimneys, ridge caps, roof texture (vs <= 1 m)
    facade_texture: bool = True           # per-material wall texture (plaster noise, brick, stone blocks, timber, panes)
    # ground realism
    dirt_color: RGB = (104, 82, 60)       # buried / skirt voxels under slopes
    water_bed_color: RGB = (92, 84, 70)
    water_drop_m: float = 0.5             # water surface this far (>= 1 voxel) below the bank level
    water_widths: Dict[str, float] = field(default_factory=lambda: {
        "river": 15.0, "canal": 10.0, "stream": 2.0, "drain": 1.5, "ditch": 1.5})
    water_max_below_m: float = 3.0        # water surface is 1 voxel .. this far below the bank level
    water_flat_tol_m: float = 1.5         # terrain spread under a water body above which it follows the slope
    water_piece_m: float = 60.0           # rivers are cut into pieces of this length, each with its own flat level
    ground_jitter_pct: float = 3.0        # per-cell brightness jitter (%) of plain ground
    ground_patch_pct: float = 3.0         # ~6 m patch variation (%)
    skirt_max_depth_m: float = 40.0        # cap on skirt depth per ground column (cliffs beyond this stay open)
    bridges: bool = True
    bridge_deck_thickness_m: float = 0.5
    bridge_min_clearance_m: float = 1.0
    # surface=* colours (roads / paths / pitches)
    surface_colors: Dict[str, RGB] = field(default_factory=lambda: {
        "asphalt": (62, 62, 66), "concrete": (176, 175, 170), "paving": (146, 132, 124),
        "gravel": (180, 172, 158), "dirt": (112, 88, 62), "grass": (94, 130, 70), "sand": (214, 200, 150),
        "wood": (132, 98, 64), "unpaved": (150, 128, 98), "metal": (110, 116, 124), "rock": (128, 124, 118),
        "tartan": (166, 74, 62), "clay": (184, 102, 70), "artificial_turf": (64, 138, 74)})
    surface_aliases: Dict[str, str] = field(default_factory=lambda: {
        "paved": "asphalt", "asphalt": "asphalt", "chipseal": "asphalt", "bitumen": "asphalt",
        "concrete": "concrete", "concrete:plates": "concrete", "concrete:lanes": "concrete",
        "cement": "concrete", "paving_stones": "paving", "paving_stones:lanes": "paving", "sett": "paving",
        "cobblestone": "paving", "unhewn_cobblestone": "paving", "bricks": "paving", "brick": "paving",
        "pavers": "paving", "stone": "paving", "gravel": "gravel", "fine_gravel": "gravel",
        "pebblestone": "gravel", "compacted": "gravel", "dirt": "dirt", "ground": "dirt", "earth": "dirt",
        "mud": "dirt", "soil": "dirt", "grass": "grass", "grass_paver": "grass", "sand": "sand",
        "wood": "wood", "woodchips": "wood", "unpaved": "unpaved", "metal": "metal", "rock": "rock",
        "tartan": "tartan", "clay": "clay", "artificial_turf": "artificial_turf"})
    checker_surfaces: Tuple[str, ...] = ("paving",)
    # land cover: "key=value" -> colour (paint order is the order of paint_classes, then key)
    landcover_colors: Dict[str, RGB] = field(default_factory=lambda: {
        "landuse=residential": (150, 146, 138), "landuse=commercial": (156, 150, 144),
        "landuse=retail": (160, 152, 146), "landuse=industrial": (130, 128, 124),
        "landuse=construction": (150, 128, 96), "landuse=railway": (118, 112, 106),
        "landuse=garages": (136, 134, 130), "landuse=brownfield": (140, 124, 100),
        "landuse=education": (150, 148, 132), "landuse=institutional": (148, 146, 136),
        "landuse=quarry": (150, 140, 124),
        "landuse=grass": (86, 130, 68), "landuse=meadow": (112, 144, 72), "landuse=farmland": (170, 152, 86),
        "landuse=orchard": (98, 134, 66), "landuse=vineyard": (120, 130, 70),
        "landuse=cemetery": (98, 128, 88), "landuse=recreation_ground": (100, 138, 76),
        "landuse=village_green": (92, 136, 70), "landuse=allotments": (120, 130, 76),
        "landuse=flowerbed": (120, 140, 80), "landuse=plant_nursery": (96, 132, 70),
        "leisure=park": (86, 130, 68), "leisure=garden": (92, 134, 72), "leisure=golf_course": (110, 160, 80),
        "natural=grassland": (104, 136, 70), "natural=scrub": (84, 112, 64), "natural=heath": (128, 120, 84),
        "natural=wetland": (96, 120, 92), "natural=bare_rock": (128, 124, 118), "natural=scree": (150, 144, 134),
        "natural=glacier": (232, 240, 246), "natural=wood": (52, 96, 52), "landuse=forest": (52, 96, 52),
        "natural=beach": (214, 200, 150), "natural=sand": (214, 200, 150),
        "leisure=pitch": (170, 160, 148), "leisure=playground": (170, 160, 148)})
    landcover_patch_pct: Dict[str, float] = field(default_factory=lambda: {
        "landuse=farmland": 7.0, "landuse=meadow": 5.0, "landuse=vineyard": 6.0, "landuse=orchard": 5.0,
        "natural=scree": 6.0, "natural=bare_rock": 6.0, "natural=heath": 5.0, "natural=scrub": 5.0,
        "natural=wood": 4.0, "landuse=forest": 4.0})
    # DEM
    dem_max_samples_per_axis: int = 50
    dem_spacing_m: float = 30.0
    dem_raster_min_spacing_m: float = 4.0      # GLO-30 path: lattice spacing = clamp(ceil(voxel), this, dem_spacing_m)
    dem_raster_max_samples_per_axis: int = 4000
    dem_datum_margin_m: float = 2.0            # datum = floor(min elevation) - this, leaves room for water beds
    dem_datasets: Tuple[str, ...] = ("srtm30m", "mapzen")
    # mapillary
    mapillary_tile_deg: float = 0.006
    mapillary_max_tiles: int = 36
    mapillary_max_images: int = 300
    mapillary_max_distance_m: float = 45.0
    mapillary_hfov_deg: float = 65.0
    mapillary_camera_height_m: float = 2.5
    mapillary_images_per_segment: int = 4   # best images per wall segment (median across them)
    mapillary_min_samples: int = 4          # valid pixel samples needed per voxel, else procedural colour
    mapillary_min_height_m: float = 0.9     # ignore the lowest strip of walls (curbs, cars, road splash)
    mapillary_hires_vs: float = 0.5         # voxel size <= this: use thumb_1024_url
    mapillary_max_images_fine: int = 150
    mapillary_thumb_fine_px: int = 768      # max side of stored 1024 thumbnails
    mapillary_occlusion_check: bool = True
    max_palette: int = 4096
    # roofs
    infer_roof_shapes: bool = True        # guess pitched roofs from building type when roof:shape is absent
    roof_pitch_deg: float = 35.0          # default pitch of gabled / hipped / pyramidal roofs
    skillion_pitch_deg: float = 12.0
    mansard_height_m: float = 3.5
    roof_max_height_m: float = 10.0
    roof_max_frac: float = 0.6            # roof height <= this * building height (height includes the roof)
    infer_narrow_depth_m: float = 14.0    # footprint depth (short side) up to which untagged city buildings may get pitched roofs
    infer_narrow_pitched_prob: float = 0.6
    infer_max_height_m: float = 24.0      # no inferred pitched roofs above this building height
    # heights without height/levels tags
    typical_heights: Dict[str, float] = field(default_factory=lambda: {
        "house": 7.0, "detached": 7.0, "semidetached_house": 7.0, "terrace": 8.0, "bungalow": 5.0,
        "villa": 8.0, "farm": 6.0, "residential": 12.0, "apartments": 15.0, "dormitory": 15.0,
        "commercial": 12.0, "retail": 8.0, "supermarket": 7.0, "office": 15.0, "hotel": 15.0,
        "industrial": 8.0, "warehouse": 8.0, "factory": 10.0, "hangar": 10.0,
        "garage": 3.0, "garages": 3.0, "shed": 3.0, "carport": 3.0, "roof": 3.5, "hut": 3.0,
        "cabin": 3.5, "kiosk": 3.0, "greenhouse": 4.0, "service": 4.0,
        "church": 15.0, "chapel": 8.0, "cathedral": 25.0, "mosque": 15.0, "synagogue": 12.0,
        "school": 10.0, "university": 14.0, "hospital": 15.0, "train_station": 10.0,
        "public": 12.0, "civic": 12.0, "government": 14.0, "museum": 12.0,
        "pavilion": 3.5, "gazebo": 3.0, "shelter": 3.0, "canopy": 4.0, "bandstand": 5.0, "grandstand_roof": 8.0,
        "chimney": 35.0, "tower": 20.0, "mast": 25.0, "communications_tower": 40.0, "silo": 18.0,
        "storage_tank": 8.0, "water_tower": 25.0, "lighthouse": 18.0, "gasometer": 30.0,
    })
    neighbor_radius_m: float = 50.0       # neighbours with explicit heights blended into fallback heights
    height_jitter: float = 0.10           # +/- fraction of deterministic variation on fallback heights
    max_building_height_m: float = 1000.0 # clamp of tagged / fallback heights (OOM guard)
    max_building_levels: float = 250.0
    foundation_max_m: float = 12.0        # max extra wall depth below a building on slopes


DEFAULT_CONFIG = Config()
