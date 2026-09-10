/**
 * The fax-account surface, asserted on the WIRE.
 *
 * Every test here checks the request that went out or the object that came
 * back, never an internal call — the same discipline as faxes.test.ts, for
 * the same reason: `list()`'s whole job is to build a query string,
 * `create()`'s and `update()`'s is to build a JSON:API document, and
 * `numbers()`'s is to walk a cursor to the end. None of that is observable
 * from the return value alone.
 *
 * The two writes are the interesting half. Their bodies are typed by the
 * spec's own request schemas, but they are sent through `client.request()`
 * rather than the spec-typed transport, because a JSON:API write must carry
 * `Content-Type: application/vnd.api+json` and the shared transport sets
 * `Accept` alone — see the docblock in faxAccounts.ts.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const ACCOUNTS_URL = `${BASE_URL}/v1/fax-accounts`;
const ACCOUNT_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";
const ACCOUNT_URL = `${ACCOUNTS_URL}/${ACCOUNT_ID}`;
const NUMBERS_URL = `${ACCOUNT_URL}/numbers`;
const CUSTOMER_ID = "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081";
const NUMBER_ID = "0198c4a1-5e6f-7081-b283-4d5e6f708192";
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
  // reads and `fax-accounts:write` for the writes.
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["fax:read", "fax-accounts:write"],
  });
}

function accountResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "fax-accounts",
    id: ACCOUNT_ID,
    attributes: {
      name: "Front desk",
      headerText: "ACME VETERINARY",
      defaultFromE164: "+14075550100",
      retentionDays: 365,
      retentionPages: null,
      status: "active",
      createdAt: "2026-08-01T09:00:00.000000Z",
      updatedAt: "2026-08-16T11:00:00.000000Z",
      ...attributeOverrides,
    },
    relationships: {
      customer: { data: { type: "customers", id: CUSTOMER_ID } },
    },
  };
}

function numberResource(id: string = NUMBER_ID, e164 = "+14075550111"): object {
  return {
    type: "phone-numbers",
    id,
    attributes: {
      e164,
      status: "active",
      country: "US",
      activatedAt: "2026-07-30T14:11:00.000000Z",
      createdAt: "2026-07-30T14:10:00.000000Z",
    },
  };
}

describe("list", () => {
  it("builds the filter and page query", async () => {
    const calls = new Calls();
    server.use(
      http.get(ACCOUNTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().faxAccounts.list({
      customer: CUSTOMER_ID,
      status: "suspended",
      pageSize: 50,
      after: "0198c4a1",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[customer]")).toBe(CUSTOMER_ID);
    expect(params.get("filter[status]")).toBe("suspended");
    expect(params.get("page[size]")).toBe("50");
    expect(params.get("page[after]")).toBe("0198c4a1");
    // An unset filter is absent, not empty: `filter[status]=` would be a
    // 400 rather than "no opinion".
    expect(params.has("page[before]")).toBe(false);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("reads the accounts and the nextCursor from meta.page", async () => {
    server.use(
      http.get(ACCOUNTS_URL, () =>
        HttpResponse.json({
          data: [accountResource()],
          links: { next: `${ACCOUNTS_URL}?page%5Bafter%5D=0198c4a1-next` },
          meta: { page: { size: 25, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().faxAccounts.list();

    expect(page.accounts).toHaveLength(1);
    expect(page.accounts[0]?.name).toBe("Front desk");
    expect(page.nextCursor).toBe("0198c4a1-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
  });

  it("has no cursor to follow on the last page, where links.next is ABSENT", async () => {
    server.use(
      http.get(ACCOUNTS_URL, () =>
        HttpResponse.json({ data: [], meta: { page: { size: 25, nextCursor: null } } }),
      ),
    );

    const page = await client().faxAccounts.list();

    expect(page.accounts).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.nextUrl).toBeNull();
  });
});

describe("get", () => {
  it("reads a JSON:API document into the public object", async () => {
    server.use(http.get(ACCOUNT_URL, () => HttpResponse.json({ data: accountResource() })));

    const account = await client().faxAccounts.get(ACCOUNT_ID);

    expect(account.id).toBe(ACCOUNT_ID);
    expect(account.name).toBe("Front desk");
    expect(account.headerText).toBe("ACME VETERINARY");
    expect(account.defaultFromE164).toBe("+14075550100");
    expect(account.retentionDays).toBe(365);
    // `null` is the prune rule being OFF — no page limit on this account.
    expect(account.retentionPages).toBeNull();
    expect(account.status).toBe("active");
    expect(account.customerId).toBe(CUSTOMER_ID);
    expect(account.createdAt?.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    expect(account.raw.type).toBe("fax-accounts");
  });

  it("hands back a frozen object", async () => {
    server.use(http.get(ACCOUNT_URL, () => HttpResponse.json({ data: accountResource() })));

    const account = await client().faxAccounts.get(ACCOUNT_ID);

    // `readonly` is erased at compile time; `Object.freeze` is what stops a
    // plain-JavaScript caller writing to a record of something that already
    // happened.
    expect(Object.isFrozen(account)).toBe(true);
    expect(() => {
      (account as { status: string | null }).status = "suspended";
    }).toThrow();
  });

  it("reads no customer rather than crashing when the linkage is absent", async () => {
    // A JSON:API server may answer a relationship with `links` alone. That
    // is legal and says nothing about the account.
    server.use(
      http.get(ACCOUNT_URL, () =>
        HttpResponse.json({
          data: {
            ...accountResource(),
            relationships: { customer: { links: { self: `${ACCOUNT_URL}/relationships/customer` } } },
          },
        }),
      ),
    );

    const account = await client().faxAccounts.get(ACCOUNT_ID);

    expect(account.customerId).toBeNull();
    expect(account.id).toBe(ACCOUNT_ID);
  });

  it("keeps a fax-account id inside its own path segment", async () => {
    // An id is whatever the caller's own system handed them, and an
    // unescaped `../faxes/secret` normalises ON THE WIRE to
    // `/v1/faxes/secret` — a different endpoint, read with this client's
    // token.
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: accountResource() });
      }),
    );

    await client().faxAccounts.get("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/fax-accounts/..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty fax-account id rather than collapsing the path", async () => {
    await expect(client().faxAccounts.get("")).rejects.toThrow(/a fax account id is required/);
  });

  it("raises a typed 404 for an account that is not yours", async () => {
    server.use(
      http.get(ACCOUNT_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found", detail: "No." }] },
          { status: 404 },
        ),
      ),
    );

    await expect(client().faxAccounts.get(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(client().faxAccounts.get(ACCOUNT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("numbers", () => {
  it("walks every page and returns them all", async () => {
    // A truncated list is indistinguishable from a complete one — every row
    // on it is real — so this call walks to the end rather than handing back
    // page one.
    const calls = new Calls();
    const bodies = [
      {
        data: [numberResource()],
        meta: { page: { size: 100, nextCursor: "cursor-2" } },
      },
      {
        data: [numberResource("0198c4a1-6f70-8192-c394-5e6f70819203", "+14075550112")],
        meta: { page: { size: 100, nextCursor: null } },
      },
    ];
    server.use(
      http.get(NUMBERS_URL, async ({ request }) => {
        const body = bodies[calls.count] ?? bodies[bodies.length - 1];
        await calls.record(request);
        return HttpResponse.json(body);
      }),
    );

    const numbers = await client().faxAccounts.numbers(ACCOUNT_ID);

    expect(numbers.map((n) => n.e164)).toEqual(["+14075550111", "+14075550112"]);
    expect(numbers[0]?.country).toBe("US");
    expect(numbers[0]?.activatedAt?.toISOString()).toBe("2026-07-30T14:11:00.000Z");
    expect(calls.at(0).url.searchParams.get("page[size]")).toBe("100");
    expect(calls.at(0).url.searchParams.has("page[after]")).toBe(false);
    expect(calls.at(1).url.searchParams.get("page[after]")).toBe("cursor-2");
  });

  it("refuses a repeated cursor rather than walking for ever", async () => {
    // A server that answers the same cursor twice would spin this walk for
    // ever, and a hang is the one failure nobody can see.
    server.use(
      http.get(NUMBERS_URL, () =>
        HttpResponse.json({
          data: [numberResource()],
          meta: { page: { size: 100, nextCursor: "stuck" } },
        }),
      ),
    );

    await expect(client().faxAccounts.numbers(ACCOUNT_ID)).rejects.toThrow(
      /served the cursor "stuck" twice/,
    );
  });
});
