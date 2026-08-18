/**
 * The BUILT package, loaded the two ways a consumer can load it.
 *
 * THIS FILE EXISTS BECAUSE EVERY OTHER TEST RUNS THE TYPESCRIPT SOURCE. Vitest
 * imports `src/`, so an ESM/CJS interop fault in the bundle is invisible to all
 * sixty of them — the suite is green and `require("ringivo")` throws on the
 * first line a consumer writes.
 *
 * That is not hypothetical. It shipped here in draft: `import createClient from
 * "openapi-fetch"` is the documented usage and works under ESM, but Node's
 * ESM-to-CJS interop rule gives a default import `module.exports` — so in the
 * CJS bundle `createClient` resolved to the module object and
 * `new Ringivo(...)` died with "is not a function". The fix was the named
 * `createPathBasedClient` export, which has no default to misresolve; this test
 * is what keeps it fixed.
 *
 * The CJS half is loaded with `createRequire`, because this test file is itself
 * an ES module.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const DIST_ESM = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const DIST_CJS = fileURLToPath(new URL("../dist/index.cjs", import.meta.url));

interface Vector {
  secret: string;
  timestamp: number;
  body: string;
  header: string;
}

const VECTOR: Vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/webhook-signature-vector.json", import.meta.url)),
    "utf8",
  ),
) as Vector;

/** The surface both entrypoints must present, named rather than inferred. */
interface Surface {
  Ringivo: new (options: { baseUrl: string; clientId: string; clientSecret: string }) => {
    baseUrl: string;
    faxes: object;
    request: unknown;
  };
  VERSION: string;
  SIGNATURE_HEADER: string;
  verifyWebhook: (
    payload: string,
    header: string,
    secret: string,
    options?: { now?: number },
  ) => void;
  SignatureVerificationError: new (message: string) => Error;
}

async function load(kind: "esm" | "cjs"): Promise<Surface> {
  return kind === "esm"
    ? ((await import(DIST_ESM)) as unknown as Surface)
    : (require(DIST_CJS) as Surface);
}

describe.each(["esm", "cjs"] as const)("the built %s entrypoint", (kind) => {
  it("constructs a client", async () => {
    const { Ringivo, VERSION } = await load(kind);

    const client = new Ringivo({
      baseUrl: "https://api.yourprovider.example/",
      clientId: "id",
      clientSecret: "secret",
    });

    expect(client.baseUrl).toBe("https://api.yourprovider.example");
    expect(typeof client.request).toBe("function");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes the whole fax surface", async () => {
    const { Ringivo } = await load(kind);

    const client = new Ringivo({
      baseUrl: "https://api.yourprovider.example",
      clientId: "id",
      clientSecret: "secret",
    });

    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(client.faxes))
        .filter((name) => name !== "constructor")
        .sort(),
    ).toEqual(["cancel", "get", "list", "media", "mediaLink", "send"]);
  });

  it("verifies the server's own vector, and refuses a tampered body", async () => {
    const { verifyWebhook, SignatureVerificationError, SIGNATURE_HEADER } = await load(kind);

    expect(SIGNATURE_HEADER).toBe("Ringivo-Signature");
    expect(() =>
      verifyWebhook(VECTOR.body, VECTOR.header, VECTOR.secret, { now: VECTOR.timestamp }),
    ).not.toThrow();
    expect(() =>
      verifyWebhook(`${VECTOR.body} `, VECTOR.header, VECTOR.secret, { now: VECTOR.timestamp }),
    ).toThrow(SignatureVerificationError);
  });
});
