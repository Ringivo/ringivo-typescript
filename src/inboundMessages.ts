/**
 * Read the text and picture messages somebody sent to your numbers.
 *
 *     const page = await client.inboundMessages.list({ number: "+13215550101" });
 *     for (const message of page.messages) {
 *       console.log(message.from, message.body);
 *     }
 *
 * -- THE POLLING HALF OF A PAIR ---------------------------------------------
 * The other half is the `message.received` webhook (`parseMessageEvent()` in
 * webhooks.ts): register an endpoint and your backend is told as each message
 * arrives. Read this collection to catch up on what you missed while your
 * endpoint was down, or instead of a webhook when you have no public callback
 * URL. The webhook's `message.id` is this collection's id, so `get()` reads
 * the message back.
 *
 * -- TWO TIMESTAMPS ---------------------------------------------------------
 * `receivedAt` is when the message was SENT, and `createdAt` is when the
 * platform stored it; they differ by however long a redelivery took. The
 * date filters match `receivedAt`, and the cursor walks `createdAt`.
 *
 * -- ATTACHMENTS ARE DESCRIBED, NEVER CARRIED -------------------------------
 * Each part names its content type, filename, encoding and size. There is no
 * file and no URL: the platform does not keep the bytes, so ask your
 * messaging provider for the file.
 *
 * -- WHAT IS SPEC-TYPED -----------------------------------------------------
 * Both reads go through the `openapi-fetch` client in client.ts, so
 * `src/_generated/schema.d.ts` type-checks their paths, their query members
 * and their response bodies at compile time. `ids` is sent as the repeated
 * `filter[id][]` pair the server reads as a list — customers.ts explains why
 * that needs no serialiser of its own.
 */
import type { Ringivo } from "./client.js";
import { transportOf } from "./client.js";
import {
  type InboundMessage,
  type InboundMessagePage,
  type RawJson,
  inboundMessageFromResource,
  inboundMessagePageFromDocument,
  isRecord,
} from "./models.js";

/** What `inboundMessages.list()` accepts. Every member narrows the collection. */
export interface ListInboundMessagesOptions {
  /** Only messages sent TO this number of yours, in E.164. */
  number?: string;
  /** Only messages from this sender, in E.164. */
  from?: string;
  /** `sms` or `mms`. */
  kind?: "sms" | "mms";
  /**
   * Messages received at or after this instant, ISO-8601. A value that is
   * not a date matches NOTHING rather than being ignored.
   */
  receivedAfter?: string;
  /** Messages received at or before this instant. Both ends are inclusive. */
  receivedBefore?: string;
  /**
   * Several messages by id in one request. An empty list asks for nothing
   * and narrows nothing, exactly as leaving this out does.
   */
  ids?: string[];
  /**
   * Walk forward: the previous page's `InboundMessagePage.nextCursor`.
   * Cannot be combined with `before` — passing both is refused with a 400.
   */
  after?: string;
  /** Walk backward from a cursor you already hold. */
  before?: string;
  /** Rows per page. The default is 25 and the ceiling is 100. */
  pageSize?: number;
}

/**
 * The `client.inboundMessages` namespace. Needs `numbers:read` or
 * `numbers:messaging`.
 */
export class InboundMessages {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of received messages, newest first.
   *
   * Needs `numbers:read` or `numbers:messaging`.
   */
  async list(options: ListInboundMessagesOptions = {}): Promise<InboundMessagePage> {
    const { data } = await transportOf(this.client)["/v1/inbound-messages"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[number]": options.number,
          "filter[from]": options.from,
          "filter[kind]": options.kind,
          "filter[receivedAfter]": options.receivedAfter,
          "filter[receivedBefore]": options.receivedBefore,
          "filter[id][]": options.ids,
        },
      },
    });

    return inboundMessagePageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one received message, exactly as the list serves it.
   *
   * A message sent to a number you do not carry text messaging for is not
   * yours and answers 404.
   *
   * Needs `numbers:read` or `numbers:messaging`.
   */
  async get(inboundMessageId: string): Promise<InboundMessage> {
    const { data } = await transportOf(this.client)["/v1/inbound-messages/{message}"].GET({
      params: { path: { message: inboundMessageIdParam(inboundMessageId) } },
    });

    return inboundMessageFromResource(dataObject(data));
  }
}

/**
 * One path segment, refused when it is empty — the rule of customers.ts's
 * `customerIdParam`. `openapi-fetch` already escapes `/`; an empty id would
 * collapse the path into the collection, which answers 200 with a page.
 */
function inboundMessageIdParam(value: string): string {
  if (!value) {
    throw new Error("an inbound message id is required");
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
