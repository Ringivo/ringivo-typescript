/**
 * `parseMessageEvent()`: the four `message.*` webhook bodies, one variant each.
 *
 * Three things carry the weight here:
 *
 * - **Each variant carries only its own members.** A received message has no
 *   provider ids and no `sentBy`; only `message.failed` has `failureCause`;
 *   an unknown body has no `message` at all. The `@ts-expect-error` lines are
 *   the compile-time half of that — `npm run typecheck` fails the day a
 *   variant grows a member it should not have.
 * - **`switch (event.type)` narrows cleanly.** That is why the unknown
 *   variant's `type` is `null` and not a `string`: a `string` would stay in
 *   every `case`, and `event.message` would never narrow.
 * - **The parser never throws.** A receiver that answered a malformed
 *   delivery with a 500 would only be sent it again.
 *
 * The bodies below are the spec's own webhook examples (`message.received`,
 * `message.sent`, `message.delivered`, `message.failed` in
 * spec/openapi.yaml), copied rather than parsed out of the YAML.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FAILURE_CAUSES,
  INBOUND_MESSAGE_EVENT_TYPES,
  OUTBOUND_MESSAGE_EVENT_TYPES,
  parseMessageEvent,
} from "./index.js";
import type { components } from "./_generated/schema.js";
import type {
  FailureCause,
  InboundMessageMediaItem,
  MessageEvent,
  OutboundMessageEventData,
  OutboundMessageMediaItem,
} from "./index.js";

const MESSAGE_RECEIVED = {
  eventId: "0198c4a1-e7b3-7a41-9c62-5f0d8a1b2c3d",
  type: "message.received",
  occurredAt: "2026-08-16T11:14:07+00:00",
  data: {
    id: "0198c4a1-6f70-7182-b394-4d5e6f708192",
    tenantId: "0198c4a1-b425-76e7-18e9-031425364a5b",
    customerId: "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081",
    kind: "mms",
    from: "+13025556789",
    to: "+14075550100",
    body: "Here is the referral form.",
    media: [{ contentType: "image/jpeg", filename: "photo.jpg", size: 40213 }],
    receivedAt: "2026-08-16T11:14:07+00:00",
  },
};

const SENT_DATA = {
  id: "0192f0c1-8e4a-7b3d-a2c5-6d7e8f901234",
  tenantId: "0191aa10-2b3c-7d4e-8f90-a1b2c3d4e5f6",
  customerId: "0191ab22-3c4d-7e5f-9a01-b2c3d4e5f607",
  source: "phone_system",
  kind: "sms",
  from: "+14075550142",
  to: "+13215550187",
  body: "Yes, a little grass is fine. Call us if he vomits.",
  media: [],
  status: "sent",
  sentBy: { kind: "phone_system_user", name: "Dana Smith" },
  sentAt: "2026-10-19T15:06:01+00:00",
  providerMessageId: "01JC8ZB2H6V4S9D3Q7N1M5KTXR",
  providerPartIds: ["01JC8ZB2H6V4S9D3Q7N1M5KTXR"],
};

const MESSAGE_SENT = {
  eventId: "0192f0c2-1a7b-7c4d-9e8f-0a1b2c3d4e5f",
  type: "message.sent",
  occurredAt: "2026-10-19T15:06:01+00:00",
  data: SENT_DATA,
};

const MESSAGE_DELIVERED = {
  eventId: "0192f0c3-5d6e-7f80-91a2-b3c4d5e6f708",
  type: "message.delivered",
  occurredAt: "2026-10-19T15:06:04+00:00",
  data: { ...SENT_DATA, status: "delivered" },
};

const MESSAGE_FAILED = {
  eventId: "0192f0c4-6e7f-7091-a2b3-c4d5e6f70819",
  type: "message.failed",
  occurredAt: "2026-10-19T15:06:09+00:00",
  data: { ...SENT_DATA, status: "undelivered", failure: { cause: "undelivered" } },
};

describe("the routing lists", () => {
  it("names the one inbound event", () => {
    expect(INBOUND_MESSAGE_EVENT_TYPES).toEqual(["message.received"]);
  });

  it("names the three outbound events", () => {
    expect([...OUTBOUND_MESSAGE_EVENT_TYPES].sort()).toEqual([
      "message.delivered",
      "message.failed",
      "message.sent",
    ]);
  });

  it("keeps the two directions apart", () => {
    expect(INBOUND_MESSAGE_EVENT_TYPES.some((type) => OUTBOUND_MESSAGE_EVENT_TYPES.includes(type))).toBe(
      false,
    );
  });

  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(INBOUND_MESSAGE_EVENT_TYPES)).toBe(true);
    expect(Object.isFrozen(OUTBOUND_MESSAGE_EVENT_TYPES)).toBe(true);
    expect(() => (OUTBOUND_MESSAGE_EVENT_TYPES as string[]).push("message.received")).toThrow(
      TypeError,
    );
  });

  it("names only webhooks the spec publishes", () => {
    const spec = readFileSync(
      fileURLToPath(new URL("../spec/openapi.yaml", import.meta.url)),
      "utf8",
    );
    for (const type of [...INBOUND_MESSAGE_EVENT_TYPES, ...OUTBOUND_MESSAGE_EVENT_TYPES]) {
      expect(spec).toContain(`\n  ${type}:\n    post:\n`);
    }
  });

  it.each([MESSAGE_SENT, MESSAGE_DELIVERED, MESSAGE_FAILED])(
    "routes $type outbound only",
    (payload) => {
      expect(OUTBOUND_MESSAGE_EVENT_TYPES.includes(payload.type)).toBe(true);
      expect(INBOUND_MESSAGE_EVENT_TYPES.includes(payload.type)).toBe(false);
    },
  );

  it("routes message.received inbound only", () => {
    expect(INBOUND_MESSAGE_EVENT_TYPES.includes(MESSAGE_RECEIVED.type)).toBe(true);
    expect(OUTBOUND_MESSAGE_EVENT_TYPES.includes(MESSAGE_RECEIVED.type)).toBe(false);
  });
});

describe("the failure causes", () => {
  const SPEC = readFileSync(
    fileURLToPath(new URL("../spec/openapi.yaml", import.meta.url)),
    "utf8",
  );

  /** The vendored spec's `OutboundMessageFailureCause` enum. */
  function documentedCauses(): string[] {
    const start = SPEC.indexOf("\n    OutboundMessageFailureCause:\n");
    expect(start).toBeGreaterThan(-1);
    const block = SPEC.slice(start + 1, SPEC.indexOf("\n    MessageFailedEventData:\n", start));
    const listed = block.split("      enum:\n", 2)[1] ?? "";
    return [...listed.matchAll(/^ {8}- ([a-z_]+)$/gm)].map((match) => match[1] ?? "");
  }

  it("are the seven causes the spec's enum lists", () => {
    const documented = documentedCauses();

    expect(documented, "the spec's list moved; read it again").toHaveLength(7);
    expect([...FAILURE_CAUSES].sort()).toEqual([...documented].sort());
  });

  it("type failure.cause in the spec by that enum", () => {
    const start = SPEC.indexOf("\n    MessageFailedEventData:\n");
    const block = SPEC.slice(start, SPEC.indexOf("\n    MessageSentEvent:\n", start));
    expect(block).toContain("$ref: '#/components/schemas/OutboundMessageFailureCause'");
  });

  it("are the generated enum, at compile time", () => {
    // Both directions: `npm run typecheck` fails the day the spec's enum
    // and the hand-written union differ by one member.
    type Generated = components["schemas"]["OutboundMessageFailureCause"];
    const sameMembers: [FailureCause] extends [Generated]
      ? [Generated] extends [FailureCause]
        ? true
        : false
      : false = true;
    expect(sameMembers).toBe(true);
  });

  it("replace outcome_unknown and submission_interrupted with send_interrupted", () => {
    const causes: readonly string[] = FAILURE_CAUSES;
    expect(causes).toContain("send_interrupted");
    expect(causes).not.toContain("outcome_unknown");
    expect(causes).not.toContain("submission_interrupted");
  });

  it("are every member of FailureCause, and nothing else", () => {
    // A `Record` over the union must name every member, or this does not
    // compile; its keys are then held equal to the runtime list.
    const every: Record<FailureCause, true> = {
      provider_refused: true,
      provider_unreachable: true,
      send_interrupted: true,
      opted_out: true,
      no_send_key: true,
      media_unavailable: true,
      undelivered: true,
    };

    expect([...FAILURE_CAUSES].sort()).toEqual(Object.keys(every).sort());
    expect(Object.isFrozen(FAILURE_CAUSES)).toBe(true);
  });

  it.each([...FAILURE_CAUSES])("reads %s as itself", (cause) => {
    const event = parseMessageEvent({ ...MESSAGE_FAILED, data: { ...SENT_DATA, failure: { cause } } });

    if (event.type !== "message.failed") {
      throw new Error("expected message.failed");
    }
    expect(event.message.failureCause).toBe(cause);
  });

  it("still reads a cause this release does not know, as a plain string", () => {
    const event = parseMessageEvent({
      ...MESSAGE_FAILED,
      data: { ...SENT_DATA, failure: { cause: "carrier_on_fire" } },
    });

    if (event.type !== "message.failed") {
      throw new Error("expected message.failed");
    }
    const cause: string | null = event.message.failureCause;
    expect(cause).toBe("carrier_on_fire");
    expect((FAILURE_CAUSES as readonly string[]).includes(cause ?? "")).toBe(false);
  });
});

