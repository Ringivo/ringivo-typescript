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
 * process: a sleep between reads, no retry of anything. A refused read (a
 * 404, a 429 from the API's own rate limit) is thrown at once, exactly as
 * `get()` throws it. It never sends a test again.
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
import { WebhookTestTimeoutError } from "./errors.js";
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
   * Milliseconds between two reads. Two seconds by default. Must be a
   * finite number above zero.
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
   * @throws WebhookTestTimeoutError when the result is still `pending` after
   *   `timeoutMs`. Its `delivery` is the last result read.
   * @throws ApiError when a read is refused. Nothing is read again after it.
   * @throws RangeError for an `intervalMs` or a `timeoutMs` that is not a
   *   usable number, before any read.
   */
  async wait(
    delivery: WebhookTestDelivery | string,
    options: WaitForWebhookTestOptions = {},
  ): Promise<WebhookTestDelivery> {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError(`intervalMs must be a finite number above zero, not ${intervalMs}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a finite number, zero or more, not ${timeoutMs}`);
    }

    const deadline = Date.now() + timeoutMs;
    const id = typeof delivery === "string" ? delivery : delivery.id;
    let current = typeof delivery === "string" ? await this.get(id) : delivery;

    while (current.status === "pending") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new WebhookTestTimeoutError(
          `the webhook test ${id} was still pending after ${timeoutMs} ms`,
          current,
        );
      }
      await sleep(Math.min(intervalMs, remaining));
      current = await this.get(id);
    }

    return current;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resume) => {
    setTimeout(resume, milliseconds);
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
