/**
 * What this client throws, and what each error carries.
 *
 * Every failure a caller can act on is a typed error with the machine-
 * readable part of the answer attached — the HTTP status, the API's own error
 * objects, and the seconds it asked you to wait — so branching on a failure
 * never means parsing a message string. The message exists for a log line and
 * a stack trace, not for code.
 *
 * -- TWO ANSWER SHAPES, AND WHERE THE LINE BETWEEN THEM RUNS ----------------
 * The line runs between the MINT and the RESOURCES, and nowhere else:
 *
 *  - `POST /oauth/token` answers RFC 6749's flat
 *    `{"error": ..., "error_description": ...}` as `application/json`. It is
 *    a standard OAuth endpoint and speaks the standard's own vocabulary —
 *    `invalid_client`, `unauthorized_client`, `invalid_request`,
 *    `invalid_scope`, `unsupported_grant_type`. A member beyond the two the
 *    standard requires is tolerated and kept: some servers add a `hint`, and
 *    whatever arrives reaches the caller on `raw`.
 *  - Everything under `/v1` answers a JSON:API error document
 *    (`{"errors": [...]}`), including the four endpoints whose SUCCESS bodies
 *    are plain JSON.
 *
 * Both fold into `ApiError` here, so a caller has one thing to catch and one
 * member to branch on wherever the refusal came from: `code` carries the
 * JSON:API error's `code` on one side and the OAuth `error` on the other.
 */
import type { Customer, WebhookTestDelivery } from "./models.js";

/**
 * Base class for everything this package throws deliberately.
 *
 * Catch this to catch the SDK. A request that got no answer is one of the
 * three classes below `ApiConnectionError`, with the platform's own error kept
 * on `cause`, so which layer failed is still there to read. A `TypeError` this
 * package did not wrap is a fault in the call itself — a malformed URL, a
 * header value `Headers` refuses — and sending it again fails the same way.
 */
export class RingivoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * One error the API stated, in the members a JSON:API error object carries.
 *
 * A refusal from the mint is folded into this same shape rather than a second
 * one — `error` reaching `code`, `error_description` reaching `detail` — so a
 * caller reads one thing wherever the refusal came from. `raw` is the object
 * exactly as it arrived either way.
 *
 * `code` is the stable machine vocabulary to branch on — and it is genuinely
 * optional: where no published code names the case, the status is the
 * contract and `meta` carries the detail (a fax that cannot be cancelled is
 * the documented example).
 */
export interface ApiErrorDetail {
  readonly status: string | null;
  readonly title: string | null;
  readonly detail: string | null;
  readonly code: string | null;
  readonly source: Readonly<Record<string, unknown>> | null;
  readonly meta: Readonly<Record<string, unknown>> | null;
  /** The whole error object, so a member the API adds still reaches you. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The API answered, and the answer was a refusal. */
export class ApiError extends RingivoError {
  readonly statusCode: number;
  readonly errors: readonly ApiErrorDetail[];
  /** The response body exactly as it arrived, never a re-encoding of it. */
  readonly body: string;
  /**
   * How many seconds the server asked you to wait, when it asked.
   *
   * This is `Retry-After` (RFC 9110 section 10.2.3), read off the response
   * and given to you as SECONDS whichever of the header's two legal forms
   * arrived — a count, or an absolute date this converts for you. A caller
   * sleeping on it wants one type, not a union.
   *
   * THE CASE IT EXISTS FOR IS THE **429**, where the body is no help: the
   * rate limiter sits in front of the mint and answers an HTML page, so the
   * status and this member are the whole machine-readable answer. It is not
   * 429-only, though — a `503` during a maintenance window carries one too,
   * and it is surfaced wherever it arrives.
   *
   * `undefined` means THE SERVER SAID NOTHING (or said something malformed),
   * which is your cue to use your own backoff. It is never a number invented
   * here, because a caller would read that as the server's instruction.
   */
  readonly retryAfter: number | undefined;
  /** The response headers, so a header the API adds still reaches you. */
  readonly headers: Headers;

  constructor(
    message: string,
    options: {
      statusCode: number;
      errors?: readonly ApiErrorDetail[];
      body?: string;
      retryAfter?: number;
      headers?: Headers;
    },
  ) {
    super(message);
    this.statusCode = options.statusCode;
    this.errors = options.errors ?? [];
    this.body = options.body ?? "";
    this.retryAfter = options.retryAfter;
    this.headers = options.headers ?? new Headers();
  }

