/**
 * What this client throws, and what each error carries.
 *
 * Every failure a caller can act on is a typed error with the machine-
 * readable part of the answer attached — the HTTP status and the API's own
 * error objects — so branching on a failure never means parsing a message
 * string. The message exists for a log line and a stack trace, not for code.
 *
 * -- TWO ANSWER SHAPES, AND WHERE THE LINE BETWEEN THEM RUNS ----------------
 * The line runs between the MINT and the RESOURCES, and nowhere else:
 *
 *  - `POST /oauth/token` answers RFC 6749's flat
 *    `{"error": ..., "error_description": ...}` as `application/json`. It is
 *    a standard OAuth endpoint and speaks the standard's own vocabulary —
 *    `invalid_client`, `unauthorized_client`, `invalid_request`,
 *    `invalid_scope`. A member beyond those two is tolerated and kept: some
 *    servers add a `hint`, and whatever arrives reaches the caller on `raw`.
 *  - Everything under `/v1` answers a JSON:API error document
 *    (`{"errors": [...]}`), including the four endpoints whose SUCCESS bodies
 *    are plain JSON.
 *
 * Both fold into `ApiError` here, so a caller has one thing to catch and one
 * member to branch on wherever the refusal came from: `code` carries the
 * JSON:API error's `code` on one side and the OAuth `error` on the other.
 */

/**
 * Base class for everything this package throws deliberately.
 *
 * Catch this to catch the SDK. Transport-level failures — a connection
 * refused, a TLS error, an abort on timeout — are the platform's own
 * `TypeError`/`DOMException` and are deliberately not wrapped: re-labelling
 * them would hide which layer failed while adding nothing a caller can
 * branch on.
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

  constructor(
    message: string,
    options: { statusCode: number; errors?: readonly ApiErrorDetail[]; body?: string },
  ) {
    super(message);
    this.statusCode = options.statusCode;
    this.errors = options.errors ?? [];
    this.body = options.body ?? "";
  }

  /** The first error's machine code, when the answer carried one. */
  get code(): string | null {
    return this.errors[0]?.code ?? null;
  }
}

/**
 * The credential was refused, or the token it bought no longer works.
 *
 * Thrown both for a token request the server rejected and for a request that
 * answered 401 twice — once on its own, and once more after the token was
 * force-refreshed and the request retried. A second 401 means the
 * credential, not the token, is the problem.
 */
export class AuthenticationError extends ApiError {}

/**
 * A webhook body did not prove it came from your provider, recently.
 *
 * One class for every failure — a missing header, a malformed one, a stale
 * timestamp, a wrong secret — because a receiver has exactly one useful
 * reaction to all of them. See verifyWebhook's note on what the MESSAGES
 * say, and on not echoing them back to the sender.
 */
export class SignatureVerificationError extends RingivoError {}

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
  // context, `invalid_request` is an ask the server cannot resolve, and
  // `invalid_scope` is a scope name that does not exist. `raw` keeps the
  // whole document, so a member beyond these two still reaches the caller.
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
  const Failure = response.status === 401 ? AuthenticationError : ApiError;

  throw new Failure(message(response.status, errors, body), {
    statusCode: response.status,
    errors,
    body,
  });
}