describe("message.received", () => {
  it("reads the spec's example", () => {
    const event = parseMessageEvent(MESSAGE_RECEIVED);

    expect(event.type).toBe("message.received");
    if (event.type !== "message.received") {
      return;
    }
    expect(event.eventId).toBe("0198c4a1-e7b3-7a41-9c62-5f0d8a1b2c3d");
    expect(event.occurredAt?.toISOString()).toBe("2026-08-16T11:14:07.000Z");
    expect(event.message).toMatchObject({
      id: "0198c4a1-6f70-7182-b394-4d5e6f708192",
      tenantId: "0198c4a1-b425-76e7-18e9-031425364a5b",
      customerId: "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081",
      kind: "mms",
      from: "+13025556789",
      to: "+14075550100",
      body: "Here is the referral form.",
    });
    expect(event.message.receivedAt?.toISOString()).toBe("2026-08-16T11:14:07.000Z");
    expect(event.message.media).toHaveLength(1);
    expect(event.message.media[0]).toEqual({
      contentType: "image/jpeg",
      filename: "photo.jpg",
      size: 40213,
      raw: { contentType: "image/jpeg", filename: "photo.jpg", size: 40213 },
    });
    expect(event.raw).toBe(MESSAGE_RECEIVED);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.message)).toBe(true);
  });

  it("keeps its media items without a download link", () => {
    // `message.received` is unchanged by the API's 2026-10-23 links: a
    // webhook body can reach logs and a retry can arrive hours later, so
    // only `inboundMessages.get()` hands out a link. Even a body that did
    // carry one does not surface it; it stays in `raw`.
    const linked = {
      contentType: "image/jpeg",
      filename: "photo.jpg",
      size: 40213,
      contentUrl: "https://api.yourprovider.example/v1/inbound-messages/x/media/y/content",
      expiresAt: "2026-08-16T11:19:07+00:00",
    };
    const event = parseMessageEvent({
      ...MESSAGE_RECEIVED,
      data: { ...MESSAGE_RECEIVED.data, media: [linked] },
    });
    if (event.type !== "message.received") {
      throw new Error("expected message.received");
    }

    const item = event.message.media[0];
    expect("contentUrl" in (item ?? {})).toBe(false);
    expect("expiresAt" in (item ?? {})).toBe(false);
    expect(item?.raw).toEqual(linked);
    // @ts-expect-error — a webhook media item has no link.
    void item?.contentUrl;
  });

  it("carries none of the members only a sent message has", () => {
    const event = parseMessageEvent(MESSAGE_RECEIVED);
    if (event.type !== "message.received") {
      throw new Error("expected message.received");
    }

    for (const member of ["source", "status", "sentBy", "sentAt", "providerMessageId", "failureCause"]) {
      expect(member in event.message).toBe(false);
    }
    // @ts-expect-error — a received message has no provider id.
    void event.message.providerMessageId;
  });

  it.each([null, "nonsense", 42, [], { id: 7, media: "x", receivedAt: "not a date" }])(
    "reads a malformed data member (%j) as nulls and never throws",
    (data) => {
      const event = parseMessageEvent({ ...MESSAGE_RECEIVED, data });

      expect(event.type).toBe("message.received");
      if (event.type !== "message.received") {
        return;
      }
      expect(event.message.from).toBeNull();
      expect(event.message.receivedAt).toBeNull();
      expect(event.message.media).toEqual([]);
    },
  );
});

