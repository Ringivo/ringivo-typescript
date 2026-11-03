/**
 * EVERY API OPERATION HAS A NAMED METHOD, OR A WRITTEN REASON IT HAS NONE.
 *
 * The rule (2026-11-03): this package offers a formal public method for
 * everything a client credential can do, never "build the request yourself
 * with `client.request()`". `client.request()` stays as the escape hatch for
 * an operation the API adds before a release names it — it is not how a
 * documented operation is reached.
 *
 * The table below is EXACT IN BOTH DIRECTIONS against the vendored spec, read
 * from the generated `paths` interface: an operation the spec gains fails
 * this test until it is given a method or a reason, and an entry whose
 * operation left the spec fails it too. Each method named is then looked up
 * on a real client, so a row cannot name a method that does not exist.
 *
 * The reasons an operation has no method are three, and only three:
 *
 * - `PAT`: the API takes a person's personal access token for it and refuses
 *   a client credential, which is the only credential this package mints.
 *   A method would be one every caller is refused from. CHECKED against the
 *   spec: such an operation's `security` must offer no `bearerAuth`.
 * - `SIGNED`: the bytes behind a pre-signed link. The link comes from a
 *   method (named in the reason), and the method that follows it is named.
 * - `MINT`: the token endpoint, which the client calls for itself.
 *
 * WHEN A SPEC SYNC ADDS AN OPERATION this test fails on the rolling
 * `spec-sync` branch, so the sync does not land on its own. That is the
 * point, and the procedure is in docs/adr/0001-client-conventions.md,
 * decision 7.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Ringivo } from "../src/index.js";

const PAT = "PAT";

/** operationId → `namespace.method` (dots walk the client), or an exclusion. */
const COVERAGE: Record<string, string | { reason: typeof PAT | "SIGNED" | "MINT"; note: string }> = {
  issueToken: { reason: "MINT", note: "the client mints and refreshes its own token (auth.ts)" },

  // Faxes
  listFaxes: "faxes.list",
  sendFax: "faxes.send",
  getFax: "faxes.get",
  updateFax: "faxes.update",
  deleteFax: "faxes.delete",
  cancelFax: "faxes.cancel",
  getFaxMedia: "faxes.mediaLink",
  getFaxThumbnail: "faxes.thumbnailLink",
  downloadFaxMedia: { reason: "SIGNED", note: "faxes.media() mints the link and follows it" },
  downloadFaxThumbnail: { reason: "SIGNED", note: "faxes.thumbnail() mints the link and follows it" },

  // Fax accounts and their users
  listFaxAccounts: "faxAccounts.list",
  createFaxAccount: "faxAccounts.create",
  getFaxAccount: "faxAccounts.get",
  updateFaxAccount: "faxAccounts.update",
  deleteFaxAccount: "faxAccounts.delete",
  listFaxAccountNumbers: "faxAccounts.numbers",
  listFaxAccountUsers: "faxAccountUsers.list",
  createFaxAccountUser: "faxAccountUsers.create",
  getFaxAccountUser: "faxAccountUsers.get",
  deleteFaxAccountUser: "faxAccountUsers.delete",

  // SIP trunks
  listSipTrunks: "sipTrunks.list",
  createSipTrunk: "sipTrunks.create",
  getSipTrunk: "sipTrunks.get",
  updateSipTrunk: "sipTrunks.update",
  deleteSipTrunk: "sipTrunks.delete",
  revealSipTrunkPassword: "sipTrunks.revealPassword",
  regenerateSipTrunkPassword: "sipTrunks.regeneratePassword",
  listSipTrunkAddressesForTrunk: "sipTrunks.addresses",
  listSipTrunkDestinationsForTrunk: "sipTrunks.destinations",
  listSipTrunkAddresses: "sipTrunkAddresses.list",
  createSipTrunkAddress: "sipTrunkAddresses.create",
  getSipTrunkAddress: "sipTrunkAddresses.get",
  updateSipTrunkAddress: "sipTrunkAddresses.update",
  deleteSipTrunkAddress: "sipTrunkAddresses.delete",
  listSipTrunkDestinations: "sipTrunkDestinations.list",
  createSipTrunkDestination: "sipTrunkDestinations.create",
  getSipTrunkDestination: "sipTrunkDestinations.get",
  updateSipTrunkDestination: "sipTrunkDestinations.update",
  deleteSipTrunkDestination: "sipTrunkDestinations.delete",

  // Webhooks
  listWebhookEndpoints: "webhookEndpoints.list",
  createWebhookEndpoint: "webhookEndpoints.create",
  getWebhookEndpoint: "webhookEndpoints.get",
  updateWebhookEndpoint: "webhookEndpoints.update",
  deleteWebhookEndpoint: "webhookEndpoints.delete",
  rotateWebhookEndpointSecret: "webhookEndpoints.rotateSecret",
  sendWebhookEndpointTest: "webhookEndpoints.sendTest",
  listWebhookTestDeliveries: "webhookTestDeliveries.list",
  getWebhookTestDelivery: "webhookTestDeliveries.get",
  listWebhookDeliveries: "webhookDeliveries.list",
  getWebhookDelivery: "webhookDeliveries.get",

  // Numbers
  searchAvailableNumbers: { reason: PAT, note: "buying spends the reseller's money; a person's token only" },
  orderNumbers: { reason: PAT, note: "buying spends the reseller's money; a person's token only" },
  listRates: { reason: PAT, note: "a person's token only" },
  lookUpNumber: { reason: PAT, note: "a paid lookup; a person's token only" },
  listPhoneNumbers: "phoneNumbers.list",
  getPhoneNumber: "phoneNumbers.get",
  assignPhoneNumberToCustomer: "phoneNumbers.assign",
  unassignPhoneNumberFromCustomer: "phoneNumbers.unassign",
  routePhoneNumber: "phoneNumbers.route",
  unroutePhoneNumber: "phoneNumbers.unroute",
  disableNumberMessaging: { reason: PAT, note: "needs a person who can answer for the number" },
  listRegions: "regions.list",

  // ZTP devices
  listZtpDevices: "ztpDevices.list",
  registerZtpDevice: "ztpDevices.create",
  getZtpDevice: "ztpDevices.get",
  updateZtpDevice: "ztpDevices.update",
  deleteZtpDevice: "ztpDevices.delete",
  retryZtpDevice: "ztpDevices.retry",

  // Text messaging
  listMessagingEnablements: "messagingEnablements.list",
  getMessagingEnablement: "messagingEnablements.get",
  createMessagingEnablement: { reason: PAT, note: "a person signs the letter of authorization" },
  retryMessagingEnablement: { reason: PAT, note: "a person signs the letter of authorization" },
  listInboundMessages: "inboundMessages.list",
  getInboundMessage: "inboundMessages.get",
  downloadInboundMessageMedia: { reason: "SIGNED", note: "inboundMessages.downloadMedia() follows the item's link" },
  recordOutboundMessage: "messages.record",
  listHostedMessagingOrders: "hostedMessagingOrders.list",
  createHostedMessagingOrder: "hostedMessagingOrders.create",
  getHostedMessagingOrder: "hostedMessagingOrders.get",

  // Port orders: reads only — every write needs a person
  listPortOrders: "portOrders.list",
  getPortOrder: "portOrders.get",
  createPortOrder: { reason: PAT, note: "port-order writes need a person" },
  updatePortOrder: { reason: PAT, note: "port-order writes need a person" },
  deletePortOrder: { reason: PAT, note: "port-order writes need a person" },
  submitPortOrder: { reason: PAT, note: "port-order writes need a person" },
  uploadPortOrderDocument: { reason: PAT, note: "port-order writes need a person" },
  generatePortOrderLoa: { reason: PAT, note: "port-order writes need a person" },
  issuePortOrderRequestLink: { reason: PAT, note: "port-order writes need a person" },
  revokePortOrderRequestLink: { reason: PAT, note: "port-order writes need a person" },
  regeneratePortOrderRequestLink: { reason: PAT, note: "port-order writes need a person" },
  sendPortOrderRequestLink: { reason: PAT, note: "port-order writes need a person" },

  // Customers
  listCustomers: "customers.list",
  createCustomer: "customers.create",
  getCustomer: "customers.get",
  updateCustomer: "customers.update",
  deleteCustomer: "customers.delete",
  enableCustomerPbx: "customers.enablePbx",
  removeCustomerPbx: "customers.removePbx",

  // The tenant
  getTenant: "tenants.get",
  updateTenant: "tenants.update",

  // The phone system
  listPbxSubscribers: "pbx.subscribers.list",
  getPbxSubscriber: "pbx.subscribers.get",
  placePbxCall: "pbx.subscribers.call",
  listPbxDevices: "pbx.devices.list",
  getPbxDevice: "pbx.devices.get",
  listCallRecords: "pbx.callRecords.list",
  getCallRecord: "pbx.callRecords.get",
  listCallRecordRecordings: "pbx.callRecords.recordings",
  listCallRecordTranscripts: "pbx.callRecords.transcripts",
  getCallRecordTranscript: "pbx.callRecords.transcript",
  requestCallRecordTranscript: "pbx.callRecords.requestTranscript",
  downloadRecording: { reason: "SIGNED", note: "pbx.callRecords.downloadRecording() follows the recording's link" },
};

