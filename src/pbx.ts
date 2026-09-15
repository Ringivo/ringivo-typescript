/**
 * Your customers' phone systems: who has an extension, what is registered,
 * what was called — and asking somebody's phone to place a call.
 *
 * -- ONE NAMESPACE, THREE COLLECTIONS AND AN ACTION -------------------------
 * `client.pbx.users` are the subscribers, `client.pbx.devices` the SIP
 * registrations they made, and `client.pbx.callRecords` the call log.
 * `client.pbx.users.call()` is the only write on the whole surface: it has a
 * subscriber's phone place a call, so the call goes out as them.
 *
 * They sit under `client.pbx` rather than at the top level because `users`
 * and `devices` are words this API uses elsewhere for other things — a
 * `users` resource is a PERSON with a console login, and a PBX user is an
 * extension on a switch. One namespace keeps the two from reading as the
 * same collection.
 *
 * -- EVERY READ IS SCOPED, AND THERE IS NO UNSCOPED FORM --------------------
 * A `/v1/pbx/` read reaches the PBX domains of the customers your credential
 * may read, and nothing else. A credential that reaches no customer with a
 * phone system is refused with a **400** rather than handed an empty page, so
 * "nobody has a phone system yet" never reads as "nobody has any users".
 * Narrow to one customer with `customer`.
 *
 * -- WHAT IS SPEC-TYPED, AND WHAT IS HAND-BUILT -----------------------------
 * The six reads go through the `openapi-fetch` client in client.ts, so
 * `src/_generated/schema.d.ts` type-checks their paths, their query members
 * and their response bodies at compile time.
 *
 * `users.call()` sends its document through `client.request()` instead, for
 * the one reason `faxAccountUsers.create()` does: a JSON:API resource route
 * answers 415 to the `application/json` a body with no explicit type gets,
 * and the shared transport is built with `Accept` alone. ITS BODY IS
 * SPEC-TYPED ALL THE SAME — the document is declared as the generated
 * `PbxCallRequest`, so a member this package spells wrongly is a compile
 * error rather than a 422 somebody reads out of a log.
 *
 * -- THE WIRE IS KEBAB-CASE HERE --------------------------------------------
 * `/v1/pbx/` attributes and filters are spelled `started-after`,
 * `display-name`, `include-hidden` — not the `camelCase` attributes and
 * `snake_case` filters of the fax surface. That is the API's own spelling for
 * these resources and this module writes it verbatim; the camelCase is on
 * this package's side of the boundary, in src/models.ts.
 */
import type { components } from "./_generated/schema.js";
import type { Ringivo } from "./client.js";
import { JSONAPI_MEDIA_TYPE, transportOf } from "./client.js";
import {
  type CallRecord,
  type CallRecordPage,
  type PbxCall,
  type PbxDevice,
  type PbxDevicePage,
  type PbxUser,
  type PbxUserPage,
  type RawJson,
  callRecordFromResource,
  callRecordPageFromDocument,
  isRecord,
  pbxCallFromResource,
  pbxDeviceFromResource,
  pbxDevicePageFromDocument,
  pbxUserFromResource,
  pbxUserPageFromDocument,
} from "./models.js";

