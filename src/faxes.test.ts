/**
 * The fax surface, asserted on the WIRE.
 *
 * Every test here checks the request that went out or the object that came
 * back, never an internal call. That is deliberate: `send()`'s whole job is
 * to build one of two very different bodies, `list()`'s is to build a query
 * string, and `media()`'s is to make two requests of which exactly one
 * carries our bearer token. None of that is observable from the return value
 * alone.
 *
 * The bodies are the ones the spec publishes — a `multipart/form-data` with
 * `documents[]` parts, or flat JSON whose `documents` is a list of https
 * URLs, and never a JSON:API document. A body carrying `data` is refused
 * outright by the server rather than half-obeyed, which is why the negative
 * assertion in "posts flat JSON" is there.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo, VERSION } from "./index.js";
import type { FaxUpload } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const FAXES_URL = `${BASE_URL}/v1/faxes`;
const FAX_ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";
const FAX_URL = `${FAXES_URL}/${FAX_ID}`;
const ACCOUNT_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";

const server = mockServer();

beforeEach(() => {
  // Every test here needs a credential to have been minted, not tested.
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(): Ringivo {
  return new Ringivo({ baseUrl: BASE_URL, clientId: "cid", clientSecret: "csecret" });
}

function accepted(overrides: Record<string, unknown> = {}): object {
  return {
    data: {
      id: FAX_ID,
      status: "queued",
      direction: "outbound",
      from: "+14075550100",
      to: "+13025556789",
      client_reference: "chart-4471",
      created_at: "2026-08-16T11:02:31+00:00",
      ...overrides,
    },
  };
}

function faxResource(): object {
  return {
    type: "faxes",
    id: FAX_ID,
    attributes: {
      direction: "inbound",
      status: "received",
      failureCode: null,
      from: "+13025556789",
      to: "+14075550100",
      pagesTotal: 3,
      pagesTransferred: 3,
      partial: false,
      attemptCount: 1,
      resolution: "fine",
      clientReference: null,
      coverPage: null,
      read: false,
      archived: false,
      tags: { clinic: "north" },
      documents: [
        {
          kind: "pdf",
          ordinal: 0,
          contentType: "application/pdf",
          byteSize: 40960,
          sha256: "a".repeat(64),
          pages: 3,
        },
      ],
      createdAt: "2026-08-16T11:02:31.000000Z",
      completedAt: "2026-08-16T11:03:04.000000Z",
    },
  };
}

/** Answer every send with 202, and record what was posted. */
function recordSends(response?: () => Response): Calls {
  const calls = new Calls();
  server.use(
    http.post(FAXES_URL, async ({ request }) => {
      await calls.record(request);
      return response ? response() : HttpResponse.json(accepted(), { status: 202 });
    }),
  );
  return calls;
}

// -- send ------------------------------------------------------------------

