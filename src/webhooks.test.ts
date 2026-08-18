/**
 * Webhook signature verification, from the receiver's side.
 *
 * THE REFUSALS ARE THE TESTS. Every accept case here passes against a
 * `verifyWebhook()` that returns undefined unconditionally, so the ones that
 * carry weight are the four negatives — a tampered body, a stale timestamp,
 * the wrong secret, and a malformed header — plus the cross-implementation
 * vector, which no implementation in this repository produced.
 *
 * The vector is the point of the exercise. A port that agreed only with its
 * own tests would pass while signing something subtly different — the
 * timestamp outside the MAC, a re-encoded body, uppercase hex — and the first
 * real delivery would be rejected. tests/fixtures/webhook-signature-vector.json
 * was computed by the server's own signer; the byte-identical file is
 * committed in the Python client and asserted in the server's own suite too.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_SECONDS,
  RingivoError,
  SIGNATURE_HEADER,
  SignatureVerificationError,
  verifyWebhook,
} from "./index.js";

interface Vector {
  secret: string;
  timestamp: number;
  body: string;
  expected_v1: string;
  header: string;
}

const VECTOR: Vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../tests/fixtures/webhook-signature-vector.json", import.meta.url)),
    "utf8",
  ),
) as Vector;

/**
 * The published recipe, recomputed here rather than imported.
 *
 * Calling the implementation would make these tests agree with whatever it
 * does. Written out, they agree with what the documentation SAYS.
 */
function sign(body: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function header(body: string, secrets: string[], timestamp: number): string {
  return [`t=${timestamp}`, ...secrets.map((secret) => `v1=${sign(body, secret, timestamp)}`)].join(
    ",",
  );
}

const BODY = '{"event_id":"0198b0f8-0000-7000-8000-000000000001","type":"fax.delivered"}';
const SECRET = "whsec_ZmFrZXNlY3JldGZvcnRlc3RzMDEyMzQ1Njc4OWFiY2Rl";
const OTHER_SECRET = "whsec_b3RoZXJzZWNyZXRmb3J0ZXN0czAxMjM0NTY3ODlhYmM";
const NOW = 1755331200;

// -- the cross-implementation vector ---------------------------------------

describe("the server's own vector", () => {
  it("verifies here", () => {
    // The whole reason this file exists. Nothing in this repository computed
    // this header — if the port drifts by one byte, this is what says so.
    expect(() =>
      verifyWebhook(VECTOR.body, VECTOR.header, VECTOR.secret, { now: VECTOR.timestamp }),
    ).not.toThrow();
  });

  it("matches the published recipe independently", () => {
    // Proves the fixture is a real MAC and not a string copied out of an
    // implementation: recomputed here from the documented recipe alone.
    expect(sign(VECTOR.body, VECTOR.secret, VECTOR.timestamp)).toBe(VECTOR.expected_v1);
    expect(VECTOR.header).toBe(`t=${VECTOR.timestamp},v1=${VECTOR.expected_v1}`);
    expect(VECTOR.secret.startsWith("whsec_")).toBe(true);
  });

  it("is verified as the raw bytes it arrived as", () => {
    // The commonest integration mistake with signatures of this shape:
    // parsing the JSON and re-encoding it before verifying. Key order,
    // spacing and escaping are free choices no two encoders make alike, so
    // the re-encoded body must NOT verify — and it must not verify quietly.
    const reencoded = JSON.stringify({ ...(JSON.parse(VECTOR.body) as object), extra: 1 });

    expect(reencoded).not.toBe(VECTOR.body);
    expect(() =>
      verifyWebhook(reencoded, VECTOR.header, VECTOR.secret, { now: VECTOR.timestamp }),
    ).toThrow(SignatureVerificationError);
  });

  it("verifies from a Uint8Array as well as a string", () => {
    // A Node receiver holding `Buffer.concat(chunks)` has bytes, not a
    // string, and must not have to decode them first — decoding and
    // re-encoding is the mistake above wearing a different hat.
    const bytes = new TextEncoder().encode(VECTOR.body);

    expect(() =>
      verifyWebhook(bytes, VECTOR.header, VECTOR.secret, { now: VECTOR.timestamp }),
    ).not.toThrow();
  });
});

// -- the refusals ----------------------------------------------------------

describe("refusals", () => {
  it("refuses a tampered body", () => {
    const tampered = BODY.replace("fax.delivered", "fax.cancelled");

    expect(tampered).not.toBe(BODY);
    expect(() => verifyWebhook(tampered, header(BODY, [SECRET], NOW), SECRET, { now: NOW })).toThrow(
      SignatureVerificationError,
    );
  });

  it("refuses a stale timestamp in either direction", () => {
    // A replay: a genuine body with its genuine header, sent again later.
    // The MAC still matches — it always will — so the window is the only
    // thing that refuses it. Both directions, because a clock ahead of ours
    // is as suspicious as one behind.
    const value = header(BODY, [SECRET], NOW);

    expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW + 299 })).not.toThrow();
    expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW + 301 })).toThrow(
      SignatureVerificationError,
    );
    expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW - 301 })).toThrow(
      SignatureVerificationError,
    );
  });

  it("refuses the wrong secret", () => {
    expect(() =>
      verifyWebhook(BODY, header(BODY, [SECRET], NOW), OTHER_SECRET, { now: NOW }),
    ).toThrow(SignatureVerificationError);
  });

  it("verifies nothing from a malformed header", () => {
    // The header is the one part of a request an attacker controls
    // entirely, so every shape of rubbish must be a refusal and never an
    // exception a receiver did not plan for.
    const rubbish = [
      "",
      "garbage",
      "t=",
      "v1=abc",
      "t=notanumber,v1=abc",
      "t=1755331200",
      "t=-1755331200,v1=abc",
      `v1=${sign(BODY, SECRET, NOW)}`,
      `t=${NOW}`,
    ];

    for (const value of rubbish) {
      expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW }), value).toThrow(
        SignatureVerificationError,
      );
    }
  });

  it("does not read a timestamp that is not ASCII digits", () => {
    // The server's parser is `ctype_digit`: ASCII digits, nothing else. A
    // port written with `Number(value)` would ALSO accept fullwidth digits,
    // leading whitespace and `0x…` — so these headers, whose timestamps are
    // inside the window and whose signatures are genuine, would verify here
    // and be refused by every other implementation.
    //
    // Each needs a VALID signature to discriminate: with a rubbish `v1` the
    // MAC comparison refuses it either way, and the parser is never the
    // thing under test.
    const fullwidth = String(NOW).replace(/[0-9]/g, (d) =>
      String.fromCodePoint(0xff10 + Number(d)),
    );

    expect(fullwidth).not.toBe(String(NOW));

    const notDigits = [fullwidth, ` ${NOW}`, `+${NOW}`, `${NOW}.0`, "1e9", `0x${NOW.toString(16)}`];

    for (const timestamp of notDigits) {
      const value = `t=${timestamp},v1=${sign(BODY, SECRET, NOW)}`;

      expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW }), timestamp).toThrow(
        SignatureVerificationError,
      );
    }
  });

  it("tolerates whitespace around a member, exactly as the Python client does", () => {
    // Not a licence — a MIRROR. Both clients trim the whole member before
    // splitting it, so `t=1755331200\n` is a valid timestamp in both and a
    // deployment cannot end up with one client accepting a delivery the
    // other refuses. This assertion exists because the first draft of the
    // test above claimed the opposite and was wrong: the trim happens before
    // the digits are ever looked at.
    //
    // Nothing reaches this path in practice — an HTTP header value cannot
    // carry a bare newline — so it is written down rather than tightened.
    const signature = sign(BODY, SECRET, NOW);

    for (const value of [` t=${NOW} , v1=${signature} `, `t=${NOW}\n,v1=${signature}`]) {
      expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW }), value).not.toThrow();
    }
  });
});

