/**
 * Send a fax, read one, list them, cancel one, fetch its pages.
 *
 * -- WHAT IS TYPED BY THE SPEC, AND WHAT IS HAND-WRITTEN --------------------
 * `get`, `list`, `cancel` and `mediaLink` go through the `openapi-fetch`
 * client in client.ts, so `src/_generated/schema.d.ts` type-checks their
 * paths, their query members and their response bodies at compile time. That
 * is the whole benefit taken from the generated half — nothing generated is
 * on the wire and nothing generated crosses the public boundary, because the
 * values handed back are the frozen objects in models.ts.
 *
 * `send` is hand-written, and for one concrete reason: its request is a
 * multipart body whose part headers matter, and no request builder in reach
 * can express the shape the spec asks for. See THE TWO SEND BODIES below.
 *
 * -- THE TWO SEND BODIES ----------------------------------------------------
 * `POST /v1/faxes` takes EITHER `multipart/form-data` with `documents[]`
 * file parts OR flat JSON whose `documents` is a list of https URLs, and
 * never both in one request. `send()` takes `file` for the first and `urls`
 * for the second, and refuses to guess if it is given both or neither.
 *
 * -- WHY THE MULTIPART BODY IS BUILT BYTE BY BYTE ---------------------------
 * `FormData` cannot express this body. The spec gives `tags` and
 * `cover_page` the encoding `contentType: application/json`, which means a
 * form FIELD carrying a content type and NO filename. Appending a `Blob` to
 * a `FormData` is the only way to attach a content type to a part, and the
 * platform spells that part `Content-Disposition: form-data; name="tags";
 * filename="blob"` — the WHATWG rule is that a non-File Blob becomes a File
 * named `blob`. A part with a filename is an uploaded file to every server
 * multipart parser there is, so those two members would arrive as files
 * rather than as fields and the tags would be silently lost.
 *
 * Building the body here costs about thirty lines and pins the wire format
 * in faxes.test.ts, where a regression is visible as a diff rather than as a
 * fax that arrives without its tags.
 */
import type { paths } from "./_generated/schema.js";
import { USER_AGENT } from "./auth.js";
import { JSON_MEDIA_TYPE, type Ringivo, transportOf } from "./client.js";
import { throwForResponse } from "./errors.js";
import {
  type Fax,
  type FaxPage,
  type MediaLink,
  type RawJson,
  faxFromAcknowledgement,
  faxFromResource,
  faxPageFromDocument,
  isRecord,
  mediaLinkFromJson,
} from "./models.js";

/**
 * The query the spec publishes for `GET /v1/faxes`.
 *
 * Used to cast the two members whose spec type is an ENUM while this
 * client's own option is a `string` — `direction` and `status`. That is
 * deliberate and it matches `Fax.status`: a status the server adds tomorrow
 * must be filterable today, without waiting for a regenerate and a release.
 * The cast is written at exactly those two members, so the rest of the query
 * is still checked against the spec.
 *
 * Local and unexported: nothing generated crosses the public boundary.
 */
type ListFaxesQuery = NonNullable<paths["/v1/faxes"]["get"]["parameters"]["query"]>;

/** The ceiling counts uploads PLUS urls — it is the same five on both bodies. */
const MAX_DOCUMENTS = 5;

/** Which rendering of a fax's document to fetch. */
export type MediaFormat = "pdf" | "tiff";

/**
 * One page to upload.
 *
 * A `Blob` or a `File` from a browser or from `openAsBlob()`; a `Uint8Array`
 * or a Node `Buffer` from `readFile()`; or a bare `ArrayBuffer`. A `File`
 * carries its own name and the request uses it — everything else is named
 * `document-<n>`, because a server that shows a person the document's name
 * has to be given one.
 */
export type FaxUpload = Blob | Uint8Array | ArrayBuffer;

