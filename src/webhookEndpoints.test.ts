/**
 * The webhook-endpoint surface, asserted on the WIRE.
 *
 * Every test here checks the request that went out or the object that came
 * back, never an internal call — the same discipline as faxAccounts.test.ts,
 * for the same reason: `list()`'s whole job is to build a query string, and
 * `create()`'s and `update()`'s is to build a JSON:API document. None of that
 * is observable from the return value alone.
 *
 * Two things in this module are worth more than the usual care, and each has
 * its own test below. The SECRET is readable in exactly two responses, so a
 * builder that dropped it would be a credential a caller can never recover.
 * And `events` has three distinct wire forms — a list, `[]`, and `null` —
 * whose meanings differ, so "the member is missing" and "the member is null"
 * must not collapse into one another.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const ENDPOINTS_URL = `${BASE_URL}/v1/webhook-endpoints`;
const ENDPOINT_ID = "0198c4a1-8192-73b4-e5b6-708192031425";
const ENDPOINT_URL = `${ENDPOINTS_URL}/${ENDPOINT_ID}`;
const ROTATE_URL = `${ENDPOINT_URL}/rotate-secret`;
const ACCOUNT_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";
const HOOK_URL = "https://hooks.acme-vet.example/faxes";
const SECRET = "whsec_Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo";
const NEW_SECRET = "whsec_bmV3c2VjcmV0dmFsdWUwMTIzNDU2Nzg5YWJjZGVm";
const JSONAPI = "application/vnd.api+json";

const server = mockServer();

beforeEach(() => {
  // Every test here needs a credential to have been minted, not tested.
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(): Ringivo {
  // The scopes are the ones this module's calls need.
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["webhooks:read", "webhooks:write"],
  });
}

function endpointResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "webhook-endpoints",
    id: ENDPOINT_ID,
    attributes: {
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      url: HOOK_URL,
      events: ["fax.received", "fax.delivered"],
      active: true,
      secret: null,
      secretPreviousExpiresAt: null,
      createdAt: "2026-08-10T08:00:00.000000Z",
      updatedAt: "2026-08-10T08:00:00.000000Z",
      ...attributeOverrides,
    },
  };
}

describe("list", () => {
  it("builds the filter and page query", async () => {
    const calls = new Calls();
    server.use(
      http.get(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().webhookEndpoints.list({
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      active: true,
      pageSize: 50,
      after: "0198c4a1",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[scope_type]")).toBe("fax_account");
    expect(params.get("filter[scope_id]")).toBe(ACCOUNT_ID);
    expect(params.get("filter[active]")).toBe("true");
    expect(params.get("page[size]")).toBe("50");
    expect(params.get("page[after]")).toBe("0198c4a1");
    // An unset filter is absent, not empty: `filter[active]=` would be a 400
    // rather than "no opinion".
    expect(params.has("page[before]")).toBe(false);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("sends filter[active]=false rather than dropping it", async () => {
    // `false` is a VALUE — "the endpoints somebody switched off" — and it is
    // the one query a falsy-check would silently turn into "no opinion".
    const calls = new Calls();
    server.use(
      http.get(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().webhookEndpoints.list({ active: false });

    expect(calls.last.url.searchParams.get("filter[active]")).toBe("false");
  });

  it("sends no filter at all when none was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().webhookEndpoints.list();

    // The DENOMINATOR of this check: the call happened, and its query is
    // empty — not "nothing was searched".
    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.keys()]).toEqual([]);
  });

  it("reads the endpoints and the nextCursor from meta.page", async () => {
    server.use(
      http.get(ENDPOINTS_URL, () =>
        HttpResponse.json({
          data: [endpointResource()],
          links: { next: `${ENDPOINTS_URL}?page%5Bafter%5D=0198c4a1-next` },
          meta: { page: { size: 25, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().webhookEndpoints.list();

    expect(page.endpoints).toHaveLength(1);
    expect(page.endpoints[0]?.url).toBe(HOOK_URL);
    expect(page.endpoints[0]?.events).toEqual(["fax.received", "fax.delivered"]);
    // No read but the create and the rotate carries the secret.
    expect(page.endpoints[0]?.secret).toBeNull();
    expect(page.nextCursor).toBe("0198c4a1-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
  });

  it("has no cursor to follow on the last page, where links.next is ABSENT", async () => {
    server.use(
      http.get(ENDPOINTS_URL, () =>
        HttpResponse.json({ data: [], meta: { page: { size: 25, nextCursor: null } } }),
      ),
    );

    const page = await client().webhookEndpoints.list();

    expect(page.endpoints).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.nextUrl).toBeNull();
  });
});

describe("get", () => {
  it("reads a JSON:API document into the public object", async () => {
    server.use(http.get(ENDPOINT_URL, () => HttpResponse.json({ data: endpointResource() })));

    const endpoint = await client().webhookEndpoints.get(ENDPOINT_ID);

    expect(endpoint.id).toBe(ENDPOINT_ID);
    expect(endpoint.scopeType).toBe("fax_account");
    expect(endpoint.scopeId).toBe(ACCOUNT_ID);
    expect(endpoint.url).toBe(HOOK_URL);
    expect(endpoint.events).toEqual(["fax.received", "fax.delivered"]);
    expect(endpoint.active).toBe(true);
    expect(endpoint.secret).toBeNull();
    expect(endpoint.secretPreviousExpiresAt).toBeNull();
    expect(endpoint.createdAt?.toISOString()).toBe("2026-08-10T08:00:00.000Z");
    expect(endpoint.raw.type).toBe("webhook-endpoints");
    expect(Object.isFrozen(endpoint)).toBe(true);
  });

  it("reads a null event list as null, and an empty one as empty", async () => {
    // Both mean "every event in scope" to the platform, and it keeps whichever
    // was sent rather than normalising — so a caller who sent `[]` can tell
    // their write was understood, and this client must not flatten the two.
    server.use(
      http.get(ENDPOINT_URL, () =>
        HttpResponse.json({ data: endpointResource({ events: null }) }),
      ),
    );
    expect((await client().webhookEndpoints.get(ENDPOINT_ID)).events).toBeNull();

    server.use(http.get(ENDPOINT_URL, () => HttpResponse.json({ data: endpointResource({ events: [] }) })));
    expect((await client().webhookEndpoints.get(ENDPOINT_ID)).events).toEqual([]);
  });

  it("keeps an endpoint id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource() });
      }),
    );

    await client().webhookEndpoints.get("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/webhook-endpoints/..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty endpoint id rather than collapsing the path", async () => {
    await expect(client().webhookEndpoints.get("")).rejects.toThrow(
      /a webhook endpoint id is required/,
    );
  });

  it("raises a typed 404 for an endpoint a fax token may not reach", async () => {
    // A customer- or tenant-scoped endpoint answers 404 to a `fax:*` token,
    // exactly as an id that names nothing does.
    server.use(
      http.get(ENDPOINT_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found", detail: "No." }] },
          { status: 404 },
        ),
      ),
    );

    await expect(client().webhookEndpoints.get(ENDPOINT_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(client().webhookEndpoints.get(ENDPOINT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("create", () => {
  it("posts a JSON:API document and hands back the secret", async () => {
    const calls = new Calls();
    server.use(
      http.post(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource({ secret: SECRET }) }, { status: 201 });
      }),
    );

    const endpoint = await client().webhookEndpoints.create({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      events: ["fax.received", "fax.delivered"],
    });

    const body = JSON.parse(calls.last.body) as {
      data: { type: string; attributes: Record<string, unknown> };
    };

    // The content type is the assertion that matters. This surface answers 415
    // to `application/json`, which is what a body sent with no explicit type
    // gets.
    expect(calls.last.request.headers.get("Content-Type")).toBe(JSONAPI);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
    expect(calls.last.request.headers.get("Authorization")).toBe("Bearer tok");
    expect(body.data.type).toBe("webhook-endpoints");
    expect(body.data.attributes).toEqual({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      events: ["fax.received", "fax.delivered"],
    });
    // THE ONLY PLACE THIS IS READABLE. A builder that dropped it would be a
    // credential the caller can never recover.
    expect(endpoint.secret).toBe(SECRET);
  });

  it("sends an empty event list as [] rather than dropping it", async () => {
    // `[]` means "every event in scope" and the platform keeps it verbatim, so
    // it has to reach the wire.
    const calls = new Calls();
    server.use(
      http.post(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource({ events: [] }) }, { status: 201 });
      }),
    );

    const endpoint = await client().webhookEndpoints.create({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      events: [],
    });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes.events).toEqual([]);
    expect("events" in body.data.attributes).toBe(true);
    expect(endpoint.events).toEqual([]);
  });

  it("sends null for an event list the caller nulled", async () => {
    const calls = new Calls();
    server.use(
      http.post(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource({ events: null }) }, { status: 201 });
      }),
    );

    await client().webhookEndpoints.create({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      events: null,
      active: false,
    });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes.events).toBeNull();
    expect(body.data.attributes.active).toBe(false);
  });

  it("leaves out a member nobody named", async () => {
    // ABSENT, not null: the platform's own default applies to a member this
    // client did not send, and `null` would be an instruction instead.
    const calls = new Calls();
    server.use(
      http.post(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource() }, { status: 201 });
      }),
    );

    await client().webhookEndpoints.create({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      // Explicitly undefined, which is what a caller spreading an options
      // object gets, and it must read the same as not passing it at all.
      events: undefined,
    });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes).toEqual({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
    });
    expect("events" in body.data.attributes).toBe(false);
    expect("active" in body.data.attributes).toBe(false);
  });

  it("surfaces the 422 a fax token gets for a customer scope", async () => {
    server.use(
      http.post(ENDPOINTS_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "422",
                code: "validation_failed",
                title: "Unprocessable",
                detail: "The scope is not available to this credential.",
                source: { pointer: "/data/attributes/scopeType" },
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    await expect(
      client().webhookEndpoints.create({
        url: HOOK_URL,
        scopeType: "customer",
        scopeId: ACCOUNT_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_failed" });
  });
});

describe("update", () => {
  it("sends only what was named, with the type and the id", async () => {
    // THE CASE THIS MODULE WAS WRITTEN FOR: an integrator registered for
    // `fax.received` alone and wondered why the outbound events never
    // arrived. Adding them must not disturb the URL or the switch.
    const calls = new Calls();
    server.use(
      http.patch(ENDPOINT_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({
          data: endpointResource({ events: ["fax.received", "fax.delivered", "fax.failed"] }),
        });
      }),
    );

    const endpoint = await client().webhookEndpoints.update(ENDPOINT_ID, {
      events: ["fax.received", "fax.delivered", "fax.failed"],
    });

    const body = JSON.parse(calls.last.body) as {
      data: { type: string; id: string; attributes: Record<string, unknown> };
    };

    expect(calls.last.request.headers.get("Content-Type")).toBe(JSONAPI);
    expect(body.data.type).toBe("webhook-endpoints");
    // The id travels in the document as well as in the path — a JSON:API
    // PATCH names the resource it is changing.
    expect(body.data.id).toBe(ENDPOINT_ID);
    expect(body.data.attributes).toEqual({
      events: ["fax.received", "fax.delivered", "fax.failed"],
    });
    // The URL is NOT sent, though the spec's request schema still marks it
    // required — the server merges the patch over the stored attributes.
    expect("url" in body.data.attributes).toBe(false);
    expect(endpoint.events).toEqual(["fax.received", "fax.delivered", "fax.failed"]);
  });

  it("switches an endpoint off without sending anything else", async () => {
    const calls = new Calls();
    server.use(
      http.patch(ENDPOINT_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource({ active: false }) });
      }),
    );

    const endpoint = await client().webhookEndpoints.update(ENDPOINT_ID, { active: false });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes).toEqual({ active: false });
    expect(endpoint.active).toBe(false);
  });

  it("sends null events as a value, not as an omission", async () => {
    const calls = new Calls();
    server.use(
      http.patch(ENDPOINT_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource({ events: null }) });
      }),
    );

    await client().webhookEndpoints.update(ENDPOINT_ID, { events: null });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes).toEqual({ events: null });
  });

  it("refuses a change that changes nothing", async () => {
    // A PATCH with an empty attributes object is a request the server would
    // accept and act on in no way, spending a round trip and an audit entry to
    // do nothing. It is far more likely a caller building the call from a form
    // that came back empty.
    const calls = new Calls();
    server.use(
      http.patch(ENDPOINT_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource() });
      }),
    );

    await expect(client().webhookEndpoints.update(ENDPOINT_ID, {})).rejects.toThrow(
      /at least one field to change/,
    );

    expect(calls.count, "an empty update reached the wire").toBe(0);
  });

  it("keeps the id escaped in the hand-built URL too", async () => {
    // The reads get their escaping from openapi-fetch. This URL is built here,
    // so the escaping is this module's own and is asserted separately.
    const calls = new Calls();
    server.use(
      http.patch(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource() });
      }),
    );

    await client().webhookEndpoints.update("../faxes/secret", { active: true });

    expect(calls.last.url.pathname).toBe("/v1/webhook-endpoints/..%2Ffaxes%2Fsecret");
  });
});

describe("delete", () => {
  it("sends DELETE and resolves with nothing", async () => {
    const calls = new Calls();
    server.use(
      http.delete(ENDPOINT_URL, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(client().webhookEndpoints.delete(ENDPOINT_ID)).resolves.toBeUndefined();
    expect(calls.last.request.method).toBe("DELETE");
  });
});

describe("rotateSecret", () => {
  it("POSTs with no body and hands back the new secret and the deadline", async () => {
    const calls = new Calls();
    server.use(
      http.post(ROTATE_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({
          data: endpointResource({
            secret: NEW_SECRET,
            secretPreviousExpiresAt: "2026-08-17T08:00:00.000000Z",
          }),
        });
      }),
    );

    const endpoint = await client().webhookEndpoints.rotateSecret(ENDPOINT_ID);

    expect(calls.last.request.method).toBe("POST");
    expect(calls.last.url.pathname).toBe(`/v1/webhook-endpoints/${ENDPOINT_ID}/rotate-secret`);
    // NO BODY, and therefore no Content-Type: this is a verb with nothing to
    // send, and a body would be a document the route does not read.
    expect(calls.last.body).toBe("");
    expect(calls.last.request.headers.get("Content-Type")).toBeNull();
    expect(endpoint.secret).toBe(NEW_SECRET);
    // The grace deadline: until then the PREVIOUS secret signs too.
    expect(endpoint.secretPreviousExpiresAt?.toISOString()).toBe("2026-08-17T08:00:00.000Z");
  });

  it("refuses an empty endpoint id rather than collapsing the path", async () => {
    // `/v1/webhook-endpoints//rotate-secret` is a different request nobody
    // asked for.
    await expect(client().webhookEndpoints.rotateSecret("")).rejects.toThrow(
      /a webhook endpoint id is required/,
    );
  });
});
