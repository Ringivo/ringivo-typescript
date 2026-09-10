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
 * Webhook receivers want `verifyWebhook()`, which needs no client and no
 * network.
 */
export { Ringivo } from "./client.js";
export type { RingivoOptions } from "./client.js";
export {
  ApiError,
  AuthenticationError,
  RingivoError,
  SignatureVerificationError,
} from "./errors.js";
export type { ApiErrorDetail } from "./errors.js";
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
  Fax,
  FaxAccount,
  FaxAccountNumber,
  FaxAccountPage,
  FaxDocument,
  FaxPage,
  MediaLink,
} from "./models.js";
export { VERSION } from "./version.js";
export { DEFAULT_TOLERANCE_SECONDS, SIGNATURE_HEADER, verifyWebhook } from "./webhooks.js";
export type { VerifyWebhookOptions } from "./webhooks.js";
