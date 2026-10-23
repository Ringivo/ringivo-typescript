/**
 * Read the results of test events, and wait for one.
 *
 * `webhookEndpoints.sendTest()` sends ONE test event to one endpoint and
 * answers 202 with its result, normally `pending`. The one attempt is made
 * a few seconds later; its outcome is read here.
 *
 * -- WHAT A RESULT SAYS -----------------------------------------------------
 * `status` is `pending` until the attempt is made, then `delivered` (your
 * server answered 2XX) or `failed` (any other answer, or none). The API marks
 * a test that has had no result for 2 minutes `failed`, with an `error` that
 * says so — and a result that arrives after that replaces it. A result is
 * kept for 7 days.
 *
 * -- WHY `wait()` EXISTS, AND WHAT IT DOES NOT DO ---------------------------
 * `wait()` re-reads one result until it is no longer `pending`. It is the
 * only call in this package that waits, and it waits in the caller's own
 * process: a sleep between reads. It never sends a test again. The reads
 * count against the API's own rate limit, so a 429 on a read that names a
 * `Retry-After` is waited out — for that long but never less than the
 * interval, so `Retry-After: 0` cannot make a hot loop, and never past the
 * deadline — and the read is made again. Every other refused read (a 404, a
 * 503, a 429 with no `Retry-After`) is thrown at once, as `get()` throws it.
 *
 * The default overall wait is 150 seconds — longer than the API's 2-minute
 * cut-off, so a test that never reaches your server still comes back as the
 * API's own `failed` result rather than as a timeout here.
 *
 * -- EVERYTHING HERE IS SPEC-TYPED ------------------------------------------
 * Both reads go through the `openapi-fetch` client in client.ts, so
 * `src/_generated/schema.d.ts` type-checks their paths, their query members
 * and their response bodies at compile time. There is no write on this
 * collection: `sendTest()` creates a result and the platform records its
 * outcome.
 */
import { type Ringivo, transportOf } from "./client.js";
import { ApiError, WebhookTestTimeoutError } from "./errors.js";
import {
  type RawJson,
  type WebhookTestDelivery,
  type WebhookTestDeliveryPage,
  isRecord,
  webhookTestDeliveryFromResource,
  webhookTestDeliveryPageFromDocument,
} from "./models.js";
import { pathSegment } from "./pathSegment.js";

/** Milliseconds `wait()` sleeps between two reads, unless told otherwise. */
const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Milliseconds `wait()` waits in all, unless told otherwise: the API's own
 * 2-minute cut-off plus 30 seconds.
 */
const DEFAULT_TIMEOUT_MS = 150_000;

/** What `webhookTestDeliveries.list()` accepts. Every member narrows the list. */
export interface ListWebhookTestDeliveriesOptions {
  /** Only the tests sent to this one endpoint, by its id. */
  endpoint?: string;
  /**
   * Several results by id in one request — the ids `sendTest()` hands back.
   * An empty list asks for nothing and narrows nothing, exactly as leaving
   * this out does.
   */
  ids?: string[];
  /**
   * Walk forward: the previous page's `WebhookTestDeliveryPage.nextCursor`.
   * Cannot be combined with `before`.
   */
  after?: string;
  /** Walk backward from a cursor you already hold. Cannot be combined with `after`. */
  before?: string;
  /** Rows per page. The default is 25 and the ceiling is 100. */
  pageSize?: number;
}

/** What `webhookTestDeliveries.wait()` accepts. */
export interface WaitForWebhookTestOptions {
  /**
   * Milliseconds between two reads. Two seconds by default. Must be above
   * zero and at most 2^31 - 1, the longest delay a timer holds.
   */
  intervalMs?: number;
  /**
   * Milliseconds to wait in all before giving up with a
   * `WebhookTestTimeoutError`. 150 seconds by default — longer than the
   * API's 2-minute cut-off, after which it marks a test with no result
   * `failed`. Must be a finite number, zero or more. The last sleep is cut
   * to what is left, and one last read is made at the deadline.
   */
  timeoutMs?: number;
}

