/**
 * The one loop every request goes through: one attempt, the 401 refresh, the
 * retries and their backoff, and the errors a request with no answer becomes.
 *
 * Internal. `Ringivo.request()` (authenticated), the token mint (no token)
 * and the signed-link download (no token, on purpose) all call `send()`, so a
 * timeout, a dropped connection and a 503 fail and retry the same way on all
 * three.
 *
 * -- WHAT IS RETRIED ---------------------------------------------------------
 * A request is retried only when sending it twice cannot do the act twice:
 * a GET, HEAD, OPTIONS, PUT or DELETE, or a write the caller marked safe —
 * one that carries an `Idempotency-Key` the endpoint honours, or a PATCH that
 * sets attributes to values (setting a value twice leaves the same value).
 * A POST with no key is never resent: if the first one reached the API and
 * only the answer was lost, a second would create a second row.
 *
 * Then only the answers the API's contract calls transient: no answer at all
 * (a refused or reset connection, a timeout), 408, 429, any 5xx, and the 409
 * `idempotency_key_in_use` that says the first request with this key still
 * runs. Everything else is the same answer the next time.
 *
 * -- HOW LONG IT WAITS -------------------------------------------------------
 * The server's `Retry-After` when it sent one (RFC 9110 section 10.2.3), so a
 * rate limit is waited out as asked. A `Retry-After` longer than
 * `MAX_RETRY_AFTER_SECONDS` is not waited in-process: a daily cap that resets
 * at midnight is the caller's to schedule, and the error carries `retryAfter`
 * for exactly that. Without the header: exponential backoff from 0.5 s,
 * doubling to at most 8 s, less up to 25 % jitter so a fleet of clients that
 * failed together does not retry together.
 *
 * -- THE 401 -----------------------------------------------------------------
 * One resend with a freshly minted token, which does not count against
 * `maxRetries`: a token can expire between the check and the request, and
 * that is not a failure of the request. A second 401 means the credential, not
 * the token, is the problem, and is thrown.
 */
import {
  ApiConnectionError,
  ApiTimeoutError,
  RequestAbortedError,
  isNoAnswer,
  retryAfterSeconds,
  throwForResponse,
} from "./errors.js";

/** The `fetch` this package calls: the platform's, or one the caller supplied. */
export type Fetch = (input: Request) => Promise<Response>;

/** A `Retry-After` longer than this is reported to the caller, not slept through. */
export const MAX_RETRY_AFTER_SECONDS = 60;

const INITIAL_RETRY_DELAY_SECONDS = 0.5;
const MAX_RETRY_DELAY_SECONDS = 8;

/** The 409 code that means "the first request with this key still runs". */
const KEY_IN_USE = "idempotency_key_in_use";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export interface SendContext {
  fetch: Fetch;
  /** Milliseconds one attempt may take. */
  timeoutMs: number;
  /** Retries after the first attempt. 0 sends once. */
  maxRetries: number;
  /** The caller's own stop. */
  signal?: AbortSignal | undefined;
  /**
   * Whether a POST or PATCH may be resent. A safe method is resendable
   * whatever this says; a POST or PATCH only when this is true or the request
   * carries an `Idempotency-Key`.
   */
  resendable?: boolean | undefined;
  /** Returns the bearer token to send; `true` asks for a new one. */
  authorize?: ((forceRefresh: boolean) => Promise<string>) | undefined;
  /**
   * Headers UNDER the request's own: a client's `defaultHeaders`. They fill
   * in what the request does not say, and never replace the `Accept` or
   * `Content-Type` a method set for its own endpoint.
   */
  defaultHeaders?: Headers | undefined;
  /** Headers OVER the request's own: one call's `headers`, then the User-Agent. */
  headers?: Headers | undefined;
}

/**
 * Send `template` (a clone of it per attempt) and return the response, or
 * throw the error it earned.
 */