/** What `pbx.callRecords.list()` accepts. Every member narrows the log. */
export interface ListCallRecordsOptions {
  /** Only the calls on this customer's PBX domain. */
  customer?: string;
  /**
   * Calls that started at or after this moment, RFC 3339.
   *
   * **The range decides which months are read at all.** The switch keeps one
   * table per month, so this and `startedBefore` pick the tables that are
   * opened: with no range you get the current and the previous month, and a
   * range wider than 13 months is refused with a 400.
   */
  startedAfter?: string;
  /** Calls that started at or before this moment, RFC 3339. */
  startedBefore?: string;
  /**
   * Which way the call went.
   *
   * **Narrow on purpose.** A word outside this list is refused with a 400
   * rather than answered with an empty page, so widening the option to
   * `string` would invite a value the server will not take. `CallRecord`'s
   * own `direction` IS wide, because the switch may record an integer this
   * API has no word for — the two differ deliberately.
   */
  direction?: "inbound" | "outbound" | "on-net";
  /**
   * Calls with this PBX **user id** on either leg — placed by them or taken
   * by them. The id of a `pbx.users` row, never an extension.
   */
  user?: string;
  /**
   * The records of ONE click-to-dial call: pass the `id` that
   * `pbx.users.call()` returned. The call record appears once the call has
   * ended.
   *
   * **The date range still applies.** The call id is matched only inside the
   * months `startedAfter` and `startedBefore` cover, and with neither that is
   * the current and the previous month. To find an older call, pass a range
   * that covers when it was placed.
   *
   * An empty page means the call has not ended yet, it was placed outside the
   * range, or the id names no call. It is never an error.
   *
   * One call writes two records — the phone system rings the subscriber
   * first, then dials out — and by default the list returns the visible
   * dial-out record. The hidden leg that rang the subscriber comes back only
   * with `includeHidden: true`.
   */
  callId?: string;
  /**
   * Also return the records the phone system marks hidden.
   *
   * They are left out of a list and served on a direct `get()`, which is the
   * asymmetry the phone system's own portal has. Pass `true` to put them back
   * into the list.
   */
  includeHidden?: boolean;
  /**
   * Walk forward: the previous page's `CallRecordPage.nextCursor`. Cannot be
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

/** What `pbx.users.list()` accepts. Every member narrows the collection. */
export interface ListPbxUsersOptions {
  /** Only the subscribers of this customer's PBX domain. */
  customer?: string;
  /** Exact match on the EXTENSION. `101` does not match `1010`. */
  user?: string;
  /**
   * Case-insensitive substring match on the display name, first name, last
   * name or extension — the one parameter behind a directory search box.
   */
  search?: string;
  /**
   * Walk forward: the previous page's `PbxUserPage.nextCursor`. Cannot be
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

/** What `pbx.devices.list()` accepts. Every member narrows the collection. */
export interface ListPbxDevicesOptions {
  /** Only the registrations on this customer's PBX domain. */
  customer?: string;
  /**
   * Only the registrations belonging to this PBX **user id** — the id of a
   * `pbx.users` row, not an extension. An id you cannot reach answers an
   * empty page rather than a refusal.
   */
  user?: string;
  /** `true` for registrations that have not expired, `false` for the rest. */
  registered?: boolean;
  /**
   * Walk forward: the previous page's `PbxDevicePage.nextCursor`. Cannot be
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

/** What `pbx.users.call()` accepts. Only `destination` is required. */
export interface PlaceCallOptions {
  /**
   * Who to call: E.164 with a leading `+`, or an extension of 2 to 7 digits.
   * Anything else is refused with a 422 pointing at
   * `/data/attributes/destination`.
   */
  destination: string;
  /**
   * The number the called party sees — E.164, with or without the `+`. A ten
   * digit North American number is accepted too and answered with its country
   * code. A value that is not a telephone number is refused rather than
   * ignored. Omit it to use the subscriber's own caller ID.
   *
   * **`PbxCall.callerId` is not an echo of what you sent**: the platform
   * stores caller IDs as E.164 WITHOUT the plus, and answers with the
   * spelling the called party will see.
   */
  callerId?: string;
  /**
   * Ask the subscriber's device to answer automatically, where it supports
   * that. `false` unless you say otherwise.
   */
  autoAnswer?: boolean;
  /**
   * Which of the subscriber's registrations to place the call from, by its
   * `pbx.devices` id.
   *
   * **The device must be that subscriber's own** — one that is not is
   * refused with a 422 pointing at `/data/attributes/device`, whether it
   * belongs to somebody else or does not exist, and nothing is dialled. The
   * two are deliberately one answer: a device id is a client-supplied name
   * for hardware on a shared platform, and telling them apart would say
   * whose it is. The check includes a user of the SAME NAME on another
   * domain, which is the case that would otherwise reach a stranger. Omit
   * it and the platform chooses.
   */
  device?: string;
}

/**
 * The click-to-dial document as the spec declares it.
 *
 * Local and unexported, so nothing generated crosses the public boundary —
 * the same shape `faxAccountUsers.ts` and `webhookEndpoints.ts` use for
 * their write documents. What it buys is that a member misspelled here is a
 * compile error rather than a 422 read back out of a log.
 */
type CallRequest = components["schemas"]["PbxCallRequest"];

/** The `client.pbx.callRecords` namespace. */
export class CallRecords {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of call records, newest first.
   *
   * **Name a date range unless you mean the last two months.** The switch
   * keeps one table per month and the range picks which are opened, so the
   * default is the current month and the previous one — not "everything".
   * A range wider than 13 months is refused with a 400.
   *
   * Hidden records are left out here and served by `get()`.
   *
   * `callId` finds what a click-to-dial became: pass the `id` that
   * `pbx.users.call()` returned, once the call has ended. The date range above
   * still applies to it, so name one that covers an older call.
   *
   * Needs `pbx-call-records:read`.
   */
  async list(options: ListCallRecordsOptions = {}): Promise<CallRecordPage> {
    const { data } = await transportOf(this.client)["/v1/pbx/call-records"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[customer]": options.customer,
          "filter[started-after]": options.startedAfter,
          "filter[started-before]": options.startedBefore,
          "filter[direction]": options.direction,
          "filter[user]": options.user,
          "filter[call-id]": options.callId,
          "filter[include-hidden]": options.includeHidden,
        },
      },
    });

