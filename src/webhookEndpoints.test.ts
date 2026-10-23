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
 * And `events` is the member the platform tightened: a create must name a
 * non-empty list, and an update must never send `null`. So the tests here pin
 * the compile-time refusals AND what an untyped caller's `null` does on a
 * PATCH — it is dropped rather than put on the wire.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo, isRetryable } from "./index.js";
import type { CreateWebhookEndpointOptions, UpdateWebhookEndpointOptions } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const ENDPOINTS_URL = `${BASE_URL}/v1/webhook-endpoints`;
const ENDPOINT_ID = "0198c4a1-8192-73b4-e5b6-708192031425";
const ENDPOINT_URL = `${ENDPOINTS_URL}/${ENDPOINT_ID}`;
const ROTATE_URL = `${ENDPOINT_URL}/rotate-secret`;
const TEST_URL = `${ENDPOINT_URL}/test`;
const TEST_ID = "019a0b3c-5d6e-7f80-9a1b-2c3d4e5f6071";
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

    expect(params.get("filter[scopeType]")).toBe("fax_account");
    expect(params.get("filter[scopeId]")).toBe(ACCOUNT_ID);
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
    // A WRITE can no longer produce either: the platform requires a non-empty
    // list on registration and on every change. This is a READER, though, and
    // it answers for documents it did not build — `null` is a response that
    // carried no list at all and `[]` is one that carried an empty list, so a
    // client that turned either into the other would be inventing an answer.
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

  it("does not typecheck without events, or with an empty list", () => {
    // THE DIRECTIVES ARE THE GATE, the way src/auth.test.ts pins its required
    // options: `tsc --noEmit` reports an UNUSED `@ts-expect-error` — and fails
    // the build — the day either of these starts compiling.
    //
    // There is no runtime half to pair them with, and that is deliberate. The
    // platform answers 422 to a create that names no events and to one that
    // names `[]`, so this client refuses both at the type rather than holding
    // a second opinion about them at run time. Nothing is sent here.
    //
    // @ts-expect-error events is required, so an options object without it must not typecheck
    const withoutEvents: CreateWebhookEndpointOptions = {
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
    };
    const withAnEmptyList: CreateWebhookEndpointOptions = {
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      // @ts-expect-error [] is not a non-empty list, so an empty one must not typecheck
      events: [],
    };

    // Each directive is spent on the member it names: every OTHER required
    // option is supplied above, and these two assertions are what stops a
    // later edit from letting a directive pass on a different mistake.
    expect(withoutEvents).not.toHaveProperty("events");
    expect(withAnEmptyList.events).toEqual([]);
  });

  it("sends the switch when the caller names it", async () => {
    const calls = new Calls();
    server.use(
      http.post(ENDPOINTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource({ active: false }) }, { status: 201 });
      }),
    );

    const endpoint = await client().webhookEndpoints.create({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      events: ["fax.received"],
      active: false,
    });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes.active).toBe(false);
    expect(endpoint.active).toBe(false);
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
      events: ["fax.received"],
      // Explicitly undefined, which is what a caller spreading an options
      // object gets, and it must read the same as not passing it at all.
      active: undefined,
    });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes).toEqual({
      url: HOOK_URL,
      scopeType: "fax_account",
      scopeId: ACCOUNT_ID,
      events: ["fax.received"],
    });
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
        events: ["fax.received"],
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

  it("never sends null events, whatever an untyped caller passes", async () => {
    // `null` USED TO BE A VALUE on this member — "every event in scope" — and
    // the platform answers 422 to it now. The option type stops a TypeScript
    // caller (the cast below is what it takes to get past it); JavaScript has
    // no such stop, so the key is dropped instead of sent.
    const calls = new Calls();
    server.use(
      http.patch(ENDPOINT_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: endpointResource() });
      }),
    );

    const nulled = { events: null } as unknown as UpdateWebhookEndpointOptions;

    // Alone, it names nothing this client can send, so the empty-change guard
    // refuses it here rather than spending a round trip on the 422.
    await expect(client().webhookEndpoints.update(ENDPOINT_ID, nulled)).rejects.toThrow(
      /at least one field to change/,
    );
    expect(calls.count, "a null event list reached the wire").toBe(0);

    // And beside a member that IS sendable, the patch goes out without it.
    await client().webhookEndpoints.update(ENDPOINT_ID, { ...nulled, active: false });

    const body = JSON.parse(calls.last.body) as { data: { attributes: Record<string, unknown> } };

    expect(body.data.attributes).toEqual({ active: false });
    expect("events" in body.data.attributes).toBe(false);
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

