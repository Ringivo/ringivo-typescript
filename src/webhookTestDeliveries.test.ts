/**
 * The results of test events, asserted on the WIRE — and the wait for one.
 *
 * Two reads and one helper. The reads are checked the way
 * webhookDeliveries.test.ts checks its own: the query string that went out
 * and the object built from the answer.
 *
 * `wait()` is the part that needs care, because it is the only call in this
 * package that waits. Its tests run on vitest's fake timers, so nothing here
 * really sleeps: the clock is moved by hand, and the number of reads is
 * counted at each step. Each outcome is pinned — pending then delivered,
 * already failed (no read at all), and the timeout — and so are the two
 * defaults: a read every 2 seconds, and an overall wait that outlasts the
 * API's own 2-minute cut-off. A 429 on a read waits out its `Retry-After`
 * inside the deadline; every other refused read is thrown.
 *
 * The fixtures carry the `endpoint` relationship exactly as the API sends it
 * on every read: `data` always present, and no `links`.
 *
 * The compile-time half at the bottom is the drift lock: the model has the
 * generated attributes' members and no others, and the status vocabulary
 * `wait()` relies on is the spec's enum.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import type { components } from "./_generated/schema.js";
import {
  ApiError,
  Ringivo,
  RingivoError,
  WebhookTestTimeoutError,
  isRetryable,
} from "./index.js";
import type { WebhookTestDelivery } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const TESTS_URL = `${BASE_URL}/v1/webhook-test-deliveries`;
const TEST_ID = "019a0b3c-5d6e-7f80-9a1b-2c3d4e5f6071";
const OTHER_TEST_ID = "019a0b3c-5d6e-7f80-9a1b-2c3d4e5f6072";
const TEST_URL = `${TESTS_URL}/${TEST_ID}`;
const ENDPOINT_ID = "0198c4a1-8192-73b4-e5b6-708192031425";
const JSONAPI = "application/vnd.api+json";
const SPEC = readFileSync(fileURLToPath(new URL("../spec/openapi.yaml", import.meta.url)), "utf8");

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
    scopes: ["webhooks:read", "webhooks:write"],
  });
}

function testResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "webhook-test-deliveries",
    id: TEST_ID,
    attributes: {
      eventType: "fax.delivered",
      status: "delivered",
      statusCode: 200,
      durationMs: 87,
      responseBody: '{"received":true}',
      error: null,
      attemptedAt: "2026-10-22T15:04:06.000000Z",
      createdAt: "2026-10-22T15:04:05.000000Z",
      updatedAt: "2026-10-22T15:04:06.000000Z",
      ...attributeOverrides,
    },
    relationships: {
      endpoint: { data: { type: "webhook-endpoints", id: ENDPOINT_ID } },
    },
  };
}

const PENDING = {
  status: "pending",
  statusCode: null,
  durationMs: null,
  responseBody: null,
  attemptedAt: null,
  updatedAt: "2026-10-22T15:04:05.000000Z",
};

describe("list", () => {
  it("builds the endpoint, id and page query", async () => {
    const calls = new Calls();
    server.use(
      http.get(TESTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().webhookTestDeliveries.list({
      endpoint: ENDPOINT_ID,
      ids: [TEST_ID, OTHER_TEST_ID],
      pageSize: 10,
      after: "019a0b3c",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[endpoint]")).toBe(ENDPOINT_ID);
    // The brackets are part of the name: the API reads a list only from the
    // repeated `filter[id][]=a&filter[id][]=b`.
    expect(params.getAll("filter[id][]")).toEqual([TEST_ID, OTHER_TEST_ID]);
    expect(params.has("filter[id]")).toBe(false);
    expect(params.get("page[size]")).toBe("10");
    expect(params.get("page[after]")).toBe("019a0b3c");
    expect(params.has("page[before]")).toBe(false);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("sends no filter at all when none was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(TESTS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().webhookTestDeliveries.list();

    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.keys()]).toEqual([]);
  });

  it("reads the results and the nextCursor from meta.page", async () => {
    server.use(
      http.get(TESTS_URL, () =>
        HttpResponse.json({
          data: [testResource({ status: "failed", statusCode: 401, error: "The endpoint answered 401." })],
          links: { next: `${TESTS_URL}?page%5Bafter%5D=019a0b3c-next` },
          meta: { page: { size: 25, nextCursor: "019a0b3c-next" } },
        }),
      ),
    );

    const page = await client().webhookTestDeliveries.list({ endpoint: ENDPOINT_ID });

    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]?.status).toBe("failed");
    expect(page.deliveries[0]?.statusCode).toBe(401);
    expect(page.deliveries[0]?.endpointId).toBe(ENDPOINT_ID);
    expect(page.nextCursor).toBe("019a0b3c-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.deliveries)).toBe(true);
  });
});

describe("get", () => {
  it("reads a JSON:API document into the public object", async () => {
    server.use(http.get(TEST_URL, () => HttpResponse.json({ data: testResource() })));

    const result = await client().webhookTestDeliveries.get(TEST_ID);

    expect(result.id).toBe(TEST_ID);
    expect(result.endpointId).toBe(ENDPOINT_ID);
    expect(result.eventType).toBe("fax.delivered");
    expect(result.status).toBe("delivered");
    expect(result.statusCode).toBe(200);
    expect(result.durationMs).toBe(87);
    expect(result.responseBody).toBe('{"received":true}');
    expect(result.error).toBeNull();
    expect(result.attemptedAt?.toISOString()).toBe("2026-10-22T15:04:06.000Z");
    expect(result.createdAt?.toISOString()).toBe("2026-10-22T15:04:05.000Z");
    expect(result.updatedAt?.toISOString()).toBe("2026-10-22T15:04:06.000Z");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("reads the endpoint linkage the spec says every read carries", () => {
    // The API sends `relationships.endpoint.data` on every read of this
    // resource, with no `links`. The fixtures above are that shape; this pins
    // the spec's own word for it, so the day it changes is a failing test.
    const block = SPEC.slice(
      SPEC.indexOf("\n    WebhookTestDeliveryResource:\n"),
      SPEC.indexOf("\n    WebhookTestDeliveryDocumentResponse:\n"),
    );
    expect(block).toContain("`data` is always present");
    expect(block).toContain("there are no `links`");
    expect(JSON.stringify(testResource())).not.toContain("links");
  });

  it("reads no endpoint rather than crashing when a body has no relationships", async () => {
    // Not a shape the API sends. The parse stays defensive all the same.
    const { relationships: _dropped, ...bare } = testResource() as Record<string, unknown>;
    server.use(http.get(TEST_URL, () => HttpResponse.json({ data: bare })));

    const result = await client().webhookTestDeliveries.get(TEST_ID);

    expect(result.endpointId).toBeNull();
    expect(result.id).toBe(TEST_ID);
  });

  it("keeps a test id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: testResource() });
      }),
    );

    await client().webhookTestDeliveries.get("../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/webhook-test-deliveries/..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty test id rather than reading the whole collection", async () => {
    await expect(client().webhookTestDeliveries.get("")).rejects.toThrow(
      /a webhook test id is required/,
    );
  });

  it("raises a typed 404 for a result that has been removed", async () => {
    // A result is kept for 7 days.
    server.use(
      http.get(TEST_URL, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found" }] },
          { status: 404 },
        ),
      ),
    );

    await expect(client().webhookTestDeliveries.get(TEST_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("wait", () => {
  beforeEach(() => {
    // Only the timer the wait sleeps on and the clocks are faked: the
    // monotonic one the deadline reads, and the wall clock the handlers below
    // read. msw answers through promises, which stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A GET handler that answers each status in turn, then repeats the last,
   * and counts what it was asked.
   */
  function answering(...statuses: string[]): Calls {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        const status = statuses[Math.min(calls.count - 1, statuses.length - 1)] ?? "pending";
        return HttpResponse.json({
          data: testResource(status === "pending" ? PENDING : { status }),
        });
      }),
    );
    return calls;
  }

  /**
   * A result as the 202 of `sendTest()` hands it back, built through the
   * public read. Its handler answers ONCE and is not counted, so the reads
   * `wait()` makes afterwards reach the handler under test.
   */
  async function sent(overrides: Record<string, unknown> = PENDING): Promise<WebhookTestDelivery> {
    server.use(
      http.get(TEST_URL, () => HttpResponse.json({ data: testResource(overrides) }), {
        once: true,
      }),
    );
    return client().webhookTestDeliveries.get(TEST_ID);
  }

  /** A promise's outcome, read without awaiting it, so the clock can move first. */
  function track<T>(promise: Promise<T>): { settled: () => boolean; result: Promise<T> } {
    let settled = false;
    const result = promise.finally(() => {
      settled = true;
    });
    // The rejection is read later; this keeps it from being unhandled meanwhile.
    result.catch(() => undefined);
    return { settled: () => settled, result };
  }

  it("reads again after each interval until the test is no longer pending", async () => {
    const calls = answering("pending", "pending", "delivered");
    const ringivo = client();
    const pending = await sent();

    const waiting = track(ringivo.webhookTestDeliveries.wait(pending, { intervalMs: 1_000 }));

    // The 202 was pending, so the first read waits one interval.
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.count).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.count).toBe(3);

    const result = await waiting.result;
    expect(result.status).toBe("delivered");
    expect(result.statusCode).toBe(200);
    expect(calls.last.url.pathname).toBe(`/v1/webhook-test-deliveries/${TEST_ID}`);

    // Nothing more is read once the answer is in.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.count).toBe(3);
  });

  it("answers at once, with no read, when the 202 is already failed", async () => {
    const calls = answering("delivered");
    const failed = await sent({
      ...PENDING,
      status: "failed",
      error: "The test could not be queued. Send it again later.",
    });

    const result = await client().webhookTestDeliveries.wait(failed);

    expect(result).toBe(failed);
    expect(calls.count).toBe(0);
  });

  it("reads first when it is given an id rather than a result", async () => {
    const calls = answering("failed");

    const result = await client().webhookTestDeliveries.wait(TEST_ID);

    expect(result.status).toBe("failed");
    expect(calls.count).toBe(1);
  });

  it("throws a WebhookTestTimeoutError carrying the last read when the time runs out", async () => {
    const calls = answering("pending");
    const pending = await sent();

    const waiting = track(
      client().webhookTestDeliveries.wait(pending, { intervalMs: 1_000, timeoutMs: 3_500 }),
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(waiting.settled()).toBe(false);
    // The last sleep is cut to what is left, and one more read is made at
    // the deadline before giving up.
    await vi.advanceTimersByTimeAsync(500);
    const error = await waiting.result.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebhookTestTimeoutError);
    expect(error).toBeInstanceOf(RingivoError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as WebhookTestTimeoutError).delivery.status).toBe("pending");
    expect((error as WebhookTestTimeoutError).delivery.id).toBe(TEST_ID);
    expect((error as Error).message).toMatch(/still pending after 3500 ms/);
    expect(calls.count).toBe(4);
    // Not a "no answer" from the network: the API answered, every time.
    expect(isRetryable(error)).toBe(false);
  });

  it("outlasts the API's own 2-minute cut-off by default", async () => {
    // The API fails a test that has had no result for 2 minutes. The default
    // must still be waiting then, or the caller never sees that answer.
    answering("pending");
    const pending = await sent();

    const waiting = track(client().webhookTestDeliveries.wait(pending));

    await vi.advanceTimersByTimeAsync(125_000);
    expect(waiting.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(waiting.result).rejects.toBeInstanceOf(WebhookTestTimeoutError);
  });

  it("returns the failed result the API writes at its 2-minute cut-off", async () => {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        // Pending for the first 2 minutes, then failed by the API.
        return HttpResponse.json({
          data:
            Date.now() - start < 120_000
              ? testResource(PENDING)
              : testResource({
                  status: "failed",
                  statusCode: null,
                  error: "No result within 2 minutes.",
                }),
        });
      }),
    );
    const start = Date.now();

    const waiting = track(client().webhookTestDeliveries.wait(TEST_ID));
    await vi.advanceTimersByTimeAsync(122_000);

    const result = await waiting.result;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("No result within 2 minutes.");
  });

  it("lets a refused read through rather than reading again", async () => {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found" }] },
          { status: 404 },
        );
      }),
    );

    await expect(client().webhookTestDeliveries.wait(TEST_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(calls.count).toBe(1);
  });

  it("reads every 2 seconds by default", async () => {
    const calls = answering("pending", "delivered");
    const pending = await sent();

    const waiting = track(client().webhookTestDeliveries.wait(pending));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls.count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.count).toBe(2);
    expect((await waiting.result).status).toBe("delivered");
  });

  it("keeps its deadline on the monotonic clock, whatever the wall clock does", async () => {
    // An NTP step moves `Date.now()`; it must not end the wait early.
    answering("pending", "pending", "delivered");
    const pending = await sent();

    const waiting = track(
      client().webhookTestDeliveries.wait(pending, { intervalMs: 1_000, timeoutMs: 5_000 }),
    );
    vi.setSystemTime(Date.now() + 3_600_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect((await waiting.result).status).toBe("delivered");
  });

  /** A 429 the way the API's rate limiter answers it. */
  function rateLimited(retryAfter: string | null): Response {
    return HttpResponse.json(
      { errors: [{ status: "429", title: "Too Many Requests" }] },
      { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } },
    );
  }

  it("waits out a 429's Retry-After on a read, then reads again", async () => {
    // The API's own rate limit covers these reads too. A wait that hits it
    // sleeps for what the server asked and goes on, inside its deadline.
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        if (calls.count === 1) {
          return rateLimited("5");
        }
        return HttpResponse.json({ data: testResource() });
      }),
    );
    const pending = await sent();

    const waiting = track(client().webhookTestDeliveries.wait(pending, { intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.count).toBe(1);
    // Retry-After is 5 s, not the 1 s interval.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.count).toBe(2);
    expect((await waiting.result).status).toBe("delivered");
  });

  it("waits at least the interval after a 429, so Retry-After: 0 cannot make a hot loop", async () => {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return calls.count <= 2 ? rateLimited("0") : HttpResponse.json({ data: testResource() });
      }),
    );
    const pending = await sent();

    const waiting = track(client().webhookTestDeliveries.wait(pending, { intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.count).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.count).toBe(3);
    expect((await waiting.result).status).toBe("delivered");
  });

  it("waits out a 429 on the first read of an id too", async () => {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return calls.count === 1
          ? rateLimited("2")
          : HttpResponse.json({ data: testResource({ status: "failed" }) });
      }),
    );

    const waiting = track(client().webhookTestDeliveries.wait(TEST_ID));
    await vi.advanceTimersByTimeAsync(2_000);

    expect((await waiting.result).status).toBe("failed");
    expect(calls.count).toBe(2);
  });

  it("cuts a 429's Retry-After to the deadline, and throws the 429 if the last read is refused too", async () => {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return rateLimited("60");
      }),
    );
    const pending = await sent();

    const waiting = track(
      client().webhookTestDeliveries.wait(pending, { intervalMs: 1_000, timeoutMs: 10_000 }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.count).toBe(1);
    // Not 60 s: the 9 s left before the deadline, then one more read.
    await vi.advanceTimersByTimeAsync(8_999);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await waiting.result.catch((caught: unknown) => caught);

    expect(calls.count).toBe(2);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 429, retryAfter: 60 });
  });

  it("throws a 429 that names no Retry-After", async () => {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return rateLimited(null);
      }),
    );

    await expect(client().webhookTestDeliveries.wait(TEST_ID)).rejects.toMatchObject({
      statusCode: 429,
      retryAfter: undefined,
    });
    expect(calls.count).toBe(1);
  });

  it("throws a 503 with a Retry-After at once: only a 429 is waited out", async () => {
    const calls = new Calls();
    server.use(
      http.get(TEST_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(
          { errors: [{ status: "503", title: "Unavailable" }] },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }),
    );

    await expect(client().webhookTestDeliveries.wait(TEST_ID)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(calls.count).toBe(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "refuses an intervalMs of %s before any read",
    async (intervalMs) => {
      const calls = answering("pending");

      await expect(
        client().webhookTestDeliveries.wait(TEST_ID, { intervalMs }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(calls.count).toBe(0);
    },
  );

  it.each([-1, Number.NaN])("refuses a timeoutMs of %s before any read", async (timeoutMs) => {
    const calls = answering("pending");

    await expect(
      client().webhookTestDeliveries.wait(TEST_ID, { timeoutMs }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls.count).toBe(0);
  });

  it("accepts the longest interval a timer can hold, 2^31 - 1 ms", async () => {
    // One more and Node's setTimeout fires after 1 ms instead: a hot loop.
    const failed = await sent({ ...PENDING, status: "failed" });

    await expect(
      client().webhookTestDeliveries.wait(failed, { intervalMs: 2 ** 31 - 1 }),
    ).resolves.toBe(failed);
  });
});

describe("the generated types", () => {
  // The drift lock, in both directions: every attribute the spec declares is
  // a member of the model, and the model has no member besides those, the
  // resource's `id`, the `endpoint` linkage and `raw`. `npm run typecheck`
  // fails on the first difference.
  type SameKeys<Model, Wire> = [Exclude<keyof Model, "raw" | "id" | "endpointId">] extends [
    keyof Wire,
  ]
    ? [keyof Wire] extends [Exclude<keyof Model, "raw" | "id" | "endpointId">]
      ? true
      : false
    : false;

  it("give the model exactly the spec's attributes", () => {
    const same: SameKeys<
      WebhookTestDelivery,
      components["schemas"]["WebhookTestDeliveryAttributes"]
    > = true;
    expect(same).toBe(true);
  });

  it("name the three statuses wait() is written against", () => {
    // `wait()` reads again while the status is `pending`, and stops on
    // anything else. That is only right while the spec's enum is these three.
    type Generated = components["schemas"]["WebhookTestDeliveryStatus"];
    type Documented = "pending" | "delivered" | "failed";
    const same: [Generated] extends [Documented]
      ? [Documented] extends [Generated]
        ? true
        : false
      : false = true;
    expect(same).toBe(true);
  });

  it("type the send's flat body with one optional member, eventType", () => {
    type Body = components["schemas"]["WebhookTestRequest"];
    const keys: [keyof Body] extends ["eventType"]
      ? ["eventType"] extends [keyof Body]
        ? true
        : false
      : false = true;
    const empty: Body = {};
    expect([keys, empty]).toEqual([true, {}]);
  });
});
