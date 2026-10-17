"""Colour / material tag parsing: CSS and OSM colour names, #hex, material palettes."""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

RGB = Tuple[int, int, int]

_CSS = (
    "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,"
    "bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,"
    "burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,"
    "cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,"
    "darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,"
    "darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,"
    "darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,"
    "darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,"
    "dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,"
    "forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,"
    "goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,"
    "hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,"
    "lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,"
    "lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,"
    "lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,"
    "lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,"
    "lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,"
    "mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,"
    "mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,"
    "midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,"
    "navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,"
    "orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,"
    "papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,"
    "purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,"
    "saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,"
    "sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,"
    "snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,"
    "tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,"
    "yellow:ffff00,yellowgreen:9acd32"
)
CSS: Dict[str, RGB] = {}
for _it in _CSS.split(","):
    _n, _h = _it.split(":")
    CSS[_n] = (int(_h[0:2], 16), int(_h[2:4], 16), int(_h[4:6], 16))

# Building-friendly renderings of the harsh primary names (a "red" building is brick red, not #ff0000).
CSS.update({
    "white": (240, 240, 236), "red": (176, 70, 58), "brown": (132, 92, 62), "beige": (225, 210, 175),
    "yellow": (226, 205, 120), "black": (50, 50, 52), "blue": (80, 110, 160), "green": (92, 132, 92),
    "orange": (210, 132, 62), "pink": (222, 172, 172), "gray": (150, 150, 150), "grey": (150, 150, 150),
    "cream": (240, 232, 200), "tan": (210, 180, 140), "darkred": (130, 48, 42), "maroon": (120, 50, 46),
    "silver": (192, 194, 196), "gold": (212, 175, 70), "purple": (120, 80, 130), "olive": (128, 128, 70),
    "lime": (130, 190, 70), "navy": (40, 56, 100), "teal": (60, 120, 120), "cyan": (110, 190, 200),
    "aqua": (110, 190, 200), "magenta": (190, 80, 150), "fuchsia": (190, 80, 150),
    "lightgrey": (205, 205, 205), "lightgray": (205, 205, 205), "darkgrey": (110, 110, 112),
    "darkgray": (110, 110, 112), "lightblue": (170, 200, 220), "darkgreen": (50, 90, 60),
    "darkblue": (50, 64, 110), "terracotta": (190, 100, 70), "brick": (160, 84, 64), "redbrick": (160, 84, 64),
    "sand": (214, 200, 150), "stone": (180, 172, 156), "copper": (184, 115, 80), "bronze": (150, 110, 60),
    "rust": (160, 80, 50), "ochre": (200, 150, 60), "salmon": (230, 150, 130),
})

_HEX3 = re.compile(r"^#([0-9a-f])([0-9a-f])([0-9a-f])$")
_HEX6 = re.compile(r"^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$")
_RGBF = re.compile(r"^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$")


def parse_colour(s: Optional[str]) -> Optional[RGB]:
    """OSM colour value -> RGB: #rgb / #rrggbb / rgb(r,g,b) / CSS names ('light_grey', 'dark red' accepted).
    Multi-valued tags ('red;white') use the first value. None when unparseable."""
    if not s:
        return None
    v = s.split(";")[0].strip().lower()
    if not v:
        return None
    m = _HEX6.match(v)
    if m:
        return tuple(int(m.group(i), 16) for i in (1, 2, 3))  # type: ignore[return-value]
    m = _HEX3.match(v)
    if m:
        return tuple(int(m.group(i), 16) * 17 for i in (1, 2, 3))  # type: ignore[return-value]
    m = _RGBF.match(v)
    if m:
        return tuple(min(255, int(m.group(i))) for i in (1, 2, 3))  # type: ignore[return-value]
    n = re.sub(r"[\s_\-]+", "", v)
    if n in CSS:
        return CSS[n]
    for pre, f in (("light", 0.35), ("dark", 0.7)):  # 'light brown' etc. that CSS lacks: shade the base name
        if n.startswith(pre) and n[len(pre):] in CSS:
            base = CSS[n[len(pre):]]
            if pre == "dark":
                return tuple(int(c * f) for c in base)  # type: ignore[return-value]
            return tuple(int(c + (255 - c) * f) for c in base)  # type: ignore[return-value]
    return None


