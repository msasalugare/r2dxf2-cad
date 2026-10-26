// Loader for the rf-core → wasm package. The generated module lives in
// `public/wasm/` (served as-is, built by `npm run wasm:build`).

export interface WasmModule {
  core_version(): string;
  solve_constraints(sketch_json: string): string;
  export_dxf(sketch_json: string): string;
  export_svg(sketch_json: string): string;
  detect_ridges(gray: Uint8Array, width: number, height: number, params_json: string): string;
  detect_ridges_roi(
    gray: Uint8Array,
    width: number,
    height: number,
    roi_json: string,
    params_json: string,
  ): string;
  snap_to_ridge(
    gray: Uint8Array,
    width: number,
    height: number,
    u: number,
    v: number,
    radius: number,
  ): string;
  fit_sketch(
    sketch_json: string,
    centerlines_json: string,
    initial_json: string,
    params_json: string,
  ): string;
  fit_sketch_step(
    sketch_json: string,
    centerlines_json: string,
    current_t_json: string,
    params_json: string,
  ): string;
  fit_sketch_masked(
    sketch_json: string,
    centerlines_json: string,
    mask_strokes_json: string,
    mask_params_json: string,
    raster_width: number,
    raster_height: number,
    initial_json: string,
    params_json: string,
  ): string;
  fit_report_json(result_json: string): string;
  fit_report_csv(result_json: string): string;
}

let ready: Promise<WasmModule> | null = null;

export function loadWasm(): Promise<WasmModule> {
  if (!ready) {
    ready = (async () => {
      const url = `${import.meta.env.BASE_URL}wasm/rf_wasm.js`;
      const mod = (await import(/* @vite-ignore */ url)) as {
        default: () => Promise<void>;
      } & WasmModule;
      await mod.default();
      return mod as unknown as WasmModule;
    })();
  }
  return ready;
}
