/**
 * The OAuth 2.0 client-credentials grant, held so a caller never sees it.
 *
 * A caller hands over a client id and secret once, at construction.
 * Everything after that — minting the token, caching it, replacing it before
 * it expires, and replacing it again when the server says it is no longer
 * good — happens here, on the way out of every request.
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
 * dying token. The 401 retry stays anyway — a token can also be revoked, or
 * a server restarted, long before its clock runs out.
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
 * second caller awaits the first caller's request instead of making its own.
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
  scopes?: readonly string[];
  timeoutMs: number;
}

/** Mints bearer tokens, and keeps the one it holds good. */
export class ClientCredentialsAuth {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scopes: readonly string[] | undefined;
  private readonly timeoutMs: number;

  private accessTokenValue: string | null = null;
  private expiresAt: number | null = null;
  private pending: Promise<string> | null = null;

  constructor(options: ClientCredentialsAuthOptions) {
    this.tokenUrl = `${options.baseUrl.replace(/\/+$/, "")}/oauth/token`;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes;
    this.timeoutMs = options.timeoutMs;
  }

  /** The token to send, minting or replacing it if that is what it takes. */
  async accessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!options.forceRefresh) {
      if (this.accessTokenValue !== null && this.isFresh()) {
        return this.accessTokenValue;
      }
      if (this.pending) {
        return this.pending;
      }
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
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    if (this.scopes && this.scopes.length > 0) {
      form.set("scope", this.scopes.join(" "));
    }

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: form.toString(),
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