describe("send", () => {
  it("uploads the pages as a multipart body", async () => {
    const sends = recordSends();

    const fax = await client().faxes.send({
      faxAccount: ACCOUNT_ID,
      to: "+13025556789",
      file: new File([new TextEncoder().encode("%PDF-1.7 pretend")], "chart-4471.pdf"),
    });

    const { request, body } = sends.last;

    expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    // The four endpoints that are not JSON:API say so, and this is one.
    expect(request.headers.get("accept")).toBe("application/json");
    expect(body).toContain('name="fax_account"');
    expect(body).toContain(ACCOUNT_ID);
    expect(body).toContain('name="to"');
    // `documents[]` is how the spec says to spell the file parts.
    expect(body).toContain('name="documents[]"; filename="chart-4471.pdf"');
    expect(body).toContain("Content-Type: application/pdf");
    expect(body).toContain("%PDF-1.7 pretend");
    expect(fax.id).toBe(FAX_ID);
    expect(fax.status).toBe("queued");
  });

  it("takes raw bytes and a list of pages", async () => {
    const sends = recordSends();

    await client().faxes.send({
      faxAccount: ACCOUNT_ID,
      to: "+13025556789",
      file: [
        new TextEncoder().encode("first-bytes"),
        new File([new TextEncoder().encode("second-page-bytes")], "second.pdf"),
      ],
    });

    const { body } = sends.last;

    expect(body.split('name="documents[]"').length - 1).toBe(2);
    expect(body).toContain("first-bytes");
    expect(body).toContain("second-page-bytes");
    // Bytes with no name of their own are named for the server's benefit,
    // and declared as the octet-stream they are — the server sniffs anyway.
    expect(body).toContain('name="documents[]"; filename="document-0"');
    expect(body).toContain("Content-Type: application/octet-stream");
  });

  it("always carries an idempotency key and honours the one given", async () => {
    // The header is MANDATORY on this endpoint, and it is what makes a retry
    // of a request whose response was never seen safe. A caller who does not
    // supply one still gets a valid single send; a caller who intends to
    // retry supplies their own and reuses it.
    const sends = recordSends();
    const faxes = client().faxes;

    await faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302", file: new Uint8Array([97]) });
    await faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302", file: new Uint8Array([97]) });
    await faxes.send({
      faxAccount: ACCOUNT_ID,
      to: "+1302",
      file: new Uint8Array([97]),
      idempotencyKey: "chart-4471-attempt-1",
    });

    const keys = sends.all.map((call) => call.request.headers.get("idempotency-key"));

    expect(keys.every(Boolean)).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe("chart-4471-attempt-1");
  });

  it("reports whether the server replayed an earlier send", async () => {
    // `Idempotent-Replay: true` is the ONLY thing that tells a replay from a
    // fresh accept — the body is the same fax either way — so it would be
    // unrecoverable if this client dropped it.
    let replayHeader = true;
    recordSends(() =>
      HttpResponse.json(
        accepted(),
        replayHeader
          ? { status: 202, headers: { "Idempotent-Replay": "true" } }
          : { status: 202 },
      ),
    );

    const faxes = client().faxes;
    const one = new Uint8Array([97]);

    const replayed = await faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302", file: one });
    expect(replayed.idempotentReplay).toBe(true);

    replayHeader = false;
    const fresh = await faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302", file: one });
    expect(fresh.idempotentReplay).toBe(false);
  });

  it("posts flat JSON for urls, and never a JSON:API document", async () => {
    const sends = recordSends();

    await client().faxes.send({
      faxAccount: ACCOUNT_ID,
      to: "+13025556789",
      urls: ["https://records.acme-vet.example/charts/4471.pdf"],
      from: "+14075550100",
      resolution: "fine",
      clientReference: "chart-4471",
      tags: { clinic: "north" },
      coverPage: { to_name: "Dr Ruiz", subject: "Records" },
    });

    const { request, body } = sends.last;
    const sent = JSON.parse(body) as Record<string, unknown>;

    expect(request.headers.get("content-type")).toBe("application/json");
    expect(sent).toEqual({
      fax_account: ACCOUNT_ID,
      to: "+13025556789",
      from: "+14075550100",
      resolution: "fine",
      client_reference: "chart-4471",
      tags: { clinic: "north" },
      cover_page: { to_name: "Dr Ruiz", subject: "Records" },
      documents: ["https://records.acme-vet.example/charts/4471.pdf"],
    });
    // A body carrying `data` is refused outright rather than half-obeyed.
    expect(sent.data).toBeUndefined();
  });

  it("sends tags and cover_page as JSON-typed parts with NO filename", async () => {
    // The spec's multipart `encoding` gives both members `contentType:
    // application/json`, so they travel as JSON-typed form fields rather
    // than as bare strings a server would have to guess at.
    //
    // The absence of a filename is the half that matters, and it is why this
    // body is built by hand: `FormData` can only attach a content type to a
    // part by making it a Blob, and the platform then names that part
    // `filename="blob"`. Every server multipart parser reads a part with a
    // filename as an uploaded FILE, so the tags would arrive as a document
    // and the fax would be sent without them.
    const sends = recordSends();

    await client().faxes.send({
      faxAccount: ACCOUNT_ID,
      to: "+1302",
      file: new Uint8Array([97]),
      tags: { clinic: "north" },
      coverPage: { to_name: "Dr Ruiz" },
    });

    const { body } = sends.last;

    expect(body).toContain(
      'name="tags"\r\nContent-Type: application/json\r\n\r\n{"clinic":"north"}',
    );
    expect(body).toContain('name="cover_page"\r\nContent-Type: application/json');
    // A form field, not an upload: no filename, or a server reads it as a page.
    expect(body).not.toContain('name="tags"; filename');
    expect(body).not.toContain('filename="blob"');
  });

  it("cannot be made to smuggle extra parts through a filename", async () => {
    // A filename is the caller's, and a caller who reads one off a user
    // upload can be handed a name carrying a quote and a CRLF. Left alone it
    // closes the quoted string and writes headers of its own — a whole extra
    // part in a request this client believed it had built.
    const sends = recordSends();

    await client().faxes.send({
      faxAccount: ACCOUNT_ID,
      to: "+1302",
      file: new File([new Uint8Array([97])], 'evil"\r\nContent-Type: text/html\r\n\r\n<script>'),
    });

    const { body } = sends.last;

    expect(body).toContain('filename="evil%22%0D%0AContent-Type: text/html%0D%0A%0D%0A<script>"');
    // One document part, one set of part headers — not two.
    expect(body.split("Content-Disposition:").length - 1).toBe(3);
    expect(body).not.toContain("Content-Type: text/html\r\n");
  });

  it("refuses to guess between uploads and urls", async () => {
    // Uploads and URLs may not be mixed in one request, and a send with
    // neither has nothing to fax. Both are refused here rather than at the
    // server, because the server's answer would be a 422 the caller has to
    // read a spec to understand.
    const faxes = client().faxes;

    await expect(faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302" })).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      faxes.send({
        faxAccount: ACCOUNT_ID,
        to: "+1302",
        file: new Uint8Array([97]),
        urls: ["https://example.test/a.pdf"],
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("refuses a document it cannot read, rather than sending an empty page", async () => {
    // TypeScript stops this at compile time; JavaScript does not, and the
    // commonest untyped mistake is passing a PATH — which is what the Python
    // client takes. Left unguarded the string is not a Blob and not a
    // Uint8Array, `new Uint8Array("chart.pdf")` is EMPTY, and the request
    // goes out: a real fax, really sent, with no pages in it. The far end is
    // dialled and the customer is charged for nothing.
    //
    // The refusal has to happen before the request is built, so this asserts
    // that no send was recorded at all.
    const sends = recordSends();
    const faxes = client().faxes;

    for (const bad of ["chart-4471.pdf", 42, null, {}] as unknown[]) {
      await expect(
        faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302", file: bad as never }),
        String(bad),
      ).rejects.toThrow(/file takes/);
    }

    expect(sends.count, "a document that could not be read still reached the wire").toBe(0);
  });

  it("refuses an empty page rather than sending a fax with nothing in it", async () => {
    // A zero-length Blob, Uint8Array or ArrayBuffer is not a document read
    // that came back empty by accident — every one of these types is a
    // caller who read zero bytes and did not notice. Sent as-is, this is
    // the same real fax, really dialled, that the type-refusal test above
    // exists to stop: the customer is charged for a call carrying no pages.
    const sends = recordSends();
    const faxes = client().faxes;

    const empties: [string, FaxUpload][] = [
      ["Blob", new Blob([])],
      ["Uint8Array", new Uint8Array(0)],
      ["ArrayBuffer", new ArrayBuffer(0)],
    ];

    for (const [label, empty] of empties) {
      await expect(
        faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302", file: empty }),
        label,
      ).rejects.toThrow(TypeError);
    }

    expect(sends.count, "an empty upload still reached the wire").toBe(0);
  });

  it("does not refuse a one-byte page — the control for the empty-upload guard", async () => {
    // The guard above must catch exactly zero bytes, not "small" — a
    // one-byte page for each type is a real (if tiny) document and has to
    // go out like any other.
    const ones: [string, FaxUpload][] = [
      ["Blob", new Blob([new Uint8Array([97])])],
      ["Uint8Array", new Uint8Array([97])],
      ["ArrayBuffer", new Uint8Array([97]).buffer],
    ];

    for (const [label, one] of ones) {
      const sends = recordSends();
      await expect(
        client().faxes.send({ faxAccount: ACCOUNT_ID, to: "+1302", file: one }),
        label,
      ).resolves.toMatchObject({ id: FAX_ID });
      expect(sends.count, label).toBe(1);
    }
  });

  it("refuses more than five documents", async () => {
    // The ceiling counts uploads PLUS urls, which is why it is checked on
    // the total rather than on each body.
    await expect(
      client().faxes.send({
        faxAccount: ACCOUNT_ID,
        to: "+1302",
        file: Array.from({ length: 6 }, () => new Uint8Array([97])),
      }),
    ).rejects.toThrow(/at most 5/);
  });
});

// -- get -------------------------------------------------------------------

describe("get", () => {
  it("reads a JSON:API document into the public object", async () => {
    server.use(http.get(FAX_URL, () => HttpResponse.json({ data: faxResource() })));

    const fax = await client().faxes.get(FAX_ID);

    expect(fax.id).toBe(FAX_ID);
    expect(fax.direction).toBe("inbound");
    expect(fax.status).toBe("received");
    expect(fax.from).toBe("+13025556789");
    expect(fax.to).toBe("+14075550100");
    expect(fax.pagesTotal).toBe(3);
    expect(fax.partial).toBe(false);
    expect(fax.read).toBe(false);
    expect(fax.tags).toEqual({ clinic: "north" });
    expect(fax.createdAt?.toISOString()).toBe("2026-08-16T11:02:31.000Z");
    expect(fax.completedAt?.toISOString()).toBe("2026-08-16T11:03:04.000Z");
    expect(fax.documents).toHaveLength(1);
    expect(fax.documents[0]?.kind).toBe("pdf");
    expect(fax.documents[0]?.byteSize).toBe(40960);
    // The whole resource object is kept, so a member the API adds after this
    // release still reaches the caller.
    expect(fax.raw.type).toBe("faxes");
  });

  it("hands back a frozen object", async () => {
    // `readonly` is erased at compile time: it stops TypeScript, it does not
    // stop JavaScript. A fax is a record of something that already happened,
    // so an assignment throws rather than looking like it changed the fax.
    server.use(http.get(FAX_URL, () => HttpResponse.json({ data: faxResource() })));

    const fax = await client().faxes.get(FAX_ID);

    expect(Object.isFrozen(fax)).toBe(true);
    expect(() => {
      (fax as { status: string | null }).status = "delivered";
    }).toThrow(TypeError);
  });

  it("keeps a fax id inside its own path segment", async () => {
    // A fax id is whatever the caller's own system handed them, and an id
    // carrying `/` or `..` must not be able to steer the request at a
    // DIFFERENT endpoint. Unquoted, `../fax-accounts/secret` normalises on
    // the wire to `/v1/fax-accounts/secret` — a real resource, read with
    // this client's token, that the caller never asked for.
    //
    // Asserted on the raw pathname, which is what goes on the wire; a
    // decoded view shows `/v1/faxes/../fax-accounts/secret` even when the
    // escaping is correct, so a test written against it proves nothing.
    const calls = new Calls();
    server.use(
      http.get(`${BASE_URL}/*`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: faxResource() });
      }),
    );

    await client().faxes.get("../fax-accounts/secret");

    expect(calls.last.url.pathname).toBe("/v1/faxes/..%2Ffax-accounts%2Fsecret");
  });

  it("refuses an empty fax id rather than collapsing the path", async () => {
    await expect(client().faxes.get("")).rejects.toThrow("a fax id is required");
    await expect(client().faxes.cancel("")).rejects.toThrow("a fax id is required");
  });

  it("speaks JSON:API and can side-load the attempts", async () => {
    const calls = new Calls();
    server.use(
      http.get(FAX_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: faxResource() });
      }),
    );

    await client().faxes.get(FAX_ID, { include: "attempts" });

    expect(calls.last.request.headers.get("accept")).toBe("application/vnd.api+json");
    expect(calls.last.url.searchParams.get("include")).toBe("attempts");
  });

  it("raises a typed 404 for a fax that is not yours", async () => {
    server.use(
      http.get(FAX_URL, () =>
        HttpResponse.json(
          {
            errors: [
              { status: "404", code: "not_found", title: "Not found", detail: "No." },
            ],
          },
          { status: 404 },
        ),
      ),
    );

    const error = (await client()
      .faxes.get(FAX_ID)
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.errors[0]?.title).toBe("Not found");
  });

  it("carries the JSON:API error source on a refused send", async () => {
    recordSends(() =>
      HttpResponse.json(
        {
          errors: [
            {
              status: "422",
              code: "validation_failed",
              title: "Invalid request",
              detail: "The to field format is invalid.",
              source: { parameter: "to" },
            },
          ],
        },
        { status: 422 },
      ),
    );

    const error = (await client()
      .faxes.send({ faxAccount: ACCOUNT_ID, to: "not-e164", file: new Uint8Array([97]) })
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.statusCode).toBe(422);
    expect(error.code).toBe("validation_failed");
    expect(error.errors[0]?.source).toEqual({ parameter: "to" });
    expect(error.message).toContain("The to field format is invalid.");
  });
});

