/**
 * The retry loop, the per-call options and the custom `fetch`, from the
 * outside: every request here goes through a `fetch` this file hands the
 * client, so what was sent, how often and with which headers is read off
 * the wire rather than off the implementation.
 *
 * The waits are real but short: a `Retry-After: 0` asks for no wait, and the
 * backoff cases replace `setTimeout` for the length of one test so the delay
 * the loop ASKED for is recorded and the test does not sleep through it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiConnectionError,
  ApiTimeoutError,
  ConflictError,
  DEFAULT_MAX_RETRIES,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  RequestAbortedError,
  Ringivo,
  UnprocessableEntityError,
  isRetryable,
} from "../src/index.js";

const BASE_URL = "https://api.yourprovider.example";
const TENANT_ID = "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8";
const FAX_ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";
const FAX_ACCOUNT_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";

/** A fake API: the mint always answers; the resource answers from a script. */
class Wire {
  readonly sent: Request[] = [];
  readonly bodies: string[] = [];
  mints = 0;
  #script: Array<() => Response | Promise<Response>>;

  constructor(script: Array<() => Response | Promise<Response>>) {
    this.#script = script;
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === "/oauth/token") {
      this.mints += 1;
      return json({ token_type: "Bearer", access_token: `tok-${this.mints}`, expires_in: 900 });
    }
    this.sent.push(request);
    this.bodies.push(await request.clone().text());
    const next = this.#script.shift();
    if (!next) {
      throw new Error(`unexpected request #${this.sent.length}: ${request.method} ${request.url}`);
    }
    return next();
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json", ...headers },
  });
}

function refusal(status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ errors: [{ status: String(status), title: "Refused", ...extra }] }, status, headers);
}

function fax(): Response {
  return json({ data: { type: "faxes", id: FAX_ID, attributes: { status: "delivered" } } });
}

function client(wire: Wire, options: { maxRetries?: number; timeoutMs?: number; defaultHeaders?: Record<string, string> } = {}): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: TENANT_ID,
    scopes: ["fax:read", "fax:write", "fax-accounts:write"],
    fetch: wire.fetch,
    ...options,
  });
}

/** A TypeError shaped like the one Node's fetch throws when the connection is refused. */
function connectionRefused(): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("which answers are retried", () => {
  it("retries a 503 and a 429 on a read, then answers the success", async () => {
    const wire = new Wire([
      () => refusal(503, {}, { "Retry-After": "0" }),
      () => refusal(429, {}, { "Retry-After": "0" }),
      () => fax(),
    ]);

    const result = await client(wire).faxes.get(FAX_ID);

    expect(result.id).toBe(FAX_ID);
    expect(wire.sent).toHaveLength(3);
  });

  it("gives up after maxRetries and throws the last answer", async () => {
    const wire = new Wire([
      () => refusal(502, {}, { "Retry-After": "0" }),
      () => refusal(502, {}, { "Retry-After": "0" }),
      () => refusal(503, { detail: "the last one" }, { "Retry-After": "0" }),
    ]);

    const error = await client(wire).faxes.get(FAX_ID).catch((caught: unknown) => caught);

    expect(DEFAULT_MAX_RETRIES).toBe(2);
    expect(wire.sent).toHaveLength(3);
    expect(error).toBeInstanceOf(InternalServerError);
    expect((error as InternalServerError).statusCode).toBe(503);
    expect(isRetryable(error)).toBe(true);
  });

  it("does not retry an answer that will be the same next time", async () => {
    for (const [status, Class] of [
      [404, NotFoundError],
      [422, UnprocessableEntityError],
      [409, ConflictError],
    ] as const) {
      const wire = new Wire([() => refusal(status)]);
      const error = await client(wire).faxes.get(FAX_ID).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Class);
      expect(wire.sent).toHaveLength(1);
    }
  });

  it("retries the 409 that says the first request with this key still runs", async () => {
    const wire = new Wire([
      () => refusal(409, { code: "idempotency_key_in_use" }, { "Retry-After": "0" }),
      () => json({ data: { type: "faxes", id: FAX_ID, attributes: { status: "queued" } } }, 202),
    ]);

    await client(wire).faxes.send({ faxAccount: FAX_ACCOUNT_ID, to: "+13025556789", file: new Uint8Array([37, 80, 68, 70]) });

    expect(wire.sent).toHaveLength(2);
    expect(wire.sent[1]?.headers.get("idempotency-key")).toBe(wire.sent[0]?.headers.get("idempotency-key"));
    expect(wire.bodies[1]).toBe(wire.bodies[0]);
  });

  it("retries a request that got no answer, and wraps the last one", async () => {
    const wire = new Wire([
      () => {
        throw connectionRefused();
      },
      () => fax(),
    ]);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    expect((await client(wire).faxes.get(FAX_ID)).id).toBe(FAX_ID);
    expect(wire.sent).toHaveLength(2);

    const down = new Wire([
      () => {
        throw connectionRefused();
      },
    ]);
    const error = await client(down, { maxRetries: 0 }).faxes.get(FAX_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiConnectionError);
    expect(error).not.toBeInstanceOf(ApiTimeoutError);
    expect((error as Error).message).toContain("ECONNREFUSED");
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    expect(isRetryable(error)).toBe(true);
  });

  it("does not wait out a Retry-After longer than a minute: it hands it to the caller", async () => {
    const wire = new Wire([() => refusal(429, { code: "transcription_capped" }, { "Retry-After": "3600" })]);

    const error = await client(wire).faxes.get(FAX_ID).catch((caught: unknown) => caught);

    expect(wire.sent).toHaveLength(1);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(3600);
  });

  it("waits the backoff when the server names no Retry-After: 0.5 s, then 1 s, less jitter", async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const wire = new Wire([() => refusal(500), () => refusal(500), () => fax()]);

    await client(wire).faxes.get(FAX_ID);

    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(375);
    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[1]).toBeGreaterThanOrEqual(750);
    expect(delays[1]).toBeLessThanOrEqual(1000);
  });
});

