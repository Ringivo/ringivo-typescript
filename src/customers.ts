/**
 * Your customers: list them, read one, create one, change one, delete one,
 * and give one a phone system or take it away.
 *
 *     const [us] = await client.regions.list();
 *     const customer = await client.customers.create({
 *       name: "Acme Dental",
 *       country: "US",
 *       addressLines: ["233 S Wacker Dr"],
 *       city: "Chicago",
 *       region: "IL",
 *       postalCode: "60606",
 *       timeZone: "America/Chicago",
 *       dataResidencyCountry: us.country,
 *       regionPreference: "partner_default",
 *     });
 *     await client.customers.enablePbx(customer.id, { domainLabel: "acme-dental" });
 *     const ready = await client.customers.waitForPbx(customer.id);
 *
 * -- AN ACCOUNT-WIDE CREDENTIAL ONLY -----------------------------------------
 * `customers:read` and `customers:write` ride a credential issued for your
 * whole reseller account. A credential issued for ONE customer never holds
 * either: the scopes are dropped from it when the token is minted.
 *
 * -- WHAT A CUSTOMER ID IS FOR ----------------------------------------------
 * A customer's `id` is what other resources ask for: `customer` on
 * `client.pbx.callRecords.list()`, `pbx.subscribers.list()` and
 * `pbx.devices.list()`, on `faxAccounts.list()` and `create()`, and the
 * customer `phoneNumbers.assign()` gives a number to.
 *
 * -- A CUSTOMER AND ITS PHONE SYSTEM ARE TWO REQUESTS -----------------------
 * `create()` is synchronous and answers the customer, with no phone system.
 * `enablePbx()` starts building one, which finishes in the background; the
 * customer's `provisioningState` says where that stands, and `waitForPbx()`
 * reads it until it is `active` or `failed`. The API keeps the two apart so
 * that one status code means one thing: 201 for the create, 202 for the
 * queued build.
 *
 * -- WHAT IS SPEC-TYPED -----------------------------------------------------
 * Every call goes through the `openapi-fetch` client in client.ts, so
 * `src/_generated/schema.d.ts` type-checks the paths, the query members, the
 * request bodies and the response bodies at compile time.
 *
 * -- WHAT IS RESENT --------------------------------------------------------
 * `create()` and `enablePbx()` are sent once: the API takes no
 * `Idempotency-Key` on either, so a lost answer may hide a customer that was
 * made, and a second POST would make another (or answer 409). Look the
 * customer up before you send a create again. `update()`, `delete()` and
 * `removePbx()` are resent on a transient failure, like every read. A resent
 * DELETE whose first attempt did land answers 404 (`delete()`) or 409 `No
 * phone system` (`removePbx()`): read either as "already done".
 *
 * -- WHY `ids` NEEDS NO SERIALISER OF ITS OWN -------------------------------
 * The spec names the parameter `filter[id][]`, brackets and all, and the
 * server reads a list only from the repeated `filter[id][]=a&filter[id][]=b`.
 * `openapi-fetch` writes one `name=value` pair per element, leaves the name's
 * brackets unescaped, and drops an EMPTY array before the query is built, so
 * `ids: []` sends no parameter. customers.test.ts asserts all of that against
 * the RAW query string.
 */
import { JSONAPI_MEDIA_TYPE, JSON_MEDIA_TYPE, type Ringivo, callOptions, type RequestOptions, transportOf } from "./client.js";
import type { components } from "./_generated/schema.js";
import { PbxProvisioningTimeoutError, RequestAbortedError } from "./errors.js";
import {
  type Customer,
  type RawJson,
  type RegionPreference,
  type SipTransport,
  customerFromResource,
  customerPageFromDocument,
  isRecord,
} from "./models.js";
import { type PagePromise, paginate } from "./pagination.js";
import { pathSegment } from "./pathSegment.js";

/** What `customers.list()` accepts. Every member narrows the collection. */
export interface ListCustomersOptions {
  /**
   * Several customers by id in one request — the ids `list()` and `get()`
   * hand back. Combines with `code`, which narrows the same page further.
   * An empty list asks for nothing and narrows nothing, exactly as leaving
   * this out does.
   */
  ids?: string[];
  /**
   * The customer whose `code` is exactly this value. A code is unique on the
   * platform, so this finds one customer, or none.
   */
  code?: string;
  /**
   * Start after this cursor: a page's `nextCursor`. Cannot be combined with
   * `before`.
   */
  after?: string;
  /**
   * Read the rows that arrived since a cursor you already hold — the polling
   * read. One page; cannot be combined with `after`.
   */
  before?: string;
  /** Rows per page. The default is 25 and the ceiling is 100. */
  pageSize?: number;
}

