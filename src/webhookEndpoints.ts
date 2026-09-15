/**
 * Register a webhook endpoint, read one, list them, change one, remove one,
 * and rotate its signing secret.
 *
 * -- WHAT IS TYPED BY THE SPEC, AND WHAT IS HAND-BUILT ----------------------
 * `list`, `get`, `delete` and `rotateSecret` go through the `openapi-fetch`
 * client in client.ts, so `src/_generated/schema.d.ts` type-checks their
 * paths, their query members and their response bodies at compile time.
 * `rotateSecret` is a POST with no body at all, which that transport sends
 * without inventing a `Content-Type` — so there is nothing here for a
 * hand-built request to add.
 *
 * `create` and `update` build their JSON:API document here and send it
 * through `client.request()` — the same public escape hatch, the same auth
 * flow, the same typed errors — exactly as `faxAccounts` does. THEIR BODIES
 * ARE SPEC-TYPED ALL THE SAME: each document is declared as the generated
 * request schema, so a member this package spells wrongly is a compile error
 * rather than a 422 somebody reads out of a log. What takes them off the
 * typed transport is the MEDIA TYPE: a JSON:API resource route answers 415 to
 * `application/json`, which is what a body sent with no explicit type gets,
 * and the shared transport is built with `Accept` alone (client.ts).
 *
 * -- THE SECRET IS READABLE TWICE, AND NEVER AGAIN --------------------------
 * `create()` and `rotateSecret()` are the only calls whose response carries
 * the signing secret. Every other read answers `secret: null`, because the
 * platform holds no readable copy — store it the moment you have it.
 *
 * A rotation starts a clock rather than replacing the secret outright: the
 * previous one goes on signing for a 24-hour grace window, whose deadline is
 * `WebhookEndpoint.secretPreviousExpiresAt`. During it a delivery's signature
 * header carries two `v1` values, newest first, and `verifyWebhook()` accepts
 * either — so a rotation costs no deliveries as long as your own copy is
 * rolled before the deadline.
 *
 * -- SPARSE WRITES, AND THE ONE MEMBER THAT IS NOT OPTIONAL -----------------
 * `update()` sends only the members the caller passed, so adding events to an
 * endpoint leaves its URL and its switch alone: `undefined` is "not given",
 * and an attribute nobody named is absent from the document rather than sent
 * as `null`, so the platform's own default applies. `create()` follows the
 * same rule for `active`.
 *
 * `events` IS THE EXCEPTION, and it is the member that changed. It used to be
 * optional and nullable, where `null` and `[]` both meant "every event in
 * scope". The platform refuses both now — an endpoint that named none would
 * receive every event type the platform ever adds, at a handler nobody asked
 * whether it wanted one — so `create()` requires a non-empty list and
 * `update()` never sends `null`. Both arms of the API answer 422 to each, and
 * the option type here is a non-empty array, so an empty literal is a compile
 * error rather than a round trip.
 */
import type { components, paths } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type Ringivo, transportOf } from "./client.js";
import {
  type RawJson,
  type WebhookEndpoint,
  type WebhookEndpointPage,
  isRecord,
  webhookEndpointFromResource,
  webhookEndpointPageFromDocument,
} from "./models.js";

/**
 * The query the spec publishes for `GET /v1/webhook-endpoints`.
 *
 * Used to cast the one member whose spec type is an ENUM while this client's
 * own option is a `string` — `scopeType`. Deliberate, and it matches
 * `WebhookEndpoint.scopeType`: a scope the server adds tomorrow must be
 * filterable today, without waiting for a regenerate and a release.
 *
 * Local and unexported: nothing generated crosses the public boundary.
 */
type ListWebhookEndpointsQuery = NonNullable<
  paths["/v1/webhook-endpoints"]["get"]["parameters"]["query"]
>;

/**
 * The create document and its attribute bag, as the spec declares them.
 *
 * Local and unexported, like the query above. What they buy is that a member
 * misspelled here is a compile error rather than a 422 read back out of a
 * log — the create attributes carry no `additionalProperties`, so that check
 * is a real one.
 */
type CreateRequest = components["schemas"]["WebhookEndpointCreateRequest"];
type CreateAttributes = CreateRequest["data"]["attributes"];

/**
 * The update document and its attribute bag, as the spec declares them —
 * spec-typed directly, the same way `CreateRequest` above is.
 *
 * A local alias with `url` made OPTIONAL used to stand here: the vendored
 * spec wrongly marked `url` as required inside `WebhookEndpointUpdateRequest`,
 * so the generated type demanded it on every PATCH even though the server
 * accepts a sparse one. That spec defect was corrected upstream (console
 * side) and the sync landed on `main` as 1913c4b on 2026-09-13, so the
 * generated type is accurate again and the loosening is gone.
 *
 * Measured rather than assumed: a throwaway probe against this type reported
 * no error for a PATCH naming no `url`, and:
 *
 *     src/__probe.ts(12,61): error TS2322: Type 'string' is not assignable
 *       to type 'boolean | undefined'.
 *     src/__probe.ts(17,70): error TS2322: Type 'number' is not assignable
 *       to type '"fax.received" | ... | "port_order.status_changed"'.
 *
 * for a wrong `active` (a string) and a wrong `events` (numbers).
 */
