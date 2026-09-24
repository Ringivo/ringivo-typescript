/**
 * Ringivo API client for TypeScript and JavaScript.
 *
 *     import { readFile } from "node:fs/promises";
 *     import { Ringivo } from "ringivo";
 *
 *     const client = new Ringivo({
 *       baseUrl: "https://api.yourprovider.example",
 *       clientId: "...",
 *       clientSecret: "...",
 *       tenant: "...",
 *       scopes: ["fax:read", "fax:write"],
 *     });
 *
 *     const fax = await client.faxes.send({
 *       faxAccount: "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70",
 *       to: "+13025556789",
 *       file: await readFile("chart-4471.pdf"),
 *     });
 *
 * The base URL has no default and no hostname is compiled into this package:
 * your provider gives you theirs.
 *
 * Fax accounts are `client.faxAccounts` — list them, read one, open one for
 * a customer, change its settings, delete it, and read the numbers routed to
 * it. Reads need `fax:read`; every write needs `fax-accounts:write`.
 *
 * Who may READ one account's faxes is `client.faxAccountUsers` — one row per
 * (user, account) pair. Listing and reading a grant need `fax:read`; the
 * grant and the revoke need `fax-accounts:write`.
 *
 * Webhooks are `client.webhookEndpoints` — register one and store the secret
 * the create hands back, add events to it, switch it off, rotate its secret —
 * and `client.webhookDeliveries` for what we could not deliver. Both need
 * `webhooks:read`/`webhooks:write`, and a `fax:*` token reaches the
 * `fax_account`-scoped endpoints alone.
 *
 * Your customers' phone systems are `client.pbx` — `pbx.callRecords` for the
 * call log, plus `pbx.callRecords.recordings()`/`.transcripts()` for what
 * was captured of one call, `pbx.subscribers` for every extension (people
 * and machines, told apart by `kind`), `pbx.devices` for what their phones
 * have registered, and `pbx.subscribers.call()` to ask one
 * of those phones to dial out. Reading needs `pbx-call-records:read` and
 * `pbx-users:read`; transcripts need `pbx-transcripts:read` too;
 * click-to-dial needs `pbx-calls:write`.
 *
 * Your customers themselves are `client.customers` — list them and read one.
 * A customer's `id` is what `client.pbx` lists take as `customer`. Both need
 * `customers:read`, which only an account-wide credential holds.
 *
 * Webhook receivers want `verifyWebhook()`, which needs no client and no
 * network.
 */
export { Ringivo } from "./client.js";
export type { RingivoOptions } from "./client.js";
export { Customers } from "./customers.js";
export type { ListCustomersOptions } from "./customers.js";
export {
  ApiError,
  AuthenticationError,
  RingivoError,
  SignatureVerificationError,
} from "./errors.js";
export type { ApiErrorDetail } from "./errors.js";
export { FaxAccountUsers } from "./faxAccountUsers.js";
export type {
  CreateFaxAccountUserOptions,
  ListFaxAccountUsersOptions,
} from "./faxAccountUsers.js";
export { FaxAccounts } from "./faxAccounts.js";
export type {
  CreateFaxAccountOptions,
  ListFaxAccountsOptions,
  UpdateFaxAccountOptions,
} from "./faxAccounts.js";
export { Faxes } from "./faxes.js";
export type {
  ListFaxesOptions,
  MediaFormat,
  SendFaxOptions,
  FaxUpload,
} from "./faxes.js";
export type {
  CallRecord,
  CallRecordPage,
  Customer,
  CustomerPage,
  Fax,
  FaxAccount,
  FaxAccountNumber,
  FaxAccountPage,
  FaxAccountUser,
  FaxAccountUserPage,
  FaxDocument,
  FaxPage,
  MediaLink,
  PbxCall,
  PbxDevice,
  PbxDevicePage,
  PbxSubscriber,
  PbxSubscriberPage,
  Recording,
  Transcript,
  WebhookDelivery,
  WebhookDeliveryPage,
  WebhookEndpoint,
  WebhookEndpointPage,
} from "./models.js";
export { CallRecords, Pbx, PbxDevices, PbxSubscribers } from "./pbx.js";
export type {
  ListCallRecordsOptions,
  ListPbxDevicesOptions,
  ListPbxSubscribersOptions,
  PlaceCallOptions,
} from "./pbx.js";
export { VERSION } from "./version.js";
export { WebhookDeliveries } from "./webhookDeliveries.js";
export type { ListWebhookDeliveriesOptions } from "./webhookDeliveries.js";
export { WebhookEndpoints } from "./webhookEndpoints.js";
export type {
  CreateWebhookEndpointOptions,
  ListWebhookEndpointsOptions,
  UpdateWebhookEndpointOptions,
} from "./webhookEndpoints.js";
export { DEFAULT_TOLERANCE_SECONDS, SIGNATURE_HEADER, verifyWebhook } from "./webhooks.js";
export type { VerifyWebhookOptions } from "./webhooks.js";