    return callRecordPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one call record.
   *
   * A record the phone system marks hidden IS served here — the list leaves
   * it out, a direct read does not, which is what the phone system's own
   * portal does. A record outside your customers' domains answers 404.
   *
   * Needs `pbx-call-records:read`.
   */
  async get(callRecordId: string): Promise<CallRecord> {
    const { data } = await transportOf(this.client)["/v1/pbx/call-records/{callRecord}"].GET({
      params: { path: { callRecord: idParam(callRecordId, "a call record id is required") } },
    });

    return callRecordFromResource(dataObject(data));
  }
}

/** The `client.pbx.users` namespace. */
export class PbxUsers {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of subscribers, by extension.
   *
   * `search` is the directory box — one substring across the display name,
   * both parts of the person's name and the extension. `user` is the exact
   * extension instead, and `101` does not match `1010`.
   *
   * Needs `pbx-users:read`.
   */
  async list(options: ListPbxUsersOptions = {}): Promise<PbxUserPage> {
    const { data } = await transportOf(this.client)["/v1/pbx/users"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[customer]": options.customer,
          "filter[user]": options.user,
          "filter[search]": options.search,
        },
      },
    });

    return pbxUserPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one subscriber.
   *
   * A subscriber outside your customers' domains answers **404**, not 403 —
   * the same answer an id that names nothing gives.
   *
   * Needs `pbx-users:read`.
   */
  async get(pbxUserId: string): Promise<PbxUser> {
    const { data } = await transportOf(this.client)["/v1/pbx/users/{user}"].GET({
      params: { path: { user: idParam(pbxUserId, "a pbx user id is required") } },
    });

    return pbxUserFromResource(dataObject(data));
  }

  /**
   * Have this subscriber's phone place a call — click-to-dial.
   *
   * The platform has that subscriber's phone place the call to
   * `destination`, so the call goes out as them rather than as you.
   *
   * **THE 202 IS NOT A CALL THAT HAPPENED.** It comes back the moment the
   * platform has accepted the request, so the `PbxCall` you get says
   * `status: "requested"` and nothing about how the call went. Its `id` is
   * the id the request was placed under, and it is how you find what the
   * call became: `pbx.callRecords.list({ callId: call.id })` returns its
   * record once the call has ended. A `CallRecord`'s own id comes from the
   * vendor row, so the two ids differ.
   *
   * **This is not undoable.** There is no cancel: once the request is
   * accepted, the call is out of your hands.
   *
   * **DO NOT RETRY THIS BLINDLY — there is no idempotency key, and a retry
   * is a second phone call to a real person.** Unlike `faxes.send()`, which
   * carries an `Idempotency-Key` and replays rather than resends, nothing
   * here deduplicates: a request you send twice because you never saw the
   * first response is two calls. The **502** below is the exception the API
   * names — nothing was dialled, so that one may be retried.
   *
   * A subscriber outside your customers' domains answers **404**, not 403.
   * A `device` that is not this subscriber's own is a **422** pointing at
   * `/data/attributes/device` — including one that belongs to a user of the
   * same name on another domain — and nothing is dialled. A phone system
   * that refuses or cannot be reached answers **502**, with its own status
   * in `errors[0].meta.vendor_status`.
   *
   * Needs `pbx-calls:write`.
   */
  async call(pbxUserId: string, options: PlaceCallOptions): Promise<PbxCall> {
    const id = idParam(pbxUserId, "a pbx user id is required");

    // `auto-answer` IS ALWAYS SENT, and the other two only when named.
    //
    // The spec requires `destination` alone and gives `auto-answer` a
    // `default: false`, which openapi-typescript renders as a NON-optional
    // member — a property with a default always has a value once the server
    // has read the document. Spelling our own `false` is therefore the one
    // reading that needs no local alias widening the generated type, and it
    // says the same thing to the server as leaving it out.
    const attributes: CallRequest["data"]["attributes"] = {
      destination: options.destination,
      "auto-answer": options.autoAnswer ?? false,
    };
    if (options.callerId !== undefined) {
      attributes["caller-id"] = options.callerId;
    }
    if (options.device !== undefined) {
      attributes.device = options.device;
    }

    const document: CallRequest = { data: { type: "calls", attributes } };

    const response = await this.client.request(
      new Request(`${this.client.baseUrl}/v1/pbx/users/${encodeURIComponent(id)}/calls`, {
        method: "POST",
        headers: new Headers({
          Accept: JSONAPI_MEDIA_TYPE,
          "Content-Type": JSONAPI_MEDIA_TYPE,
        }),
        body: JSON.stringify(document),
      }),
    );

    return pbxCallFromResource(dataObject(await response.json()));
  }
}

