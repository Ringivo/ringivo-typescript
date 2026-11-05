/**
 * PBX numbers on the WIRE. Worth pinning: the create is a JSON:API document
 * naming the phone number as a RELATIONSHIP (there is no attribute to send),
 * it is sent once against a 503, and the model reads the phone system's
 * spelling of the number into `number`.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ConflictError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const PBX_NUMBER_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";
const PHONE_NUMBER_ID = "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081";
const CUSTOMER_ID = "0198c4a1-5e6f-7071-b283-4d5e6f708192";
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
    scopes: ["numbers:read", "numbers:route"],
  });
}

function resource(state = "pending"): object {
  return {
    type: "pbx-numbers",
    id: PBX_NUMBER_ID,
    attributes: {
      phoneSystemNumber: "13025550100",
      state,
      stateDetail: state === "failed" ? "The phone system refused the number." : null,
      stateChangedAt: "2026-11-03T22:00:00.000000Z",
      createdAt: "2026-11-03T21:59:00.000000Z",
      updatedAt: "2026-11-03T22:00:00.000000Z",
    },
    relationships: {
      phoneNumber: { data: { type: "phone-numbers", id: PHONE_NUMBER_ID } },
      customer: { data: { type: "customers", id: CUSTOMER_ID } },
    },
  };
}

describe("pbxNumbers", () => {
  it("creates with the phone number as a relationship, and reads the answer", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/pbx-numbers`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: resource() }, { status: 201 });
      }),
    );

    const added = await client().pbxNumbers.create({ phoneNumberId: PHONE_NUMBER_ID });

    expect(calls.last.request.headers.get("Content-Type")).toBe(JSONAPI);
    expect(JSON.parse(calls.last.body)).toEqual({
      data: {
        type: "pbx-numbers",
        relationships: { phoneNumber: { data: { type: "phone-numbers", id: PHONE_NUMBER_ID } } },
      },
    });
    expect(added.id).toBe(PBX_NUMBER_ID);
    expect(added.number).toBe("13025550100");
    expect(added.state).toBe("pending");
    expect(added.phoneNumberId).toBe(PHONE_NUMBER_ID);
    expect(added.customerId).toBe(CUSTOMER_ID);
    expect(added.createdAt).toEqual(new Date("2026-11-03T21:59:00.000Z"));
  });

  it("sends a create once, never again on a 503", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/pbx-numbers`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 503 });
      }),
    );

    await expect(client().pbxNumbers.create({ phoneNumberId: PHONE_NUMBER_ID })).rejects.toThrow();
    expect(calls.count).toBe(1);
  });

  it("surfaces a refused add as a ConflictError carrying the step to take first", async () => {
    server.use(
      http.post(`${BASE_URL}/v1/pbx-numbers`, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "409",
                title: "Cannot join the PBX",
                detail: "+13025550100 is not routed to Acme Dental's PBX yet. Route it first.",
              },
            ],
          },
          { status: 409, headers: { "Content-Type": JSONAPI } },
        ),
      ),
    );

    const error = await client().pbxNumbers.create({ phoneNumberId: PHONE_NUMBER_ID }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).errors[0]?.detail).toContain("Route it first");
  });

  it("lists by phone number and state, and reads one", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/v1/pbx-numbers`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [resource("failed")], meta: { page: { nextCursor: null } } });
      }),
      http.get(`${BASE_URL}/v1/pbx-numbers/${PBX_NUMBER_ID}`, () => HttpResponse.json({ data: resource("active") })),
    );

    const page = await client().pbxNumbers.list({ phoneNumber: PHONE_NUMBER_ID, state: "failed" });

    expect([...calls.last.url.searchParams.keys()].sort()).toEqual(["filter[phoneNumber]", "filter[state]"]);
    expect(calls.last.url.searchParams.get("filter[phoneNumber]")).toBe(PHONE_NUMBER_ID);
    expect(calls.last.url.searchParams.get("filter[state]")).toBe("failed");
    expect(page.data[0]?.stateDetail).toContain("refused");
    expect((await client().pbxNumbers.get(PBX_NUMBER_ID)).state).toBe("active");
  });

  it("deletes and retries by id with no body", async () => {
    const calls = new Calls();
    server.use(
      http.delete(`${BASE_URL}/v1/pbx-numbers/${PBX_NUMBER_ID}`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BASE_URL}/v1/pbx-numbers/${PBX_NUMBER_ID}/retry`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await client().pbxNumbers.retry(PBX_NUMBER_ID);
    await client().pbxNumbers.delete(PBX_NUMBER_ID);

    expect(calls.all.map((call) => call.request.method)).toEqual(["POST", "DELETE"]);
    expect(calls.at(0).body).toBe("");
  });

  it("sends a retry once, never again on a 503", async () => {
    // A second retry while the first is queued is a 409, not the first answer, so the
    // client must not resend it.
    const calls = new Calls();
    server.use(
      http.post(`${BASE_URL}/v1/pbx-numbers/${PBX_NUMBER_ID}/retry`, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 503 });
      }),
    );

    await expect(client().pbxNumbers.retry(PBX_NUMBER_ID)).rejects.toThrow();
    expect(calls.count).toBe(1);
  });

  it("refuses an empty id before anything is sent", async () => {
    await expect(client().pbxNumbers.create({ phoneNumberId: "" })).rejects.toThrow(/phone number id is required/);
    await expect(client().pbxNumbers.get("")).rejects.toThrow(/PBX number id is required/);
  });
});