type UpdateRequest = components["schemas"]["WebhookEndpointUpdateRequest"];
type UpdateAttributes = UpdateRequest["data"]["attributes"];

/** What `webhookEndpoints.list()` accepts. Every member narrows the list. */
export interface ListWebhookEndpointsOptions {
  /**
   * `tenant`, `customer` or `fax_account` — what the endpoints you want hear
   * about. The three are a containment order, so a reseller-wide endpoint and
   * a per-account one both hear about the same fax.
   */
  scopeType?: string;
  /** The id of the tenant, customer or fax account the endpoints are for. */
  scopeId?: string;
  /** Only the endpoints that are switched on, or only those switched off. */
  active?: boolean;
  /**
   * Walk forward: the previous page's `WebhookEndpointPage.nextCursor`.
   * Cannot be combined with `before`.
   */
  after?: string;
  /**
   * Walk backward from a cursor you already hold — this is how you poll for
   * rows that arrived since your last read. Cannot be combined with `after`.
   */
  before?: string;
  /** Rows per page. The default is 25 and the ceiling is 100. */
  pageSize?: number;
}

/** What `webhookEndpoints.create()` accepts. */
export interface CreateWebhookEndpointOptions {
  /**
   * Where we POST. `https` only, on a public host: plain http, credentials in
   * the URL, a private address literal and any other scheme are each refused
   * at registration. A hostname that does not resolve YET is accepted on
   * purpose, so you can register before you publish DNS.
   */
  url: string;
  /**
   * What this endpoint hears about: `tenant`, `customer` or `fax_account`.
   * Required, and fixed for the endpoint's life — the delivery history is the
   * record of what THAT scope was told, so a different scope is a new
   * endpoint.
   */
  scopeType: string;
  /** The id of that tenant, customer or fax account. Required. */
  scopeId: string;
  /**
   * The events you want — AT LEAST ONE, and the list is exact: this endpoint
   * hears about the names on it and about nothing else.
   *
   * **There is no "everything" spelling.** `null` and `[]` used to mean "every
   * event in scope"; each is a 422 now, because that default is paid for by a
   * handler that meets a brand-new event type it has never seen. Name the
   * events you handle, and add to the list with `update()` when you handle
   * more.
   *
   * The type is a non-empty array, so `events: []` is a compile error rather
   * than a round trip. An event name this platform does not publish is a 422 —
   * a typo would otherwise subscribe you to silence.
   */
  events: readonly [string, ...string[]];
  /** Switched on unless you say otherwise. */
  active?: boolean;
}

/**
 * What `webhookEndpoints.update()` accepts — a SPARSE patch.
 *
 * Only the members you pass are sent, so adding events leaves the URL and the
 * switch exactly as they were. `undefined` is "not given", and it is the only
 * way to leave a member alone: `null` is not a value this surface takes any
 * more.
 *
 * There is no `scopeType` or `scopeId` here on purpose: neither can change.
 */
export interface UpdateWebhookEndpointOptions {
  /** Where we POST from now on. `https` only, on a public host. */
  url?: string;
  /**
   * The events you want from now on — the list REPLACES the old one, it is
   * not merged into it, and it must still name at least one. `[]` is a 422;
   * this client never sends `null` — a JavaScript caller's `null` is dropped
   * from the PATCH, and refused if nothing else was named. A PATCH that could
   * empty the list would otherwise reach the every-event state a create
   * refuses, one request later.
   */
  events?: readonly [string, ...string[]];
  /**
   * `false` stops the fan-out without removing the endpoint, and keeps its
   * secret and its delivery history.
   */
  active?: boolean;
}