describe("message.sent, message.delivered, message.failed", () => {
  it("reads the spec's message.sent example", () => {
    const event = parseMessageEvent(MESSAGE_SENT);

    expect(event.type).toBe("message.sent");
    if (event.type !== "message.sent") {
      return;
    }
    expect(event.eventId).toBe("0192f0c2-1a7b-7c4d-9e8f-0a1b2c3d4e5f");
    expect(event.occurredAt?.toISOString()).toBe("2026-10-19T15:06:01.000Z");
    expect(event.message).toMatchObject({
      id: "0192f0c1-8e4a-7b3d-a2c5-6d7e8f901234",
      tenantId: "0191aa10-2b3c-7d4e-8f90-a1b2c3d4e5f6",
      customerId: "0191ab22-3c4d-7e5f-9a01-b2c3d4e5f607",
      source: "phone_system",
      kind: "sms",
      from: "+14075550142",
      to: "+13215550187",
      body: "Yes, a little grass is fine. Call us if he vomits.",
      media: [],
      status: "sent",
      providerMessageId: "01JC8ZB2H6V4S9D3Q7N1M5KTXR",
      providerPartIds: ["01JC8ZB2H6V4S9D3Q7N1M5KTXR"],
    });
    expect(event.message.sentBy).toMatchObject({ kind: "phone_system_user", name: "Dana Smith" });
    expect(event.message.sentAt?.toISOString()).toBe("2026-10-19T15:06:01.000Z");
    expect("receivedAt" in event.message).toBe(false);
    expect("failureCause" in event.message).toBe(false);
    // @ts-expect-error — only message.failed carries a cause.
    void event.message.failureCause;
  });

  it("reads message.delivered with the same members", () => {
    const event = parseMessageEvent(MESSAGE_DELIVERED);

    expect(event.type).toBe("message.delivered");
    if (event.type !== "message.delivered") {
      return;
    }
    expect(event.message.status).toBe("delivered");
    expect(event.message.providerMessageId).toBe("01JC8ZB2H6V4S9D3Q7N1M5KTXR");
  });

  it("reads message.failed with its cause", () => {
    const event = parseMessageEvent(MESSAGE_FAILED);

    expect(event.type).toBe("message.failed");
    if (event.type !== "message.failed") {
      return;
    }
    expect(event.message.status).toBe("undelivered");
    expect(event.message.failureCause).toBe("undelivered");
    expect(event.message.sentBy?.name).toBe("Dana Smith");
  });

  it("reads null provider members for a message that never left", () => {
    const event = parseMessageEvent({
      ...MESSAGE_FAILED,
      data: {
        ...MESSAGE_FAILED.data,
        source: "api",
        status: "failed",
        sentBy: null,
        sentAt: null,
        providerMessageId: null,
        providerPartIds: null,
        failure: { cause: "provider_refused" },
      },
    });

    if (event.type !== "message.failed") {
      throw new Error("expected message.failed");
    }
    expect(event.message.sentBy).toBeNull();
    expect(event.message.sentAt).toBeNull();
    expect(event.message.providerMessageId).toBeNull();
    expect(event.message.providerPartIds).toBeNull();
    expect(event.message.failureCause).toBe("provider_refused");
  });

  it("still reads an empty part-id list as an empty list", () => {
    // The API never sends `[]` any more (null exactly when the message id is
    // null), but the reader does not flatten `[]` into null: what arrived is
    // what you read.
    const event = parseMessageEvent({
      ...MESSAGE_FAILED,
      data: { ...MESSAGE_FAILED.data, providerMessageId: null, providerPartIds: [] },
    });

    if (event.type !== "message.failed") {
      throw new Error("expected message.failed");
    }
    expect(event.message.providerPartIds).toEqual([]);
  });

  it("keeps values and members this release does not know", () => {
    const payload = {
      ...MESSAGE_FAILED,
      future: true,
      data: {
        ...MESSAGE_FAILED.data,
        source: "carrier_pigeon",
        sentBy: { kind: "phone_system_robot", name: null },
        failure: { cause: "eaten_by_dog", detail: "x" },
      },
    };

    const event = parseMessageEvent(payload);

    if (event.type !== "message.failed") {
      throw new Error("expected message.failed");
    }
    expect(event.message.source).toBe("carrier_pigeon");
    expect(event.message.sentBy).toMatchObject({ kind: "phone_system_robot", name: null });
    expect(event.message.failureCause).toBe("eaten_by_dog");
    expect(event.raw.future).toBe(true);
  });

  it("reads outbound media items by content type and size", () => {
    const event = parseMessageEvent({
      ...MESSAGE_SENT,
      data: { ...SENT_DATA, kind: "mms", media: [{ contentType: "image/png", size: 512 }] },
    });

    if (event.type !== "message.sent") {
      throw new Error("expected message.sent");
    }
    expect(event.message.media[0]).toEqual({
      contentType: "image/png",
      size: 512,
      raw: { contentType: "image/png", size: 512 },
    });
    // An outbound item has no filename: the platform keeps none for it.
    expect("filename" in (event.message.media[0] ?? {})).toBe(false);
    // @ts-expect-error — a media item sent from your number has no filename.
    void event.message.media[0]?.filename;
  });

  it("no longer reads the old bytes and encoding members", () => {
    // `bytes` and `encoding` left the wire in 0.23.0; an item that still
    // carries them reads no size, and the old members stay on `raw` only.
    const event = parseMessageEvent({
      ...MESSAGE_RECEIVED,
      data: {
        ...MESSAGE_RECEIVED.data,
        media: [{ contentType: "image/jpeg", filename: "a.jpg", encoding: "base64", bytes: 9 }],
      },
    });

    if (event.type !== "message.received") {
      throw new Error("expected message.received");
    }
    const item = event.message.media[0];
    expect(item?.size).toBeNull();
    expect(item?.raw.bytes).toBe(9);
    // @ts-expect-error — `encoding` is gone.
    void item?.encoding;
  });

  it("reads a failure that is not an object as no cause", () => {
    const event = parseMessageEvent({ ...MESSAGE_FAILED, data: { ...SENT_DATA, failure: "x" } });

    if (event.type !== "message.failed") {
      throw new Error("expected message.failed");
    }
    expect(event.message.failureCause).toBeNull();
  });
});

