/**
 * Numbers inside your customers' phone systems — the step the portal calls
 * "Add to PBX".
 *
 * A number rings a user or an auto attendant only after two writes:
 * `phoneNumbers.route()` sends its calls to the customer's phone system, and
 * `pbxNumbers.create()` makes the phone system know the number. Then point
 * it at a user or an auto attendant in the phone system itself.
 *
 *     await client.phoneNumbers.route(numberId);              // calls reach the phone system
 *     const added = await client.pbxNumbers.create({ phoneNumberId: numberId }); // the phone system knows it
 *     // later: added.state is "active", or "failed" with the reason in stateDetail
 *
 * The phone-system write is queued, so a create answers `pending`. A failed
 * one is re-driven with `retry()` once you have acted on its `stateDetail`.
 *
 * Needs `numbers:read` to read and `numbers:route` to add, remove or retry.
 * A credential issued for one customer reaches that customer's numbers only.
 */
import type { components, paths } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import { type PbxNumber, type RawJson, isRecord, pbxNumberFromResource, pbxNumberPageFromDocument } from "./models.js";
import { type PagePromise, paginate } from "./pagination.js";
import { pathSegment } from "./pathSegment.js";

type ListQuery = NonNullable<paths["/v1/pbx-numbers"]["get"]["parameters"]["query"]>;
type CreateRequest = components["schemas"]["PbxNumberCreateRequest"];

/** What `pbxNumbers.list()` accepts. */
export interface ListPbxNumbersOptions {
  ids?: string[];
  /** The PBX number of this phone number (its id in `phoneNumbers`). */
  phoneNumber?: string;
  /** `pending`, `provisioning`, `active` or `failed`. */
  state?: string;
  /** `createdAt` or `id`, with a leading `-` to reverse. Newest first by default. */
  sort?: string;
  after?: string;
  before?: string;
  pageSize?: number;
}

/**
 * What `pbxNumbers.create()` accepts. An object rather than a bare id, so a
 * member the API adds later (a destination inside the phone system, say) is
 * a new optional member and not a breaking change.
 */
export interface CreatePbxNumberOptions {
  /** The phone number to add — its id in `phoneNumbers`. */
  phoneNumberId: string;
}

/** The `client.pbxNumbers` namespace. */
export class PbxNumbers {
  constructor(private readonly client: Ringivo) {}

  /** One page of PBX numbers, newest first. Needs `numbers:read`. */
  list(options: ListPbxNumbersOptions = {}, requestOptions?: RequestOptions): PagePromise<PbxNumber> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/pbx-numbers"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[phoneNumber]": options.phoneNumber,
              "filter[state]": options.state as ListQuery["filter[state]"],
              "filter[id][]": options.ids,
            },
          },
        });
        return pbxNumberPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /** Read one PBX number. Needs `numbers:read`. */
  async get(pbxNumberId: string, requestOptions?: RequestOptions): Promise<PbxNumber> {
    const { data } = await transportOf(this.client)["/v1/pbx-numbers/{pbxNumber}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { pbxNumber: idParam(pbxNumberId) } },
    });
    return pbxNumberFromResource(dataObject(data));
  }

  /**
   * Add a phone number to its customer's phone system ("Add to PBX").
   *
   * The number must belong to a customer and be routed to that customer's
   * phone system (`phoneNumbers.route()`), and the phone system must be
   * active. Otherwise a `ConflictError` whose `detail` names the step to take
   * first. A `pending` number (one still porting in) can be added too.
   *
   * Answers the PBX number `pending` while the write is queued. Sent once,
   * never resent: a second add of the same number is a `ConflictError`.
   *
   * Needs `numbers:route`.
   */
  async create(options: CreatePbxNumberOptions, requestOptions?: RequestOptions): Promise<PbxNumber> {
    const body: CreateRequest = {
      data: {
        type: "pbx-numbers",
        relationships: {
          phoneNumber: {
            data: { type: "phone-numbers", id: pathSegment(options.phoneNumberId, "a phone number id is required") },
          },
        },
      },
    };
    const { data } = await transportOf(this.client)["/v1/pbx-numbers"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      body,
    });
    return pbxNumberFromResource(dataObject(data));
  }

  /**
   * Remove a number from its customer's phone system. There is no
   * precondition. The number still routes to the phone system until
   * `phoneNumbers.unroute()`, which is allowed once this is done.
   *
   * Needs `numbers:route`.
   */
  async delete(pbxNumberId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/pbx-numbers/{pbxNumber}"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { pbxNumber: idParam(pbxNumberId) } },
    });
  }

  /**
   * Try a `failed` phone-system write again. The write is queued and the
   * row stays `failed` until it starts; read `state` back. Any other state is
   * a `ConflictError`. Sent once.
   *
   * Needs `numbers:route`.
   */
  async retry(pbxNumberId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/pbx-numbers/{pbxNumber}/retry"].POST({
      ...callOptions(this.client, requestOptions),
      params: { path: { pbxNumber: idParam(pbxNumberId) } },
    });
  }
}

function idParam(value: string): string {
  return pathSegment(value, "a PBX number id is required");
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
