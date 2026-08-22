/**
 * The error fold, from both sides of the line it straddles.
 *
 * `throwForResponse` folds two answer shapes into one typed error, and which
 * one arrives is decided by WHICH SURFACE refused:
 *
 *  - the mint, `POST /oauth/token`, answers RFC 6749's flat
 *    `{"error": ..., "error_description": ...}`;
 *  - every `/v1` resource answers a JSON:API error document.
 *
 * The JSON:API side is covered from the caller's side by the refusal tests in
 * faxes.test.ts; the mint's vocabulary is covered from the caller's side in
 * auth.test.ts. What is left for this file is the FOLD ITSELF — that both
 * shapes reach the same members, that the flat one puts its `error` where a
 * caller branches rather than only in a message, and that the two do not
 * shadow each other when a body could be read as either.
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError, AuthenticationError, throwForResponse } from "./errors.js";

/** The typed error this response folds into, without the try/catch noise. */
async function fold(body: unknown, status: number): Promise<ApiError> {
  return foldRaw(JSON.stringify(body), status, "application/json");
}

/** The same, for a body that is not JSON at all and must not be assumed to be. */
async function foldRaw(body: string, status: number, contentType: string): Promise<ApiError> {
  const response = new Response(body, { status, headers: { "Content-Type": contentType } });

  return (await throwForResponse(response).catch((caught: unknown) => caught)) as ApiError;
}

/** The same again, for a refusal whose HEADERS are the thing under test. */
async function foldHeaders(status: number, headers: Record<string, string>): Promise<ApiError> {
  const response = new Response("<!DOCTYPE html><html><body>429</body></html>", {
    status,
    headers: { "Content-Type": "text/html", ...headers },
  });

  return (await throwForResponse(response).catch((caught: unknown) => caught)) as ApiError;
}

describe("the RFC 6749 flat error shape", () => {
  it("folds into the same typed error a JSON:API document would", async () => {
    const error = await fold(
      { error: "invalid_client", error_description: "Client authentication failed" },
      401,
    );

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(401);
    // `error` is the machine vocabulary here, so it lands on `code` — the
    // member a caller branches on — and not only in the message.
    expect(error.code).toBe("invalid_client");
    expect(error.errors[0]?.detail).toBe("Client authentication failed");
    expect(error.message).toContain("[invalid_client]");
    expect(error.message).toContain("Client authentication failed");
  });

  it("carries the whole mint vocabulary onto code, not just the one it was written for", async () => {
    // The five the mint can answer with. A fold that special-cased
    // `invalid_client` would pass the test above and fail every caller who
    // branched on one of the other four.
    //
    // Four of the five share a status: RFC 6749 section 5.2 gives the token
    // endpoint 400 for every refusal but a bad credential, so `code` is the
    // only member that separates them. `unauthorized_client` was a 403 until
    // 2026-08-21 and is a 400 now, which changed nothing here — the fold
    // reports whatever status arrived.
    //
    // `unsupported_grant_type` was missing from this list until 0.4.1, and
    // the omission is why the list is worth writing down: the spec and the
    // server have published five all along, and a table that names four
    // reads as the complete set to whoever copies it into a switch.
    const vocabulary = [
      { code: "unauthorized_client", status: 400 },
      { code: "invalid_request", status: 400 },
      { code: "invalid_scope", status: 400 },
      { code: "unsupported_grant_type", status: 400 },
      { code: "invalid_client", status: 401 },
    ];

    for (const { code, status } of vocabulary) {
      const error = await fold({ error: code, error_description: "why" }, status);
      expect(error.code, `the ${code} refusal`).toBe(code);
      expect(error.statusCode, `the ${code} refusal`).toBe(status);
    }
  });

  it("keeps a member the standard does not require and this client does not read", async () => {
    // Some OAuth servers add a `hint` beside the two required members, and a
    // parser that dropped whatever it did not recognise would take a detail
    // the caller could act on out of their reach. `raw` is the whole
    // document, so an unmodelled member survives the fold.
    const error = await fold(
      {
        error: "invalid_scope",
        error_description: "The requested scope is invalid, unknown, or malformed",
        hint: "Check the `fax:reed` scope",
      },
      400,
    );

    expect(error.code).toBe("invalid_scope");
    expect(error.errors[0]?.raw).toEqual({
      error: "invalid_scope",
      error_description: "The requested scope is invalid, unknown, or malformed",
      hint: "Check the `fax:reed` scope",
    });
  });

  it("survives a refusal that states an error and no description", async () => {
    // `error_description` is optional in RFC 6749. Absent, the caller still
    // gets the code to branch on and a message that says the status.
    const error = await fold({ error: "invalid_scope" }, 400);

    expect(error.code).toBe("invalid_scope");
    expect(error.errors[0]?.detail).toBeNull();
    expect(error.message).toContain("[invalid_scope]");
  });
});