describe("anything else", () => {
  it.each([null, undefined, "message.sent", 42, [], [MESSAGE_SENT], {}, { type: 7 }])(
    "reads %j as an unknown event and never throws",
    (payload) => {
      const event = parseMessageEvent(payload);

      expect(event.type).toBeNull();
      expect("message" in event).toBe(false);
      expect(event.eventId).toBeNull();
      expect(event.occurredAt).toBeNull();
    },
  );

  it.each(["fax.completed", "message.queued", "MESSAGE.SENT"])(
    "reads type %j as an unknown event, with the body on raw",
    (type) => {
      const payload = { ...MESSAGE_SENT, type };

      const event = parseMessageEvent(payload);

      expect(event.type).toBeNull();
      expect(event.eventId).toBe(MESSAGE_SENT.eventId);
      expect(event.raw.type).toBe(type);
      // @ts-expect-error — an unknown event carries no message to read.
      void event.message;
    },
  );
});

describe("test events", () => {
  // A test sent with `webhookEndpoints.sendTest()` carries the published
  // example body for its type plus `test: true`. Every id in it is
  // illustrative, so a receiver must be able to tell it apart from a real
  // event — on every variant, before it reads anything else.
  it.each([MESSAGE_RECEIVED, MESSAGE_SENT, MESSAGE_DELIVERED, MESSAGE_FAILED])(
    "reads test: true on $type",
    (payload) => {
      const event = parseMessageEvent({ ...payload, test: true });

      expect(event.type).toBe(payload.type);
      expect(event.test).toBe(true);
    },
  );

  it.each([MESSAGE_RECEIVED, MESSAGE_SENT, MESSAGE_DELIVERED, MESSAGE_FAILED])(
    "reads test: false on a real $type, which carries no test member",
    (payload) => {
      expect("test" in payload).toBe(false);

      expect(parseMessageEvent(payload).test).toBe(false);
    },
  );

  // Each case is wrapped in its own array: `it.each` spreads an array case
  // into arguments, so a bare `[true]` would arrive as `true`.
  it.each([[false], ["true"], [1], [null], [{}], [[true]]])(
    "reads test %j as false: only the literal true marks a test",
    (value) => {
      expect(parseMessageEvent({ ...MESSAGE_SENT, test: value }).test).toBe(false);
    },
  );

  it("reads the webhook.test ping as an unknown event that is a test", () => {
    const ping = {
      eventId: "019a0b3c-5d6e-7f80-9a1b-2c3d4e5f6071",
      type: "webhook.test",
      occurredAt: "2026-10-22T15:04:05+00:00",
      test: true,
      data: { endpointId: "0198c4a1-8192-73b4-e5b6-708192031425" },
    };

    const event = parseMessageEvent(ping);

    expect(event.type).toBeNull();
    expect(event.test).toBe(true);
    expect(event.eventId).toBe(ping.eventId);
  });

  it.each([[null], [undefined], ["x"], [42], [[]], [[{ test: true }]]])(
    "reads %j as not a test, and never throws",
    (payload) => {
      expect(parseMessageEvent(payload).test).toBe(false);
    },
  );

  it("is a boolean on every variant, at compile time", () => {
    // `MessageEvent["test"]` is the union of the variants' members, so this
    // fails `npm run typecheck` if any variant lacks it or widens it.
    const same: [MessageEvent["test"]] extends [boolean]
      ? [boolean] extends [MessageEvent["test"]]
        ? true
        : false
      : false = true;
    expect(same).toBe(true);
  });

  it("reads the envelope member the spec publishes: optional, and only ever true", () => {
    // The drift lock for the wire side: the parser reads `test === true`
    // because the spec's envelope declares `test?: true`. It fails
    // `npm run typecheck` the day that member is renamed, dropped or widened.
    type Wire = components["schemas"]["WebhookEventEnvelope"]["test"];
    const same: [Wire] extends [true | undefined]
      ? [true | undefined] extends [Wire]
        ? true
        : false
      : false = true;
    expect(same).toBe(true);
  });

  it("is frozen with the rest of the event", () => {
    const event = parseMessageEvent({ ...MESSAGE_SENT, test: true });

    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as unknown as { test: boolean }).test = false;
    }).toThrow(TypeError);
  });
});