describe("which requests are retried", () => {
  it("never resends a create that carries no Idempotency-Key", async () => {
    // A lost answer may hide a row that was made: a second POST would make another.
    const wire = new Wire([() => refusal(503, {}, { "Retry-After": "0" })]);

    const error = await client(wire)
      .faxAccounts.create({ customer: "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081", name: "Front desk" })
      .catch((caught: unknown) => caught);

    expect(wire.sent).toHaveLength(1);
    expect(error).toBeInstanceOf(InternalServerError);
  });

  it("resends a PATCH: setting a value twice leaves the same value", async () => {
    const wire = new Wire([
      () => refusal(503, {}, { "Retry-After": "0" }),
      () => json({ data: { type: "fax-accounts", id: FAX_ACCOUNT_ID, attributes: { name: "Desk" } } }),
    ]);

    await client(wire).faxAccounts.update(FAX_ACCOUNT_ID, { name: "Desk" });

    expect(wire.sent).toHaveLength(2);
    expect(wire.sent.map((request) => request.method)).toEqual(["PATCH", "PATCH"]);
    expect(wire.bodies[1]).toBe(wire.bodies[0]);
  });

  it("sends once when maxRetries is 0, on the client or on the call", async () => {
    const onClient = new Wire([() => refusal(503, {}, { "Retry-After": "0" })]);
    await client(onClient, { maxRetries: 0 }).faxes.get(FAX_ID).catch(() => undefined);
    expect(onClient.sent).toHaveLength(1);

    const onCall = new Wire([() => refusal(503, {}, { "Retry-After": "0" })]);
    await client(onCall).faxes.get(FAX_ID, {}, { maxRetries: 0 }).catch(() => undefined);
    expect(onCall.sent).toHaveLength(1);
  });

  it("refuses a maxRetries that is not a whole number, 0 or more", () => {
    expect(() => client(new Wire([]), { maxRetries: -1 })).toThrow(TypeError);
    expect(() => client(new Wire([]), { maxRetries: 1.5 })).toThrow(TypeError);
  });
});

