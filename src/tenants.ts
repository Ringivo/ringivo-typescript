/**
 * Your own account with the provider: read it, and change the brand colors
 * and the support contact your customers see.
 *
 * The tenant id is the one you passed as `tenant` when you built the client.
 *
 * Needs `tenants:read` to read and `tenants:write` to change.
 */
import type { components } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type RequestOptions, type Ringivo, callOptions, transportOf } from "./client.js";
import { type RawJson, type Tenant, isRecord, tenantFromResource } from "./models.js";
import { pathSegment } from "./pathSegment.js";

type UpdateRequest = components["schemas"]["TenantUpdateRequest"];
type WritableAttributes = components["schemas"]["TenantWritableAttributes"];

/**
 * What `tenants.update()` accepts — a SPARSE patch. `null` clears a value.
 */
export interface UpdateTenantOptions {
  /** `#rrggbb`. */
  brandColorPrimary?: string | null;
  /** `#rrggbb`. */
  brandColorAccent?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

/** The `client.tenants` namespace. */
export class Tenants {
  constructor(private readonly client: Ringivo) {}

  /** Read your tenant. Needs `tenants:read`. */
  async get(tenantId: string, requestOptions?: RequestOptions): Promise<Tenant> {
    const { data } = await transportOf(this.client)["/v1/tenants/{tenant}"].GET({
      ...callOptions(this.client, requestOptions),
      params: { path: { tenant: tenantIdParam(tenantId) } },
    });
    return tenantFromResource(dataObject(data));
  }

  /**
   * Change the brand colors or the support contact. A SPARSE PATCH: only the
   * members you pass are sent.
   *
   * @throws Error when no member was named.
   *
   * Needs `tenants:write`.
   */
  async update(tenantId: string, options: UpdateTenantOptions, requestOptions?: RequestOptions): Promise<Tenant> {
    const id = tenantIdParam(tenantId);
    const attributes: WritableAttributes = {};
    if (options.brandColorPrimary !== undefined) attributes.brandColorPrimary = options.brandColorPrimary;
    if (options.brandColorAccent !== undefined) attributes.brandColorAccent = options.brandColorAccent;
    if (options.supportEmail !== undefined) attributes.supportEmail = options.supportEmail;
    if (options.supportPhone !== undefined) attributes.supportPhone = options.supportPhone;
    if (Object.keys(attributes).length === 0) {
      throw new Error(
        "update() needs at least one field to change: brandColorPrimary, brandColorAccent, " +
          "supportEmail or supportPhone. Pass null to clear one — that counts as a change.",
      );
    }

    const body: UpdateRequest = { data: { type: "tenants", id, attributes } };
    const { data } = await transportOf(this.client)["/v1/tenants/{tenant}"].PATCH({
      ...callOptions(this.client, requestOptions, true),
      headers: { "Content-Type": JSONAPI_MEDIA_TYPE },
      params: { path: { tenant: id } },
      body,
    });
    return tenantFromResource(dataObject(data));
  }
}

function tenantIdParam(value: string): string {
  return pathSegment(value, "a tenant id is required");
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
