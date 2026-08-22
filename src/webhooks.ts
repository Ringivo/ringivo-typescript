/**
 * Prove a webhook body came from your provider, and recently.
 *
 *     import { SIGNATURE_HEADER, verifyWebhook } from "ringivo";
 *
 *     app.post("/hooks/fax", (request, response) => {
 *       verifyWebhook(
 *         request.rawBody,                         // the RAW bytes
 *         request.headers[SIGNATURE_HEADER.toLowerCase()],
 *         YOUR_WHSEC_SECRET,
 *       );
 *       ...
 *     });
 *
 * No client, no network, no credential beyond the `whsec_` secret the
 * endpoint was created with. This is the whole receiving half of the
 * contract.
 *
 * -- SIGN THE RAW BODY, NEVER A RE-ENCODING ---------------------------------
 * The bytes verified must be the bytes that arrived. A receiver that parses
 * the JSON and re-encodes it before verifying WILL fail, and correctly so:
 * key order, unicode escaping and number formatting are free choices no two
 * encoders make identically. This is the single most common integration
 * mistake with signatures of this shape, and in Node it is easy to make by
 * accident — `express.json()` hands you a PARSED object and throws the bytes
 * away. Keep them (`express.json({ verify: (req, _res, buf) => { req.rawBody
 * = buf; } })`), or read the stream yourself.
 *
 * -- WHY THE TIMESTAMP IS INSIDE THE MAC ------------------------------------
 * The signed message is `"<t>.<raw body>"`, not the body alone. Were `t`
 * merely a header beside the signature, an attacker holding one captured
 * delivery could replay it forever under a fresh `t` and the MAC would still
 * check out, because it never covered the time. Binding them means a replay
 * must reuse the original `t`, which is what makes the tolerance window real.
 *
 * -- BOTH HALVES MUST PASS --------------------------------------------------
 * A good MAC under an old `t` is a replay; a fresh `t` with no matching MAC
 * is a forgery. Neither is a delivery, and both throw.
 *
 * -- EVERY `v1` IS TRIED ----------------------------------------------------
 * A second `v1` appears during a rotation's grace window, signed with the
 * previous secret, newest first. A receiver holding EITHER copy must verify —
 * that is the whole reason the window exists — so the loop below does not
 * stop at the first candidate.
 *
 * -- THIS FUNCTION NEEDS `node:crypto` --------------------------------------
 * `createHmac` and `timingSafeEqual` are Node's, so verification runs on a
 * server and not in a browser. That is where it belongs: the secret is a
 * server-side credential, and a `whsec_` shipped to a browser is a `whsec_`
 * that has been published.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { SignatureVerificationError } from "./errors.js";

/** The header a delivery carries its signature in. */
export const SIGNATURE_HEADER = "Ringivo-Signature";

/** How far a delivery's `t` may be from your clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

// Digits only, and nothing else: not a sign, not whitespace, not a fullwidth
// digit `Number()` would happily accept but no signer would ever emit. `^`
// and `$` without the `m` flag anchor the WHOLE string in JavaScript, so a
// trailing newline is not a match either.
const TIMESTAMP = /^[0-9]+$/;

/** What `verifyWebhook` will accept beyond the three required arguments. */
export interface VerifyWebhookOptions {
  /**
   * How far the delivery's timestamp may be from your clock, in seconds.
   * Five minutes by default.
   */
  toleranceSeconds?: number;
  /**
   * The moment to measure against, as a Unix second. Yours by default; pass
   * one to test a receiver deterministically.
   */
  now?: number;
}

