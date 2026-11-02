/**
 * The numbers in your inventory: list them, read one, give one to a
 * customer, and point it at that customer's phone system, fax account or SIP
 * trunk.
 *
 *     const [number] = (await client.phoneNumbers.list({ e164: "+13025550100" })).data;
 *     await client.phoneNumbers.assign(number.id, customer.id);
 *     await client.phoneNumbers.route(number.id); // to the customer's phone system
 *
 * -- TWO AXES, TWO VERBS -----------------------------------------------------
 * WHO holds a number (`assign()`/`unassign()`, `numbers:assign`) and WHERE
 * its calls go (`route()`/`unroute()`, `numbers:route`) are separate, so a
 * credential can be given one and not the other. Assignment comes first: a
 * number nobody holds cannot be routed. Nothing moves in one call — moving a
 * routed number to another customer is unroute, unassign, assign, route, in
 * that order, and the gap in the middle is real.
 *
 * -- NONE OF THESE IS RESENT --------------------------------------------------
 * The four verbs are POSTs and DELETEs whose second attempt answers a 409
 * (already assigned, already routed) or a 404 rather than the first answer.
 * The two DELETEs are resent on a transient failure like every DELETE; read a
 * 409 or 404 after one as "already done".
 *
 * -- WHICH CUSTOMER HOLDS IT --------------------------------------------------
 * Both reads ask for `include=customer`, so `customerId` is always known:
 * the customer's id, or `null` while the number is in your own pool.
 */