  /** The first error's machine code, when the answer carried one. */
  get code(): string | null {
    return this.errors[0]?.code ?? null;
  }
}

/**
 * The credential was refused, or the token it bought no longer works.
 *
 * Thrown for a token request refused with a 401 (`invalid_client`: a wrong
 * secret) and for a request that answered 401 twice — once on its own, and
 * once more after the token was force-refreshed. A second 401 means the
 * credential, not the token, is the problem. A token request refused with a
 * 400 (`invalid_scope`, `invalid_request`, `unauthorized_client`) is a
 * `BadRequestError`: branch on its `code`.
 */
export class AuthenticationError extends ApiError {}

/** A 400: the request was malformed — a query parameter, a header or a body this API does not take. */
export class BadRequestError extends ApiError {}

/** A 403: the credential is good and does not allow this — most often a missing scope. */
export class PermissionDeniedError extends ApiError {}

/**
 * A 404: nothing of yours has that id. This includes a row that belongs to
 * somebody else — the API never answers 403 for that, because a 403 would say
 * the row exists.
 */
export class NotFoundError extends ApiError {}

/** A 409: the request was well formed, and the current state refused it. `code` or `title` says which state. */
export class ConflictError extends ApiError {}

/** A 422: a member of the body was refused. `errors[n].source.pointer` names it. */
export class UnprocessableEntityError extends ApiError {}

/** A 429: too many requests. `retryAfter` says how long to wait, when the server said. */
export class RateLimitError extends ApiError {}

/** A 5xx: the API, or a system behind it, failed. Sending the request again may work. */
export class InternalServerError extends ApiError {}

/**
 * The request got no answer: the connection was refused or reset, a name did
 * not resolve, TLS failed. The platform's own error is `cause`.
 *
 * The request may or may not have reached the API, so a write that is not
 * idempotent may have happened. `isRetryable()` is `true` for it.
 */
export class ApiConnectionError extends RingivoError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, configurable: true, writable: true });
    }
  }
}

/** The request took longer than its `timeoutMs`. `isRetryable()` is `true` for it. */
export class ApiTimeoutError extends ApiConnectionError {}

/**
 * The `signal` you passed was aborted. Not retried, and `isRetryable()` is
 * `false` for it: you asked for the stop. The signal's `reason` is `cause`.
 */
export class RequestAbortedError extends RingivoError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, configurable: true, writable: true });
    }
  }
}

/**
 * A 409 `recording_audio_missing`: there is no audio for this capture.
 *
 * Thrown by `pbx.callRecords.requestTranscript()`. The platform holds no audio
 * for the capture, so it cannot be transcribed. Asking again does not help.
 */
export class RecordingAudioMissingError extends ConflictError {}

/**
 * A 429 `transcription_capped`: the daily transcription budget is spent.
 *
 * Thrown by `pbx.callRecords.requestTranscript()`. `retryAfter` gives the
 * seconds until the budget resets at 00:00 UTC. Nothing was started.
 */
export class TranscriptionCappedError extends RateLimitError {}

/**
 * A 429 `transcript_request_limited`: this call was asked about too often.
 *
 * Thrown by `pbx.callRecords.requestTranscript()`. The limit counts asks per
 * CALL, across all of its captures (3 a day by default). `retryAfter` gives
 * the seconds until one more ask is accepted. Nothing was started.
 */
export class TranscriptRequestLimitedError extends RateLimitError {}

/**
 * The refusals that get a class of their own, by the API's `code`. The code is
 * the stable vocabulary, so it decides — not the status alone, which a 429
 * shares with the plain rate limiter.
 */
const BY_CODE: Readonly<Record<string, typeof ApiError>> = Object.freeze({
  recording_audio_missing: RecordingAudioMissingError,
  transcription_capped: TranscriptionCappedError,
  transcript_request_limited: TranscriptRequestLimitedError,
});

/**
 * A webhook body did not prove it came from your provider, recently.
 *
 * One class for every failure — a missing header, a malformed one, a stale
 * timestamp, a wrong secret — because a receiver has exactly one useful
 * reaction to all of them. See verifyWebhook's note on what the MESSAGES
 * say, and on not echoing them back to the sender.
 */
export class SignatureVerificationError extends RingivoError {}

/**
 * `webhookTestDeliveries.wait()` ran out of time while the test was still
 * `pending`.
 *
 * Not an `ApiError`: the API answered every read, and the answer was "not
 * yet". `delivery` is the last result read, so its id is still there to read
 * again later. `isRetryable()` is `false` for it, because there is nothing to
 * send again — read the result later, or send another test.
 *
 * The default wait is longer than the 2 minutes after which the API marks a
 * test with no result `failed`, so with the default this means the API did
 * not do that in time either.
 */
