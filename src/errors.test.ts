/**
 * The error fold nothing else reaches any more.
 *
 * `throwForResponse` folds two answer shapes into one typed error: the
 * JSON:API error document the whole API speaks — covered from the caller's
 * side by every refusal test in auth.test.ts and faxes.test.ts — and RFC
 * 6749's flat `{"error": ..., "error_description": ...}`.
 *
 * THE FLAT ONE HAS NO CALLER LEFT INSIDE THIS PACKAGE. Since the mint moved
 * to `POST /v1/integration/token`, which refuses with JSON:API documents,
 * that branch is reachable only through `Ringivo.request()` — the supported
 * escape hatch onto endpoints this client does not wrap, the platform's own
 * /oauth/token among them. Kept code with no test is code that rots quietly,
 * so this is the test.
 */
import { describe, expect, it } from "vitest";

import { ApiError, AuthenticationError, throwForResponse } from "./errors.js";

describe("the RFC 6749 flat error shape", () => {
  it("folds into the same typed error a JSON:API document would", async () => {
    const response = new Response(
      JSON.stringify({
        error: "invalid_client",
        error_description: "Client authentication failed",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );

    const error = (await throwForResponse(response).catch(
      (caught: unknown) => caught,
    )) as AuthenticationError;

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
});
