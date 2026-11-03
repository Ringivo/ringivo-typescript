/**
 * Text-messaging requests, hosted messaging orders, port orders and the
 * tenant, on the WIRE: each list's filters, each model, the one create and
 * the one update.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TENANT_ID = "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8";
const ENABLEMENT_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";
const NUMBER_ID = "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081";
const ORDER_ID = "0198c4a1-5e6f-7071-b283-4d5e6f708192";
const CUSTOMER_ID = "0198c4a1-6f70-7182-c394-5e6f708192a3";

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
    tenant: TENANT_ID,
    scopes: ["numbers:read", "port-orders:read", "port-orders:hosted-messaging", "tenants:read", "tenants:write"],
  });
}

describe("messagingEnablements", () => {
  it("lists with its filters and reads stage, cause and the number linkage", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/v1/messaging-enablements`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({
          data: [
            {
              type: "messaging-enablements",
              id: ENABLEMENT_ID,
              attributes: {
                e164: "+13025550100",
                status: "failed",
                stage: 3,
                stageWord: "With the current provider",
                detail: "The provider refused it.",
                failedCause: "provider_rejected",
                failedAt: "2026-11-02T10:00:00.000000Z",
                createdAt: "2026-11-01T10:00:00.000000Z",
              },
              relationships: { phoneNumber: { data: { type: "phone-numbers", id: NUMBER_ID } }, portOrder: { data: null } },
            },
          ],
        });
      }),
    );

    const page = await client().messagingEnablements.list({ status: "failed", e164: "+13025550100", phoneNumber: NUMBER_ID });

    expect([...calls.last.url.searchParams.keys()].sort()).toEqual(["filter[e164]", "filter[phoneNumber]", "filter[status]"]);
    const [request] = page.data;
    expect(request?.stage).toBe(3);
    expect(request?.failedCause).toBe("provider_rejected");
    expect(request?.phoneNumberId).toBe(NUMBER_ID);
    expect(request?.portOrderId).toBeNull();
    expect(request?.failedAt).toEqual(new Date("2026-11-02T10:00:00.000Z"));
  });

  it("reads one by id", async () => {
    server.use(
      http.get(`${BASE_URL}/v1/messaging-enablements/${ENABLEMENT_ID}`, () =>
        HttpResponse.json({ data: { type: "messaging-enablements", id: ENABLEMENT_ID, attributes: { status: "completed" } } }),
      ),
    );
    expect((await client().messagingEnablements.get(ENABLEMENT_ID)).status).toBe("completed");
  });
});

describe("hostedMessagingOrders", () => {
  it("creates with the number as an attribute and the customer as a relationship, sent once", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/hosted-messaging-orders`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 503 });
      }),
    );

    await expect(
      client().hostedMessagingOrders.create({
        e164: "+13025550100",
        endUser: { name: "Dana Whitfield", email: "dana@acme.example" },
        customer: CUSTOMER_ID,
      }),
    ).rejects.toThrow();

    expect(calls.count).toBe(1);
    expect(JSON.parse(calls.last.body)).toEqual({
      data: {
        type: "hosted-messaging-orders",
        attributes: { e164: "+13025550100", endUser: { name: "Dana Whitfield", email: "dana@acme.example" } },
        relationships: { customer: { data: { type: "customers", id: CUSTOMER_ID } } },
      },
    });
  });

  it("lists and reads", async () => {
    const calls = new Calls();
    const order = { type: "hosted-messaging-orders", id: ORDER_ID, attributes: { e164: "+13025550100", status: "submitted", mechanism: "claimed" } };
    server.use(
      http.get(`${BASE_URL}/v1/hosted-messaging-orders`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [order] });
      }),
      http.get(`${BASE_URL}/v1/hosted-messaging-orders/${ORDER_ID}`, () => HttpResponse.json({ data: order })),
    );

    const page = await client().hostedMessagingOrders.list({ status: "submitted" });
    expect(calls.last.url.searchParams.get("filter[status]")).toBe("submitted");
    expect(page.data[0]?.mechanism).toBe("claimed");
    expect((await client().hostedMessagingOrders.get(ORDER_ID)).e164).toBe("+13025550100");
  });
});

describe("portOrders", () => {
  it("lists by status and reads the common members, keeping the rest in raw", async () => {
    const calls = new Calls();
    const order = {
      type: "port-orders",
      id: ORDER_ID,
      attributes: {
        label: "Acme move",
        country: "US",
        status: "foc_assigned",
        numbers: ["+13025550100", "+13025550101"],
        correctionsRequired: false,
        tasks: { open: [] },
      },
    };
    server.use(
      http.get(`${BASE_URL}/v1/port-orders`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [order] });
      }),
      http.get(`${BASE_URL}/v1/port-orders/${ORDER_ID}`, () => HttpResponse.json({ data: order })),
    );

    const page = await client().portOrders.list({ status: "foc_assigned" });
    expect(calls.last.url.searchParams.get("filter[status]")).toBe("foc_assigned");
    expect(page.data[0]?.numbers).toEqual(["+13025550100", "+13025550101"]);
    const one = await client().portOrders.get(ORDER_ID);
    expect(one.status).toBe("foc_assigned");
    expect((one.raw.attributes as Record<string, unknown>).tasks).toEqual({ open: [] });
  });
});

describe("tenants", () => {
  it("reads the tenant and updates sparsely, a null clearing a value", async () => {
    const calls = new Calls();
    const tenant = {
      type: "tenants",
      id: TENANT_ID,
      attributes: { brandName: "Acme Voice", status: "active", onboardingRequirements: [], supportEmail: null },
    };
    server.use(
      http.get(`${BASE_URL}/v1/tenants/${TENANT_ID}`, () => HttpResponse.json({ data: tenant })),
      http.patch(`${BASE_URL}/v1/tenants/${TENANT_ID}`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: tenant });
      }),
    );

    const read = await client().tenants.get(TENANT_ID);
    expect(read.brandName).toBe("Acme Voice");
    expect(read.onboardingRequirements).toEqual([]);

    await client().tenants.update(TENANT_ID, { brandColorPrimary: "#112233", supportEmail: null });
    expect(JSON.parse(calls.last.body)).toEqual({
      data: { type: "tenants", id: TENANT_ID, attributes: { brandColorPrimary: "#112233", supportEmail: null } },
    });
    await expect(client().tenants.update(TENANT_ID, {})).rejects.toThrow(/at least one field/);
  });
});