export class WebhookTestTimeoutError extends RingivoError {
  /** The last result read — still `pending`. */
  readonly delivery: WebhookTestDelivery;

  constructor(message: string, delivery: WebhookTestDelivery) {
    super(message);
    this.delivery = delivery;
  }
}

/**
 * `customers.waitForPbx()` ran out of time while the phone system was still
 * being built.
 *
 * Not an `ApiError`: every read was answered, and the answer was "not yet".
 * `customer` is the last read. `isRetryable()` is `false`: nothing needs
 * sending again — wait longer, or read the customer later.
 */
export class PbxProvisioningTimeoutError extends RingivoError {
  /** The last read — `provisioningState` still `pending` or `provisioning`. */
  readonly customer: Customer;

  constructor(message: string, customer: Customer) {
    super(message);
    this.customer = customer;
  }
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function record(
  source: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailFromJson(value: Record<string, unknown>): ApiErrorDetail {
  return Object.freeze({
    status: text(value, "status"),
    title: text(value, "title"),
    detail: text(value, "detail"),
    code: text(value, "code"),
    source: record(value, "source"),
    meta: record(value, "meta"),
    raw: value,
  });
}

function errorsFromBody(body: string, statusCode: number): readonly ApiErrorDetail[] {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return [];
  }

  if (!isRecord(document)) {
    return [];
  }

  const errors = document.errors;
  if (Array.isArray(errors)) {
    return errors.filter(isRecord).map(detailFromJson);
  }

  // RFC 6749's flat shape — what the mint refuses with, and the branch every
  // failed token request lands on.
  //
  // `error` becomes `code` and not only part of the message, because it is
  // the machine vocabulary a caller branches on: `invalid_client` is a wrong
  // credential, `unauthorized_client` is a credential nobody granted this
  // context, `invalid_request` is an ask the server cannot resolve,
  // `invalid_scope` is a scope name that does not exist, and
  // `unsupported_grant_type` is a `grant_type` missing or not served here.
  // `raw` keeps the whole document, so a member beyond the standard's two
  // still reaches the caller.
  const oauthError = document.error;
  if (typeof oauthError === "string") {
    const description = document.error_description;
    return [
      Object.freeze({
        status: String(statusCode),
        title: oauthError,
        detail: typeof description === "string" ? description : null,
        code: oauthError,
        source: null,
        meta: null,
        raw: document,
      }),
    ];
  }

  return [];
}

/**
 * The seconds a `Retry-After` asks for, or undefined if it did not say one.
 *
 * RFC 9110 section 10.2.3 gives the header two forms — `delay-seconds` and an
 * absolute `HTTP-date` — and the server picks, not the caller. Both are read,
 * and both come back as seconds.
 *
 * THE DIGITS ARE READ FIRST AND THE DATE BRANCH IS GUARDED, which is not
 * belt-and-braces: `Date.parse` is far looser than the grammar and turns
 * malformed values into real dates rather than NaN. `"60"` parses as 1960,
 * `"-5"` as 2001-05-01, `"1.5"` as 2001-01-05 — all in the past, so a naive
 * `Number(v) || Date.parse(v)` would answer **0** for a malformed header, and
 * `0` reads as "the server told me to retry immediately". It never did. So
 * `delay-seconds` must be digits and nothing else, and an HTTP-date must
 * begin with the weekday name that all three of the standard's formats do.
 */
export function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const trimmed = value.trim();

  if (/^[0-9]+$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (!/^[A-Za-z]/.test(trimmed)) {
    return undefined;
  }

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) {
    return undefined;
  }

  // Never negative. A date already past means "now", which is a wait a caller
  // can act on; a negative number is one they would have to guard themselves.
  return Math.max(0, Math.round((when - Date.now()) / 1000));
}

function message(statusCode: number, errors: readonly ApiErrorDetail[], body: string): string {
  const prefix = `HTTP ${statusCode}`;

  const first = errors[0];
  if (first) {
    const said = [first.title, first.detail].filter(Boolean).join(" ");
    const coded = first.code ? ` [${first.code}]` : "";
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
    return `${prefix}${coded}: ${said || "the API refused the request"}${more}`;
  }

  const excerpt = body.slice(0, 200).trim();
  return excerpt ? `${prefix}: ${excerpt}` : prefix;
}

/**
 * Throw the typed error this response deserves, or return.
 *
 * One place decides, so every call in the package fails the same way — and
 * so a 401 is an `AuthenticationError` whether it came from the token
 * endpoint or from a resource that refused a token twice.
 *
 * The body is read ONLY on the failure path. A successful response is handed
 * back untouched, so its stream is still there for the caller to parse.
 */
