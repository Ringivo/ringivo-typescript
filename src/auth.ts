/**
 * The integration token, minted and kept good so a caller never sees it.
 *
 * A caller hands over a client id, a secret and the context those act for
 * once, at construction. Everything after that — minting the token, caching
 * it, replacing it before it expires, and replacing it again when the server
 * says it is no longer good — happens here, on the way out of every request.
 *
 * -- WHY THE CONTEXT IS NAMED AT THE MINT AND NOWHERE ELSE ------------------
 * `POST /v1/integration/token` issues a token that CARRIES its tenant and,
 * when one is named, a customer inside it. Which rows a request reaches is
 * decided by the token, never by a header or a path sent later — so acting
 * for another tenant means another client, and one token is one context for
 * its whole life. A member the caller did not configure is left out of the
 * body altogether: `tenant` absent asks the server to decide from the single
 * grant it holds, which is not the same request as `tenant` sent empty.
 *
 * -- WHY THIS IS A SEPARATE OBJECT AND NOT A WRAPPER METHOD -----------------
 * The token cache, the expiry margin and the single 401 retry belong to the
 * CONNECTION, not to any one call. This object holds them once, and
 * `Ringivo`'s own `fetch` (client.ts) is the single place that reads them —
 * so every request through the client is covered, including any a caller
 * makes through the typed `openapi-fetch` surface, which knows nothing about
 * tokens.
 *
 * -- WHY THE EXPIRY MARGIN --------------------------------------------------
 * The cached token is replaced `expires_in - 60` seconds after it was
 * minted, not `expires_in`. Without the margin a token that expires
 * mid-flight is discovered by the SERVER, which costs a refused request and
 * a retry; with it the replacement happens before a request ever carries the
 * dying token. The life is whatever the answer said — a short one is the
 * point of this endpoint, and no number is compiled in here. The 401 retry
 * stays anyway: a grant can be withdrawn, or a secret rotated, long before
 * the clock runs out.
 *
 * -- WHY A MONOTONIC CLOCK --------------------------------------------------
 * Expiry is measured with `performance.now()`, which cannot be moved by an
 * NTP correction or a daylight-saving jump. `Date.now()` arithmetic would
 * treat a one-hour clock step as an hour of elapsed token life.
 *
 * -- WHY A SHARED PROMISE AND NOT A LOCK ------------------------------------
 * JavaScript has no lock and needs none, but it does have concurrency: two
 * calls awaiting a token at the same moment would both find the cache empty
 * and both mint, which costs the server two tokens and races over which one
 * is cached. The in-flight mint is held in `pending` and shared, so the
 * second caller awaits the first caller's request instead of making its own
 * — and that holds for a FORCED refresh too: two callers that both meet a
 * 401 on the same stale token join the same in-flight mint rather than each
 * buying a fresh token for a refresh already under way.
 */
import { AuthenticationError, throwForResponse } from "./errors.js";
import { VERSION } from "./version.js";

/**
 * What every request says it is, token mints included.
 *
 * Node sets a `User-Agent` header when asked; a browser silently ignores the
 * attempt and sends its own, which is a browser rule rather than a bug here.
 * This SDK targets Node 20 and newer first.
 */
export const USER_AGENT = `Ringivo/TS ${VERSION}`;

/** How long before a token's stated expiry it is treated as spent. */
export const EXPIRY_MARGIN_SECONDS = 60;

/** Seconds since some fixed point in this process, unaffected by clock steps. */
function monotonic(): number {
  return performance.now() / 1000;
}

export interface ClientCredentialsAuthOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  tenant?: string;
  customer?: string;
  scopes?: readonly string[];
  timeoutMs: number;
}

/** Mints bearer tokens, and keeps the one it holds good. */
export class ClientCredentialsAuth {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenant: string | undefined;
  private readonly customer: string | undefined;
  private readonly scopes: readonly string[] | undefined;
  private readonly timeoutMs: number;

  private accessTokenValue: string | null = null;
  private expiresAt: number | null = null;
  private pending: Promise<string> | null = null;

  constructor(options: ClientCredentialsAuthOptions) {
    this.tokenUrl = `${options.baseUrl.replace(/\/+$/, "")}/v1/integration/token`;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tenant = options.tenant;
    this.customer = options.customer;
    this.scopes = options.scopes;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * The token to send, minting or replacing it if that is what it takes.
   *
   * The pending-mint check runs for a forced refresh too, not only the
   * cache-miss path above it: two callers that both meet a 401 on the same
   * stale token can both land here before either mint finishes, and a mint
   * already in flight always answers with a token newer than anything
   * either caller is holding. Skipping this check for `forceRefresh` was
   * the bug — it bought a second token for a refresh already under way.
   */
  async accessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!options.forceRefresh && this.accessTokenValue !== null && this.isFresh()) {
      return this.accessTokenValue;
    }
    if (this.pending) {
      return this.pending;
    }

    const pending = this.mint().finally(() => {
      if (this.pending === pending) {
        this.pending = null;
      }
    });
    this.pending = pending;
    return pending;
  }

  private isFresh(): boolean {
    if (this.expiresAt === null) {
      // The server did not say when it expires, so there is nothing to
      // pre-empt. The 401 retry is what replaces this one.
      return true;
    }
    return monotonic() < this.expiresAt;
  }

  private async mint(): Promise<string> {
    // Only what the caller actually configured. A member sent as `null` or
    // as an empty string is a value the server has to interpret; a member
    // left out is the absence the endpoint documents.
    const asked: Record<string, unknown> = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
    };
    if (this.tenant !== undefined) {
      asked.tenant = this.tenant;
    }
    if (this.customer !== undefined) {
      asked.customer = this.customer;
    }
    if (this.scopes && this.scopes.length > 0) {
      asked.scopes = [...this.scopes];
    }

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(asked),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await throwForResponse(response);

    const body = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }

    const token =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).access_token
        : null;

    if (typeof token !== "string" || token === "") {
      throw new AuthenticationError(
        "HTTP 200 [invalid_token_response]: the token endpoint answered success with no " +
          "access_token",
        { statusCode: response.status, body },
      );
    }

    const expiresIn = (payload as Record<string, unknown>).expires_in;
    this.accessTokenValue = token;
    this.expiresAt =
      typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? monotonic() + Math.max(Math.trunc(expiresIn) - EXPIRY_MARGIN_SECONDS, 0)
        : null;

    return token;
  }
}
