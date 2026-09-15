/**
 * Your customers: list them, read one.
 *
 * -- READS ONLY, AND AN ACCOUNT-WIDE CREDENTIAL ONLY ------------------------
 * This release lists customers and reads one; there is no write here.
 * `customers:read` rides a credential issued for your whole reseller account.
 * A credential issued for ONE customer never holds it: the scope is dropped
 * from a customer credential when the token is minted.
 *
 * -- WHAT A CUSTOMER ID IS FOR ----------------------------------------------
 * A customer's `id` is what other resources ask for: `customer` on
 * `client.pbx.callRecords.list()`, `pbx.users.list()` and
 * `pbx.devices.list()`, and on `faxAccounts.list()` and `create()`.
 *
 * -- WHAT IS SPEC-TYPED -----------------------------------------------------
 * Both reads go through the `openapi-fetch` client in client.ts, so
 * `src/_generated/schema.d.ts` type-checks their paths, their query members
 * and their response bodies at compile time.
 *
 * -- WHAT THE SPEC DOCUMENTS AND THIS RELEASE DOES NOT EXPOSE ----------------
 * `sort` and `filter[id]` are not options here.
 *
 * `sort`, because no other list in this package takes one: the lists are
 * newest first and walked by cursor, and this one is the same.
 *
 * `filter[id]`, because the spec declares it a plain array, which serialises
 * as a repeated `filter[id]=a&filter[id]=b` — while the server reads a list
 * only from `filter[id][]=a&filter[id][]=b`. Sending the form the server reads
 * would take a serialiser that contradicts the vendored spec. Adding it once
 * the two agree is additive; until then `client.request()` reaches it.
 */
import type { Ringivo } from "./client.js";
import { transportOf } from "./client.js";
import {
  type Customer,
  type CustomerPage,
  type RawJson,
  customerFromResource,
  customerPageFromDocument,
  isRecord,
} from "./models.js";

/** What `customers.list()` accepts. Every member narrows the collection. */
export interface ListCustomersOptions {
  /**
   * The customer whose `code` is exactly this value — the five-character
   * code the platform assigns, which never changes. So this finds one
   * customer, or none.
   */
  code?: string;
  /**
   * Walk forward: the previous page's `CustomerPage.nextCursor`. Cannot be
   * combined with `before`.
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

/** The `client.customers` namespace. */
export class Customers {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of your customers, newest first.
   *
   * `code` finds one customer by its code. A customer's `id` is what the
   * other resources take as `customer` — `client.pbx.callRecords.list()`
   * among them.
   *
   * Needs `customers:read`, which only an account-wide credential holds.
   */
  async list(options: ListCustomersOptions = {}): Promise<CustomerPage> {
    const { data } = await transportOf(this.client)["/v1/customers"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[code]": options.code,
        },
      },
    });

    return customerPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one customer.
   *
   * A customer that is not on your account answers **404** — the same answer
   * an id that names nothing gives, never 403.
   *
   * Needs `customers:read`, which only an account-wide credential holds.
   */
  async get(customerId: string): Promise<Customer> {
    const { data } = await transportOf(this.client)["/v1/customers/{customer}"].GET({
      params: { path: { customer: customerIdParam(customerId) } },
    });

    return customerFromResource(dataObject(data));
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
  if (!value) {
    throw new Error("a customer id is required");
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
