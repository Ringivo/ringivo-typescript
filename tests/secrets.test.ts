/**
 * A client must not hand its credential to whatever prints it.
 *
 * `console.log(client)`, a logger that inspects its argument, an error
 * reporter that walks an object's properties: each of them used to print the
 * client secret and the live bearer token, because both sat on ordinary
 * (TypeScript-`private`) properties. This file is the outside view of the
 * fix, and it reads the BUILT package too, because that is what ships.
 */
import { createRequire } from "node:module";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { Ringivo } from "../src/index.js";

const SECRET = "csecret-0123456789-do-not-print";
const TOKEN = "tok-0123456789-do-not-print";

function walk(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  return Object.values(value).flatMap((member) => walk(member, seen));
}

async function used(Client: typeof Ringivo): Promise<Ringivo> {
  const client = new Client({
    baseUrl: "https://api.yourprovider.example",
    clientId: "cid",
    clientSecret: SECRET,
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["fax:read"],
    maxRetries: 0,
    fetch: async (request) =>
      new URL(request.url).pathname === "/oauth/token"
        ? Response.json({ access_token: TOKEN, token_type: "Bearer", expires_in: 900 })
        : Response.json({ data: { type: "faxes", id: "f", attributes: {} } }),
  });
  // A request first, so a token is held too.
  await client.faxes.get("f");
  return client;
}

describe("a client's credential never reaches a printout", () => {
  it.each([
    ["the source", Ringivo],
    ["the built CommonJS bundle", createRequire(import.meta.url)("../dist/index.cjs").Ringivo as typeof Ringivo],
  ])("%s: inspect, console.log and a property walk show neither the secret nor the token", async (_, Client) => {
    const client = await used(Client);

    const printed = inspect(client, { depth: 10, showHidden: true });
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain("https://api.yourprovider.example");

    const strings = walk(client);
    expect(strings).not.toContain(SECRET);
    expect(strings).not.toContain(TOKEN);
    // The walk reached something, or "contains nothing" would prove nothing.
    expect(strings).toContain("https://api.yourprovider.example");
  });
});
