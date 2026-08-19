/**
 * The client a caller constructs, and the one connection everything shares.
 *
 * `Ringivo` owns three things: the base URL (there is no default — see
 * below), one authenticated request path, and the resource namespaces hung
 * off it (`client.faxes`).
 *
 * -- NO HOSTNAME IS COMPILED IN ---------------------------------------------
 * `baseUrl` is required and has no default. This package is grey-label: the
 * same tarball is installed by integrators of different providers, and a
 * default host would name one of them in every stack trace, every log line
 * and every editor tooltip. tests/grey-label.test.ts asserts the absence
 * from the other side, by reading the BUILT `dist/`.
 *
 * -- ONE REQUEST PATH, ONE AUTH FLOW ----------------------------------------
 * Every request goes through `request()` below, so token caching, the expiry
 * margin, the single 401 retry, the User-Agent and the typed errors apply
 * once and apply everywhere. `openapi-fetch` is handed that method as its
 * `fetch`, which is what puts the spec-typed calls in src/faxes.ts on the
 * same path as the hand-written multipart send — and what makes `request()`
 * a supported escape hatch rather than a way around the client.
 *
 * Pre-signed media downloads are the deliberate exception: they go out
 * UNAUTHENTICATED (see `downloadUnauthenticated` in faxes.ts). The download
 * URL sits on the tenant's own API host, behind a branded media proxy, but
 * it must still never receive our bearer token: the signature in the URL is
 * what authorizes the read, and handing over a credential good for the
 * whole account would extend it to a link that could end up anywhere.
 *
 * -- WHY THE TYPED TRANSPORT IS HELD IN A WeakMap ---------------------------
 * `openapi-fetch`'s client is typed by `paths`, and `paths` is the
 * whole generated spec — every endpoint, every schema, every description.
 * Held as a public member it would be dragged into `dist/index.d.ts` and
 * PUBLISHED: about 140 KB of types a caller never asked for, whose names and
 * nullability change with a tool upgrade. Nothing generated crosses the
 * public boundary, and this is how that rule is kept rather than merely
 * stated — the map is module-private, so the type stops at this file.
 */
import { type PathBasedClient, createPathBasedClient } from "openapi-fetch";

import type { paths } from "./_generated/schema.js";
import { ClientCredentialsAuth, USER_AGENT } from "./auth.js";
import { throwForResponse } from "./errors.js";
import { Faxes } from "./faxes.js";
import { VERSION } from "./version.js";

/** What the JSON:API resource endpoints send and accept. */
export const JSONAPI_MEDIA_TYPE = "application/vnd.api+json";

/**
 * What the four non-JSON:API endpoints send and accept — `POST /v1/faxes`,
 * the two media links, and `POST /v1/faxes/{fax}/cancel`.
 */
export const JSON_MEDIA_TYPE = "application/json";

const DEFAULT_TIMEOUT_MS = 30_000;

const transports = new WeakMap<Ringivo, PathBasedClient<paths>>();

/** How `Ringivo` is constructed. */
export interface RingivoOptions {
  /**
   * The API root you were given, without a trailing slash —
   * `https://api.yourprovider.example`. Required: this package names no host
   * of its own.
   */
  baseUrl: string;
  /** The client id issued with your credential. */
  clientId: string;
  /** Its secret. */
  clientSecret: string;
  /**
   * The tenant this client acts for — the id your provider named in the
   * grant behind your credential. **Set it:** almost every integrator has to
   * today. Omit it only where your provider can resolve the grant without
   * one.
   *
   * It is named once, here, because the token CARRIES it: which rows you
   * reach is decided by the token, so acting for another tenant means
   * another client. The token itself is short-lived and this client re-mints
   * it for you — you never handle one.
   */
  tenant?: string;
  /**
   * One customer inside that tenant, when your grant names one. It SELECTS a
   * context your provider already granted and narrows nothing by itself:
   * naming a customer your credential was not granted is refused, and
   * omitting it asks for the tenant-wide token your grant allows.
   */
  customer?: string;
  /**
   * The scopes to ask for. **At least one, or the constructor refuses to
   * build the client:** what you get is the intersection with your grant, so
   * an empty ask mints a token that carries nothing and is refused by every
   * endpoint you spend it on. There is no default to fall back to.
   *
   * Anything outside your grant — including a scope name that does not exist
   * — is dropped silently rather than refused, so read the scopes back off
   * your provider's answer rather than assuming the request was honoured in
   * full.
   */
  scopes?: readonly string[];
  /**
   * Milliseconds any single request may take, token requests and media
   * downloads included. Thirty seconds by default.
   */
  timeoutMs?: number;
}

