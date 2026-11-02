/**
 * The client a caller constructs, and the one connection everything shares.
 *
 * `Ringivo` owns three things: the base URL (there is no default — see
 * below), one authenticated request path, and the resource namespaces hung
 * off it (`client.faxes`, `client.faxAccounts`, `client.faxAccountUsers`,
 * `client.webhookEndpoints`, `client.webhookDeliveries`,
 * `client.webhookTestDeliveries`, `client.pbx`,
 * `client.customers`, `client.regions`, `client.phoneNumbers`,
 * `client.messages`, `client.inboundMessages`).
 *
 * -- NO HOSTNAME IS COMPILED IN ---------------------------------------------
 * `baseUrl` is required and has no default. This package is grey-label: the
 * same tarball is installed by integrators of different providers, and a
 * default host would name one of them in every stack trace, every log line
 * and every editor tooltip. tests/grey-label.test.ts asserts the absence
 * from the other side, by reading the BUILT `dist/`.
 *
 * -- ONE REQUEST PATH, ONE AUTH FLOW ----------------------------------------
 * Every request goes through `request()` below, so token caching, the expiry
 * margin, the single 401 refresh, the retries and their backoff (see
 * transport.ts), the User-Agent and the typed errors apply once and apply
 * everywhere. `openapi-fetch` is handed that method as its
 * `fetch`, which is what puts the spec-typed calls in src/faxes.ts on the
 * same path as the hand-written multipart send — and what makes `request()`
 * a supported escape hatch rather than a way around the client.
 *
 * Pre-signed media downloads are the deliberate exception: they go out
 * UNAUTHENTICATED (see `downloadUnauthenticated` in download.ts). The download
 * URL sits on the tenant's own API host, behind a branded media proxy, but
 * it must still never receive our bearer token: the signature in the URL is
 * what authorizes the read, and handing over a credential good for the
 * whole account would extend it to a link that could end up anywhere.
 *
 * -- NOTHING SECRET IS AN ORDINARY PROPERTY -----------------------------------
 * The credential and the token live in a module-private WeakMap (and
 * `#private` fields in auth.ts), never on a property, so `console.log(client)`
 * or a logger that serialises a client prints no secret. tests/secrets.test.ts
 * holds that from the outside.
 *
 * -- WHY THE TYPED TRANSPORT IS HELD IN A WeakMap ---------------------------
 * `openapi-fetch`'s client is typed by `paths`, and `paths` is the
 * whole generated spec — every endpoint, every schema, every description.
 * Held as a public member it would be dragged into `dist/index.d.ts` and
 * PUBLISHED: about 140 KB of types a caller never asked for, whose names and
 * nullability change with a tool upgrade. Nothing generated crosses the
 * public boundary, and this is how that rule is kept rather than merely
 * stated — the map is module-private, so the type stops at this file.
 */
import { type PathBasedClient, createPathBasedClient } from "openapi-fetch";

import type { paths } from "./_generated/schema.js";
import { ClientCredentialsAuth, USER_AGENT } from "./auth.js";
import { Customers } from "./customers.js";
import { FaxAccountUsers } from "./faxAccountUsers.js";
import { FaxAccounts } from "./faxAccounts.js";
import { Faxes } from "./faxes.js";
import { InboundMessages } from "./inboundMessages.js";
import { Messages } from "./messages.js";
import { Pbx } from "./pbx.js";
import { PhoneNumbers } from "./phoneNumbers.js";
import { Regions } from "./regions.js";
import { type Fetch, send } from "./transport.js";
import { VERSION } from "./version.js";
import { WebhookDeliveries } from "./webhookDeliveries.js";
import { WebhookEndpoints } from "./webhookEndpoints.js";
import { WebhookTestDeliveries } from "./webhookTestDeliveries.js";

/** What the JSON:API resource endpoints send and accept. */
export const JSONAPI_MEDIA_TYPE = "application/vnd.api+json";