/** What `customers.create()` takes. */
export interface CreateCustomerOptions {
  /** The customer's name, at most 255 characters. Its `code` is made from it. */
  name: string;
  /** The service address's country, ISO 3166-1 alpha-2 (`US`). */
  country: string;
  /** The service address's street lines, one or two. */
  addressLines: readonly string[];
  /** Send it when you have it: an address without a city is more often refused. */
  city?: string | null;
  /** The state or province (`IL`). */
  region?: string | null;
  postalCode?: string | null;
  /** An IANA time zone name, such as `America/Chicago`. */
  timeZone: string;
  /**
   * The country the customer's data is kept in, ISO 3166-1 alpha-2: one of
   * the countries `regions.list()` answers. It cannot change later.
   */
  dataResidencyCountry: string;
  /** One of the `options` `regions.list()` gives for that country. */
  regionPreference: RegionPreference;
}

/**
 * What `customers.update()` takes: only the members you pass are sent. The
 * phone system settings apply only to a customer that has a phone system.
 */
export interface UpdateCustomerOptions {
  name?: string;
  /** An IANA time zone name. */
  timeZone?: string;
  /** The phone system's residential setting. */
  residential?: boolean;
  /** The most calls at once, 1 to 50. */
  callLimit?: number;
  /** The most external calls at once, 1 to 50, and not more than `callLimit`. */
  callLimitExternal?: number;
  /** The SIP transports to offer, first preferred. At least one, no repeats. */
  transports?: readonly SipTransport[];
}

/**
 * What `customers.enablePbx()` takes. Every member is optional; one you leave
 * out gets the platform's default, shown on each.
 */
export interface EnablePbxOptions {
  /** `false` by default. */
  residential?: boolean;
  /** The most calls at once, 1 to 50. `10` by default. */
  callLimit?: number;
  /** The most external calls at once, 1 to 50, not more than `callLimit`. `10` by default. */
  callLimitExternal?: number;
  /** The SIP transports to offer, first preferred. `["tls", "udp"]` by default. */
  transports?: readonly SipTransport[];
  /**
   * The first label of the phone system domain — the domain the customer's
   * users sign in with. It becomes the customer's
   * `code`, and cannot change after the phone system exists. 3 to 32
   * lowercase letters, digits and hyphens, with no hyphen at either end.
   * Left out, the customer's current `code` is used.
   */
  domainLabel?: string;
}

/** What `customers.waitForPbx()` takes. */
export interface WaitForPbxOptions {
  /** Milliseconds between two reads. 3 seconds by default. */
  intervalMs?: number;
  /** Milliseconds to wait in all before `PbxProvisioningTimeoutError`. 5 minutes by default. */
  timeoutMs?: number;
}

const DEFAULT_WAIT_INTERVAL_MS = 3_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;

type CreateRequest = components["schemas"]["CustomerCreateRequest"];
type UpdateRequest = components["schemas"]["CustomerUpdateRequest"];
type UpdateAttributes = components["schemas"]["CustomerUpdateAttributes"];
type EnableRequest = components["schemas"]["CustomerPbxEnableRequest"];

/** The `client.customers` namespace. */
export class Customers {
  constructor(private readonly client: Ringivo) {}

