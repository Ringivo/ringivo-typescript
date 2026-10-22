/**
 * One id as one path segment, or a refusal before any request is built.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so a
 * `/` in an id is already `%2F` and cannot add a segment. Three values get
 * past that escaping and still steer the request, and this refuses them:
 *
 * - `""` collapses `/v1/faxes/{fax}` into `/v1/faxes/`, the collection, which
 *   answers 200 with a page a caller would read as the one row they asked for.
 * - `"."` and `".."` are DOT SEGMENTS. `encodeURIComponent` leaves them alone,
 *   and URL parsing resolves them before the request is sent:
 *   `/v1/inbound-messages/.` becomes the collection, and
 *   `/v1/inbound-messages/..` becomes `/v1/` — a different endpoint, read with
 *   this client's token.
 *
 * Every namespace's id guard goes through here, so the rule is the same on
 * every resource. pathSegment.test.ts asserts it through each public method
 * that takes an id.
 */
export function pathSegment(value: string, refusal: string): string {
  if (!value) {
    throw new Error(refusal);
  }
  if (value === "." || value === "..") {
    throw new Error(
      `${refusal}; got "${value}", a dot segment the URL would resolve to a different path`,
    );
  }
  return value;
}
