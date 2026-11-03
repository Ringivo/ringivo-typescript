/**
 * SIP trunks: a customer's own PBX that sends and receives calls through
 * this platform. Three namespaces, one per resource the API publishes:
 *
 * - `client.sipTrunks` — the trunk itself, and its two audited password
 *   calls;
 * - `client.sipTrunkAddresses` — the address ranges a `static` trunk's calls
 *   are trusted from (the API's `sip-trunk-ips`);
 * - `client.sipTrunkDestinations` — the hosts a trunk's inbound calls are
 *   sent to (the API's `sip-trunk-targets`).
 *
 *     const trunk = await client.sipTrunks.create({
 *       customer: customer.id, name: "Main office", domainLabel: "acme-main",
 *       primaryRegion: "use1", mode: "static",
 *     });
 *     await client.sipTrunkAddresses.create({ sipTrunk: trunk.id, cidr: "203.0.113.10/32" });
 *     await client.sipTrunkDestinations.create({
 *       sipTrunk: trunk.id, host: "pbx.acme.example", transport: "tls", preference: 10, enabled: true,
 *     });
 *     await client.phoneNumbers.route(numberId, { targetType: "sip_trunk", sipTrunk: trunk.id });
 *
 * -- WRITES ARE JSON:API DOCUMENTS -------------------------------------------
 * Every create and update sends `{"data": {"type": ..., "attributes": ...}}`
 * as `application/vnd.api+json`. An update is SPARSE: only the members you
 * pass are sent. `undefined` is "not given"; `null` clears a nullable field.
 *
 * -- WHICH CALLS ARE RESENT ---------------------------------------------------
 * Reads, deletes and the PATCH updates are resent on a transient failure.
 * A create and the two password calls are sent once: the API takes no
 * `Idempotency-Key` on them, and a lost answer may hide a row that was made
 * or a password that was changed.
 *
 * Needs `sip-trunks:read` to read, `sip-trunks:write` to change, and
 * `sip-trunks:admin` for the two password calls.
 */
import type { components, paths } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import {
  type RawJson,
  type SipTrunk,
  type SipTrunkAddress,
  type SipTrunkDestination,
  isRecord,
  sipTrunkAddressFromResource,
  sipTrunkAddressPageFromDocument,
  sipTrunkDestinationFromResource,
  sipTrunkDestinationPageFromDocument,
  sipTrunkFromResource,
  sipTrunkPageFromDocument,
} from "./models.js";
import { type PagePromise, paginate } from "./pagination.js";
import { pathSegment } from "./pathSegment.js";

type TrunkListQuery = NonNullable<paths["/v1/sip-trunks"]["get"]["parameters"]["query"]>;
type TrunkWritable = components["schemas"]["SipTrunkWritableAttributes"];
type TrunkCreateRequest = components["schemas"]["SipTrunkCreateRequest"];
type TrunkUpdateRequest = components["schemas"]["SipTrunkUpdateRequest"];
type AddressCreateRequest = components["schemas"]["SipTrunkIpCreateRequest"];
type AddressUpdateRequest = components["schemas"]["SipTrunkIpUpdateRequest"];
type AddressWritable = components["schemas"]["SipTrunkIpWritableAttributes"];
type DestinationWritable = components["schemas"]["SipTrunkTargetWritableAttributes"];
type DestinationCreateRequest = components["schemas"]["SipTrunkTargetCreateRequest"];
type DestinationUpdateRequest = components["schemas"]["SipTrunkTargetUpdateRequest"];

/** The paging members every list here takes. */
interface PageOptions {
  /** Start after this cursor: a page's `nextCursor`. Cannot be combined with `before`. */
  after?: string;
  /** Read the rows that arrived since a cursor you hold. One page; cannot be combined with `after`. */
  before?: string;
  /** Rows per page. The default is 25 and the ceiling is 100. */
  pageSize?: number;
}

/** What `sipTrunks.list()` accepts. */
export interface ListSipTrunksOptions extends PageOptions {
  /** Several trunks by id in one request. */
  ids?: string[];
  /** Only this customer's trunks. */
  customer?: string;
  /** `static` or `register`. */
  mode?: string;
  enabled?: boolean;
  /** `use1` or `usw1`. */
  region?: string;
  /** A field name with a leading `-` to reverse; newest first by default. */
  sort?: string;
}

