/**
 * Record a text your own system already sent, so staff see it in their threads.
 *
 *     const recorded = await client.messages.record({
 *       from: "+14075550142",
 *       to: "+13215550187",
 *       body: "Reminder: Rex is due for his rabies booster on Oct 24.",
 *       senderLabel: "Appointment reminder",
 *       providerMessageId: "01JC8ZA1F5T3R8C2P6M0L4JSWQ",
 *       providerPartIds: ["01JC8ZA1F5T3R8C2P6M0L4JSWQ"],
 *       sentAt: new Date("2026-10-19T15:02:44Z"),
 *     });
 *
 * `POST /v1/outbound-messages` with `alreadySent`. The platform sends nothing:
 * the text already left through your own messaging-provider account, and the
 * call files it in the conversation with your label in front of it.
 *
 * -- NO IDEMPOTENCY-KEY -----------------------------------------------------
 * The provider message id IS the key, by contract. A repeat with the same id
 * and the same `from`, `to`, `body` and media count answers 200 with the
 * first record and stores nothing new; `OutboundMessage.replayed` is then
 * `true`. A repeat with different content is a 409. So a retry is the same
 * call with the same arguments — and NEW presigned media links, because the
 * platform fetches the media during the call and never fetches a link again.
 *
 * -- MEDIA ------------------------------------------------------------------
 * `mediaUrls` links to MEDIA ITEMS of any type: an image, a contact card
 * (vCard), audio, video, a PDF or any other file. They go on the wire as
 * `mediaUrls`. Each is copied into the staff threads as you sent it. The
 * API's limits: at most 10 media items, at most 10 MB each and at most 20 MB
 * together. It refuses `text/plain` (put the text in `body`), a SMIL layout,
 * HTML, XML, SVG and script, by the declared type and by the file's own first
 * bytes. Only the count and the `https` scheme are checked here — the type
 * and the size are known only once the API fetches the link, so those
 * refusals come from the API. The answer describes the media in
 * `OutboundMessage.media` (content type and size), never with your links.
 *
 * If any link fails, nothing is stored. The `ApiError` names the link in
 * `errors[0].source.pointer` (`/data/attributes/mediaUrls/<index>`) and the
 * reason in `code`:
 *
 * - 422 `media_rejected`: the link or what it served can never be used. Fix
 *   the link; do not retry it unchanged.
 * - 504 `media_timeout`: the link did not finish within 10 seconds.
 * - 502 `media_unreachable`: its host answered 5xx, refused the connection,
 *   or does not resolve.
 * - 503 `media_store_unavailable`: the platform could not keep the media
 *   right now.
 *
 * The last three carry `Retry-After` and `isRetryable()` is `true` for them:
 * retry after `retryAfter` seconds, with NEW links for the first two.
 *
 * -- REFUSED BEFORE ANY REQUEST ---------------------------------------------
 * What the API would answer with a 422 that no retry can fix is thrown here
 * instead, before a request goes out: an empty provider message id or
 * part-id list, a `sentAt` that is not a valid `Date`, a text with neither a
 * body nor a media link, more than ten media links, a link that is not
 * `https`, and a label that breaks the label rule. A wrong TYPE — one string
 * where a list belongs — is a `TypeError`; every other refusal is an `Error`.
 * Neither is an `ApiError`, `isRetryable()` answers `false` for both, and
 * your queue should not see either as an API failure.
 *
 * -- THE LABEL RULE ---------------------------------------------------------
 * Staff see every recorded text as `"<label>: <body>"`. After trimming the
 * white space at both ends, a label is one line (no control character, no
 * line or paragraph separator), has at least one visible character (a
 * letter, digit, punctuation mark or symbol) and is 1 to 40 Unicode code
 * points long. `record()` REFUSES a label that breaks the rule; it never
 * changes your label silently. `senderLabel()` below is the helper that
 * MAKES any text — a person's name, say — into a label that keeps the rule.
 *
 * The API also limits the label, a colon, a space and the body together to
 * 1024 code points. That limit is not checked here, because the API counts
 * it after its own trim; a text over it is a 422.
 *
 * -- THE TIMEOUT ------------------------------------------------------------
 * The call fetches your media before it answers: all links at once, each
 * within 10 seconds, and then stores up to 20 MB. The API ends any request
 * at 30 seconds of its own time. A client that gives up first can abandon a
 * call that was about to succeed. Its retry is then answered 200 (the API
 * looks for a repeat before it fetches anything), but the wait was wasted.
 * This client's clock starts before the API's does — the request still has
 * to reach it — so this one call waits at least `RECORD_MIN_TIMEOUT_MS`
 * (35 000): the API's cut plus a margin, so that you always get the API's
 * own answer. That is whatever the client's own `timeoutMs` is; a longer
 * client timeout is kept.
 *
 * The floor bounds the WHOLE REQUEST — connect, send and wait — because
 * `fetch` has no separate read timeout. The Python client's floor bounds
 * only the wait for the answer (httpx's read timeout), which starts once the
 * request is sent. The 5-second margin covers that difference too.
 *
 * The Python client keeps the same rules in `ringivo/messages.py`; the two
 * are kept the same on purpose.
 */