import type { components } from "./_generated/schema.js";
import { JSON_MEDIA_TYPE, type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import {
  type PhoneNumber,
  type PhoneNumberStatus,
  type RawJson,
  isRecord,
  phoneNumberFromResource,
  phoneNumberPageFromDocument,
} from "./models.js";
import { type PagePromise, paginate } from "./pagination.js";
import { pathSegment } from "./pathSegment.js";

/** What `phoneNumbers.list()` accepts. */
export interface ListPhoneNumbersOptions {
  /** Several numbers by id in one request. An empty list narrows nothing. */
  ids?: string[];
  /** The number whose E.164 form is exactly this, with its `+`: finds one number, or none. */
  e164?: string;
  /** The numbers in this state. */
  status?: PhoneNumberStatus;
  /**
   * `createdAt`, `e164` or `id`, with a leading `-` to reverse. Newest first
   * (`-createdAt,-id`) by default.
   */
  sort?: string;
  /** Start after this cursor: a page's `nextCursor`. Cannot be combined with `before`. */
  after?: string;
  /** Read the rows that arrived since a cursor you hold. One page; cannot be combined with `after`. */
  before?: string;
  /** Rows per page. The default is 25 and the ceiling is 100. */
  pageSize?: number;
}

/**
 * Where `phoneNumbers.route()` points a number. Always one of the number's
 * own customer's destinations: a customer has one phone system, so `pbx`
 * names nothing more.
 */
export type RouteTarget =
  | { targetType: "pbx" }
  | { targetType: "fax"; faxAccount: string }
  | { targetType: "sip_trunk"; sipTrunk: string };

type ListQuery = NonNullable<components["parameters"]["PhoneNumberInclude"]>;
type RouteRequest = components["schemas"]["PhoneNumberRouteRequest"];

const INCLUDE_CUSTOMER: ListQuery = "customer";

/** The `client.phoneNumbers` namespace. */
export class PhoneNumbers {
  constructor(private readonly client: Ringivo) {}

  /**
   * Your numbers, newest first: the ones in your pool and the ones you gave a
   * customer. A credential issued for one customer sees only that customer's.
   *
   * Needs `numbers:read`.
   */
  list(options: ListPhoneNumbersOptions = {}, requestOptions?: RequestOptions): PagePromise<PhoneNumber> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/phone-numbers"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[e164]": options.e164,
              "filter[status]": options.status as "pending" | "active" | "failed" | "releasing" | undefined,
              "filter[id][]": options.ids,
              include: INCLUDE_CUSTOMER,
            },
          },
        });
        return phoneNumberPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /**
   * Read one number. One you just bought reads `pending` until the carrier
   * activates it, then `active`. A number that is not yours answers 404.
   *
   * Needs `numbers:read`.
   */
  async get(phoneNumberId: string, requestOptions?: RequestOptions): Promise<PhoneNumber> {
    const { data } = await transportOf(this.client)["/v1/phone-numbers/{phoneNumber}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { phoneNumber: idParam(phoneNumberId) }, query: { include: INCLUDE_CUSTOMER } },
    });
    return phoneNumberFromResource(dataObject(data));
  }

  /**
   * Give a number from your pool to one of your customers. Nothing is
   * ordered and no carrier is told: it is your bookkeeping, true when this
   * resolves. A `ConflictError` when the number already belongs to a
   * customer (`Already assigned`; take it back first) or is neither
   * `pending` nor `active` (`Not assignable`). A credential issued for one
   * customer cannot assign (403).
   *
   * Needs `numbers:assign`.
   */
  async assign(phoneNumberId: string, customerId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/phone-numbers/{phoneNumber}/customer"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSON_MEDIA_TYPE },
      params: { path: { phoneNumber: idParam(phoneNumberId) } },
      body: { customerId: pathSegment(customerId, "a customer id is required") },
    });
  }

  /**
   * Take a number back from its customer, into your pool. A `ConflictError`
   * names the state that refuses it — `Not assigned`, `Still routed`
   * (`unroute()` it first), `Still in the PBX`, `Still registered for e911` —
   * and its `detail` names the step that clears it.
   *
   * Needs `numbers:assign`.
   */
  async unassign(phoneNumberId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/phone-numbers/{phoneNumber}/customer"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { phoneNumber: idParam(phoneNumberId) } },
    });
  }

  /**
   * Point a number at one of its customer's destinations: the phone system
   * when `target` is left out. It is routed when this resolves.
   *
   * The number must already belong to a customer, and a phone system route
   * needs that customer's phone system to be built (`customers.waitForPbx()`):
   * otherwise a `ConflictError` titled `Not routable`. A number that already
   * routes is `Already routed`: `unroute()` it first. A destination id that
   * is not that customer's is an `UnprocessableEntityError`.
   *
   * A phone system route makes the number's calls REACH the phone system;
   * it does not make them ring anyone. The phone system must also know the
   * number (the portal's "Add to PBX" — there is no request for it this
   * credential can make yet), and the number must be pointed at a user or an
   * auto attendant in the phone system itself.
   *
   * Needs `numbers:route`.
   */
  async route(
    phoneNumberId: string,
    target: RouteTarget = { targetType: "pbx" },
    requestOptions?: RequestOptions,
  ): Promise<void> {
    // FLAT JSON. A phone-system route sends no body at all, which is the
    // documented spelling; the other two name their destination's id.
    let body: RouteRequest | undefined;
    if (target.targetType === "fax") {
      body = { targetType: "fax", faxAccount: target.faxAccount };
    } else if (target.targetType === "sip_trunk") {
      body = { targetType: "sip_trunk", sipTrunk: target.sipTrunk };
    }

    await transportOf(this.client)["/v1/phone-numbers/{phoneNumber}/routing"].POST({
      ...callOptions(this.client, requestOptions),
      params: { path: { phoneNumber: idParam(phoneNumberId) } },
      ...(body === undefined ? {} : { body, headers: { "Content-Type": JSON_MEDIA_TYPE } }),
    });
  }

  /**
   * Stop a number pointing anywhere. Calls to it stop ringing at the edge's
   * next reconcile.
   *
   * Needs `numbers:route`.
   */
  async unroute(phoneNumberId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/phone-numbers/{phoneNumber}/routing"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { phoneNumber: idParam(phoneNumberId) } },
    });
  }
}

function idParam(value: string): string {
  return pathSegment(value, "a phone number id is required");
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