/**
 * What the four non-JSON:API endpoints send and accept — `POST /v1/faxes`,
 * the two media links, and `POST /v1/faxes/{fax}/cancel`.
 */
export const JSON_MEDIA_TYPE = "application/json";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Anything `new Headers()` takes: a `Headers`, a plain object, or a list of pairs. */
export type HeadersLike = ConstructorParameters<typeof Headers>[0];

/** How many times a failed request is sent again, unless the client or the call says otherwise. */
export const DEFAULT_MAX_RETRIES = 2;

const transports = new WeakMap<Ringivo, PathBasedClient<paths>>();

/** What a client holds that must never be a readable property. */
interface Internals {
  auth: ClientCredentialsAuth;
  fetch: Fetch;
  defaultHeaders: Headers;
}

const internals = new WeakMap<Ringivo, Internals>();

/**
 * What every method accepts as its last argument, to change one call.
 *
 * Each member left out falls back to the client's own setting.
 */
export interface RequestOptions {
  /**
   * Milliseconds each attempt of this call may take, in place of the client's
   * `timeoutMs`. Retries each get the same allowance.
   */
  timeoutMs?: number;
  /** Retries for this call, in place of the client's `maxRetries`. `0` sends once. */
  maxRetries?: number;
  /**
   * Stops the call — the request in flight, or the wait before a retry. The
   * call then rejects with `RequestAbortedError`.
   */
  signal?: AbortSignal;
  /** Extra headers for this call. They replace a client `defaultHeaders` of the same name. */
  headers?: HeadersLike;
}

/** How `Ringivo` is constructed. */
export interface RingivoOptions {
  /**
   * The API root you were given, without a trailing slash —
   * `https://api.yourprovider.example`. Required: this package names no host
   * of its own.
   */
  baseUrl: string;
  /** The client id issued with your credential. */
  clientId: string;
  /** Its secret. */
  clientSecret: string;
  /**
   * The scopes to ask for. **Required, and never empty:** what you get is the
   * intersection with what your grant allows, so an empty ask reaches an
   * empty set — and an empty set is refused, not issued. There is no default
   * to fall back to and there never will be.
   *
   * A scope outside your grant is dropped silently rather than refused, as
   * long as something survives the intersection, so read the scopes back off
   * your provider's answer rather than assuming the request was honoured in
   * full. Only two cases are loud: a scope NAME nobody publishes, and an
   * intersection that comes out empty.
   *
   * `fax:read` and `fax:write` are what the fax calls need. Opening,
   * changing or deleting a fax account needs `fax-accounts:write` as well —
   * a reseller-tier scope, so a credential issued for one customer cannot
   * hold it however it is asked for.
   *
   * Webhook endpoints and their deliveries need `webhooks:read` and
   * `webhooks:write`. A `fax:*` token reaches the `fax_account`-scoped
   * endpoints alone: it may register one, and a customer- or tenant-scoped
   * endpoint is absent from its lists and answers 404 to its reads.
   *
   * The phone-system surface needs `pbx-call-records:read` for the call log,
   * `pbx-users:read` for the subscribers AND their devices — one scope covers
   * both — and `pbx-calls:write` for click-to-dial.
   *
   * Listing and reading your customers needs `customers:read`, which only a
   * credential issued for your whole account holds: it is dropped from a
   * credential issued for one customer when the token is minted.
   *
   * Recording a text you already sent needs `messages:record`; reading the
   * texts sent to your numbers needs `numbers:read` or `numbers:messaging`.
   */
  scopes: readonly string[];
  /**
   * The tenant this client acts for — the id your provider named in the
   * grant behind your credential. **Required:** name it on every client.
   *
   * It is named once, here, because the token CARRIES it: which rows you
   * reach is decided by the token, so acting for another tenant means
   * another client. The token itself is short-lived and this client re-mints
   * it for you — you never handle one.
   *
   * There is nothing left to infer. The mint used to resolve an absent
   * tenant from the one grant a client held, which worked until the day a
   * reseller granted that client a second tenant — and then broke an
   * integration nobody had touched. An id you wrote down cannot rot that way.
   */
  tenant: string;
  /**
   * One customer inside that tenant, when your grant names one. It SELECTS a
   * context your provider already granted and narrows nothing by itself:
   * naming a customer your credential was not granted is refused, and
   * omitting it asks for the tenant-wide token your grant allows.
   */
  customer?: string;
  /**
   * Milliseconds any single attempt may take, token requests and media
   * downloads included. Thirty seconds by default.
   */
  timeoutMs?: number;
  /**
   * How many times a failed request is sent again: 2 by default, `0` to turn
   * retries off.
   *
   * Only what is safe to send twice is retried: reads, deletes, the PATCH
   * updates, and the writes that carry an `Idempotency-Key` (a fax send,
   * click-to-dial). A create without a key is sent once, because a lost answer
   * may hide a row that was made. Only transient answers are retried: no
   * answer, a timeout, 408, 429, any 5xx, and the 409 `idempotency_key_in_use`.
   * The wait is the server's `Retry-After` when it gives one of up to 60
   * seconds, and otherwise a backoff from 0.5 s to 8 s with jitter. A longer
   * `Retry-After` is not waited out: the error carries it as `retryAfter`.
   */
  maxRetries?: number;
  /**
   * The `fetch` to send with — for a proxy agent, a test double, or a runtime
   * whose global `fetch` you want to wrap. The global `fetch` by default,
   * looked up on every request.
   */
  fetch?: (input: Request) => Promise<Response>;
  /** Headers sent with every request, under the ones this client sets itself. */
  defaultHeaders?: HeadersLike;
}

