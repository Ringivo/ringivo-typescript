/**
 * The SIP trunk namespaces, asserted on the WIRE: each method's verb, path,
 * query and document, and the model built from the answer. Three things are
 * worth more than a round trip:
 *
 * - **An update is sparse.** Only the members passed are sent; `null` is
 *   sent as `null` (it clears), and `undefined` is not sent at all.
 * - **A create and the two password calls are sent ONCE**, a PATCH and a
 *   DELETE are resent on a 503 — a lost create may hide a trunk that was
 *   made, and a lost regenerate a password nobody holds.
 * - **The password is read only off the two password calls.**
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TRUNK_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";
const CUSTOMER_ID = "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081";
const ADDRESS_ID = "0198c4a1-5e6f-7071-b283-4d5e6f708192";
const DESTINATION_ID = "0198c4a1-6f70-7182-c394-5e6f708192a3";
const JSONAPI = "application/vnd.api+json";

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
    scopes: ["sip-trunks:read", "sip-trunks:write", "sip-trunks:admin"],
  });
}

function trunk(attributes: Record<string, unknown> = {}): object {
  return {
    type: "sip-trunks",
    id: TRUNK_ID,
    attributes: {
      name: "Main office",
      domainLabel: "acme-main",
      primaryRegion: "use1",
      enabled: true,
      mode: "register",
      username: "acme",
      password: null,
      registrationMode: "replace",
      registrationExpires: 120,
      localization: "US",
      aniFormat: "plus_e164",
      dnisFormat: "e164",
      dialPolicy: "us_canada",
      mediaMode: "anchored",
      codecs: ["PCMU", "G722"],
      registration: { state: "registered", contacts: [] },
      createdAt: "2026-11-01T10:00:00.000000Z",
      updatedAt: "2026-11-01T10:05:00.000000Z",
      ...attributes,
    },
    relationships: { customer: { data: { type: "customers", id: CUSTOMER_ID } } },
  };
}

describe("sipTrunks", () => {
  it("lists with its filters and reads the trunk off each row", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/v1/sip-trunks`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [trunk()], meta: { page: { nextCursor: null } } });
      }),
    );

    const page = await client().sipTrunks.list({ customer: CUSTOMER_ID, mode: "register", enabled: true, region: "use1" });

    const params = calls.last.url.searchParams;
    expect([...params.keys()].sort()).toEqual(["filter[customer]", "filter[enabled]", "filter[mode]", "filter[region]"]);
    expect(params.get("filter[enabled]")).toBe("true");
    const [row] = page.data;
    expect(row?.id).toBe(TRUNK_ID);
    expect(row?.mode).toBe("register");
    expect(row?.codecs).toEqual(["PCMU", "G722"]);
    expect(row?.registration?.state).toBe("registered");
    expect(row?.customerId).toBe(CUSTOMER_ID);
    expect(row?.password).toBeNull();
    expect(row?.createdAt).toEqual(new Date("2026-11-01T10:00:00.000Z"));
  });

  it("creates with a JSON:API document naming the customer, sent once", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/sip-trunks`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 503 });
      }),
    );

    await expect(
      client().sipTrunks.create({
        customer: CUSTOMER_ID,
        name: "Main office",
        domainLabel: "acme-main",
        primaryRegion: "use1",
        mode: "static",
        codecs: ["PCMU"],
      }),
    ).rejects.toThrow();

    expect(calls.count).toBe(1);
    expect(calls.last.request.headers.get("Content-Type")).toBe(JSONAPI);
    expect(JSON.parse(calls.last.body)).toEqual({
      data: {
        type: "sip-trunks",
        attributes: { name: "Main office", domainLabel: "acme-main", primaryRegion: "use1", mode: "static", codecs: ["PCMU"] },
        relationships: { customer: { data: { type: "customers", id: CUSTOMER_ID } } },
      },
    });
  });

  it("updates sparsely: a null is sent, an undefined is not, and an empty update is refused", async () => {
    const calls = new Calls();
    server.use(
      http.patch(`${BASE_URL}/v1/sip-trunks/${TRUNK_ID}`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: trunk({ enabled: false, username: null }) });
      }),
    );

    const updated = await client().sipTrunks.update(TRUNK_ID, { enabled: false, username: null, name: undefined });

    expect(JSON.parse(calls.last.body)).toEqual({
      data: { type: "sip-trunks", id: TRUNK_ID, attributes: { enabled: false, username: null } },
    });
    expect(updated.enabled).toBe(false);
    await expect(client().sipTrunks.update(TRUNK_ID, {})).rejects.toThrow(/at least one field/);
    expect(calls.count).toBe(1);
  });

  it("reveals and regenerates the password with no body, each sent once", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/sip-trunks/${TRUNK_ID}/reveal-password`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: trunk({ password: "a-long-generated-secret" }) });
      }),
      http.post(`${BASE_URL}/v1/sip-trunks/${TRUNK_ID}/regenerate-password`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 503 });
      }),
    );

    const revealed = await client().sipTrunks.revealPassword(TRUNK_ID);
    expect(revealed.password).toBe("a-long-generated-secret");
    expect(calls.last.body).toBe("");

    await expect(client().sipTrunks.regeneratePassword(TRUNK_ID)).rejects.toThrow();
    expect(calls.count).toBe(2);
  });

  it("deletes, resending on a 503", async () => {
    let attempts = 0;
    server.use(
      http.delete(`${BASE_URL}/v1/sip-trunks/${TRUNK_ID}`, () => {
        attempts += 1;
        return attempts === 1 ? new HttpResponse(null, { status: 503, headers: { "Retry-After": "0" } }) : new HttpResponse(null, { status: 204 });
      }),
    );

    await client().sipTrunks.delete(TRUNK_ID);
    expect(attempts).toBe(2);
  });

  it("lists one trunk's addresses and destinations on its own sub-paths", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/v1/sip-trunks/${TRUNK_ID}/sip-trunk-ips`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [{ type: "sip-trunk-ips", id: ADDRESS_ID, attributes: { cidr: "203.0.113.10/32", description: null } }] });
      }),
      http.get(`${BASE_URL}/v1/sip-trunks/${TRUNK_ID}/sip-trunk-targets`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [{ type: "sip-trunk-targets", id: DESTINATION_ID, attributes: { host: "pbx.acme.example", port: null, transport: "tls", preference: 10, enabled: true } }] });
      }),
    );

    const addresses = await client().sipTrunks.addresses(TRUNK_ID, { pageSize: 100 });
    const destinations = await client().sipTrunks.destinations(TRUNK_ID);

    expect(addresses.data[0]?.cidr).toBe("203.0.113.10/32");
    expect(calls.at(0).url.searchParams.get("page[size]")).toBe("100");
    expect(destinations.data[0]?.transport).toBe("tls");
    expect(destinations.data[0]?.port).toBeNull();
  });

  it("refuses an empty id before anything is sent", async () => {
    await expect(client().sipTrunks.get("")).rejects.toThrow(/SIP trunk id is required/);
  });
});

describe("sipTrunkAddresses", () => {
  it("creates against the trunk, and updates and deletes by id", async () => {
    const calls = new Calls();
    const resource = { type: "sip-trunk-ips", id: ADDRESS_ID, attributes: { cidr: "203.0.113.0/24" }, relationships: { sipTrunk: { data: { type: "sip-trunks", id: TRUNK_ID } } } };
    server.use(
      http.post(`${BASE_URL}/v1/sip-trunk-ips`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: resource }, { status: 201 });
      }),
      http.patch(`${BASE_URL}/v1/sip-trunk-ips/${ADDRESS_ID}`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: resource });
      }),
      http.delete(`${BASE_URL}/v1/sip-trunk-ips/${ADDRESS_ID}`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${BASE_URL}/v1/sip-trunk-ips`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [resource] });
      }),
    );

    const created = await client().sipTrunkAddresses.create({ sipTrunk: TRUNK_ID, cidr: "203.0.113.0/24", description: "Dallas office" });
    expect(JSON.parse(calls.at(0).body)).toEqual({
      data: {
        type: "sip-trunk-ips",
        attributes: { cidr: "203.0.113.0/24", description: "Dallas office" },
        relationships: { sipTrunk: { data: { type: "sip-trunks", id: TRUNK_ID } } },
      },
    });
    expect(created.sipTrunkId).toBe(TRUNK_ID);

    await client().sipTrunkAddresses.update(ADDRESS_ID, { description: null });
    expect(JSON.parse(calls.at(1).body)).toEqual({ data: { type: "sip-trunk-ips", id: ADDRESS_ID, attributes: { description: null } } });
    await expect(client().sipTrunkAddresses.update(ADDRESS_ID, {})).rejects.toThrow(/at least one field/);

    await client().sipTrunkAddresses.delete(ADDRESS_ID);
    expect(calls.at(2).request.method).toBe("DELETE");

    await client().sipTrunkAddresses.list({ sipTrunk: TRUNK_ID });
    expect(calls.at(3).url.searchParams.get("filter[sipTrunk]")).toBe(TRUNK_ID);
  });
});

describe("sipTrunkDestinations", () => {
  it("creates with the four required members, and updates sparsely", async () => {
    const calls = new Calls();
    const resource = { type: "sip-trunk-targets", id: DESTINATION_ID, attributes: { host: "pbx.acme.example", port: 5061, transport: "tls", preference: 10, enabled: true } };
    server.use(
      http.post(`${BASE_URL}/v1/sip-trunk-targets`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: resource }, { status: 201 });
      }),
      http.patch(`${BASE_URL}/v1/sip-trunk-targets/${DESTINATION_ID}`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: resource });
      }),
    );

    const created = await client().sipTrunkDestinations.create({
      sipTrunk: TRUNK_ID,
      host: "pbx.acme.example",
      port: 5061,
      transport: "tls",
      preference: 10,
      enabled: true,
    });
    expect(JSON.parse(calls.at(0).body).data.attributes).toEqual({
      host: "pbx.acme.example",
      port: 5061,
      transport: "tls",
      preference: 10,
      enabled: true,
    });
    expect(created.port).toBe(5061);

    await client().sipTrunkDestinations.update(DESTINATION_ID, { port: null });
    expect(JSON.parse(calls.at(1).body).data.attributes).toEqual({ port: null });
    await expect(client().sipTrunkDestinations.update(DESTINATION_ID, {})).rejects.toThrow(/at least one field/);
  });
});