/** The operationIds of the generated `paths` interface — the vendored spec's operations, webhooks excluded. */
function specOperations(): string[] {
  const schema = readFileSync(fileURLToPath(new URL("../src/_generated/schema.d.ts", import.meta.url)), "utf8");
  const start = schema.indexOf("export interface paths {");
  const end = schema.indexOf("\nexport ", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  const block = schema.slice(start, end);
  return [...new Set([...block.matchAll(/operations\["([^"]+)"\]/g)].map((m) => m[1] as string))].sort();
}

/** operationId → the `security` the vendored spec declares for it (`undefined` = none, public). */
function specSecurity(): Map<string, readonly Record<string, unknown>[] | undefined> {
  const spec = parse(readFileSync(fileURLToPath(new URL("../spec/openapi.yaml", import.meta.url)), "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string; security?: Record<string, unknown>[] }>>;
  };
  const found = new Map<string, readonly Record<string, unknown>[] | undefined>();
  for (const item of Object.values(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (["get", "post", "put", "patch", "delete"].includes(method) && operation.operationId) {
        found.set(operation.operationId, operation.security);
      }
    }
  }
  return found;
}

function acceptsClientCredential(security: readonly Record<string, unknown>[] | undefined): boolean {
  // No `security` on the operation means it is public (`listRegions`): any caller reaches it.
  return security === undefined || security.some((requirement) => "bearerAuth" in requirement);
}

function client(): Ringivo {
  return new Ringivo({
    baseUrl: "https://api.yourprovider.example",
    clientId: "id",
    clientSecret: "secret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["fax:read"],
  });
}

describe("every API operation has a method", () => {
  it("the table names exactly the spec's operations", () => {
    const operations = specOperations();
    // Anti-vacuity: a broken parse would find nothing and agree with an empty table.
    expect(operations.length).toBeGreaterThan(100);
    expect(Object.keys(COVERAGE).sort()).toEqual(operations);
  });

  it.each(Object.entries(COVERAGE).filter((entry): entry is [string, string] => typeof entry[1] === "string"))(
    "%s is %s()",
    (_operation, method) => {
      let target: unknown = client();
      for (const part of method.split(".")) {
        target = (target as Record<string, unknown>)[part];
      }
      expect(typeof target).toBe("function");
    },
  );

  it("a PAT exclusion is an operation the spec refuses a client credential, and a method is one it allows", () => {
    const security = specSecurity();
    expect(security.size).toBeGreaterThan(100);

    for (const [operation, entry] of Object.entries(COVERAGE)) {
      expect(security.has(operation), operation).toBe(true);
      if (typeof entry === "string") {
        expect(acceptsClientCredential(security.get(operation)), `${operation} has a method but takes no client credential`).toBe(true);
      } else if (entry.reason === PAT) {
        expect(acceptsClientCredential(security.get(operation)), `${operation} is excluded as PAT-only but takes a client credential`).toBe(false);
      }
    }
  });

  it("every method an exclusion names exists", () => {
    const named = Object.values(COVERAGE)
      .filter((entry): entry is { reason: "SIGNED"; note: string } => typeof entry !== "string" && entry.reason === "SIGNED")
      .map((entry) => /^([a-zA-Z.]+)\(\)/.exec(entry.note)?.[1]);
    expect(named.length).toBe(4);
    for (const method of named) {
      let target: unknown = client();
      for (const part of (method ?? "").split(".")) {
        target = (target as Record<string, unknown>)[part];
      }
      expect(typeof target, method).toBe("function");
    }
  });
});
