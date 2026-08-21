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
import { describe, expect, it } from "vitest";

import { ApiError, AuthenticationError, throwForResponse } from "./errors.js";

/** The typed error this response folds into, without the try/catch noise. */
async function fold(body: unknown, status: number): Promise<ApiError> {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
    // The four the mint can answer with. A fold that special-cased
    // `invalid_client` would pass the test above and fail every caller who
    // branched on one of the other three.
    const vocabulary = [
      { code: "unauthorized_client", status: 403 },
      { code: "invalid_request", status: 400 },
      { code: "invalid_scope", status: 400 },
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
        error: "invalid_request",
        error_description: "Name the tenant you are acting for.",
        hint: "Check the `tenant` parameter",
      },
      400,
    );

    expect(error.code).toBe("invalid_request");
    expect(error.errors[0]?.raw).toEqual({
      error: "invalid_request",
      error_description: "Name the tenant you are acting for.",
      hint: "Check the `tenant` parameter",
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

  it("gives a body it can read as neither shape back to the caller whole", async () => {
    // The mint is rate-limited by a layer in front of it, and that layer's
    // 429 is neither shape. The STATUS is the contract there; the body is
    // not, so nothing is invented from it — but it is kept verbatim on
    // `.body` and excerpted into the message, which is what a caller reading
    // a log line needs.
    const error = await fold({ message: "Too Many Attempts." }, 429);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(429);
    expect(error.code).toBeNull();
    expect(error.errors).toEqual([]);
    expect(error.body).toBe('{"message":"Too Many Attempts."}');
    expect(error.message).toContain("Too Many Attempts.");
  });
});