  /**
   * Your customers, newest first. `await` it for one page; `for await` it for
   * every customer.
   *
   * `ids` reads several customers by id in one request, and combines with
   * `code`. `code` finds one customer by its code.
   *
   * Needs `customers:read`.
   */
  list(options: ListCustomersOptions = {}, requestOptions?: RequestOptions): PagePromise<Customer> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/customers"].GET({
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              "filter[id][]": options.ids,
              "filter[code]": options.code,
            },
          },
          ...callOptions(this.client, requestOptions),
        });

        return customerPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /**
   * Read one customer.
   *
   * A customer that is not on your account answers **404** (`NotFoundError`)
   * — the same answer an id that names nothing gives, never 403.
   *
   * Needs `customers:read`.
   */
  async get(customerId: string, requestOptions?: RequestOptions): Promise<Customer> {
    const { data } = await transportOf(this.client)["/v1/customers/{customer}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { customer: customerIdParam(customerId) } },
    });

    return customerFromResource(dataObject(data));
  }

  /**
   * Create a customer. It has no phone system yet: `pbx` is `false`. Give it
   * one with `enablePbx()`.
   *
   * The service address is validated as one postal address, and the customer
   * keeps the corrected spelling — read `addressLines` off the answer. An
   * address that cannot be confirmed is an `UnprocessableEntityError` whose
   * `errors[0].source.pointer` is `/data/attributes/addressLines` and whose
   * `detail` says what is wrong. A `regionPreference` not legal in
   * `dataResidencyCountry`, and a time zone the phone system does not
   * support, are 422s on their own attributes.
   *
   * SENT ONCE, never resent: the API takes no `Idempotency-Key` here. If the
   * call fails with no answer, look the customer up by name before you send
   * it again.
   *
   * Needs `customers:write`.
   */
  async create(options: CreateCustomerOptions, requestOptions?: RequestOptions): Promise<Customer> {
    const attributes: CreateRequest["data"]["attributes"] = {
      name: options.name,
      country: options.country,
      addressLines: [...options.addressLines],
      timeZone: options.timeZone,
      dataResidencyCountry: options.dataResidencyCountry,
      regionPreference: options.regionPreference as CreateRequest["data"]["attributes"]["regionPreference"],
    };
    // Sent only when named: an absent member is "I do not know", which the
    // address check reads differently from an explicit null.
    if (options.city !== undefined) {
      attributes.city = options.city;
    }
    if (options.region !== undefined) {
      attributes.region = options.region;
    }
    if (options.postalCode !== undefined) {
      attributes.postalCode = options.postalCode;
    }

    const { data } = await transportOf(this.client)["/v1/customers"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      body: { data: { type: "customers", attributes } },
    });

    return customerFromResource(dataObject(data));
  }

  /**
   * Change a customer's `name`, `timeZone`, or its phone system's settings.
   *
   * A SPARSE PATCH: only the members you pass are sent, and every other value
   * stays. When a change touches a value the phone system holds, the phone
   * system is updated in the background, and `provisioningState` shows it.
   * The phone system settings on a customer with no phone system are a 422.
   *
   * @throws Error when no member was named — an empty PATCH changes nothing.
   *
   * Needs `customers:write`.
   */
  async update(
    customerId: string,
    options: UpdateCustomerOptions,
    requestOptions?: RequestOptions,
  ): Promise<Customer> {
    const id = customerIdParam(customerId);
    const attributes: UpdateAttributes = {};
    if (options.name !== undefined) attributes.name = options.name;
    if (options.timeZone !== undefined) attributes.timeZone = options.timeZone;
    if (options.residential !== undefined) attributes.residential = options.residential;
    if (options.callLimit !== undefined) attributes.callLimit = options.callLimit;
    if (options.callLimitExternal !== undefined) attributes.callLimitExternal = options.callLimitExternal;
    if (options.transports !== undefined) attributes.transports = [...options.transports];

    if (Object.keys(attributes).length === 0) {
      throw new Error(
        "update() needs at least one field to change: name, timeZone, residential, " +
          "callLimit, callLimitExternal or transports.",
      );
    }

    const body: UpdateRequest = { data: { type: "customers", id, attributes } };
    const { data } = await transportOf(this.client)["/v1/customers/{customer}"].PATCH({
      // Resendable: setting the same values twice leaves the same values.
      ...callOptions(this.client, requestOptions, true),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      params: { path: { customer: id } },
      body,
    });

    return customerFromResource(dataObject(data));
  }

  /**
   * Delete a customer and, when it has one, its phone system.
   *
   * Accepted (202): the customer is gone from the API when this resolves,
   * and the phone system's domain is removed in the background.
   *
   * REFUSED, and nothing changes, while the phone system is in use — a
   * `ConflictError` whose `errors[0].title` says which: `PBX still holds
   * numbers`, `Phone system not empty` (users or SIP trunks), or `Teardown did
   * not run` (it is being set up right now; try again in a few minutes). An
   * `InternalServerError` with status 502 means the phone system could not be
   * asked; nothing changed.
   *
   * Needs `customers:write`.
   */
  async delete(customerId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/customers/{customer}"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { customer: customerIdParam(customerId) } },
    });
  }

  /**
   * Start building the customer's phone system.
   *
   * Accepted (202): the customer reads `pbx: true` at once, and the phone
   * system is built in the background. `waitForPbx()` waits for it. Every
   * setting is optional; see `EnablePbxOptions` for the defaults.
   *
   * Refused with a `ConflictError` when the customer already has a phone
   * system (`Phone system already enabled`), when the domain label was taken
   * a moment ago (`Domain label unavailable`), or when no phone system can
   * take a customer in its region (`No PBX node available`, `PBX cannot be
   * placed`). A refused setting or a bad `domainLabel` is an
   * `UnprocessableEntityError` whose `source.pointer` names it
   * (`/domainLabel`, `/callLimitExternal`).
   *
   * SENT ONCE, never resent: the API takes no `Idempotency-Key` here.
   *
   * Needs `customers:write`.
   */
  async enablePbx(
    customerId: string,
    options: EnablePbxOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<void> {
    // FLAT JSON, members only when named. The endpoint refuses a JSON:API
    // document (a top-level `data`) with a 400, because its settings would
    // otherwise be ignored — so this is deliberately NOT the shape every
    // other customers call sends.
    const body: EnableRequest = {};
    if (options.residential !== undefined) body.residential = options.residential;
    if (options.callLimit !== undefined) body.callLimit = options.callLimit;
    if (options.callLimitExternal !== undefined) body.callLimitExternal = options.callLimitExternal;
    if (options.transports !== undefined) body.transports = [...options.transports];
    if (options.domainLabel !== undefined) body.domainLabel = options.domainLabel;

    await transportOf(this.client)["/v1/customers/{customer}/pbx"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSON_MEDIA_TYPE },
      params: { path: { customer: customerIdParam(customerId) } },
      body,
    });
  }

  /**
   * Take away the customer's phone system, and keep the customer.
   *
   * Accepted (202): the customer reads `pbx: false` at once, and the domain
   * is removed in the background. Refused with a `ConflictError`, and nothing
   * changes, for the reasons `delete()` gives, and when there is no phone
   * system (`No phone system`).
   *
   * Needs `customers:write`.
   */
  async removePbx(customerId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/customers/{customer}/pbx"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { customer: customerIdParam(customerId) } },
    });
  }

  /**
   * Read the customer until its phone system is built: until
   * `provisioningState` is `active`, or `failed`, which is answered too —
   * check it. A number can be routed to the phone system once it is `active`.
   *
   * It only reads; it never sends `enablePbx()` again.
   *
   * @throws PbxProvisioningTimeoutError when `timeoutMs` passes first; its
   *   `customer` is the last read.
   * @throws Error when the customer has no phone system (`pbx` is `false`):
   *   there is nothing to wait for.
   *
   * Needs `customers:read`.
   */
  async waitForPbx(
    customerId: string,
    options: WaitForPbxOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<Customer> {
    const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError(`intervalMs must be above zero, not ${intervalMs}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a finite number, zero or more, not ${timeoutMs}`);
    }

    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const customer = await this.get(customerId, requestOptions);
      if (customer.pbx !== true) {
        throw new Error(`customer ${customerId} has no phone system: call enablePbx() first`);
      }
      if (customer.provisioningState === "active" || customer.provisioningState === "failed") {
        return customer;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new PbxProvisioningTimeoutError(
          `the phone system of customer ${customerId} was still ${customer.provisioningState ?? "not reported"} after ${timeoutMs} ms`,
          customer,
        );
      }
      await pause(Math.min(intervalMs, remaining), requestOptions?.signal);
    }
  }
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so `/`
 * is already `%2F` by the time the URL is built — an unescaped
 * `../faxes/secret` would normalise ON THE WIRE to a different endpoint, read
 * with this client's token. What this adds is the REFUSAL: an empty id would
 * collapse `/v1/customers/{customer}` into the collection, which answers 200
 * with a page a caller would read as the one row they asked for.
 */
function customerIdParam(value: string): string {
  return pathSegment(value, "a customer id is required");
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}

function pause(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError("the wait was aborted by its signal", { cause: signal.reason }));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RequestAbortedError("the wait was aborted by its signal", { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
