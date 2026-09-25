/**
 * Who can see a fax account's faxes: list the grants, read one, grant, revoke.
 *
 * -- WHAT A GRANT IS, AND WHAT IT IS NOT -----------------------------------
 * A grant is a pair of foreign keys and a fact — a `(user, fax account)` row
 * that exists or does not. There is nothing on it to change, so the API
 * publishes no update route and this module has no `update()`: you withdraw
 * one by deleting it.
 *
 * It is not what lets somebody ADMINISTER an account. Administering one is
 * permission-gated on the person's role, while reading its CONTENT is
 * grant-gated, so the two answer different questions: a manager who can
 * rename an account may hold no grant on it at all. That is also why
 * `create()` may name an account the caller holds no grant on themselves —
 * somebody has to be able to add the first member.
 *
 * -- WHAT IS TYPED BY THE SPEC, AND WHAT IS HAND-BUILT ----------------------
 * `list`, `get` and `delete` go through the `openapi-fetch` client in
 * client.ts, so `src/_generated/schema.d.ts` type-checks their paths, their
 * query members and their response bodies at compile time.
 *
 * `create` builds its JSON:API document here and sends it through
 * `client.request()` — the same public escape hatch, the same auth flow, the
 * same typed errors — exactly as `faxAccounts.create()` does. ITS BODY IS
 * SPEC-TYPED ALL THE SAME: the document is declared as the generated
 * `FaxAccountUserCreateRequest`, so a member this package spells wrongly is
 * a compile error rather than a 422 somebody reads out of a log.
 *
 * What takes it off the typed transport is the MEDIA TYPE, and that is the
 * only reason. A JSON:API resource route answers 415 to `application/json`,
 * which is what a body sent with no explicit type gets, and the shared
 * `openapi-fetch` client is built with `Accept` alone (client.ts). This one
 * call sets both headers itself.
 *
 * -- THE DOCUMENT IS ALL RELATIONSHIPS -------------------------------------
 * Unlike a fax-account write, a grant carries no attributes at all on the
 * way in — `{"data": {"type": "fax-account-users", "relationships":
 * {"faxAccount": …, "user": …}}}` — and the spec requires both. So there is
 * no sparse-write rule here and no "not given" sentinel to need: every
 * member of this document is mandatory, and `userEmail` is the server's to
 * publish rather than the caller's to send.
 */
import type { components } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type Ringivo, transportOf } from "./client.js";
import {
  type FaxAccountUser,
  type FaxAccountUserPage,
  type RawJson,
  faxAccountUserFromResource,
  faxAccountUserPageFromDocument,
  isRecord,
} from "./models.js";

/**
 * The create document as the spec declares it.
 *
 * Local and unexported, so nothing generated crosses the public boundary.
 * What it buys is that a relationship misspelled here is a compile error
 * rather than a 422 read back out of a log.
 */
type CreateRequest = components["schemas"]["FaxAccountUserCreateRequest"];

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

/** What `faxAccountUsers.create()` accepts. The spec requires both. */
export interface CreateFaxAccountUserOptions {
  /** The account whose faxes this person is to be able to read. */
  faxAccount: string;
  /** The person who is to read them. */
  user: string;
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
          "filter[faxAccount]": options.faxAccount,
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

  /**
   * Grant one person access to one fax account's faxes.
   *
   * The account may be one you hold no grant on yourself: administering an
   * account is permission-gated while reading its content is grant-gated,
   * so somebody has to be able to add the first member.
   *
   * Granting the same pair twice is the server's question, not this
   * client's — it answers, and whatever it answers reaches you as it is.
   *
   * A relationship naming a fax account or a user that does not exist FOR
   * YOU answers 404 on the pointer, the same as one that names nothing
   * anywhere: a resource you cannot reach does not resolve rather than
   * being fetched and then refused.
   *
   * Needs `fax-accounts:write`.
   */
  async create(options: CreateFaxAccountUserOptions): Promise<FaxAccountUser> {
    const document: CreateRequest = {
      data: {
        type: "fax-account-users",
        relationships: {
          faxAccount: { data: { type: "fax-accounts", id: options.faxAccount } },
          user: { data: { type: "users", id: options.user } },
        },
      },
    };

    const response = await this.client.request(
      new Request(`${this.client.baseUrl}/v1/fax-account-users`, {
        method: "POST",
        headers: jsonApiHeaders(),
        body: JSON.stringify(document),
      }),
    );

    return faxAccountUserFromResource(dataObject(await response.json()));
  }

  /**
   * Withdraw a grant. The person stops seeing that account's faxes.
   *
   * This is the only way to undo one — there is no update route, because
   * there is nothing on a grant to change.
   *
   * It removes the GRANT and nothing else: the account, its numbers and
   * every fax on it are untouched, and a person who reaches the account
   * some other way — a role that carries `fax-accounts:write`, say — goes
   * on reaching it. Revoking is not the same as shutting somebody out.
   *
   * The id is the grant's own id, so pass what `list()` handed you rather
   * than the account's or the person's.
   *
   * Needs `fax-accounts:write`.
   */
  async delete(faxAccountUserId: string): Promise<void> {
    await transportOf(this.client)["/v1/fax-account-users/{faxAccountUser}"].DELETE({
      params: { path: { faxAccountUser: faxAccountUserIdParam(faxAccountUserId) } },
    });
  }
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so
 * `/` is already `%2F` by the time the URL is built and this function does
 * not escape it a second time. What it adds is the REFUSAL: an empty id
 * would otherwise collapse `/v1/fax-account-users/{faxAccountUser}` into
 * `/v1/fax-account-users/` — the COLLECTION path, which is a different
 * request from the one the caller asked for. Whether a given server answers
 * that with a page, a redirect or a 404 has not been measured here and does
 * not need to be: none of the three is the one grant `get("")` was called
 * for, and this package refuses it before it can be sent.
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

/**
 * The `Accept` and `Content-Type` the grant sends.
 *
 * `application/vnd.api+json` on BOTH, and the request half is the one that
 * matters: a JSON:API resource route answers 415 to `application/json`,
 * which is what a body sent with no explicit type gets.
 */
function jsonApiHeaders(): Headers {
  return new Headers({ Accept: JSONAPI_MEDIA_TYPE, "Content-Type": JSONAPI_MEDIA_TYPE });
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
