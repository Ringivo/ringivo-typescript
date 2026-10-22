/**
 * Reading the texts sent to your numbers, asserted on the WIRE.
 *
 * Two reads. `list()`'s job is a query string and `get()`'s is the object
 * built from the answer. The query is asserted key for key, so a filter that
 * slipped onto the wire under the wrong name fails here rather than in a
 * customer's integration, and `ids` is asserted on the RAW query string —
 * the server reads a list only from the repeated `filter[id][]` pair.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const MESSAGES_URL = `${BASE_URL}/v1/inbound-messages`;
const MESSAGE_ID = "0198c4a1-8f70-7081-b283-4d5e6f708301";
const SECOND_MESSAGE_ID = "0198c4a1-8f70-7081-b283-4d5e6f708302";
const JSONAPI = "application/vnd.api+json";

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
    scopes: ["numbers:read"],
  });
}

/** The spec's own list example's one row. */
function messageResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "inbound-messages",
    id: MESSAGE_ID,
    attributes: {
      kind: "sms",
      from: "+12003004000",
      to: "+13215550101",
      body: "Hello World",
      media: [],
      receivedAt: "2026-09-03T09:14:02.000000Z",
      createdAt: "2026-09-03T09:14:03.000000Z",
      updatedAt: "2026-09-03T09:14:03.000000Z",
      ...attributeOverrides,
    },
  };
}

function listing(document: object): Calls {
  const calls = new Calls();
  server.use(
    http.get(MESSAGES_URL, async ({ request }) => {
      await calls.record(request);
      return HttpResponse.json(document);
    }),
  );
  return calls;
}

describe("list", () => {
  it("reads the spec's example page", async () => {
    listing({
      data: [messageResource()],
      links: { next: `${MESSAGES_URL}?page[after]=cursor-2` },
      meta: { page: { nextCursor: "cursor-2" } },
    });

    const page = await client().inboundMessages.list();

    expect(page.messages).toHaveLength(1);
    const message = page.messages[0];
    expect(message?.id).toBe(MESSAGE_ID);
    expect(message?.kind).toBe("sms");
    expect(message?.from).toBe("+12003004000");
    expect(message?.to).toBe("+13215550101");
    expect(message?.body).toBe("Hello World");
    expect(message?.media).toEqual([]);
    expect(message?.receivedAt?.toISOString()).toBe("2026-09-03T09:14:02.000Z");
    expect(message?.createdAt?.toISOString()).toBe("2026-09-03T09:14:03.000Z");
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.nextUrl).toBe(`${MESSAGES_URL}?page[after]=cursor-2`);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.messages)).toBe(true);
    expect(Object.isFrozen(message)).toBe(true);
  });

  it("sends every filter and the cursor, and nothing else", async () => {
    const calls = listing({ data: [] });

    await client().inboundMessages.list({
      number: "+13215550101",
      from: "+12003004000",
      kind: "mms",
      receivedAfter: "2026-09-01T00:00:00Z",
      receivedBefore: "2026-09-30T23:59:59Z",
      after: "cursor-1",
      pageSize: 50,
    });

    const params = calls.last.url.searchParams;
    expect(Object.fromEntries(params)).toEqual({
      "filter[number]": "+13215550101",
      "filter[from]": "+12003004000",
      "filter[kind]": "mms",
      "filter[receivedAfter]": "2026-09-01T00:00:00Z",
      "filter[receivedBefore]": "2026-09-30T23:59:59Z",
      "page[after]": "cursor-1",
      "page[size]": "50",
    });
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("sends no parameter for an option left out", async () => {
    const calls = listing({ data: [] });

    await client().inboundMessages.list();

    expect(calls.last.url.search).toBe("");
  });

  it("sends ids as one filter[id][] pair per id", async () => {
    const calls = listing({ data: [] });

    await client().inboundMessages.list({ ids: [MESSAGE_ID, SECOND_MESSAGE_ID] });

    expect(calls.last.url.search).toBe(
      `?filter[id][]=${MESSAGE_ID}&filter[id][]=${SECOND_MESSAGE_ID}`,
    );
  });

  it("sends no id parameter for an empty list", async () => {
    const calls = listing({ data: [] });

    await client().inboundMessages.list({ ids: [] });

    expect(calls.last.url.searchParams.has("filter[id][]")).toBe(false);
  });

  it.each([
    ["a body that is not an object", "nonsense"],
    ["data that is not a list", { data: { id: MESSAGE_ID } }],
    ["a row that is not an object", { data: ["nonsense", null] }],
  ])("reads %s as an empty page", async (_name, document) => {
    server.use(http.get(MESSAGES_URL, () => HttpResponse.json(document as object)));

    const page = await client().inboundMessages.list();

    expect(page.messages).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.nextUrl).toBeNull();
  });
});

describe("get", () => {
  it("reads one message and describes its media", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${MESSAGES_URL}/${MESSAGE_ID}`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({
          data: messageResource({
            kind: "mms",
            body: null,
            media: [
              { contentType: "image/jpeg", filename: "photo.jpg", size: 40213 },
              { contentType: "text/vcard", filename: null, size: "large" },
            ],
          }),
        });
      }),
    );

    const message = await client().inboundMessages.get(MESSAGE_ID);

    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
    expect(message.kind).toBe("mms");
    expect(message.body).toBeNull();
    expect(message.media).toHaveLength(2);
    expect(message.media[0]).toEqual({
      contentType: "image/jpeg",
      filename: "photo.jpg",
      size: 40213,
      raw: { contentType: "image/jpeg", filename: "photo.jpg", size: 40213 },
    });
    // A member of the wrong type reads null; the value is still in raw.
    expect(message.media[1]?.filename).toBeNull();
    expect(message.media[1]?.size).toBeNull();
    expect(message.media[1]?.raw.size).toBe("large");
    expect(Object.isFrozen(message.media)).toBe(true);
  });

  it("keeps an id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${MESSAGES_URL}/:id`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: messageResource() });
      }),
    );

    await client().inboundMessages.get("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/inbound-messages/..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty id before any request", async () => {
    await expect(client().inboundMessages.get("")).rejects.toThrow(
      "an inbound message id is required",
    );
  });

  it("throws a 404 as an ApiError", async () => {
    server.use(
      http.get(`${MESSAGES_URL}/${MESSAGE_ID}`, () =>
        HttpResponse.json({ errors: [{ status: "404", title: "Not Found" }] }, { status: 404 }),
      ),
    );

    const error = await client()
      .inboundMessages.get(MESSAGE_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(404);
  });
});
