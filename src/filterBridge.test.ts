/**
 * The v1 naming cleanup bridge (0.12.x), asserted on the WIRE.
 *
 * The API renamed eight filter keys and a few plain-JSON members from
 * snake_case to camelCase with no alias. This release works against the API
 * on BOTH sides of that deploy: it asks with the new filter names, falls back
 * once to the old ones on the exact 400 an unknown filter key gets, remembers
 * which spelling worked, and flips back the same way. It reads both spellings
 * of the renamed response members. The next release deletes all of it.
 *
 * The refusal fixture is the API's real body for an unknown filter key,
 * captured from the console on 2026-09-24.
 */
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { Calls, mockServer } from "../tests/msw.js";
import { ApiError, Ringivo } from "./index.js";

const BASE_URL = "https://api.yourprovider.example";
const TOKEN_URL = `${BASE_URL}/oauth/token`;
const FAXES_URL = `${BASE_URL}/v1/faxes`;
const DELIVERIES_URL = `${BASE_URL}/v1/webhook-deliveries`;
const FAX_ID = "0198c4a1-2b3c-7d4e-8f50-1a2b3c4d5e6f";
const ACCOUNT_ID = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";

const server = mockServer();

beforeEach(() => {
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }),
    ),
  );
});

function client(): Ringivo {
  return new Ringivo({
    baseUrl: BASE_URL,
    clientId: "cid",
    clientSecret: "csecret",
    tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
    scopes: ["fax:read", "webhooks:read"],
  });
}

function unknownFilter(name: string): Response {
  return HttpResponse.json(
    {
      errors: [
        {
          detail: `Filter parameter ${name} is not allowed.`,
          source: { parameter: "filter" },
          status: "400",
          title: "Invalid Query Parameter",
        },
      ],
    },
    { status: 400 },
  );
}

/** Answer each call with the next response in the list. */
function sequence(url: string, calls: Calls, answers: Array<() => Response>): void {
  let next = 0;
  server.use(
    http.get(url, async ({ request }) => {
      await calls.record(request);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      return answer ? answer() : HttpResponse.json({ data: [] });
    }),
  );
}

const emptyPage = (): Response => HttpResponse.json({ data: [] });

function filterKeys(calls: Calls): string[][] {
  return calls.all.map((call) =>
    [...call.url.searchParams.keys()].filter((key) => key.startsWith("filter[")).sort(),
  );
}

describe("the v1 naming cleanup bridge", () => {
  it("asks an API with the rename once, in the new names", async () => {
    const calls = new Calls();
    sequence(FAXES_URL, calls, [emptyPage]);

    await client().faxes.list({
      faxAccount: ACCOUNT_ID,
      clientReference: "chart-4471",
      createdAfter: "2026-08-05",
      createdBefore: "2026-08-20",
    });

    expect(filterKeys(calls)).toEqual([
      [
        "filter[clientReference]",
        "filter[createdAfter]",
        "filter[createdBefore]",
        "filter[faxAccount]",
      ],
    ]);
  });

  it("asks an API before the rename again in the old names, and remembers", async () => {
    const calls = new Calls();
    sequence(FAXES_URL, calls, [() => unknownFilter("faxAccount"), emptyPage, emptyPage]);

    const ringivo = client();
    await ringivo.faxes.list({ faxAccount: ACCOUNT_ID, status: "received" });
    await ringivo.faxes.list({ faxAccount: ACCOUNT_ID });

    expect(filterKeys(calls)).toEqual([
      ["filter[faxAccount]", "filter[status]"],
      ["filter[fax_account]", "filter[status]"],
      ["filter[fax_account]"],
    ]);
    expect(calls.all[1]?.url.searchParams.get("filter[fax_account]")).toBe(ACCOUNT_ID);
  });

  it("flips back when the API is renamed under a running process", async () => {
    const calls = new Calls();
    sequence(DELIVERIES_URL, calls, [
      () => unknownFilter("eventType"),
      emptyPage,
      () => unknownFilter("event_type"),
      emptyPage,
      emptyPage,
    ]);

    const ringivo = client();
    await ringivo.webhookDeliveries.list({ eventType: "fax.received" });
    await ringivo.webhookDeliveries.list({ eventType: "fax.received" });
    await ringivo.webhookDeliveries.list({ eventType: "fax.received" });

    expect(filterKeys(calls)).toEqual([
      ["filter[eventType]"],
      ["filter[event_type]"],
      ["filter[event_type]"],
      ["filter[eventType]"],
      ["filter[eventType]"],
    ]);
  });

  it("hands any other 400 to the caller untouched, and never retries it", async () => {
    const calls = new Calls();
    sequence(FAXES_URL, calls, [
      () =>
        HttpResponse.json(
          {
            errors: [
              {
                detail: "The page size must not be greater than 100.",
                source: { parameter: "page.size" },
                status: "400",
              },
            ],
          },
          { status: 400 },
        ),
    ]);

    await expect(client().faxes.list({ faxAccount: ACCOUNT_ID, pageSize: 1000 })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(calls.all).toHaveLength(1);
  });

  it("does not retry a refusal naming a filter that was never renamed", async () => {
    const calls = new Calls();
    sequence(FAXES_URL, calls, [() => unknownFilter("status")]);

    await expect(client().faxes.list({ status: "nonsense" })).rejects.toBeInstanceOf(ApiError);
    expect(calls.all).toHaveLength(1);
  });

  it("reads the media link in the new names and falls back to the old", async () => {
    const url = `${FAXES_URL}/${FAX_ID}/media/content?signature=abc`;
    let next = 0;
    const answers = [
      { url, expiresAt: "2026-08-16T11:07:31+00:00", byteSize: 7, sha256: "d".repeat(64) },
      { url, expires_at: "2026-08-16T11:07:31+00:00", byte_size: 7, sha256: "d".repeat(64) },
    ];
    server.use(
      http.get(`${FAXES_URL}/${FAX_ID}/media`, () => {
        const body = answers[next];
        next += 1;
        return HttpResponse.json(body);
      }),
    );

    const ringivo = client();
    const renamed = await ringivo.faxes.mediaLink(FAX_ID);
    const legacy = await ringivo.faxes.mediaLink(FAX_ID);

    const stamp = new Date("2026-08-16T11:07:31Z").getTime();
    expect([renamed.expiresAt?.getTime(), renamed.byteSize]).toEqual([stamp, 7]);
    expect([legacy.expiresAt?.getTime(), legacy.byteSize]).toEqual([stamp, 7]);
  });

  it("reads the send acknowledgement in the new names and falls back to the old", async () => {
    let next = 0;
    const base = { id: FAX_ID, status: "queued", direction: "outbound" };
    const answers = [
      { ...base, clientReference: "new", createdAt: "2026-08-16T11:02:31+00:00" },
      { ...base, client_reference: "old", created_at: "2026-08-16T11:02:31+00:00" },
    ];
    server.use(
      http.post(FAXES_URL, () => {
        const data = answers[next];
        next += 1;
        return HttpResponse.json({ data }, { status: 202 });
      }),
    );

    const ringivo = client();
    const send = () =>
      ringivo.faxes.send({ faxAccount: ACCOUNT_ID, to: "+13025556789", urls: ["https://x.example/a.pdf"] });
    const renamed = await send();
    const legacy = await send();

    const stamp = new Date("2026-08-16T11:02:31Z").getTime();
    expect([renamed.clientReference, renamed.createdAt?.getTime()]).toEqual(["new", stamp]);
    expect([legacy.clientReference, legacy.createdAt?.getTime()]).toEqual(["old", stamp]);
  });
});
