/**
 * The customers surface, asserted on the WIRE.
 *
 * Two reads. `list()`'s whole job is a query string and `get()`'s is the
 * object built from the answer, and neither is observable from a return
 * value alone. Three things here are worth more than the usual round trip:
 *
 * - **The list sends only what this release exposes.** `code` and the three
 *   paging members. The spec also documents `sort` and `filter[id]`; neither
 *   is an option here, and the query is asserted key for key so a member
 *   that slipped onto the wire would fail rather than pass unnoticed.
 * - **A customer with no phone system reads null on the five PBX fields.**
 *   `pbx: false` is the answer; `residential`, `callLimit`,
 *   `callLimitExternal`, `transports` and `provisioningState` are null,
 *   never `false`, `0` or an empty list that would read as a real setting.
 * - **The order of `transports` is data.** It is the order the transports are
 *   offered in DNS, first preferred, so it is handed back as it arrived.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const CUSTOMERS_URL = `${BASE_URL}/v1/customers`;
const CUSTOMER_ID = "0198c4a1-7a10-7c3e-9d21-4f5a6b7c8d9e";
const CUSTOMER_URL = `${CUSTOMERS_URL}/${CUSTOMER_ID}`;
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
    scopes: ["customers:read"],
  });
}

function customerResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "customers",
    id: CUSTOMER_ID,
    attributes: {
      name: "Acme Dental",
      code: "jpz3k",
      country: "US",
      addressLines: ["233 S Wacker Dr", "Suite 400"],
      city: "Chicago",
      region: "IL",
      postalCode: "60606",
      timeZone: "America/Chicago",
      dataResidencyCountry: "US",
      regionPreference: "partner_default",
      effectiveRegion: "use1",
      pbx: true,
      residential: false,
      callLimit: 10,
      callLimitExternal: 8,
      transports: ["tls", "udp"],
      provisioningState: "active",
      createdAt: "2026-09-01T12:00:00.000000Z",
      updatedAt: "2026-09-01T12:05:00.000000Z",
      ...attributeOverrides,
    },
  };
}

describe("list", () => {
  it("sends the code filter and the page query, and nothing else", async () => {
    const calls = new Calls();
    server.use(
      http.get(CUSTOMERS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().customers.list({ code: "jpz3k", pageSize: 50, after: "0198c4a1-cursor" });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[code]")).toBe("jpz3k");
    expect(params.get("page[size]")).toBe("50");
    expect(params.get("page[after]")).toBe("0198c4a1-cursor");
    // Key for key: an unset member is absent, not empty, and nothing this
    // release does not expose reaches the wire.
    expect([...params.keys()].sort()).toEqual(["filter[code]", "page[after]", "page[size]"]);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("walks backward from a cursor", async () => {
    const calls = new Calls();
    server.use(
      http.get(CUSTOMERS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().customers.list({ before: "0198c4a1-earlier" });

    expect(calls.last.url.searchParams.get("page[before]")).toBe("0198c4a1-earlier");
    expect(calls.last.url.searchParams.has("page[after]")).toBe(false);
  });

  it("sends no filter at all when none was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(CUSTOMERS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().customers.list();

    // The DENOMINATOR: the call happened, and its query is empty.
    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.keys()]).toEqual([]);
  });

  it("reads the customers and the nextCursor from meta.page", async () => {
    server.use(
      http.get(CUSTOMERS_URL, () =>
        HttpResponse.json({
          data: [customerResource()],
          links: {
            first: CUSTOMERS_URL,
            next: `${CUSTOMERS_URL}?page%5Bafter%5D=0198c4a1-next`,
          },
          meta: { page: { size: 25, nextCursor: "0198c4a1-next", total: 30 } },
        }),
      ),
    );

    const page = await client().customers.list();

    expect(page.customers).toHaveLength(1);
    expect(page.customers[0]?.id).toBe(CUSTOMER_ID);
    expect(page.customers[0]?.name).toBe("Acme Dental");
    expect(page.nextCursor).toBe("0198c4a1-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.customers)).toBe(true);
  });

  it("has no cursor to follow on the last page, where links.next is ABSENT", async () => {
    server.use(
      http.get(CUSTOMERS_URL, () =>
        HttpResponse.json({
          data: [customerResource()],
          links: { first: CUSTOMERS_URL },
          meta: { page: { size: 25, nextCursor: null, total: 1 } },
        }),
      ),
    );

    const page = await client().customers.list();

    expect(page.nextCursor).toBeNull();
    expect(page.nextUrl).toBeNull();
  });
});

describe("get", () => {
  it("reads a JSON:API document into the public object", async () => {
    server.use(http.get(CUSTOMER_URL, () => HttpResponse.json({ data: customerResource() })));

    const customer = await client().customers.get(CUSTOMER_ID);

    expect(customer.id).toBe(CUSTOMER_ID);
    expect(customer.name).toBe("Acme Dental");
    expect(customer.code).toBe("jpz3k");
    expect(customer.country).toBe("US");
    expect(customer.addressLines).toEqual(["233 S Wacker Dr", "Suite 400"]);
    expect(customer.city).toBe("Chicago");
    expect(customer.region).toBe("IL");
    expect(customer.postalCode).toBe("60606");
    expect(customer.timeZone).toBe("America/Chicago");
    expect(customer.dataResidencyCountry).toBe("US");
    expect(customer.regionPreference).toBe("partner_default");
    expect(customer.effectiveRegion).toBe("use1");
    expect(customer.pbx).toBe(true);
    expect(customer.residential).toBe(false);
    expect(customer.callLimit).toBe(10);
    expect(customer.callLimitExternal).toBe(8);
    expect(customer.transports).toEqual(["tls", "udp"]);
    expect(customer.provisioningState).toBe("active");
    expect(customer.createdAt?.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(customer.updatedAt?.toISOString()).toBe("2026-09-01T12:05:00.000Z");
    expect(customer.raw.type).toBe("customers");
  });

  it("keeps the transports in the order the server sent them", async () => {
    // The ORDER is data: it is the order the transports are offered in DNS,
    // first preferred. `udp, tls` is deliberately not alphabetical.
    server.use(
      http.get(CUSTOMER_URL, () =>
        HttpResponse.json({ data: customerResource({ transports: ["udp", "tls", "tcp"] }) }),
      ),
    );

    const customer = await client().customers.get(CUSTOMER_ID);

    expect(customer.transports).toEqual(["udp", "tls", "tcp"]);
  });

  it("reads a customer with no phone system as null on the five PBX fields", async () => {
    server.use(
      http.get(CUSTOMER_URL, () =>
        HttpResponse.json({
          data: customerResource({
            pbx: false,
            residential: null,
            callLimit: null,
            callLimitExternal: null,
            transports: null,
            provisioningState: null,
          }),
        }),
      ),
    );

    const customer = await client().customers.get(CUSTOMER_ID);

    expect(customer.pbx).toBe(false);
    expect(customer.residential).toBeNull();
    expect(customer.callLimit).toBeNull();
    expect(customer.callLimitExternal).toBeNull();
    expect(customer.transports).toBeNull();
    expect(customer.provisioningState).toBeNull();
  });

  it("hands back a frozen object", async () => {
    server.use(http.get(CUSTOMER_URL, () => HttpResponse.json({ data: customerResource() })));

    const customer = await client().customers.get(CUSTOMER_ID);

    expect(Object.isFrozen(customer)).toBe(true);
    expect(Object.isFrozen(customer.addressLines)).toBe(true);
    expect(Object.isFrozen(customer.transports)).toBe(true);
    expect(() => {
      (customer as { name: string | null }).name = "Somebody else";
    }).toThrow();
  });

  it("keeps a customer id inside its own path segment", async () => {
    // An unescaped `../faxes/secret` normalises ON THE WIRE to
    // `/v1/faxes/secret` — a different endpoint, read with this client's token.
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: customerResource() });
      }),
    );

    await client().customers.get("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/customers/..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty id rather than reading the whole collection", async () => {
    await expect(client().customers.get("")).rejects.toThrow(/a customer id is required/);
  });

  it("raises a typed 404 for a customer that is not on your account", async () => {
    server.use(
      http.get(CUSTOMER_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found", detail: "No." }] },
          { status: 404 },
        ),
      ),
    );

    await expect(client().customers.get(CUSTOMER_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(client().customers.get(CUSTOMER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});
