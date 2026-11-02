/**
 * The one way this client follows a signed download link: a fax's document
 * (`faxes.media()`) and a received MMS's media item
 * (`inboundMessages.downloadMedia()`) both come through here.
 */
import { USER_AGENT } from "./auth.js";
import { type RequestOptions, type Ringivo, fetchOf } from "./client.js";
import { send } from "./transport.js";

/**
 * Follow a pre-signed URL and return the bytes behind it.
 *
 * Deliberately NOT through `client.request()`: that path carries our bearer
 * token, and this URL — though it lives on the tenant's own API host, behind
 * a branded media proxy — is already authorized by its own signature.
 * Sending the bearer token with it would hand out a credential that reads
 * every fax and every message this client can reach, for no reason: the
 * signature already grants the read.
 *
 * It drops the token and nothing else — the User-Agent stays, because the
 * download is still this SDK asking and an operator reading the media
 * proxy's access log should see which client fetched the file.
 *
 * A refusal is an `ApiError` like any other answer: a 403 for a link whose
 * signature does not verify or has expired, a 404 for a file that is not
 * there, a 429 with its `retryAfter`.
 */
export async function downloadUnauthenticated(
  client: Ringivo,
  url: string,
  options: RequestOptions = {},
): Promise<Uint8Array> {
  // The client's own fetch, timeout and retries, and NO `authorize`: the loop
  // sets an Authorization header only when it is handed a token source.
  const headers = new Headers(options.headers);
  headers.set("User-Agent", USER_AGENT);
  const response = await send(new Request(url, { redirect: "follow" }), {
    fetch: fetchOf(client),
    timeoutMs: options.timeoutMs ?? client.timeoutMs,
    maxRetries: options.maxRetries ?? client.maxRetries,
    signal: options.signal,
    headers,
  });
  return new Uint8Array(await response.arrayBuffer());
}