/** What `faxes.send()` accepts. */
export interface SendFaxOptions {
  /** The account to send from. */
  faxAccount: string;
  /**
   * The destination in E.164 — this string is dialled, so nothing looser
   * will do.
   */
  to: string;
  /**
   * The pages to upload: one document, or up to five. Give this or `urls`.
   */
  file?: FaxUpload | readonly FaxUpload[];
  /** Up to five `https` URLs to fetch the pages from instead. */
  urls?: readonly string[];
  /**
   * The caller ID. Omit it to use the account's default; a number the
   * account does not hold is refused.
   */
  from?: string;
  /** `fine` or `standard`. */
  resolution?: string;
  /** Your own reference, echoed back on the fax. */
  clientReference?: string;
  /** Your own flat labels. Replaced wholesale on a write. */
  tags?: Readonly<Record<string, string>>;
  /** `to_name`, `from_name`, `subject`, `message`. */
  coverPage?: Readonly<Record<string, string>>;
  /**
   * Your key for this send. **A fresh UUID is generated when you do not pass
   * one**, which makes a single call safe; pass your own — and reuse it — if
   * you intend to retry a send whose response you never saw. Reusing a key
   * replays the first fax instead of sending a second.
   */
  idempotencyKey?: string;
}

/** What `faxes.list()` accepts. Every member narrows the collection. */
export interface ListFaxesOptions {
  faxAccount?: string;
  direction?: string;
  status?: string;
  from?: string;
  to?: string;
  clientReference?: string;
  createdAfter?: string;
  createdBefore?: string;
  read?: boolean;
  archived?: boolean;
  /** Match on your own tags, one member per tag name. Two of them mean BOTH. */
  tags?: Readonly<Record<string, string>>;
  include?: "attempts";
  /** The previous page's `nextCursor`. */
  cursor?: string;
  pageSize?: number;
}

/** The `client.faxes` namespace. */
export class Faxes {
  constructor(private readonly client: Ringivo) {}