// -- rotation --------------------------------------------------------------

describe("secret rotation", () => {
  it("tries every v1 candidate so a rotation does not drop deliveries", () => {
    // During a rotation's grace window the header carries two `v1` values,
    // newest first. A receiver holding EITHER copy must verify: the one they
    // have just installed, or the one they have not got round to replacing.
    // Stopping at the first candidate would break exactly one of them, and
    // only for as long as the window lasts — the worst kind of bug to find.
    const value = header(BODY, [SECRET, OTHER_SECRET], NOW);

    expect(value.split("v1=").length - 1).toBe(2);
    expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW })).not.toThrow();
    expect(() => verifyWebhook(BODY, value, OTHER_SECRET, { now: NOW })).not.toThrow();
  });

  it("refuses the old secret once the grace is over", () => {
    expect(() =>
      verifyWebhook(BODY, header(BODY, [SECRET], NOW), OTHER_SECRET, { now: NOW }),
    ).toThrow(SignatureVerificationError);
  });

  it("reads the last valid t and skips members it does not know", () => {
    // Unknown members are skipped rather than refused, so a future scheme
    // version added beside `v1` does not break every receiver at once.
    const value = `${header(BODY, [SECRET], NOW)},v2=whatever,scheme=2`;

    expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW })).not.toThrow();
  });
});

// -- the surface -----------------------------------------------------------

describe("the surface", () => {
  it("publishes the header name so a receiver need not hardcode it", () => {
    expect(SIGNATURE_HEADER).toBe("Ringivo-Signature");
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
  });

  it("defaults the window to five minutes and lets it be narrowed", () => {
    const value = header(BODY, [SECRET], NOW);

    expect(() => verifyWebhook(BODY, value, SECRET, { now: NOW + 299 })).not.toThrow();
    expect(() =>
      verifyWebhook(BODY, value, SECRET, { toleranceSeconds: 60, now: NOW + 61 }),
    ).toThrow(SignatureVerificationError);
  });

  it("uses the receiver's own clock when none is given", () => {
    const now = Math.floor(Date.now() / 1000);

    expect(() => verifyWebhook(BODY, header(BODY, [SECRET], now), SECRET)).not.toThrow();
    expect(() => verifyWebhook(BODY, header(BODY, [SECRET], now - 3600), SECRET)).toThrow(
      SignatureVerificationError,
    );
  });

  it("answers with silence and throws the documented type", () => {
    // It returns undefined on success on purpose: a boolean invites
    // `verifyWebhook(...)` written without the `if`, which is a check that
    // never runs. There is nothing to forget about a thrown error.
    expect(verifyWebhook(BODY, header(BODY, [SECRET], NOW), SECRET, { now: NOW })).toBeUndefined();

    let caught: unknown;
    try {
      verifyWebhook(BODY, "t=1,v1=ff", SECRET, { now: NOW });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SignatureVerificationError);
    expect(caught).toBeInstanceOf(RingivoError);
    expect(caught).toBeInstanceOf(Error);
  });
});