/** A connection to one provider's API, authenticated for its lifetime. */
export class Ringivo {
  /** The API root every request is built against, with no trailing slash. */
  readonly baseUrl: string;

  /** Milliseconds any single attempt may take. */
  readonly timeoutMs: number;

  /** How many times a failed request is sent again. */
  readonly maxRetries: number;

  /** Send a fax, read one, list them, cancel one, fetch its pages. */
  readonly faxes: Faxes;

  /** Open a customer's fax account, read it, change it, delete it. */
  readonly faxAccounts: FaxAccounts;

  /** Who can see a fax account's faxes: list, read, grant, revoke. */
  readonly faxAccountUsers: FaxAccountUsers;

  /**
   * Register a webhook endpoint, change one, remove one, rotate its secret,
   * send it a test event.
   */
  readonly webhookEndpoints: WebhookEndpoints;

  /** Read what we could not deliver to your endpoints. */
  readonly webhookDeliveries: WebhookDeliveries;

  /** Read the results of test events, and wait for one. */
  readonly webhookTestDeliveries: WebhookTestDeliveries;

  /**
   * Your customers' phone systems: `pbx.callRecords`, `pbx.subscribers`,
   * `pbx.devices`, and `pbx.subscribers.call()` for click-to-dial.
   */
  readonly pbx: Pbx;

  /**
   * Your customers: list, read, create, change, delete, and give one a phone
   * system (`enablePbx()`, `waitForPbx()`) or take it away (`removePbx()`).
   */
  readonly customers: Customers;

  /** Where you may place a customer: the values `customers.create()` takes. */
  readonly regions: Regions;

  /** Your numbers: list, read, give one to a customer, point it at a destination. */
  readonly phoneNumbers: PhoneNumbers;

  /** Record a text your own system already sent. */
  readonly messages: Messages;

  /** Read the texts somebody sent to your numbers: list them, read one. */
  readonly inboundMessages: InboundMessages;

