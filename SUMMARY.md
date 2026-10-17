# VoxelWorlds — Current State Summary

_Single status file. Update in place; no other docs, no tests (user directive)._
_Last updated: 2026-10-14 by teamlead._

## Goal
Electron desktop app: pick a bbox on a Leaflet map → Python pipeline (OSM + Mapillary + optional DEM)
→ sparse voxel `.vwg` → Three.js preview (orbit + fly) → export `.vox` / `.schem` / `.json`.
Zero paid APIs: OSM + Mapillary v4 only.

## Constraints from user
- DO NOT write tests. DO NOT write docs. Only keep this summary current.

## Frozen contract
`src/shared/contract.ts` — stdio JSON-lines IPC (Request/Event), `VoxelApi` preload surface,
`.vwg` (VWG1) binary format. Bulk data goes via temp `.vwg` file, never stdio.
Coordinates: Y-up, +x east, +z south.

## Ownership
| Area | Path | Owner |
|---|---|---|
| Electron shell, main process, Python bridge, preload, Leaflet map, controls, export panel, build config | `package.json`, `src/main`, `src/preload`, `src/renderer/{index.html,map,ui}` | `electron-pro` |
| Three.js preview, `.vwg` parser, camera modes | `src/renderer/preview`, `src/shared/vwg.ts` | `threejs-voxel-renderer` |
| Python pipeline, `.vwg` writer, exporters, stdio loop | `python/` | `python-gis-voxel` |

## Status
| Item | State |
|---|---|
| Project dir + git init | done |
| Contract (`contract.ts`) | done, frozen |
| Electron shell + IPC bridge + UI | written; `tsc` + `npm run build` pass; app never launched |
| Three.js preview + vwg parser | written; greedy-meshed 32³ chunks, orbit + fly; node-benchmarked only (11M voxels: 0.9 s mesh, 4.9M tris), no GPU/FPS numbers |
| Python pipeline + exporters | written; manual smoke OK (Eiffel ~200 m bbox, 2 m voxels: 38k voxels, 30 buildings; .vwg/.vox/.schem/.json produced) |
| Integration (Electron <-> Python <-> preview, real run) | partly verified: real `PythonBridge` driven against real Python (ready/ping/VOXEL_LIMIT/BAD_REQUEST/EXPORT_FAILED/live cancel OK); full GUI run NOT done |
| macOS packaging | done: `npm run dist:mac` -> arm64 .app (530 MB) / .dmg (192 MB) / .zip in `release/`; ad-hoc signed; packaged launch + bundled Python verified |
| code-reviewer gate | done (round 1) — contract parity confirmed, 1 bug fixed, open items below |

## macOS build
- `npm run dist:mac` (runs `prebuild:mac`: placeholder icon `scripts/make-icon.mjs`, then `scripts/bundle-python.mjs`: pinned python-build-standalone 20260414 / CPython 3.10.20 + pip deps -> `build/python-runtime`, shipped via extraResources). Config: `electron-builder.config.cjs`, `build/entitlements.mac.plist`. First run ~9.5 min (downloads), later runs cached in `.cache/`.
- Packaged bridge: `resourcesPath/python-runtime/bin/python3 -m voxelworlds`, cwd `resourcesPath/python`; child in own process group, killed on quit.
- Fixed in packaged build: prod-only CSP `<meta>` (`src/main/csp.ts` shared with header), OSM tile Referer/User-Agent, temp `.vwg` cleanup (startup, after generate, on quit). Verified: 20/20 tiles load, python child starts and exits with app.
- Unsigned (ad-hoc). Other Macs: right-click Open or `xattr -dr com.apple.quarantine`. Notarization enabled only if APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID (+ CSC_LINK for signing) set.
- Not verified: real generate/export inside packaged app, Referer header on the wire, x64/universal build, Mapillary under bundled Python. Size trims possible: pyogrio 73 MB, pandas 26 MB, pip.
- Never run bundled python without PYTHONDONTWRITEBYTECODE=1 inside the .app (breaks signature seal).

## UI run (dev + packaged) — 2026-10-16
- 21 screenshots in `screenshots/` (01–17 dev, 20-packaged-* packaged). Driven via CDP/puppeteer-core from scratchpad (nothing added to repo).
- Worked: tiles 20/20, bbox draw + estimate, generate (Eiffel, 2 m: ~40.5k voxels, 35 buildings), preview renders real voxels, HUD 120 FPS steady (4–8 FPS during initial meshing for a few s), orbit/fly toggle, oversized/large-area warnings, VOXEL_LIMIT error, Mapillary run (17 photo / 21 procedural), packaged app + bundled Python OK, zero renderer console errors. `npm run build` + `tsc` pass.
- Fresh-install note: if `npm run dev` fails with missing `node_modules/electron/dist`, run `node node_modules/electron/install.js`.
- Not tested: export .vox/.schem/.json (native save dialog undrivable), pointer-lock mouse-look, hilly elevation.
- Open UX defects: (M) Cancel slow, no "Cancelling…" feedback, Overpass call not abortable (116 s); (M) no activity indicator during long Overpass wait (0% for ~112 s); (L-M) failed state shows only "Failed" — reason only in log panel; (L) layout jumps when warnings/progress appear; (L) Generate disabled w/o tooltip; (L) bbox rectangle faint; (L) fly speed default 62 m/s too fast for small scenes, hint "Click view to capture mouse" may stick; (L) comma decimals in number inputs — verify parsing; (Info) estimate vs backend voxel count differ.

