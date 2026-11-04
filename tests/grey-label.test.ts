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
 * The same scan holds the API's vendor rule: the SDK names no vendor the
 * platform is built on — only carriers may be named. It reads the built `dist/` and the README and
 * examples, which npm and GitHub show to every integrator.
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
// repository does not itself spell them anywhere. The second group is the
// speech-to-text service and its model family: the API stopped naming them
// on 2026-10-01, and nothing here may name them either. The model family is
// matched at a word start only, so an ordinary word that contains it does
// not fail the test.
const rot13 = (s: string): string =>
  s.replace(/[a-z]/g, (c) =>
    String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97),
  );
// The third group is the vendors the platform is built on (the phone system
// and its device and media products, the rating engine, the speech, AI and
// email providers, the clouds, the edge, the error inbox, the identity check,
// the number-lookup and porting services). Carriers are allowed and are not
// here. A short or common token is matched as a whole word only.
const VENDOR_NAMES = [
  "argfncvraf", "fancfbyhgvba", "fanczbovyr", "ptengrf", "yvirxvg", "bcranv",
  "naguebcvp", "pynhqr", "ryriraynof", "pybhqsyner", "xnznvyvb", "serrfjvgpu",
  "egcratvar", "zrvyvfrnepu", "cbegpbageby", "qvqvg", "fxlfjvgpu", "fragel",
  "cbfgznex", "benpyr", "nznmba",
].map(rot13);
const VENDOR_WORDS = ["gryvdhr", "aqc", "azf", "bpv", "bpve", "njf", "frf"].map(rot13);
const FORBIDDEN = new RegExp(
  [
    `${rot13("gryanzvp")}|${rot13("gryvzngvp")}|${rot13("qrrctenz")}|\\b${rot13("abin")}|ringivo\\.com`,
    ...VENDOR_NAMES,
    `${rot13("cbegvat")}\\.com`,
    `${rot13("cynva")}\\.com`,
    ...VENDOR_WORDS.map((word) => `\\b${word}\\b`),
  ].join("|"),
  "gi",
);

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

  it("refuses the speech-to-text names (the control for the scan above)", () => {
    // A pattern that matched nothing would make that scan pass in silence.
    const once = new RegExp(FORBIDDEN.source, "i");
    expect(once.test(`made by ${rot13("qrrctenz").toUpperCase()}`)).toBe(true);
    expect(once.test(`model: ${rot13("abin")}-3`)).toBe(true);
    expect(once.test("an innovation in transcripts")).toBe(false);
  });

  it("names no vendor in the README or the examples", () => {
    const files = [join(ROOT, "README.md"), ...distFiles(join(ROOT, "examples"))];

    // The denominator: the README and at least one example were read.
    expect(files.filter((path) => path.endsWith(".ts")).length).toBeGreaterThan(0);

    const offenders = Object.fromEntries(
      files
        .map((path) => [path, [...new Set(Array.from(readFileSync(path, "utf8").matchAll(FORBIDDEN), (match) => match[0].toLowerCase()))]] as const)
        .filter(([, found]) => found.length > 0),
    );

    expect(offenders, "the README or an example names a forbidden brand, host or vendor").toEqual({});
  });

  it("refuses the vendor names and passes the carriers (the control for both scans)", () => {
    const once = new RegExp(FORBIDDEN.source, "i");
    expect(once.test(`${rot13("argfncvraf")}Number`)).toBe(true);
    expect(once.test(`the ${rot13("aqc").toUpperCase()} login`)).toBe(true);
    expect(once.test(`${rot13("pybhqsyner").toUpperCase()} token`)).toBe(true);
    expect(once.test("Bandwidth, Sinch, Telnyx, Twilio and Inteliquent carry calls; uses a session")).toBe(false);
  });

  it("compiles in no base URL of its own", () => {
    // The same rule from the API's side: there is no default to fall back
    // to, so a caller who forgets their provider's URL is told, not silently
    // pointed at somebody's server.
    //
    // Both halves are gates. The runtime one runs here; the compile-time one
    // is the directive below, which `tsc --noEmit` reports as an UNUSED
    // suppression the day `baseUrl` stops being required.
    //
    // Every OTHER required option is supplied, so the directive is spent on
    // `baseUrl` alone — a gate a second missing member could satisfy would go
    // on passing after the one it names stopped being required.
    const rest = {
      clientId: "c",
      clientSecret: "s",
      tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
      scopes: ["fax:read"],
    };

    expect(
      // @ts-expect-error baseUrl has no default, so omitting it must not typecheck
      () => new Ringivo(rest),
    ).toThrow("baseUrl is required");
  });
});
