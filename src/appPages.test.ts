/**
 * The app page calls, asserted on the WIRE.
 *
 * Six calls on two namespaces: set, read and clear, for a customer and for
 * one subscriber. What is worth asserting is what the return value cannot
 * show:
 *
 * - **A set sends FLAT JSON**, not a JSON:API document, as `application/json`,
 *   with `icon` only when it was named.
 * - **A set is resent on a transient failure** — the API says a repeated set
 *   changes nothing, and asks for the same set again after a 502 — while a
 *   409 `Change in progress` is not resent by the client.
 * - **The answer is read defensively**: `page` and `effective` are `null` for
 *   `null`, and `source` is passed through.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ConflictError, Ringivo, UnprocessableEntityError } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const CUSTOMER_ID = "0198c4a1-9203-74c5-a6d7-819203142536";
const SUBSCRIBER_ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";
const CUSTOMER_PAGE_URL = `${BASE_URL}/v1/customers/${CUSTOMER_ID}/app-page`;
const SUBSCRIBER_PAGE_URL = `${BASE_URL}/v1/pbx/subscribers/${SUBSCRIBER_ID}/app-page`;
const JSONAPI = "application/vnd.api+json";

const PAGE = { url: "https://app.example.com/phone?tab=missed", label: "Missed calls", icon: "call_missed" };

const server = mockServer();

beforeEach(() => {
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["pbx-app-pages:write"],
  });
}

/** An `AppPageDocument`, as the spec's 200 examples give it. */
function pageDocument(id: string, attributes: Record<string, unknown>): object {
  return { data: { type: "app-pages", id, attributes } };
}

