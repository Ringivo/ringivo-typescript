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
 * The ids inside a to-many relationship's linkage, or null.
 *
 * The same rule as `relationshipId` above, for the plural case: null reads
 * "the server did not send the linkage", never "there are none" — and an
 * EMPTY ARRAY is the answer that does mean none, so the two stay apart. A
 * member of the array with no `id` is dropped rather than passed on as an
 * empty string, because the list is handed to callers as `readonly string[]`.
 */
function relationshipIds(resource: RawJson, name: string): readonly string[] | null {
  const relationships = nested(resource, "relationships");
  const relation = relationships ? nested(relationships, name) : null;
  const data = relation ? relation.data : undefined;
  if (!Array.isArray(data)) {
    return null;
  }

  return Object.freeze(
    data
      .filter(isRecord)
      .map((identifier) => text(identifier, "id"))
      .filter((id): id is string => id !== null),
  );
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
 * One subscriber on a customer's phone system — a person or a machine.
 *
 * -- `kind` SAYS WHAT THIS ROW IS -------------------------------------------
 * A phone system holds people AND machines: auto attendants, call queues, AI
 * agents, the domain's settings template. `kind` is `user` for a person, and
 * otherwise one of `auto_attendant`, `call_queue`, `ai_agent`, `conference`,
 * `department`, `site`, `ring_group`, `trunk`, `time_of_day`, `domain` or
 * `system`. `system` is any machine the platform has no word for yet — an
 * unknown marker is never read as `user`. It is a `string`, WIDE ON PURPOSE
 * like `CallRecord.direction`: a word the API adds later arrives as itself.
 * Read a word you do not know as `system`.
 *
 * For a click-to-call picker, list with `{ kind: "user", hasDevices: true }`:
 * a subscriber with no device cannot place a call.
 *
 * -- WHY THE TIMESTAMPS HERE ARE STRINGS ------------------------------------
 * `createdAt` and `updatedAt` are `string`, not `Date`, and they are the only
 * two in this package that are. They come straight out of the phone system,
 * which has never published the format it writes them in, so the API serves
 * them UNPARSED and this client hands them on the same way. A mis-parse would
 * be silent — a date a year out reads exactly like a date that is right — and
 * a string a caller can see is better than a `Date` they cannot check. Parse
 * them yourself if you know your switch's format.
 *
 * `presence` is the phone system's own word, verbatim. There is deliberately
 * no derived `online` flag: the vocabulary is longer than two states, and
 * which of its words mean "available" is your decision rather than ours.
 *
 * `customerId` and `deviceIds` come from the relationship linkages, so both
 * read null when the server answered a relationship with `links` alone. An
 * EMPTY `deviceIds` array is different: it means this subscriber has no
 * registration at all.
 */
export interface PbxSubscriber {
  readonly id: string;
  /** The extension. */
  readonly user: string | null;
  readonly domain: string | null;
  readonly displayName: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  /** The phone system's own permission tier for this person. */
  readonly scope: string | null;
  readonly group: string | null;
  readonly site: string | null;
  readonly presence: string | null;
  readonly callerIdNumber: string | null;
  readonly callerIdName: string | null;
  readonly timeZone: string | null;
  /** As the phone system stores it — TEXT, not RFC 3339. See above. */
  readonly createdAt: string | null;
  /** As the phone system stores it — TEXT, not RFC 3339. See above. */
  readonly updatedAt: string | null;
  /** What this subscriber is — `user` for a person. See above. */
  readonly kind: string | null;
  readonly customerId: string | null;
  readonly deviceIds: readonly string[] | null;
  readonly raw: RawJson;
}

/**
 * One page of `pbx.subscribers.list()`, by extension.
 *
 * `nextCursor` is the server's own cursor, lifted out of `meta.page` — never
 * one this client built — and it is null on the last page. `nextUrl` mirrors
 * `links.next`, which is absent rather than null at the end.
 */
export interface PbxSubscriberPage {
  readonly subscribers: readonly PbxSubscriber[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/**
 * One REGISTRATION, not one handset.
 *
 * The row exists because something sent a SIP REGISTER, and it disappears
 * when nothing does. So a phone that is unplugged leaves no device here, and
 * a phone that registered twice leaves two.
 *
 * `registered` is derived by the server — is `registrationExpiresAt` still in
 * the future? — which is why it is worth reading rather than recomputing:
 * the three timestamps on this model are the phone system's own TEXT and
 * carry no zone, exactly as on `PbxSubscriber`.
 *
 * `subscriberId` is the `pbx.subscribers` resource this registration belongs
 * to, off the `subscriber` relationship. `user` beside it is the extension.
 */
export interface PbxDevice {
  readonly id: string;
  /** The address of record that registered. */
  readonly aor: string | null;
  /** The subscriber's extension. */
  readonly user: string | null;
  readonly domain: string | null;
  readonly mode: string | null;
  /** What the phone said it is. */
  readonly userAgent: string | null;
  readonly contact: string | null;
  readonly transport: string | null;
  /** The address the registration arrived from. */
  readonly receivedFrom: string | null;
  /** As the phone system stores it — TEXT, not RFC 3339. */
  readonly registeredAt: string | null;
  /** As the phone system stores it — TEXT, not RFC 3339. */
  readonly registrationExpiresAt: string | null;
  /** Derived by the server: has the registration not expired? */
  readonly registered: boolean | null;
  readonly autoAnswer: boolean | null;
  /** As the phone system stores it — TEXT, not RFC 3339. */
  readonly createdAt: string | null;
  readonly customerId: string | null;
  readonly subscriberId: string | null;
  readonly raw: RawJson;
}

/** One page of `pbx.devices.list()`, by address of record. */
export interface PbxDevicePage {
  readonly devices: readonly PbxDevice[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/**
 * One call, as the phone system recorded it.
 *
 * **0.11.0 rebuilt this model to the API's one clean camelCase shape.**
 * `vendorType`, `fromUser`, `fromUri`, `toUser`, `toUri`, `dialed`, `byUser`,
 * `termUser`, `tag`, `duration` and `talkTime` are gone; reach for the
 * extended tier below for the raw values they carried.
 *
 * -- TWO TIERS ---------------------------------------------------------------
 * Everything from `direction` through `hidden` is the STANDARD set and is on
 * every response. `vendorId` onward through `rawRequestUser` is the EXTENDED
 * tier — the phone system's own raw values — and each is null unless you
 * named it in `fields` on `list()`. A sparse fieldset NARROWS rather than
 * adds, so naming one extended field without the standard ones you want
 * leaves the rest of this object null too.
 *
 * -- THE THREE INSTANTS ARE REAL DATES --------------------------------------
 * Unlike `PbxSubscriber` and `PbxDevice`, whose timestamps are the switch's
 * own text, `startedAt`, `answeredAt` and `releasedAt` are RFC 3339 in UTC:
 * the switch stores them as Unix epochs. `answeredAt` is null when nobody
 * answered.
 *
 * -- direction AND disposition ARE WIDE ON PURPOSE --------------------------
 * The switch records ONE integer carrying which way the call went and whether
 * anybody answered. `direction` is `inbound`, `outbound` or `internal` (a
 * call that stayed inside one domain); `disposition` is `answered` or
 * `missed`. An integer this API has no word for is served as its own digits
 * in `direction` rather than as null, so these are `string`: compare against
 * the words you know and treat anything else as unrecognised.
 *
 * -- A `*Number` FIELD IS E.164 OR NOTHING -----------------------------------
 * `fromNumber`, `toNumber` and `dialedNumber` carry `+14075550101` or null —
 * never an extension, a dial code or a star code. An extension is in
 * `fromExtension`, `routedByExtension` or `answeringExtension` instead.
 *
 * `hasRecording` says a recording is HELD for this call; it is not itself
 * the audio. Fetch the call's captures with
 * `pbx.callRecords.recordings(record.id)`, and a transcript the same way
 * from `pbx.callRecords.transcripts(record.id)`.
 *
 * `fromSubscriberId` and `toSubscriberId` are the `pbx.subscribers`
 * resources on the two legs, off the `fromSubscriber` and `toSubscriber`
 * relationships. Null when a leg has no subscriber — an outside caller — and
 * also null when the server answered the relationship with `links` alone.
 */
export interface CallRecord {
  readonly id: string;
  readonly direction: string | null;
  readonly disposition: string | null;
  readonly tenantId: string | null;
  readonly domain: string | null;
  readonly territory: string | null;
  readonly fromNumber: string | null;
  readonly fromExtension: string | null;
  readonly fromName: string | null;
  readonly toNumber: string | null;
  readonly dialedNumber: string | null;
  readonly routedByExtension: string | null;
  readonly answeringExtension: string | null;
  readonly startedAt: Date | null;
  /** Null when nobody answered. */
  readonly answeredAt: Date | null;
  readonly releasedAt: Date | null;
  /** Seconds, end to end. */
  readonly durationSeconds: number | null;
  /** Seconds anybody was actually talking. */
  readonly talkSeconds: number | null;
  readonly releaseCode: string | null;
  readonly releaseText: string | null;
  readonly hasRecording: boolean | null;
  /** Does the phone system hide this record from its own call log? */
  readonly hidden: boolean | null;
  // -- EXTENDED: served only when named in `fields` on list() ---------------
  readonly vendorId: string | null;
  readonly origCallId: string | null;
  readonly termCallId: string | null;
  readonly byAction: string | null;
  readonly terminatedTo: string | null;
  readonly codec: string | null;
  readonly hostname: string | null;
  readonly rawFromUri: string | null;
  readonly rawFromUser: string | null;
  readonly rawToUser: string | null;
  readonly rawRequestUser: string | null;
  readonly customerId: string | null;
  readonly fromSubscriberId: string | null;
  readonly toSubscriberId: string | null;
  readonly raw: RawJson;
}

/** One page of `pbx.callRecords.list()`, newest first. */
export interface CallRecordPage {
  readonly callRecords: readonly CallRecord[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/**
 * One capture of a call, from `pbx.callRecords.recordings()`.
 *
 * **There is no page here, on purpose.** `recordings()` answers every
 * capture of ONE call — bounded by that call's own two legs, never a
 * growing table — so this package returns a plain `readonly Recording[]`
 * rather than a `...Page` with a cursor. The console's own schema calls
 * this out the same way: its collection document carries no `links` or
 * `meta.page` member to walk.
 *
 * `id` is derived from the phone system's own `(call id, capture id)`
 * pair, so it is stable across regions and a supersede reuses it rather
 * than minting a new one.
 *
 * `contentUrl` is a signed, time-limited link to the audio, freshly minted
 * on every call to `recordings()` — do not cache it past `expiresAt` or
 * hand it to anyone else; whoever holds the URL can fetch the audio with
 * no further authorization. `duration` is null when the phone system never
 * reported one for this capture, which is not the same as a missing
 * recording — `byteSize` still describes real bytes.
 *
 * `superseded` is false on a first capture and becomes true once a longer
 * capture of the same call replaced the audio behind this same `id` — the
 * id does not change, but `byteSize` and `sha256` do.
 */
export interface Recording {
  readonly id: string;
  readonly cccId: string | null;
  readonly duration: number | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly superseded: boolean | null;
  readonly contentUrl: string | null;
  readonly expiresAt: Date | null;
  readonly raw: RawJson;
}

/**
 * The transcript of one capture, from `pbx.callRecords.transcripts()`.
 *
 * **One item per RECORDING of the call, not one per transcript that
 * exists**: a capture with no words yet still appears here, with
 * `status: "pending"` and every other field null, so a caller can tell
 * "no transcript yet" from "no recording at all". There is a third state,
 * `failed`, but this collection never reports it — telling a permanent
 * failure from a wait costs a lookup this list does not pay; that
 * distinction belongs to the single-transcript endpoint, which this
 * client does not yet wrap.
 *
 * **No page here either**, for the same reason `Recording` has none: this
 * is the captures of one call, and the console's own transcript collection
 * document carries no `links` or `meta.page` to walk.
 *
 * `id` is the RECORDING's id, not a separate transcript id — a transcript
 * is keyed one-to-one by the capture it is of, so it is the same id
 * `recordings()` published for the same capture.
 *
 * `contentUrl` is a signed, time-limited link to the stored transcript
 * document (the speech-to-text provider's own response, not the audio) —
 * the same rule as `Recording.contentUrl`: do not cache it past
 * `expiresAt`. Every field but `id`, `cccId` and `status` is null while
 * `status` is `"pending"`.
 */
export interface Transcript {
  readonly id: string;
  readonly cccId: string | null;
  readonly status: string | null;
  readonly language: string | null;
  readonly duration: number | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly contentUrl: string | null;
  readonly expiresAt: Date | null;
  readonly raw: RawJson;
}

/**
 * A call this client ASKED FOR — the answer to `pbx.subscribers.call()`.
 *
 * It is an intent, not a call that happened. The server answers **202** the
 * moment it has accepted the request, so `status` is `requested` here and
 * nothing on this object says how the call went. That story is a
 * `CallRecord`, minutes later.
 *
 * **`id` is the id the request was placed under, and it finds that record.**
 * Pass it to `pbx.callRecords.list({ callId: call.id })`: the record appears
 * once the call has ended, and by default the list returns the visible
 * dial-out record — the hidden leg that rang the subscriber comes back only
 * with `includeHidden: true`. **The list's date range still applies:** with no
 * `startedAfter` or `startedBefore` only the current and the previous month
 * are read, so for an older call pass a range that covers when it was placed.
 * An empty page means the call has not ended yet, it was placed outside the
 * range, or the id names no call. It is never an error.
 * A `CallRecord`'s own id is computed from the vendor row it was read out of,
 * so it never equals this one.
 *
 * **There is no idempotency key on the way in.** Asking twice is two calls
 * to a real person, so a `PbxCall` you never received is not a request to
 * repeat blindly.
 *
 * **These values are what was SENT to the phone system, not what you typed.**
 * `callerId` is the clearest case: the platform stores caller IDs as E.164
 * without the plus and answers with the spelling the called party will see,
 * so a `+1…` you passed comes back as `1…`. It is null when the
 * subscriber's own caller ID was used.
 *
 * `device` is the `pbx.devices` id the call originates from, and null when
 * none was named — an ATTRIBUTE rather than a relationship, the same as it
 * is on the way in. `status` is `requested` and nothing else from this
 * endpoint.
 *
 * `requestedAt` is a real instant: the API declares it RFC 3339, unlike a
 * `PbxSubscriber`'s timestamps, which come from the phone system as unparsed text.
 */
export interface PbxCall {
  readonly id: string;
  readonly destination: string | null;
  readonly callerId: string | null;
  readonly autoAnswer: boolean | null;
  readonly device: string | null;
  readonly status: string | null;
  readonly requestedAt: Date | null;
  readonly raw: RawJson;
}

/** Build from a JSON:API resource object — every PBX-subscriber read. */
export function pbxSubscriberFromResource(resource: RawJson): PbxSubscriber {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    user: text(attributes, "user"),
    domain: text(attributes, "domain"),
    displayName: text(attributes, "displayName"),
    firstName: text(attributes, "firstName"),
    lastName: text(attributes, "lastName"),
    email: text(attributes, "email"),
    scope: text(attributes, "scope"),
    group: text(attributes, "group"),
    site: text(attributes, "site"),
    presence: text(attributes, "presence"),
    callerIdNumber: text(attributes, "callerIdNumber"),
    callerIdName: text(attributes, "callerIdName"),
    timeZone: text(attributes, "timeZone"),
    createdAt: text(attributes, "createdAt"),
    updatedAt: text(attributes, "updatedAt"),
    kind: text(attributes, "kind"),
    customerId: relationshipId(resource, "customer"),
    deviceIds: relationshipIds(resource, "devices"),
    raw: resource,
  });
}

export function pbxSubscriberPageFromDocument(document: RawJson): PbxSubscriberPage {
  const data = document.data;
  const subscribers = (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .map(pbxSubscriberFromResource);

  return Object.freeze({
    subscribers: Object.freeze(subscribers),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/** Build from a JSON:API resource object — every PBX-device call. */
export function pbxDeviceFromResource(resource: RawJson): PbxDevice {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    aor: text(attributes, "aor"),
    user: text(attributes, "user"),
    domain: text(attributes, "domain"),
    mode: text(attributes, "mode"),
    userAgent: text(attributes, "userAgent"),
    contact: text(attributes, "contact"),
    transport: text(attributes, "transport"),
    receivedFrom: text(attributes, "receivedFrom"),
    registeredAt: text(attributes, "registeredAt"),
    registrationExpiresAt: text(attributes, "registrationExpiresAt"),
    registered: boolean(attributes, "registered"),
    autoAnswer: boolean(attributes, "autoAnswer"),
    createdAt: text(attributes, "createdAt"),
    customerId: relationshipId(resource, "customer"),
    subscriberId: relationshipId(resource, "subscriber"),
    raw: resource,
  });
}

export function pbxDevicePageFromDocument(document: RawJson): PbxDevicePage {
  const data = document.data;
  const devices = (Array.isArray(data) ? data : []).filter(isRecord).map(pbxDeviceFromResource);

  return Object.freeze({
    devices: Object.freeze(devices),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/** Build from a JSON:API resource object — every call-record read. */
export function callRecordFromResource(resource: RawJson): CallRecord {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    direction: text(attributes, "direction"),
    disposition: text(attributes, "disposition"),
    tenantId: text(attributes, "tenantId"),
    domain: text(attributes, "domain"),
    territory: text(attributes, "territory"),
    fromNumber: text(attributes, "fromNumber"),
    fromExtension: text(attributes, "fromExtension"),
    fromName: text(attributes, "fromName"),
    toNumber: text(attributes, "toNumber"),
    dialedNumber: text(attributes, "dialedNumber"),
    routedByExtension: text(attributes, "routedByExtension"),
    answeringExtension: text(attributes, "answeringExtension"),
    startedAt: instant(attributes.startedAt),
    answeredAt: instant(attributes.answeredAt),
    releasedAt: instant(attributes.releasedAt),
    durationSeconds: integer(attributes, "durationSeconds"),
    talkSeconds: integer(attributes, "talkSeconds"),
    releaseCode: text(attributes, "releaseCode"),
    releaseText: text(attributes, "releaseText"),
    hasRecording: boolean(attributes, "hasRecording"),
    hidden: boolean(attributes, "hidden"),
    vendorId: text(attributes, "vendorId"),
    origCallId: text(attributes, "origCallId"),
    termCallId: text(attributes, "termCallId"),
    byAction: text(attributes, "byAction"),
    terminatedTo: text(attributes, "terminatedTo"),
    codec: text(attributes, "codec"),
    hostname: text(attributes, "hostname"),
    rawFromUri: text(attributes, "rawFromUri"),
    rawFromUser: text(attributes, "rawFromUser"),
    rawToUser: text(attributes, "rawToUser"),
    rawRequestUser: text(attributes, "rawRequestUser"),
    customerId: relationshipId(resource, "customer"),
    fromSubscriberId: relationshipId(resource, "fromSubscriber"),
    toSubscriberId: relationshipId(resource, "toSubscriber"),
    raw: resource,
  });
}

export function callRecordPageFromDocument(document: RawJson): CallRecordPage {
  const data = document.data;
  const callRecords = (Array.isArray(data) ? data : []).filter(isRecord).map(callRecordFromResource);

  return Object.freeze({
    callRecords: Object.freeze(callRecords),
    nextUrl: nextLink(document),
    nextCursor: nextCursorOf(document),
    raw: document,
  });
}

/**
 * Build from one `recordings` resource object.
 *
 * The attribute keys are KEBAB-CASE on the wire (`ccc-id`, `byte-size`,
 * `content-url`, `expires-at`) — this endpoint's own spelling, unlike the
 * camelCase of the other `/v1/pbx/` resources in this module.
 */
export function recordingFromResource(resource: RawJson): Recording {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    cccId: text(attributes, "ccc-id"),
    duration: integer(attributes, "duration"),
    byteSize: integer(attributes, "byte-size"),
    sha256: text(attributes, "sha256"),
    superseded: boolean(attributes, "superseded"),
    contentUrl: text(attributes, "content-url"),
    expiresAt: instant(attributes["expires-at"]),
    raw: resource,
  });
}

/** The `recordings` resources in one `pbx.callRecords.recordings()` document. */
export function recordingsFromDocument(document: RawJson): readonly Recording[] {
  const data = document.data;
  return Object.freeze(
    (Array.isArray(data) ? data : []).filter(isRecord).map(recordingFromResource),
  );
}

/**
 * Build from one `transcripts` resource object.
 *
 * KEBAB-CASE attribute keys, the same as `recordingFromResource` and for
 * the same reason: this is that endpoint's own spelling.
 */
export function transcriptFromResource(resource: RawJson): Transcript {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    cccId: text(attributes, "ccc-id"),
    status: text(attributes, "status"),
    language: text(attributes, "language"),
    duration: integer(attributes, "duration"),
    byteSize: integer(attributes, "byte-size"),
    sha256: text(attributes, "sha256"),
    provider: text(attributes, "provider"),
    model: text(attributes, "model"),
    contentUrl: text(attributes, "content-url"),
    expiresAt: instant(attributes["expires-at"]),
    raw: resource,
  });
}

/** The `transcripts` resources in one `pbx.callRecords.transcripts()` document. */
export function transcriptsFromDocument(document: RawJson): readonly Transcript[] {
  const data = document.data;
  return Object.freeze(
    (Array.isArray(data) ? data : []).filter(isRecord).map(transcriptFromResource),
  );
}

/** Build from the JSON:API resource the 202 carries — `pbx.subscribers.call()`. */
export function pbxCallFromResource(resource: RawJson): PbxCall {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    destination: text(attributes, "destination"),
    callerId: text(attributes, "callerId"),
    autoAnswer: boolean(attributes, "autoAnswer"),
    device: text(attributes, "device"),
    status: text(attributes, "status"),
    requestedAt: instant(attributes.requestedAt),
    raw: resource,
  });
}

/**
 * One of your customers: a business you sell to.
 *
 * `id` is what the other resources take as `customer` — the filter on
 * `client.pbx.callRecords.list()`, `pbx.subscribers.list()` and `pbx.devices.list()`,
 * and the owner named on a fax account.
 *
 * `code` is the short code the platform assigns: five lowercase letters and
 * digits, and it never changes. `dataResidencyCountry` is fixed when the
 * customer is created. `effectiveRegion` is what `regionPreference` resolves
 * to NOW — for `partner_default` that is your account's current default, so it
 * can change without anybody editing this customer.
 *
 * -- THE PHONE-SYSTEM FIELDS ARE NULL, NOT FALSE, WITHOUT ONE ---------------
 * `pbx` says whether the customer has a phone system. When it is `false`, the
 * five fields after it — `residential`, `callLimit`, `callLimitExternal`,
 * `transports` and `provisioningState` — are `null`: there is no setting to
 * report, and a `false` or a `0` would read as one.
 *
 * `transports` keeps the server's ORDER, which is data: the order the SIP
 * transports are offered in DNS, first preferred.
 *
 * `regionPreference`, `transports` and `provisioningState` are `string`s
 * rather than the spec's enums, for the reason `FaxAccount.status` is: a word
 * the server adds tomorrow must reach you today, without a new SDK.
 */
export interface Customer {
  readonly id: string;
  readonly name: string | null;
  readonly code: string | null;
  /** The service address's country, ISO 3166-1 alpha-2. */
  readonly country: string | null;
  /** The service address's street lines, as the address was validated. */
  readonly addressLines: readonly string[] | null;
  readonly city: string | null;
  /** The state or province. */
  readonly region: string | null;
  readonly postalCode: string | null;
  /** An IANA time zone name. */
  readonly timeZone: string | null;
  /** The country this customer's data is kept in, ISO 3166-1 alpha-2. */
  readonly dataResidencyCountry: string | null;
  /** `partner_default`, `use1` or `usw1`. */
  readonly regionPreference: string | null;
  readonly effectiveRegion: string | null;
  /** Whether this customer has a phone system. */
  readonly pbx: boolean | null;
  readonly residential: boolean | null;
  /** The most calls the phone system allows at once. */
  readonly callLimit: number | null;
  /** The most external calls the phone system allows at once. */
  readonly callLimitExternal: number | null;
  /** The SIP transports offered, first preferred. */
  readonly transports: readonly string[] | null;
  /** Where building the phone system on the switch stands. */
  readonly provisioningState: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly raw: RawJson;
}

/**
 * One page of `customers.list()`, newest first.
 *
 * `nextCursor` is the server's own cursor, lifted out of `meta.page` — never
 * one this client built — and it is null on the last page. `nextUrl` mirrors
 * `links.next`, which is absent rather than null at the end.
 */
export interface CustomerPage {
  readonly customers: readonly Customer[];
  readonly nextUrl: string | null;
  readonly nextCursor: string | null;
  readonly raw: RawJson;
}

/** Build from a JSON:API resource object — both customer calls. */
export function customerFromResource(resource: RawJson): Customer {
  const attributes = nested(resource, "attributes") ?? {};

  return Object.freeze({
    id: text(resource, "id") ?? "",
    name: text(attributes, "name"),
    code: text(attributes, "code"),
    country: text(attributes, "country"),
    addressLines: textList(attributes, "addressLines"),
    city: text(attributes, "city"),
    region: text(attributes, "region"),
    postalCode: text(attributes, "postalCode"),
    timeZone: text(attributes, "timeZone"),
    dataResidencyCountry: text(attributes, "dataResidencyCountry"),
    regionPreference: text(attributes, "regionPreference"),
    effectiveRegion: text(attributes, "effectiveRegion"),
    pbx: boolean(attributes, "pbx"),
    residential: boolean(attributes, "residential"),
    callLimit: integer(attributes, "callLimit"),
    callLimitExternal: integer(attributes, "callLimitExternal"),
    transports: textList(attributes, "transports"),
    provisioningState: text(attributes, "provisioningState"),
    createdAt: instant(attributes.createdAt),
    updatedAt: instant(attributes.updatedAt),
    raw: resource,
  });
}

export function customerPageFromDocument(document: RawJson): CustomerPage {
  const data = document.data;
  const customers = (Array.isArray(data) ? data : []).filter(isRecord).map(customerFromResource);

  return Object.freeze({
    customers: Object.freeze(customers),
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