describe("narrowing on type", () => {
  /** What a receiver writes. It must compile with no cast. */
  function describeEvent(event: MessageEvent): string {
    switch (event.type) {
      case "message.received":
        return `received from ${event.message.from} at ${event.message.receivedAt?.toISOString()}`;
      case "message.sent":
      case "message.delivered":
        return `${event.type} by ${event.message.sentBy?.name ?? "nobody"}`;
      case "message.failed":
        return `failed: ${event.message.failureCause}`;
      case null:
        return `ignored ${String(event.raw.type)}`;
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }

  it("lets a switch reach every variant's own members", () => {
    expect(describeEvent(parseMessageEvent(MESSAGE_RECEIVED))).toBe(
      "received from +13025556789 at 2026-08-16T11:14:07.000Z",
    );
    expect(describeEvent(parseMessageEvent(MESSAGE_SENT))).toBe("message.sent by Dana Smith");
    expect(describeEvent(parseMessageEvent(MESSAGE_DELIVERED))).toBe(
      "message.delivered by Dana Smith",
    );
    expect(describeEvent(parseMessageEvent(MESSAGE_FAILED))).toBe("failed: undelivered");
    expect(describeEvent(parseMessageEvent({ type: "fax.completed" }))).toBe(
      "ignored fax.completed",
    );
  });

  it("gives the three outbound events one data type", () => {
    const outbound: OutboundMessageEventData[] = [];
    for (const payload of [MESSAGE_SENT, MESSAGE_DELIVERED, MESSAGE_FAILED]) {
      const event = parseMessageEvent(payload);
      if (
        event.type === "message.sent" ||
        event.type === "message.delivered" ||
        event.type === "message.failed"
      ) {
        outbound.push(event.message);
      }
    }

    expect(outbound.map((message) => message.status)).toEqual(["sent", "delivered", "undelivered"]);
  });
});

describe("the media item shapes", () => {
  // The drift lock for the two media items, in both directions: every member
  // the generated schema declares is a member of the model, and the model has
  // no member besides those and `raw`. `npm run typecheck` fails on the first
  // difference — against the spec from before 0.23.0 (`bytes`, `encoding`,
  // one `...MediaPart` schema per surface) it fails on the names alone.
  type SameKeys<Model, Wire> = [Exclude<keyof Model, "raw">] extends [keyof Wire]
    ? [keyof Wire] extends [Exclude<keyof Model, "raw">]
      ? true
      : false
    : false;

  it("are the spec's OutboundMessageMediaItem and InboundMessageMediaItem", () => {
    const outbound: SameKeys<
      OutboundMessageMediaItem,
      components["schemas"]["OutboundMessageMediaItem"]
    > = true;
    const inbound: SameKeys<
      InboundMessageMediaItem,
      components["schemas"]["InboundMessageMediaItem"]
    > = true;
    expect([outbound, inbound]).toEqual([true, true]);
  });
});