/**
 * The settings a trunk takes. Every member is optional on an update; see
 * `CreateSipTrunkOptions` for the ones a create requires.
 */
export interface SipTrunkSettings {
  /** What a person calls the trunk, up to 64 characters. */
  name?: string;
  /** The label that names the trunk's SIP host: a lowercase letter, then letters, digits and `-`. */
  domainLabel?: string;
  /** `use1` or `usw1`. */
  primaryRegion?: string;
  enabled?: boolean;
  /** `static` (calls trusted by source address) or `register` (the PBX signs in). */
  mode?: string;
  /** The sign-in name of a `register` trunk. */
  username?: string | null;
  /** The sign-in password of a `register` trunk, 8 characters or more. Never read back. */
  password?: string | null;
  /** `replace` or `additive`. */
  registrationMode?: string;
  /** Seconds, 60 to 300. */
  registrationExpires?: number;
  /** `US`, `CA`, `MX` or `GB`. */
  localization?: string;
  /** How the caller's number is written on calls to the trunk. */
  aniFormat?: string;
  /** How the dialled number is written on calls to the trunk. */
  dnisFormat?: string;
  /** `us_canada`, `nanp` or `permit_all`. */
  dialPolicy?: string;
  /** `anchored` or `direct`. */
  mediaMode?: string;
  /** `PCMU`, `PCMA` and `G722`, in the order offered. At least one. */
  codecs?: string[];
}

/** What `sipTrunks.create()` accepts. */
export interface CreateSipTrunkOptions extends SipTrunkSettings {
  /** The customer the trunk is for. Fixed for the trunk's life. */
  customer: string;
  name: string;
  domainLabel: string;
  primaryRegion: string;
  mode: string;
}

