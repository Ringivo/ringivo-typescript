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
 * `nextCursor` is the server's own cursor, lifted out of `links.next` —
 * never one this client built. The cursor encodes the row AND the direction,
 * and its meaning belongs to the server; pass it straight back as `cursor`
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

function nested(source: RawJson, key: string): RawJson | null {
  const value = source[key];
  return isRecord(value) ? value : null;
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

export function faxPageFromDocument(document: RawJson): FaxPage {
  const data = document.data;
  const faxes = (Array.isArray(data) ? data : []).filter(isRecord).map(faxFromResource);
  const nextUrl = nextLink(document);

  return Object.freeze({
    faxes: Object.freeze(faxes),
    nextUrl,
    nextCursor: cursorOf(nextUrl),
    raw: document,
  });
}

function nextLink(document: RawJson): string | null {
  const links = nested(document, "links");
  if (!links) {
    return null;
  }

  const following = links.next;
  return typeof following === "string" && following !== "" ? following : null;
}

/**
 * Lift the server's own cursor out of `links.next`.
 *
 * Never rebuilt — the value is read back out of the link the server minted,
 * so the client is passing the server its own token.
 */
function cursorOf(url: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).searchParams.get("page[cursor]");
  } catch {
    return null;
  }
}
