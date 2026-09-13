/**
 * The webhook-delivery surface, asserted on the WIRE.
 *
 * Two reads, so the whole job is the query string and the object built from
 * the answer — neither of which is observable from the return value alone.
 * `status: "dead"` is the query this collection exists for, so it is asserted
 * on the wire rather than assumed.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const DELIVERIES_URL = `${BASE_URL}/v1/webhook-deliveries`;
const DELIVERY_ID = "0198c4a1-9203-74c5-f6c7-819203142536";
const DELIVERY_URL = `${DELIVERIES_URL}/${DELIVERY_ID}`;
const ENDPOINT_ID = "0198c4a1-8192-73b4-e5b6-708192031425";
const EVENT_ID = "0198c4a1-a314-75d6-07d8-92031425364a";
const DIGEST = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const JSONAPI = "application/vnd.api+json";

const server = mockServer();

beforeEach(() => {
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["webhooks:read"],
  });
}

function deliveryResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "webhook-deliveries",
    id: DELIVERY_ID,
    attributes: {
      eventId: EVENT_ID,
      eventType: "fax.received",
      payloadSha256: DIGEST,
      status: "dead",
      attemptNo: 7,
      statusCode: 500,
      durationMs: 812,
      error: null,
      nextAttemptAt: null,
      // Always null on this API, and deliberately absent from the model —
      // `status` is the status. It stays readable in `raw`.
      deliveredAt: null,
      deadAt: "2026-08-16T19:45:00.000000Z",
      createdAt: "2026-08-16T11:02:31.000000Z",
      updatedAt: "2026-08-16T19:45:00.000000Z",
      ...attributeOverrides,
    },
    relationships: {
      endpoint: { data: { type: "webhook-endpoints", id: ENDPOINT_ID } },
    },
  };
}

describe("list", () => {
  it("builds the filter and page query", async () => {
    const calls = new Calls();
    server.use(
      http.get(DELIVERIES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().webhookDeliveries.list({
      endpoint: ENDPOINT_ID,
      eventType: "fax.received",
      status: "dead",
      pageSize: 100,
      before: "0198c4a1",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[endpoint]")).toBe(ENDPOINT_ID);
    expect(params.get("filter[event_type]")).toBe("fax.received");
    expect(params.get("filter[status]")).toBe("dead");
    expect(params.get("page[size]")).toBe("100");
    expect(params.get("page[before]")).toBe("0198c4a1");
    // An unset filter is absent, not empty.
    expect(params.has("page[after]")).toBe(false);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("sends no filter at all when none was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(DELIVERIES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().webhookDeliveries.list();

    // The DENOMINATOR: the call happened, and its query is empty.
    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.keys()]).toEqual([]);
  });

  it("reads the deliveries and the nextCursor from meta.page", async () => {
    server.use(
      http.get(DELIVERIES_URL, () =>
        HttpResponse.json({
          data: [deliveryResource()],
          links: { next: `${DELIVERIES_URL}?page%5Bafter%5D=0198c4a1-next` },
          meta: { page: { size: 25, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().webhookDeliveries.list({ status: "dead" });

    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]?.status).toBe("dead");
    expect(page.deliveries[0]?.endpointId).toBe(ENDPOINT_ID);
    expect(page.nextCursor).toBe("0198c4a1-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
  });

  it("surfaces the 400 the API answers for a status it does not publish", async () => {
    // There is no `delivered`, and the API refuses the value rather than
    // ignoring it. TypeScript stops that spelling at compile time; a plain
    // JavaScript caller meets this.
    server.use(
      http.get(DELIVERIES_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "400",
                code: "bad_query",
                title: "Bad query",
                detail: "filter[status] must be pending or dead.",
                source: { parameter: "filter[status]" },
              },
            ],
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      client().webhookDeliveries.list({
        status: "delivered" as "dead",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "bad_query" });
  });
});

describe("get", () => {
  it("reads a JSON:API document into the public object", async () => {
    server.use(http.get(DELIVERY_URL, () => HttpResponse.json({ data: deliveryResource() })));

    const delivery = await client().webhookDeliveries.get(DELIVERY_ID);

    expect(delivery.id).toBe(DELIVERY_ID);
    expect(delivery.endpointId).toBe(ENDPOINT_ID);
    expect(delivery.eventId).toBe(EVENT_ID);
    expect(delivery.eventType).toBe("fax.received");
    expect(delivery.payloadSha256).toBe(DIGEST);
    expect(delivery.status).toBe("dead");
    expect(delivery.attemptNo).toBe(7);
    expect(delivery.statusCode).toBe(500);
    expect(delivery.durationMs).toBe(812);
    expect(delivery.error).toBeNull();
    expect(delivery.nextAttemptAt).toBeNull();
    expect(delivery.deadAt?.toISOString()).toBe("2026-08-16T19:45:00.000Z");
    expect(delivery.createdAt?.toISOString()).toBe("2026-08-16T11:02:31.000Z");
    expect(Object.isFrozen(delivery)).toBe(true);
    // `deliveredAt` is not a member of this model — it is always null on the
    // API — and it stays readable in `raw` for anyone who wants to see that.
    expect("deliveredAt" in delivery).toBe(false);
    expect((delivery.raw.attributes as Record<string, unknown>).deliveredAt).toBeNull();
  });

  it("reads a pending delivery's next attempt", async () => {
    server.use(
      http.get(DELIVERY_URL, () =>
        HttpResponse.json({
          data: deliveryResource({
            status: "pending",
            attemptNo: 2,
            statusCode: null,
            error: "connection refused",
            nextAttemptAt: "2026-08-16T11:12:31.000000Z",
            deadAt: null,
          }),
        }),
      ),
    );

    const delivery = await client().webhookDeliveries.get(DELIVERY_ID);

    expect(delivery.status).toBe("pending");
    expect(delivery.statusCode).toBeNull();
    expect(delivery.error).toBe("connection refused");
    expect(delivery.nextAttemptAt?.toISOString()).toBe("2026-08-16T11:12:31.000Z");
    expect(delivery.deadAt).toBeNull();
  });

  it("reads no endpoint rather than crashing when the linkage is absent", async () => {
    // A JSON:API server may answer a relationship with `links` alone. That is
    // legal and says nothing about which endpoint this delivery was for.
    server.use(
      http.get(DELIVERY_URL, () =>
        HttpResponse.json({
          data: {
            ...deliveryResource(),
            relationships: {
              endpoint: { links: { self: `${DELIVERY_URL}/relationships/endpoint` } },
            },
          },
        }),
      ),
    );

    const delivery = await client().webhookDeliveries.get(DELIVERY_ID);

    expect(delivery.endpointId).toBeNull();
    expect(delivery.id).toBe(DELIVERY_ID);
  });

  it("keeps a delivery id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: deliveryResource() });
      }),
    );

    await client().webhookDeliveries.get("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/webhook-deliveries/..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty delivery id rather than reading the whole collection", async () => {
    await expect(client().webhookDeliveries.get("")).rejects.toThrow(
      /a webhook delivery id is required/,
    );
  });

  it("raises a typed 404 for a delivery that has been removed", async () => {
    // A row is removed as soon as a later attempt succeeds, so a 404 here is
    // as likely to be good news as an id that never existed.
    server.use(
      http.get(DELIVERY_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found", detail: "No." }] },
          { status: 404 },
        ),
      ),
    );

    await expect(client().webhookDeliveries.get(DELIVERY_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(client().webhookDeliveries.get(DELIVERY_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});