/** The `client.sipTrunks` namespace. */
export class SipTrunks {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of SIP trunks, newest first.
   *
   * Needs `sip-trunks:read`.
   */
  list(options: ListSipTrunksOptions = {}, requestOptions?: RequestOptions): PagePromise<SipTrunk> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/sip-trunks"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[customer]": options.customer,
              "filter[mode]": options.mode as TrunkListQuery["filter[mode]"],
              "filter[enabled]": options.enabled,
              "filter[region]": options.region as TrunkListQuery["filter[region]"],
              "filter[id][]": options.ids,
            },
          },
        });
        return sipTrunkPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /**
   * Read one SIP trunk. Its `password` is always `null` here.
   *
   * Needs `sip-trunks:read`.
   */
  async get(sipTrunkId: string, requestOptions?: RequestOptions): Promise<SipTrunk> {
    const { data } = await transportOf(this.client)["/v1/sip-trunks/{sipTrunk}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunk: trunkId(sipTrunkId) } },
    });
    return sipTrunkFromResource(dataObject(data));
  }

  /**
   * Create a SIP trunk for one of your customers. Sent once, never resent.
   *
   * Needs `sip-trunks:write`.
   */
  async create(options: CreateSipTrunkOptions, requestOptions?: RequestOptions): Promise<SipTrunk> {
    const attributes = {
      ...trunkAttributes(options),
      name: options.name,
      domainLabel: options.domainLabel,
      primaryRegion: options.primaryRegion as TrunkWritable["primaryRegion"] & string,
      mode: options.mode as NonNullable<TrunkWritable["mode"]>,
    };
    const body: TrunkCreateRequest = {
      data: {
        type: "sip-trunks",
        attributes,
        relationships: {
          customer: { data: { type: "customers", id: pathSegment(options.customer, "a customer id is required") } },
        },
      },
    };
    const { data } = await transportOf(this.client)["/v1/sip-trunks"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      body,
    });
    return sipTrunkFromResource(dataObject(data));
  }

  /**
   * Change a SIP trunk's settings. A SPARSE PATCH: only the members you pass
   * are sent.
   *
   * @throws Error when no member was named.
   *
   * Needs `sip-trunks:write`.
   */
  async update(sipTrunkId: string, options: SipTrunkSettings, requestOptions?: RequestOptions): Promise<SipTrunk> {
    const id = trunkId(sipTrunkId);
    const attributes = trunkAttributes(options);
    refuseEmpty(attributes, "a SIP trunk");
    const body: TrunkUpdateRequest = { data: { type: "sip-trunks", id, attributes } };
    const { data } = await transportOf(this.client)["/v1/sip-trunks/{sipTrunk}"].PATCH({
      ...callOptions(this.client, requestOptions, true),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      params: { path: { sipTrunk: id } },
      body,
    });
    return sipTrunkFromResource(dataObject(data));
  }

  /**
   * Delete a SIP trunk, with its addresses and destinations.
   *
   * Needs `sip-trunks:write`.
   */
  async delete(sipTrunkId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/sip-trunks/{sipTrunk}"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunk: trunkId(sipTrunkId) } },
    });
  }

  /**
   * The trunk with its live `password`. AUDITED: your account's history
   * records who asked and when. Sent once, never resent.
   *
   * Needs `sip-trunks:admin`.
   */
  async revealPassword(sipTrunkId: string, requestOptions?: RequestOptions): Promise<SipTrunk> {
    const { data } = await transportOf(this.client)["/v1/sip-trunks/{sipTrunk}/reveal-password"].POST({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunk: trunkId(sipTrunkId) } },
    });
    return sipTrunkFromResource(dataObject(data));
  }

  /**
   * Replace the trunk's password with a new generated one, and answer it
   * once in `password`. The old password stops working. AUDITED, and sent
   * once, never resent: a lost answer would leave a password nobody holds.
   *
   * Needs `sip-trunks:admin`.
   */
  async regeneratePassword(sipTrunkId: string, requestOptions?: RequestOptions): Promise<SipTrunk> {
    const { data } = await transportOf(this.client)["/v1/sip-trunks/{sipTrunk}/regenerate-password"].POST({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunk: trunkId(sipTrunkId) } },
    });
    return sipTrunkFromResource(dataObject(data));
  }

  /**
   * One page of this trunk's trusted address ranges.
   *
   * Needs `sip-trunks:read`.
   */
  addresses(
    sipTrunkId: string,
    options: PageOptions & { ids?: string[] } = {},
    requestOptions?: RequestOptions,
  ): PagePromise<SipTrunkAddress> {
    const id = trunkId(sipTrunkId);
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/sip-trunks/{sipTrunk}/sip-trunk-ips"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            path: { sipTrunk: id },
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              "filter[id][]": options.ids,
            },
          },
        });
        return sipTrunkAddressPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /**
   * One page of this trunk's destinations.
   *
   * Needs `sip-trunks:read`.
   */
  destinations(
    sipTrunkId: string,
    options: PageOptions & { ids?: string[] } = {},
    requestOptions?: RequestOptions,
  ): PagePromise<SipTrunkDestination> {
    const id = trunkId(sipTrunkId);
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/sip-trunks/{sipTrunk}/sip-trunk-targets"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            path: { sipTrunk: id },
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              "filter[id][]": options.ids,
            },
          },
        });
        return sipTrunkDestinationPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }
}

/** What `sipTrunkAddresses.list()` accepts. */
export interface ListSipTrunkAddressesOptions extends PageOptions {
  ids?: string[];
  /** Only this trunk's addresses. */
  sipTrunk?: string;
  sort?: string;
}

/** What `sipTrunkAddresses.create()` accepts. */
export interface CreateSipTrunkAddressOptions {
  /** The trunk the range belongs to. */
  sipTrunk: string;
  /** An IPv4 address or CIDR range, such as `203.0.113.10/32`. */
  cidr: string;
  /** Your own note about the address, up to 64 characters — "Dallas office". */
  description?: string | null;
}

/** What `sipTrunkAddresses.update()` accepts — a SPARSE patch. `null` clears the description. */
export interface UpdateSipTrunkAddressOptions {
  cidr?: string;
  description?: string | null;
}

