/**
 * Open a fax account, read one, list them, change one, delete one.
 *
 * -- WHAT IS TYPED BY THE SPEC, AND WHAT IS HAND-BUILT ----------------------
 * `list`, `get`, `numbers` and `delete` go through the `openapi-fetch`
 * client in client.ts, so `src/_generated/schema.d.ts` type-checks their
 * paths, their query members and their response bodies at compile time.
 *
 * `create` and `update` build their JSON:API document here and send it
 * through `client.request()` — the same public escape hatch, the same auth
 * flow, the same typed errors — exactly as `faxes.send()` does for its
 * multipart body. THEIR BODIES ARE SPEC-TYPED ALL THE SAME: each document
 * is declared as the generated `FaxAccountCreateRequest` /
 * `FaxAccountUpdateRequest`, so a member this package spells wrongly is a
 * compile error rather than a 422 somebody reads out of a log.
 *
 * What takes them off the typed transport is the MEDIA TYPE, and that is
 * the only reason left. A JSON:API resource route answers 415 to
 * `application/json`, which is what a body sent with no explicit type gets,
 * and the shared `openapi-fetch` client is built with `Accept` alone
 * (client.ts). These two calls set both headers themselves.
 *
 * An earlier draft carried a second and larger reason: the spec declared
 * the create attributes as
 * `allOf: [FaxAccountWritableAttributes, {type: object, required: [name]}]`,
 * which openapi-typescript rendered as an intersection with
 * `Record<string, never>` — a type no property at all can be assigned to.
 * The spec no longer does that. `FaxAccountCreateAttributes` is a plain
 * object of the same six members with `name` required, and
 * `FaxAccountUpdateRequest` carries `FaxAccountWritableAttributes` with
 * nothing intersected onto it.
 *
 * That was measured rather than assumed. On the synced tree of 2026-09-10
 * (spec rev 31d1f36) a create body and an update body both compile against
 * the generated request types, while a deliberate control in the same
 * throwaway probe file — `attributes: { retentionDays: "365" }` — is still
 * reported:
 *
 *     src/__probe.ts(30,19): error TS2322: Type 'string' is not assignable
 *     to type 'number'.
 *
 * so the clean compile says the types are usable rather than saying nothing
 * was checked. There is therefore no `@ts-expect-error` gate over these
 * writes: no workaround is left to hold one.
 *
 * -- THE DOCUMENTS ARE JSON:API, UNLIKE A SEND -----------------------------
 * `POST /v1/faxes` is the odd one out on this API: its body is multipart or
 * flat JSON. Every fax-account write is an ordinary JSON:API document —
 * `{"data": {"type": "fax-accounts", "attributes": {...}}}`.
 *
 * -- SPARSE WRITES -----------------------------------------------------------
 * `update()` sends only the members the caller passed, so changing a status
 * leaves the retention rules alone. `undefined` is "not given" and `null` is
 * a VALUE — it clears a nullable field, which for the two retention members
 * means turning that prune rule off. `create()` follows the same rule, so an
 * attribute nobody named is absent from the document and the platform's own
 * defaults apply rather than this package inventing them.
 */
import type { components, paths } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type Ringivo, transportOf } from "./client.js";
import {
  type FaxAccount,
  type FaxAccountNumber,
  type FaxAccountPage,
  type RawJson,
  faxAccountFromResource,
  faxAccountNumbersFromDocument,
  faxAccountPageFromDocument,
  isRecord,
  nextCursorOfDocument,
} from "./models.js";

/**
 * The query the spec publishes for `GET /v1/fax-accounts`.
 *
 * Used to cast the one member whose spec type is an ENUM while this client's
 * own option is a `string` — `status`. Deliberate, and it matches
 * `FaxAccount.status`: a status the server adds tomorrow must be filterable
 * today, without waiting for a regenerate and a release.
 *
 * Local and unexported: nothing generated crosses the public boundary.
 */
type ListFaxAccountsQuery = NonNullable<
  paths["/v1/fax-accounts"]["get"]["parameters"]["query"]
>;