// -- list ------------------------------------------------------------------

describe("list", () => {
  it("builds the filter query including the deep-object tag", async () => {
    // `filter[tag][clinic]=north` — one query member per tag name, and two
    // of them mean BOTH. The wrapper is the part that matters: a filter that
    // silently drops it answers 200 with the WHOLE collection to a caller
    // who believes they narrowed it.
    const calls = new Calls();
    server.use(
      http.get(FAXES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().faxes.list({
      direction: "outbound",
      status: "delivered",
      read: false,
      archived: undefined,
      tags: { clinic: "north", site: "east" },
      pageSize: 50,
      after: "0198c4a1",
    });

    const params = calls.last.url.searchParams;

    expect(params.get("filter[direction]")).toBe("outbound");
    expect(params.get("filter[status]")).toBe("delivered");
    expect(params.get("filter[read]")).toBe("false");
    expect(params.get("filter[tag][clinic]")).toBe("north");
    expect(params.get("filter[tag][site]")).toBe("east");
    expect(params.get("page[size]")).toBe("50");
    expect(params.get("page[after]")).toBe("0198c4a1");
    // An unset filter is absent, not empty: `filter[archived]=` would be a
    // 400 rather than "no opinion".
    expect(params.has("filter[archived]")).toBe(false);
    expect(params.has("filter[to]")).toBe(false);
    // And `filter[tag]` with no tag name is a 400, so an empty map sends
    // nothing at all rather than a bare wrapper.
    expect(calls.last.url.search).not.toContain("filter[tag]=");
  });

  it("sends no tag wrapper when the tag map is empty", async () => {
    const calls = new Calls();
    server.use(
      http.get(FAXES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().faxes.list({ tags: {} });

    expect(calls.last.url.search).toBe("");
  });

  it("sends page[before] to poll for rows that arrived since the last read", async () => {
    const calls = new Calls();
    server.use(
      http.get(FAXES_URL, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: [] });
      }),
    );

    await client().faxes.list({ before: "0198c4a1-first-row" });

    expect(calls.last.url.searchParams.get("page[before]")).toBe("0198c4a1-first-row");
    expect(calls.last.url.searchParams.has("page[after]")).toBe(false);
  });

  it("reads nextCursor from meta.page, not by parsing the next link", async () => {
    // `nextCursor` is the server's own cursor, lifted out of `meta.page` —
    // never rebuilt from `links.next`. A client that parsed the link instead
    // would break the day the link's query grammar changed even though the
    // cursor itself did not.
    server.use(
      http.get(FAXES_URL, () =>
        HttpResponse.json({
          data: [faxResource()],
          links: { next: `${FAXES_URL}?page%5Bafter%5D=0198c4a1-next&page%5Bsize%5D=50` },
          meta: { page: { size: 50, nextCursor: "0198c4a1-next" } },
        }),
      ),
    );

    const page = await client().faxes.list();

    expect(page.faxes).toHaveLength(1);
    expect(page.faxes[0]?.id).toBe(FAX_ID);
    expect(page.nextCursor).toBe("0198c4a1-next");
    expect(page.nextUrl).toContain("page%5Bafter%5D");
  });

  it("has no cursor to follow on the last page, where links.next is ABSENT", async () => {
    // The deployed contract: `next` is missing from `links` altogether on
    // the final page, not present-and-null — `meta.page.nextCursor` is the
    // one member that answers "is there more?" on every page, this one
    // included.
    server.use(
      http.get(FAXES_URL, () =>
        HttpResponse.json({
          data: [],
          links: {},
          meta: { page: { size: 25, nextCursor: null } },
        }),
      ),
    );

    const page = await client().faxes.list();

    expect(page.faxes).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.nextUrl).toBeNull();
  });

  it("treats a null links.next the same as an absent one", async () => {
    // Defensive: the deployed API omits the key rather than nulling it, but
    // the builder must not choke on a null either.
    server.use(
      http.get(FAXES_URL, () =>
        HttpResponse.json({
          data: [],
          links: { next: null },
          meta: { page: { size: 25, nextCursor: null } },
        }),
      ),
    );

    const page = await client().faxes.list();

    expect(page.nextUrl).toBeNull();
    expect(page.nextCursor).toBeNull();
  });
});

