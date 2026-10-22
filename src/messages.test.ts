/**
 * Recording a text you already sent, asserted on the WIRE.
 *
 * `record()`'s whole job is one JSON:API document and the status code of its
 * answer, so the request body is asserted member for member against the
 * spec's own example. The rest is the refusals: what the API would answer
 * with a 422 no retry can fix is thrown here before any request, and every
 * refusal test asserts that NOTHING went out.
 *
 * The label rule mirrors the API's own (a PCRE `[\s\p{Z}]` trim, then the
 * category checks), so the edge cases below are the ones where JavaScript's
 * own notion of white space differs from the API's. The Python client's
 * tests/test_messages.py carries the same cases.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HttpResponse, delay, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import {
  ApiError,
  MAX_MEDIA,
  MAX_PROVIDER_ID_LENGTH,
  MAX_SENDER_LABEL_CODE_POINTS,
  RECORD_MIN_TIMEOUT_MS,
  Ringivo,
  isRetryable,
  senderLabel,
} from "./index.js";
import type { RecordMessageOptions } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const RECORD_URL = `${BASE_URL}/v1/outbound-messages`;
const JSONAPI = "application/vnd.api+json";
const MESSAGE_ID = "01JC8ZA1F5T3R8C2P6M0L4JSWQ";

const server = mockServer();

beforeEach(() => {
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(timeoutMs?: number): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["messages:record", "fax:read"],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** The spec's own request example, as `record()` options. */
function options(overrides: Partial<Record<keyof RecordMessageOptions, unknown>> = {}) {
  return {
    from: "+14075550142",
    to: "+13215550187",
    body: "Reminder: Rex is due for his rabies booster on Oct 24.",
    senderLabel: "Appointment reminder",
    providerMessageId: MESSAGE_ID,
    providerPartIds: [MESSAGE_ID],
    sentAt: new Date("2026-10-19T15:02:44Z"),
    ...overrides,
  } as RecordMessageOptions;
}

/** The spec's 201 example. */
function recorded(attributeOverrides: Record<string, unknown> = {}): object {
  return {
    data: {
      type: "outbound-messages",
      id: "0192f0c0-5d2e-7a1b-8c3d-4e5f60718293",
      attributes: {
        source: "recorded",
        kind: "sms",
        status: "sent",
        from: "+14075550142",
        to: "+13215550187",
        body: "Reminder: Rex is due for his rabies booster on Oct 24.",
        media: [],
        senderLabel: "Appointment reminder",
        markConversationRead: false,
        sentAt: "2026-10-19T15:02:44.000000Z",
        providerMessageId: MESSAGE_ID,
        providerPartIds: [MESSAGE_ID],
        createdAt: "2026-10-19T15:02:45.000000Z",
        updatedAt: "2026-10-19T15:02:45.000000Z",
        ...attributeOverrides,
      },
    },
  };
}

function answering(status: number, body: object = recorded()): Calls {
  const calls = new Calls();
  server.use(
    http.post(RECORD_URL, async ({ request }) => {
      await calls.record(request);
      return HttpResponse.json(body, { status });
    }),
  );
  return calls;
}

const SPEC = readFileSync(
  fileURLToPath(new URL("../spec/openapi.yaml", import.meta.url)),
  "utf8",
);

