import { defineConfig } from "tsup";

/**
 * The ONE place the build is configured.
 *
 * `package.json`'s `build` script is a bare `tsup` on purpose: flags there
 * as well would be a second, silently-winning copy of these options, and the
 * two would disagree the first time either was edited alone.
 *
 * `dts: true` emits BOTH `dist/index.d.ts` and `dist/index.d.cts`, which is
 * why `exports` declares a `types` per condition — a CJS consumer on
 * `moduleResolution: node16` reads the `.d.ts` beside an ESM `package.json`
 * as an ES module and reports the package as "masquerading as ESM".
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
});