  constructor(options: RingivoOptions) {
    if (!options.baseUrl) {
      throw new Error("baseUrl is required");
    }
    if (!options.clientId || !options.clientSecret) {
      throw new Error("clientId and clientSecret are required");
    }
    // REFUSED HERE, LOUDLY, RATHER THAN IN PRODUCTION. Asking for no scopes
    // is not "the default scopes": the server intersects what you ask for
    // with what your grant allows, so an empty ask reaches an empty set — and
    // the mint refuses an empty set with a 400 `invalid_scope` rather than
    // handing back a token every resource would go on to reject. There is no
    // default to invent on the caller's behalf, so the only honest moment to
    // say so is now, one round trip earlier than the server would.
    //
    // BOTH HALVES ARE GATES, and this is the half that runs. `scopes` is
    // REQUIRED in `RingivoOptions`, which stops a TypeScript caller at
    // compile time (src/auth.test.ts holds the `@ts-expect-error` that fails
    // the build the day it stops being required). This check is what a
    // JavaScript caller meets, and it is also the only one of the two that
    // can see an EMPTY list: `readonly string[]` is a type `[]` satisfies.
    if (!options.scopes || options.scopes.length === 0) {
      throw new TypeError(
        "scopes is required: name the scopes your credential was granted, e.g. " +
          'scopes: ["fax:read", "fax:write"]. An empty ask narrows to nothing, and the ' +
          "token endpoint refuses it.",
      );
    }
    // THE SAME PAIR OF GATES, for a rule that arrived later. `tenant` is
    // REQUIRED in `RingivoOptions`, which stops a TypeScript caller at compile
    // time (src/auth.test.ts holds the `@ts-expect-error` that fails the build
    // the day it stops being required). This check is what a JavaScript caller
    // meets, and it is also the only one of the two that can see an EMPTY
    // string — which the mint reads as no tenant at all, per RFC 6749 section
    // 3.2, and refuses as a missing one.
    //
    // Nothing is inferred on the caller's behalf, because there is no longer
    // anything to infer: the mint's single-grant inference is gone, so a
    // client with no tenant has no request that can succeed. Refusing here
    // saves a caller the round trip and names the fix at the line that caused
    // it, instead of a 400 read back out of a log.
    if (!options.tenant) {
      throw new TypeError(
        "tenant is required: name the tenant your credential was granted for, e.g. " +
          'tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8". The mint no longer resolves it ' +
          "from your grant, and a token request without it is refused.",
      );
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new TypeError("maxRetries must be a whole number, 0 or more");
    }
    // Looked up per request rather than captured here, so a global `fetch`
    // replaced after the client was made (a test interceptor, an APM agent)
    // is the one used.
    const fetchImpl: Fetch = options.fetch ?? ((input) => globalThis.fetch(input));
    internals.set(this, {
      fetch: fetchImpl,
      defaultHeaders: new Headers(options.defaultHeaders),
      auth: new ClientCredentialsAuth({
        baseUrl: this.baseUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        tenant: options.tenant,
        customer: options.customer,
        scopes: options.scopes,
        timeoutMs: this.timeoutMs,
        fetch: fetchImpl,
        maxRetries: this.maxRetries,
      }),
    });

    transports.set(
      this,
      createPathBasedClient<paths>({
        baseUrl: this.baseUrl,
        headers: { Accept: JSONAPI_MEDIA_TYPE },
        // The whole point of the seam. `openapi-fetch` builds and types the
        // request; this method is what actually sends it, so the typed calls
        // and the hand-written multipart send share one auth flow and one
        // error path.
        fetch: (outgoing: Request) => this.request(outgoing),
      }),
    );

    this.faxes = new Faxes(this);
    this.faxAccounts = new FaxAccounts(this);
    this.faxAccountUsers = new FaxAccountUsers(this);
    this.webhookEndpoints = new WebhookEndpoints(this);
    this.webhookDeliveries = new WebhookDeliveries(this);
    this.webhookTestDeliveries = new WebhookTestDeliveries(this);
    this.pbx = new Pbx(this);
    this.customers = new Customers(this);
    this.regions = new Regions(this);
    this.phoneNumbers = new PhoneNumbers(this);
    this.messages = new Messages(this);
    this.inboundMessages = new InboundMessages(this);
  }

