/**
 * ZTP devices on the WIRE. The two writes with a relationship are the ones
 * worth pinning: a create that names no customer sends no relationship at
 * all (the device goes to the unassigned pool), and an update that sends
 * `customer: null` sends a NULL linkage (it returns the device to the pool).
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const DEVICE_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";
const CUSTOMER_ID = "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081";

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
    scopes: ["ztp-devices:read", "ztp-devices:write"],
  });
}

const DEVICE = {
  type: "ztp-devices",
  id: DEVICE_ID,
  attributes: {
    mac: "001565f0517a",
    vendor: "yealink",
    label: "Front desk",
    state: "failed",
    stateDetail: "This MAC is already registered — contact support.",
    stateChangedAt: "2026-11-01T10:00:00.000000Z",
    registeredAt: null,
    lastConnectedAt: null,
    lastIp: null,
    observedAt: null,
    createdAt: "2026-11-01T09:59:00.000000Z",
    updatedAt: "2026-11-01T10:00:00.000000Z",
  },
};

describe("ztpDevices", () => {
  it("lists with its filters and reads the device", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/v1/ztp-devices`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [DEVICE] });
      }),
    );

    const page = await client().ztpDevices.list({ mac: "00:15:65:f0:51:7a", state: "failed", customer: CUSTOMER_ID });

    expect([...calls.last.url.searchParams.keys()].sort()).toEqual(["filter[customer]", "filter[mac]", "filter[state]"]);
    const [device] = page.data;
    expect(device?.mac).toBe("001565f0517a");
    expect(device?.state).toBe("failed");
    expect(device?.stateDetail).toContain("already registered");
    expect(device?.registeredAt).toBeNull();
  });

  it("creates with no relationship when no customer is named, and with one when it is", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/ztp-devices`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: DEVICE }, { status: 201 });
      }),
    );

    await client().ztpDevices.create({ mac: "00:15:65:f0:51:7a" });
    await client().ztpDevices.create({ mac: "00:15:65:f0:51:7a", label: "Front desk", customer: CUSTOMER_ID });

    expect(JSON.parse(calls.at(0).body)).toEqual({ data: { type: "ztp-devices", attributes: { mac: "00:15:65:f0:51:7a" } } });
    expect(JSON.parse(calls.at(1).body)).toEqual({
      data: {
        type: "ztp-devices",
        attributes: { mac: "00:15:65:f0:51:7a", label: "Front desk" },
        relationships: { customer: { data: { type: "customers", id: CUSTOMER_ID } } },
      },
    });
  });

  it("updates: customer null is a null linkage, and an empty update is refused", async () => {
    const calls = new Calls();
    server.use(
      http.patch(`${BASE_URL}/v1/ztp-devices/${DEVICE_ID}`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: DEVICE });
      }),
    );

    await client().ztpDevices.update(DEVICE_ID, { customer: null });

    expect(JSON.parse(calls.last.body)).toEqual({
      data: { type: "ztp-devices", id: DEVICE_ID, relationships: { customer: { data: null } } },
    });
    await expect(client().ztpDevices.update(DEVICE_ID, {})).rejects.toThrow(/at least one field/);
  });

  it("retries and deletes by id", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/ztp-devices/${DEVICE_ID}/retry`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 202 });
      }),
      http.delete(`${BASE_URL}/v1/ztp-devices/${DEVICE_ID}`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await client().ztpDevices.retry(DEVICE_ID);
    await client().ztpDevices.delete(DEVICE_ID);

    expect(calls.all.map((call) => call.request.method)).toEqual(["POST", "DELETE"]);
    expect(calls.at(0).body).toBe("");
  });
});