describe("per-call options", () => {
  it("sends the call's headers over the client's defaultHeaders, and keeps its own User-Agent", async () => {
    const wire = new Wire([() => fax()]);

    await client(wire, { defaultHeaders: { "X-Trace": "client", "X-Team": "ops" } }).faxes.get(
      FAX_ID,
      {},
      { headers: { "X-Trace": "call", "User-Agent": "mine/1.0" } },
    );

    const sent = wire.sent[0];
    expect(sent?.headers.get("x-trace")).toBe("call");
    expect(sent?.headers.get("x-team")).toBe("ops");
    expect(sent?.headers.get("user-agent")).toMatch(/^Ringivo\/TS /);
    expect(sent?.headers.get("authorization")).toBe("Bearer tok-1");
  });

  it("stops a call whose signal is aborted, with RequestAbortedError, and does not retry it", async () => {
    const controller = new AbortController();
    const wire = new Wire([
      () => {
        controller.abort(new Error("shutting down"));
        return refusal(503, {}, { "Retry-After": "1" });
      },
    ]);

    const error = await client(wire)
      .faxes.get(FAX_ID, {}, { signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(isRetryable(error)).toBe(false);
    expect(wire.sent).toHaveLength(1);
  });

  it("times one attempt out with the call's timeoutMs, as ApiTimeoutError", async () => {
    const wire = new Wire([
      () =>
        new Promise<Response>(() => {
          // never answers
        }),
    ]);
    // The fake never reads the signal, so the loop's own race decides: hand
    // the loop a fetch that honours it, the way the platform's does.
    const honouring = async (request: Request): Promise<Response> =>
      new URL(request.url).pathname === "/oauth/token"
        ? wire.fetch(request)
        : new Promise((_, reject) => {
            void wire.fetch(request);
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });

    const ringivo = new Ringivo({
      baseUrl: BASE_URL,
      clientId: "cid",
      clientSecret: "csecret",
      tenant: TENANT_ID,
      scopes: ["fax:read"],
      fetch: honouring,
      maxRetries: 0,
    });

    const error = await ringivo.faxes.get(FAX_ID, {}, { timeoutMs: 20 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTimeoutError);
    expect(error).toBeInstanceOf(ApiConnectionError);
    expect(isRetryable(error)).toBe(true);
  });
});

describe("the 401 refresh", () => {
  it("is not a retry: it happens with maxRetries 0, once", async () => {
    const wire = new Wire([() => refusal(401), () => fax()]);

    await client(wire, { maxRetries: 0 }).faxes.get(FAX_ID);

    expect(wire.mints).toBe(2);
    expect(wire.sent.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer tok-1",
      "Bearer tok-2",
    ]);
  });
});

describe("header precedence", () => {
  it("defaultHeaders fill in, and never replace the media type a method sets for its endpoint", async () => {
    const wire = new Wire([
      () => json({ data: { type: "fax-accounts", id: FAX_ACCOUNT_ID, attributes: { name: "Desk" } } }, 201),
    ]);

    await client(wire, {
      defaultHeaders: { Accept: "text/plain", "Content-Type": "text/plain", "X-Team": "ops" },
    }).faxAccounts.create({ customer: "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081", name: "Desk" });

    const sent = wire.sent[0];
    expect(sent?.headers.get("accept")).toBe("application/vnd.api+json");
    expect(sent?.headers.get("content-type")).toBe("application/vnd.api+json");
    expect(sent?.headers.get("x-team")).toBe("ops");
  });

  it("an Idempotency-Key in a call's headers makes that call resendable; one in defaultHeaders does not", async () => {
    const post = (): Request => new Request(`${BASE_URL}/v1/anything`, { method: "POST", body: "{}" });

    const keyed = new Wire([() => refusal(503, {}, { "Retry-After": "0" }), () => json({}, 202)]);
    await client(keyed).request(post(), { headers: { "Idempotency-Key": "job-7" } });
    expect(keyed.sent).toHaveLength(2);
    expect(keyed.sent.map((request) => request.headers.get("idempotency-key"))).toEqual(["job-7", "job-7"]);

    const defaulted = new Wire([() => refusal(503, {}, { "Retry-After": "0" })]);
    await client(defaulted, { defaultHeaders: { "Idempotency-Key": "same-for-all" } })
      .request(post())
      .catch(() => undefined);
    expect(defaulted.sent).toHaveLength(1);
  });
});

describe("more transient answers", () => {
  it("retries an attempt that timed out", async () => {
    let calls = 0;
    const ringivo = new Ringivo({
      baseUrl: BASE_URL,
      clientId: "cid",
      clientSecret: "csecret",
      tenant: TENANT_ID,
      scopes: ["fax:read"],
      timeoutMs: 20,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/oauth/token") {
          return json({ access_token: "tok", token_type: "Bearer", expires_in: 900 });
        }
        calls += 1;
        if (calls === 1) {
          return new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
        return fax();
      },
    });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    expect((await ringivo.faxes.get(FAX_ID)).id).toBe(FAX_ID);
    expect(calls).toBe(2);
  });

  it("waits a Retry-After given as an HTTP date", async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const soon = new Date(Date.now() + 5_000).toUTCString();
    const wire = new Wire([() => refusal(503, {}, { "Retry-After": soon }), () => fax()]);

    await client(wire).faxes.get(FAX_ID);

    expect(wire.sent).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(3_000);
    expect(delays[0]).toBeLessThanOrEqual(6_000);
  });
});

describe("a runtime without AbortSignal.any", () => {
  it("still aborts, and lets go of the caller's signal after each attempt", async () => {
    const any = AbortSignal.any;
    // Node 20.0 to 20.2 have no AbortSignal.any.
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
    try {
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const wire = new Wire([() => fax(), () => fax(), () => fax()]);
      const ringivo = client(wire);

      for (let i = 0; i < 3; i += 1) {
        await ringivo.faxes.get(FAX_ID, {}, { signal: controller.signal });
      }

      expect(added.mock.calls.length).toBe(3);
      expect(removed.mock.calls.length).toBe(3);

      controller.abort(new Error("stop"));
      const error = await ringivo.faxes
        .get(FAX_ID, {}, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RequestAbortedError);
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: any, configurable: true, writable: true });
    }
  });
});