import type { components } from "./_generated/schema.js";
import { JSONAPI_MEDIA_TYPE, type Ringivo } from "./client.js";
import {
  type OutboundMessage,
  type RawJson,
  isRecord,
  outboundMessageFromResource,
} from "./models.js";

type RecordRequest = components["schemas"]["OutboundMessageRecordRequest"];

/**
 * The longest label the API accepts, in Unicode code points — the spec's
 * `senderLabel.maxLength` (messages.test.ts reads it from the spec).
 */
export const MAX_SENDER_LABEL_CODE_POINTS = 40;

/** The most media links one record may carry — the spec's `mediaUrls.maxItems`. */
export const MAX_MEDIA = 10;

/** The longest provider message id or part id — the spec's `maxLength`. */
export const MAX_PROVIDER_ID_LENGTH = 128;

/**
 * The shortest timeout `record()` uses, in milliseconds: the API's own cut
 * plus a margin. The API fetches every media link at once, each within 10
 * seconds, stores the media, all before it answers, and ends any request at
 * 30 seconds. The floor adds 5 seconds to that cut, because this client's
 * clock starts before the API's.
 */
export const RECORD_MIN_TIMEOUT_MS = 35_000;

/** What `messages.record()` accepts. */
export interface RecordMessageOptions {
  /** Your number that sent it, in E.164, on your own messaging-provider account. */
  from: string;
  /** The one recipient, in E.164. */
  to: string;
  /**
   * What staff see in front of the text. It must keep the label rule (see
   * the top of this module); `senderLabel()` makes one from any text.
   */
  senderLabel: string;
  /** Your provider's id for the text — the dedupe key. A retry passes the same one. */
  providerMessageId: string;
  /** Every part id your provider returned. A one-part text names its own id. */
  providerPartIds: readonly string[];
  /** When your provider accepted the text. */
  sentAt: Date;
  /** The text as you sent it. Required unless `mediaUrls` names a media item. */
  body?: string | null;
  /**
   * Up to ten `https` links to the media you sent, in order — any type but
   * plain text, at most 10 MB each and 20 MB together. Make NEW presigned
   * links for each attempt: they are all fetched at once during this call,
   * each within 10 seconds, and never again.
   */
  mediaUrls?: readonly string[];
  /**
   * `true` marks the staff threads read — for a reply a person typed in your
   * own inbox. `false` (the default) leaves the read marks as they were.
   */
  markConversationRead?: boolean;
}

/** The `client.messages` namespace. Needs the `messages:record` scope. */
export class Messages {
  constructor(private readonly client: Ringivo) {}

  /**
   * Record one text you already sent.
   *
   * @returns The record. `replayed` is `true` when the answer was 200 — a
   *   repeat of an earlier record, returned unchanged.
   *
   * @throws TypeError or Error before any request, for what the API would
   *   refuse with a 422 that no retry can fix.
   * @throws {@link ApiError} when the API refused. Retry only what
   *   `isRetryable()` says is retryable, after `retryAfter` when it is set. A
   *   media link that failed is named by `code` and `source.pointer` (see the
   *   top of this module).
   *
   * Needs `messages:record`.
   */
  async record(options: RecordMessageOptions): Promise<OutboundMessage> {
    const document = recordDocument(options);

    const response = await this.client.request(
      new Request(`${this.client.baseUrl}/v1/outbound-messages`, {
        method: "POST",
        headers: { Accept: JSONAPI_MEDIA_TYPE, "Content-Type": JSONAPI_MEDIA_TYPE },
        body: JSON.stringify(document),
      }),
      { timeoutMs: Math.max(this.client.timeoutMs, RECORD_MIN_TIMEOUT_MS) },
    );

    return outboundMessageFromResource(dataObject(await response.json()), {
      replayed: response.status === 200,
    });
  }
}

