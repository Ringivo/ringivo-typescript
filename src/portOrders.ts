/**
 * Port orders, read with a client credential: `list` and `get`.
 *
 * Every port-order WRITE — create, edit, submit, the documents, the letter
 * of authorization and the end-user link — needs a person: they are
 * personal-access-token requests on the API, so a client credential cannot
 * make them and this package does not offer them.
 *
 * Needs `port-orders:read`.
 */
import type { paths } from "./_generated/schema.js";
import { type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import { type PortOrder, type RawJson, isRecord, portOrderFromResource, portOrderPageFromDocument } from "./models.js";
import { type PagePromise, paginate } from "./pagination.js";
import { pathSegment } from "./pathSegment.js";

type ListQuery = NonNullable<paths["/v1/port-orders"]["get"]["parameters"]["query"]>;

/** What `portOrders.list()` accepts. */
export interface ListPortOrdersOptions {
  ids?: string[];
  /**
   * `draft`, `awaiting_signature`, `awaiting_review`, `submitted`,
   * `foc_assigned`, `completed` or `failed`.
   */
  status?: string;
  sort?: string;
  after?: string;
  before?: string;
  pageSize?: number;
}

/** The `client.portOrders` namespace. */
export class PortOrders {
  constructor(private readonly client: Ringivo) {}

  /** One page of port orders, newest first. Needs `port-orders:read`. */
  list(options: ListPortOrdersOptions = {}, requestOptions?: RequestOptions): PagePromise<PortOrder> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/port-orders"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[status]": options.status as ListQuery["filter[status]"],
              "filter[id][]": options.ids,
            },
          },
        });
        return portOrderPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /** Read one port order. Needs `port-orders:read`. */
  async get(portOrderId: string, requestOptions?: RequestOptions): Promise<PortOrder> {
    const { data } = await transportOf(this.client)["/v1/port-orders/{portOrder}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { portOrder: pathSegment(portOrderId, "a port order id is required") } },
    });
    return portOrderFromResource(dataObject(data));
  }
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
