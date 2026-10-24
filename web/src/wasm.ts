// Loader for the rf-core → wasm package. The generated module lives in
// `public/wasm/` (served as-is, built by `npm run wasm:build`).

export interface WasmModule {
  core_version(): string;
  solve_constraints(sketch_json: string): string;
  export_dxf(sketch_json: string): string;
  export_svg(sketch_json: string): string;
  detect_ridges(gray: Uint8Array, width: number, height: number, params_json: string): string;
  fit_sketch(sketch_json: string, centerlines_json: string, initial_json: string, params_json: string): string;
}

let ready: Promise<WasmModule> | null = null;

export function loadWasm(): Promise<WasmModule> {
  if (!ready) {
    ready = (async () => {
      const url = `${import.meta.env.BASE_URL}wasm/rf_wasm.js`;
      const mod = (await import(/* @vite-ignore */ url)) as {
        default: () => Promise<void>;
        core_version: () => string;
        solve_constraints: (s: string) => string;
        export_dxf: (s: string) => string;
        export_svg: (s: string) => string;
        detect_ridges: (g: Uint8Array, w: number, h: number, p: string) => string;
        fit_sketch: (s: string, c: string, i: string, p: string) => string;
      };
      await mod.default();
      return mod as unknown as WasmModule;
    })();
  }
  return ready;
}
