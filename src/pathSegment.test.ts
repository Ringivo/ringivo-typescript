/**
 * Every id a public method puts in a path is ONE path segment, or a refusal.
 *
 * `""`, `"."` and `".."` get past `encodeURIComponent` and still steer the
 * request: the empty id collapses into the collection, and the two dot
 * segments are resolved by URL parsing — `/v1/inbound-messages/..` is sent as
 * `/v1/`. This walks every public method that takes an id, so a new method
 * that skips the guard fails here. The mock server answers the token request
 * only: an id that got through would reach a URL nobody handles, and msw
 * fails that request with its own error, not the refusal asserted below.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { mockServer } from "../tests/msw.js";
import { Ringivo } from "./index.js";
import { pathSegment } from "./pathSegment.js";

const BASE_URL = "https://api.yourprovider.example";
const ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";

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
    scopes: ["fax:read"],
  });
}

type Call = (ringivo: Ringivo, id: string) => Promise<unknown>;

const CALLS: Array<[string, Call, string]> = [
  ["faxes.get", (r, id) => r.faxes.get(id), "a fax id is required"],
  ["faxes.cancel", (r, id) => r.faxes.cancel(id), "a fax id is required"],
  ["faxes.mediaLink", (r, id) => r.faxes.mediaLink(id), "a fax id is required"],
  ["faxes.thumbnailLink", (r, id) => r.faxes.thumbnailLink(id), "a fax id is required"],
  ["faxes.media", (r, id) => r.faxes.media(id), "a fax id is required"],
  ["faxAccounts.get", (r, id) => r.faxAccounts.get(id), "a fax account id is required"],
  ["faxAccounts.numbers", (r, id) => r.faxAccounts.numbers(id), "a fax account id is required"],
  [
    "faxAccounts.update",
    (r, id) => r.faxAccounts.update(id, { name: "x" }),
    "a fax account id is required",
  ],
  ["faxAccounts.delete", (r, id) => r.faxAccounts.delete(id), "a fax account id is required"],
  [
    "faxAccountUsers.get",
    (r, id) => r.faxAccountUsers.get(id),
    "a fax account user id is required",
  ],
  [
    "faxAccountUsers.delete",
    (r, id) => r.faxAccountUsers.delete(id),
    "a fax account user id is required",
  ],
  [
    "webhookEndpoints.get",
    (r, id) => r.webhookEndpoints.get(id),
    "a webhook endpoint id is required",
  ],
  [
    "webhookEndpoints.update",
    (r, id) => r.webhookEndpoints.update(id, { active: false }),
    "a webhook endpoint id is required",
  ],
  [
    "webhookEndpoints.delete",
    (r, id) => r.webhookEndpoints.delete(id),
    "a webhook endpoint id is required",
  ],
  [
    "webhookEndpoints.rotateSecret",
    (r, id) => r.webhookEndpoints.rotateSecret(id),
    "a webhook endpoint id is required",
  ],
  [
    "webhookDeliveries.get",
    (r, id) => r.webhookDeliveries.get(id),
    "a webhook delivery id is required",
  ],
  ["customers.get", (r, id) => r.customers.get(id), "a customer id is required"],
  [
    "inboundMessages.get",
    (r, id) => r.inboundMessages.get(id),
    "an inbound message id is required",
  ],
  ["pbx.callRecords.get", (r, id) => r.pbx.callRecords.get(id), "a call record id is required"],
  [
    "pbx.callRecords.recordings",
    (r, id) => r.pbx.callRecords.recordings(id),
    "a call record id is required",
  ],
  [
    "pbx.callRecords.transcripts",
    (r, id) => r.pbx.callRecords.transcripts(id),
    "a call record id is required",
  ],
  [
    "pbx.callRecords.transcript (call record)",
    (r, id) => r.pbx.callRecords.transcript(id, ID),
    "a call record id is required",
  ],
  [
    "pbx.callRecords.transcript (recording)",
    (r, id) => r.pbx.callRecords.transcript(ID, id),
    "a recording id is required",
  ],
  [
    "pbx.callRecords.requestTranscript (call record)",
    (r, id) => r.pbx.callRecords.requestTranscript(id, ID),
    "a call record id is required",
  ],
  [
    "pbx.callRecords.requestTranscript (recording)",
    (r, id) => r.pbx.callRecords.requestTranscript(ID, id),
    "a recording id is required",
  ],
  ["pbx.subscribers.get", (r, id) => r.pbx.subscribers.get(id), "a pbx subscriber id is required"],
  [
    "pbx.subscribers.call",
    (r, id) => r.pbx.subscribers.call(id, { destination: "1001" }),
    "a pbx subscriber id is required",
  ],
  ["pbx.devices.get", (r, id) => r.pbx.devices.get(id), "a pbx device id is required"],
];

describe.each(CALLS)("%s", (_name, call, refusal) => {
  it.each(["", ".", ".."])("refuses %j before any request", async (id) => {
    await expect(call(client(), id)).rejects.toThrow(refusal);
  });
});

describe("pathSegment", () => {
  it("hands back an id that is one segment, dots inside it included", () => {
    expect(pathSegment(ID, "x")).toBe(ID);
    expect(pathSegment("...", "x")).toBe("...");
    expect(pathSegment("a.b", "x")).toBe("a.b");
  });

  it("names the dot segment it refused", () => {
    expect(() => pathSegment("..", "a fax id is required")).toThrow(
      'a fax id is required; got "..", a dot segment',
    );
  });
});