describe("the rate limit's Retry-After", () => {
  it("reads the delta-seconds form, which is what the mint's limiter sends", async () => {
    // The 429 is the one refusal a caller can do something useful about, and
    // the seconds to wait were on the response all along — reachable only by
    // digging the raw header out of a Response the caller never gets handed.
    const error = await foldHeaders(429, { "Retry-After": "60" });

    expect(error.statusCode).toBe(429);
    expect(error.retryAfter).toBe(60);
  });

  it("reads the HTTP-date form too, as seconds from now", async () => {
    // BOTH FORMS ARE LEGAL (RFC 9110 section 10.2.3) and the caller does not
    // get to choose which one arrives. Reading only the integer would answer
    // `undefined` against a perfectly conformant server. It is converted
    // rather than surfaced as a Date so a caller has ONE type to sleep on.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
      const error = await foldHeaders(429, { "Retry-After": "Sat, 22 Aug 2026 12:02:00 GMT" });

      expect(error.retryAfter).toBe(120);
    } finally {
      vi.useRealTimers();
    }
  });

  it("floors a date already past at zero instead of answering a negative sleep", async () => {
    // A skewed clock, or a queued retry read late. Zero means "go now",
    // which is an instruction; a negative number is one a caller would hand
    // to setTimeout, where it means the same thing but only by accident.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
      const error = await foldHeaders(429, { "Retry-After": "Sat, 22 Aug 2026 11:58:00 GMT" });

      expect(error.retryAfter).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing rather than inventing a number it cannot justify", async () => {
    // `undefined` is "the server gave no instruction", which is the caller's
    // cue to use their own backoff. A number invented here would be read as
    // the server's, which is worse than silence.
    //
    // THE LAST TWO ARE THE TRAP, and they are why the date branch may not
    // simply be `Date.parse`. That function is far more forgiving than the
    // grammar: `Date.parse("-5")` is 2001-05-01 and `Date.parse("1.5")` is
    // 2001-01-05 — both real dates, both in the past, so a naive fallback
    // would answer `0` ("retry immediately") for a header that is malformed.
    // `Date.parse("60")` is 1960, which is why the digits are read FIRST.
    const nothing = [
      ["no header at all", {}],
      ["a word", { "Retry-After": "soon" }],
      ["an empty value", { "Retry-After": "" }],
      ["a negative count", { "Retry-After": "-5" }],
      ["a fractional count", { "Retry-After": "1.5" }],
    ] as const;

    for (const [what, headers] of nothing) {
      const error = await foldHeaders(429, headers);
      expect(error.retryAfter, what).toBeUndefined();
    }
  });

  it("is undefined on a refusal that carried no such header, whatever the status", async () => {
    // Nothing about it is 429-only: the member is absent unless the server
    // sent one, so a caller reads `retryAfter` and not the status to decide
    // whether they were told to wait.
    const error = await fold({ error: "invalid_scope" }, 400);

    expect(error.retryAfter).toBeUndefined();
  });
});

describe("the two shapes side by side", () => {
  it("reads a JSON:API document as JSON:API even when it also carries an error member", async () => {
    // The shapes are decided by surface, not sniffed per body — but nothing
    // stops a `/v1` error document growing a top-level `error` member, and
    // the richer shape is the one that must win. `errors[]` carries a
    // `source` that names the member to fix; the flat branch has no such
    // thing to offer.
    const error = await fold(
      {
        errors: [
          {
            status: "422",
            code: "validation_failed",
            detail: "The to field format is invalid.",
            source: { parameter: "to" },
          },
        ],
        error: "invalid_request",
      },
      422,
    );

    expect(error.code).toBe("validation_failed");
    expect(error.errors[0]?.source).toEqual({ parameter: "to" });
  });

  it("gives a body that is not even JSON back to the caller whole", async () => {
    // THE RATE LIMIT, AND IT ARRIVES AS AN HTML PAGE. The limiter sits in
    // front of the mint and is not part of either contract, so its 429 is
    // `text/html` whatever `Accept` was sent — measured against the running
    // platform, not assumed. A parser that took "the mint answers JSON" as
    // licence to call `JSON.parse` without a guard would throw a SyntaxError
    // here and bury a plain rate limit under a crash in the error handler.
    //
    // So the STATUS is the contract and the body is not: nothing is invented
    // from it, it survives verbatim on `.body`, and it is excerpted into the
    // message for whoever reads the log line.
    const page = "<!DOCTYPE html><html><body><h1>429 Too Many Requests</h1></body></html>";
    const error = await foldRaw(page, 429, "text/html");

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(429);
    expect(error.code).toBeNull();
    expect(error.errors).toEqual([]);
    expect(error.body).toBe(page);
    expect(error.message).toContain("429 Too Many Requests");
  });

  it("gives back a JSON body it can read as neither shape", async () => {
    // The other half of "neither shape": parseable, but carrying no `errors`
    // array and no `error` member. Nothing is invented from that either.
    const error = await fold({ message: "Something went wrong." }, 503);

    expect(error.statusCode).toBe(503);
    expect(error.code).toBeNull();
    expect(error.errors).toEqual([]);
    expect(error.message).toContain("Something went wrong.");
  });
});
