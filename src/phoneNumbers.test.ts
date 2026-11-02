/**
 * `client.phoneNumbers` and `client.regions`, read off the wire: the query
 * each read sends, the flat bodies the four verbs send, and what a number's
 * `customerId` is read from.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ConflictError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const NUMBER_ID = "0198c4a1-c6b2-721c-a2ca-738fd1f21d40";
const CUSTOMER_ID = "0198c4a1-7a10-7c3e-9d21-4f5a6b7c8d9e";
const NUMBER_URL = `${BASE_URL}/v1/phone-numbers/${NUMBER_ID}`;

const server = mockServer();

beforeEach(() => {
  server.use(
    http.post(`${BASE_URL}/oauth/token`, () =>
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
    scopes: ["numbers:read", "numbers:assign", "numbers:route"],
  });
}

/** The shape the API answers, measured on a branch read with `include=customer`. */
function numberResource(customer: string | null): object {
  return {
    type: "phone-numbers",
    id: NUMBER_ID,
    attributes: {
      e164: "+14075550111",
      status: "active",
      country: "US",
      activatedAt: null,
      createdAt: "2026-11-02T21:56:44.000000Z",
      messaging: { enabled: false, mmsEnabled: null, messageClass: null, enabledAt: null },
      voice: { enabled: true },
    },
    relationships: {
      customer: { links: {}, data: customer === null ? null : { type: "customers", id: customer } },
      routingTarget: { links: {} },
    },
  };
}

describe("phoneNumbers reads", () => {
  it("lists by e164, always side-loading the customer, and reads customerId off the linkage", async () => {
    const reads = new Calls();
    server.use(
      http.get(`${BASE_URL}/v1/phone-numbers`, async ({ request }) => {
        await reads.record(request);
        return HttpResponse.json({ data: [numberResource(CUSTOMER_ID)], meta: { page: { nextCursor: null } } });
      }),
    );

    const page = await client().phoneNumbers.list({ e164: "+14075550111", status: "active" });

    const [number] = page.data;
    expect(number?.id).toBe(NUMBER_ID);
    expect(number?.e164).toBe("+14075550111");
    expect(number?.customerId).toBe(CUSTOMER_ID);
    expect(number?.voiceEnabled).toBe(true);
    expect(number?.messagingEnabled).toBe(false);
    expect(page.hasNextPage()).toBe(false);

    const query = reads.last.url.searchParams;
    expect(query.get("filter[e164]")).toBe("+14075550111");
    // The `+` arrives as a plus, not a space: it was encoded on the way out.
    expect(reads.last.url.search).toContain("filter[e164]=%2B14075550111");
    expect(query.get("filter[status]")).toBe("active");
    expect(query.get("include")).toBe("customer");
  });

  it("reads one number, and a number in your pool has customerId null", async () => {
    const reads = new Calls();
    server.use(
      http.get(NUMBER_URL, async ({ request }) => {
        await reads.record(request);
        return HttpResponse.json({ data: numberResource(null) });
      }),
    );

    const number = await client().phoneNumbers.get(NUMBER_ID);

    expect(number.customerId).toBeNull();
    expect(reads.last.url.searchParams.get("include")).toBe("customer");
  });
});

describe("phoneNumbers verbs", () => {
  it("assigns with a flat customerId body", async () => {
    const posts = new Calls();
    server.use(
      http.post(`${NUMBER_URL}/customer`, async ({ request }) => {
        await posts.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await client().phoneNumbers.assign(NUMBER_ID, CUSTOMER_ID);

    expect(JSON.parse(posts.last.body)).toEqual({ customerId: CUSTOMER_ID });
    expect(posts.last.request.headers.get("content-type")).toBe("application/json");
  });

  it("routes to the phone system with NO body, and to a fax account by its id", async () => {
    const posts = new Calls();
    server.use(
      http.post(`${NUMBER_URL}/routing`, async ({ request }) => {
        await posts.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await client().phoneNumbers.route(NUMBER_ID);
    await client().phoneNumbers.route(NUMBER_ID, { targetType: "fax", faxAccount: "fa-1" });

    expect(posts.at(0).body).toBe("");
    expect(JSON.parse(posts.at(1).body)).toEqual({ targetType: "fax", faxAccount: "fa-1" });
  });

  it("unassigns and unroutes with a DELETE, and surfaces the state that refuses it", async () => {
    server.use(
      http.delete(`${NUMBER_URL}/routing`, () => new HttpResponse(null, { status: 204 })),
      http.delete(`${NUMBER_URL}/customer`, () =>
        HttpResponse.json({ errors: [{ status: "409", title: "Still routed" }] }, { status: 409 }),
      ),
    );

    await expect(client().phoneNumbers.unroute(NUMBER_ID)).resolves.toBeUndefined();
    const error = await client().phoneNumbers.unassign(NUMBER_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).errors[0]?.title).toBe("Still routed");
  });

  it("refuses an empty id before any request", async () => {
    await expect(client().phoneNumbers.assign("", CUSTOMER_ID)).rejects.toThrow(/phone number id is required/);
    await expect(client().phoneNumbers.assign(NUMBER_ID, "")).rejects.toThrow(/customer id is required/);
  });
});

describe("regions", () => {
  it("answers every country with its options, in the API's order", async () => {
    server.use(
      http.get(`${BASE_URL}/v1/regions`, () =>
        HttpResponse.json({
          data: [
            {
              type: "regions",
              id: "US",
              attributes: {
                options: [
                  { value: "partner_default", label: "Partner default (US East)" },
                  { value: "use1", label: "US East" },
                  { value: "usw1", label: "US West" },
                ],
              },
            },
          ],
        }),
      ),
    );

    const regions = await client().regions.list();

    expect(regions).toHaveLength(1);
    expect(regions[0]?.country).toBe("US");
    expect(regions[0]?.options.map((option) => option.value)).toEqual(["partner_default", "use1", "usw1"]);
    expect(Object.isFrozen(regions)).toBe(true);
  });
});
