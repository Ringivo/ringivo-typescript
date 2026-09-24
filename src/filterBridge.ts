/**
 * The v1 naming cleanup bridge: speak the new filter names, fall back once.
 *
 * The API renamed eight snake_case filter keys to camelCase with no alias
 * (`filter[fax_account]` became `filter[faxAccount]`, and so on). Each
 * spelling works against exactly one side of that deploy: an API that has not
 * taken the rename refuses `filter[faxAccount]` with a 400, and one that has
 * refuses `filter[fax_account]` the same way. This package cannot know which
 * API it is talking to, so for ONE release it asks with the new names and, on
 * the specific refusal an unknown filter key gets, asks once more with the old
 * ones. It remembers which spelling worked, per client, and flips back the
 * same way if the API changes under a long-running process.
 *
 * THIS MODULE IS TEMPORARY and internal (not exported from index.ts). It sits
 * on the typed transport's `fetch` seam in client.ts, so the wrapped
 * namespaces go through it and `client.request()` — the escape hatch — does
 * not. The next release deletes it and sends the new names only.
 */
import { ApiError } from "./errors.js";

/** New spelling -> the spelling the API took before the v1 naming cleanup. */
const RENAMED_FILTERS: Readonly<Record<string, string>> = Object.freeze({
  "filter[faxAccount]": "filter[fax_account]",
  "filter[clientReference]": "filter[client_reference]",
  "filter[createdAfter]": "filter[created_after]",
  "filter[createdBefore]": "filter[created_before]",
  "filter[scopeType]": "filter[scope_type]",
  "filter[scopeId]": "filter[scope_id]",
  "filter[eventType]": "filter[event_type]",
});

const OLD_TO_NEW: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(RENAMED_FILTERS).map(([next, old]) => [old, next])),
);

/** The query keys of this request that name a renamed filter, in either spelling. */
function renamedKeysIn(url: URL): string[] {
  return [...url.searchParams.keys()].filter((key) => key in RENAMED_FILTERS || key in OLD_TO_NEW);
}

/** The same URL with every renamed filter in the chosen spelling. */
function respelled(url: URL, legacy: boolean): URL {
  const map = legacy ? RENAMED_FILTERS : OLD_TO_NEW;
  const next = new URL(url);
  next.search = "";
  for (const [key, value] of url.searchParams) {
    next.searchParams.append(map[key] ?? key, value);
  }
  return next;
}

/**
 * Is this the 400 an API answers for a filter key it does not declare, naming
 * one of the renamed keys this request sent? Narrow on purpose: any other 400
 * — a bad cursor, a `page[size]` over the ceiling — reaches the caller as it is.
 */
function isUnknownFilterRefusal(error: unknown, sent: URL): boolean {
  if (!(error instanceof ApiError) || error.statusCode !== 400) {
    return false;
  }
  const names = renamedKeysIn(sent).map((key) => key.slice("filter[".length, -1));
  return error.errors.some(
    (detail) =>
      detail.source?.parameter === "filter" &&
      names.some((name) => (detail.detail ?? "").includes(name)),
  );
}

/**
 * Wrap a request function with the bridge. `state.legacy` is the spelling the
 * API took last; it starts at the new names.
 */
export function bridgeFilters(
  send: (outgoing: Request) => Promise<Response>,
  state: { legacy: boolean },
): (outgoing: Request) => Promise<Response> {
  return async (outgoing) => {
    const url = new URL(outgoing.url);
    if (outgoing.method !== "GET" || renamedKeysIn(url).length === 0) {
      return send(outgoing);
    }

    const first = respelled(url, state.legacy);
    try {
      return await send(new Request(first, outgoing));
    } catch (error) {
      if (!isUnknownFilterRefusal(error, first)) {
        throw error;
      }
    }

    const other = !state.legacy;
    const response = await send(new Request(respelled(url, other), outgoing));
    state.legacy = other;
    return response;
  };
}
