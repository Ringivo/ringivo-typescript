/**
 * `list()` answers a `PagePromise`: awaited it is the first page, iterated it
 * is every item on every page. Read against `customers.list()`, whose pages
 * also carry `meta.page.total`; every other list shares this one type.
 */
import { describe, expect, it } from "vitest";

import { Page, PagePromise, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";

function customer(id: string): object {
  return { type: "customers", id, attributes: { name: `Customer ${id}`, code: id } };
}

/** Three pages: a, b | c, d | e. The cursor of a page is the id that starts it. */
const PAGES: Record<string, { data: object[]; next: string | null }> = {
  first: { data: [customer("a"), customer("b")], next: "c" },
  c: { data: [customer("c"), customer("d")], next: "e" },
  e: { data: [customer("e")], next: null },
};

function client(seen: URL[]): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["customers:read"],
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/token") {
        return Response.json({ access_token: "tok", token_type: "Bearer", expires_in: 900 });
      }
      seen.push(url);
      const page = PAGES[url.searchParams.get("page[after]") ?? "first"];
      if (!page) {
        return Response.json({ errors: [{ status: "400" }] }, { status: 400 });
      }
      return Response.json({
        data: page.data,
        meta: { page: { size: 2, nextCursor: page.next, total: 5 } },
        links: page.next ? { next: `${BASE_URL}/v1/customers?page[after]=${page.next}` } : {},
      });
    },
  });
}

describe("a list", () => {
  it("awaited, is the first page, with one shape whatever the resource", async () => {
    const seen: URL[] = [];
    const page = await client(seen).customers.list({ pageSize: 2 });

    expect(page).toBeInstanceOf(Page);
    expect(page.data.map((c) => c.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("c");
    expect(page.nextUrl).toBe(`${BASE_URL}/v1/customers?page[after]=c`);
    expect(page.total).toBe(5);
    expect(page.hasNextPage()).toBe(true);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.data)).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("iterated, is every item on every page, in order, one request per page", async () => {
    const seen: URL[] = [];
    const ids: string[] = [];

    for await (const each of client(seen).customers.list({ pageSize: 2, code: "x" })) {
      ids.push(each.id);
    }

    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
    expect(seen.map((url) => url.searchParams.get("page[after]"))).toEqual([null, "c", "e"]);
    // The query is kept page after page: a cursor belongs to the query that made it.
    expect(seen.map((url) => url.searchParams.get("filter[code]"))).toEqual(["x", "x", "x"]);
    expect(seen.map((url) => url.searchParams.get("page[size]"))).toEqual(["2", "2", "2"]);
  });

  it("walks page by page with getNextPage(), and refuses one past the last", async () => {
    const seen: URL[] = [];
    const first = await client(seen).customers.list();
    const second = await first.getNextPage();
    const last = await second.getNextPage();

    expect(last.data.map((c) => c.id)).toEqual(["e"]);
    expect(last.hasNextPage()).toBe(false);
    await expect(last.getNextPage()).rejects.toThrow(/no next page/);

    const pages: string[][] = [];
    for await (const page of first.iterPages()) {
      pages.push(page.data.map((c) => c.id));
    }
    expect(pages).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("is a real Promise, sent once however it is then read", async () => {
    const seen: URL[] = [];
    const pending = client(seen).customers.list();

    expect(pending).toBeInstanceOf(PagePromise);
    expect(pending).toBeInstanceOf(Promise);
    const [one, two] = await Promise.all([pending, pending.then((page) => page.data.length)]);

    expect(one.data).toHaveLength(2);
    expect(two).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("asked for with before, is one page: the polling read never walks on by itself", async () => {
    const seen: URL[] = [];
    const ids: string[] = [];

    for await (const each of client(seen).customers.list({ before: "first-cursor" })) {
      ids.push(each.id);
    }

    expect(ids).toEqual(["a", "b"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.searchParams.get("page[before]")).toBe("first-cursor");
  });

  it("starts from the caller's own after, and rejects like any promise", async () => {
    const seen: URL[] = [];
    const page = await client(seen).customers.list({ after: "e" });
    expect(page.data.map((c) => c.id)).toEqual(["e"]);

    await expect(client(seen).customers.list({ after: "nonsense" }, { maxRetries: 0 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("a PagePromise's own then, catch and finally", () => {
  it("delegate to the request, and answer plain promises", async () => {
    const seen: URL[] = [];
    let finished = false;

    const failed = client(seen).customers.list({ after: "nonsense" }, { maxRetries: 0 });
    const caught = failed.catch((error: unknown) => (error as { statusCode: number }).statusCode);
    expect(caught).not.toBeInstanceOf(PagePromise);
    expect(await caught).toBe(400);

    const page = await client(seen)
      .customers.list()
      .finally(() => {
        finished = true;
      });
    expect(finished).toBe(true);
    expect(page.data).toHaveLength(2);

    const winner = await Promise.race([client(seen).customers.list(), new Promise(() => undefined)]);
    expect((winner as Page<unknown>).data).toHaveLength(2);
  });
});
