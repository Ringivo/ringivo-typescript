/**
 * The integration-token layer, from the caller's side.
 *
 * Every test here drives the real request path (`client.faxes.get`) against
 * a mocked transport, because the token is not a thing a caller ever
 * handles: it is minted, cached, replaced and retried on their behalf, and
 * the only evidence any of that happened is the requests that went out.
 *
 * THE REFUSALS AND THE COUNTS CARRY THE WEIGHT. An assertion that a call
 * succeeded passes against an implementation that mints a fresh token every
 * single time, so the tests that matter are the ones counting how many token
 * requests were made, and the one proving a 401 is retried exactly ONCE.
 *
 * The absences carry weight too. `tenant` and `customer` select the context
 * the token is issued for, so a member sent empty or null is a DIFFERENT
 * request from one not sent at all — hence the assertions that a member the
 * caller never configured is absent from the body, not present and blank.
 */
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import type { Recorded } from "../tests/msw.js";
import { ApiError, AuthenticationError, Ringivo, VERSION } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/v1/integration/token`;
const TENANT_ID = "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8";
const CUSTOMER_ID = "0198c4a1-5a6b-7c8d-9e0f-1a2b3c4d5e6f";
const FAX_ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";
const FAX_URL = `${BASE_URL}/v1/faxes/${FAX_ID}`;

const server = mockServer();

afterEach(() => {
  vi.useRealTimers();
});

/** The 200 the spec publishes: a token, its type, its life, its real scopes. */
function tokenBody(accessToken = "tok-1", expiresIn: number | null = 900): object {
  const body: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    scopes: ["fax:read", "fax:write"],
  };
  if (expiresIn !== null) {
    body.expires_in = expiresIn;
  }
  return body;
}

/** One JSON:API error document, the shape this endpoint refuses with. */
function refusal(status: number, detail: string, source?: object): object {
  return {
    errors: [{ status: String(status), title: "Refused", detail, ...(source ? { source } : {}) }],
  };
}

function faxDocument(): object {
  return { data: { type: "faxes", id: FAX_ID, attributes: { status: "delivered" } } };
}

/** The body that went out, parsed — every mint here posts JSON. */
function sent(call: Recorded): Record<string, unknown> {
  return JSON.parse(call.body) as Record<string, unknown>;
}

/**
 * A client with a tenant and a scope, which is what an integrator has today.
 * Pass `{ tenant: undefined }` for the credential that names no tenant.
 */
function client(
  options: { scopes?: string[]; tenant?: string; customer?: string } = {},
): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: TENANT_ID,
    scopes: ["fax:read"],
    ...options,
  });
}

/** The two handlers nearly every test wants, plus the call recorders. */
function wire(
  options: {
    tokens?: object[];
    faxResponses?: Response[];
  } = {},
): { token: Calls; fax: Calls } {
  const token = new Calls();
  const fax = new Calls();
  const tokens = options.tokens;

  server.use(
    http.post(TOKEN_URL, async ({ request }) => {
      await token.record(request);
      const body = tokens ? (tokens[Math.min(token.count - 1, tokens.length - 1)] ?? {}) : tokenBody();
      return HttpResponse.json(body);
    }),
    http.get(FAX_URL, async ({ request }) => {
      await fax.record(request);
      const canned = options.faxResponses;
      if (canned) {
        return (canned[Math.min(fax.count - 1, canned.length - 1)] as Response).clone();
      }
      return HttpResponse.json(faxDocument());
    }),
  );

  return { token, fax };
}

describe("the token request", () => {
  it("posts the credentials and the tenant as JSON to the integration mint", async () => {
    // One endpoint, one body, no grant_type and no form encoding: this is the
    // mint whose tokens the /v1 surface accepts.
    const { token } = wire();

    await client().faxes.get(FAX_ID);

    expect(token.last.url.pathname).toBe("/v1/integration/token");
    expect(token.last.request.headers.get("content-type")).toBe("application/json");
    expect(sent(token.last)).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      tenant: TENANT_ID,
      scopes: ["fax:read"],
    });
  });

  it("asks for the scopes it was given, as a list", async () => {
    // A list, not the space-separated string the older OAuth endpoint took.
    const { token } = wire();

    await client({ scopes: ["fax:read", "fax:write"] }).faxes.get(FAX_ID);

    expect(sent(token.last).scopes).toEqual(["fax:read", "fax:write"]);
  });

  it("names a customer only when one was configured", async () => {
    // ABSENCE MEANS ABSENCE. `customer` selects a context somebody granted;
    // sending it empty or null is a different request from not sending it,
    // and the tenant-wide token is what the omission asks for.
    const narrowed = wire();
    await client({ customer: CUSTOMER_ID }).faxes.get(FAX_ID);
    expect(sent(narrowed.token.last).customer).toBe(CUSTOMER_ID);

    server.resetHandlers();
    const wide = wire();
    await client().faxes.get(FAX_ID);
    expect(sent(wide.token.last)).not.toHaveProperty("customer");
  });

  it("leaves the tenant out when the credential names none", async () => {
    // The same rule one member up: a client that configured no tenant sends
    // no `tenant`, so the server decides from the single grant it holds
    // rather than reading an empty string as one.
    const { token } = wire();

    await client({ tenant: undefined }).faxes.get(FAX_ID);

    expect(sent(token.last)).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      scopes: ["fax:read"],
    });
  });

  it("carries no bearer of its own", async () => {
    // The mint is unauthenticated by definition (`security: []`); sending a
    // stale bearer with it would be a request the server has to reject
    // before it can help.
    const { token } = wire();

    await client().faxes.get(FAX_ID);

    expect(token.last.request.headers.get("authorization")).toBeNull();
  });
});

describe("the cache", () => {
  it("mints the token once and reuses it", async () => {
    // The point of the cache. This passes against an implementation with no
    // cache at all unless the assertion is on the COUNT, not the outcome.
    const { token } = wire();
    const ringivo = client();

    await ringivo.faxes.get(FAX_ID);
    await ringivo.faxes.get(FAX_ID);
    await ringivo.faxes.get(FAX_ID);

    expect(token.count).toBe(1);
  });

  it("mints once when several calls race for a token that is not there yet", async () => {
    // JavaScript has no threads but it does have concurrency: three calls
    // started together all find the cache empty. Without a shared in-flight
    // promise each mints its own, which costs the server three tokens and
    // races over which one is kept.
    const { token } = wire();
    const ringivo = client();

    await Promise.all([
      ringivo.faxes.get(FAX_ID),
      ringivo.faxes.get(FAX_ID),
      ringivo.faxes.get(FAX_ID),
    ]);

    expect(token.count).toBe(1);
  });

  it("replaces the token a minute before it expires", async () => {
    // `expires_in - 60`: the margin exists so a token that is about to
    // expire is replaced BEFORE a request carries it, rather than after the
    // server has already refused one. 59 seconds into a 120-second token the
    // cached copy is still used; 61 seconds in it is not.
    //
    // The life is read off the answer, never assumed: the endpoint documents
    // 15 minutes today, and a token minted with a different life must expire
    // on ITS clock and not on a number compiled in here.
    //
    // `performance` is faked explicitly — vitest does not fake it by default,
    // and this client measures expiry with `performance.now()` so an NTP step
    // cannot be read as elapsed token life.
    vi.useFakeTimers({ toFake: ["performance", "Date"] });

    const { token } = wire({ tokens: [tokenBody("tok-1", 120)] });
    const ringivo = client();

    await ringivo.faxes.get(FAX_ID);
    expect(token.count).toBe(1);

    vi.advanceTimersByTime(59_000);
    await ringivo.faxes.get(FAX_ID);
    expect(token.count).toBe(1);

    vi.advanceTimersByTime(2_000);
    await ringivo.faxes.get(FAX_ID);
    expect(token.count).toBe(2);
  });

  it("keeps a token with no stated expiry and leaves it to the 401 retry", async () => {
    // The spec requires `expires_in`, so this is the answer no server should
    // send. With no expiry to compute against there is nothing to pre-empt,
    // so the token is kept and the 401 retry below is what replaces it —
    // which is better than treating a missing member as expiry now and
    // minting on every single call.
    const { token } = wire({ tokens: [tokenBody("tok-1", null)] });
    const ringivo = client();

    await ringivo.faxes.get(FAX_ID);
    await ringivo.faxes.get(FAX_ID);

    expect(token.count).toBe(1);
  });
});

describe("the 401 retry", () => {
  it("forces a refresh and retries the request once", async () => {
    // A token can stop working before it expires — the grant withdrawn, the
    // secret rotated, the server restarted. One 401, one forced refresh, one
    // retry carrying the NEW bearer, and the caller sees the success.
    const { token, fax } = wire({
      tokens: [tokenBody("stale"), tokenBody("fresh")],
      faxResponses: [
        HttpResponse.json({ errors: [{ status: "401", title: "Unauthenticated" }] }, { status: 401 }),
        HttpResponse.json(faxDocument()),
      ],
    });

    const result = await client().faxes.get(FAX_ID);

    expect(result.id).toBe(FAX_ID);
    expect(token.count).toBe(2);
    expect(fax.count).toBe(2);
    expect(fax.at(0).request.headers.get("authorization")).toBe("Bearer stale");
    expect(fax.at(1).request.headers.get("authorization")).toBe("Bearer fresh");
  });

  it("mints once when two requests race to force the same refresh", async () => {
    // Two callers can each meet a 401 on the SAME stale token and both call
    // `accessToken({ forceRefresh: true })` before either mint finishes.
    // Without a shared in-flight promise each would mint its own — two
    // tokens bought for one refresh, the forced-refresh twin of the
    // cache-miss race already covered above.
    const token = new Calls();
    const fax = new Calls();
    // tok-1 is good until the server revokes it — flipped only AFTER the
    // warmup call below has already succeeded with it.
    let revoked = false;

    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        await token.record(request);
        return HttpResponse.json(tokenBody(`tok-${token.count}`));
      }),
      http.get(FAX_URL, async ({ request }) => {
        await fax.record(request);
        // Routed on the bearer actually sent, so this holds regardless of
        // which of the two concurrent attempts the mock server sees first.
        const stale = revoked && request.headers.get("authorization") === "Bearer tok-1";
        return stale
          ? HttpResponse.json({ errors: [{ status: "401", title: "Unauthenticated" }] }, { status: 401 })
          : HttpResponse.json(faxDocument());
      }),
    );

    const ringivo = client();
    await ringivo.faxes.get(FAX_ID); // warms the cache with tok-1, while it is still good
    expect(token.count).toBe(1);

    revoked = true; // now both concurrent calls below meet a 401 on tok-1

    const [a, b] = await Promise.all([ringivo.faxes.get(FAX_ID), ringivo.faxes.get(FAX_ID)]);

    expect(a.id).toBe(FAX_ID);
    expect(b.id).toBe(FAX_ID);
    // ONE shared refresh, not one per caller that met the 401.
    expect(token.count).toBe(2);
    // Both first attempts on the stale token, both retries on the new one.
    expect(fax.all.filter((call) => call.request.headers.get("authorization") === "Bearer tok-1"))
      .toHaveLength(3); // the warmup call plus both concurrent first attempts
    expect(fax.all.filter((call) => call.request.headers.get("authorization") === "Bearer tok-2"))
      .toHaveLength(2);
  });

  it("does not retry a second 401", async () => {
    // ONCE, not "until it works". A credential that has genuinely lost its
    // reach would otherwise spin, and every retry costs the server a token
    // mint. Two attempts total, then the caller is told.
    const { fax } = wire({
      faxResponses: [
        HttpResponse.json({ errors: [{ status: "401", title: "Unauthenticated" }] }, { status: 401 }),
      ],
    });

    await expect(client().faxes.get(FAX_ID)).rejects.toThrow(AuthenticationError);
    expect(fax.count).toBe(2);
  });

  it("retries a request whose body was already sent", async () => {
    // The retry re-sends the SAME bytes, and a `Request` may be read once —
    // so the spare copy has to be taken before the first attempt, not after.
    // A send is the case that proves it: its body is a multipart upload, and
    // a retry that lost the body would post an empty fax.
    const sends = new Calls();
    let answered = 0;

    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json(tokenBody())),
      http.post(`${BASE_URL}/v1/faxes`, async ({ request }) => {
        await sends.record(request);
        answered += 1;
        return answered === 1
          ? HttpResponse.json({ errors: [{ status: "401" }] }, { status: 401 })
          : HttpResponse.json({ data: { id: FAX_ID, status: "queued" } }, { status: 202 });
      }),
    );

    const fax = await client().faxes.send({
      faxAccount: "acct",
      to: "+13025556789",
      file: new TextEncoder().encode("%PDF-1.7 pretend"),
    });

    expect(fax.id).toBe(FAX_ID);
    expect(sends.count).toBe(2);
    expect(sends.at(1).body).toContain("%PDF-1.7 pretend");
    // And the retry is the same fax, not a second one.
    expect(sends.at(1).request.headers.get("idempotency-key")).toBe(
      sends.at(0).request.headers.get("idempotency-key"),
    );
  });
});

describe("refusals", () => {
  it("raises AuthenticationError when the credential itself is refused", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(refusal(401, "Invalid client credentials."), { status: 401 }),
      ),
    );

    const error = (await client()
      .faxes.get(FAX_ID)
      .catch((caught: unknown) => caught)) as AuthenticationError;

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(401);
    expect(error.message).toContain("Invalid client credentials.");
  });

  it("folds the 403 that means no grant matches", async () => {
    // Good credentials, no grant — for this tenant or for the customer named,
    // and the answer does not say which. It is not an AuthenticationError:
    // replacing the token would change nothing, because the credential is
    // not what was refused.
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(refusal(403, "No active integration grant for this tenant."), {
          status: 403,
        }),
      ),
    );

    const error = (await client()
      .faxes.get(FAX_ID)
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(403);
    expect(error.errors[0]?.detail).toBe("No active integration grant for this tenant.");
  });

  it("folds the 422 that names the malformed member", async () => {
    // A selector that is not a uuid. `source.pointer` is the whole value of
    // this answer — it says WHICH member to fix — so it has to survive the
    // fold into the typed error.
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          refusal(422, "The customer field must be a valid UUID.", { pointer: "/customer" }),
          { status: 422 },
        ),
      ),
    );

    const error = (await client({ customer: "not-a-uuid" })
      .faxes.get(FAX_ID)
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.statusCode).toBe(422);
    expect(error.errors[0]?.source).toEqual({ pointer: "/customer" });
    expect(error.message).toContain("The customer field must be a valid UUID.");
  });

  it("refuses a 200 that carried no access_token", async () => {
    // A success with nothing in it is not a success. Left alone it becomes
    // `Bearer undefined` on every later request, and the caller debugs a 401
    // that has nothing to do with their credential.
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ token_type: "Bearer" })));

    await expect(client().faxes.get(FAX_ID)).rejects.toThrow(/no access_token/);
  });
});

describe("the surface", () => {
  it("carries the versioned User-Agent on every request", async () => {
    // Including the token request: an operator reading their access log
    // wants to see which SDK asked, and the mint is a request like any
    // other.
    const { token, fax } = wire();

    await client().faxes.get(FAX_ID);

    expect(token.last.request.headers.get("user-agent")).toBe(`Ringivo/TS ${VERSION}`);
    expect(fax.last.request.headers.get("user-agent")).toBe(`Ringivo/TS ${VERSION}`);
  });

  it("takes the base URL whole and normalises only a trailing slash", () => {
    // No hostname is compiled in — the caller's base URL is the only one
    // there is (the grey-label rule, asserted from the other side in
    // tests/grey-label.test.ts).
    expect(
      new Ringivo({
        baseUrl: `${BASE_URL}/`,
        clientId: "c",
        clientSecret: "s",
        scopes: ["fax:read"],
      }).baseUrl,
    ).toBe(BASE_URL);

    expect(
      () => new Ringivo({ baseUrl: "", clientId: "c", clientSecret: "s", scopes: ["fax:read"] }),
    ).toThrow("baseUrl is required");
    expect(
      () =>
        new Ringivo({ baseUrl: BASE_URL, clientId: "", clientSecret: "s", scopes: ["fax:read"] }),
    ).toThrow("clientId and clientSecret are required");
  });

  it("refuses to construct with no scopes, before anything reaches the wire", () => {
    // A token minted with no scopes CARRIES none: the server intersects what
    // you ask for with what your grant allows, so asking for nothing is not
    // "the credential's default" — it is a token every endpoint refuses,
    // discovered as a 403 nowhere near the line that caused it. The refusal
    // is bought here instead, where the message can name the fix, and no
    // default is invented on the caller's behalf.
    const { token, fax } = wire();

    // Omitted, and empty: two spellings of the same ask.
    expect(() => new Ringivo({ baseUrl: BASE_URL, clientId: "c", clientSecret: "s" })).toThrow(
      TypeError,
    );
    expect(() => new Ringivo({ baseUrl: BASE_URL, clientId: "c", clientSecret: "s" })).toThrow(
      /scopes is required/,
    );
    expect(
      () => new Ringivo({ baseUrl: BASE_URL, clientId: "c", clientSecret: "s", scopes: [] }),
    ).toThrow(TypeError);
    expect(
      () => new Ringivo({ baseUrl: BASE_URL, clientId: "c", clientSecret: "s", scopes: [] }),
    ).toThrow(/scopes is required/);

    // And NOTHING went out on either: the refusal happens at construction,
    // before there is a client to mint with.
    expect(token.count).toBe(0);
    expect(fax.count).toBe(0);
  });

  it("constructs and mints with one scope", async () => {
    // The control for the refusal above: the guard turns away an empty ask,
    // not every ask.
    const { token } = wire();

    await client({ scopes: ["fax:read"] }).faxes.get(FAX_ID);

    expect(token.count).toBe(1);
    expect(sent(token.last).scopes).toEqual(["fax:read"]);
  });
});
