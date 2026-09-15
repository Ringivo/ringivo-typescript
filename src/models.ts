/**
 * What this client hands back: frozen, camelCased, and ours.
 *
 * Nothing generated ever crosses the public boundary. The types under
 * `src/_generated` are regenerated wholesale from the spec, so a caller who
 * held one would be holding a type whose members, names and nullability can
 * change with a tool upgrade they never asked for. The interfaces here
 * change only when this package decides they do.
 *
 * They are FROZEN — `Object.freeze`, not only `readonly` — because a fax is
 * a record of something that already happened, and because `readonly` is
 * erased at compile time: it stops TypeScript, it does not stop JavaScript.
 * Assigning to one would look like it changed the fax and would change
 * nothing at all, so it throws in strict mode instead.
 *
 * Every model keeps the JSON object it was built from in `raw`. A member the
 * API adds after this release still reaches the caller through it, so a new
 * server field never has to wait for a new SDK.
 *
 * -- WHY `null` AND NOT `undefined` -----------------------------------------
 * A member the API did not carry reads `null`, never `undefined`. One
 * spelling for "absent" means `fax.completedAt === null` is the whole check;
 * two spellings mean every caller has to remember which one this SDK picked
 * for which field. `undefined` is kept for the other direction — an OPTION
 * the caller did not pass.
 */

/** The JSON object a model was built from, exactly as it arrived. */
export type RawJson = Readonly<Record<string, unknown>>;

/**
 * One of a fax's documents, described but never reachable from here.
 *
 * No object key and no URL is published on a fax. The bytes are reached only
 * through `client.faxes.media()`, which mints a short-lived link and records
 * who asked.
 */
export interface FaxDocument {
  readonly kind: string | null;
  readonly ordinal: number | null;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly pages: number | null;
  readonly raw: RawJson;
}

/**
 * One fax, inbound or outbound.
 *
 * `from` is spelled plainly: it is a reserved word in JavaScript but a legal
 * property name, so the trailing underscore the Python client carries is not
 * needed here. Every other name is the API's own attribute name.
 *
 * Two builders fill this in, and they do not fill in the same amount. A fax
 * read with `faxes.get()` or `faxes.list()` is complete. A fax returned by
 * `faxes.send()` or `faxes.cancel()` is the flat acknowledgement those
 * endpoints answer — the members it does not carry are `null`, and
 * `faxes.get()` is where the rest lives.
 */
export interface Fax {
  readonly id: string;
  readonly status: string | null;
  readonly direction: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly failureCode: string | null;
  readonly pagesTotal: number | null;
  readonly pagesTransferred: number | null;
  readonly partial: boolean | null;
  readonly attemptCount: number | null;
  readonly resolution: string | null;
  readonly clientReference: string | null;
  readonly coverPage: RawJson | null;
  readonly read: boolean | null;
  readonly archived: boolean | null;
  readonly tags: RawJson | null;
  readonly documents: readonly FaxDocument[];
  readonly createdAt: Date | null;
  readonly completedAt: Date | null;
  /**
   * `true` when the server said this response replays an earlier send — the
   * only thing that tells the two apart, because the body is the same fax
   * either way. `null` on a fax that was read rather than sent.
   */
  readonly idempotentReplay: boolean | null;
  readonly raw: RawJson;
}

/**
 * One page of `faxes.list()`, newest first.
 *
 * `nextCursor` is the server's own cursor, lifted out of `meta.page` —
 * never one this client built. The cursor encodes the row AND the direction,
 * and its meaning belongs to the server; pass it straight back as `after`
 * to read the following page. It is `null` on the last page.
 */