describe("a customer's app page", () => {
  it("sets the page with flat JSON and reads the answer", async () => {
    const posts = new Calls();
    server.use(
      http.post(CUSTOMER_PAGE_URL, async ({ request }) => {
        await posts.record(request);
        return HttpResponse.json(
          pageDocument(CUSTOMER_ID, { page: PAGE, complete: true, effective: PAGE, source: "customer" }),
          { headers: { "Content-Type": JSONAPI } },
        );
      }),
    );

    const page = await client().customers.setAppPage(CUSTOMER_ID, PAGE);

    // FLAT, and plain JSON: a `data` wrapper is a 422 on this route.
    expect(JSON.parse(posts.at(0).body)).toEqual(PAGE);
    expect(posts.at(0).request.headers.get("content-type")).toBe("application/json");
    expect(page.id).toBe(CUSTOMER_ID);
    expect(page.page).toMatchObject(PAGE);
    expect(page.effective).toMatchObject(PAGE);
    expect(page.complete).toBe(true);
    expect(page.source).toBe("customer");
  });

  it("leaves icon off the body when it was not named", async () => {
    const posts = new Calls();
    server.use(
      http.post(CUSTOMER_PAGE_URL, async ({ request }) => {
        await posts.record(request);
        return HttpResponse.json(
          pageDocument(CUSTOMER_ID, { page: PAGE, complete: true, effective: PAGE, source: "customer" }),
        );
      }),
    );

    await client().customers.setAppPage(CUSTOMER_ID, { url: PAGE.url, label: PAGE.label });

    // Absent, not null: the API then uses `open_in_new`.
    expect(JSON.parse(posts.at(0).body)).toEqual({ url: PAGE.url, label: PAGE.label });
  });

  it("resends a set after a 502, because the API asks for the same set again", async () => {
    const posts = new Calls();
    server.use(
      http.post(CUSTOMER_PAGE_URL, async ({ request }) => {
        await posts.record(request);
        if (posts.count === 1) {
          return HttpResponse.json(
            { errors: [{ status: "502", title: "Phone system unreachable", meta: { changedSettings: 4 } }] },
            { status: 502, headers: { "Retry-After": "0" } },
          );
        }
        return HttpResponse.json(
          pageDocument(CUSTOMER_ID, { page: PAGE, complete: true, effective: PAGE, source: "customer" }),
        );
      }),
    );

    const page = await client().customers.setAppPage(CUSTOMER_ID, PAGE);

    expect(posts.count).toBe(2);
    expect(posts.at(1).body).toBe(posts.at(0).body);
    expect(page.complete).toBe(true);
  });

  it("does not resend a 409 Change in progress", async () => {
    const posts = new Calls();
    server.use(
      http.post(CUSTOMER_PAGE_URL, async ({ request }) => {
        await posts.record(request);
        return HttpResponse.json(
          { errors: [{ status: "409", title: "Change in progress" }] },
          { status: 409 },
        );
      }),
    );

    await expect(client().customers.setAppPage(CUSTOMER_ID, PAGE)).rejects.toBeInstanceOf(ConflictError);
    expect(posts.count).toBe(1);
  });

  it("surfaces a refused url on its pointer", async () => {
    server.use(
      http.post(CUSTOMER_PAGE_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "422", title: "Unprocessable Entity", source: { pointer: "/url" } }] },
          { status: 422 },
        ),
      ),
    );

    const error = await client()
      .customers.setAppPage(CUSTOMER_ID, PAGE)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnprocessableEntityError);
    expect((error as UnprocessableEntityError).errors[0]?.source).toEqual({ pointer: "/url" });
  });

  it("reads a customer with no page of its own as page null", async () => {
    const shared = { url: "https://help.example.com", label: "Help", icon: "help" };
    server.use(
      http.get(CUSTOMER_PAGE_URL, () =>
        HttpResponse.json(
          pageDocument(CUSTOMER_ID, { page: null, complete: false, effective: shared, source: "default" }),
        ),
      ),
    );

    const page = await client().customers.getAppPage(CUSTOMER_ID);

    expect(page.page).toBeNull();
    expect(page.complete).toBe(false);
    expect(page.effective).toMatchObject(shared);
    expect(page.source).toBe("default");
  });

  it("reads an empty menu as effective and source null", async () => {
    server.use(
      http.get(CUSTOMER_PAGE_URL, () =>
        HttpResponse.json(
          pageDocument(CUSTOMER_ID, { page: null, complete: true, effective: null, source: null }),
        ),
      ),
    );

    const page = await client().customers.getAppPage(CUSTOMER_ID);

    expect([page.page, page.effective, page.source]).toEqual([null, null, null]);
  });

  it("clears the page with a DELETE that answers 204", async () => {
    const deletes = new Calls();
    server.use(
      http.delete(CUSTOMER_PAGE_URL, async ({ request }) => {
        await deletes.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(client().customers.clearAppPage(CUSTOMER_ID)).resolves.toBeUndefined();
    expect(deletes.count).toBe(1);
  });
});

describe("a subscriber's app page", () => {
  it("sets the page with flat JSON and reads the answer", async () => {
    const posts = new Calls();
    server.use(
      http.post(SUBSCRIBER_PAGE_URL, async ({ request }) => {
        await posts.record(request);
        return HttpResponse.json(
          pageDocument(SUBSCRIBER_ID, { page: PAGE, complete: true, effective: PAGE, source: "subscriber" }),
        );
      }),
    );

    const page = await client().pbx.subscribers.setAppPage(SUBSCRIBER_ID, PAGE);

    expect(JSON.parse(posts.at(0).body)).toEqual(PAGE);
    expect(posts.at(0).request.headers.get("content-type")).toBe("application/json");
    expect(page.id).toBe(SUBSCRIBER_ID);
    expect(page.source).toBe("subscriber");
  });

  it("reads the page, with the customer's as the effective one", async () => {
    server.use(
      http.get(SUBSCRIBER_PAGE_URL, () =>
        HttpResponse.json(
          pageDocument(SUBSCRIBER_ID, { page: null, complete: true, effective: PAGE, source: "customer" }),
        ),
      ),
    );

    const page = await client().pbx.subscribers.getAppPage(SUBSCRIBER_ID);

    expect(page.page).toBeNull();
    expect(page.effective).toMatchObject(PAGE);
    expect(page.source).toBe("customer");
  });

  it("clears the page with a DELETE that answers 204", async () => {
    const deletes = new Calls();
    server.use(
      http.delete(SUBSCRIBER_PAGE_URL, async ({ request }) => {
        await deletes.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await client().pbx.subscribers.clearAppPage(SUBSCRIBER_ID);

    expect(deletes.count).toBe(1);
  });

  it("escapes the id into one path segment", async () => {
    const deletes = new Calls();
    server.use(
      http.delete(`${BASE_URL}/v1/pbx/subscribers/:id/app-page`, async ({ request }) => {
        await deletes.record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await client().pbx.subscribers.clearAppPage("a/b");

    expect(deletes.at(0).url.pathname).toBe("/v1/pbx/subscribers/a%2Fb/app-page");
  });
});
