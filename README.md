# ringivo

The TypeScript and JavaScript client for the Ringivo fax API: send a fax,
read one, list them, cancel one, fetch its pages, and verify the webhooks
that tell you what happened.

```sh
npm install ringivo
```

Node 20 or newer. The only runtime dependency is `openapi-fetch`. The package
ships both ES modules and CommonJS, with types for each.

## Before you install 0.3.0

**0.3.0 needs a provider whose platform mints at `POST /oauth/token`.** Ask
your provider whether they have made that change; if they have not announced
it, stay on 0.2.x.

This matters more than a version bump usually does, because the older platform
will not tell you no. That path already exists there, serving a different
population: it ignores `tenant` and `customer`, and answers **200** with a
token that carries no tenant at all. Nothing fails until you spend it, and then
every call is refused with a 403 that says nothing about the mint that caused
it. A version you cannot use looks exactly like a credential problem.

0.2.x mints at the older endpoint, `POST /v1/integration/token`. That endpoint
is deprecated as of **2026-08-21** and keeps serving through a migration
window, so staying put is safe while you wait.

**Webhook verification needs Node.** `verifyWebhook()` uses `node:crypto`,
so it runs on a server. That is where it belongs: the signing secret is a
server-side credential, and a `whsec_` sent to a browser is a `whsec_` that
has been published.

## Your base URL, your tenant, your scopes

There is no default host, and none is compiled in. Your provider gives you
the API root, a client id, a client secret, and the **tenant** id your
credential was granted for; everything in this README uses
`https://api.yourprovider.example` where yours goes.

The client exchanges all of that for a bearer token on the first call, and
mints a fresh one before the short-lived token it holds expires — or as soon
as the server refuses the one it has. You never handle a token.

**Ask for the scopes you need**, or the client refuses to build one at all: a
token minted without scopes carries none, and is refused by every endpoint
you spend it on. There is no default set, so an empty ask is a mistake worth
hearing about at construction rather than as a puzzling 403 in production.

What you get back is your ask narrowed to what your grant allows, and a
**published** scope outside it is dropped silently rather than refused. So ask
for exactly the scopes you were granted: a dropped one costs you nothing here
and surfaces much later, as a 403 on a call that looks unrelated.

A scope **name** nobody publishes is the exception, and it is refused outright
rather than dropped — a typo is a mistake, not an answer about permissions.

## Send a fax

```ts
import { readFile } from "node:fs/promises";
import { Ringivo } from "ringivo";

const client = new Ringivo({
  baseUrl: "https://api.yourprovider.example",
  clientId: "0198c4a1-1f2e-7a3b-9c40-5f6e7d8a9b01",
  clientSecret: "9tK2xr4mQ7vBnZ1sD5hL0pWfC8jY3aE6",
  tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
  scopes: ["fax:read", "fax:write"],
});

const fax = await client.faxes.send({
  faxAccount: "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70",
  to: "+13025556789",
  file: await readFile("chart-4471.pdf"),
  clientReference: "chart-4471",
});

console.log(fax.id, fax.status); // 0198c4a1-… queued
```

`send()` returns as soon as the fax is **accepted**. The render and the call
happen afterwards, so `status` is `queued` here — read the fax again to see
how it ended:

```ts
const finished = await client.faxes.get(fax.id);
console.log(finished.status, finished.pagesTransferred);
```

`file` takes a `Buffer`, a `Uint8Array`, a `Blob`, a `File`, an `ArrayBuffer`,
or an array of up to five of them. A `File` keeps its own name; anything else
is named `document-0`, `document-1` and so on. **A path is not a document** —
read it first, as above; passing the path itself is refused rather than sent
as an empty page.

Point at pages instead of uploading them with `urls: [...]` (up to five
`https` links). Uploads and URLs cannot be mixed in one request.

### Retrying a send safely

Every send carries an `Idempotency-Key`, and the client invents one when you
do not pass it. If you intend to **retry** a send whose response you never
saw — a timeout, a dropped connection — pass your own key and reuse it. The
server replays the first fax instead of sending a second, and tells you it
did:

```ts
const fax = await client.faxes.send({
  faxAccount,
  to: "+13025556789",
  file: pdfBytes,
  idempotencyKey: "chart-4471-attempt-1",
});

if (fax.idempotentReplay) {
  console.log("this was already sent");
}
```

## Read, list, cancel, download