export interface FaxPage {
  readonly faxes: readonly Fax[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/**
 * A short-lived capability, plus the facts about what is behind it.
 *
 * Every call mints a fresh one and writes an audit entry naming who asked,
 * so do not cache it past `expiresAt` or pass it on: anyone holding this URL
 * reads that document with no further authorization.
 */
export interface MediaLink {
  readonly url: string;
  readonly expiresAt: Date | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly raw: RawJson;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(source: RawJson, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function integer(source: RawJson, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function boolean(source: RawJson, key: string): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * A list of strings off one attribute, or null.
 *
 * Null for an ABSENT member and for an explicit `null`, like every other
 * reader here — the two are told apart in `raw`. A non-string item is dropped
 * rather than passed on: the list is handed to callers as `readonly string[]`,
 * and one stray number in it would be a value no caller's type admits.
 */
function textList(source: RawJson, key: string): readonly string[] | null {
  const value = source[key];
  if (!Array.isArray(value)) {
    return null;
  }
  return Object.freeze(value.filter((item): item is string => typeof item === "string"));
}

function nested(source: RawJson, key: string): RawJson | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

/**
 * The id inside a to-one relationship's linkage, or null.
 *
 * THE LINKAGE IS OPTIONAL IN THE DOCUMENT, so null here does not mean the
 * resource has no such relation. JSON:API lets a server answer a
 * relationship with `links` alone and no `data` member at all, and this
 * API's own schema marks the member optional. So null reads "the server did
 * not send the linkage on this response", never "there is no customer" —
 * and `raw` still carries whatever did arrive.
 */
function relationshipId(resource: RawJson, name: string): string | null {
  const relationships = nested(resource, "relationships");
  const relation = relationships ? nested(relationships, name) : null;
  const data = relation ? nested(relation, "data") : null;
  return data ? text(data, "id") : null;
}

/**
 * An ISO-8601 instant as the API writes it, or null.
 *
 * The API writes both `...T11:02:31.000000Z` and `...T11:02:31+00:00`, and
 * `new Date(string)` reads both. An unparseable value yields null instead of
 * an Invalid Date: a `Date` whose every method answers NaN is a value that
 * fails somewhere far from here, and the original string is still in `raw`.
 */
function instant(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Build from a JSON:API resource object — `faxes.get()`/`list()`. */
export function faxFromResource(resource: RawJson): Fax {
  const attributes = nested(resource, "attributes") ?? {};
  const documents = attributes.documents;

  return Object.freeze({
    id: text(resource, "id") ?? "",
    status: text(attributes, "status"),
    direction: text(attributes, "direction"),
    from: text(attributes, "from"),
    to: text(attributes, "to"),
    failureCode: text(attributes, "failureCode"),
    pagesTotal: integer(attributes, "pagesTotal"),
    pagesTransferred: integer(attributes, "pagesTransferred"),
    partial: boolean(attributes, "partial"),
    attemptCount: integer(attributes, "attemptCount"),
    resolution: text(attributes, "resolution"),
    clientReference: text(attributes, "clientReference"),
    coverPage: nested(attributes, "coverPage"),
    read: boolean(attributes, "read"),
    archived: boolean(attributes, "archived"),
    tags: nested(attributes, "tags"),
    documents: Object.freeze(
      (Array.isArray(documents) ? documents : []).filter(isRecord).map(faxDocumentFromJson),
    ),
    createdAt: instant(attributes.createdAt),
    completedAt: instant(attributes.completedAt),
    idempotentReplay: null,
    raw: resource,
  });
}

/**
 * Build from the flat `data` object `send` and `cancel` answer.
 *
 * Their bodies are snake_cased plain JSON, not JSON:API documents — which is
 * why this is a second builder rather than a flag on the first one.
 */
export function faxFromAcknowledgement(
  payload: RawJson,
  options: { idempotentReplay?: boolean } = {},
): Fax {
  return Object.freeze({
    id: text(payload, "id") ?? "",
    status: text(payload, "status"),
    direction: text(payload, "direction"),
    from: text(payload, "from"),
    to: text(payload, "to"),
    failureCode: null,
    pagesTotal: null,
    pagesTransferred: null,
    partial: null,
    attemptCount: null,
    resolution: null,
    clientReference: text(payload, "client_reference"),
    coverPage: null,
    read: null,
    archived: null,
    tags: null,
    documents: Object.freeze([]),
    createdAt: instant(payload.created_at),
    completedAt: null,
    idempotentReplay: options.idempotentReplay ?? null,
    raw: payload,
  });
}

export function faxDocumentFromJson(source: RawJson): FaxDocument {
  return Object.freeze({
    kind: text(source, "kind"),
    ordinal: integer(source, "ordinal"),
    contentType: text(source, "contentType"),
    byteSize: integer(source, "byteSize"),
    sha256: text(source, "sha256"),
    pages: integer(source, "pages"),
    raw: source,
  });
}

export function mediaLinkFromJson(payload: RawJson): MediaLink {
  return Object.freeze({
    url: text(payload, "url") ?? "",
    expiresAt: instant(payload.expires_at),
    byteSize: integer(payload, "byte_size"),
    sha256: text(payload, "sha256"),
    raw: payload,
  });
}

/**
 * One fax account: a customer's container for numbers, faxes and settings.
 *
 * `retentionDays` and `retentionPages` are the two prune rules, and **null
 * means the rule is OFF** — the pages are kept for ever, or without a count
 * limit. The API writes `null` for that, so null is the honest reading of
 * it; it is also what you get if a server stops sending the member at all,
 * and `raw` is where the two can be told apart.
 *
 * `customerId` is the customer this account belongs to, when the server
 * sends the relationship linkage. An account is never moved between
 * customers: every fax it holds carries the customer it was sent or
 * received for.
 */
export interface FaxAccount {
  readonly id: string;
  readonly name: string | null;
  readonly headerText: string | null;
  readonly defaultFromE164: string | null;
  readonly retentionDays: number | null;
  readonly retentionPages: number | null;
  readonly status: string | null;
  readonly customerId: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly raw: RawJson;
}

/**
 * One page of `faxAccounts.list()`, newest first.
 *
 * `nextCursor` is the server's own cursor, lifted out of `meta.page` —
 * never one this client built — and it is null on the last page. `nextUrl`
 * mirrors `links.next`, which is absent rather than null at the end.
 */
export interface FaxAccountPage {
  readonly accounts: readonly FaxAccount[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/**
 * One number routed to a fax account.
 *
 * It is a `phone-numbers` resource — the routing API's own object, read
 * here through the account it points at. This model carries the members a
 * fax integration needs and leaves the rest in `raw`, which is where a
 * number's messaging and voice blocks stay.
 */
export interface FaxAccountNumber {
  readonly id: string;
  readonly e164: string | null;
  readonly status: string | null;
  readonly country: string | null;
  readonly activatedAt: Date | null;
  readonly createdAt: Date | null;
  readonly raw: RawJson;
}

/**
 * One grant: this person may read this fax account's faxes.
 *
 * A grant is a pair of foreign keys and a fact — it exists or it does not.
 * There is nothing on it to change, which is why the API publishes no
 * update route and this package no `update()`.
 *
 * It is NOT what lets somebody administer the account. Administering one is
 * permission-gated on the person's role; reading its CONTENT is gated on a
 * grant. So the two answer different questions, and a manager who can
 * rename an account may hold no grant on it at all.
 *
 * `userEmail` is the whole reason a grant list is worth reading: the
 * question is "who can see this?", and a page of ids answers nothing.
 *
 * `faxAccountId` and `userId` come from the relationship linkages, so both
 * read null when the server answered a relationship with `links` alone —
 * which is legal JSON:API and says nothing about the grant. `raw` still
 * carries whatever did arrive.
 */
export interface FaxAccountUser {
  readonly id: string;
  readonly userEmail: string | null;
  readonly faxAccountId: string | null;
  readonly userId: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly raw: RawJson;
}

/**
 * One page of `faxAccountUsers.list()`, newest first.
 *
 * The rows are called `grants` rather than `users`, because that is what
 * they are: `grants[0].userId` is the person and `grants[0].id` is the
 * grant, and naming the page after the person would make those two look
 * like the same id.
 *
 * `nextCursor` is the server's own cursor, lifted out of `meta.page` —
 * never one this client built — and it is null on the last page. `nextUrl`
 * mirrors `links.next`, which is absent rather than null at the end.
 */
export interface FaxAccountUserPage {
  readonly grants: readonly FaxAccountUser[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/** Build from a JSON:API resource object — every fax-account call. */
export function faxAccountFromResource(resource: RawJson): FaxAccount {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    name: text(attributes, "name"),
    headerText: text(attributes, "headerText"),
    defaultFromE164: text(attributes, "defaultFromE164"),
    retentionDays: integer(attributes, "retentionDays"),
    retentionPages: integer(attributes, "retentionPages"),
    status: text(attributes, "status"),
    customerId: relationshipId(resource, "customer"),
    createdAt: instant(attributes.createdAt),
    updatedAt: instant(attributes.updatedAt),
    raw: resource,
  });
}

/** Build from a `phone-numbers` resource object — `faxAccounts.numbers()`. */
export function faxAccountNumberFromResource(resource: RawJson): FaxAccountNumber {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    e164: text(attributes, "e164"),
    status: text(attributes, "status"),
    country: text(attributes, "country"),
    activatedAt: instant(attributes.activatedAt),
    createdAt: instant(attributes.createdAt),
    raw: resource,
  });
}

export function faxAccountPageFromDocument(document: RawJson): FaxAccountPage {
  const data = document.data;
  const accounts = (Array.isArray(data) ? data : []).filter(isRecord).map(faxAccountFromResource);

  return Object.freeze({
    accounts: Object.freeze(accounts),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/** The `phone-numbers` resources in one page of the numbers relationship. */
export function faxAccountNumbersFromDocument(document: RawJson): readonly FaxAccountNumber[] {
  const data = document.data;
  return (Array.isArray(data) ? data : []).filter(isRecord).map(faxAccountNumberFromResource);
}

/** Build from a JSON:API resource object — every fax-account-user call. */
export function faxAccountUserFromResource(resource: RawJson): FaxAccountUser {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    userEmail: text(attributes, "userEmail"),
    faxAccountId: relationshipId(resource, "faxAccount"),
    userId: relationshipId(resource, "user"),
    createdAt: instant(attributes.createdAt),
    updatedAt: instant(attributes.updatedAt),
    raw: resource,
  });
}

export function faxAccountUserPageFromDocument(document: RawJson): FaxAccountUserPage {
  const data = document.data;
  const grants = (Array.isArray(data) ? data : []).filter(isRecord).map(faxAccountUserFromResource);

  return Object.freeze({
    grants: Object.freeze(grants),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/**
 * `meta.page.nextCursor` off any collection document.
 *
 * Exported for `faxAccounts.numbers()`, which walks the numbers collection
 * itself rather than handing back a page object — the cursor reader is the
 * same one every other page uses, and there is no second copy of it.
 */
export function nextCursorOfDocument(document: RawJson): string | null {
  return nextCursorOf(document);
}

export function faxPageFromDocument(document: RawJson): FaxPage {
  const data = document.data;
  const faxes = (Array.isArray(data) ? data : []).filter(isRecord).map(faxFromResource);

  return Object.freeze({
    faxes: Object.freeze(faxes),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/**
 * One webhook endpoint: where we POST, what it hears about, and its switch.
 *
 * `secret` IS THE SIGNING SECRET, and it is non-null in exactly two places:
 * the `webhookEndpoints.create()` that registered the endpoint and the
 * `rotateSecret()` that minted a new one. Every other read is `null` —
 * the platform keeps no readable copy, so that null is an honest statement
 * and not a missing field. Store it when you first see it.
 *
 * `events` is the list the endpoint asked for, published back verbatim, and it
 * names at least one type: the platform requires a non-empty list on
 * registration and on every change. **`null` here is a response that carried
 * no list** — a sparse fieldset, say — rather than an endpoint that hears
 * about everything, which is what it used to mean.
 *
 * `secretPreviousExpiresAt` is the deadline of a rotation's 24-hour grace
 * window: until then the PREVIOUS secret still signs, and a delivery carries
 * two signatures. It is null outside a rotation.
 *
 * `scopeType` and `scopeId` say what the endpoint hears about and never
 * change: the delivery history is the record of what THAT scope was told.
 */
export interface WebhookEndpoint {
  readonly id: string;
  readonly scopeType: string | null;
  readonly scopeId: string | null;
  readonly url: string | null;
  readonly events: readonly string[] | null;
  readonly active: boolean | null;
  readonly secret: string | null;
  readonly secretPreviousExpiresAt: Date | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly raw: RawJson;
}

/**
 * One page of `webhookEndpoints.list()`, newest first.
 *
 * `nextCursor` is the server's own cursor, lifted out of `meta.page` — never
 * one this client built — and it is null on the last page. `nextUrl` mirrors
 * `links.next`, which is absent rather than null at the end.
 */
export interface WebhookEndpointPage {
  readonly endpoints: readonly WebhookEndpoint[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/**
 * One failed delivery attempt — evidence, not a history.
 *
 * A delivery that lands leaves no row at all, so every object here is
 * something still owed to you (`status: "pending"`, still on the retry
 * ladder) or something given up on (`status: "dead"`). There is no
 * `delivered`.
 *
 * There is deliberately no `deliveredAt` on this model. The API still
 * publishes the attribute so that a client generated against an older spec
 * goes on parsing, and it is ALWAYS null — nothing sets it any more. A member
 * that can only ever be null is a member a caller would read as a status and
 * be wrong about, so it stays in `raw` and out of here; `status` is the
 * status.
 *
 * `endpointId` comes from the `endpoint` relationship's linkage, and it is
 * null when the server answered that relationship with `links` alone — which
 * is legal and says nothing about the endpoint.
 *
 * `payloadSha256` is the digest of the exact bytes we signed; the body itself
 * is never published here. `statusCode` is what your server answered, null
 * when we never reached it, and `error` is why we could not.
 */
export interface WebhookDelivery {
  readonly id: string;
  readonly endpointId: string | null;
  readonly eventId: string | null;
  readonly eventType: string | null;
  readonly payloadSha256: string | null;
  readonly status: string | null;
  readonly attemptNo: number | null;
  readonly statusCode: number | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly nextAttemptAt: Date | null;
  readonly deadAt: Date | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly raw: RawJson;
}

/** One page of `webhookDeliveries.list()`, newest first. */
export interface WebhookDeliveryPage {
  readonly deliveries: readonly WebhookDelivery[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/** Build from a JSON:API resource object — every webhook-endpoint call. */
export function webhookEndpointFromResource(resource: RawJson): WebhookEndpoint {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    scopeType: text(attributes, "scopeType"),
    scopeId: text(attributes, "scopeId"),
    url: text(attributes, "url"),
    events: textList(attributes, "events"),
    active: boolean(attributes, "active"),
    secret: text(attributes, "secret"),
    secretPreviousExpiresAt: instant(attributes.secretPreviousExpiresAt),
    createdAt: instant(attributes.createdAt),
    updatedAt: instant(attributes.updatedAt),
    raw: resource,
  });
}

export function webhookEndpointPageFromDocument(document: RawJson): WebhookEndpointPage {
  const data = document.data;
  const endpoints = (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .map(webhookEndpointFromResource);

  return Object.freeze({
    endpoints: Object.freeze(endpoints),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/** Build from a JSON:API resource object — every webhook-delivery call. */
export function webhookDeliveryFromResource(resource: RawJson): WebhookDelivery {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    endpointId: relationshipId(resource, "endpoint"),
    eventId: text(attributes, "eventId"),
    eventType: text(attributes, "eventType"),
    payloadSha256: text(attributes, "payloadSha256"),
    status: text(attributes, "status"),
    attemptNo: integer(attributes, "attemptNo"),
    statusCode: integer(attributes, "statusCode"),
    durationMs: integer(attributes, "durationMs"),
    error: text(attributes, "error"),
    nextAttemptAt: instant(attributes.nextAttemptAt),
    deadAt: instant(attributes.deadAt),
    createdAt: instant(attributes.createdAt),
    updatedAt: instant(attributes.updatedAt),
    raw: resource,
  });
}

export function webhookDeliveryPageFromDocument(document: RawJson): WebhookDeliveryPage {
  const data = document.data;
  const deliveries = (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .map(webhookDeliveryFromResource);

  return Object.freeze({
    deliveries: Object.freeze(deliveries),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/**
 * `links.next`, present on every page but the last — on the final page the
 * key is ABSENT from the document altogether, never present-and-null. Both
 * are read as "no next", because a client that trusted only the documented
 * shape would still choke on the other one showing up.
 */
function nextLink(document: RawJson): string | null {
  const links = nested(document, "links");
  if (!links) {
    return null;
  }

  const following = links.next;
  return typeof following === "string" && following !== "" ? following : null;
}

/**
 * `meta.page.nextCursor` — the server's own cursor, never one this client
 * builds. `null` on the final page and present on every page otherwise, so
 * this one member answers "is there more?" everywhere, unlike `links.next`
 * which is simply missing at the end.
 */
function nextCursorOf(document: RawJson): string | null {
  const meta = nested(document, "meta");
  const page = meta ? nested(meta, "page") : null;
  if (!page) {
    return null;
  }

  const cursor = page.nextCursor;
  return typeof cursor === "string" ? cursor : null;
}