/** The `client.sipTrunkAddresses` namespace — the API's `sip-trunk-ips`. */
export class SipTrunkAddresses {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of trusted address ranges, across your trunks or one of them.
   *
   * Needs `sip-trunks:read`.
   */
  list(options: ListSipTrunkAddressesOptions = {}, requestOptions?: RequestOptions): PagePromise<SipTrunkAddress> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/sip-trunk-ips"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[sipTrunk]": options.sipTrunk,
              "filter[id][]": options.ids,
            },
          },
        });
        return sipTrunkAddressPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /** Read one address range. Needs `sip-trunks:read`. */
  async get(sipTrunkAddressId: string, requestOptions?: RequestOptions): Promise<SipTrunkAddress> {
    const { data } = await transportOf(this.client)["/v1/sip-trunk-ips/{sipTrunkIp}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunkIp: addressId(sipTrunkAddressId) } },
    });
    return sipTrunkAddressFromResource(dataObject(data));
  }

  /** Trust one more address range on a trunk. Sent once. Needs `sip-trunks:write`. */
  async create(options: CreateSipTrunkAddressOptions, requestOptions?: RequestOptions): Promise<SipTrunkAddress> {
    const body: AddressCreateRequest = {
      data: {
        type: "sip-trunk-ips",
        attributes: {
          cidr: options.cidr,
          ...(options.description !== undefined ? { description: options.description } : {}),
        },
        relationships: {
          sipTrunk: { data: { type: "sip-trunks", id: trunkId(options.sipTrunk) } },
        },
      },
    };
    const { data } = await transportOf(this.client)["/v1/sip-trunk-ips"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      body,
    });
    return sipTrunkAddressFromResource(dataObject(data));
  }

  /**
   * Change an address range or its description. A SPARSE PATCH.
   *
   * @throws Error when no member was named.
   *
   * Needs `sip-trunks:write`.
   */
  async update(
    sipTrunkAddressId: string,
    options: UpdateSipTrunkAddressOptions,
    requestOptions?: RequestOptions,
  ): Promise<SipTrunkAddress> {
    const id = addressId(sipTrunkAddressId);
    const attributes: AddressWritable = {};
    if (options.cidr !== undefined) attributes.cidr = options.cidr;
    if (options.description !== undefined) attributes.description = options.description;
    refuseEmpty(attributes, "a SIP trunk address");
    const body: AddressUpdateRequest = { data: { type: "sip-trunk-ips", id, attributes } };
    const { data } = await transportOf(this.client)["/v1/sip-trunk-ips/{sipTrunkIp}"].PATCH({
      ...callOptions(this.client, requestOptions, true),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      params: { path: { sipTrunkIp: id } },
      body,
    });
    return sipTrunkAddressFromResource(dataObject(data));
  }

  /** Stop trusting an address range. Needs `sip-trunks:write`. */
  async delete(sipTrunkAddressId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/sip-trunk-ips/{sipTrunkIp}"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunkIp: addressId(sipTrunkAddressId) } },
    });
  }
}

/** What `sipTrunkDestinations.list()` accepts. */
export interface ListSipTrunkDestinationsOptions extends PageOptions {
  ids?: string[];
  /** Only this trunk's destinations. */
  sipTrunk?: string;
  enabled?: boolean;
  sort?: string;
}

/** The settings a destination takes. Every member is optional on an update. */
export interface SipTrunkDestinationSettings {
  /** A host name or IP address, up to 253 characters. */
  host?: string;
  /** 1 to 65535; `null` uses the transport's default port. */
  port?: number | null;
  /** `udp`, `tcp` or `tls`. */
  transport?: string;
  /** 0 to 1000; lower is tried first. */
  preference?: number;
  enabled?: boolean;
}

/** What `sipTrunkDestinations.create()` accepts. */
export interface CreateSipTrunkDestinationOptions extends SipTrunkDestinationSettings {
  /** The trunk the destination belongs to. */
  sipTrunk: string;
  host: string;
  transport: string;
  preference: number;
  enabled: boolean;
}