# ── materials (tag values, first token) -> candidate palettes ────────────────────────────────────────────
WALL_MATERIALS: Dict[str, List[RGB]] = {
    "brick": [(170, 92, 70), (156, 84, 64), (184, 106, 80), (140, 78, 62)],
    "concrete": [(168, 168, 164), (150, 152, 150), (182, 180, 174)],
    "cement_block": [(160, 160, 155), (172, 170, 164)],
    "stone": [(186, 176, 156), (166, 160, 148), (198, 188, 168)],
    "sandstone": [(200, 176, 132), (190, 160, 118)],
    "limestone": [(218, 208, 182), (206, 196, 170)],
    "marble": [(230, 228, 222), (218, 216, 210)],
    "granite": [(150, 146, 142), (130, 128, 126)],
    "wood": [(150, 114, 78), (132, 100, 68), (166, 130, 92)],
    "timber_framing": [(214, 198, 168), (200, 184, 152)],
    "glass": [(120, 160, 180), (100, 140, 162), (140, 176, 196)],
    "metal": [(150, 156, 162), (130, 136, 142)],
    "steel": [(140, 144, 150), (120, 124, 130)],
    "aluminium": [(176, 180, 184)],
    "iron": [(110, 100, 94), (100, 94, 90)],
    "corrugated_iron": [(140, 146, 150), (130, 138, 142)],
    "plaster": [(232, 222, 202), (224, 212, 190), (238, 232, 216)],
    "render": [(232, 222, 202), (224, 214, 196)],
    "stucco": [(232, 222, 202), (220, 206, 180)],
    "mud": [(170, 130, 95)], "clay": [(176, 130, 96)], "adobe": [(186, 146, 104)], "earth": [(160, 124, 92)],
    "tiles": [(190, 110, 80), (170, 150, 130)], "ceramic": [(215, 205, 190)],
    "plastic": [(220, 218, 212)], "vinyl": [(222, 218, 205)], "asbestos": [(150, 150, 145)],
    "bamboo": [(190, 170, 110)], "slate": [(90, 94, 104)], "gravel": [(150, 146, 136)],
}
ROOF_MATERIALS: Dict[str, List[RGB]] = {
    "roof_tiles": [(176, 88, 62), (164, 80, 58), (188, 102, 72)],
    "tile": [(176, 88, 62), (164, 80, 58)], "tiles": [(176, 88, 62), (164, 80, 58)],
    "clay_tiles": [(180, 92, 64)], "concrete_tiles": [(110, 108, 108)], "concrete": [(128, 128, 126)],
    "slate": [(76, 82, 94), (64, 70, 82), (88, 94, 104)],
    "tar_paper": [(58, 58, 62), (68, 68, 70)], "tar": [(58, 58, 62)], "bitumen": [(56, 56, 60)],
    "asphalt": [(66, 66, 68)], "roofing_felt": [(66, 66, 66)],
    "copper": [(112, 160, 140), (96, 148, 130), (180, 112, 80)],
    "metal": [(140, 148, 156), (124, 132, 140)], "metal_sheet": [(140, 148, 156)],
    "zinc": [(128, 136, 142)], "steel": [(130, 134, 140)], "aluminium": [(176, 180, 184)],
    "iron": [(100, 96, 94)], "corrugated_iron": [(140, 146, 150)], "tin": [(160, 164, 168)],
    "thatch": [(164, 142, 92), (150, 128, 82)], "reed": [(168, 148, 98)],
    "glass": [(130, 172, 192), (110, 150, 172)],
    "wood": [(130, 100, 70)], "wood_shingle": [(124, 98, 72)], "shingle": [(110, 100, 94)],
    "stone": [(150, 144, 132)], "gravel": [(142, 138, 128)],
    "grass": [(94, 132, 72), (84, 120, 66)], "green": [(94, 132, 72)], "plants": [(94, 132, 72)],
    "eternit": [(140, 140, 135)], "asbestos": [(140, 140, 135)], "plastic": [(200, 200, 196)],
    "membrane": [(150, 150, 150)], "solar_panels": [(40, 54, 90)], "photovoltaic": [(40, 54, 90)],
}


def _norm_mat(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    return re.sub(r"[\s\-]+", "_", s.split(";")[0].strip().lower()) or None


def wall_material(s: Optional[str]) -> Optional[str]:
    """Normalized wall material key present in WALL_MATERIALS (with a few aliases), else None."""
    v = _norm_mat(s)
    if v is None:
        return None
    v = {"bricks": "brick", "masonry": "brick", "reinforced_concrete": "concrete", "cement": "concrete",
         "wooden": "wood", "timber": "wood", "timber_framed": "timber_framing", "half_timbered": "timber_framing",
         "plaster": "plaster", "metal_sheet": "metal", "aluminum": "aluminium", "glass_facade": "glass",
         "lime": "limestone", "sandstone": "sandstone", "cladding": None}.get(v, v)
    return v if v in WALL_MATERIALS else None


def roof_material(s: Optional[str]) -> Optional[str]:
    v = _norm_mat(s)
    if v is None:
        return None
    v = {"tiles": "roof_tiles", "tile": "roof_tiles", "roof_tile": "roof_tiles", "ceramic": "roof_tiles",
         "terracotta": "roof_tiles", "aluminum": "aluminium", "concrete_tile": "concrete_tiles",
         "grass_roof": "grass", "green_roof": "grass", "sedum": "grass", "slates": "slate", "bitumen": "tar_paper",
         "felt": "roofing_felt", "metal_sheet": "metal", "sheet_metal": "metal", "wooden": "wood",
         "shingles": "shingle", "straw": "thatch", "solar": "solar_panels"}.get(v, v)
    return v if v in ROOF_MATERIALS else None