/** The `OutboundMessageRecordRequest` schema's YAML, as text. */
function recordRequestSchema(): string {
  const start = SPEC.indexOf("\n    OutboundMessageRecordRequest:\n");
  const end = SPEC.indexOf("\n    OutboundMessageAttributes:\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SPEC.slice(start, end);
}

/** The YAML block of one property inside `schema`, up to the next sibling at `indent`. */
function property(schema: string, name: string, indent: number): string {
  const pad = " ".repeat(indent);
  const start = schema.indexOf(`\n${pad}${name}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = schema.slice(start + 1);
  const next = rest.slice(1).search(new RegExp(`\\n${pad}[A-Za-z]`));
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("record", () => {
  it("posts the spec's own example as JSON:API", async () => {
    const calls = answering(201);

    await client().messages.record(options());

    expect(calls.count).toBe(1);
    expect(calls.last.request.method).toBe("POST");
    expect(calls.last.request.headers.get("Accept")).toBe(JSONAPI);
    expect(calls.last.request.headers.get("Content-Type")).toBe(JSONAPI);
    // No Idempotency-Key: the provider message id IS the key.
    expect(calls.last.request.headers.has("Idempotency-Key")).toBe(false);
    expect(JSON.parse(calls.last.body)).toEqual({
      data: {
        type: "outbound-messages",
        attributes: {
          from: "+14075550142",
          to: "+13215550187",
          body: "Reminder: Rex is due for his rabies booster on Oct 24.",
          mediaUrls: [],
          senderLabel: "Appointment reminder",
          markConversationRead: false,
          alreadySent: {
            providerMessageId: MESSAGE_ID,
            providerPartIds: [MESSAGE_ID],
            sentAt: "2026-10-19T15:02:44Z",
          },
        },
      },
    });
  });

  it("reads a 201 as the record, and not as a replay", async () => {
    answering(201);

    const message = await client().messages.record(options());

    expect(message.id).toBe("0192f0c0-5d2e-7a1b-8c3d-4e5f60718293");
    expect(message.source).toBe("recorded");
    expect(message.kind).toBe("sms");
    expect(message.status).toBe("sent");
    expect(message.from).toBe("+14075550142");
    expect(message.to).toBe("+13215550187");
    expect(message.senderLabel).toBe("Appointment reminder");
    expect(message.markConversationRead).toBe(false);
    expect(message.sentAt?.toISOString()).toBe("2026-10-19T15:02:44.000Z");
    expect(message.providerMessageId).toBe(MESSAGE_ID);
    expect(message.providerPartIds).toEqual([MESSAGE_ID]);
    expect(message.media).toEqual([]);
    expect(message.createdAt?.toISOString()).toBe("2026-10-19T15:02:45.000Z");
    expect(message.replayed).toBe(false);
    expect(Object.isFrozen(message)).toBe(true);
  });

  it("reads a 200 as a replay of the first record", async () => {
    answering(200);

    const message = await client().messages.record(options());

    expect(message.replayed).toBe(true);
    expect(message.id).toBe("0192f0c0-5d2e-7a1b-8c3d-4e5f60718293");
  });

  it("sends mediaUrls, the read choice and every part, and reads the media back", async () => {
    const calls = answering(
      201,
      recorded({
        kind: "mms",
        markConversationRead: true,
        media: [{ contentType: "image/jpeg", size: 40213 }],
      }),
    );

    const message = await client().messages.record(
      options({
        body: null,
        mediaUrls: ["https://media.example.com/rex.jpg", "https://media.example.com/card.vcf"],
        markConversationRead: true,
        providerPartIds: ["part-1", "part-2"],
      }),
    );

    const attributes = JSON.parse(calls.last.body).data.attributes;
    expect(attributes.body).toBeNull();
    // `mediaUrls` is a list of strings; the API answers `media` with a 422.
    expect(attributes.mediaUrls).toEqual([
      "https://media.example.com/rex.jpg",
      "https://media.example.com/card.vcf",
    ]);
    expect(attributes).not.toHaveProperty("media");
    expect(attributes.markConversationRead).toBe(true);
    expect(attributes.alreadySent.providerPartIds).toEqual(["part-1", "part-2"]);

    expect(message.media).toEqual([
      {
        contentType: "image/jpeg",
        size: 40213,
        raw: { contentType: "image/jpeg", size: 40213 },
      },
    ]);
    expect(message.markConversationRead).toBe(true);
  });

  it.each([
    [422, "media_rejected", false],
    [504, "media_timeout", true],
    [502, "media_unreachable", true],
    [503, "media_store_unavailable", true],
  ] as const)(
    "throws a %i %s that names the link and the reason",
    async (status, code, retryable) => {
      server.use(
        http.post(RECORD_URL, () =>
          HttpResponse.json(
            {
              errors: [
                { status: String(status), code, source: { pointer: "/data/attributes/mediaUrls/1" } },
              ],
            },
            { status, headers: status === 422 ? {} : { "Retry-After": "5" } },
          ),
        ),
      );

      const error = (await client()
        .messages.record(
          options({
            mediaUrls: ["https://media.example.com/a.jpg", "https://media.example.com/b.jpg"],
          }),
        )
        .catch((caught: unknown) => caught)) as ApiError;

      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(status);
      expect(error.code).toBe(code);
      expect(error.errors[0]?.source).toEqual({ pointer: "/data/attributes/mediaUrls/1" });
      expect(isRetryable(error)).toBe(retryable);
      expect(error.retryAfter).toBe(status === 422 ? undefined : 5);
    },
  );

  it("sends a sentAt with milliseconds as the UTC instant it names", async () => {
    const calls = answering(201);

    await client().messages.record(options({ sentAt: new Date("2026-10-19T17:02:44.250+02:00") }));

    expect(JSON.parse(calls.last.body).data.attributes.alreadySent.sentAt).toBe(
      "2026-10-19T15:02:44.250Z",
    );
  });

  it("throws a 422 with the pointer, and says not to retry it", async () => {
    server.use(
      http.post(RECORD_URL, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "422",
                code: "validation_failed",
                detail: "The from number does not send through your own provider account.",
                source: { pointer: "/data/attributes/from" },
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    const error = (await client()
      .messages.record(options())
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe("validation_failed");
    expect(error.errors[0]?.source).toEqual({ pointer: "/data/attributes/from" });
    expect(isRetryable(error)).toBe(false);
  });

  it("throws a 409, which is not retryable", async () => {
    server.use(
      http.post(RECORD_URL, () =>
        HttpResponse.json({ errors: [{ status: "409", detail: "Conflict" }] }, { status: 409 }),
      ),
    );

    const error = await client()
      .messages.record(options())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(409);
    expect(isRetryable(error)).toBe(false);
  });

  it("names the list, not a link, when the media pass 20 MB together", async () => {
    server.use(
      http.post(RECORD_URL, () =>
        HttpResponse.json(
          {
            errors: [
              { status: "422", code: "media_rejected", source: { pointer: "/data/attributes/mediaUrls" } },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    const error = (await client()
      .messages.record(options({ mediaUrls: ["https://media.example.com/big.mp4"] }))
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("media_rejected");
    expect(error.errors[0]?.source).toEqual({ pointer: "/data/attributes/mediaUrls" });
    expect(isRetryable(error)).toBe(false);
  });

  it.each([429, 503])("throws a %i with Retry-After, which is retryable", async (status) => {
    server.use(
      http.post(RECORD_URL, () =>
        HttpResponse.json(
          { errors: [{ status: String(status) }] },
          { status, headers: { "Retry-After": "7" } },
        ),
      ),
    );

    const error = (await client()
      .messages.record(options())
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.statusCode).toBe(status);
    expect(error.retryAfter).toBe(7);
    expect(isRetryable(error)).toBe(true);
  });
});

describe("the record's timeout", () => {
  it("waits at least the floor when the client's own timeout is shorter", async () => {
    const ringivo = client(1_000);
    const sent = vi.spyOn(ringivo, "request");
    answering(201);

    await ringivo.messages.record(options());

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[1]).toEqual({ timeoutMs: RECORD_MIN_TIMEOUT_MS });
  });

  it("keeps a longer client timeout", async () => {
    const ringivo = client(60_000);
    const sent = vi.spyOn(ringivo, "request");
    answering(201);

    await ringivo.messages.record(options());

    expect(sent.mock.calls[0]?.[1]).toEqual({ timeoutMs: 60_000 });
  });

  it("outlasts a client timeout that the same wait fails every other call on", async () => {
    // A real wait, not a spy: 300 ms is past this client's 100 ms timeout,
    // and well inside the record's floor.
    const ringivo = client(100);
    server.use(
      http.post(RECORD_URL, async () => {
        await delay(300);
        return HttpResponse.json(recorded(), { status: 201 });
      }),
      http.get(`${BASE_URL}/v1/faxes/slow`, async () => {
        await delay(300);
        return HttpResponse.json({ data: {} });
      }),
    );

    await expect(ringivo.messages.record(options())).resolves.toMatchObject({ status: "sent" });

    const timedOut = await ringivo.faxes.get("slow").catch((caught: unknown) => caught);
    expect((timedOut as Error).name).toBe("TimeoutError");
    expect(isRetryable(timedOut)).toBe(true);
  });
});

describe("what no retry can fix is refused before any request", () => {
  it.each<[string, Partial<Record<keyof RecordMessageOptions, unknown>>, string]>([
    ["an empty provider message id", { providerMessageId: "" }, "providerMessageId"],
    ["no part ids", { providerPartIds: [] }, "providerPartIds"],
    ["one part-id string", { providerPartIds: MESSAGE_ID }, "not one string"],
    ["an empty part id", { providerPartIds: ["ok", ""] }, "providerPartIds"],
    ["a sentAt string", { sentAt: "2026-10-19T15:02:44Z" }, "must be a Date"],
    ["an Invalid Date", { sentAt: new Date("not a date") }, "Invalid Date"],
    [
      "eleven links",
      { mediaUrls: Array.from({ length: 11 }, (_, n) => `https://m.example.com/${n}.jpg`) },
      "at most 10",
    ],
    ["an http link", { mediaUrls: ["http://m.example.com/a.jpg"] }, "https"],
    ["a link that is no URL", { mediaUrls: ["https//m.example.com/a.jpg"] }, "https"],
    // WHATWG `URL` reads both of these as https://m.example.com/; Python's
    // `urlsplit()` finds no host in either, and neither does this.
    ["a link with no slashes", { mediaUrls: ["https:m.example.com/a.jpg"] }, "https"],
    ["a link with backslashes", { mediaUrls: ["https:\\\\m.example.com\\a.jpg"] }, "https"],
    ["a link with no host", { mediaUrls: ["https:///a.jpg"] }, "https"],
    ["one link string", { mediaUrls: "https://m.example.com/a.jpg" }, "not one string"],
    ["no body and no link", { body: null }, "body or at least one media link"],
    ["an empty body and no link", { body: "" }, "body or at least one media link"],
    ["a blank label", { senderLabel: "  " }, "empty"],
    ["a two-line label", { senderLabel: "Dana\nSmith" }, "one line"],
    ["a label with a line separator", { senderLabel: "Dana Smith" }, "one line"],
    ["an invisible label", { senderLabel: "​​" }, "visible"],
    [
      "a label one code point too long",
      { senderLabel: "x".repeat(MAX_SENDER_LABEL_CODE_POINTS + 1) },
      "at most 40",
    ],
    [
      "a provider message id one too long",
      { providerMessageId: "x".repeat(MAX_PROVIDER_ID_LENGTH + 1) },
      "at most 128",
    ],
    [
      "a part id one too long",
      { providerPartIds: ["x".repeat(MAX_PROVIDER_ID_LENGTH + 1)] },
      "at most 128",
    ],
    ["a repeated part id", { providerPartIds: ["part-1", "part-2", "part-1"] }, "must not repeat"],
  ])("refuses %s", async (_name, overrides, message) => {
    const calls = answering(201);

    await expect(client().messages.record(options(overrides))).rejects.toThrow(message);

    expect(calls.count).toBe(0);
  });

  it("accepts an https link whatever the case of its scheme, and sends it as given", async () => {
    const calls = answering(201);

    await client().messages.record(options({ mediaUrls: ["HTTPS://M.example.com/a.jpg"] }));

    expect(JSON.parse(calls.last.body).data.attributes.mediaUrls).toEqual([
      "HTTPS://M.example.com/a.jpg",
    ]);
  });

  it("throws a TypeError for a wrong type and an Error for a wrong value, never an ApiError", async () => {
    answering(201);

    const wrongType = await client()
      .messages.record(options({ providerPartIds: MESSAGE_ID }))
      .catch((caught: unknown) => caught);
    const wrongValue = await client()
      .messages.record(options({ providerPartIds: [] }))
      .catch((caught: unknown) => caught);

    expect(wrongType).toBeInstanceOf(TypeError);
    expect(wrongValue).toBeInstanceOf(Error);
    expect(wrongValue).not.toBeInstanceOf(ApiError);
    expect(isRetryable(wrongType)).toBe(false);
    expect(isRetryable(wrongValue)).toBe(false);
  });
});

