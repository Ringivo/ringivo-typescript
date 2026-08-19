/**
 * The OAuth client-credentials layer, from the caller's side.
 *
 * Every test here drives the real request path (`client.faxes.get`) against
 * a mocked transport, because the token is not a thing a caller ever
 * handles: it is fetched, cached, refreshed and retried on their behalf, and
 * the only evidence any of that happened is the requests that went out.
 *
 * THE REFUSALS AND THE COUNTS CARRY THE WEIGHT. An assertion that a call
 * succeeded passes against an implementation that fetches a fresh token
 * every single time, so the tests that matter are the ones counting how many
 * token requests were made, and the one proving a 401 is retried exactly
 * ONCE.
 */
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { AuthenticationError, Ringivo, VERSION } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const FAX_ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";
const FAX_URL = `${BASE_URL}/v1/faxes/${FAX_ID}`;

const server = mockServer();

afterEach(() => {
  vi.useRealTimers();
});

function tokenBody(accessToken = "tok-1", expiresIn: number | null = 3600): object {
  const body: Record<string, unknown> = { token_type: "Bearer", access_token: accessToken };
  if (expiresIn !== null) {
    body.expires_in = expiresIn;
  }
  return body;
}

function faxDocument(): object {
  return { data: { type: "faxes", id: FAX_ID, attributes: { status: "delivered" } } };
}

function client(options: { scopes?: string[] } = {}): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
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
  it("is the documented client-credentials form", async () => {
    const { token } = wire();

    await client().faxes.get(FAX_ID);

    expect(token.last.request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(token.last.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "cid",
      client_secret: "csecret",
    });
  });

  it("sends scopes space-separated, and omits them when none were asked for", async () => {
    const { token } = wire();

    await client({ scopes: ["fax:read", "fax:write"] }).faxes.get(FAX_ID);

    expect(new URLSearchParams(token.last.body).get("scope")).toBe("fax:read fax:write");
  });

  it("carries no bearer of its own", async () => {
    // The mint is unauthenticated by definition; sending a stale bearer with
    // it would be a request the server has to reject before it can help.
    const { token } = wire();

    await client().faxes.get(FAX_ID);

    expect(token.last.request.headers.get("authorization")).toBeNull();
  });
});

describe("the cache", () => {
  it("fetches the token once and reuses it", async () => {
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
    // `expires_in` is optional in the spec. With no expiry to compute
    // against there is nothing to pre-empt, so the token is kept and the 401
    // retry below is what replaces it.
    const { token } = wire({ tokens: [tokenBody("tok-1", null)] });
    const ringivo = client();

    await ringivo.faxes.get(FAX_ID);
    await ringivo.faxes.get(FAX_ID);

    expect(token.count).toBe(1);
  });
});

describe("the 401 retry", () => {
  it("forces a refresh and retries the request once", async () => {
    // A token can stop working before it expires — revoked, rotated, or the
    // server restarted. One 401, one forced refresh, one retry carrying the
    // NEW bearer, and the caller sees the success.
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
  it("raises AuthenticationError carrying the OAuth reason", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: "invalid_client", error_description: "Client authentication failed" },
          { status: 401 },
        ),
      ),
    );

    await expect(client().faxes.get(FAX_ID)).rejects.toThrow(AuthenticationError);
    await expect(client().faxes.get(FAX_ID)).rejects.toThrow(/invalid_client/);
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
    // wants to see which SDK asked, and the token call is a request like any
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
      new Ringivo({ baseUrl: `${BASE_URL}/`, clientId: "c", clientSecret: "s" }).baseUrl,
    ).toBe(BASE_URL);

    expect(() => new Ringivo({ baseUrl: "", clientId: "c", clientSecret: "s" })).toThrow(
      "baseUrl is required",
    );
    expect(() => new Ringivo({ baseUrl: BASE_URL, clientId: "", clientSecret: "s" })).toThrow(
      "clientId and clientSecret are required",
    );
  });
});