  /**
   * Send one outbound fax.
   *
   * @returns The accepted fax. `202` means accepted, not sent: the render
   *   and the call happen afterwards, so this carries the acknowledgement
   *   members only. Watch it finish with `get()`. `idempotentReplay` is
   *   `true` when the server said this response replays an earlier send.
   */
  async send(options: SendFaxOptions): Promise<Fax> {
    const documents = uploads(options.file);
    const urls = options.urls ?? [];

    if (documents.length > 0 === urls.length > 0) {
      throw new Error(
        "send() needs exactly one of file (uploaded pages) or urls (https links); " +
          "uploads and URLs may not be mixed in one request",
      );
    }

    const count = documents.length + urls.length;
    if (count > MAX_DOCUMENTS) {
      throw new Error(
        `a fax carries at most ${MAX_DOCUMENTS} documents, uploads and URLs counted ` +
          `together; got ${count}`,
      );
    }

    const fields: Record<string, string> = {
      fax_account: options.faxAccount,
      to: options.to,
    };
    if (options.from !== undefined) {
      fields.from = options.from;
    }
    if (options.resolution !== undefined) {
      fields.resolution = options.resolution;
    }
    if (options.clientReference !== undefined) {
      fields.client_reference = options.clientReference;
    }

    const headers = new Headers({
      Accept: JSON_MEDIA_TYPE,
      "Idempotency-Key": options.idempotencyKey ?? globalThis.crypto.randomUUID(),
    });

    let body: string | Uint8Array;

    if (urls.length > 0) {
      const json: Record<string, unknown> = { ...fields };
      if (options.tags !== undefined) {
        json.tags = { ...options.tags };
      }
      if (options.coverPage !== undefined) {
        json.cover_page = { ...options.coverPage };
      }
      json.documents = [...urls];

      headers.set("Content-Type", JSON_MEDIA_TYPE);
      body = JSON.stringify(json);
    } else {
      const boundary = `----ringivoBoundary${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
      headers.set("Content-Type", `multipart/form-data; boundary=${boundary}`);
      body = await multipartBody(boundary, fields, options, documents);
    }

    const response = await this.client.request(
      new Request(`${this.client.baseUrl}/v1/faxes`, { method: "POST", headers, body }),
    );

    // `Idempotent-Replay: true` is the ONLY thing that tells a replay from a
    // fresh accept — the body is the same fax either way.
    return faxFromAcknowledgement(dataObject(await response.json()), {
      idempotentReplay: response.headers.get("Idempotent-Replay") === "true",
    });
  }

  /**
   * Read one fax and its document metadata.
   *
   * @param options.include - `attempts` to side-load the per-call attempt
   *   records, which then arrive in `fax.raw`'s sibling `included` member.
   */
  async get(faxId: string, options: { include?: "attempts" } = {}): Promise<Fax> {
    const { data } = await transportOf(this.client)["/v1/faxes/{fax}"].GET({
      params: { path: { fax: faxIdParam(faxId) }, query: { include: options.include } },
    });

    return faxFromResource(dataObject(data));
  }

  /**
   * One page of faxes, newest first — the inbox and the outbox together.
   *
   * The collection is cursor-paginated and nothing is sortable: the cursor's
   * ordering IS the id ordering, so a client-supplied sort would make pages
   * overlap. Pass the previous page's `nextCursor` back as `cursor` to walk
   * it.
   */
  async list(options: ListFaxesOptions = {}): Promise<FaxPage> {
    const tags = options.tags;

    const { data } = await transportOf(this.client)["/v1/faxes"].GET({
      params: {
        query: {
          "page[cursor]": options.cursor,
          "page[size]": options.pageSize,
          include: options.include,
          "filter[fax_account]": options.faxAccount,
          "filter[direction]": options.direction as ListFaxesQuery["filter[direction]"],
          "filter[status]": options.status as ListFaxesQuery["filter[status]"],
          "filter[from]": options.from,
          "filter[to]": options.to,
          "filter[client_reference]": options.clientReference,
          "filter[created_after]": options.createdAfter,
          "filter[created_before]": options.createdBefore,
          "filter[read]": options.read,
          "filter[archived]": options.archived,
          // Only when there is a tag to match: `filter[tag]` with no tag
          // name is a 400 rather than "no opinion", and an empty object
          // would serialise to exactly that.
          "filter[tag]": tags && Object.keys(tags).length > 0 ? { ...tags } : undefined,
        },
      },
    });

    return faxPageFromDocument(isRecord(data) ? data : {});
  }

  /**
   * Withdraw a fax before the far end answers.
   *
   * 200, not 202: the decision is complete when this returns and no later
   * result undoes it. Once the call has been answered, or the fax has
   * finished, it cannot be cancelled — that is an `ApiError` whose
   * `statusCode` is 409 and whose `errors[0].meta.reason` is `answered` or
   * `terminal`. That refusal carries no `code`; the status is the contract.
   */
  async cancel(faxId: string): Promise<Fax> {
    const { data } = await transportOf(this.client)["/v1/faxes/{fax}/cancel"].POST({
      params: { path: { fax: faxIdParam(faxId) } },
      headers: { Accept: JSON_MEDIA_TYPE },
    });

    return faxFromAcknowledgement(dataObject(data));
  }

  /**
   * Mint a short-lived download URL for a fax's document.
   *
   * Every call mints a fresh capability and records who asked, so the URL is
   * not something to cache past `expiresAt` or to pass on.
   *
   * @param options.format - `pdf` is what a person reads; `tiff` is what
   *   went on the wire.
   */
  async mediaLink(faxId: string, options: { format?: MediaFormat } = {}): Promise<MediaLink> {
    const { data } = await transportOf(this.client)["/v1/faxes/{fax}/media"].GET({
      params: {
        path: { fax: faxIdParam(faxId) },
        query: { format: options.format ?? "pdf" },
      },
      headers: { Accept: JSON_MEDIA_TYPE },
    });

    return mediaLinkFromJson(isRecord(data) ? data : {});
  }

  /**
   * The document's bytes: mint the link, then follow it.
   *
   * The download itself goes out UNAUTHENTICATED — the URL is pre-signed and
   * points at an object store, which must never be sent this client's bearer
   * token.
   *
   * A fax accepted a second ago has no rendered PDF yet, and a purged one
   * has none any more; both are an `ApiError` with status 404.
   */
  async media(faxId: string, options: { format?: MediaFormat } = {}): Promise<Uint8Array> {
    const link = await this.mediaLink(faxId, options);
    return downloadUnauthenticated(link.url, this.client.timeoutMs);
  }
}

/**
 * Follow a pre-signed URL and return the bytes behind it.
 *
 * Deliberately NOT through `client.request()`: that path carries our bearer
 * token, and this URL is somebody else's host. Sending the token there would
 * hand a third party a credential that reads every fax this client can
 * reach.
 *
 * It drops the token and nothing else — the User-Agent stays, because the
 * download is still this SDK asking and an operator reading an object
 * store's access log should see which client fetched the document.
 */
async function downloadUnauthenticated(url: string, timeoutMs: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await throwForResponse(response);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * One path segment, escaped so an id cannot steer the request.
 *
 * `openapi-fetch` runs `encodeURIComponent` over every path parameter, so
 * `/` is already `%2F` by the time the URL is built and this function does
 * not escape it a second time. What it adds is the REFUSAL: an empty id
 * would otherwise collapse `/v1/faxes/{fax}/cancel` into
 * `/v1/faxes//cancel`, which is a different request nobody asked for.
 *
 * Why the escaping matters at all: an id is whatever the caller's own system
 * handed them, and an unescaped `../fax-accounts/secret` normalises ON THE
 * WIRE to `/v1/fax-accounts/secret` — a different endpoint, read with this
 * client's token. faxes.test.ts asserts the escaped path rather than
 * trusting the library to keep doing it.
 */
function faxIdParam(value: string): string {
  if (!value) {
    throw new Error("a fax id is required");
  }
  return value;
}

function dataObject(payload: unknown): RawJson {
  if (!isRecord(payload)) {
    return {};
  }
  const data = payload.data;
  return isRecord(data) ? data : {};
}

/** Normalise whatever `file` was given into a list of documents. */
function uploads(file: SendFaxOptions["file"]): readonly FaxUpload[] {
  if (file === undefined) {
    return [];
  }
  if (Array.isArray(file)) {
    return file as readonly FaxUpload[];
  }
  return [file as FaxUpload];
}

interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  content: Uint8Array;
}

async function multipartBody(
  boundary: string,
  fields: Record<string, string>,
  options: SendFaxOptions,
  documents: readonly FaxUpload[],
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Part[] = Object.entries(fields).map(([name, value]) => ({
    name,
    content: encoder.encode(value),
  }));

  // `tags` and `cover_page` are JSON-typed parts, as the spec's multipart
  // `encoding` says — a content type and NO filename, so a server reads them
  // as form fields rather than as uploaded pages.
  if (options.tags !== undefined) {
    parts.push({
      name: "tags",
      contentType: JSON_MEDIA_TYPE,
      content: encoder.encode(JSON.stringify({ ...options.tags })),
    });
  }
  if (options.coverPage !== undefined) {
    parts.push({
      name: "cover_page",
      contentType: JSON_MEDIA_TYPE,
      content: encoder.encode(JSON.stringify({ ...options.coverPage })),
    });
  }

  for (const [index, document] of documents.entries()) {
    parts.push(await documentPart(document, index));
  }

  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${headerValue(part.name)}"`
        : `form-data; name="${headerValue(part.name)}"; filename="${headerValue(part.filename)}"`;
    const contentType =
      part.contentType === undefined ? "" : `Content-Type: ${headerValue(part.contentType)}\r\n`;

    chunks.push(
      encoder.encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${contentType}\r\n`),
      part.content,
      encoder.encode("\r\n"),
    );
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  return concat(chunks);
}

/**
 * One `documents[]` part: a name, the bytes, and a declared type.
 *
 * The declared type is a courtesy for anything reading the request, not a
 * claim: the server sniffs the BYTES, and neither the name nor the header
 * decides what a document is.
 */
async function documentPart(document: FaxUpload, index: number): Promise<Part> {
  const fallbackName = `document-${index}`;

  if (document instanceof Blob) {
    const name = "name" in document && typeof document.name === "string" ? document.name : "";
    const filename = name || fallbackName;
    return {
      name: "documents[]",
      filename,
      contentType: document.type || guessContentType(filename),
      content: new Uint8Array(await document.arrayBuffer()),
    };
  }

  return {
    name: "documents[]",
    filename: fallbackName,
    contentType: guessContentType(fallbackName),
    content: document instanceof Uint8Array ? document : new Uint8Array(document),
  };
}

/**
 * The content type a filename suggests, for the four kinds the API accepts.
 *
 * Deliberately tiny, and deliberately not a dependency: this value is a
 * courtesy header the server does not trust, so a full media-type database
 * would be several hundred kilobytes bought to be ignored.
 */
function guessContentType(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const known: Record<string, string> = {
    pdf: "application/pdf",
    tif: "image/tiff",
    tiff: "image/tiff",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };
  return known[extension] ?? "application/octet-stream";
}

/**
 * A value safe to put inside a multipart header, quotes and all.
 *
 * A filename is the caller's, and a caller who reads one off a user upload
 * can be handed `a"\r\nContent-Type: text/html\r\n\r\n…`. Left alone, that
 * closes the quoted string and writes headers of its own — a whole extra
 * part smuggled into a request this client believed it had built. The three
 * characters that can do it are percent-escaped; nothing else is touched,
 * because a filename with a space or a comma in it is ordinary.
 */
function headerValue(value: string): string {
  return value.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
