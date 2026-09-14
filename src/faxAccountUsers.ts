/**
 * Who can see a fax account's faxes: list the grants and read one.
 *
 * -- WHAT A GRANT IS, AND WHAT IT IS NOT -----------------------------------
 * A grant is a pair of foreign keys and a fact — a `(user, fax account)` row
 * that exists or does not. There is nothing on it to change, so the API
 * publishes no update route and this module has no `update()`.
 *
 * It is not what lets somebody ADMINISTER an account. Administering one is
 * permission-gated on the person's role, while reading its CONTENT is
 * grant-gated, so the two answer different questions: a manager who can
 * rename an account may hold no grant on it at all.
 *
 * -- WHAT IS TYPED BY THE SPEC ---------------------------------------------
 * Both reads go through the `openapi-fetch` client in client.ts, so
 * `src/_generated/schema.d.ts` type-checks their paths, their query members
 * and their response bodies at compile time.
 */
import { type Ringivo, transportOf } from "./client.js";
import {
  type FaxAccountUser,
  type FaxAccountUserPage,
  type RawJson,
  faxAccountUserFromResource,
  faxAccountUserPageFromDocument,
  isRecord,
} from "./models.js";

/** What `faxAccountUsers.list()` accepts. Every member narrows the collection. */
export interface ListFaxAccountUsersOptions {
  /** Only the grants ON this fax account — "who can see this one?". */
  faxAccount?: string;
  /** Only the grants HELD BY this user — "what can this person see?". */
  user?: string;
  /**
   * Walk forward: the previous page's `FaxAccountUserPage.nextCursor`.
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

/** The `client.faxAccountUsers` namespace. */
export class FaxAccountUsers {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of grants, newest first.
   *
   * Pass `faxAccount` for "who can see this account?" and `user` for "what
   * can this person see?" — the same collection read from either end. With
   * neither, it is every grant your credential can reach.
   *
   * Needs `fax:read`.
   */
  async list(options: ListFaxAccountUsersOptions = {}): Promise<FaxAccountUserPage> {
    const { data } = await transportOf(this.client)["/v1/fax-account-users"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[fax_account]": options.faxAccount,
          "filter[user]": options.user,
        },
      },
    });

    return faxAccountUserPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one grant.
   *
   * The id here is the GRANT's own id — the `id` of a row from `list()`,
   * not the account's and not the person's.
   *
   * An id that is not yours answers 404, the same as one that names nothing
   * anywhere.
   *
   * Needs `fax:read`.
   */
  async get(faxAccountUserId: string): Promise<FaxAccountUser> {
    const { data } = await transportOf(this.client)["/v1/fax-account-users/{faxAccountUser}"].GET({
      params: { path: { faxAccountUser: faxAccountUserIdParam(faxAccountUserId) } },
    });

    return faxAccountUserFromResource(dataObject(data));
  }
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so
 * `/` is already `%2F` by the time the URL is built and this function does
 * not escape it a second time. What it adds is the REFUSAL: an empty id
 * would otherwise collapse `/v1/fax-account-users/{faxAccountUser}` into
 * `/v1/fax-account-users`, which is the LIST — so a `get("")` would answer
 * 200 with a page of grants instead of raising, and the caller would read
 * the first row of it as the grant they asked for.
 *
 * Why the escaping matters at all: an id is whatever the caller's own system
 * handed them, and an unescaped `../faxes/secret` normalises ON THE WIRE to
 * `/v1/faxes/secret` — a different endpoint, read with this client's token.
 * faxAccountUsers.test.ts asserts the escaped path rather than trusting the
 * library to keep doing it.
 */
function faxAccountUserIdParam(value: string): string {
  if (!value) {
    throw new Error("a fax account user id is required");
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