/** The `client.webhookTestDeliveries` namespace. */
export class WebhookTestDeliveries {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of test results from the last 7 days, newest first.
   *
   * Needs `webhooks:read`. A test borrows its endpoint's reach, so a
   * `fax:read` token lists only the tests of **fax-account-scoped**
   * endpoints.
   */
  async list(options: ListWebhookTestDeliveriesOptions = {}): Promise<WebhookTestDeliveryPage> {
    const { data } = await transportOf(this.client)["/v1/webhook-test-deliveries"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[endpoint]": options.endpoint,
          "filter[id][]": options.ids,
        },
      },
    });

    return webhookTestDeliveryPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read the result of one test event.
   *
   * Read it again while `status` is `pending` — or let `wait()` do that.
   * A result older than 7 days answers 404.
   *
   * Needs `webhooks:read`. A test borrows its endpoint's reach, as a
   * delivery does.
   */
  async get(webhookTestDeliveryId: string): Promise<WebhookTestDelivery> {
    const { data } = await transportOf(this.client)[
      "/v1/webhook-test-deliveries/{webhookTestDelivery}"
    ].GET({
      params: {
        path: { webhookTestDelivery: webhookTestDeliveryIdParam(webhookTestDeliveryId) },
      },
    });

    return webhookTestDeliveryFromResource(dataObject(data));
  }

  /**
   * Wait until a test's result is no longer `pending`, and resolve to it.
   *
   * Pass the `WebhookTestDelivery` that `webhookEndpoints.sendTest()`
   * resolved to, or its id. A result that is already not `pending` — the 202
   * of a test that could not be queued is already `failed` — comes back at
   * once, with no read. An id is read first. A pending result is read again
   * every `intervalMs` until its status changes.
   *
   *     const test = await client.webhookEndpoints.sendTest(endpoint.id);
   *     const result = await client.webhookTestDeliveries.wait(test);
   *     result.status; // "delivered" or "failed"
   *
   * A 429 on a read with a `Retry-After` sleeps for that long, never less
   * than `intervalMs` and cut to what is left before the deadline, and reads
   * again. The deadline is kept on
   * the monotonic clock (`performance.now()`), so a wall-clock step does not
   * move it.
   *
   * @throws WebhookTestTimeoutError when the result is still `pending` after
   *   `timeoutMs`. Its `delivery` is the last result read.
   * @throws ApiError when a read is refused, other than a 429 with a
   *   `Retry-After` inside the deadline. Nothing is read again after it. A
   *   429 whose wait reaches the deadline is thrown as itself.
   * @throws RangeError for an `intervalMs` (above zero, at most 2^31 - 1) or
   *   a `timeoutMs` (zero or more) that is not a usable number, before any
   *   read.
   */
  async wait(
    delivery: WebhookTestDelivery | string,
    options: WaitForWebhookTestOptions = {},
  ): Promise<WebhookTestDelivery> {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_TIMER_MS) {
      throw new RangeError(
        `intervalMs must be above zero and at most ${MAX_TIMER_MS}, not ${intervalMs}`,
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a finite number, zero or more, not ${timeoutMs}`);
    }

    // The MONOTONIC clock: a wall-clock step (NTP, a laptop waking) must not
    // shorten or stretch the wait.
    const deadline = performance.now() + timeoutMs;
    const id = typeof delivery === "string" ? delivery : delivery.id;
    let last: WebhookTestDelivery | null = typeof delivery === "string" ? null : delivery;
    if (last !== null && last.status !== "pending") {
      return last;
    }

    // How long to sleep before the next read: nothing before the first read
    // of an id, the interval after a pending read, Retry-After after a 429.
    let pause: number | null = last === null ? null : intervalMs;

    for (;;) {
      if (pause !== null) {
        const remaining = deadline - performance.now();
        if (remaining <= 0 && last !== null) {
          throw new WebhookTestTimeoutError(
            `the webhook test ${id} was still pending after ${timeoutMs} ms`,
            last,
          );
        }
        await sleep(Math.max(0, Math.min(pause, remaining)));
      }

      try {
        last = await this.get(id);
      } catch (error) {
        const backoff = rateLimitBackoffMs(error);
        if (backoff === undefined || deadline - performance.now() <= 0) {
          throw error;
        }
        // Never less than the interval: a `Retry-After: 0` would otherwise
        // read again at once, as often as the server answers.
        pause = Math.max(backoff, intervalMs);
        continue;
      }

      if (last.status !== "pending") {
        return last;
      }
      pause = intervalMs;
    }
  }
}

/**
 * The longest delay Node's `setTimeout` holds. A longer one fires after 1 ms
 * instead, which would turn a wait into a hot loop.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The milliseconds a refused read asks `wait()` to sleep, or undefined when
 * the refusal is to be thrown.
 *
 * Only a 429 that names a `Retry-After` is waited out: the API's own rate
 * limit covers these reads, and a few waits at once can reach it. Every other
 * refusal — a 503 included — is thrown, as `get()` throws it.
 */
function rateLimitBackoffMs(error: unknown): number | undefined {
  if (error instanceof ApiError && error.statusCode === 429 && error.retryAfter !== undefined) {
    return error.retryAfter * 1000;
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resume) => {
    setTimeout(resume, Math.min(milliseconds, MAX_TIMER_MS));
  });
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` escapes the value; what this adds is the REFUSAL: an empty
 * id would otherwise turn `/v1/webhook-test-deliveries/{id}` into the whole
 * collection.
 */
function webhookTestDeliveryIdParam(value: string): string {
  return pathSegment(value, "a webhook test id is required");
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
