/**
 * The grey-label lock: no platform brand and no provider host ships.
 *
 * This package is installed by integrators of different providers, and the
 * provider is named by the caller's `baseUrl` — never by us. A hostname or a
 * platform name that leaked into a doc comment, a default argument or a
 * generated type would put somebody else's brand into every stack trace and
 * every editor tooltip of a provider who has nothing to do with them.
 *
 * The scan reads the BUILT `dist/`, which is exactly what `files: ["dist"]`
 * ships — not the repository. That is the half that can regress without
 * anybody editing a line by hand: `src/_generated/schema.d.ts` carries the
 * spec's own descriptions as doc comments, and tsup copies whatever of them
 * reaches the public types into `dist/index.d.ts`.
 *
 * Cheap and durable on purpose: it costs milliseconds, it needs no network,
 * and it fails on the next `scripts/generate.sh` run that pulls a branded
 * string out of a spec.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Ringivo } from "../src/index.js";

// The names this package must never carry, kept rot13-encoded so this public
// repository does not itself spell them anywhere.
const rot13 = (s: string): string =>
  s.replace(/[a-z]/g, (c) =>
    String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97),
  );
const FORBIDDEN = new RegExp(
  `${rot13("gryanzvp")}|${rot13("gryvzngvp")}|ringivo\\.com`,
  "gi",
);

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

function distFiles(directory: string = DIST): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? distFiles(path) : [path];
  });
}

describe("the published tarball", () => {
  it("names no platform brand and no provider host", () => {
    const files = distFiles();

    // The DENOMINATOR, asserted first: "no matches" and "nothing searched"
    // must not look alike. Without this the test passes forever over an
    // empty directory — which is exactly what an unbuilt checkout has.
    expect(files.length, "dist/ is empty — run `npm run build` before the tests").toBeGreaterThan(
      0,
    );
    expect(files.some((path) => path.endsWith(".js"))).toBe(true);
    expect(files.some((path) => path.endsWith(".cjs"))).toBe(true);
    // The declarations are the half that carries doc comments lifted from
    // the spec, so a scan that missed them would miss the likeliest leak.
    expect(files.some((path) => path.endsWith(".d.ts"))).toBe(true);
    expect(files.some((path) => path.endsWith(".d.cts"))).toBe(true);

    const offenders = new Map<string, string[]>();
    for (const path of files) {
      const found = [
        ...new Set(
          Array.from(readFileSync(path, "utf8").matchAll(FORBIDDEN), (match) =>
            match[0].toLowerCase(),
          ),
        ),
      ].sort();
      if (found.length > 0) {
        offenders.set(path, found);
      }
    }

    expect(
      Object.fromEntries(offenders),
      `${offenders.size} of ${files.length} built files name a forbidden brand or host`,
    ).toEqual({});
  });

  it("compiles in no base URL of its own", () => {
    // The same rule from the API's side: there is no default to fall back
    // to, so a caller who forgets their provider's URL is told, not silently
    // pointed at somebody's server.
    //
    // Both halves are gates. The runtime one runs here; the compile-time one
    // is the directive below, which `tsc --noEmit` reports as an UNUSED
    // suppression the day `baseUrl` stops being required.
    expect(
      // @ts-expect-error baseUrl has no default, so omitting it must not typecheck
      () => new Ringivo({ clientId: "c", clientSecret: "s" }),
    ).toThrow("baseUrl is required");
  });
});
