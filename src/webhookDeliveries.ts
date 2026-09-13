/**
 * Read what we could NOT deliver.
 *
 * -- THIS IS EVIDENCE, NOT A HISTORY ----------------------------------------
 * A delivery that reaches your endpoint leaves nothing here. Only failures are
 * recorded: a row appears when an attempt fails, moves along the retry ladder,
 * and is REMOVED the moment a later attempt succeeds. So the collection
 * answers one question — what do we still owe you, and what did we give up on?
 *
 * `list({ status: "dead" })` is the query it exists for. Delivery is
 * at-least-once with a dead-letter, so "we tried and gave up" is a state that
 * is reached without your server ever hearing about it; this is where you
 * learn what an outage cost you. `pending` is everything still on the ladder,
 * and there is NO `delivered` — see `ListWebhookDeliveriesOptions.status`.
 *
 * For proof that one specific event arrived, use your own receipt instead:
 * every POST carries a `Ringivo-Event-Id`, and the resource it was about can
 * be refetched. The body we POSTed is never published here either — only its
 * `payloadSha256`, so an integrator who kept what they received can prove it
 * is what we sent.
 *
 * -- EVERYTHING HERE IS SPEC-TYPED ------------------------------------------
 * Both calls are reads through the `openapi-fetch` client in client.ts, so
 * `src/_generated/schema.d.ts` type-checks their paths, their query members
 * and their response bodies at compile time. There is no write on this
 * collection at all: a delivery is the platform's own record.
 */
import type { paths } from "./_generated/schema.js";
import { type Ringivo, transportOf } from "./client.js";
import {
  type RawJson,
  type WebhookDelivery,
  type WebhookDeliveryPage,
  isRecord,
  webhookDeliveryFromResource,
  webhookDeliveryPageFromDocument,
} from "./models.js";

/**
 * The query the spec publishes for `GET /v1/webhook-deliveries`.
 *
 * Used to cast the one member whose spec type is an ENUM while this client's
 * own option is a `string` — `eventType`. Deliberate, and it matches
 * `WebhookDelivery.eventType`: an event the platform publishes tomorrow must
 * be filterable today, without waiting for a regenerate and a release.
 *
 * `status` is NOT cast, because it is not widened — see the option's own note.
 *
 * Local and unexported: nothing generated crosses the public boundary.
 */
type ListWebhookDeliveriesQuery = NonNullable<
  paths["/v1/webhook-deliveries"]["get"]["parameters"]["query"]
>;

/** What `webhookDeliveries.list()` accepts. Every member narrows the list. */
export interface ListWebhookDeliveriesOptions {
  /** Only the deliveries of this one endpoint, by its id. */
  endpoint?: string;
  /** One event name, e.g. `fax.received`. */
  eventType?: string;
  /**
   * `pending` is still on the retry ladder; `dead` ran out of rungs and is
   * what an outage costs you.
   *
   * **THERE IS NO `delivered`, and this option is narrow on purpose.** A
   * delivery that lands leaves no row at all, so the state does not exist
   * here — and the API refuses `filter[status]=delivered` with a **400**
   * rather than ignoring it, because this collection used to publish that
   * value. Widening this member to `string`, the way `eventType` above is
   * widened, would invite exactly the one value the server answers 400 to.
   */
  status?: "pending" | "dead";
  /**
   * Walk forward: the previous page's `WebhookDeliveryPage.nextCursor`.
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

/** The `client.webhookDeliveries` namespace. */
export class WebhookDeliveries {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of failed deliveries, newest first.
   *
   * `list({ status: "dead" })` is what you read after an outage: the
   * deliveries we gave up on, which your server never heard about. `pending`
   * is what is still owed to you.
   *
   * Needs `webhooks:read`. A delivery borrows its endpoint's reach, so a
   * `fax:read` token lists only the deliveries of **fax-account-scoped**
   * endpoints.
   */
  async list(options: ListWebhookDeliveriesOptions = {}): Promise<WebhookDeliveryPage> {
    const { data } = await transportOf(this.client)["/v1/webhook-deliveries"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[endpoint]": options.endpoint,
          "filter[event_type]": options.eventType as ListWebhookDeliveriesQuery["filter[event_type]"],
          "filter[status]": options.status,
        },
      },
    });

    return webhookDeliveryPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one failed delivery.
   *
   * An id that has been removed answers 404 — and a row is removed as soon as
   * a later attempt succeeds, so a 404 here is as likely to be good news as
   * an id that never existed.
   *
   * Needs `webhooks:read`. A delivery borrows its endpoint's reach, so a
   * `fax:read` token reaches only the deliveries of **fax-account-scoped**
   * endpoints; any other answers 404 to it.
   */
  async get(webhookDeliveryId: string): Promise<WebhookDelivery> {
    const { data } = await transportOf(this.client)[
      "/v1/webhook-deliveries/{webhookDelivery}"
    ].GET({
      params: { path: { webhookDelivery: webhookDeliveryIdParam(webhookDeliveryId) } },
    });

    return webhookDeliveryFromResource(dataObject(data));
  }
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so `/`
 * is already `%2F` by the time the URL is built. What this adds is the
 * REFUSAL: an empty id would otherwise collapse
 * `/v1/webhook-deliveries/{webhookDelivery}` into `/v1/webhook-deliveries`,
 * which is the whole collection rather than the row somebody asked for.
 */
function webhookDeliveryIdParam(value: string): string {
  if (!value) {
    throw new Error("a webhook delivery id is required");
  }
  return value;
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
