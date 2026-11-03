/**
 * Text-messaging requests and orders, read with a client credential:
 *
 * - `client.messagingEnablements` — every request to turn text messaging on
 *   for one of your numbers, in flight and historical (`list`, `get`).
 *   Making one needs a person to sign a letter of authorization, so the
 *   create is a personal-access-token request and is not offered here.
 * - `client.hostedMessagingOrders` — orders that bring a number whose calls
 *   another provider carries into your inventory so you can text from it
 *   (`list`, `get`, `create`).
 *
 * Reading needs `numbers:read` or `numbers:messaging` for enablements, and
 * `port-orders:read` for hosted messaging orders. Creating an order needs
 * `port-orders:hosted-messaging`.
 */
import type { components, paths } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import {
  type HostedMessagingOrder,
  type MessagingEnablement,
  type RawJson,
  hostedMessagingOrderFromResource,
  hostedMessagingOrderPageFromDocument,
  isRecord,
  messagingEnablementFromResource,
  messagingEnablementPageFromDocument,
} from "./models.js";
import { type PagePromise, paginate } from "./pagination.js";
import { pathSegment } from "./pathSegment.js";

type EnablementQuery = NonNullable<paths["/v1/messaging-enablements"]["get"]["parameters"]["query"]>;
type OrderQuery = NonNullable<paths["/v1/hosted-messaging-orders"]["get"]["parameters"]["query"]>;
type OrderCreateRequest = components["schemas"]["HostedMessagingOrderCreateRequest"];

/** What `messagingEnablements.list()` accepts. */
export interface ListMessagingEnablementsOptions {
  ids?: string[];
  /** `awaiting_signature`, `scheduled`, `submitted`, `completed` or `failed`. */
  status?: string;
  /** The requests for this number, in E.164 with its `+`. */
  e164?: string;
  /** The requests for this phone number id. */
  phoneNumber?: string;
  sort?: string;
  after?: string;
  before?: string;
  pageSize?: number;
}

/** The `client.messagingEnablements` namespace. */
export class MessagingEnablements {
  constructor(private readonly client: Ringivo) {}

  /** One page of text-messaging requests, newest first. Needs `numbers:read` or `numbers:messaging`. */
  list(
    options: ListMessagingEnablementsOptions = {},
    requestOptions?: RequestOptions,
  ): PagePromise<MessagingEnablement> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/messaging-enablements"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[status]": options.status as EnablementQuery["filter[status]"],
              "filter[e164]": options.e164,
              "filter[phoneNumber]": options.phoneNumber,
              "filter[id][]": options.ids,
            },
          },
        });
        return messagingEnablementPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /** Read one text-messaging request. Needs `numbers:read` or `numbers:messaging`. */
  async get(messagingEnablementId: string, requestOptions?: RequestOptions): Promise<MessagingEnablement> {
    const { data } = await transportOf(this.client)["/v1/messaging-enablements/{enablement}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { enablement: pathSegment(messagingEnablementId, "a messaging enablement id is required") } },
    });
    return messagingEnablementFromResource(dataObject(data));
  }
}

/** What `hostedMessagingOrders.list()` accepts. */
export interface ListHostedMessagingOrdersOptions {
  ids?: string[];
  /** `claimed`, `awaiting_signature`, `submitted` or `failed`. */
  status?: string;
  /** The orders for this number, in E.164 with its `+`. */
  e164?: string;
  sort?: string;
  after?: string;
  before?: string;
  pageSize?: number;
}

/** What `hostedMessagingOrders.create()` accepts. */
export interface CreateHostedMessagingOrderOptions {
  /** The number to bring in, in E.164 with its `+`. */
  e164: string;
  /** The person who will authorize it: they receive the letter to sign. */
  endUser: { name: string; email: string };
  /** The customer the number is for. */
  customer?: string;
}

/** The `client.hostedMessagingOrders` namespace. */
export class HostedMessagingOrders {
  constructor(private readonly client: Ringivo) {}

  /** One page of hosted messaging orders, newest first. Needs `port-orders:read`. */
  list(
    options: ListHostedMessagingOrdersOptions = {},
    requestOptions?: RequestOptions,
  ): PagePromise<HostedMessagingOrder> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/hosted-messaging-orders"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[status]": options.status as OrderQuery["filter[status]"],
              "filter[e164]": options.e164,
              "filter[id][]": options.ids,
            },
          },
        });
        return hostedMessagingOrderPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /** Read one hosted messaging order. Needs `port-orders:read`. */
  async get(hostedMessagingOrderId: string, requestOptions?: RequestOptions): Promise<HostedMessagingOrder> {
    const { data } = await transportOf(this.client)["/v1/hosted-messaging-orders/{hostedMessagingOrder}"].GET({
      ...callOptions(this.client, requestOptions),
      params: {
        path: {
          hostedMessagingOrder: pathSegment(hostedMessagingOrderId, "a hosted messaging order id is required"),
        },
      },
    });
    return hostedMessagingOrderFromResource(dataObject(data));
  }

  /**
   * Bring a number whose calls another provider carries into your inventory
   * so you can text from it. One order makes exactly one number. Sent once,
   * never resent.
   *
   * Needs `port-orders:hosted-messaging`.
   */
  async create(
    options: CreateHostedMessagingOrderOptions,
    requestOptions?: RequestOptions,
  ): Promise<HostedMessagingOrder> {
    const body: OrderCreateRequest = {
      data: {
        type: "hosted-messaging-orders",
        attributes: {
          e164: options.e164,
          endUser: { name: options.endUser.name, email: options.endUser.email },
        },
        ...(options.customer !== undefined
          ? {
              relationships: {
                customer: { data: { type: "customers", id: pathSegment(options.customer, "a customer id is required") } },
              },
            }
          : {}),
      },
    };
    const { data } = await transportOf(this.client)["/v1/hosted-messaging-orders"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      body,
    });
    return hostedMessagingOrderFromResource(dataObject(data));
  }
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