/**
 * Make any text a label that keeps the label rule.
 *
 * Every control character and line break becomes a space, every run of white
 * space becomes one space, the ends are trimmed, and the result is cut to
 * `MAX_SENDER_LABEL_CODE_POINTS` code points (and trimmed again, so a cut
 * never ends on a space).
 *
 * @throws Error when nothing visible is left — the text was empty, white
 *   space, or invisible characters only. There is no label to make, so choose
 *   your own fallback.
 */
export function senderLabel(text: string): string {
  const words: string[] = [];
  let current = "";
  for (const character of text) {
    const spaced = breaksLine(character) ? " " : character;
    if (isSpace(spaced)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else {
      current += spaced;
    }
  }
  if (current) {
    words.push(current);
  }

  const cut = Array.from(words.join(" ")).slice(0, MAX_SENDER_LABEL_CODE_POINTS);
  const label = trimmed(cut);
  if (!label.some(isVisible)) {
    throw new Error("no visible character is left to make a sender label from");
  }
  return label.join("");
}

/**
 * The JSON:API request document, after every pre-request refusal.
 *
 * Typed against the generated `OutboundMessageRecordRequest`, so the compiler
 * checks every member name and type against the spec.
 */
function recordDocument(options: RecordMessageOptions): RecordRequest {
  const providerMessageId = options.providerMessageId;
  if (typeof providerMessageId !== "string" || providerMessageId === "") {
    throw new Error("providerMessageId is required: it is the key a retry is matched on");
  }
  if (codePointLength(providerMessageId) > MAX_PROVIDER_ID_LENGTH) {
    throw new Error(
      `providerMessageId must be at most ${MAX_PROVIDER_ID_LENGTH} characters; ` +
        `it is ${codePointLength(providerMessageId)}`,
    );
  }

  const partIds: unknown = options.providerPartIds;
  if (typeof partIds === "string") {
    throw new TypeError(
      "providerPartIds must be a list of part ids, not one string; a one-part text " +
        "names its own id: [providerMessageId]",
    );
  }
  if (!Array.isArray(partIds)) {
    throw new TypeError("providerPartIds must be a list of part ids");
  }
  if (
    partIds.length === 0 ||
    !partIds.every((part): part is string => typeof part === "string" && part !== "")
  ) {
    throw new Error(
      "providerPartIds must name every part id your provider returned, at least one; " +
        "a one-part text names its own id",
    );
  }
  if (partIds.some((part) => codePointLength(part) > MAX_PROVIDER_ID_LENGTH)) {
    throw new Error(`every provider part id must be at most ${MAX_PROVIDER_ID_LENGTH} characters`);
  }
  if (new Set(partIds).size !== partIds.length) {
    throw new Error("providerPartIds must not repeat a part id");
  }

  const sentAt: unknown = options.sentAt;
  if (!(sentAt instanceof Date)) {
    throw new TypeError(
      "sentAt must be a Date: the instant your provider accepted the text, e.g. " +
        'new Date("2026-10-19T15:02:44Z")',
    );
  }
  if (Number.isNaN(sentAt.getTime())) {
    throw new Error("sentAt is an Invalid Date: it names no instant");
  }

  const mediaUrls: unknown = options.mediaUrls ?? [];
  if (typeof mediaUrls === "string") {
    throw new TypeError("mediaUrls must be a list of links, not one string");
  }
  if (!Array.isArray(mediaUrls)) {
    throw new TypeError("mediaUrls must be a list of links");
  }
  if (mediaUrls.length > MAX_MEDIA) {
    throw new Error(`a record carries at most ${MAX_MEDIA} media links; got ${mediaUrls.length}`);
  }
  const links = mediaUrls.map((link: unknown, index) => {
    if (typeof link !== "string" || !isHttpsLink(link)) {
      throw new Error(`mediaUrls[${index}] must be an https link`);
    }
    return link;
  });

  const body = options.body ?? null;
  if (!body && links.length === 0) {
    throw new Error("a recorded text needs a body or at least one media link");
  }

  const refusal = labelRefusal(options.senderLabel);
  if (refusal !== null) {
    throw new Error(refusal);
  }

  return {
    data: {
      type: "outbound-messages",
      attributes: {
        from: options.from,
        to: options.to,
        body,
        mediaUrls: links,
        senderLabel: options.senderLabel,
        markConversationRead: options.markConversationRead ?? false,
        alreadySent: {
          providerMessageId,
          providerPartIds: [...partIds],
          sentAt: utcInstant(sentAt),
        },
      },
    },
  };
}

/** A `Date` as the UTC ISO-8601 instant the API reads, without `.000` when it has no milliseconds. */
function utcInstant(value: Date): string {
  return value.toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Is this an `https` link with a host, as Python's `urlsplit()` reads one?
 *
 * The scheme and `//` are checked on the STRING, not on a parsed `URL`. The
 * WHATWG parser is lenient where the API is not: it reads `https:example.com`
 * and `https:\\example.com` as `https://example.com/`, but the string sent is
 * the caller's, and the API refuses it with a 422. Python's
 * `urlsplit(link).netloc` is empty for both, so both are refused before the
 * request — here as there. The parse then refuses what is not a URL at all.
 */
function isHttpsLink(value: string): boolean {
  if (!/^https:\/\/[^/?#]/i.test(value)) {
    return false;
  }
  try {
    return new URL(value).hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Why this label breaks the rule, or null when it keeps it.
 *
 * The checks are the API's, in the API's order, on the trimmed label.
 */
function labelRefusal(label: unknown): string | null {
  if (typeof label !== "string") {
    return "the sender label must be a string: give the label staff see in front of the text";
  }
  const points = trimmed(Array.from(label));
  if (points.length === 0) {
    return "the sender label is empty: give the label staff see in front of the text";
  }
  if (points.some(breaksLine)) {
    return "the sender label must be one line, with no newline or other control character";
  }
  if (!points.some(isVisible)) {
    return (
      "the sender label must have at least one visible character: a letter, a digit, " +
      "a punctuation mark or a symbol"
    );
  }
  if (points.length > MAX_SENDER_LABEL_CODE_POINTS) {
    return (
      `the sender label must be at most ${MAX_SENDER_LABEL_CODE_POINTS} characters ` +
      `(Unicode code points); it is ${points.length}`
    );
  }
  return null;
}

/**
 * What the API trims as white space besides the `Z` categories: what its `\s`
 * matches — space, tab, LF, VT, FF, CR, and U+0085 (NEL; the API's PCRE trims
 * it at either end, so "\x85Rex" is accepted as "Rex"). NOT U+001C–U+001F,
 * which the API's regex reads as control characters. NOT JavaScript's own
 * `\s` either: it also matches U+FEFF, a format character the API keeps.
 */
const ASCII_SPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\v", "\f", "\r", "\u0085"]);

/** The two separators that end a line without being `Cc` characters. */
const LINE_BREAKS: ReadonlySet<string> = new Set([" ", " "]);

const SEPARATOR = /^\p{Z}$/u;
const CONTROL = /^\p{Cc}$/u;
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

/**
 * White space as the API trims it (`[\s\p{Z}]`): ASCII white space, U+0085,
 * and the Unicode separators (`Zs`, `Zl`, `Zp`).
 */
function isSpace(character: string): boolean {
  return ASCII_SPACE.has(character) || SEPARATOR.test(character);
}

function breaksLine(character: string): boolean {
  return CONTROL.test(character) || LINE_BREAKS.has(character);
}

/** A letter, digit, punctuation mark or symbol (`L`, `N`, `P`, `S`). */
function isVisible(character: string): boolean {
  return VISIBLE.test(character);
}

/** The code points with the API's white space removed from both ends. */
function trimmed(points: readonly string[]): string[] {
  let start = 0;
  let end = points.length;
  while (start < end && isSpace(points[start] ?? "")) {
    start += 1;
  }
  while (end > start && isSpace(points[end - 1] ?? "")) {
    end -= 1;
  }
  return points.slice(start, end);
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}
