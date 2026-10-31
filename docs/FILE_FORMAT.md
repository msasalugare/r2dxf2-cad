# File formats

Project persistence and export formats. Details are filled as milestones land.

## Project (`.rasterfit.zip`, M7)

A single zip containing:

- `project.json` — versioned metadata: raster ref + hash, affine `T`, Part origin,
  calibration segments, geometry, constraints, text annotations, mask strokes
  (raster coords), guides, measurements, fit settings, last report.
- `raster` — the imported image blob (or a per-page raster for multi-page PDF).

## Raster

- 8-bit gray buffer + a tile pyramid live in the worker; the original blob is
  stored separately in IndexedDB.

## Export

- **DXF** (M7): `LINE`, `CIRCLE`, `ARC` on `geometry`/`construction` layers and
  multiline annotations as R12 `TEXT` on `annotations`, in calibrated Part mm.
- **SVG** (M7): vector export of the sketch.
- **JSON report + CSV** (M7): per-primitive fit residuals.
- **FreeCAD `.FCMacro`** (M8, optional): reconstructs geometry + constraints.