/** The `client.sipTrunkDestinations` namespace — the API's `sip-trunk-targets`. */
export class SipTrunkDestinations {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of destinations, across your trunks or one of them.
   *
   * Needs `sip-trunks:read`.
   */
  list(
    options: ListSipTrunkDestinationsOptions = {},
    requestOptions?: RequestOptions,
  ): PagePromise<SipTrunkDestination> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/sip-trunk-targets"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[sipTrunk]": options.sipTrunk,
              "filter[enabled]": options.enabled,
              "filter[id][]": options.ids,
            },
          },
        });
        return sipTrunkDestinationPageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /** Read one destination. Needs `sip-trunks:read`. */
  async get(sipTrunkDestinationId: string, requestOptions?: RequestOptions): Promise<SipTrunkDestination> {
    const { data } = await transportOf(this.client)["/v1/sip-trunk-targets/{sipTrunkTarget}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunkTarget: destinationId(sipTrunkDestinationId) } },
    });
    return sipTrunkDestinationFromResource(dataObject(data));
  }

  /** Add a destination to a trunk. Sent once. Needs `sip-trunks:write`. */
  async create(
    options: CreateSipTrunkDestinationOptions,
    requestOptions?: RequestOptions,
  ): Promise<SipTrunkDestination> {
    const attributes = {
      ...destinationAttributes(options),
      host: options.host,
      transport: options.transport as NonNullable<DestinationWritable["transport"]>,
      preference: options.preference,
      enabled: options.enabled,
    };
    const body: DestinationCreateRequest = {
      data: {
        type: "sip-trunk-targets",
        attributes,
        relationships: {
          sipTrunk: { data: { type: "sip-trunks", id: trunkId(options.sipTrunk) } },
        },
      },
    };
    const { data } = await transportOf(this.client)["/v1/sip-trunk-targets"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      body,
    });
    return sipTrunkDestinationFromResource(dataObject(data));
  }

  /**
   * Change a destination. A SPARSE PATCH.
   *
   * @throws Error when no member was named.
   *
   * Needs `sip-trunks:write`.
   */
  async update(
    sipTrunkDestinationId: string,
    options: SipTrunkDestinationSettings,
    requestOptions?: RequestOptions,
  ): Promise<SipTrunkDestination> {
    const id = destinationId(sipTrunkDestinationId);
    const attributes = destinationAttributes(options);
    refuseEmpty(attributes, "a SIP trunk destination");
    const body: DestinationUpdateRequest = { data: { type: "sip-trunk-targets", id, attributes } };
    const { data } = await transportOf(this.client)["/v1/sip-trunk-targets/{sipTrunkTarget}"].PATCH({
      ...callOptions(this.client, requestOptions, true),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      params: { path: { sipTrunkTarget: id } },
      body,
    });
    return sipTrunkDestinationFromResource(dataObject(data));
  }

  /** Remove a destination. Needs `sip-trunks:write`. */
  async delete(sipTrunkDestinationId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/sip-trunk-targets/{sipTrunkTarget}"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { sipTrunkTarget: destinationId(sipTrunkDestinationId) } },
    });
  }
}

/** The members the caller named, `null` kept and `undefined` dropped. */
function trunkAttributes(options: SipTrunkSettings): TrunkWritable {
  const attributes: Record<string, unknown> = {};
  for (const key of [
    "name",
    "domainLabel",
    "primaryRegion",
    "enabled",
    "mode",
    "username",
    "password",
    "registrationMode",
    "registrationExpires",
    "localization",
    "aniFormat",
    "dnisFormat",
    "dialPolicy",
    "mediaMode",
  ] as const) {
    if (options[key] !== undefined) {
      attributes[key] = options[key];
    }
  }
  if (options.codecs !== undefined) {
    attributes.codecs = [...options.codecs];
  }
  return attributes as TrunkWritable;
}

function destinationAttributes(options: SipTrunkDestinationSettings): DestinationWritable {
  const attributes: Record<string, unknown> = {};
  for (const key of ["host", "port", "transport", "preference", "enabled"] as const) {
    if (options[key] !== undefined) {
      attributes[key] = options[key];
    }
  }
  return attributes as DestinationWritable;
}

function refuseEmpty(attributes: object, what: string): void {
  if (Object.keys(attributes).length === 0) {
    throw new Error(`update() needs at least one field to change on ${what}.`);
  }
}

function trunkId(value: string): string {
  return pathSegment(value, "a SIP trunk id is required");
}

function addressId(value: string): string {
  return pathSegment(value, "a SIP trunk address id is required");
}

function destinationId(value: string): string {
  return pathSegment(value, "a SIP trunk destination id is required");
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
