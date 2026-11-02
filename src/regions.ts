/**
 * Where you may place a customer: the values `customers.create()` takes for
 * `dataResidencyCountry` and `regionPreference`.
 *
 *     for (const region of await client.regions.list()) {
 *       console.log(region.country, region.options.map((option) => option.value));
 *     }
 *
 * One entry per country a customer's data may be kept in. The list is about
 * YOUR account: the leading `partner_default` option appears only where your
 * own default region is, and a country where no region can take a customer
 * yet is left out. Not paged — it is a handful of countries — so `list()`
 * answers the whole list.
 */
import { type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import { type Region, isRecord, regionFromResource } from "./models.js";

/** The `client.regions` namespace. */
export class Regions {
  constructor(private readonly client: Ringivo) {}

  /**
   * Every country you may keep a customer's data in, with the primary
   * regions you may choose there.
   *
   * Needs no scope beyond the credential's own reach: it is the vocabulary
   * of a create, and the reseller backend about to create a customer is the
   * caller it exists for.
   */
  async list(requestOptions?: RequestOptions): Promise<readonly Region[]> {
    const { data } = await transportOf(this.client)["/v1/regions"].GET({
      ...callOptions(this.client, requestOptions),
    });
    const resources = isRecord(data) && Array.isArray(data.data) ? data.data : [];
    return Object.freeze(resources.filter(isRecord).map(regionFromResource));
  }
}