## Defect fixes round (2026-10-16) — VERIFIED (dev + packaged rebuilt)
- Python: cancel ~0.25 s (network stages via `Job.run_blocking` daemon workers; abandoned worker can't emit/write); heartbeat progress ~1 s with elapsed text; job slot freed BEFORE terminal event. Abandoned osmnx/requests call lingers until its own timeout (harmless).
- UI: Cancelling… state; elapsed timer + indeterminate bar (after 2.5 s stall); error shown in progress area; reserved layout heights (Generate/Export/log tops constant across states); disabled-Generate reason + tooltip; bbox stroke #ff1744 w3; comma decimals via parseDecimal.
- Preview: fly speed clamp(2r/25, 3, 40) m/s (19.9 on Eiffel since r is the 3D half-diagonal incl. tower); drag-to-look fallback works; meshing: Eiffel 2 m fully meshed ~0.1 s, 0.5 m stress (704k voxels, 852k tris) 117-120 FPS during meshing (was 4-8).
- Regression results: cancel 612 ms / 8 ms / 9 ms (Mapillary search stage); Mapillary 17 photo of 35 buildings; packaged rebuilt (`npm run dist:mac` ~6 min), tiles 24/24, generate 1.8 s, 120 FPS, python child inside .app, clean quit; zero renderer console errors.
- Screenshots: 30-fix-* (UI), 40-verify-* (dev regression), 41-packaged-* (packaged).
- Still untested: export dialogs (.vox/.schem/.json), real pointer-lock capture + locked hint, cancel during Mapillary thumbnail/DEM stage, hilly terrain, BUSY-message path, value sent for comma decimals (code path reads parseDecimal; earlier run logged 3.5).
- Fixed after regression: failure text now headline + scrollable full text (78 px box, tooltip; screenshot 50-fix-failure-text.png); CANCELLED/BUSY returned as data from ipc handler (`__voxelError`, preload rethrows) so no main-process stack noise (BUSY path still unexercised); estimate = ground columns x 3.5 (fit to 2 m: 3.35x, 0.5 m: 3.63x), 1 km² at 2 m stays enabled, 20M cap trips at ~5.7M columns. Packaged app rebuilt after these.
- Remaining small items: (I) HUD speed line appears ~0.5-1 s after entering fly mode; (L, unconfirmed/maybe harness) first map drag after reload sometimes swallowed.

## Tiled parallel generation (2026-10-17) — implemented, e2e pass pending
- Contract (additive): `GenerateParams.tileSize?` (default 500, 50–5000), `workers?` (0=auto, 0–16), voxelSize now 0.05–5.0, progress `tile?:{done,total}`, `GenerateStats.tileCount?`.
- Python: global UTM voxel lattice, integer cell-window tiles (≤4096 cells/edge), ownership by clipping whole-building voxelization to tile columns; facade seeds per building id; Mapillary assignment once in parent. Spawn process pool (`tiles.py`; workers redirect fd1 to stderr; Queue to parent; ≤workers+1 tasks in flight); single tile or workers=1 runs inline. Global maxVoxels check during merge; one stable (x,z,y) sort. Disk caches (`cache.py`): OSM (≤2.5 km chunks, ≤2 concurrent, retries, 7-day), DEM (10x10 blocks), Mapillary tiles+thumbs; dir `$VOXEL_CACHE_DIR` or `<tmp>/voxelworlds-cache`.
- Progress when >1 tile: pct overall monotonic (init 0–2, osm 2–15, dem 15–20, mapillary 20–30, tiles 30–95, serialize 95–100). Single tile keeps old per-stage pct and no `tile` field.
- Verified (python, real stdio server): 20-tile 1.1×1.5 km @2 m output byte-identical to single-tile for workers 1/4/8 (arrays, palette, origin, extent); 0.5 m: 14.7M voxels, 9.8 s (1 worker) vs 4.4 s (4) vs 3.7 s (auto 8); cancel 0.01–0.05 s with no leftover workers; VOXEL_LIMIT paths; BAD_REQUEST on voxelSize<0.05, tileSize<50, workers>16; 0.1 m on ~100 m bbox: 11.6M voxels.
- UI: slider 0.05–5 m (0.05 steps to 1 m then 0.25) + editable box; Tile size + Workers inputs; "≈ N tiles of T m (a x b)" hint; "Tile n of m" progress; Max voxels default 50 M, range 1–250 M, RAM hint (~35 B/voxel; amber >100 M), settings migration (`v:2`). Verified against a fake backend only so far.
- Memory: merge holds ~16 B/voxel + ~16–20 B for the final sort (~3.5 GB at 100 M). Per-worker 100–400 MB at 4096-cell tiles. A building larger than a tile is re-voxelized per tile it touches.
- Limits: DEM public API still rate-limited (~1.1 s per 100-point block, cached); resource_tracker helper lives as long as the server; per-axis int32 guard unreachable on Earth (flat ground-column check added); first uncached Overpass fetch for 1.1×1.5 km took 144 s.
- E2E VERIFIED (dev + packaged, rebuilt after tiling): Eiffel 2 m single tile 41,102 vox / 34 bldg (no "Tile n of m"); Paris 1.1×1.5 km @2 m, 20 tiles: 825,620 vox / 1,299 bldg, 33.6 s cold (~28 s DEM) / 1.8 s warm, bar monotonic over 222 samples, no seam gaps in top-down preview, 120 FPS (1.48 M tris); @1 m 3.47 M vox in 1.9 s (88–91 FPS steady, 4.14 M tris); tile size/worker count do not change output; cancel at "Tile 9 of 48" 583 ms dev / 442 ms packaged, no leftover workers; limits + request params verified; packaged: spawn pool works in bundled interpreter (8 workers + tracker), 20/20 tiles, clean quit; zero console errors. Screenshots 70-tiles-*, 71-packaged-*.
- Open low defects (none blocking): sidebar overflows at ~900 px window height (stats/Export/failure text below fold, no scroll cue); area warning box clips long text; "Tile 0 of N" shown during init/OSM/DEM (~33 s cold); tile counter vs stage message can disagree; stats line omits tileCount; single-tile bar resets to 0 at voxelize; RAM hint "≈0.0 GB" at 1 M and amber hint shifts field ~18 px; Workers -1 error text wrong; old preview stays after failed run.
- Not verified: tiled photo texturing in UI (no token), cold Overpass fetch in packaged app, DEM-stage cancel, hilly terrain, export dialogs, real pointer lock.

## Realism round 1: roofs, colours, building shape (2026-10-17) — implemented, offline-verified; PAUSED here by user
- Roofs (`voxel/roofs.py`): reads roof:shape/height/levels/direction/orientation; flat, gabled, hipped, half-hipped, mansard (68° steep + flat top), pyramidal, cone, skillion, dome/round (gambrel/saltbox/side-hipped approximated). No straight-skeleton lib: hipped = distance-to-boundary height field; gabled ridge along min-rotated-rectangle long axis or ⟂ roof:direction. Height = roof:height > roof:levels×mPF > 35° pitch from half-width, capped min(10 m, 0.6×bldg height, 62°). `height` includes roof, `building:levels` excludes it. Shape inference when untagged (`Config.infer_roof_shapes`; houses gabled/hipped, churches pyramidal/gabled, industrial/commercial flat, apartments ~60% pitched ≤32 m, generic 40–250 m² <10 m gabled/hipped/flat) — statistical, not ground truth. Gable ends closed; 0 wall/roof gaps in column-adjacency checks (Paris @1 m, Paris block @0.5 m, Rothenburg @0.25 m). OSM cache key bumped to `osm|v2-roof|…`. Roof shares: Paris 76% flat/13% gabled/8% hipped; Rothenburg 76% gabled/20% hipped/5% flat.
- Colour/material (`voxel/colours.py`): building:colour, building:facade:colour, colour, roof:colour (#hex/rgb()/CSS names/"light grey"), ~35 wall + ~40 roof materials; priority exact colour tag > material palette (+jitter) > procedural. Paris: 13/13 wall and 10/10 roof colour tags applied. DECISION PENDING: a building with an explicit wall colour tag skips photos (one condition in `assign_photos` to flip).
- Photos (`mapillary/sampling.py`, `assign.py`, `client.py`): ≤4 images/wall segment scored by distance, facing/looking angle, age; occluded lines of sight dropped; pinhole projection (assumed 65° FOV, 2.5 m camera height) sampling 3×3 per wall voxel; median in linear RGB + one Lab outlier-rejection round; excludes sky, vegetation, bottom-12% hood band, lowest 0.9 m of wall; ≥4 valid samples else tag/procedural colour; voxelSize ≤0.5 m uses `thumb_1024_url` (stored ≤768 px with facade-mask alpha; caches `mly-t1024`/`mly-t256`). *** NEVER RUN AGAINST LIVE MAPILLARY *** (no token): only synthetic-image math (100% correct at 0.25/0.5/2 m) and mocked-call pipeline checks; real Graph response, `captured_at`, real photo quality untested. No ML segmentation; no car/people heuristic beyond hood band + median.
- Shape (`voxel/buildings.py`): courtyards/holes honoured (Paris: 172 courtyards, 0 of 10,775 cells occupied); building:part rendered as separate volumes (own height/min_height/roof/colours; inherit from parent; parent reduced to uncovered remainder; `building:part=no` ignored; Paris 148 parts → 6 remainder pieces); min_height kept (Paris 27); height fallback = levels×mPF else `Config.typical_heights` (house 7, apartments 15, industrial 8, church 15, garage 3…) blended 0.3–0.7 with median explicit height of buildings ≤50 m, ±10% deterministic jitter; foundations extend down to lowest ground under footprint (only synthetic-slope check). NOT done: bridges/layer (too risky), Overture Maps.
- Tile identity holds: Paris @2 m 180 tiles/4 workers vs 80 tiles/1 worker, Eiffel 9 vs 4 tiles, Rothenburg @0.5 m, and with fake photos — all byte-identical. Cancel still 0.01 s.
- Numbers: Paris @2 m now 897,610 voxels (was 825,620; roofs/heights add voxels — UI estimate ×3.5 will be somewhat low), single tile 2.8 s, 4 workers 1.77 s, building extraction 0.37 s/1,299 bldgs; Eiffel @2 m 39,663; Rothenburg @0.5 m 299,126 voxels in 0.46 s.
- Overpass: `Config.overpass_urls` mirrors (overpass-api.de, .fr, kumi, private.coffee) rotated on retry (main instance was 502/refusing for a long time).
- Not looked at in the real UI/preview: the new roofs/colours have only been seen in matplotlib renders (scratch PNGs in /private/tmp/claude-501/vwtest/out/, not in repo). No AO/soft shadows yet (item 7 not started). Items 5 (facade details), 6 (environment) not started.
- User paused the roadmap after the packaged build; resume with: UI check of roofs in the real preview, live Mapillary photo test (needs token), then items 5/6/7.

## Landscape round: terrain, ground, water, AO (2026-10-17/18) — implemented, reviewed, verified dev + packaged
- NOTE: props (trees/lamps/barriers, `voxel/props.py`), facade details (`voxel/details.py`), roofs, Overpass mirror rotation and `python/tests` (12–15 unit tests, from another session; run `python -m unittest discover -s python/tests`) also exist; older "Known limits" lines about flat roofs/no courtyards are obsolete.
- DEM: Copernicus GLO-30 COG read by own reader `osm/copdem.py` (requests+zlib+numpy, HTTP range, no rasterio, no new deps; bundle unchanged). 404 = missing tile (sea only if neighbours/probe show no land, else opentopodata fallback); other errors -> retry once -> opentopodata + `DEM_FALLBACK` warning. Bicubic onto UTM lattice spacing clamp(ceil(vs),4,30) m, ≤4000 samples/axis; tile bytes cached (`demtile`, 90 d); cold ~1 s, warm 0.04 s (was ~28 s). Datum = floor(min)−2 m. GLO-30 is a surface model (building/canopy tops at 30 m). Known: ~1 pixel height step across 1° file boundaries (≈11 m on steep alpine at lat 47); unused Terrarium code removed.
- Ground: skirts down to lowest 4-neighbour (dirt colour, darker below), cap `skirt_max_depth_m` 40, VOXEL_LIMIT checked before allocation; 0 side gaps on Uetliberg/Lauterbrunnen/Zürich/Thun (+1–10% voxels). Negative Y now occurs (water beds); sort keys/exporters/parser normalise by min.
- Water (`voxel/ground.py`): waterway lines fetched (river 15 m, canal 10, stream 2, ditch/drain 1.5; cache key `osm|v5-water`), level = low percentile under polygon clipped to the DEM window, clamped 1 voxel…3 m below bank ring (25th pct outside), flat per body/60 m river piece, follows ground if spread >1.5 m; 1-voxel bed. Bridges (`bridge=*`): 8 m deck pieces interpolated between end grounds, 0.5 m thick, raised for ≥1 voxel air over water, no piers/railings, `layer` ignored. Surfaces (`surface=*`) and ~40 landcover colours + deterministic per-cell jitter/checker (`layers.py`, `voxel/ground.py`; `_build_layers` moved from pipeline.py).
- Preview AO (`preview/mesher.ts`, `chunking.ts`, `world.ts`, `index.ts`, `hud.ts`): per-vertex AO, 26-neighbour border (shell only), merge only equal-AO quads, diagonal flip; +9% tris Eiffel, +21% Paris 2 m, +108% Paris 1 m synthetic. Default ON ≤2.5M voxels, OFF above (toggle works ≤12M). Sky gradient + mild fog, PCFShadowMap. UI: "Ambient occlusion" checkbox bottom-right of preview + `O` key (document-level while Preview tab visible); user choice survives new scenes; `PreviewHandle.getAmbientOcclusion()`.
- Review: code-reviewer found 15 items (2 high: bicubic zero-padding at 1° edges, transient 403 cached as sea) — all fixed except noted limits. Tile identity re-verified (Uetliberg 583,364 vox hash e2f2df4613df; Zürich 1,045,624 hash 2c01ca406654 across 5000/1, 500/4, 120/4, 250/1). Cancel in DEM stage 0.01–0.15 s.
- App runs: Eiffel @2 m 45.4k vox/34 bldg 120 FPS; Uetliberg reduced bbox @1 m 521k vox 120 FPS, @0.4 m 3.26M vox ~50 FPS (AO default off); Zürich @1 m ~1.08M vox, water below banks, Quaibrücke reads as bridge (clearance mostly exactly 1 air voxel). Packaged rebuilt (`dist:mac` 5.5 min; dmg 199 MB, zip 202 MB, .app 530 MB), bundled python + copdem OK (no DEM_FALLBACK), AO checkbox OK, clean quit, zero console errors. Screenshots 80-ao-*, 81-ao-toggle, 90-qa-*, 91/92-zurich-*, 93-packaged-*.
- Open (low): cold Overpass is slow/unreliable (mirrors 500/403/timeouts; larger Uetliberg bbox 502 after 6 min) and retry status goes only to the log; OSM cache key is exact-bbox (tiny drawn-bbox differences miss the cache); fly camera has no collision and Tab starts at the 40 m/s clamp on mid-size scenes; water single-sided, world has no floor/underside; faint 1-voxel stepped water bands between bodies; `#bbox-warn` fixed 58 px slot; voxel estimate overshoots at fine sizes (~3x, vs AO threshold); trees/lamps in water use plain terrain height; no lane markings, bridge piers/railings, `layer`; a saved Mapillary token sits in the packaged app's localStorage (rotate/clear); AO + 4M+ tris scenes untested for FPS on weaker GPUs; exports (.vox/.schem/.json with negative Y) verified only by code reading, not opened in MagicaVoxel/Minecraft.
- Not started: lane markings (another session may take it, as a layer in `layers.py`/`ground.py`), ESA WorldCover, sub-30 m lidar DEMs, time-of-day lighting.

## Building realism round 2 (2026-10-18) — implemented, reviewed (14 fixes), dev + packaged checked; final tweaks NOT re-run in the real app
- Facades (`voxel/details.py`, rewritten): per-run layout (consecutive outline segments turning <30°), symmetric windows between corner piers that follow diagonal/curved walls (old code gave almost no windows on non-axis-aligned walls); styles by building type (residential x3, office ribbon, civic tall, industrial strip, church tall); windows stop below eave, gable-end attic window; party walls (`Building.party_lo/party_h`, neighbour height range must overlap, overlap-by-area ignored) get no windows; shopfronts only for retail + signboard; string course, cornice, door lintel, balconies with depth. At ≤0.35 m: window frames/mullions, sills, lintels, shutters (35% residential), tint variation. Wall textures by material (plaster, brick, stone blocks, concrete panels, metal ribs, planks, timber framing, glass curtain wall); untagged religious=stone, commercial=concrete, industrial=metal.
- Roofs (`voxel/roofdetail.py` new, `roofs.py`): flat roofs get 0.4–0.8 m parapet + coping, HVAC boxes, stair bulkhead, skylights; pitched: ridge cap, 1–2 chimneys, dormers (axis from roof direction/orientation), tile courses/gravel/blotches. Narrow untagged city lots (depth ≤14 m) pitched with 60% probability (statistical).
- Structures: open types (roof/carport/pavilion/gazebo/shelter/canopy…) = pillars every ~4 m by arclength + slab, forced kind `minor` + short heights; greenhouses glass; `man_made` chimney/tower/mast/silo/tank/water_tower/lighthouse/gasometer (nodes get radius+default height; node inside a building without height skipped; polygon tower/mast >150 m² or lattice dropped as box). Lattice towers (`tower:construction=lattice/framework/truss`, parts inherit): pieces >8 m become open tapered 4-leg frame with rings, ≤8 m pieces stay solid slabs (Eiffel @2 m: 24,174 voxels; recognisable tower, legs are chunky column stacks, a few stray leg fragments left of the base and an odd ring near the top — cosmetic).
- Safety/perf from review: height clamp 1000 m / levels 250 + VOXEL_LIMIT check before np.repeat; building query box inflated by `details.max_protrusion_m(vs)` and lattice parts carry `Building.reach`; `building:part` via STRtree; `_Runs.locate` per unique column; independent hashes (crc32 of key:salt); palette = exact if ≤4096 colours else weighted median-cut per material (`pipeline._palette`, `export/quant.py` scores cached).
- Preview-triangle fix: per-voxel colour noise scaled with voxel size (ground: none at ≥1 m, 1 m cells at 0.5 m, checker only ≤0.35 m; walls/roofs noise + grime + window tint only ≤0.35 m; trees one colour per tree ≥1 m). Triangles (AO off/on): Paris-like @1 m 14.3M→5.5M/8.1M (original code 9.0M/10.4M), Zürich @0.5 m 13.3M→5.5M/7.6M, Rothenburg @0.25 m 3.8M→2.2M/2.8M. FPS is inferred from triangles after this fix, NOT measured (before it: 45–49 FPS on Paris @1 m / Zürich @0.5 m).
- OSM cache key now `osm|v6-manmade` (one-time refetch; new man_made query never run against live Overpass). Cache is exact-bbox keyed.
- Hashes @tile configs identical: Eiffel@2 fcf02788fa7a (24,174), Paris@1 600a89b2c08e (3,701,057), Zürich@1 912217bd76aa (1,056,979), Zürich@0.5 2245b112852a (4,466,985), Rothenburg@0.25 7cac26bb8df4 (1,109,666), Rothenburg@0.5 ae2a942abc2f. Cancel 19–76 ms. 15 unit tests pass. Seam fix for balconies could not be shown by a failing hash on cached scenes (reach measured: 6/87 Rothenburg buildings exceed the old margin).
- Real-app QA (before the last triangle/lattice fixes): Rothenburg 0.25 m 1.21M vox 107–115 FPS, convincing; Zürich/Paris good; zero console errors dev + packaged; packaged python OK; Mapillary token not present in packaged profile. Screenshots 100-bld-*-before/after, 101-bld-*, 102-packaged-*.
- TODO next: rebuild packaged app (`npm run dist:mac`) — current .app predates the triangle/lattice/palette fixes; re-run app check on Paris @1 m + Zürich @0.5 m for measured FPS; code-review the lattice-tower code (`Building.reach`, tapered frames) which was added after the review; consider eave overhangs, mansard roofs, entrance steps/canopies, bay windows (skipped), Mapillary with new wall colours (untested), contour/leg shape polish for lattice towers.

## Photo facades + interiors: DONE (2026-10-17) — reviewed, QA GO, UI-tested in dev Electron, packaged app rebuilt + smoke-tested
User choices: user-uploaded photo, separate detail scene, classical CV only (numpy + Pillow decode).
Flow: generate -> click building (orbit; F in fly mode) -> "Detail this building" -> choose photo, mark 4 corners, Analyze -> edit windows/doors/floors -> optional interior -> Generate detail (own scene, floor cutaway, export). Detail voxel cap 30M (UI 1-30M, default 20M); detail needs a prior generate of the same bbox in the session and the OSM cache (fails fast with NO_DATA otherwise).
Contract additions are in src/shared/contract.ts (BuildingIndex, FacadeSpec, DetailParams/Stats, analyzeFacade/detail requests). Footprint rings are CCW seen from above; FacadeSpec.u runs ring[i]->ring[i+1]; floorYs has exactly `levels` entries.
Verification: 88 py tests, 41 vitest, tsc clean, 320-case interior walk fuzz 0 flagged; generate hashes unchanged (zurich@1 912217bd76aa, eiffel@0.5 ffc81f1e2b2d); real Electron dev 120 FPS, no leaks over 10 cycles; packaged smoke (screenshots/130-packaged-*) OK: 410 buildings, detail+interior 813k voxels/81 rooms, .vox export from detail.
Known limits / TODO: classical CV assumes a regular grid of openings on a plain wall (doors under ~1.25 m or on a wrongly sized wall are missed; packaged run of facade2.jpg found 4 windows/2 doors vs 5/1 when the wall size matched); parts of one building get separate entrances (no connecting door); detail scene is flat (elevation 0), neighbours optional; stairs rise >0.2 m at voxel sizes >0.2 m; no lift for 6x5/7x3.5 footprints with 6+ levels; corridors follow principal axes; voxel estimate ~15% off for some shapes; exports not opened in MagicaVoxel/Minecraft; mouse-look picking in fly mode (F key) untested; cancel during a long detail untested in the UI; .vwg header embeds elapsedMs (not byte-identical files, content identical); 16 of 408 buildings not detailable (tiny/hollow footprints); packaged app notarization skipped (ad-hoc signed).

## Saved worlds + Geofabrik pbf source: DONE (2026-10-18) — reviewed, QA conditional GO fixed, UI-tested in dev Electron, packaged app rebuilt + smoke-tested
Verified: tsc clean, 161 vitest, 142 python tests; pbf Zurich == Overpass Zurich hash 912217bd76aa; Overpass hashes unchanged (zurich@1 912217bd76aa, eiffel@0.5 ffc81f1e2b2d). Packaged (screenshots/160-packaged-*): world save/restart/reopen, saved interior opens in ~209 ms with no python, real Monaco download (md5 verified) -> generate + detail from the bundled osmium.
Notes: python cache now lives in <userData>/voxel-cache (NOT userData/Cache: case clash with Chromium); pbf index is '<pbf>.vwidx' next to the extract (files < 48 MB are scanned, no index) - ~2.1x the pbf size on disk per country, first index build 2.5-4.5 min (Switzerland); detail may use expired saved OSM data (OSM_CACHE_STALE); worlds in userData/worlds (damaged ones moved to .damaged); no auto retention (UI shows total, warns > 1.5 GB). Don't run build/python-runtime/bin/python3 without -B before dist:mac (pyc breaks signature).
Open: dark-sky bug from UI test not reproduced (replaced by CSS gradient, re-check on the tester's flow); .vwidx placement untested in the packaged app (needs a big extract); covers/overlaps labels just wired; fallback index location (cache/pbfidx) is not removed by deleteGeodata; notarization skipped; macOS arm64 only.
Original plan for reference:

## Plan: saved worlds/interiors + Geofabrik pbf source
Request: (1) interiors must be saved and reachable from the world map after generation; (2) world generation from a Geofabrik .osm.pbf (downloaded once, reusable offline) OR the free Overpass API as now.
Interpretation/decisions: "world map" = the 3D world preview. Every generate is auto-saved to a Worlds library (userData/worlds/<id>), every detail result (incl. interior/facade) is auto-saved into its world; saved worlds can be reopened after restart; buildings with saved details are marked in the city view and open instantly from the building panel (no python). pbf: region picker from Geofabrik index-v1.json (suggested by bbox), main-process resumable download into userData/geodata with md5 check, python reads it via pyosmium (wheel exists for cp310 macOS arm64), results cached per bbox+source.
Contract additions already in src/shared/contract.ts: GenerateParams.dataSource, BuildingRef.dataSource, WorldMeta/DetailRecord, GeodataRegion/Entry/Progress, VoxelApi worlds + geodata methods, detail() returns optional record, error codes PBF_UNREADABLE/PBF_NO_COVERAGE/DOWNLOAD_FAILED/WORLD_NOT_FOUND, stage 'pbf'.
Owners: python-gis-voxel (osm/pbf.py reader, same feature schema as Overpass path), electron-pro (worlds library, geodata manager, IPC/preload, packaging of pyosmium), threejs-voxel-renderer (UI: worlds panel, saved-detail markers, data source + region/download UI). Gates: code-reviewer, qa-expert, ui-ux-tester, packaged rebuild.

## Plan: per-building photo facades + interiors (original plan)

Goal A: user picks one building, supplies a photo of one side, that wall is regenerated procedurally from the photo (windows/doors/floors/colours/materials).
Goal B: user picks one building, its interior is generated procedurally (floors, rooms, stairs, doors, windows aligned to the facade).

Shared foundation (Phase 0, teamlead + typescript-pro/python-gis-voxel):
- Building identity: stable id = OSM way/relation id (already the per-building seed). Pipeline must emit a building index (id, footprint, height, levels, per-edge wall ids) so the UI can pick and address one wall.
- Contract additions (additive, VWG1 untouched): `Request.type='detail'` {buildingId, bbox/params ref, wall?: edgeIndex, photoPath?, interior?: InteriorOptions} -> result `.vwg` patch for that building at a finer voxel size (0.1-0.25 m), plus `BuildingInfo` list on generate result. Detail output is a separate vwg layer, not merged into the 5 km scene.
- Renderer: click-pick a building in preview (raycast voxel -> building id via per-voxel id side-array or footprint lookup), highlight, side panel "Detail this building". Detail view = separate small scene with cutaway (clip plane / floor slider) for interiors.

Workstream A (photo -> facade), owner python-gis-voxel:
1. Rectify: user marks/auto-detects wall quad in photo (4-corner homography; v1 manual corners in UI, auto later), warp to metric front elevation.
2. Analyse (classical CV, no ML dependency in v1): dominant wall/roof colours (k-means), floor lines + window grid by edge-profile periodicity, window/door boxes by colour/contrast segmentation, door at ground level. Output a FacadeSpec {floors, bays, window rects, door rect, colours, material class}.
3. Synthesise: voxelise FacadeSpec onto the chosen wall at detail voxel size (frames, sills, glass, door, cornice), deterministic per (buildingId, photo hash).
Optional v2: ML window detector; Mapillary image auto-fetch for the chosen wall instead of user photo (reuse mapillary/assign.py).

Workstream B (interiors), owner python-gis-voxel:
1. Floor slabs per level from footprint + level height; hollow shell with wall thickness.
2. Room partition: BSP/straight-skeleton-lite split of footprint into rooms by building kind (residential: hall+rooms; office: corridor+offices; shop: open plan), corridor and stairwell placement, doors between rooms, interior doors lined up with facade windows.
3. Furniture/fixtures by room type from a small voxel-prop library (bed, table, counter, stairs), deterministic seed.
4. Export: interior included in .vox/.schem/.json for the detail layer.

Workstream C (UI/render), owners threejs-voxel-renderer + electron-pro:
- picking + highlight, detail panel (photo drop, corner picker overlay, options), detail scene with floor cutaway slider, progress.

Gates: code-reviewer then qa-expert on each phase; ui-ux-tester on C; devops-engineer on packaging (OpenCV/scikit-image dep size).
Risks: photo analysis quality varies (mitigate: show spec overlay, allow manual correction); OSM footprints without levels (use defaults); detail voxel counts explode (cap by footprint size); new python deps increase app size (prefer numpy + scipy-free classical CV, or opencv-python-headless ~50 MB).
Out of scope v1: photos of roofs, curved walls, multi-building photos, furnished interiors from photos, interiors for the whole city.

## Review round 1 results
- Verified: python `.vwg` writer round-trips through TS `parseVwg` (n=0,1,2,3,5 incl. odd-padding and negative z); stdout purity; readVwg guard; window security flags.
- Fixed: CSP `img-src` blocked OSM tiles (`tile.openstreetmap.org` bare host not matched by `*.`) — `src/main/index.ts`. Not confirmed in a running app.
- (Resolved by macOS build, see above) in packaged build (`loadFile`, `file://`) the header-injected CSP may not apply, and OSM tiles may 403 without a Referer/User-Agent — add prod-only CSP `<meta>` and `onBeforeSendHeaders` for `tile.openstreetmap.org`. Packaged build never run.
- Open (low): `vw-*.vwg` temp files never cleaned; cancel only cooperative (long Overpass/DEM call finishes first); export not cancellable; Mapillary token in plaintext localStorage; tiny race on job pop after `result`.

## How to run
- Python venv must be built from `~/.pyenv/versions/3.10.12` (3.10.14 lacks `ssl`). Venv at `python/.venv`.
- `npm install`, `npm run dev`. Python resolves: `$VOXEL_PYTHON` > `python/.venv/bin/python` > `python3`.
- Main passes `VOXEL_TMP_DIR`; Python writes `.vwg` there. `readVwg` only accepts paths returned by a prior generate; export uses the last generate's path.

## Mapillary status (VERIFIED)
- Client uses vector tiles (`tiles.mapillary.com/maps/vtp/mly1_public/2/14/x/y`, `mapbox-vector-tile`) to find cameras, then Graph API per-image lookup for `thumb_256_url`, thumbnails downloaded and projected onto wall voxels.
- First supplied token had a wrong secret hash (tiles OK, image reads denied). The corrected token reads images fine.
- Eiffel bbox (lat 48.8575..48.8595, lon 2.2935..2.2965, voxelSize 2): 34 buildings, 17 photo-textured / 17 procedural, 43,747 voxels, ~20 s; wall voxels use 876 distinct colours (vs 28 procedural-only) with natural tones.
- Token is NOT in the repo; copies only in session scratchpad. It was pasted in chat several times — rotate the client secret when done.

## Known limits / untested
- Untested: elevation on hilly terrain, MagicaVoxel opening the .vox, Minecraft loading the .schem. Cancel verified during Overpass only.
- Roofs flat only; no courtyards/holes, bridges, building `layer`. UTM zone has no Norway/Svalbard exceptions.
- DEM via public opentopodata is slow, capped at 20x20 samples interpolated.
- Preview: main-thread meshing (6 ms slices), no LOD, no AO; >10M voxels gets heavy. `.schem` is dense (fails >400M cells); `.json` export heavy beyond a few M voxels.
- UI sends fixed `maxVoxels` = 20M.
- Installed Electron 44 / TypeScript 7 (latest at install); caret-pinned.

## Decisions / assumptions
- Toolchain: Node 22, Python 3.10, electron-vite + TypeScript.
- `.schem` = Sponge Schematic v2 (gzip NBT); `.vox` = MagicaVoxel v150 (256³ chunks per model if larger).
- Mapillary is optional: no token or no coverage → warning event, procedural facades.

## Next steps
1. Launch the app (`npm run dev`), draw a small bbox, generate, confirm tiles load, preview renders, orbit/fly work, all 3 exports save. Needs a human/GUI session.
2. Fix the medium open item (packaged-build CSP + tile Referer) and temp-file cleanup.
3. Measure real FPS in the preview on large scenes; add worker meshing/LOD if <60 FPS.
4. Test Mapillary path with a real token; hilly-terrain elevation; open exports in MagicaVoxel / Minecraft (WorldEdit).
5. Possible features: gable/hip roofs, building holes/courtyards, trees/vegetation voxels, dense-free `.schem`.