/**
 * Throw unless `payload` was signed with `secret`, recently.
 *
 * @param payload - The RAW request body: the bytes as they arrived, or the
 *   string a framework decoded them into. A string is read as UTF-8.
 * @param header - The whole `Ringivo-Signature` header value,
 *   `t=<unix>,v1=<hex>[,v1=<hex>]`. Hand it over exactly as your framework
 *   gave it to you: a value that is not a string — `undefined` or a
 *   `string[]` from `req.headers[name]`, `null` from `Headers.get()` — is
 *   REFUSED with the error below, never a TypeError, so the one catch
 *   documented here is enough for a delivery with no header at all.
 * @param secret - Your endpoint's `whsec_` signing secret.
 * @param options - {@link VerifyWebhookOptions}.
 *
 * @throws {@link SignatureVerificationError} for every failure — a missing or
 *   malformed header, a timestamp outside the window, or no `v1` that
 *   matches. ONE class for all of them, because a receiver has exactly one
 *   useful reaction.
 *
 *   The MESSAGES do name which check failed, and that is a deliberate trade
 *   rather than an oversight: the operator reading their own log needs to
 *   tell a clock-skew problem from a wrong-secret one, and a receiver that
 *   cannot tell them apart debugs a rotation by guesswork. The cost is that
 *   the message must not be echoed to the sender — ANSWER A BARE 400, log
 *   the message on your own side. Telling a stranger which check their
 *   forgery failed is help they should not get. (The Python client made the
 *   same choice; the two clients are kept the same on purpose.)
 *
 * @returns Nothing. Success is silence: a boolean invites
 *   `verifyWebhook(...)` written without the `if`, which is a check that
 *   never runs.
 */
export function verifyWebhook(
  payload: string | Uint8Array,
  header: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): void {
  // A MISSING HEADER IS A REFUSAL, NOT A CRASH — and this is the half of the
  // gate that runs. The `header: string` type stops a TypeScript caller who
  // has a string to lose; this is what everyone else meets, and "everyone
  // else" is not a rare case: `req.headers[name]` is `undefined` when the
  // header did not arrive and a `string[]` when it arrived twice, and
  // `Headers.get()` answers `null`. The example above is written on the first
  // of those.
  //
  // Without this, all three reached `header.split(",")` and threw a raw
  // TypeError. A receiver following the documented catch-and-400 pattern does
  // not catch a TypeError, so an absent header — the commonest misconfiguration
  // there is, and one an attacker can produce at will — answered 500 instead
  // of 400, and the sender retried a delivery nobody had refused.
  if (typeof header !== "string") {
    throw new SignatureVerificationError(
      `the ${SIGNATURE_HEADER} header is missing: expected a string, received ` +
        `${header === null ? "null" : typeof header}`,
    );
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const { timestamp, candidates } = parse(header);

  if (timestamp === null || candidates.length === 0) {
    throw new SignatureVerificationError(
      `the ${SIGNATURE_HEADER} header carried no timestamp and signature pair`,
    );
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const elapsed = Math.abs(now - timestamp);
  if (elapsed > tolerance) {
    throw new SignatureVerificationError(
      `the signature timestamp is ${elapsed}s from now, outside the ${tolerance}s window`,
    );
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");

  // A constant-time compare, never `===`. A short-circuiting comparison over
  // a hex digest leaks how many leading characters were right, which is
  // enough to forge one byte at a time given enough attempts. And every
  // candidate is compared — during a rotation only one of them is signed
  // with the secret this receiver holds.
  if (!candidates.some((candidate) => constantTimeEquals(expected, candidate))) {
    throw new SignatureVerificationError(
      "no signature in the header matches this body and secret",
    );
  }
}

/**
 * Read `t=<unix>,v1=<hex>[,v1=<hex>]` as forgivingly as is safe.
 *
 * Unknown members are skipped rather than refused, so a future scheme
 * version added beside `v1` does not break every receiver at once. A
 * malformed member is simply not a member, and the LAST valid `t` wins.
 */
function parse(header: string): { timestamp: number | null; candidates: string[] } {
  let timestamp: number | null = null;
  const candidates: string[] = [];

  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);

    if (key === "t" && TIMESTAMP.test(value)) {
      timestamp = Number(value);
    } else if (key === "v1" && value) {
      candidates.push(value);
    }
  }

  return { timestamp, candidates };
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * `timingSafeEqual` THROWS on inputs of different lengths rather than
 * answering false, so the lengths are checked first. That check is not a
 * leak: the length of a signature is public, and a candidate of the wrong
 * length was never going to match.
 */
function constantTimeEquals(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(candidate, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