describe("the label rule", () => {
  it("accepts a label the API trims, and sends it as given", async () => {
    const calls = answering(201);
    // 39 emoji and a zero-width joiner: 40 code points, padded with spaces.
    const label = `  ${"\u{1f436}".repeat(39)}‍  `;

    await client().messages.record(options({ senderLabel: label }));

    expect(JSON.parse(calls.last.body).data.attributes.senderLabel).toBe(label);
  });

  it.each(["\x1c", "\x1d", "\x1e", "\x1f"])(
    "reads %j as a control character, not as space",
    async (separator) => {
      const calls = answering(201);

      await expect(
        client().messages.record(options({ senderLabel: `${separator}Dana` })),
      ).rejects.toThrow("one line");
      expect(calls.count).toBe(0);
      expect(senderLabel(`${separator}Dana${separator}`)).toBe("Dana");
    },
  );

  it.each([" ", "\t", "\x85", " ", "　", " "])(
    "trims the white space the API trims (%j)",
    async (space) => {
      const calls = answering(201);

      await client().messages.record(options({ senderLabel: `${space}Dana${space}` }));

      expect(calls.count).toBe(1);
    },
  );

  it("does not trim U+FEFF, which JavaScript's own \\s would", async () => {
    const calls = answering(201);

    // A format character the API keeps: it is not space, so the label is
    // 41 code points and too long.
    await expect(
      client().messages.record(
        options({ senderLabel: `﻿${"x".repeat(MAX_SENDER_LABEL_CODE_POINTS)}` }),
      ),
    ).rejects.toThrow("at most 40");
    expect(calls.count).toBe(0);
  });

  it("trims a next line at either end, but refuses one inside", async () => {
    const calls = answering(201);

    await client().messages.record(options({ senderLabel: "\x85Rex\x85" }));
    expect(calls.count).toBe(1);

    await expect(client().messages.record(options({ senderLabel: "R\x85ex" }))).rejects.toThrow(
      "one line",
    );
    expect(calls.count).toBe(1);
  });
});