// -- cancel ----------------------------------------------------------------

describe("cancel", () => {
  it("posts a verb and returns the decision", async () => {
    const calls = new Calls();
    server.use(
      http.post(`${FAX_URL}/cancel`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({ data: { id: FAX_ID, status: "cancelled" } });
      }),
    );

    const fax = await client().faxes.cancel(FAX_ID);

    expect(calls.last.request.headers.get("accept")).toBe("application/json");
    expect(fax.id).toBe(FAX_ID);
    expect(fax.status).toBe("cancelled");
    // A cancel is not a send, so it says nothing about a replay.
    expect(fax.idempotentReplay).toBeNull();
  });

  it("cannot cancel a fax the far end answered", async () => {
    // This refusal carries no `code` — the status is the contract, and the
    // reason is in `meta`. A caller must be able to read it without one.
    server.use(
      http.post(`${FAX_URL}/cancel`, () =>
        HttpResponse.json(
          {
            errors: [
              {
                status: "409",
                title: "Fax not cancellable",
                detail: "That fax's call has already been answered.",
                meta: { reason: "answered" },
              },
            ],
          },
          { status: 409 },
        ),
      ),
    );

    const error = (await client()
      .faxes.cancel(FAX_ID)
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.statusCode).toBe(409);
    expect(error.code).toBeNull();
    expect(error.errors[0]?.meta).toEqual({ reason: "answered" });
  });
});

