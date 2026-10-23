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
import type { components } from "./_generated/schema.js";
import { ApiError, Ringivo, VERSION, isRetryable } from "./index.js";
import type { InboundMessage, InboundMessageMediaWithLink } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const MESSAGES_URL = `${BASE_URL}/v1/inbound-messages`;
const MESSAGE_ID = "0198c4a1-8f70-7081-b283-4d5e6f708301";
const SECOND_MESSAGE_ID = "0198c4a1-8f70-7081-b283-4d5e6f708302";
const PART_ID = "0198c4a1-9a10-7c2d-8e3f-405162738495";
const JSONAPI = "application/vnd.api+json";
/** The signed link a media item names: the spec's own example, on the API host. */
const CONTENT_PATH_URL = `${MESSAGES_URL}/${MESSAGE_ID}/media/${PART_ID}/content`;
const CONTENT_URL = `${CONTENT_PATH_URL}?expires=1787057037&signature=abc123`;

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
      contentUrl: null,
      expiresAt: null,
      raw: { contentType: "image/jpeg", filename: "photo.jpg", size: 40213 },
    });
    // A member of the wrong type reads null; the value is still in raw.
    expect(message.media[1]?.filename).toBeNull();
    expect(message.media[1]?.size).toBeNull();
    expect(message.media[1]?.raw.size).toBe("large");
    expect(Object.isFrozen(message.media)).toBe(true);
  });

  it("reads each media item's download link and when it dies", async () => {
    server.use(
      http.get(`${MESSAGES_URL}/${MESSAGE_ID}`, () =>
        HttpResponse.json({
          data: messageResource({
            kind: "mms",
            media: [
              {
                contentType: "image/jpeg",
                filename: "photo.jpg",
                size: 40213,
                contentUrl: CONTENT_URL,
                expiresAt: "2026-08-18T12:43:57+00:00",
              },
              {
                contentType: "text/plain",
                filename: null,
                size: 12,
                contentUrl: null,
                expiresAt: null,
              },
            ],
          }),
        }),
      ),
    );

    const message = await client().inboundMessages.get(MESSAGE_ID);

    expect(message.media[0]?.contentUrl).toBe(CONTENT_URL);
    expect(message.media[0]?.expiresAt?.toISOString()).toBe("2026-08-18T12:43:57.000Z");
    // Null when the platform holds no bytes: the text part here.
    expect(message.media[1]?.contentUrl).toBeNull();
    expect(message.media[1]?.expiresAt).toBeNull();
    expect(Object.isFrozen(message.media[0])).toBe(true);
  });
});

describe("list reads media links", () => {
  it("reads contentUrl and expiresAt on every row of a page", async () => {
    listing({
      data: [
        messageResource({
          kind: "mms",
          media: [
            {
              contentType: "image/png",
              filename: "a.png",
              size: 9,
              contentUrl: CONTENT_URL,
              expiresAt: "2026-08-18T12:43:57Z",
            },
          ],
        }),
      ],
    });

    const page = await client().inboundMessages.list();

    expect(page.messages[0]?.media[0]).toEqual({
      contentType: "image/png",
      filename: "a.png",
      size: 9,
      contentUrl: CONTENT_URL,
      expiresAt: new Date("2026-08-18T12:43:57Z"),
      raw: {
        contentType: "image/png",
        filename: "a.png",
        size: 9,
        contentUrl: CONTENT_URL,
        expiresAt: "2026-08-18T12:43:57Z",
      },
    });
  });

  it("reads a link member of the wrong type as null", async () => {
    listing({
      data: [
        messageResource({
          media: [
            { contentType: "image/png", filename: null, size: 9, contentUrl: 7, expiresAt: "soon" },
          ],
        }),
      ],
    });

    const page = await client().inboundMessages.list();

    expect(page.messages[0]?.media[0]?.contentUrl).toBeNull();
    expect(page.messages[0]?.media[0]?.expiresAt).toBeNull();
  });
});

