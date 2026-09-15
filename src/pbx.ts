/**
 * Your customers' phone systems: who has an extension, what is registered,
 * what was called — and asking somebody's phone to place a call.
 *
 * -- ONE NAMESPACE, THREE COLLECTIONS AND AN ACTION -------------------------
 * `client.pbx.users` are the subscribers, `client.pbx.devices` the SIP
 * registrations they made, and `client.pbx.callRecords` the call log.
 * `client.pbx.users.call()` is the only write on the whole surface: it asks
 * the switch to ring somebody's phone and dial out from it.
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
 * `users.call()` is hand-built, for the two reasons `faxAccountUsers.create()`
 * is: a JSON:API resource route answers 415 to the `application/json` a body
 * with no explicit type gets, and the shared transport is built with `Accept`
 * alone. It is hand-built for a THIRD reason as well, and this one is
 * temporary — `POST /v1/pbx/users/{id}/calls` is not in the vendored spec
 * yet, so its document is declared against the local interface below rather
 * than a generated one. When the action reaches the spec, the next
 * `scripts/generate.sh` publishes its schemas and `CallRequest` here is
 * replaced by the generated type; nothing a caller sees changes.
 *
 * -- THE WIRE IS KEBAB-CASE HERE --------------------------------------------
 * `/v1/pbx/` attributes and filters are spelled `started-after`,
 * `display-name`, `include-hidden` — not the `camelCase` attributes and
 * `snake_case` filters of the fax surface. That is the API's own spelling for
 * these resources and this module writes it verbatim; the camelCase is on
 * this package's side of the boundary, in src/models.ts.
 */
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
  /** Whether anybody answered. Narrow for the same reason as `direction`. */
  disposition?: "answered" | "missed";
  /**
   * Calls with this PBX **user id** on either leg — placed by them or taken
   * by them. The id of a `pbx.users` row, never an extension.
   */
  user?: string;
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
  /** The number to show the far end, E.164. Your provider's default if omitted. */
  callerId?: string;
  /**
   * Answer the originating leg without the person picking up the handset.
   * `false` unless you say otherwise — their phone rings first.
   */
  autoAnswer?: boolean;
  /**
   * Which of the user's registrations to call from, by its `pbx.devices` id.
   *
   * **It must be one of THIS user's devices.** A device id belonging to
   * somebody else is refused with a 422 pointing at
   * `/data/attributes/device`, rather than ringing a stranger's phone with
   * this user's caller ID on it. Omit it and the switch rings what it
   * normally would.
   */
  device?: string;
}

/**
 * The click-to-dial document, as this client sends it.
 *
 * Local, unexported and HAND-WRITTEN: the action is not in the vendored spec
 * yet, so there is no generated request schema to declare it against. It
 * exists all the same so that a member misspelled here is a compile error
 * rather than a 422 read back out of a log — and so that the replacement,
 * when the spec catches up, is one import.
 */
interface CallRequest {
  data: {
    type: "calls";
    attributes: {
      destination: string;
      "caller-id"?: string;
      "auto-answer"?: boolean;
      device?: string;
    };
  };
}

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
          "filter[disposition]": options.disposition,
          "filter[user]": options.user,
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
   * Ask this subscriber's phone to call somebody — click-to-dial.
   *
   * Their phone rings first; when they pick it up the switch dials
   * `destination` and joins the two. Pass `autoAnswer: true` to skip their
   * half of that, if their handset supports it.
   *
   * **THE 202 IS NOT A CALL THAT HAPPENED.** It comes back the moment the
   * switch has been told, so the `PbxCall` you get says `status: "requested"`
   * and nothing about whether a phone rang or anybody answered. Its `id` is
   * the id the call is placed under, so the `CallRecord` that appears
   * afterwards carries the same one — that is how you find out how it went.
   *
   * **This is not undoable.** There is no cancel: by the time a refusal could
   * be sent, a phone is ringing and somebody is picking it up.
   *
   * A subscriber outside your customers' domains answers **404**, not 403.
   * A `device` that is not this user's own is a **422** pointing at
   * `/data/attributes/device`. A switch that refuses the origination is a
   * **502** carrying its own status in `meta`.
   *
   * Needs `pbx-calls:write`.
   */
  async call(pbxUserId: string, options: PlaceCallOptions): Promise<PbxCall> {
    const id = idParam(pbxUserId, "a pbx user id is required");

    // Only what the caller named. `auto-answer` defaults to false at the
    // server, so an absent member and `false` mean the same thing there —
    // but sending nothing keeps the document a statement of what was asked
    // for, which is what the audit trail records.
    const attributes: CallRequest["data"]["attributes"] = { destination: options.destination };
    if (options.callerId !== undefined) {
      attributes["caller-id"] = options.callerId;
    }
    if (options.autoAnswer !== undefined) {
      attributes["auto-answer"] = options.autoAnswer;
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