/** The `client.pbx.devices` namespace. */
export class PbxDevices {
  constructor(private readonly client: Ringivo) {}

  /**
   * One page of registrations, by address of record.
   *
   * A row is here because something sent a SIP REGISTER, so this is what is
   * reachable right now rather than what hardware was bought. `registered:
   * false` is the half that has expired — a phone that was unplugged.
   *
   * Needs `pbx-users:read`, the same scope as the subscribers themselves.
   */
  async list(options: ListPbxDevicesOptions = {}): Promise<PbxDevicePage> {
    const { data } = await transportOf(this.client)["/v1/pbx/devices"].GET({
      params: {
        query: {
          "page[after]": options.after,
          "page[before]": options.before,
          "page[size]": options.pageSize,
          "filter[customer]": options.customer,
          "filter[user]": options.user,
          "filter[registered]": options.registered,
        },
      },
    });

    return pbxDevicePageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Read one registration.
   *
   * A registration outside your customers' domains answers **404**, not 403.
   * So does one that has since disappeared, which is what a registration
   * does when nothing renews it.
   *
   * Needs `pbx-users:read`.
   */
  async get(pbxDeviceId: string): Promise<PbxDevice> {
    const { data } = await transportOf(this.client)["/v1/pbx/devices/{device}"].GET({
      params: { path: { device: idParam(pbxDeviceId, "a pbx device id is required") } },
    });

    return pbxDeviceFromResource(dataObject(data));
  }
}

/** The `client.pbx` namespace: the three collections and the one action. */
export class Pbx {
  /** Your customers' call log. */
  readonly callRecords: CallRecords;

  /** The subscribers on their phone systems, and click-to-dial. */
  readonly users: PbxUsers;

  /** The SIP registrations their phones have made. */
  readonly devices: PbxDevices;

  constructor(client: Ringivo) {
    this.callRecords = new CallRecords(client);
    this.users = new PbxUsers(client);
    this.devices = new PbxDevices(client);
  }
}

/**
 * One path segment, refused when it is empty.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so `/`
 * is already `%2F` by the time a typed URL is built — and `call()`, which
 * builds its own URL, runs it itself for the same reason. An unescaped
 * `../call-records/secret` normalises ON THE WIRE to a different endpoint,
 * read with this client's token.
 *
 * What this adds is the REFUSAL. An empty id would collapse
 * `/v1/pbx/users/{user}` into `/v1/pbx/users` — the COLLECTION, which answers
 * 200 with a page a caller would read as the one row they asked for. On
 * `call()` it would collapse `/v1/pbx/users//calls` instead, which is a
 * request nobody meant to send.
 */
function idParam(value: string, refusal: string): string {
  if (!value) {
    throw new Error(refusal);
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