  toString(): string {
    return `Ringivo { baseUrl: ${this.baseUrl}, version: ${VERSION} }`;
  }

  /** What `util.inspect` and `console.log` print: the base URL, never a credential. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /**
   * Send one request, authenticated, and hand back the response — or throw.
   *
   * Anything at or above 400 becomes a typed error here, so no caller has to
   * check a status code — including the 401 that has already been sent once
   * more with a fresh token.
   *
   * This is also the ESCAPE HATCH, and it is public for that reason: an
   * endpoint this client does not wrap yet is still reachable with your
   * credential, your timeout, your retries, your User-Agent and the same
   * typed errors:
   *
   *     // Every SIP trunk your credential can reach. This client does not
   *     // wrap trunks yet.
   *     const response = await client.request(
   *       new Request(`${client.baseUrl}/v1/sip-trunks`, {
   *         headers: { Accept: "application/vnd.api+json" },
   *       }),
   *     );
   *
   * What you get back is a plain `Response`, not one of this package's
   * frozen objects — you are past the boundary and the shape is the API's.
   *
   * `options` changes this one request (`timeoutMs`, `maxRetries`, `signal`,
   * `headers`); the token request keeps the client's own. It is RETRIED only
   * when sending it twice is safe: a GET, HEAD, OPTIONS, PUT or DELETE, or a
   * request that carries an `Idempotency-Key` header — set one only on an
   * endpoint that honours it.
   */
  async request(outgoing: Request, options: RequestOptions = {}): Promise<Response> {
    return sendThrough(this, outgoing, options, false);
  }
}

/**
 * Send one request through the client's loop. Internal: the resource methods
 * call this with `resendable` set for the writes that are safe to send twice
 * (a PATCH of attribute values), which `request()` cannot know about a request
 * it did not build. A request carrying an `Idempotency-Key` is resendable
 * either way.
 */
export function sendThrough(
  client: Ringivo,
  outgoing: Request,
  options: RequestOptions,
  resendable: boolean,
): Promise<Response> {
  const own = internals.get(client);
  if (!own) {
    throw new Error("this Ringivo client was never constructed");
  }

  // Lowest first: the client's defaults, this call's own, then the two
  // headers this client always sets.
  const headers = new Headers(own.defaultHeaders);
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  headers.set("User-Agent", USER_AGENT);

  const maxRetries = options.maxRetries ?? client.maxRetries;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("maxRetries must be a whole number, 0 or more");
  }

  return send(outgoing, {
    fetch: own.fetch,
    timeoutMs: options.timeoutMs ?? client.timeoutMs,
    maxRetries,
    signal: options.signal,
    resendable,
    headers,
    // ONE refresh after a 401, inside send(): a second 401 is answered by the
    // caller's error, not by another mint — a credential that has lost its
    // reach would otherwise spin, and every mint costs the server a token.
    authorize: (forceRefresh) => own.auth.accessToken({ forceRefresh }),
  });
}

/** The `fetch` a client sends with. Internal: the signed-link download uses it with no token. */
export function fetchOf(client: Ringivo): Fetch {
  const own = internals.get(client);
  if (!own) {
    throw new Error("this Ringivo client was never constructed");
  }
  return own.fetch;
}

/**
 * The per-call options `openapi-fetch` takes, so a spec-typed call goes
 * through `sendThrough()` with this call's `RequestOptions`. Internal.
 */
export function callOptions(
  client: Ringivo,
  options: RequestOptions = {},
  resendable = false,
): { fetch: Fetch } {
  return { fetch: (outgoing: Request) => sendThrough(client, outgoing, options, resendable) };
}

/**
 * The spec-typed transport for one client.
 *
 * Internal to this package and deliberately not re-exported from index.ts:
 * see the WeakMap note at the top of this file.
 */
export function transportOf(client: Ringivo): PathBasedClient<paths> {
  const transport = transports.get(client);
  if (!transport) {
    throw new Error("this Ringivo client was never constructed");
  }
  return transport;
}