/** The `client.webhookEndpoints` namespace. */
export class WebhookEndpoints {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of webhook endpoints, newest first.
   *
   * `secret` is `null` on every endpoint here — see `create()`.
   *
   * Needs `webhooks:read`. A `fax:read` token lists only the
   * **fax-account-scoped** endpoints: customer- and tenant-scoped ones are
   * absent from that list rather than refused, so a short list is what a
   * narrower token looks like.
   */
  async list(options: ListWebhookEndpointsOptions = {}): Promise<WebhookEndpointPage> {
    const { data } = await transportOf(this.client)["/v1/webhook-endpoints"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[scope_type]": options.scopeType as ListWebhookEndpointsQuery["filter[scope_type]"],
          "filter[scope_id]": options.scopeId,
          "filter[active]": options.active,
        },
      },
    });

    return webhookEndpointPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one webhook endpoint.
   *
   * `secret` is always `null` here — see `create()`.
   *
   * Needs `webhooks:read`. A `fax:read` token reaches only a
   * **fax-account-scoped** endpoint; a customer- or tenant-scoped one answers
   * 404 to it, exactly as an id that names nothing does.
   */
  async get(webhookEndpointId: string): Promise<WebhookEndpoint> {
    const { data } = await transportOf(this.client)[
      "/v1/webhook-endpoints/{webhookEndpoint}"
    ].GET({
      params: { path: { webhookEndpoint: webhookEndpointIdParam(webhookEndpointId) } },
    });

    return webhookEndpointFromResource(dataObject(data));
  }

  /**
   * Register a webhook endpoint — and STORE THE SECRET IT HANDS BACK.
   *
   * The returned `WebhookEndpoint.secret` is the signing secret, and this
   * response and a later `rotateSecret()` are the only places it is ever
   * readable: **store it now; there is no way to read it back.** Every other
   * read answers `secret: null`, because the platform keeps no readable copy.
   *
   * `events` NAMES WHAT THIS ENDPOINT HEARS ABOUT, and it is required: there
   * is no spelling left that means "every event in scope", because a handler
   * should not meet an event type nobody subscribed it to.
   *
   * Needs `webhooks:write`. A `fax:write` token may register only a
   * `fax_account`-scoped endpoint: naming a `customer` or `tenant` scope with
   * a `fax:*` token is a 422.
   */
  async create(options: CreateWebhookEndpointOptions): Promise<WebhookEndpoint> {
    const attributes: CreateAttributes = {
      url: options.url,
      scopeType: options.scopeType as CreateAttributes["scopeType"],
      scopeId: options.scopeId,
      events: eventList(options.events),
    };
    if (options.active !== undefined) {
      attributes.active = options.active;
    }

    const document: CreateRequest = {
      data: { type: "webhook-endpoints", attributes },
    };

    const response = await this.client.request(
      new Request(`${this.client.baseUrl}/v1/webhook-endpoints`, {
        method: "POST",
        headers: jsonApiHeaders(),
        body: JSON.stringify(document),
      }),
    );

    return webhookEndpointFromResource(dataObject(await response.json()));
  }

  /**
   * Change an endpoint's URL, its event list, or its switch.
   *
   * A SPARSE PATCH: only the members you pass are sent, so adding events
   * leaves the URL alone. This is how an integrator who registered for one
   * event subscribes to the rest — `update(id, { events: [...] })` — and the
   * list REPLACES the old one rather than being merged into it.
   *
   * `scopeType` and `scopeId` cannot be changed and are not offered: a
   * different scope is a new endpoint.
   *
   * @throws Error when no member was named. An empty PATCH spends a round
   *   trip and an audit entry to change nothing, and it is far more often a
   *   form that came back empty than an intention.
   *
   * Needs `webhooks:write`. A `fax:write` token reaches only a
   * **fax-account-scoped** endpoint; a customer- or tenant-scoped one answers
   * 404 to it.
   */
  async update(
    webhookEndpointId: string,
    options: UpdateWebhookEndpointOptions,
  ): Promise<WebhookEndpoint> {
    const attributes = writableAttributes(options);
    if (Object.keys(attributes).length === 0) {
      throw new Error("update() needs at least one field to change: url, events or active.");
    }

    const document: UpdateRequest = {
      data: { type: "webhook-endpoints", id: webhookEndpointId, attributes },
    };

    const response = await this.client.request(
      new Request(
        `${this.client.baseUrl}/v1/webhook-endpoints/${encodeURIComponent(
          webhookEndpointIdParam(webhookEndpointId),
        )}`,
        { method: "PATCH", headers: jsonApiHeaders(), body: JSON.stringify(document) },
      ),
    );

    return webhookEndpointFromResource(dataObject(await response.json()));
  }

  /**
   * Remove a webhook endpoint. The fan-out stops at once.
   *
   * **The delivery history survives** — "why did our integration stop hearing
   * about faxes?" is answered by the deliveries of the endpoint somebody
   * removed, so `webhookDeliveries.list()` still finds them afterwards.
   *
   * Needs `webhooks:write`. A `fax:write` token reaches only a
   * **fax-account-scoped** endpoint; a customer- or tenant-scoped one answers
   * 404 to it.
   */
  async delete(webhookEndpointId: string): Promise<void> {
    await transportOf(this.client)["/v1/webhook-endpoints/{webhookEndpoint}"].DELETE({
      params: { path: { webhookEndpoint: webhookEndpointIdParam(webhookEndpointId) } },
    });
  }

  /**
   * Mint a new signing secret — and START A 24-HOUR CLOCK.
   *
   * A verb rather than a PATCH, because it creates a credential. The returned
   * `WebhookEndpoint.secret` is the NEW secret, readable here and nowhere
   * else, and `secretPreviousExpiresAt` is the deadline of the grace window:
   * until then the PREVIOUS secret goes on signing too, a delivery's
   * signature header carries two `v1` values (newest first), and
   * `verifyWebhook()` accepts either. So a rotation costs you no deliveries
   * as long as your own copy is rolled before that deadline.
   *
   * Needs `webhooks:write`. A `fax:write` token may rotate only a
   * **fax-account-scoped** endpoint's secret; a customer- or tenant-scoped
   * one answers 404 to it.
   */
  async rotateSecret(webhookEndpointId: string): Promise<WebhookEndpoint> {
    const { data } = await transportOf(this.client)[
      "/v1/webhook-endpoints/{webhookEndpoint}/rotate-secret"
    ].POST({
      params: { path: { webhookEndpoint: webhookEndpointIdParam(webhookEndpointId) } },
    });

    return webhookEndpointFromResource(dataObject(data));
  }
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so `/`
 * is already `%2F` by the time the URL is built and this function does not
 * escape it a second time. What it adds is the REFUSAL: an empty id would
 * otherwise collapse `/v1/webhook-endpoints/{webhookEndpoint}/rotate-secret`
 * into `/v1/webhook-endpoints//rotate-secret`, which is a different request
 * nobody asked for.
 *
 * Why the escaping matters at all: an id is whatever the caller's own system
 * handed them, and an unescaped `../faxes/secret` normalises ON THE WIRE to
 * `/v1/faxes/secret` — a different endpoint, read with this client's token.
 * webhookEndpoints.test.ts asserts the escaped path rather than trusting the
 * library to keep doing it, and `update()`'s hand-built URL escapes it itself
 * because it never reaches openapi-fetch.
 */