describe("senderLabel", () => {
  it.each([
    ["Dana Smith", "Dana Smith"],
    ["  Dana \t\n Smith  ", "Dana Smith"],
    ["Dana\r\nSmith", "Dana Smith"],
    ["Dana Smith\x07", "Dana Smith"],
    ["Dr. Lee", "Dr. Lee"],
    ["x".repeat(50), "x".repeat(MAX_SENDER_LABEL_CODE_POINTS)],
    // A cut that ends on a space is trimmed again.
    [`${"a".repeat(39)} bcd`, "a".repeat(39)],
    // Code points, not UTF-16 units: an emoji is one.
    ["\u{1f436}".repeat(45), "\u{1f436}".repeat(MAX_SENDER_LABEL_CODE_POINTS)],
  ])("makes %j into %j", (text, label) => {
    expect(senderLabel(text)).toBe(label);
  });

  it.each(["", "   ", "\n\t", "​​"])("refuses %j: nothing visible is left", (text) => {
    expect(() => senderLabel(text)).toThrow("visible");
  });

  it("makes labels record() always accepts", async () => {
    const calls = answering(201);

    for (const text of ["  Dana \n Smith ", "y".repeat(90), "Dr. Lee\x00"]) {
      await client().messages.record(options({ senderLabel: senderLabel(text) }));
    }

    expect(calls.count).toBe(3);
  });
});