/**
 * The two write documents and the attribute bag inside them, as the spec
 * declares them.
 *
 * Local and unexported, like `ListFaxAccountsQuery` above: nothing generated
 * crosses the public boundary. What they buy is that a member misspelled
 * here is a compile error rather than a 422 read back out of a log.
 */
type CreateRequest = components["schemas"]["FaxAccountCreateRequest"];
type UpdateRequest = components["schemas"]["FaxAccountUpdateRequest"];
type WritableAttributes = components["schemas"]["FaxAccountWritableAttributes"];

/**
 * The page size `numbers()` asks for. It is the API's published ceiling, so
 * the walk makes as few requests as the server allows.
 */
const MAX_PAGE_SIZE = 100;

/** What `faxAccounts.list()` accepts. Every member narrows the collection. */
export interface ListFaxAccountsOptions {
  /** Only this customer's accounts. */
  customer?: string;
  /**
   * `active` or `suspended`. A suspended account still receives faxes; it
   * may not send them.
   */
  status?: string;
  /**
   * Walk forward: the previous page's `FaxAccountPage.nextCursor`. Cannot be
   * combined with `before`.
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

/** What `faxAccounts.create()` accepts. */
export interface CreateFaxAccountOptions {
  /**
   * The customer this account is FOR. Required, and fixed for the account's
   * life — every fax it holds carries the customer it was sent or received
   * for, so there is no way to move it. A customer id that is not yours
   * answers 404 on the relationship pointer, the same as one that names
   * nothing anywhere.
   */
  customer: string;
  /** What a person calls this account. */
  name: string;
  /**
   * The line printed across the top of every page, up to 64 characters —
   * the fax protocol's own column, not a product choice. Pass `null` or an
   * empty string for NO header line at all: the renderer skips the overlay,
   * page count included.
   */
  headerText?: string | null;
  /**
   * The caller ID a send falls back to when it names none. It may be set
   * before the number is routed — whether this account holds it is asked at
   * the send, not here.
   */
  defaultFromE164?: string | null;
  /**
   * Delete this account's fax pages once they are older than this many days.
   * **`null` turns the rule off** — the pages are kept for ever. Leave it
   * out and your provider's default applies.
   */
  retentionDays?: number | null;
  /**
   * Keep only this many of the newest pages on the account. **`null` turns
   * the rule off** — there is no page limit. Leave it out and your
   * provider's default applies.
   */
  retentionPages?: number | null;
}

/**
 * What `faxAccounts.update()` accepts — a SPARSE patch.
 *
 * Only the members you pass are sent, so changing a status leaves the
 * retention rules exactly as they were. `undefined` is "not given"; `null`
 * is a value that CLEARS a nullable field, which for the two retention
 * members means turning that prune rule off.
 *
 * There is no `customer` here on purpose: an account is never moved between
 * customers.
 */
export interface UpdateFaxAccountOptions {
  name?: string;
  headerText?: string | null;
  defaultFromE164?: string | null;
  retentionDays?: number | null;
  retentionPages?: number | null;
  /**
   * `active`, or `suspended` to stop this account SENDING while it goes on
   * receiving. Suspending deletes nothing.
   */
  status?: string;
}

/** The `client.faxAccounts` namespace. */
export class FaxAccounts {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of fax accounts, newest first.
   *
   * Which accounts you see depends on the credential: a token issued for a
   * PERSON lists the accounts that person was granted, while a machine
   * credential lists every account in its scope.
   *
   * Needs `fax:read`.
   */
  async list(options: ListFaxAccountsOptions = {}): Promise<FaxAccountPage> {
    const { data } = await transportOf(this.client)["/v1/fax-accounts"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[customer]": options.customer,
          "filter[status]": options.status as ListFaxAccountsQuery["filter[status]"],
        },
      },
    });

    return faxAccountPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one fax account.
   *
   * An id that is not yours answers 404, the same as one that names nothing
   * anywhere — a foreign account does not resolve rather than being fetched
   * and then refused.
   *
   * Needs `fax:read`.
   */
  async get(faxAccountId: string): Promise<FaxAccount> {
    const { data } = await transportOf(this.client)["/v1/fax-accounts/{faxAccount}"].GET({
      params: { path: { faxAccount: faxAccountIdParam(faxAccountId) } },
    });

    return faxAccountFromResource(dataObject(data));
  }

  /**
   * EVERY number routed to this account, not one page of them.
   *
   * The collection is cursor-paginated, and this walks it to the end before
   * returning. That is deliberate: a truncated list is indistinguishable
   * from a complete one — every row on it is real — and "which numbers does
   * this account hold?" is a question whose wrong answer looks exactly like
   * the right one. An account holds a handful of DIDs, so the walk is one
   * request in practice and asks for the ceiling page size to keep it that
   * way.
   *
   * Attaching a number is NOT done here. A number points at one destination
   * and that rule belongs to the number, so routing is
   * `POST /v1/phone-numbers/{id}/routing` — reachable through
   * `client.request()`.
   *
   * @throws Error when the server serves the same cursor twice. A walk that
   *   trusted it would never end, and a hang is the one failure a caller
   *   cannot see.
   *
   * Needs `fax:read`.
   */
  async numbers(faxAccountId: string): Promise<readonly FaxAccountNumber[]> {
    const account = faxAccountIdParam(faxAccountId);
    const found: FaxAccountNumber[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const { data } = await transportOf(this.client)[
        "/v1/fax-accounts/{faxAccount}/numbers"
      ].GET({
        params: {
          path: { faxAccount: account },
          query: { "page[size]": MAX_PAGE_SIZE, "page[after]": cursor },
        },
      });

      const document = isRecord(data) ? data : {};
      found.push(...faxAccountNumbersFromDocument(document));

      const next = nextCursorOfDocument(document);
      if (next === null) {
        return Object.freeze(found);
      }
      if (seen.has(next)) {
        throw new Error(
          `the API served the cursor "${next}" twice while listing the numbers on fax ` +
            `account ${faxAccountId}: walking it again would never end. ${found.length} ` +
            "numbers were read before this.",
        );
      }
      seen.add(next);
      cursor = next;
    }
  }

  /**
   * Open a fax account for one of your customers.
   *
   * Leave a member out and the platform's own default applies — one year of
   * retention and no page limit, at the time of writing. This client
   * deliberately sends nothing for a member nobody named, so that policy
   * stays the platform's rather than being frozen into an installed package.
   *
   * Numbers are not attached here: point a DID at the account through the
   * routing API.
   *
   * Needs `fax-accounts:write`.
   */
  async create(options: CreateFaxAccountOptions): Promise<FaxAccount> {
    const document: CreateRequest = {
      data: {
        type: "fax-accounts",
        attributes: { ...writableAttributes(options), name: options.name },
        relationships: {
          customer: { data: { type: "customers", id: options.customer } },
        },
      },
    };

    const response = await this.client.request(
      new Request(`${this.client.baseUrl}/v1/fax-accounts`, {
        method: "POST",
        headers: jsonApiHeaders(),
        body: JSON.stringify(document),
      }),
    );

    return faxAccountFromResource(dataObject(await response.json()));
  }

  /**
   * Change a fax account's settings, or suspend it.
   *
   * A SPARSE PATCH: only the members you pass are sent. `null` clears a
   * nullable field rather than meaning "no opinion".
   *
   * @throws Error when no member was named. An empty PATCH spends a round
   *   trip and an audit entry to change nothing, and it is far more often a
   *   form that came back empty than an intention.
   *
   * Needs `fax-accounts:write`.
   */
  async update(faxAccountId: string, options: UpdateFaxAccountOptions): Promise<FaxAccount> {
    const attributes = writableAttributes(options);
    if (Object.keys(attributes).length === 0) {
      throw new Error(
        "update() needs at least one field to change: name, headerText, defaultFromE164, " +
          "retentionDays, retentionPages or status. Pass null to clear a nullable field — " +
          "that counts as a change.",
      );
    }

    const document: UpdateRequest = {
      data: { type: "fax-accounts", id: faxAccountId, attributes },
    };

    const response = await this.client.request(
      new Request(
        `${this.client.baseUrl}/v1/fax-accounts/${encodeURIComponent(
          faxAccountIdParam(faxAccountId),
        )}`,
        { method: "PATCH", headers: jsonApiHeaders(), body: JSON.stringify(document) },
      ),
    );

    return faxAccountFromResource(dataObject(await response.json()));
  }

  /**
   * Delete a fax account. The pages go; the records stay.
   *
   * This DESTROYS the stored pages of every fax on the account and cannot be
   * undone — download anything you want to keep first. The account then
   * leaves your listings and the people granted it lose access. The fax
   * records themselves survive, because they are the billing and audit
   * evidence, and nothing bills after this.
   *
   * It is REFUSED while any number still routes to the account: that is an
   * `ApiError` whose `statusCode` is 409 and whose `code` is
   * `fax_account_has_routed_numbers`. Move or release the numbers through
   * the routing API, then delete. Branch on `code` rather than on the
   * status — a fax that cannot be cancelled is a 409 too, and it carries no
   * code at all.
   *
   * Needs `fax-accounts:write`.
   */
  async delete(faxAccountId: string): Promise<void> {
    await transportOf(this.client)["/v1/fax-accounts/{faxAccount}"].DELETE({
      params: { path: { faxAccount: faxAccountIdParam(faxAccountId) } },
    });
  }
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so
 * `/` is already `%2F` by the time the URL is built and this function does
 * not escape it a second time. What it adds is the REFUSAL: an empty id
 * would otherwise collapse `/v1/fax-accounts/{faxAccount}/numbers` into
 * `/v1/fax-accounts//numbers`, which is a different request nobody asked
 * for.
 *
 * Why the escaping matters at all: an id is whatever the caller's own system
 * handed them, and an unescaped `../faxes/secret` normalises ON THE WIRE to
 * `/v1/faxes/secret` — a different endpoint, read with this client's token.
 * faxAccounts.test.ts asserts the escaped path rather than trusting the
 * library to keep doing it, and `update()`'s hand-built URL escapes it
 * itself because it never reaches openapi-fetch.
 */