export async function throwForResponse(response: Response): Promise<void> {
  if (response.status < 400) {
    return;
  }

  const body = await response.text();
  const errors = errorsFromBody(body, response.status);
  const code = errors[0]?.code ?? null;
  const Failure =
    response.status === 401
      ? AuthenticationError
      : ((code !== null && Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : undefined) ??
        byStatus(response.status));

  throw new Failure(message(response.status, errors, body), {
    statusCode: response.status,
    errors,
    body,
    retryAfter: retryAfterSeconds(response.headers.get("retry-after")),
    headers: response.headers,
  });
}

/**
 * The class a status gets when no `code` earns a class of its own. The names
 * are the ones most TypeScript API clients use, so `catch (e) { if (e
 * instanceof NotFoundError) … }` reads the same here as there.
 */
function byStatus(status: number): typeof ApiError {
  switch (status) {
    case 400:
      return BadRequestError;
    case 401:
      return AuthenticationError;
    case 403:
      return PermissionDeniedError;
    case 404:
      return NotFoundError;
    case 409:
      return ConflictError;
    case 422:
      return UnprocessableEntityError;
    case 429:
      return RateLimitError;
    default:
      return status >= 500 ? InternalServerError : ApiError;
  }
}

/** The statuses below 500 the API's contract says to retry unchanged. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * The one 409 the API says to send again unchanged: the first request with
 * this `Idempotency-Key` still runs. Matched by code, because every other 409
 * (a suspended account, a fax that cannot be cancelled, missing audio)
 * answers the same however often it is sent.
 */
const KEY_IN_USE = "idempotency_key_in_use";

/**
 * Whether the API's contract says to try this call again, unchanged.
 *
 * `true` for NO ANSWER, for an `ApiError` whose status is 408, 429 or any
 * 5xx, and for a 409 whose code is `idempotency_key_in_use`. That 409 says the
 * first request with this `Idempotency-Key` still runs: send the same request
 * WITH THE SAME KEY after `retryAfter` to get its answer. A new key could do
 * the act a second time. `false` for every other `ApiError` (400, 401, 403,
 * 404, every other 409, 422): the same request gets the same answer until
 * something changes first — the request itself, or the account. A 401, 403 or 404 can be a setting that is
 * fixed later; for example `messages.record()` answers 404 while recording
 * texts is not turned on for the platform yet. Retry those only after the
 * change, or slowly. `false` for anything else, because this package did not
 * throw it for the API — a refusal before any request included.
 *
 * NO ANSWER is an `ApiConnectionError` (an `ApiTimeoutError` included): the
 * request got no response. The raw errors Node's `fetch` throws for the same
 * cases are read too, for a caller who sends with their own `fetch`: the
 * `TimeoutError` of a timeout, and the `TypeError` whose `cause` carries a
 * system or socket error `code` (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`,
 * `UND_ERR_SOCKET`, a TLS failure). A `TypeError` the call itself caused is
 * `false`: an unknown URL scheme, a forbidden port, an invalid URL or argument.
 * `RequestAbortedError` is `false`: you stopped it.
 *
 * This decides WHETHER to retry, never WHEN. Wait at least
 * `error.retryAfter` seconds when it is set; otherwise use your own backoff.
 *
 * The client already retried what it could before you see the error: by
 * default up to 2 more times (`maxRetries`), with backoff, and only a request
 * that is safe to send twice — see `RingivoOptions.maxRetries`. So an error
 * this answers `true` for has failed every attempt; send it again from your
 * own queue, later, rather than in a tight loop.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiConnectionError) {
    return true;
  }
  if (error instanceof RingivoError && !(error instanceof ApiError)) {
    return false;
  }
  if (error instanceof ApiError) {
    if (error.statusCode === 409) {
      return error.code === KEY_IN_USE;
    }
    return RETRYABLE_STATUSES.has(error.statusCode) || error.statusCode >= 500;
  }
  return isNoAnswer(error);
}

/** Whether a thrown `fetch` error means the request got no answer. Internal. */
export function isNoAnswer(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  // `AbortSignal.timeout()` rejects with a `DOMException` named
  // `TimeoutError`. Read by name: a `DOMException` is not an `Error` on every
  // runtime this package supports.
  if ((error as { name?: unknown }).name === "TimeoutError") {
    return true;
  }
  if (!(error instanceof TypeError)) {
    return false;
  }
  const cause: unknown = error.cause;
  const code =
    typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (typeof code !== "string" || code === "") {
    return false;
  }
  return !/^(ERR_INVALID|UND_ERR_INVALID_ARG|UND_ERR_NOT_SUPPORTED)/.test(code);
}