export async function send(template: Request, context: SendContext): Promise<Response> {
  // The key counts wherever the caller put it: on the request, or in this
  // call's own `headers`. Not in a client's `defaultHeaders` — one key for
  // every request would make every write a replay of the first.
  const resendable =
    SAFE_METHODS.has(template.method.toUpperCase()) ||
    context.resendable === true ||
    template.headers.has("Idempotency-Key") ||
    context.headers?.has("Idempotency-Key") === true;

  let retriesLeft = resendable ? Math.max(0, Math.trunc(context.maxRetries)) : 0;
  let retriesDone = 0;
  let refreshed = false;
  let token = context.authorize ? await context.authorize(false) : undefined;

  for (;;) {
    throwIfAborted(context.signal);

    let response: Response;
    try {
      response = await attempt(template.clone(), context, token);
    } catch (error) {
      const failure = asTransportError(error, context.signal);
      if (failure instanceof ApiConnectionError && retriesLeft > 0) {
        await sleep(backoffMs(retriesDone), context.signal);
        retriesLeft -= 1;
        retriesDone += 1;
        continue;
      }
      throw failure;
    }

    if (response.status === 401 && context.authorize && !refreshed) {
      refreshed = true;
      discard(response);
      token = await context.authorize(true);
      continue;
    }

    if (retriesLeft > 0 && (await isTransient(response))) {
      const delay = retryDelayMs(response, retriesDone);
      if (delay !== undefined) {
        discard(response);
        await sleep(delay, context.signal);
        retriesLeft -= 1;
        retriesDone += 1;
        continue;
      }
    }

    await throwForResponse(response);
    return response;
  }
}

async function attempt(outgoing: Request, context: SendContext, token: string | undefined): Promise<Response> {
  // Lowest first: the client's defaults, the request's own, this call's own.
  const headers = new Headers(context.defaultHeaders);
  outgoing.headers.forEach((value, name) => headers.set(name, value));
  context.headers?.forEach((value, name) => headers.set(name, value));
  if (token !== undefined) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const timeout = AbortSignal.timeout(context.timeoutMs);
  const combined = context.signal ? anySignal(context.signal, timeout) : { signal: timeout, release: noop };
  try {
    return await context.fetch(new Request(outgoing, { headers, signal: combined.signal }));
  } finally {
    combined.release();
  }
}

function noop(): void {}

/**
 * `AbortSignal.any` where the runtime has it (Node 20.3+), the same by hand
 * where it does not. The hand-made one RELEASES its listeners when the
 * attempt settles: a caller's long-lived signal (a server's shutdown signal)
 * would otherwise gather one listener per request.
 */
function anySignal(first: AbortSignal, second: AbortSignal): { signal: AbortSignal; release: () => void } {
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([first, second]), release: noop };
  }
  const controller = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  for (const signal of [first, second]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push([signal, onAbort]);
  }
  return {
    signal: controller.signal,
    release: () => {
      for (const [signal, onAbort] of listeners) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * What a thrown `fetch` becomes. The caller's own abort first, because a
 * timeout racing it must not turn "you stopped it" into "it timed out".
 */
function asTransportError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) {
    return new RequestAbortedError("the request was aborted by its signal", { cause: signal.reason });
  }
  if (isTimeout(error)) {
    return new ApiTimeoutError("the request timed out before the API answered", { cause: error });
  }
  if (isNoAnswer(error)) {
    return new ApiConnectionError(`the request got no answer: ${describe(error)}`, { cause: error });
  }
  return error;
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (cause && typeof cause.code === "string") {
    return cause.code;
  }
  return error instanceof Error ? error.message : String(error);
}

async function isTransient(response: Response): Promise<boolean> {
  const status = response.status;
  if (status === 408 || status === 429 || status >= 500) {
    return true;
  }
  if (status !== 409) {
    return false;
  }
  // Only the key-in-use 409 is transient; every other 409 is a state that
  // answers the same however often it is asked. A clone, so the body is still
  // there for the error the caller may yet get.
  try {
    const document: unknown = JSON.parse(await response.clone().text());
    const errors = (document as { errors?: unknown }).errors;
    return Array.isArray(errors) && (errors[0] as { code?: unknown } | undefined)?.code === KEY_IN_USE;
  } catch {
    return false;
  }
}

/** Milliseconds to wait before the next attempt, or undefined to stop retrying. */
function retryDelayMs(response: Response, retriesDone: number): number | undefined {
  const asked = retryAfterSeconds(response.headers.get("retry-after"));
  if (asked !== undefined) {
    return asked <= MAX_RETRY_AFTER_SECONDS ? asked * 1000 : undefined;
  }
  return backoffMs(retriesDone);
}

function backoffMs(retriesDone: number): number {
  const seconds = Math.min(INITIAL_RETRY_DELAY_SECONDS * 2 ** retriesDone, MAX_RETRY_DELAY_SECONDS);
  const jitter = 1 - Math.random() * 0.25;
  return seconds * jitter * 1000;
}

/**
 * Let go of a response body we will not read, so its connection is freed.
 * NOT awaited: a cancel can wait on a stream that never settles (a mocked
 * response is one), and nothing here needs it finished.
 */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RequestAbortedError("the request was aborted by its signal", { cause: signal.reason });
  }
}

/** A wait the caller's signal can cut short. */
function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError("the request was aborted by its signal", { cause: signal.reason }));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RequestAbortedError("the request was aborted by its signal", { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