```ts
const fax = await client.faxes.get(faxId);

const page = await client.faxes.list({
  direction: "inbound",
  read: false,
  tags: { clinic: "north" },
});
for (const one of page.faxes) {
  console.log(one.id, one.from, one.pagesTotal);
}

if (page.nextCursor) {
  // newest first; follow the server's own cursor
  const next = await client.faxes.list({ after: page.nextCursor });
}

await client.faxes.cancel(faxId); // before the far end answers

const pdf = await client.faxes.media(faxId); // the document's bytes
await writeFile("received.pdf", pdf);
```

`media()` mints a short-lived download link and follows it for you. Use
`mediaLink()` instead if you want the URL and its expiry — but do not cache
it or pass it on: anyone holding it reads that document.

## Verify a webhook

Every delivery carries a `Ringivo-Signature` header. Check it before you
trust the body — this needs no client and no network:

```ts
import express from "express";
import { SIGNATURE_HEADER, SignatureVerificationError, verifyWebhook } from "ringivo";

const app = express();

// Keep the RAW bytes. `express.json()` alone throws them away, and a
// re-encoded body never verifies.
app.use(express.json({ verify: (request, _response, raw) => { request.rawBody = raw; } }));

app.post("/hooks/fax", (request, response) => {
  try {
    verifyWebhook(request.rawBody, request.get(SIGNATURE_HEADER), "whsec_...");
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      // A bare 400. Do NOT echo the message: it names which check failed,
      // which is help a forger should not get. Log it on your own side.
      return response.sendStatus(400);
    }
    throw error;
  }

  handle(request.body);
  return response.sendStatus(202);
});
```

Two rules decide whether this works:

- **Give it the raw body.** Parsing the JSON and re-encoding it before
  verifying will fail, and correctly so — key order, escaping and number
  formatting are free choices no two encoders make alike. Reach for your
  framework's raw-body accessor.
- **Answer any 2XX to accept.** Deliveries are at-least-once: dedupe on
  `event_id`, because a retry carries the same one.

`verifyWebhook()` returns nothing and throws `SignatureVerificationError` on
any failure — a stale timestamp, the wrong secret, a malformed header.
During a secret rotation the header carries two signatures and either secret
verifies, so a rotation costs you no deliveries.

## When something is refused

```ts
import { ApiError, AuthenticationError } from "ringivo";

try {
  await client.faxes.send({ faxAccount, to: "not-e164", file: pdf });
} catch (error) {
  if (error instanceof ApiError) {
    error.statusCode; // 422
    error.code; // "validation_failed" — the vocabulary to branch on
    error.errors[0]?.detail; // "The to field format is invalid."
    error.errors[0]?.source; // { parameter: "to" }
  }
}
```

`AuthenticationError` (a subclass) means the credential itself was refused —
the client had already replaced its token and retried once by then.
Connection failures, timeouts and TLS errors are the platform's own
exceptions and are deliberately not wrapped.

A refusal from the **token exchange** is the same `ApiError`, and `code`
carries OAuth's vocabulary rather than the API's: `invalid_client` for a
wrong secret, `unauthorized_client` for a credential nobody granted this
tenant, `invalid_request` for an ask the server cannot resolve — most often
a tenant you did not name — and `invalid_scope` for a scope name that does
not exist.

## What is in the box

| | |
|---|---|
| `new Ringivo({ baseUrl, clientId, clientSecret, scopes, tenant?, customer?, timeoutMs? })` | The client. `scopes` may not be empty. |
| `client.faxes.send({ faxAccount, to, file \| urls, … })` | Send one fax. Resolves to the accepted `Fax`. |
| `client.faxes.get(faxId, { include? })` | One fax, complete. |
| `client.faxes.list({ …filters, after?, before?, pageSize? })` | A `FaxPage`: `faxes` plus `nextCursor`. |
| `client.faxes.cancel(faxId)` | Withdraw a fax before it is answered. |
| `client.faxes.media(faxId, { format? })` | The document's bytes, as a `Uint8Array`. |
| `client.faxes.mediaLink(faxId, { format? })` | The URL and its expiry, as a `MediaLink`. |
| `client.request(request)` | Any endpoint this client does not wrap yet, with your credential. |
| `verifyWebhook(payload, header, secret, { toleranceSeconds?, now? })` | Throws unless the body is genuine and fresh. |

`Fax`, `FaxDocument`, `FaxPage` and `MediaLink` are frozen plain objects, and
each keeps the JSON it was built from in `.raw` — so a member the API adds
after this release reaches you without a new SDK. A member the API did not
send reads `null`.

The whole endpoint surface is typed from the OpenAPI document at
`src/_generated/schema.d.ts`. Those types are private: they are regenerated
wholesale by `scripts/generate.sh`, and none of them is published in this
package's own types.

## Licence

MIT.