function faxAccountIdParam(value: string): string {
  if (!value) {
    throw new Error("a fax account id is required");
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
 * The `Accept` and `Content-Type` both fax-account writes send.
 *
 * `application/vnd.api+json` on BOTH, and the request half is the one that
 * matters: a JSON:API resource route answers 415 to `application/json`,
 * which is what a body sent with no explicit type gets.
 */
function jsonApiHeaders(): Headers {
  return new Headers({ Accept: JSONAPI_MEDIA_TYPE, "Content-Type": JSONAPI_MEDIA_TYPE });
}

/**
 * The attributes the caller actually named — `null` included.
 *
 * `undefined` is dropped and `null` is KEPT, because the two mean different
 * things on the wire: an absent member leaves the server's value exactly as
 * it was, while `null` clears a nullable field. They are separated HERE
 * rather than left to `JSON.stringify` — which also drops `undefined` —
 * because `update()` has to COUNT what was named in order to refuse an
 * empty change, and a count taken after serialisation is a count of a
 * string.
 *
 * `status` is widened to `string` on this package's own options and cast
 * back here, for the reason `ListFaxAccountsOptions.status` is: a status the
 * server adds tomorrow must be settable today, without waiting for a
 * regenerate and a release.
 */
function writableAttributes(options: {
  name?: string;
  headerText?: string | null;
  defaultFromE164?: string | null;
  retentionDays?: number | null;
  retentionPages?: number | null;
  status?: string;
}): WritableAttributes {
  const attributes: WritableAttributes = {};

  if (options.name !== undefined) {
    attributes.name = options.name;
  }
  if (options.headerText !== undefined) {
    attributes.headerText = options.headerText;
  }
  if (options.defaultFromE164 !== undefined) {
    attributes.defaultFromE164 = options.defaultFromE164;
  }
  if (options.retentionDays !== undefined) {
    attributes.retentionDays = options.retentionDays;
  }
  if (options.retentionPages !== undefined) {
    attributes.retentionPages = options.retentionPages;
  }
  if (options.status !== undefined) {
    attributes.status = options.status as WritableAttributes["status"];
  }

  return attributes;
}
