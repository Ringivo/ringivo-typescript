/**
 * The phone-system surface, asserted on the WIRE.
 *
 * Seven calls, six of them reads, so most of the job is the query string and
 * the object built from the answer — neither of which is observable from a
 * return value alone. Three things here are worth more than the usual
 * round-trip check:
 *
 * - **The wire is kebab-case on this surface.** `filter[started-after]`, not
 *   `filter[started_after]`; `display-name`, not `displayName`. The fax
 *   surface spells both the other way, so a reader who pattern-matched off
 *   `faxes.ts` would get these wrong and nothing but a test would say so.
 * - **`false` is a value, not an absence.** `registered: false` and
 *   `includeHidden: false` are the halves of those filters somebody actually
 *   wants — expired registrations, and the default hidden-records behaviour
 *   stated explicitly. A serialiser that drops falsy query members would turn
 *   both into "no filter at all" and answer 200 with the wrong rows, so the
 *   literal `"false"` is asserted rather than assumed.
 * - **A PBX user's timestamps are STRINGS.** Every other model in this package
 *   parses `createdAt` into a `Date`, and these two deliberately do not; a
 *   test that only checked the value would pass against a `Date` built from
 *   the same text.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;

const CALL_RECORDS_URL = `${BASE_URL}/v1/pbx/call-records`;
const PBX_USERS_URL = `${BASE_URL}/v1/pbx/users`;
const PBX_DEVICES_URL = `${BASE_URL}/v1/pbx/devices`;

const CALL_RECORD_ID = "e4837703-48c1-5c9e-8699-bbaafb17bb84";
const PBX_USER_ID = "6f98cc5d-5248-5100-9967-8606e2993077";
const PBX_DEVICE_ID = "92e7c8b3-9d9f-5286-86ac-f0d0c035e6c0";
const CUSTOMER_ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";
const CALL_ID = "0198c4a1-b425-7601-92e3-0405060708a9";

const CALL_RECORD_URL = `${CALL_RECORDS_URL}/${CALL_RECORD_ID}`;
const CALL_RECORD_RECORDINGS_URL = `${CALL_RECORD_URL}/recordings`;
const CALL_RECORD_TRANSCRIPTS_URL = `${CALL_RECORD_URL}/transcripts`;
const RECORDING_ID = "0198c9aa-1111-7000-8000-0000000000b1";
const PBX_USER_URL = `${PBX_USERS_URL}/${PBX_USER_ID}`;
const PBX_DEVICE_URL = `${PBX_DEVICES_URL}/${PBX_DEVICE_ID}`;
const PLACE_CALL_URL = `${PBX_USERS_URL}/${PBX_USER_ID}/calls`;

const JSONAPI = "application/vnd.api+json";

const server = mockServer();

beforeEach(() => {
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: [
      "pbx-call-records:read",
      "pbx-transcripts:read",
      "pbx-users:read",
      "pbx-calls:write",
    ],
  });
}

function callRecordResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "call-records",
    id: CALL_RECORD_ID,
    attributes: {
      direction: "inbound",
      disposition: "answered",
      "vendor-type": 1,
      domain: "acme.example",
      "from-user": "",
      "from-uri": "sip:+13025556789@carrier.example",
      "from-name": "Dr Bell",
      "to-user": "101",
      "to-uri": "sip:101@acme.example",
      dialed: "+14075550101",
      "by-user": "",
      "term-user": "101",
      "started-at": "2026-09-12T14:00:00+00:00",
      "answered-at": "2026-09-12T14:00:04+00:00",
      "released-at": "2026-09-12T14:01:04+00:00",
      duration: 64,
      "talk-time": 60,
      tag: "clinic",
      hidden: false,
      "has-recording": true,
      "vendor-id": "20260912000000000001c0ffee0123456789abcdef",
      ...attributeOverrides,
    },
    relationships: {
      customer: { data: { type: "customers", id: CUSTOMER_ID } },
      "from-pbx-user": { data: null },
      "to-pbx-user": { data: { type: "users", id: PBX_USER_ID } },
    },
  };
}

/**
 * One `recordings` resource object, KEBAB-CASE attributes and all — the
 * same spelling every other `/v1/pbx/` resource in this file uses,
 * `callRecordResource` above included.
 */
function recordingResource(
  attributeOverrides: Record<string, unknown> = {},
  resourceId: string = RECORDING_ID,
): object {
  return {
    type: "recordings",
    id: resourceId,
    attributes: {
      "ccc-id": "00b1",
      duration: 64,
      "byte-size": 512000,
      sha256: "a".repeat(64),
      superseded: false,
      "content-url": `${BASE_URL}/v1/pbx/recordings-content/signed-token`,
      "expires-at": "2026-09-12T15:00:00Z",
      ...attributeOverrides,
    },
  };
}

/** One `transcripts` resource object in the `ready` state. */
function transcriptResource(
  attributeOverrides: Record<string, unknown> = {},
  resourceId: string = RECORDING_ID,
): object {
  return {
    type: "transcripts",
    id: resourceId,
    attributes: {
      "ccc-id": "00b1",
      status: "ready",
      language: "en-US",
      duration: 64,
      "byte-size": 2048,
      sha256: "b".repeat(64),
      provider: "deepgram",
      model: "nova-3",
      "content-url": `${BASE_URL}/v1/pbx/transcripts-content/signed-token`,
      "expires-at": "2026-09-12T15:00:00Z",
      ...attributeOverrides,
    },
  };
}

function pbxUserResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "users",
    id: PBX_USER_ID,
    attributes: {
      user: "101",
      domain: "acme.example",
      "display-name": "Ann Perkins",
      "first-name": "Ann",
      "last-name": "Perkins",
      email: "ann@acme.example",
      scope: "Basic User",
      group: "sales",
      site: "HQ",
      presence: "open",
      "caller-id-number": "+14075550101",
      "caller-id-name": "Ann Perkins",
      "time-zone": "US/Eastern",
      "created-at": "2026-01-02 03:04:05",
      "updated-at": "2026-09-01 10:00:00",
      ...attributeOverrides,
    },
    relationships: {
      customer: { data: { type: "customers", id: CUSTOMER_ID } },
      devices: { data: [{ type: "devices", id: PBX_DEVICE_ID }] },
    },
  };
}

function pbxDeviceResource(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    type: "devices",
    id: PBX_DEVICE_ID,
    attributes: {
      aor: "sip:101@acme.example",
      user: "101",
      domain: "acme.example",
      mode: "register",
      "user-agent": "Polycom/6.4.2",
      contact: "sip:101@198.51.100.7:5060",
      transport: "udp",
      "received-from": "198.51.100.7:5060",
      "registered-at": "2026-09-14 08:00:00",
      "registration-expires-at": "2026-09-14 09:00:00",
      registered: true,
      "auto-answer": false,
      "created-at": "2026-01-02 03:04:05",
      ...attributeOverrides,
    },
    relationships: {
      customer: { data: { type: "customers", id: CUSTOMER_ID } },
      "pbx-user": { data: { type: "users", id: PBX_USER_ID } },
    },
  };
}

function errorBody(status: number, code: string, detail: string, source?: object): object {
  return { errors: [{ status: String(status), code, title: code, detail, ...(source ?? {}) }] };
}