describe("downloadMedia", () => {
  function withLink(contentUrl: string | null): InboundMessageMediaWithLink {
    return Object.freeze({
      contentType: "image/jpeg",
      filename: "photo.jpg",
      size: 23,
      contentUrl,
      expiresAt: contentUrl === null ? null : new Date("2026-08-18T12:43:57Z"),
      raw: {},
    });
  }

  it("reads the message with the bearer, then downloads WITHOUT it", async () => {
    // The link is signed: the signature is the authorization. Sending our
    // bearer token with it would hand a credential that reads every message
    // to a URL that never needed one.
    const read = new Calls();
    const download = new Calls();
    server.use(
      http.get(`${MESSAGES_URL}/${MESSAGE_ID}`, async ({ request }) => {
        await read.record(request);
        return HttpResponse.json({
          data: messageResource({
            kind: "mms",
            media: [
              {
                contentType: "image/jpeg",
                filename: "photo.jpg",
                size: 23,
                contentUrl: CONTENT_URL,
                expiresAt: "2026-08-18T12:43:57+00:00",
              },
            ],
          }),
        });
      }),
      http.get(CONTENT_PATH_URL, async ({ request }) => {
        await download.record(request);
        return HttpResponse.text("\xff\xd8 the real photo", {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const ringivo = client();
    const message = await ringivo.inboundMessages.get(MESSAGE_ID);
    const item = message.media[0];
    if (!item) {
      throw new Error("expected one media item");
    }
    const content = await ringivo.inboundMessages.downloadMedia(item);

    expect(content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(content)).toContain("the real photo");
    expect(read.last.request.headers.get("authorization")).toBe("Bearer tok");
    expect(download.count).toBe(1);
    expect(download.last.request.headers.get("authorization")).toBeNull();
    // It drops the token and nothing else: the User-Agent stays.
    expect(download.last.request.headers.get("user-agent")).toBe(`Ringivo/TS ${VERSION}`);
    // The link is followed exactly as given: the signature covers all of it.
    expect(download.last.url.toString()).toBe(CONTENT_URL);
  });

  it("refuses an item with no link, before any request", async () => {
    // No handler is registered: a request would fail the test on its own.
    const error = await client()
      .inboundMessages.downloadMedia(withLink(null))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).message).toMatch(/no contentUrl/);
    expect((error as Error).message).toMatch(/messaging provider/);
  });

  it("refuses a webhook media item, which never has a link", async () => {
    const webhookItem = { contentType: "image/jpeg", filename: "photo.jpg", size: 23, raw: {} };

    await expect(
      // @ts-expect-error — a webhook item has no contentUrl; read the message for one.
      client().inboundMessages.downloadMedia(webhookItem),
    ).rejects.toThrow(/inboundMessages\.get\(\)/);
  });

  it("throws an expired or altered link's 403 as an ApiError", async () => {
    server.use(
      http.get(CONTENT_PATH_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "403", title: "Forbidden", detail: "Invalid signature." }] },
          { status: 403, headers: { "Content-Type": JSONAPI } },
        ),
      ),
    );

    const error = (await client()
      .inboundMessages.downloadMedia(withLink(CONTENT_URL))
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(403);
    expect(error.errors[0]?.detail).toBe("Invalid signature.");
  });

  it("throws a file the platform no longer holds as a 404 not_found", async () => {
    server.use(
      http.get(CONTENT_PATH_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found" }] },
          { status: 404, headers: { "Content-Type": JSONAPI } },
        ),
      ),
    );

    const error = (await client()
      .inboundMessages.downloadMedia(withLink(CONTENT_URL))
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("not_found");
  });

  it("throws a 429 with its Retry-After, retryable", async () => {
    server.use(
      http.get(CONTENT_PATH_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "429", code: "rate_limited", title: "Too Many Requests" }] },
          { status: 429, headers: { "Content-Type": JSONAPI, "Retry-After": "12" } },
        ),
      ),
    );

    const error = (await client()
      .inboundMessages.downloadMedia(withLink(CONTENT_URL))
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.statusCode).toBe(429);
    expect(error.retryAfter).toBe(12);
    expect(isRetryable(error)).toBe(true);
  });
});

describe("the API media item shape", () => {
  // The drift lock, in both directions, as messageEvents.test.ts has for the
  // webhook item: every member the generated schema declares is a member of
  // the model, and the model has no member besides those and `raw`.
  type SameKeys<Model, Wire> = [Exclude<keyof Model, "raw">] extends [keyof Wire]
    ? [keyof Wire] extends [Exclude<keyof Model, "raw">]
      ? true
      : false
    : false;

  it("is the spec's InboundMessageMediaWithLink", () => {
    const withLink: SameKeys<
      InboundMessageMediaWithLink,
      components["schemas"]["InboundMessageMediaWithLink"]
    > = true;
    const message: InboundMessage["media"][number] extends InboundMessageMediaWithLink
      ? true
      : false = true;
    expect([withLink, message]).toEqual([true, true]);
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