/** A connection to one provider's API, authenticated for its lifetime. */
export class Ringivo {
  /** The API root every request is built against, with no trailing slash. */
  readonly baseUrl: string;

  /** Milliseconds any single request may take. */
  readonly timeoutMs: number;

  /** Send a fax, read one, list them, cancel one, fetch its pages. */
  readonly faxes: Faxes;

  private readonly auth: ClientCredentialsAuth;

  constructor(options: RingivoOptions) {
    if (!options.baseUrl) {
      throw new Error("baseUrl is required");
    }
    if (!options.clientId || !options.clientSecret) {
      throw new Error("clientId and clientSecret are required");
    }
    // REFUSED HERE, LOUDLY, RATHER THAN IN PRODUCTION. Asking for no scopes
    // is not "the default scopes": the server intersects what you ask for
    // with what your grant allows, so an empty ask mints a token that holds
    // nothing and is refused by every endpoint it is spent on — a 403 whose
    // cause is nowhere near where it is read. There is no default to invent
    // on the caller's behalf, so the only honest moment to say so is now.
    if (!options.scopes || options.scopes.length === 0) {
      throw new TypeError(
        "scopes is required: name the scopes your credential was granted, e.g. " +
          'scopes: ["fax:read", "fax:write"]. A token minted with none carries none, and ' +
          "every endpoint refuses it.",
      );
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.auth = new ClientCredentialsAuth({
      baseUrl: this.baseUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      tenant: options.tenant,
      customer: options.customer,
      scopes: options.scopes,
      timeoutMs: this.timeoutMs,
    });

    transports.set(
      this,
      createPathBasedClient<paths>({
        baseUrl: this.baseUrl,
        headers: { Accept: JSONAPI_MEDIA_TYPE },
        // The whole point of the seam. `openapi-fetch` builds and types the
        // request; this method is what actually sends it, so the typed calls
        // and the hand-written multipart send share one auth flow and one
        // error path.
        fetch: (outgoing: Request) => this.request(outgoing),
      }),
    );

    this.faxes = new Faxes(this);
  }

  toString(): string {
    return `Ringivo { baseUrl: ${this.baseUrl}, version: ${VERSION} }`;
  }

  /**
   * Send one request, authenticated, and hand back the response — or throw.
   *
   * Anything at or above 400 becomes a typed error here, so no caller has to
   * check a status code — including the 401 that has already been retried
   * once just below.
   *
   * This is also the ESCAPE HATCH, and it is public for that reason: this
   * client wraps the fax surface, and an endpoint it does not wrap yet is
   * still reachable with your credential, your timeout, your User-Agent and
   * the same typed errors:
   *
   *     const response = await client.request(
   *       new Request(`${client.baseUrl}/v1/webhook-endpoints`, {
   *         headers: { Accept: "application/vnd.api+json" },
   *       }),
   *     );
   *
   * What you get back is a plain `Response`, not one of this package's
   * frozen objects — you are past the boundary and the shape is the API's.
   */
  async request(outgoing: Request): Promise<Response> {
    // Cloned BEFORE anything reads the body: a `Request` may be sent once,
    // and the retry below needs a second copy of the same bytes. Cloning
    // after the first send is too late.
    const spare = outgoing.clone();

    let response = await this.attempt(outgoing, await this.auth.accessToken());

    if (response.status === 401) {
      // ONCE. A second 401 is answered by the caller's error, not by another
      // mint: a credential that has lost its reach would otherwise spin, and
      // every attempt costs the server a token.
      response = await this.attempt(spare, await this.auth.accessToken({ forceRefresh: true }));
    }

    await throwForResponse(response);
    return response;
  }

  private attempt(outgoing: Request, token: string): Promise<Response> {
    const headers = new Headers(outgoing.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", USER_AGENT);

    return fetch(
      new Request(outgoing, { headers, signal: AbortSignal.timeout(this.timeoutMs) }),
    );
  }
}

/**
 * The spec-typed transport for one client.
 *
 * Internal to this package and deliberately not re-exported from index.ts:
 * see the WeakMap note at the top of this file.
 */
export function transportOf(client: Ringivo): PathBasedClient<paths> {
  const transport = transports.get(client);
  if (!transport) {
    throw new Error("this Ringivo client was never constructed");
  }
  return transport;
}