describe("callRecords.list", () => {
  it("spells every filter the way this surface spells them — kebab-case", async () => {
    const calls = new Calls();
    server.use(
      http.get(CALL_RECORDS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.callRecords.list({
      customer: CUSTOMER_ID,
      startedAfter: "2026-09-01T00:00:00Z",
      startedBefore: "2026-09-30T23:59:59Z",
      direction: "inbound",
      user: PBX_USER_ID,
      callId: CALL_ID,
      includeHidden: true,
      pageSize: 100,
      after: "0198c4a1-cursor",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[customer]")).toBe(CUSTOMER_ID);
    expect(params.get("filter[started-after]")).toBe("2026-09-01T00:00:00Z");
    expect(params.get("filter[started-before]")).toBe("2026-09-30T23:59:59Z");
    expect(params.get("filter[direction]")).toBe("inbound");
    expect(params.get("filter[user]")).toBe(PBX_USER_ID);
    expect(params.get("filter[call-id]")).toBe(CALL_ID);
    expect(params.get("filter[include-hidden]")).toBe("true");
    expect(params.get("page[size]")).toBe("100");
    expect(params.get("page[after]")).toBe("0198c4a1-cursor");
    // An unset filter is absent, not empty.
    expect(params.has("page[before]")).toBe(false);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
  });

  it("sends includeHidden: false as a value rather than dropping it", async () => {
    // `false` is falsy, and a serialiser that skipped it would send NO
    // include-hidden filter — which happens to be the same behaviour here, so
    // this assertion is about the wire staying explicit rather than about the
    // rows. The `registered` filter below is the one where the two differ.
    const calls = new Calls();
    server.use(
      http.get(CALL_RECORDS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.callRecords.list({ includeHidden: false });

    expect(calls.last.url.searchParams.get("filter[include-hidden]")).toBe("false");
  });

  it("sends no filter at all when none was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(CALL_RECORDS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.callRecords.list();

    // The DENOMINATOR: the call happened, and its query is empty.
    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.keys()]).toEqual([]);
  });

  it("sends no disposition filter, which the API refuses with a 400", async () => {
    // `filter[disposition]` was withdrawn from the API, and a list that still
    // sent it would be refused outright. The option is gone from the type —
    // the directive below fails `tsc --noEmit` the day it comes back — and
    // this assertion is the runtime half: a JavaScript caller who still
    // passes it must not reach the wire with it.
    const calls = new Calls();
    server.use(
      http.get(CALL_RECORDS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    // @ts-expect-error disposition is no longer a call-record filter
    await client().pbx.callRecords.list({ disposition: "missed", direction: "inbound" });

    // The DENOMINATOR: the request went out and carried the filter that IS
    // still supported.
    expect(calls.count).toBe(1);
    expect(calls.last.url.searchParams.get("filter[direction]")).toBe("inbound");
    expect(calls.last.url.searchParams.has("filter[disposition]")).toBe(false);
  });

  it("finds a click-to-dial call's records by the id call() answered", async () => {
    // The join this release adds: the `id` of the 202 goes back out,
    // unchanged, as `filter[call-id]`.
    const calls = new Calls();
    server.use(
      http.post(PLACE_CALL_URL, () =>
        HttpResponse.json(
          {
            data: {
              type: "calls",
              id: CALL_ID,
              attributes: { destination: "+13025556789", status: "requested" },
            },
          },
          { status: 202 },
        ),
      ),
      http.get(CALL_RECORDS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [callRecordResource({ hidden: false })] });
      }),
    );

    const ringivo = client();
    const call = await ringivo.pbx.users.call(PBX_USER_ID, { destination: "+13025556789" });
    const page = await ringivo.pbx.callRecords.list({ callId: call.id });

    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.entries()]).toEqual([["filter[call-id]", CALL_ID]]);
    expect(page.callRecords).toHaveLength(1);
  });

  it("walks backward from a cursor", async () => {
    const calls = new Calls();
    server.use(
      http.get(CALL_RECORDS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.callRecords.list({ before: "0198c4a1-earlier" });

    expect(calls.last.url.searchParams.get("page[before]")).toBe("0198c4a1-earlier");
    expect(calls.last.url.searchParams.has("page[after]")).toBe(false);
  });

  it("reads the records and the nextCursor from meta.page", async () => {
    server.use(
      http.get(CALL_RECORDS_URL, () =>
        HttpResponse.json({
          data: [callRecordResource()],
          links: { next: `${CALL_RECORDS_URL}?page%5Bafter%5D=0198c4a1-next` },
          meta: { page: { size: 25, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().pbx.callRecords.list();

    expect(page.callRecords).toHaveLength(1);
    expect(page.callRecords[0]?.id).toBe(CALL_RECORD_ID);
    expect(page.nextCursor).toBe("0198c4a1-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
    expect(Object.isFrozen(page)).toBe(true);
  });

  it("has no next cursor on the last page", async () => {
    server.use(
      http.get(CALL_RECORDS_URL, () =>
        HttpResponse.json({
          data: [callRecordResource()],
          meta: { page: { size: 25, nextCursor: null } },
        }),
      ),
    );

    const page = await client().pbx.callRecords.list();

    expect(page.nextCursor).toBeNull();
    expect(page.nextUrl).toBeNull();
  });
});

describe("callRecords.get", () => {
  it("reads a kebab-case document into the camelCase public object", async () => {
    server.use(http.get(CALL_RECORD_URL, () => HttpResponse.json({ data: callRecordResource() })));

    const record = await client().pbx.callRecords.get(CALL_RECORD_ID);

    expect(record.id).toBe(CALL_RECORD_ID);
    expect(record.direction).toBe("inbound");
    expect(record.disposition).toBe("answered");
    expect(record.vendorType).toBe(1);
    expect(record.domain).toBe("acme.example");
    expect(record.fromUser).toBe("");
    expect(record.fromUri).toBe("sip:+13025556789@carrier.example");
    expect(record.fromName).toBe("Dr Bell");
    expect(record.toUser).toBe("101");
    expect(record.toUri).toBe("sip:101@acme.example");
    expect(record.dialed).toBe("+14075550101");
    expect(record.byUser).toBe("");
    expect(record.termUser).toBe("101");
    expect(record.duration).toBe(64);
    expect(record.talkTime).toBe(60);
    expect(record.tag).toBe("clinic");
    expect(record.hidden).toBe(false);
    expect(record.hasRecording).toBe(true);
    expect(record.vendorId).toBe("20260912000000000001c0ffee0123456789abcdef");
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("parses the three instants, which ARE RFC 3339 on this resource", async () => {
    server.use(http.get(CALL_RECORD_URL, () => HttpResponse.json({ data: callRecordResource() })));

    const record = await client().pbx.callRecords.get(CALL_RECORD_ID);

    expect(record.startedAt).toBeInstanceOf(Date);
    expect(record.startedAt?.toISOString()).toBe("2026-09-12T14:00:00.000Z");
    expect(record.answeredAt?.toISOString()).toBe("2026-09-12T14:00:04.000Z");
    expect(record.releasedAt?.toISOString()).toBe("2026-09-12T14:01:04.000Z");
  });

  it("reads a missed call's absent answer time as null", async () => {
    server.use(
      http.get(CALL_RECORD_URL, () =>
        HttpResponse.json({
          data: callRecordResource({
            direction: "inbound",
            disposition: "missed",
            "vendor-type": 2,
            "answered-at": null,
            "talk-time": 0,
          }),
        }),
      ),
    );

    const record = await client().pbx.callRecords.get(CALL_RECORD_ID);

    expect(record.disposition).toBe("missed");
    expect(record.answeredAt).toBeNull();
    expect(record.talkTime).toBe(0);
  });

  it("passes a direction word this SDK does not know straight through", async () => {
    // The switch records ONE integer carrying direction and disposition, and
    // an integer the API has no word for is published as its own digits. The
    // model is `string` for exactly this, so a vocabulary that grows at the
    // switch's end never erases a call.
    server.use(
      http.get(CALL_RECORD_URL, () =>
        HttpResponse.json({ data: callRecordResource({ direction: "9", "vendor-type": 9 }) }),
      ),
    );

    const record = await client().pbx.callRecords.get(CALL_RECORD_ID);

    expect(record.direction).toBe("9");
    expect(record.vendorType).toBe(9);
  });

  it("reads both legs' user relationships, and a null linkage as null", async () => {
    server.use(http.get(CALL_RECORD_URL, () => HttpResponse.json({ data: callRecordResource() })));

    const record = await client().pbx.callRecords.get(CALL_RECORD_ID);

    expect(record.customerId).toBe(CUSTOMER_ID);
    // An outside caller has no extension, so this leg resolves to nothing.
    expect(record.fromPbxUserId).toBeNull();
    expect(record.toPbxUserId).toBe(PBX_USER_ID);
  });

  it("serves a hidden record, which the list leaves out", async () => {
    server.use(
      http.get(CALL_RECORD_URL, () =>
        HttpResponse.json({ data: callRecordResource({ hidden: true }) }),
      ),
    );

    const record = await client().pbx.callRecords.get(CALL_RECORD_ID);

    expect(record.hidden).toBe(true);
  });

  it("keeps a call record id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: callRecordResource() });
      }),
    );

    await client().pbx.callRecords.get("../../faxes/secret");

    expect(calls.last.url.pathname).toBe("/v1/pbx/call-records/..%2F..%2Ffaxes%2Fsecret");
  });

  it("refuses an empty id rather than reading the whole collection", async () => {
    await expect(client().pbx.callRecords.get("")).rejects.toThrow(
      /a call record id is required/,
    );
  });

  it("raises a typed 404 for a record outside the caller's domains", async () => {
    server.use(
      http.get(CALL_RECORD_URL, () =>
        HttpResponse.json(errorBody(404, "not_found", "No such record."), { status: 404 }),
      ),
    );

    await expect(client().pbx.callRecords.get(CALL_RECORD_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(client().pbx.callRecords.get(CALL_RECORD_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });

  it("surfaces the 400 a range wider than 13 months is refused with", async () => {
    server.use(
      http.get(CALL_RECORDS_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "400",
                code: "bad_query",
                title: "Bad query",
                detail: "The date range may not be wider than 13 months.",
                source: { parameter: "filter[started-after]" },
                meta: { filter: { maxMonths: 13 } },
              },
            ],
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      client().pbx.callRecords.list({ startedAfter: "2020-01-01T00:00:00Z" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "bad_query" });
  });
});

describe("callRecords.recordings", () => {
  it("reads a kebab-case document into a plain array of camelCase objects", async () => {
    server.use(
      http.get(CALL_RECORD_RECORDINGS_URL, () =>
        HttpResponse.json({ data: [recordingResource()] }),
      ),
    );

    const recordings = await client().pbx.callRecords.recordings(CALL_RECORD_ID);

    expect(Array.isArray(recordings)).toBe(true);
    expect(recordings).toHaveLength(1);
    const [recording] = recordings;
    expect(recording?.id).toBe(RECORDING_ID);
    expect(recording?.cccId).toBe("00b1");
    expect(recording?.duration).toBe(64);
    expect(recording?.byteSize).toBe(512000);
    expect(recording?.sha256).toBe("a".repeat(64));
    expect(recording?.superseded).toBe(false);
    expect(recording?.contentUrl).toBe(`${BASE_URL}/v1/pbx/recordings-content/signed-token`);
    expect(recording?.expiresAt?.toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(Object.isFrozen(recording)).toBe(true);
  });

  it("returns every capture in the server's own order", async () => {
    // Vendor key order `(call_id, ccc_id)`, not chronological — this client
    // does not reorder what the server sent.
    const secondId = "0198c9aa-1111-7000-8000-0000000000b2";
    server.use(
      http.get(CALL_RECORD_RECORDINGS_URL, () =>
        HttpResponse.json({
          data: [
            recordingResource(),
            recordingResource({ "ccc-id": "00b2" }, secondId),
          ],
        }),
      ),
    );

    const recordings = await client().pbx.callRecords.recordings(CALL_RECORD_ID);

    expect(recordings.map((recording) => recording.id)).toEqual([RECORDING_ID, secondId]);
  });

  it("returns an empty array rather than an error when there are no captures", async () => {
    server.use(http.get(CALL_RECORD_RECORDINGS_URL, () => HttpResponse.json({ data: [] })));

    const recordings = await client().pbx.callRecords.recordings(CALL_RECORD_ID);

    expect(recordings).toEqual([]);
  });

  it("keeps a call record id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [recordingResource()] });
      }),
    );

    await client().pbx.callRecords.recordings("../../faxes/secret");

    expect(calls.last.url.pathname).toBe(
      "/v1/pbx/call-records/..%2F..%2Ffaxes%2Fsecret/recordings",
    );
  });

  it("refuses an empty id rather than reading the whole collection", async () => {
    await expect(client().pbx.callRecords.recordings("")).rejects.toThrow(
      /a call record id is required/,
    );
  });

  it("raises a typed 404 for a call outside the caller's domains", async () => {
    server.use(
      http.get(CALL_RECORD_RECORDINGS_URL, () =>
        HttpResponse.json(errorBody(404, "not_found", "No such record."), { status: 404 }),
      ),
    );

    await expect(client().pbx.callRecords.recordings(CALL_RECORD_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("callRecords.transcripts", () => {
  it("reads the ready state into a plain array of camelCase objects", async () => {
    server.use(
      http.get(CALL_RECORD_TRANSCRIPTS_URL, () =>
        HttpResponse.json({ data: [transcriptResource()] }),
      ),
    );

    const transcripts = await client().pbx.callRecords.transcripts(CALL_RECORD_ID);

    expect(transcripts).toHaveLength(1);
    const [transcript] = transcripts;
    expect(transcript?.id).toBe(RECORDING_ID);
    expect(transcript?.cccId).toBe("00b1");
    expect(transcript?.status).toBe("ready");
    expect(transcript?.language).toBe("en-US");
    expect(transcript?.duration).toBe(64);
    expect(transcript?.byteSize).toBe(2048);
    expect(transcript?.sha256).toBe("b".repeat(64));
    expect(transcript?.provider).toBe("deepgram");
    expect(transcript?.model).toBe("nova-3");
    expect(transcript?.contentUrl).toBe(`${BASE_URL}/v1/pbx/transcripts-content/signed-token`);
    expect(transcript?.expiresAt?.toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(Object.isFrozen(transcript)).toBe(true);
  });

  it("reads the pending state with every other field null", async () => {
    // A capture with no words yet is still an ITEM in this collection —
    // `status: "pending"` and every field below it null — so a caller can
    // tell "no transcript yet" from "no recording at all".
    server.use(
      http.get(CALL_RECORD_TRANSCRIPTS_URL, () =>
        HttpResponse.json({
          data: [
            transcriptResource({
              status: "pending",
              language: null,
              duration: null,
              "byte-size": null,
              sha256: null,
              provider: null,
              model: null,
              "content-url": null,
              "expires-at": null,
            }),
          ],
        }),
      ),
    );

    const [transcript] = await client().pbx.callRecords.transcripts(CALL_RECORD_ID);

    expect(transcript?.status).toBe("pending");
    expect(transcript?.language).toBeNull();
    expect(transcript?.duration).toBeNull();
    expect(transcript?.byteSize).toBeNull();
    expect(transcript?.sha256).toBeNull();
    expect(transcript?.provider).toBeNull();
    expect(transcript?.model).toBeNull();
    expect(transcript?.contentUrl).toBeNull();
    expect(transcript?.expiresAt).toBeNull();
  });

  it("returns an empty array rather than an error when there are no captures", async () => {
    server.use(http.get(CALL_RECORD_TRANSCRIPTS_URL, () => HttpResponse.json({ data: [] })));

    const transcripts = await client().pbx.callRecords.transcripts(CALL_RECORD_ID);

    expect(transcripts).toEqual([]);
  });

  it("keeps a call record id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [transcriptResource()] });
      }),
    );

    await client().pbx.callRecords.transcripts("../../faxes/secret");

    expect(calls.last.url.pathname).toBe(
      "/v1/pbx/call-records/..%2F..%2Ffaxes%2Fsecret/transcripts",
    );
  });

  it("refuses an empty id rather than reading the whole collection", async () => {
    await expect(client().pbx.callRecords.transcripts("")).rejects.toThrow(
      /a call record id is required/,
    );
  });

  it("raises a typed 404 for a call outside the caller's domains", async () => {
    server.use(
      http.get(CALL_RECORD_TRANSCRIPTS_URL, () =>
        HttpResponse.json(errorBody(404, "not_found", "No such record."), { status: 404 }),
      ),
    );

    await expect(client().pbx.callRecords.transcripts(CALL_RECORD_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("users.list", () => {
  it("builds the three filters and the page query", async () => {
    const calls = new Calls();
    server.use(
      http.get(PBX_USERS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.users.list({
      customer: CUSTOMER_ID,
      user: "101",
      search: "perkins",
      pageSize: 50,
      after: "0198c4a1-cursor",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[customer]")).toBe(CUSTOMER_ID);
    expect(params.get("filter[user]")).toBe("101");
    expect(params.get("filter[search]")).toBe("perkins");
    expect(params.get("page[size]")).toBe("50");
    expect(params.get("page[after]")).toBe("0198c4a1-cursor");
    expect(params.has("page[before]")).toBe(false);
  });

  it("sends no filter at all when none was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(PBX_USERS_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.users.list();

    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.keys()]).toEqual([]);
  });

  it("reads the users and the nextCursor from meta.page", async () => {
    server.use(
      http.get(PBX_USERS_URL, () =>
        HttpResponse.json({
          data: [pbxUserResource()],
          links: { next: `${PBX_USERS_URL}?page%5Bafter%5D=0198c4a1-next` },
          meta: { page: { size: 25, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().pbx.users.list();

    expect(page.users).toHaveLength(1);
    expect(page.users[0]?.displayName).toBe("Ann Perkins");
    expect(page.nextCursor).toBe("0198c4a1-next");
  });
});

describe("users.get", () => {
  it("reads a kebab-case document into the camelCase public object", async () => {
    server.use(http.get(PBX_USER_URL, () => HttpResponse.json({ data: pbxUserResource() })));

    const user = await client().pbx.users.get(PBX_USER_ID);

    expect(user.id).toBe(PBX_USER_ID);
    expect(user.user).toBe("101");
    expect(user.domain).toBe("acme.example");
    expect(user.displayName).toBe("Ann Perkins");
    expect(user.firstName).toBe("Ann");
    expect(user.lastName).toBe("Perkins");
    expect(user.email).toBe("ann@acme.example");
    expect(user.scope).toBe("Basic User");
    expect(user.group).toBe("sales");
    expect(user.site).toBe("HQ");
    expect(user.presence).toBe("open");
    expect(user.callerIdNumber).toBe("+14075550101");
    expect(user.callerIdName).toBe("Ann Perkins");
    expect(user.timeZone).toBe("US/Eastern");
    expect(Object.isFrozen(user)).toBe(true);
  });

  it("hands the phone system's timestamps back as UNPARSED TEXT", async () => {
    // The switch has never published the format it writes these in, so the
    // API serves them unparsed and so does this client. A mis-parse would be
    // silent — `new Date("2026-01-02 03:04:05")` yields a LOCAL-time Date, so
    // the same string would read as a different instant in another timezone.
    server.use(http.get(PBX_USER_URL, () => HttpResponse.json({ data: pbxUserResource() })));

    const user = await client().pbx.users.get(PBX_USER_ID);

    expect(user.createdAt).toBe("2026-01-02 03:04:05");
    expect(user.updatedAt).toBe("2026-09-01 10:00:00");
    expect(user.createdAt).not.toBeInstanceOf(Date);
    expect(typeof user.createdAt).toBe("string");
  });

  it("reads the customer and the to-many devices linkage", async () => {
    server.use(http.get(PBX_USER_URL, () => HttpResponse.json({ data: pbxUserResource() })));

    const user = await client().pbx.users.get(PBX_USER_ID);

    expect(user.customerId).toBe(CUSTOMER_ID);
    expect(user.deviceIds).toEqual([PBX_DEVICE_ID]);
  });

  it("tells an EMPTY devices linkage apart from an absent one", async () => {
    // Empty means this subscriber has registered nothing. Absent means the
    // server answered the relationship with `links` alone, which is legal
    // JSON:API and says nothing at all about their devices.
    server.use(
      http.get(PBX_USER_URL, () =>
        HttpResponse.json({
          data: { ...pbxUserResource(), relationships: { devices: { data: [] } } },
        }),
      ),
    );

    const none = await client().pbx.users.get(PBX_USER_ID);
    expect(none.deviceIds).toEqual([]);

    server.use(
      http.get(PBX_USER_URL, () =>
        HttpResponse.json({
          data: {
            ...pbxUserResource(),
            relationships: { devices: { links: { self: `${PBX_USER_URL}/relationships/devices` } } },
          },
        }),
      ),
    );

    const unsaid = await client().pbx.users.get(PBX_USER_ID);
    expect(unsaid.deviceIds).toBeNull();
  });

  it("keeps a user id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: pbxUserResource() });
      }),
    );

    await client().pbx.users.get("../devices/secret");

    expect(calls.last.url.pathname).toBe("/v1/pbx/users/..%2Fdevices%2Fsecret");
  });

  it("refuses an empty id rather than reading the whole collection", async () => {
    await expect(client().pbx.users.get("")).rejects.toThrow(/a pbx user id is required/);
  });

  it("raises a typed 404 for a subscriber outside the caller's domains", async () => {
    server.use(
      http.get(PBX_USER_URL, () =>
        HttpResponse.json(errorBody(404, "not_found", "No such user."), { status: 404 }),
      ),
    );

    await expect(client().pbx.users.get(PBX_USER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("devices.list", () => {
  it("builds the three filters and the page query", async () => {
    const calls = new Calls();
    server.use(
      http.get(PBX_DEVICES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.devices.list({
      customer: CUSTOMER_ID,
      user: PBX_USER_ID,
      registered: true,
      pageSize: 10,
      before: "0198c4a1-earlier",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[customer]")).toBe(CUSTOMER_ID);
    expect(params.get("filter[user]")).toBe(PBX_USER_ID);
    expect(params.get("filter[registered]")).toBe("true");
    expect(params.get("page[size]")).toBe("10");
    expect(params.get("page[before]")).toBe("0198c4a1-earlier");
    expect(params.has("page[after]")).toBe(false);
  });

  it("sends registered: false as a value rather than dropping it", async () => {
    // THE ONE THAT WOULD BITE. `false` asks for the EXPIRED registrations;
    // dropping it because it is falsy asks for all of them, and the answer is
    // a 200 full of the wrong rows rather than an error anybody would notice.
    const calls = new Calls();
    server.use(
      http.get(PBX_DEVICES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.devices.list({ registered: false });

    expect(calls.last.url.searchParams.get("filter[registered]")).toBe("false");
  });

  it("sends no filter at all when none was named", async () => {
    const calls = new Calls();
    server.use(
      http.get(PBX_DEVICES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().pbx.devices.list();

    expect(calls.count).toBe(1);
    expect([...calls.last.url.searchParams.keys()]).toEqual([]);
  });

  it("reads the devices and the nextCursor from meta.page", async () => {
    server.use(
      http.get(PBX_DEVICES_URL, () =>
        HttpResponse.json({
          data: [pbxDeviceResource()],
          meta: { page: { size: 25, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().pbx.devices.list();

    expect(page.devices).toHaveLength(1);
    expect(page.devices[0]?.aor).toBe("sip:101@acme.example");
    expect(page.nextCursor).toBe("0198c4a1-next");
  });
});

describe("devices.get", () => {
  it("reads a kebab-case document into the camelCase public object", async () => {
    server.use(http.get(PBX_DEVICE_URL, () => HttpResponse.json({ data: pbxDeviceResource() })));

    const device = await client().pbx.devices.get(PBX_DEVICE_ID);

    expect(device.id).toBe(PBX_DEVICE_ID);
    expect(device.aor).toBe("sip:101@acme.example");
    expect(device.user).toBe("101");
    expect(device.domain).toBe("acme.example");
    expect(device.mode).toBe("register");
    expect(device.userAgent).toBe("Polycom/6.4.2");
    expect(device.contact).toBe("sip:101@198.51.100.7:5060");
    expect(device.transport).toBe("udp");
    expect(device.receivedFrom).toBe("198.51.100.7:5060");
    expect(device.registered).toBe(true);
    expect(device.autoAnswer).toBe(false);
    expect(Object.isFrozen(device)).toBe(true);
  });

  it("hands the registration timestamps back as UNPARSED TEXT", async () => {
    server.use(http.get(PBX_DEVICE_URL, () => HttpResponse.json({ data: pbxDeviceResource() })));

    const device = await client().pbx.devices.get(PBX_DEVICE_ID);

    expect(device.registeredAt).toBe("2026-09-14 08:00:00");
    expect(device.registrationExpiresAt).toBe("2026-09-14 09:00:00");
    expect(device.createdAt).toBe("2026-01-02 03:04:05");
    expect(typeof device.registeredAt).toBe("string");
  });

  it("reads the pbx-user relationship, which is NOT called `user`", async () => {
    // `user` is already an attribute here — the extension — and JSON:API
    // forbids a relationship sharing the name, so the linkage is `pbx-user`.
    server.use(http.get(PBX_DEVICE_URL, () => HttpResponse.json({ data: pbxDeviceResource() })));

    const device = await client().pbx.devices.get(PBX_DEVICE_ID);

    expect(device.user).toBe("101");
    expect(device.pbxUserId).toBe(PBX_USER_ID);
    expect(device.customerId).toBe(CUSTOMER_ID);
  });

  it("keeps a device id inside its own path segment", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: pbxDeviceResource() });
      }),
    );

    await client().pbx.devices.get("../users/secret");

    expect(calls.last.url.pathname).toBe("/v1/pbx/devices/..%2Fusers%2Fsecret");
  });

  it("refuses an empty id rather than reading the whole collection", async () => {
    await expect(client().pbx.devices.get("")).rejects.toThrow(/a pbx device id is required/);
  });

  it("raises a typed 404 for a registration that has since gone", async () => {
    server.use(
      http.get(PBX_DEVICE_URL, () =>
        HttpResponse.json(errorBody(404, "not_found", "No such device."), { status: 404 }),
      ),
    );

    await expect(client().pbx.devices.get(PBX_DEVICE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});

describe("users.call", () => {
  function accepted(attributeOverrides: Record<string, unknown> = {}): object {
    return {
      data: {
        type: "calls",
        id: CALL_ID,
        attributes: {
          destination: "+13025556789",
          "caller-id": null,
          "auto-answer": false,
          device: null,
          status: "requested",
          "requested-at": "2026-09-15T04:30:00.000000Z",
          ...attributeOverrides,
        },
      },
    };
  }

  it("POSTs a JSON:API document to the user's own calls route", async () => {
    const calls = new Calls();
    server.use(
      http.post(PLACE_CALL_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(accepted(), { status: 202 });
      }),
    );

    await client().pbx.users.call(PBX_USER_ID, { destination: "+13025556789" });

    expect(calls.last.request.method).toBe("POST");
    expect(calls.last.url.pathname).toBe(`/v1/pbx/users/${PBX_USER_ID}/calls`);
    // BOTH headers, and the request half is the one that matters: a JSON:API
    // resource route answers 415 to the `application/json` a body with no
    // explicit type gets.
    expect(calls.last.request.headers.get("Content-Type")).toBe(JSONAPI);
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
    expect(calls.last.request.headers.get("Authorization")).toBe("Bearer tok");
  });

  it("sends only the attributes the caller named, kebab-cased", async () => {
    const calls = new Calls();
    server.use(
      http.post(PLACE_CALL_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(accepted(), { status: 202 });
      }),
    );

    await client().pbx.users.call(PBX_USER_ID, {
      destination: "1001",
      callerId: "+14075550101",
      autoAnswer: true,
      device: PBX_DEVICE_ID,
    });

    expect(JSON.parse(calls.last.body)).toEqual({
      data: {
        type: "calls",
        attributes: {
          destination: "1001",
          "caller-id": "+14075550101",
          "auto-answer": true,
          device: PBX_DEVICE_ID,
        },
      },
    });
  });

  it("omits what was not named, but always spells auto-answer", async () => {
    // The spec requires `destination` alone and gives `auto-answer` a
    // `default: false` — which the generated request type renders as a
    // non-optional member. Sending our own `false` is the reading that needs
    // no local alias widening that type, and the server reads it the same as
    // an absent member. `caller-id` and `device` really are optional, and
    // stay out of the document when they were not named.
    const calls = new Calls();
    server.use(
      http.post(PLACE_CALL_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(accepted(), { status: 202 });
      }),
    );

    await client().pbx.users.call(PBX_USER_ID, { destination: "+13025556789" });

    expect(JSON.parse(calls.last.body)).toEqual({
      data: {
        type: "calls",
        attributes: { destination: "+13025556789", "auto-answer": false },
      },
    });
  });

  it("sends autoAnswer: false when it was named explicitly", async () => {
    const calls = new Calls();
    server.use(
      http.post(PLACE_CALL_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(accepted(), { status: 202 });
      }),
    );

    await client().pbx.users.call(PBX_USER_ID, {
      destination: "+13025556789",
      autoAnswer: false,
    });

    const body = JSON.parse(calls.last.body) as {
      data: { attributes: Record<string, unknown> };
    };
    expect(body.data.attributes["auto-answer"]).toBe(false);
  });

  it("reads the 202 into a PbxCall", async () => {
    server.use(
      http.post(PLACE_CALL_URL, () =>
        HttpResponse.json(
          // `caller-id` comes back WITHOUT the plus: the platform stores every
          // caller ID as E.164 without one and answers with the spelling the
          // called party will see, so this is not an echo of what was sent.
          accepted({ "caller-id": "14075550101", "auto-answer": true, device: PBX_DEVICE_ID }),
          { status: 202 },
        ),
      ),
    );

    const call = await client().pbx.users.call(PBX_USER_ID, {
      destination: "+13025556789",
      callerId: "+14075550101",
      device: PBX_DEVICE_ID,
    });

    expect(call.id).toBe(CALL_ID);
    expect(call.destination).toBe("+13025556789");
    // Sent with a plus, answered without one. Passed through as it arrived.
    expect(call.callerId).toBe("14075550101");
    expect(call.autoAnswer).toBe(true);
    expect(call.device).toBe(PBX_DEVICE_ID);
    // NOT a call that happened — only one that was asked for.
    expect(call.status).toBe("requested");
    // Declared RFC 3339 by the spec, unlike a PbxUser's timestamps.
    expect(call.requestedAt).toBeInstanceOf(Date);
    expect(call.requestedAt?.toISOString()).toBe("2026-09-15T04:30:00.000Z");
    expect(Object.isFrozen(call)).toBe(true);
  });

  it("reads a null caller-id as the subscriber's own being used", async () => {
    server.use(
      http.post(PLACE_CALL_URL, () => HttpResponse.json(accepted(), { status: 202 })),
    );

    const call = await client().pbx.users.call(PBX_USER_ID, { destination: "+13025556789" });

    expect(call.callerId).toBeNull();
    expect(call.device).toBeNull();
  });

  it("raises a typed 422 pointing at the device that is not this user's", async () => {
    server.use(
      http.post(PLACE_CALL_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "422",
                code: "validation_failed",
                title: "Unprocessable",
                detail: "That device does not belong to this user.",
                source: { pointer: "/data/attributes/device" },
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    const refusal = await client()
      .pbx.users.call(PBX_USER_ID, { destination: "+13025556789", device: PBX_DEVICE_ID })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ statusCode: 422, code: "validation_failed" });
    expect((refusal as ApiError).errors[0]?.source).toEqual({
      pointer: "/data/attributes/device",
    });
  });

  it("raises a typed 422 for a destination that is neither E.164 nor an extension", async () => {
    server.use(
      http.post(PLACE_CALL_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "422",
                code: "validation_failed",
                title: "Unprocessable",
                detail: "The destination must be E.164 or an extension of 2 to 7 digits.",
                source: { pointer: "/data/attributes/destination" },
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    await expect(
      client().pbx.users.call(PBX_USER_ID, { destination: "not-a-number" }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_failed" });
  });

  it("surfaces the 502 a switch that refused the origination answers", async () => {
    server.use(
      http.post(PLACE_CALL_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "502",
                code: "upstream_refused",
                title: "Bad gateway",
                detail: "The phone system refused the call.",
                meta: { vendorStatus: 403 },
              },
            ],
          },
          { status: 502 },
        ),
      ),
    );

    await expect(
      client().pbx.users.call(PBX_USER_ID, { destination: "+13025556789" }),
    ).rejects.toMatchObject({ statusCode: 502, code: "upstream_refused" });
  });

  it("raises a typed 404 for a subscriber outside the caller's domains", async () => {
    // 404 and not 403: a resource you may not reach does not resolve, rather
    // than being found and then refused.
    server.use(
      http.post(PLACE_CALL_URL, () =>
        HttpResponse.json(errorBody(404, "not_found", "No such user."), { status: 404 }),
      ),
    );

    await expect(
      client().pbx.users.call(PBX_USER_ID, { destination: "+13025556789" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("keeps a user id inside its own path segment", async () => {
    const calls = new Calls();
    // Scoped to `/v1/pbx/`, not `${BASE_URL}/*`: a wildcard over the whole
    // host also claims `POST /oauth/token` and the client never gets a token.
    server.use(
      http.post(`${BASE_URL}/v1/pbx/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json(accepted(), { status: 202 });
      }),
    );

    await client().pbx.users.call("../../faxes/secret", { destination: "+13025556789" });

    expect(calls.last.url.pathname).toBe("/v1/pbx/users/..%2F..%2Ffaxes%2Fsecret/calls");
  });

  it("refuses an empty user id rather than POSTing to a path nobody meant", async () => {
    await expect(
      client().pbx.users.call("", { destination: "+13025556789" }),
    ).rejects.toThrow(/a pbx user id is required/);
  });
});