describe("sendTest", () => {
  // The 202 the spec publishes: the test is on its way, and its result is
  // pending. The resource is a `webhook-test-deliveries` one, whose id is also
  // the `eventId` of the body sent to the endpoint.
  function testResource(attributeOverrides: Record<string, unknown> = {}): object {
    return {
      type: "webhook-test-deliveries",
      id: TEST_ID,
      attributes: {
        eventType: "fax.delivered",
        status: "pending",
        statusCode: null,
        durationMs: null,
        responseBody: null,
        error: null,
        attemptedAt: null,
        createdAt: "2026-10-22T15:04:05.000000Z",
        updatedAt: "2026-10-22T15:04:05.000000Z",
        ...attributeOverrides,
      },
      relationships: {
        endpoint: { data: { type: "webhook-endpoints", id: ENDPOINT_ID } },
      },
    };
  }

  function refusal(
    status: number,
    error: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Response {
    return HttpResponse.json(
      { errors: [{ status: String(status), ...error }] },
      { status, headers: { "Content-Type": JSONAPI, ...headers } },
    );
  }

  it("POSTs a flat JSON body naming the event type, not a JSON:API document", async () => {
    const calls = new Calls();
    server.use(
      http.post(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(
          { data: testResource() },
          { status: 202, headers: { "Content-Type": JSONAPI } },
        );
      }),
    );

    await client().webhookEndpoints.sendTest(ENDPOINT_ID, { type: "fax.delivered" });

    expect(calls.count).toBe(1);
    expect(calls.last.request.method).toBe("POST");
    expect(calls.last.url.pathname).toBe(`/v1/webhook-endpoints/${ENDPOINT_ID}/test`);
    // The spec's requestBody is `application/json`, and its schema is flat:
    // `{"eventType": ...}` and nothing else — no `data`, no `type`.
    expect(JSON.parse(calls.last.body)).toEqual({ eventType: "fax.delivered" });
    expect(calls.last.request.headers.get("Content-Type")).toBe("application/json");
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
    // Each send is a new test. The API reads no Idempotency-Key here, so none
    // is sent.
    expect(calls.last.request.headers.has("Idempotency-Key")).toBe(false);
  });

  it("sends the plain ping type as given", async () => {
    const calls = new Calls();
    server.use(
      http.post(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(
          { data: testResource({ eventType: "webhook.test" }) },
          { status: 202 },
        );
      }),
    );

    const sent = await client().webhookEndpoints.sendTest(ENDPOINT_ID, { type: "webhook.test" });

    expect(JSON.parse(calls.last.body)).toEqual({ eventType: "webhook.test" });
    expect(sent.eventType).toBe("webhook.test");
  });

  it.each([[""], ["   "]])(
    "refuses type %j before any request, rather than letting the API pick the first",
    async (type) => {
      // The API reads an empty or blank string as no type at all and sends
      // the endpoint's first type with a 202 — a test of a type nobody named.
      const calls = new Calls();
      server.use(
        http.post(TEST_URL, async ({ request }) => {
          await calls.record(request);
          return HttpResponse.json({ data: testResource() }, { status: 202 });
        }),
      );

      await expect(client().webhookEndpoints.sendTest(ENDPOINT_ID, { type })).rejects.toThrow(
        /type must name an event type/,
      );
      expect(calls.count).toBe(0);
    },
  );

  it("reads a plain-JavaScript type: null as no type, and sends an empty object", async () => {
    const calls = new Calls();
    server.use(
      http.post(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: testResource() }, { status: 202 });
      }),
    );

    await client().webhookEndpoints.sendTest(ENDPOINT_ID, { type: null as unknown as string });

    expect(calls.count).toBe(1);
    expect(calls.last.body).toBe("{}");
  });

  it("sends an empty object when no type was named, so the API picks the first", async () => {
    const calls = new Calls();
    server.use(
      http.post(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: testResource() }, { status: 202 });
      }),
    );

    await client().webhookEndpoints.sendTest(ENDPOINT_ID);
    await client().webhookEndpoints.sendTest(ENDPOINT_ID, {});

    expect(calls.count).toBe(2);
    expect(calls.at(0).body).toBe("{}");
    expect(calls.at(1).body).toBe("{}");
  });

  it("reads the 202 into a frozen WebhookTestDelivery", async () => {
    server.use(
      http.post(TEST_URL, () =>
        HttpResponse.json(
          { data: testResource() },
          { status: 202, headers: { "Content-Type": JSONAPI } },
        ),
      ),
    );

    const sent = await client().webhookEndpoints.sendTest(ENDPOINT_ID, { type: "fax.delivered" });

    expect(sent.id).toBe(TEST_ID);
    expect(sent.endpointId).toBe(ENDPOINT_ID);
    expect(sent.eventType).toBe("fax.delivered");
    expect(sent.status).toBe("pending");
    expect(sent.statusCode).toBeNull();
    expect(sent.durationMs).toBeNull();
    expect(sent.responseBody).toBeNull();
    expect(sent.error).toBeNull();
    expect(sent.attemptedAt).toBeNull();
    expect(sent.createdAt?.toISOString()).toBe("2026-10-22T15:04:05.000Z");
    expect(sent.updatedAt?.toISOString()).toBe("2026-10-22T15:04:05.000Z");
    expect(Object.isFrozen(sent)).toBe(true);
    expect(sent.raw).toMatchObject({ type: "webhook-test-deliveries", id: TEST_ID });
  });

  it("reads a 202 that is already failed, because the test could not be queued", async () => {
    server.use(
      http.post(TEST_URL, () =>
        HttpResponse.json(
          {
            data: testResource({
              status: "failed",
              error: "The test could not be queued. Send it again later.",
            }),
          },
          { status: 202 },
        ),
      ),
    );

    const sent = await client().webhookEndpoints.sendTest(ENDPOINT_ID);

    expect(sent.status).toBe("failed");
    expect(sent.error).toBe("The test could not be queued. Send it again later.");
  });

  it("keeps an endpoint id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: testResource() }, { status: 202 });
      }),
    );

    await client().webhookEndpoints.sendTest("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/webhook-endpoints/..%2Ffaxes%2Fsecret/test");
  });

  it("refuses an empty endpoint id rather than collapsing the path", async () => {
    await expect(client().webhookEndpoints.sendTest("")).rejects.toThrow(
      /a webhook endpoint id is required/,
    );
  });

  it("surfaces the 409 for a disabled endpoint as a refusal not to retry", async () => {
    server.use(
      http.post(TEST_URL, () =>
        refusal(409, {
          title: "Endpoint disabled",
          detail:
            "This endpoint is disabled, so nothing is sent to it — a test included. Enable it, then send the test.",
        }),
      ),
    );

    const error = await client()
      .webhookEndpoints.sendTest(ENDPOINT_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 409, code: null, retryAfter: undefined });
    expect((error as ApiError).errors[0]?.title).toBe("Endpoint disabled");
    expect(isRetryable(error)).toBe(false);
  });

  it("surfaces the 422 for a type the endpoint may not receive, with its pointer", async () => {
    server.use(
      http.post(TEST_URL, () =>
        refusal(422, {
          title: "Unprocessable Entity",
          detail:
            "This endpoint cannot be sent a test of port_order.status_changed. Send one of: fax.received, fax.delivered, webhook.test.",
          source: { pointer: "/eventType" },
        }),
      ),
    );

    const error = await client()
      .webhookEndpoints.sendTest(ENDPOINT_ID, { type: "port_order.status_changed" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 422 });
    expect((error as ApiError).errors[0]?.source).toEqual({ pointer: "/eventType" });
    expect(isRetryable(error)).toBe(false);
  });

  it.each([
    [
      429,
      "42",
      42,
      "Too many test events",
      "At most 5 test events a minute may be sent to one endpoint, and 5 a minute by one account. Try again in 42 seconds.",
    ],
    [
      503,
      "60",
      60,
      "Test events unavailable",
      "Test events cannot be sent right now. Try again in a minute.",
    ],
  ])(
    "surfaces the %i with its Retry-After, and does not send the test again by itself",
    async (status, header, seconds, title, detail) => {
      const calls = new Calls();
      server.use(
        http.post(TEST_URL, async ({ request }) => {
          await calls.record(request);
          return refusal(status, { title, detail }, { "Retry-After": header });
        }),
      );

      const error = await client()
        .webhookEndpoints.sendTest(ENDPOINT_ID)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ statusCode: status, retryAfter: seconds });
      expect((error as ApiError).errors[0]?.title).toBe(title);
      // The caller may send another test after `retryAfter`; the client does
      // not do it for them.
      expect(isRetryable(error)).toBe(true);
      expect(calls.count).toBe(1);
    },
  );
});