describe("the contract's limits, read from the spec", () => {
  it("is the spec's label limit", () => {
    const label = property(recordRequestSchema(), "senderLabel", 16);
    expect(label).toMatch(new RegExp(`\\n\\s+maxLength: ${MAX_SENDER_LABEL_CODE_POINTS}\\n`));
    expect(label).toMatch(/\n\s+minLength: 1\n/);
  });

  it("is the spec's media limit, on a list of strings", () => {
    const mediaUrls = property(recordRequestSchema(), "mediaUrls", 16);
    expect(mediaUrls).toMatch(new RegExp(`\\n\\s+maxItems: ${MAX_MEDIA}\\n`));
    expect(mediaUrls).toMatch(/\n\s+items: \{ type: string,/);
    expect(recordRequestSchema()).not.toMatch(/\n {16}media:/);
  });

  it("is the spec's provider id limits", () => {
    const alreadySent = property(recordRequestSchema(), "alreadySent", 16);
    const messageId = property(alreadySent, "providerMessageId", 20);
    const partIds = property(alreadySent, "providerPartIds", 20);
    expect(messageId).toMatch(new RegExp(`\\n\\s+maxLength: ${MAX_PROVIDER_ID_LENGTH}\\n`));
    expect(partIds).toMatch(/\n\s+minItems: 1\n/);
    expect(partIds).toContain(`items: { type: string, maxLength: ${MAX_PROVIDER_ID_LENGTH} }`);
  });

  it("documents the media sizes the spec publishes", () => {
    const flat = SPEC.replace(/\s+/g, " ");
    expect(flat).toContain("must be a media item of at most 10 MB");
    expect(flat).toContain("at most 20 MB of media together");
    expect(flat).toContain("**each must finish within 10 seconds of the call**");
    expect(flat).toContain("`text/plain` is refused");
    // Past 20 MB together the refusal names the list, not one link.
    expect(flat).toContain(
      "refuse the record with `media_rejected` and `source.pointer` `/data/attributes/mediaUrls` — the list, not one link",
    );

    const documented = readFileSync(
      fileURLToPath(new URL("./messages.ts", import.meta.url)),
      "utf8",
    ).replace(/\s+\*\s+/g, " ");
    expect(documented).toContain(
      "at most 10 media items, at most 10 MB each and at most 20 MB together",
    );
    expect(documented).toContain("each within 10 seconds of the call");
    expect(documented).toContain("the pointer is the list itself, `/data/attributes/mediaUrls`");
  });

  it("is the timeout the spec tells a caller to set, plus a 5-second margin", () => {
    // The spec's number is the API's own cut; this client's clock starts
    // before the API's, so the floor sits above it. A spec that moves the
    // number fails here.
    const flat = SPEC.replace(/\s+/g, " ");
    const found = /\*\*Set your client timeout to (\d+) seconds\*\*/.exec(flat);
    expect(found, "the spec no longer says what timeout to set; read it again").not.toBeNull();
    const documentedMs = Number(found?.[1]) * 1000;
    expect(documentedMs).toBe(30_000);
    expect(RECORD_MIN_TIMEOUT_MS).toBeGreaterThanOrEqual(documentedMs + 5_000);
    expect(RECORD_MIN_TIMEOUT_MS).toBe(35_000);
  });

  it.each([
    [422, "media_rejected"],
    [504, "media_timeout"],
    [502, "media_unreachable"],
    [503, "media_store_unavailable"],
  ])("documents %i %s as an ErrorCode on its status", (status, code) => {
    const errorCodes = SPEC.slice(
      SPEC.indexOf("\n    ErrorCode:\n"),
      SPEC.indexOf("\n    ErrorDocument:\n"),
    );
    expect(errorCodes).toMatch(new RegExp(`^ {8}- ${code}$`, "m"));

    const operation = SPEC.slice(
      SPEC.indexOf("\n  /v1/outbound-messages:\n"),
      SPEC.indexOf("\n  /v1/", SPEC.indexOf("\n  /v1/outbound-messages:\n") + 1),
    );
    const response = operation.slice(operation.indexOf(`\n        '${status}':\n`));
    const description = response.slice(0, response.indexOf("\n        '", 1));
    expect(description).toContain(`\`${code}\``);
  });
});