function webhookEndpointIdParam(value: string): string {
  if (!value) {
    throw new Error("a webhook endpoint id is required");
  }
  return value;
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}

/**
 * The `Accept` and `Content-Type` both webhook-endpoint writes send.
 *
 * `application/vnd.api+json` on BOTH, and the request half is the one that
 * matters: a JSON:API resource route answers 415 to `application/json`, which
 * is what a body sent with no explicit type gets.
 */
function jsonApiHeaders(): Headers {
  return new Headers({ Accept: JSONAPI_MEDIA_TYPE, "Content-Type": JSONAPI_MEDIA_TYPE });
}

/**
 * The event list as the document carries it — a copy, never the caller's own
 * array.
 *
 * Copied because the caller's array is theirs: nothing here should hold a
 * reference a caller can change after the call. Cast because this package's
 * own option is a list of `string` while the spec's is an enum, for the
 * reason `ListWebhookEndpointsOptions.scopeType` is widened: an event name
 * the platform publishes tomorrow must be subscribable today, without waiting
 * for a regenerate and a release. A name this platform does not publish is a
 * 422, which is the server's answer to give rather than a compile error six
 * months out of date.
 *
 * `NonNullable` rather than the member's own type, because one helper serves
 * both arms and the two differ: `events` is required and non-nullable on the
 * create attributes and optional on the update ones. The array both accept is
 * what this returns.
 */
function eventList(
  events: readonly [string, ...string[]],
): NonNullable<CreateAttributes["events"]> {
  return [...events] as NonNullable<CreateAttributes["events"]>;
}

/**
 * The attributes the caller actually named.
 *
 * `undefined` is dropped, and so is a `null` on `events`. That second half is
 * what changed: `null` used to be a VALUE on that member — "every event in
 * scope" — and the platform answers 422 to it now, so the key is left out and
 * a PATCH that named nothing else is refused by `update()`'s own empty-change
 * guard rather than spending a round trip on the refusal. The option type
 * already stops a TypeScript caller from spelling it; the `!= null` below is
 * what an untyped one meets.
 *
 * The members are separated HERE rather than left to `JSON.stringify` — which
 * also drops `undefined` — because `update()` has to COUNT what was named in
 * order to refuse an empty change, and a count taken after serialisation is a
 * count of a string.
 */
function writableAttributes(options: UpdateWebhookEndpointOptions): UpdateAttributes {
  const attributes: UpdateAttributes = {};

  if (options.url !== undefined) {
    attributes.url = options.url;
  }
  if (options.events != null) {
    attributes.events = eventList(options.events);
  }
  if (options.active !== undefined) {
    attributes.active = options.active;
  }

  return attributes;
}