// -- media -----------------------------------------------------------------

describe("media", () => {
  it("mints a link and then downloads it WITHOUT the bearer", async () => {
    // The URL is pre-signed and lives on the tenant's own API host, behind
    // a branded media proxy. Sending our bearer token there anyway would
    // hand out a credential that reads every fax this client can reach, for
    // a link the signature alone already authorizes.
    const downloadUrl = "https://objects.example.net/fax/0198c4a1/document.pdf?signature=abc";
    const link = new Calls();
    const download = new Calls();

    server.use(
      http.get(`${FAX_URL}/media`, async ({ request }) => {
        await link.record(request);
        return HttpResponse.json({
          url: downloadUrl,
          expires_at: "2026-08-16T11:07:31+00:00",
          byte_size: 40960,
          sha256: "c".repeat(64),
        });
      }),
      http.get("https://objects.example.net/fax/0198c4a1/document.pdf", async ({ request }) => {
        await download.record(request);
        return HttpResponse.text("%PDF-1.7 the real pages");
      }),
    );

    const content = await client().faxes.media(FAX_ID);

    expect(new TextDecoder().decode(content)).toBe("%PDF-1.7 the real pages");
    expect(link.last.request.headers.get("authorization")).toBe("Bearer tok");
    expect(download.last.request.headers.get("authorization")).toBeNull();
    // It drops the token and NOTHING else: the download is still this SDK
    // asking, and an operator reading the media proxy's access log should
    // see which client fetched the document.
    expect(download.last.request.headers.get("user-agent")).toBe(`Ringivo/TS ${VERSION}`);
    expect(link.last.url.searchParams.get("format")).toBe("pdf");
  });

  it("hands back the capability and its facts", async () => {
    const calls = new Calls();
    server.use(
      http.get(`${FAX_URL}/media`, async ({ request }) => {
        await calls.record(request);
        return HttpResponse.json({
          url: "https://objects.example.net/fax/0198c4a1/document.tiff?signature=abc",
          expires_at: "2026-08-16T11:07:31+00:00",
          byte_size: 128,
          sha256: "d".repeat(64),
        });
      }),
    );

    const media = await client().faxes.mediaLink(FAX_ID, { format: "tiff" });

    expect(calls.last.url.searchParams.get("format")).toBe("tiff");
    expect(calls.last.request.headers.get("accept")).toBe("application/json");
    expect(media.url.endsWith("signature=abc")).toBe(true);
    expect(media.byteSize).toBe(128);
    expect(media.expiresAt?.toISOString()).toBe("2026-08-16T11:07:31.000Z");
  });

  it("raises a typed 404 for a fax with no rendered document yet", async () => {
    server.use(
      http.get(`${FAX_URL}/media`, () =>
        HttpResponse.json(
          { errors: [{ status: "404", code: "not_found", title: "Not found" }] },
          { status: 404 },
        ),
      ),
    );

    const error = (await client()
      .faxes.media(FAX_ID)
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.statusCode).toBe(404);
  });
});
