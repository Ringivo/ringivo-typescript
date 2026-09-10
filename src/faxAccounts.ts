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
 * the request attributes as
 * `allOf: [FaxAccountWritableAttributes, {type: object, required: [name]}]`,
 * which openapi-typescript rendered as an intersection with
 * `Record<string, never>` — a type no property at all can be assigned to.
 * That is fixed, and it was measured rather than assumed. On the synced
 * tree of 2026-09-10 (spec rev 2ed4589) a create body and an update body
 * both compile against the generated request types, while a deliberate
 * control in the same file — `attributes: { retentionDays: "365" }` — is
 * still reported:
 *
 *     src/__probe.ts(32,19): error TS2322: Type 'string' is not assignable
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
import type { paths } from "./_generated/schema.js";
import { type Ringivo, transportOf } from "./client.js";
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
