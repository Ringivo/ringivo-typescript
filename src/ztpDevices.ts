/**
 * Phone MAC addresses registered with a vendor's zero-touch redirect
 * service, so a drop-shipped handset finds your provisioning URL the first
 * time it boots.
 *
 *     const device = await client.ztpDevices.create({ mac: "00:15:65:f0:51:7a", customer: customer.id });
 *     // later: device.state is "active", or "failed" with the reason in stateDetail
 *
 * `active` means the redirect is set, not that the phone works: the phone
 * system must also hold a device record for that MAC.
 *
 * The registration is queued, so a create answers `pending`; read the device
 * again until `state` is `active` or `failed`. `retry()` re-drives a failed
 * one after you have acted on its `stateDetail`.
 *
 * Needs `ztp-devices:read` to read and `ztp-devices:write` to change.
 */
import type { components, paths } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import { type RawJson, type ZtpDevice, isRecord, ztpDeviceFromResource, ztpDevicePageFromDocument } from "./models.js";
import { type PagePromise, paginate } from "./pagination.js";
import { pathSegment } from "./pathSegment.js";

type ListQuery = NonNullable<paths["/v1/ztp-devices"]["get"]["parameters"]["query"]>;
type CreateRequest = components["schemas"]["ZtpDeviceCreateRequest"];
type UpdateRequest = components["schemas"]["ZtpDeviceUpdateRequest"];

/** What `ztpDevices.list()` accepts. */
export interface ListZtpDevicesOptions {
  ids?: string[];
  /** The device with this MAC, in any of the accepted spellings. */
  mac?: string;
  /** Only this customer's devices. */
  customer?: string;
  /** `pending`, `provisioning`, `active` or `failed`. */
  state?: string;
  sort?: string;
  after?: string;
  before?: string;
  pageSize?: number;
}

/** What `ztpDevices.create()` accepts. */
export interface CreateZtpDeviceOptions {
  /** `001565f0517a`, `00:15:65:f0:51:7a` or `00-15-65-f0-51-7a`, either case. */
  mac: string;
  /** Your own caption, up to 64 characters. Never sent to the vendor. */
  label?: string | null;
  /**
   * The customer the phone is for. Leave it out to keep the device in your
   * unassigned pool; a customer-scoped credential gets its own customer.
   */
  customer?: string;
}

/** What `ztpDevices.update()` accepts — a SPARSE patch. */
export interface UpdateZtpDeviceOptions {
  label?: string | null;
  /** Another customer's id, or `null` to return the device to your pool. */
  customer?: string | null;
}

/** The `client.ztpDevices` namespace. */
export class ZtpDevices {
  constructor(private readonly client: Ringivo) {}

  /** One page of registered devices, newest first. Needs `ztp-devices:read`. */
  list(options: ListZtpDevicesOptions = {}, requestOptions?: RequestOptions): PagePromise<ZtpDevice> {
    return paginate(
      async (after) => {
        const { data } = await transportOf(this.client)["/v1/ztp-devices"].GET({
          ...callOptions(this.client, requestOptions),
          params: {
            query: {
              "page[after]": after,
              "page[before]": options.before,
              "page[size]": options.pageSize,
              sort: options.sort,
              "filter[mac]": options.mac,
              "filter[customer]": options.customer,
              "filter[state]": options.state as ListQuery["filter[state]"],
              "filter[id][]": options.ids,
            },
          },
        });
        return ztpDevicePageFromDocument(isRecord(data) ? data : {});
      },
      { after: options.after, backward: options.before !== undefined },
    );
  }

  /** Read one device. Needs `ztp-devices:read`. */
  async get(ztpDeviceId: string, requestOptions?: RequestOptions): Promise<ZtpDevice> {
    const { data } = await transportOf(this.client)["/v1/ztp-devices/{ztpDevice}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { ztpDevice: deviceId(ztpDeviceId) } },
    });
    return ztpDeviceFromResource(dataObject(data));
  }

  /**
   * Register a phone MAC. The device answers `pending` while the vendor call
   * is queued. A MAC another company holds is an `UnprocessableEntityError`.
   * Sent once, never resent.
   *
   * Needs `ztp-devices:write`.
   */
  async create(options: CreateZtpDeviceOptions, requestOptions?: RequestOptions): Promise<ZtpDevice> {
    const body: CreateRequest = {
      data: {
        type: "ztp-devices",
        attributes: {
          mac: options.mac,
          ...(options.label !== undefined ? { label: options.label } : {}),
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
    const { data } = await transportOf(this.client)["/v1/ztp-devices"].POST({
      ...callOptions(this.client, requestOptions),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      body,
    });
    return ztpDeviceFromResource(dataObject(data));
  }

  /**
   * Change a device's label, or the customer it is for. A SPARSE PATCH.
   *
   * @throws Error when no member was named.
   *
   * Needs `ztp-devices:write`.
   */
  async update(ztpDeviceId: string, options: UpdateZtpDeviceOptions, requestOptions?: RequestOptions): Promise<ZtpDevice> {
    const id = deviceId(ztpDeviceId);
    if (options.label === undefined && options.customer === undefined) {
      throw new Error("update() needs at least one field to change: label or customer.");
    }
    const body: UpdateRequest = {
      data: {
        type: "ztp-devices",
        id,
        ...(options.label !== undefined ? { attributes: { label: options.label } } : {}),
        ...(options.customer !== undefined
          ? {
              relationships: {
                customer: {
                  data:
                    options.customer === null
                      ? null
                      : { type: "customers", id: pathSegment(options.customer, "a customer id is required") },
                },
              },
            }
          : {}),
      },
    };
    const { data } = await transportOf(this.client)["/v1/ztp-devices/{ztpDevice}"].PATCH({
      ...callOptions(this.client, requestOptions, true),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      params: { path: { ztpDevice: id } },
      body,
    });
    return ztpDeviceFromResource(dataObject(data));
  }

  /**
   * Deregister a device. Its removal from the vendor's service is queued.
   *
   * Needs `ztp-devices:write`.
   */
  async delete(ztpDeviceId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/ztp-devices/{ztpDevice}"].DELETE({
      ...callOptions(this.client, requestOptions),
      params: { path: { ztpDevice: deviceId(ztpDeviceId) } },
    });
  }

  /**
   * Try a `failed` registration again (accepted, 202): the device goes back
   * to `pending`. Any other state is a `ConflictError`. Sent once.
   *
   * Needs `ztp-devices:write`.
   */
  async retry(ztpDeviceId: string, requestOptions?: RequestOptions): Promise<void> {
    await transportOf(this.client)["/v1/ztp-devices/{ztpDevice}/retry"].POST({
      ...callOptions(this.client, requestOptions),
      params: { path: { ztpDevice: deviceId(ztpDeviceId) } },
    });
  }
}

function deviceId(value: string): string {
  return pathSegment(value, "a ZTP device id is required");
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
