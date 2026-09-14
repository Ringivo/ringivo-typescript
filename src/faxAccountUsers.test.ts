/**
 * The fax-account-user surface, asserted on the WIRE.
 *
 * Every test here checks the request that went out or the object that came
 * back, never an internal call — the same discipline as faxAccounts.test.ts,
 * for the same reason: `list()`'s whole job is to build a query string and
 * none of that is observable from the return value.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const GRANTS_URL = `${BASE_URL}/v1/fax-account-users`;
const GRANT_ID = "0198c4a1-6f70-7192-c394-5e6f70819203";
const GRANT_URL = `${GRANTS_URL}/${GRANT_ID}`;
const ACCOUNT_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";
const USER_ID = "0198c4a1-7081-72a3-d4a5-6f7081920314";
const JSONAPI = "application/vnd.api+json";

const server = mockServer();

beforeEach(() => {
  // Every test here needs a credential to have been minted, not tested.
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(): Ringivo {
  // The scopes are the ones this module's calls need: `fax:read` for the
  // reads and `fax-accounts:write` for the grant and the revoke.
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["fax:read", "fax-accounts:write"],
  });
}

function grantResource(overrides: Record<string, unknown> = {}): object {
  return {
    type: "fax-account-users",
    id: GRANT_ID,
    attributes: {
      userEmail: "records@acme-vet.example",
      createdAt: "2026-08-02T10:00:00.000000Z",
      updatedAt: "2026-08-02T10:00:00.000000Z",
      ...overrides,
    },
    relationships: {
      faxAccount: { data: { type: "fax-accounts", id: ACCOUNT_ID } },
      user: { data: { type: "users", id: USER_ID } },
    },
  };
}

describe("list", () => {
  it("builds both filters and the page query", async () => {
    const calls = new Calls();
    server.use(
      http.get(GRANTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().faxAccountUsers.list({
      faxAccount: ACCOUNT_ID,
      user: USER_ID,
      pageSize: 50,
      after: "0198c4a1",
    });

    const params = calls.last.url.searchParams;

    // The filter is spelled `fax_account`, not `faxAccount`: the query
    // grammar is snake_case even where the document members are camelCase,
    // and a filter this client misspelled would be a 400 rather than a
    // narrower page.
    expect(params.get("filter[fax_account]")).toBe(ACCOUNT_ID);
    expect(params.get("filter[user]")).toBe(USER_ID);
    expect(params.get("page[size]")).toBe("50");
    expect(params.get("page[after]")).toBe("0198c4a1");
    // An unset filter is absent, not empty: `filter[user]=` would be a 400
    // rather than "no opinion".
    expect(params.has("page[before]")).toBe(false);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("asks for every grant when no filter was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(GRANTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().faxAccountUsers.list();

    expect(calls.last.url.searchParams.has("filter[fax_account]")).toBe(false);
    expect(calls.last.url.searchParams.has("filter[user]")).toBe(false);
  });

  it("reads the grants and the nextCursor from meta.page", async () => {
    server.use(
      http.get(GRANTS_URL, () =>
        HttpResponse.json({
          data: [grantResource()],
          links: { next: `${GRANTS_URL}?page%5Bafter%5D=0198c4a1-next` },
          meta: { page: { size: 25, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().faxAccountUsers.list({ faxAccount: ACCOUNT_ID });

    expect(page.grants).toHaveLength(1);
    expect(page.grants[0]?.userEmail).toBe("records@acme-vet.example");
    expect(page.grants[0]?.faxAccountId).toBe(ACCOUNT_ID);
    expect(page.nextCursor).toBe("0198c4a1-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
  });

  it("has no cursor to follow on the last page, where links.next is ABSENT", async () => {
    server.use(
      http.get(GRANTS_URL, () =>
        HttpResponse.json({ data: [], meta: { page: { size: 25, nextCursor: null } } }),
      ),
    );

    const page = await client().faxAccountUsers.list();

    expect(page.grants).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.nextUrl).toBeNull();
  });
});

describe("get", () => {
  it("reads a JSON:API document into the public object", async () => {
    server.use(http.get(GRANT_URL, () => HttpResponse.json({ data: grantResource() })));

    const grant = await client().faxAccountUsers.get(GRANT_ID);

    // The three ids are three different things, and this is the assertion
    // that keeps them apart: the grant's own id, the account it is on, and
    // the person who holds it.
    expect(grant.id).toBe(GRANT_ID);
    expect(grant.faxAccountId).toBe(ACCOUNT_ID);
    expect(grant.userId).toBe(USER_ID);
    expect(grant.userEmail).toBe("records@acme-vet.example");
    expect(grant.createdAt?.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    expect(grant.updatedAt?.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    expect(grant.raw.type).toBe("fax-account-users");
  });

  it("hands back a frozen object", async () => {
    server.use(http.get(GRANT_URL, () => HttpResponse.json({ data: grantResource() })));

    const grant = await client().faxAccountUsers.get(GRANT_ID);

    // `readonly` is erased at compile time; `Object.freeze` is what stops a
    // plain-JavaScript caller writing to a record of something that already
    // happened.
    expect(Object.isFrozen(grant)).toBe(true);
    expect(() => {
      (grant as { userEmail: string | null }).userEmail = "someone.else@example";
    }).toThrow();
  });

  it("reads no ids rather than crashing when the linkages are absent", async () => {
    // A JSON:API server may answer a relationship with `links` alone. That
    // is legal and says nothing about the grant.
    server.use(
      http.get(GRANT_URL, () =>
        HttpResponse.json({
          data: {
            type: "fax-account-users",
            id: GRANT_ID,
            attributes: { userEmail: "records@acme-vet.example" },
            relationships: {
              faxAccount: { links: { self: `${GRANT_URL}/relationships/faxAccount` } },
              user: { links: { self: `${GRANT_URL}/relationships/user` } },
            },
          },
        }),
      ),
    );

    const grant = await client().faxAccountUsers.get(GRANT_ID);

    expect(grant.faxAccountId).toBeNull();
    expect(grant.userId).toBeNull();
    expect(grant.id).toBe(GRANT_ID);
    expect(grant.userEmail).toBe("records@acme-vet.example");
  });

  it("keeps a grant id inside its own path segment", async () => {
    // An id is whatever the caller's own system handed them, and an
    // unescaped `../faxes/secret` normalises ON THE WIRE to
    // `/v1/faxes/secret` — a different endpoint, read with this client's
    // token.
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: grantResource() });
      }),
    );

    await client().faxAccountUsers.get("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/fax-account-users/..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty grant id rather than sending the collection path", async () => {
    // An empty id collapses the resource path onto the COLLECTION path,
    // which is a different request from the one that was asked for. The
    // assertion is that NOTHING went out: the count, not the server's
    // answer, is the part this package controls.
    const calls = new Calls();
    server.use(
      http.get(GRANTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [grantResource()] });
      }),
    );

    await expect(client().faxAccountUsers.get("")).rejects.toThrow(
      /a fax account user id is required/,
    );

    expect(calls.count, "an empty id reached the wire").toBe(0);
  });

  it("raises a typed 404 for a grant that is not yours", async () => {
    server.use(
      http.get(GRANT_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found", detail: "No." }] },
          { status: 404 },
        ),
      ),
    );

    await expect(client().faxAccountUsers.get(GRANT_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(client().faxAccountUsers.get(GRANT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("create", () => {
  it("posts a JSON:API document naming both relationships", async () => {
    const calls = new Calls();
    server.use(
      http.post(GRANTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: grantResource() }, { status: 201 });
      }),
    );

    const grant = await client().faxAccountUsers.create({
      faxAccount: ACCOUNT_ID,
      user: USER_ID,
    });

    const body = JSON.parse(calls.last.body) as {
      data: {
        type: string;
        attributes?: unknown;
        relationships: {
          faxAccount: { data: { type: string; id: string } };
          user: { data: { type: string; id: string } };
        };
      };
    };

    // The content type is the assertion that matters. This surface answers
    // 415 to `application/json`, which is what a body sent with no explicit
    // type gets.
    expect(calls.last.request.headers.get("Content-Type")).toBe(JSONAPI);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
    expect(body.data.type).toBe("fax-account-users");
    // The two linkages carry the RESOURCE TYPES the spec names, and they
    // are not the same word as the relationship: the `user` relationship
    // points at a `users` resource, and `faxAccount` at `fax-accounts`.
    expect(body.data.relationships.faxAccount.data).toEqual({
      type: "fax-accounts",
      id: ACCOUNT_ID,
    });
    expect(body.data.relationships.user.data).toEqual({ type: "users", id: USER_ID });
    // A grant carries no attributes on the way in. `userEmail` is the
    // server's to publish, and a client that sent one would be asking to
    // rename somebody.
    expect("attributes" in body.data).toBe(false);
    expect(grant.id).toBe(GRANT_ID);
    expect(grant.userEmail).toBe("records@acme-vet.example");
  });

  it("carries the bearer token, like every other call", async () => {
    // The hand-built request is the one place a write could accidentally
    // leave the auth flow. It does not: `client.request()` is what sends it.
    const calls = new Calls();
    server.use(
      http.post(GRANTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: grantResource() }, { status: 201 });
      }),
    );

    await client().faxAccountUsers.create({ faxAccount: ACCOUNT_ID, user: USER_ID });

    expect(calls.last.request.headers.get("Authorization")).toBe("Bearer tok");
  });

  it("answers on the relationship pointer for a user that is not yours", async () => {
    server.use(
      http.post(GRANTS_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "404",
                title: "Not Found",
                detail: "The related resource does not exist.",
                source: { pointer: "/data/relationships/user" },
              },
            ],
          },
          { status: 404 },
        ),
      ),
    );

    await expect(
      client().faxAccountUsers.create({ faxAccount: ACCOUNT_ID, user: USER_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("delete", () => {
  it("sends DELETE to the grant's own path and resolves with nothing", async () => {
    const calls = new Calls();
    server.use(
      http.delete(GRANT_URL, async ({ request }) => {
        await calls.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(client().faxAccountUsers.delete(GRANT_ID)).resolves.toBeUndefined();
    expect(calls.last.request.method).toBe("DELETE");
    expect(calls.last.url.pathname).toBe(`/v1/fax-account-users/${GRANT_ID}`);
  });

  it("refuses an empty grant id rather than sending DELETE at the collection", async () => {
    await expect(client().faxAccountUsers.delete("")).rejects.toThrow(
      /a fax account user id is required/,
    );
  });

  it("raises a typed 404 for a grant that is already gone", async () => {
    server.use(
      http.delete(GRANT_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found", detail: "No." }] },
          { status: 404 },
        ),
      ),
    );

    await expect(client().faxAccountUsers.delete(GRANT_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(client().faxAccountUsers.delete(GRANT_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
