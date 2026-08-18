/**
 * The version is written in two files, so this is what keeps them equal.
 *
 * `package.json` owns the version npm publishes; `src/version.ts` owns the
 * one the runtime puts in its User-Agent (and it is a literal because
 * `package.json` is not shipped inside `dist/`). Nothing but this test stops
 * a release being cut with the two disagreeing — and a User-Agent naming the
 * wrong version is a lie an operator reads out of their access log months
 * later.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string; name: string };

describe("the version", () => {
  it("is the same in package.json and in the runtime", () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it("is a plain three-part version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
