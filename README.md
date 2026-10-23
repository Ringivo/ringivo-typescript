# ringivo

The TypeScript and JavaScript client for the Ringivo API: send a fax, read
one, list them, cancel one, fetch its pages, manage your customers' fax
accounts, say who may read them, register the webhooks that tell you what
happened — and verify them when they arrive. It also lists your customers
and reads their phone systems: their call records, who holds which
extension, what their phones have registered, and click-to-dial. For text
messaging, it records the texts your own system sent, reads the texts sent to
your numbers, and parses the `message.*` webhooks.

```sh
npm install ringivo
```

Node 20 or newer. The only runtime dependency is `openapi-fetch`. The package
ships both ES modules and CommonJS, with types for each.

**Webhook verification needs Node.** `verifyWebhook()` uses `node:crypto`,
so it runs on a server. That is where it belongs: the signing secret is a
server-side credential, and a `whsec_` sent to a browser is a `whsec_` that
has been published.

Upgrade notes and breaking changes: [CHANGELOG.md](https://github.com/Ringivo/ringivo-typescript/blob/main/CHANGELOG.md).

## Your base URL, your tenant, your scopes

There is no default host, and none is compiled in. Your provider gives you
the API root, a client id, a client secret, and the **tenant** id your
credential was granted for; everything in this README uses
`https://api.yourprovider.example` where yours goes.

The client exchanges all of that for a bearer token on the first call, and
mints a fresh one before the short-lived token it holds expires — or as soon
as the server refuses the one it has. You never handle a token.

**Name your tenant. It is required**, and the client refuses to build without
one. The mint used to work it out for you when your credential held exactly
one grant — and that inference is gone. It worked right up to the day a
reseller granted your credential a *second* tenant, and then an integration
that had run for months began failing, in code nobody had touched, because of
a change made on somebody else's screen. A tenant you wrote down cannot rot
that way. Acting for another tenant means another client.

**Ask for the scopes you need**, or the client refuses to build one at all.
What you get is your ask narrowed to what your grant allows, so an empty ask
narrows to nothing — and a token that authorises nothing is refused rather
than issued. There is no default set, so an empty ask is a mistake worth
hearing about at construction rather than one round trip later.

A **published** scope outside your grant is dropped silently rather than
refused, as long as something survives. So ask for exactly the scopes you were
granted: a dropped one costs you nothing here and surfaces much later, as a
403 on a call that looks unrelated.

Two cases are loud instead. A scope **name** nobody publishes is refused
outright — a typo is a mistake, not an answer about permissions. And if every
scope you asked for is dropped, so that nothing at all is left, the mint
refuses rather than handing you a token no endpoint accepts.

The scopes this client's calls need are `fax:read` and `fax:write` for
faxes, `fax-accounts:write` for opening, changing or deleting a fax
account and for granting or withdrawing access to one — a reseller-tier
scope, so a credential issued for one customer cannot hold it however it is
asked for — and `webhooks:read` / `webhooks:write` for webhook endpoints and
their deliveries. The phone-system surface needs `pbx-call-records:read` for
the call log, `pbx-users:read` for the subscribers and their devices alike,
and `pbx-calls:write` for click-to-dial. `customers:read` lists your customers
and reads one, and only a credential issued for your whole account holds it.
Recording a text you already sent needs `messages:record`, and reading the
texts sent to your numbers needs `numbers:read` or `numbers:messaging`.
A client that provisions accounts and then reads them asks for `fax:read` and
`fax-accounts:write`:

```ts
const provisioning = new Ringivo({
  baseUrl: "https://api.yourprovider.example",
  clientId: "0198c4a1-1f2e-7a3b-9c40-5f6e7d8a9b01",
  clientSecret: "9tK2xr4mQ7vBnZ1sD5hL0pWfC8jY3aE6",
  tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
  scopes: ["fax:read", "fax-accounts:write"],
});

const account = await provisioning.faxAccounts.create({
  customer: "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081",
  name: "Front desk",
});
console.log(account.id, account.retentionDays);
```

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

`send()` returns as soon as the fax is **accepted**, as a complete `Fax`
(0.16.0 asks for JSON:API; `cancel()`, `mediaLink()` and `thumbnailLink()` do
too). The render and the call happen afterwards, so `status` is `queued` here — read the fax again to see
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
did. The same key with a different request (other pages, another number) is
refused with a 422 `idempotency_key_reused`, and nothing is sent. The same
key while the first send still runs is refused with a 409
`idempotency_key_in_use`; send it again after `error.retryAfter` seconds,
with the same key. A key is 1 to 255 printable ASCII characters. An empty
key is sent as given and refused with a 400 `idempotency_key_required`; only
an omitted key gets a fresh one:

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
it or pass it on: anyone holding it reads that document. It also carries
the document's `id`, `kind` and `contentType` (`null` against an older API).

`thumbnailLink()` mints the same kind of link for the first-page preview, a
PNG — the one a list screen shows beside each fax.

## Fax accounts

A fax account is a customer's container: the numbers routed to it, the faxes
sent and received on it, and the settings that govern both. Opening,
changing and deleting one is `client.faxAccounts`.

```ts
const account = await client.faxAccounts.create({
  customer: "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081",
  name: "Front desk",
  headerText: "ACME VETERINARY",
  retentionDays: 365,
});

const page = await client.faxAccounts.list({
  customer: "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081",
});
for (const one of page.accounts) {
  console.log(one.id, one.name, one.status);
}

for (const number of await client.faxAccounts.numbers(account.id)) {
  console.log(number.e164, number.status);
}

await client.faxAccounts.update(account.id, { status: "suspended" }); // receive only
await client.faxAccounts.delete(account.id);
```

**An account belongs to one customer for its whole life.** Every fax it
holds carries the customer it was sent or received for, so there is no way
to move it and no option that would try.

**Numbers are attached through the routing API, not here.** A number points
at one destination, and that rule belongs to the number:
`POST /v1/phone-numbers/{id}/routing` with `targetType: fax` and the
account's id in `faxAccount`, through `client.request()`. `numbers()` reads
back what is pointed at this account — all of them, walking the pages for
you, because a half-list of a fax account's numbers looks exactly like a
full one.

```ts
await client.request(
  new Request(`${client.baseUrl}/v1/phone-numbers/${numberId}/routing`, {
    method: "POST",
    headers: { Accept: "application/vnd.api+json", "Content-Type": "application/json" },
    body: JSON.stringify({ targetType: "fax", faxAccount: account.id }),
  }),
);
```

Send these camelCase names. The API refuses the old
`target_type`/`fax_account` body with a 422 rather than routing the number to the PBX. **The body is not
portable across the API's v1 naming cleanup** (see "0.12.0" in CHANGELOG.md): an API that has not taken the rename reads only
`target_type`/`fax_account`, ignores `targetType`, and routes the number to
the customer's PBX with a 204. Check where the number routes after the call
if you cannot be sure which API you are talking to.

### Retention: two rules, either of them off

Retention here DELETES; it never holds anything back.

| Option | What it does | Off |
|---|---|---|
| `retentionDays` | Delete a fax's pages once they are older than this many days. | `null` — kept for ever |
| `retentionPages` | Keep only this many of the newest pages on the account. | `null` — no page limit |

A new account gets your provider's defaults — a year, and no page limit, at
the time of writing — because this client sends nothing for an option you
did not pass.

```ts
await client.faxAccounts.update(account.id, { retentionDays: 90, retentionPages: 5000 });
await client.faxAccounts.update(account.id, { retentionDays: null }); // keep for ever
```

Deleting a FAX is never blocked by retention: `DELETE /v1/faxes/{id}`
removes its pages now.

### Changing one setting changes one setting

`update()` is a sparse PATCH: it sends only the members you pass, so
suspending an account leaves its retention rules exactly as they were.
`undefined` is "not given"; `null` is a value that clears a nullable field.

```ts
await client.faxAccounts.update(account.id, { defaultFromE164: null }); // clears it
await client.faxAccounts.update(account.id, {});                       // throws
```

### Deleting an account

`delete()` DESTROYS the stored pages of every fax on the account and cannot
be undone — download anything worth keeping first. The account then leaves
your listings and the people granted it lose access; the fax records
themselves survive as the billing and audit evidence, and nothing bills
after the delete.

It is refused while any number still routes to the account:

```ts
try {
  await client.faxAccounts.delete(account.id);
} catch (refusal) {
  if (refusal instanceof ApiError && refusal.code === "fax_account_has_routed_numbers") {
    console.log("move or release its numbers first");
  }
}
```

Branch on `code`, not on the 409: a fax that cannot be cancelled is a 409
too, and it carries no code at all.

## Who can see an account's faxes

A **grant** is one row: this person may read this account's faxes. They are
`client.faxAccountUsers`, and the question they answer is "who can see
this?" — which is why every row carries the grantee's `userEmail` and not
only an id.

```ts
const faxAccount = "0198c4a1-3c4d-7e5f-9061-2b3c4d5e6f70";

const grant = await client.faxAccountUsers.create({
  faxAccount,
  user: "0198c4a1-7081-72a3-d4a5-6f7081920314",
});

const page = await client.faxAccountUsers.list({ faxAccount });
for (const one of page.grants) {
  console.log(one.userEmail, one.userId);
}

await client.faxAccountUsers.delete(grant.id); // withdraw it
```

Reading grants needs `fax:read`; granting and withdrawing need
`fax-accounts:write`.

**A grant is not what lets somebody administer the account.** Administering
one is decided by the person's role, and reading its CONTENT is decided by a
grant, so the two answer different questions — a manager who can rename an
account may hold no grant on it. That is also why `create()` may name an
account you hold no grant on yourself: somebody has to add the first member.

**There is nothing on a grant to change**, so there is no `update()`.
Withdraw one by deleting it, and `delete()` takes the GRANT's own id — the
`id` of a row from `list()`, not the account's and not the person's.
Withdrawing removes the grant and nothing else: the account, its numbers and
every fax on it are untouched, and a person who reaches the account some
other way goes on reaching it.

## Webhook endpoints

A webhook endpoint is a URL of yours plus what it hears about. Registering
one, changing it, switching it off and rotating its secret is
`client.webhookEndpoints`.

Reads need `webhooks:read` and writes need `webhooks:write`. A `fax:*` token
reaches the **fax-account-scoped** endpoints alone: `fax:write` may register
one, and a customer- or tenant-scoped endpoint is absent from a `fax:read`
listing and answers 404 to a `fax:*` read.

### Register one, and store the secret

```ts
const endpoint = await client.webhookEndpoints.create({
  url: "https://hooks.acme-vet.example/faxes",
  scopeType: "fax_account",
  scopeId: account.id,
  events: ["fax.received"],
});

await vault.put("ringivo-webhook-secret", endpoint.secret); // the only time you see it
```

**The secret is in that response and nowhere else.** Store it before you do
anything else: every other read answers `secret: null`, because the platform
keeps no readable copy. `verifyWebhook()` is what you spend it on.

`scopeType` is `tenant`, `customer` or `fax_account`, and `scopeId` is the id
of that one thing. Neither can be changed afterwards — the delivery history is
the record of what that scope was told, so a different scope is a new
endpoint. A `fax:write` token may only say `fax_account`; naming a `customer`
or `tenant` scope with it is a 422.

`events` is required, and it must name at least one type. **There is no
spelling that means *every event in scope*:** `null` and `[]` are each a 422,
and the option type is a non-empty array, so an empty list is a compile error
before it is a round trip. Name the events you handle — `update()` below is how
you add more. An event name the platform does not publish is a 422 too, so a
typo cannot subscribe you to silence.

The URL must be `https` on a public host. A hostname that does not resolve yet
is accepted on purpose, so you can register before you publish DNS.

### Adding events to an endpoint you already have

This is the one that catches people. Register for `fax.received` alone and
that is all you will ever hear about — the outbound lifecycle events never
arrive, and nothing fails to tell you so. Add them:

```ts
await client.webhookEndpoints.update(endpoint.id, {
  events: ["fax.received", "fax.delivered", "fax.partial", "fax.failed"],
});
```

**The list REPLACES the old one**, so name every event you want, not only the
new ones. It must still name at least one: `[]` is a 422; this client never
sends `null` — a JavaScript caller's `null` is dropped from the PATCH, and
refused if nothing else was named. A PATCH that could empty the list would
otherwise reach, one request later, the every-event state a registration
refuses.

`update()` is a sparse PATCH, like `faxAccounts.update()`: it sends only the
members you pass, so changing the events leaves the URL and the switch exactly
as they were. An empty options object throws.

### Switching one off

```ts
await client.webhookEndpoints.update(endpoint.id, { active: false });
```

The fan-out stops and everything else stays: the secret, the URL, the event
list and the delivery history. `delete()` removes the endpoint instead — the
fan-out stops at once, and the deliveries survive, which is what answers "why
did our integration stop hearing about faxes?".

### Rotating the secret

```ts
const rotated = await client.webhookEndpoints.rotateSecret(endpoint.id);

await vault.put("ringivo-webhook-secret", rotated.secret);
console.log(rotated.secretPreviousExpiresAt); // roll your copy before this
```

A rotation starts a clock rather than cutting you off. **The previous secret
goes on signing for 24 hours**, and `secretPreviousExpiresAt` is the deadline;
during that window a delivery carries two signatures and `verifyWebhook()`
accepts either. So a rotation costs you no deliveries as long as your own copy
is replaced before the deadline.

### What we could not deliver

`client.webhookDeliveries` is evidence of what went wrong, not a history. A
delivery that reaches you leaves no row at all: one appears when an attempt
fails, moves along the retry ladder, and is removed the moment a later attempt
succeeds.

```ts
const missed = await client.webhookDeliveries.list({ status: "dead" });
for (const delivery of missed.deliveries) {
  console.log(delivery.eventType, delivery.eventId, delivery.statusCode, delivery.error);
}
```

**`status: "dead"` is the query this collection exists for.** Delivery is
at-least-once with a dead-letter, so "we tried and gave up" is a state that is
reached without your server ever hearing about it — this is where you learn
what an outage cost you. `pending` is everything still on the ladder. There is
no `delivered`, and asking for one is a 400.

Narrow it with `endpoint`, `eventType` and the page params, and read one row
with `webhookDeliveries.get(id)`. The body we POSTed is never published here —
only its `payloadSha256`, so an integrator who kept what they received can
prove it is what we sent. For proof that one event arrived, use your own
receipt: every POST carries `Ringivo-Event-Id`.

Reads need `webhooks:read`. A delivery borrows its endpoint's reach, so
`fax:read` lists only the deliveries of fax-account-scoped endpoints.

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
  `eventId`, because a retry carries the same one.

`verifyWebhook()` returns nothing and throws `SignatureVerificationError` on
any failure — a stale timestamp, the wrong secret, a malformed header, or no
header at all. That last one includes whatever your framework hands over when
the header is absent (`undefined`, `null`) or arrived twice (a `string[]`), so
the one `catch` above is enough to answer 400 and never 500.
During a secret rotation the header carries two signatures and either secret
verifies, so a rotation costs you no deliveries.

## Message events

`message.received` describes a text somebody sent TO one of your numbers.
`message.sent`, `message.delivered` and `message.failed` describe a text
sent FROM one of your numbers. Verify the raw body, decode it yourself, then
parse it and branch on `event.type`:

```ts
import { SIGNATURE_HEADER, SignatureVerificationError, parseMessageEvent, verifyWebhook } from "ringivo";

app.post("/hooks/messages", (request, response) => {
  try {
    verifyWebhook(request.rawBody, request.get(SIGNATURE_HEADER), "whsec_...");
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      return response.sendStatus(400);
    }
    throw error;
  }

  const event = parseMessageEvent(JSON.parse(request.rawBody.toString("utf8")));

  switch (event.type) {
    case "message.received": // somebody texted one of your numbers
      console.log(event.message.from, "wrote to", event.message.to, ":", event.message.body);
      break;
    case "message.sent":
    case "message.delivered":
      if (event.message.source === "phone_system" && event.message.sentBy !== null) {
        console.log(event.message.sentBy.name, "replied:", event.message.body);
      }
      break;
    case "message.failed":
      console.log("failed:", event.message.failureCause); // treat a cause you do not know as a failure
      break;
    default: // not a message event (type is null): accept it and ignore it
  }
  return response.sendStatus(204);
});
```

- **One variant per event type.** `event.type` tells them apart, and each
  variant carries only its own members: a received message has `receivedAt`
  and no provider ids; the three sent-message events share
  `OutboundMessageEventData`; only `message.failed` has `failureCause`.
- **Anything else is an `UnknownMessageEvent`**, whose `type` is `null` and
  which has no `message`: another event type, a type this release does not
  know yet, or a body that is not a JSON object. The type that arrived, if
  any, is `event.raw.type`.
- **To route by direction without parsing**, use
  `INBOUND_MESSAGE_EVENT_TYPES` (`message.received`) and
  `OUTBOUND_MESSAGE_EVENT_TYPES` (`message.sent`, `message.delivered`,
  `message.failed`). There is no list of all four: a receiver that read every
  type in one list as a sent message would file received texts as sent.
- **The parse never throws on content.** A member that is missing or of the
  wrong type reads `null`, and the whole body stays on `event.raw` — the same
  rule as every model here. Decide for yourself which `null` you cannot work
  without (for example, no `message.providerMessageId`).
- **`source` and `failureCause` are strings, not enums**: the API can add
  values, and a value this release does not know still reaches you.
  `FAILURE_CAUSES` lists the seven causes the API documents today, and
  `failureCause` is typed `FailureCause` or any other string. **Treat a
  cause you do not know as a failure.** The seven causes are
  `provider_refused`, `provider_unreachable`, `send_interrupted`,
  `opted_out`, `no_send_key`, `media_unavailable` and `undelivered`.
  `send_interrupted` means the send was interrupted before the carrier
  confirmed it: treat the text as not sent (rarely, it may still arrive).
  The platform never sends it again.
- **`sentBy`** is set only for a staff reply (`source === "phone_system"`),
  and its `name` can be `null`. For a message the provider never accepted,
  **`sentAt`, `providerMessageId` and `providerPartIds` are `null`**. The
  provider ids are set only on your own provider account; on any other
  account both are `null`. `providerPartIds` is `null` exactly when
  `providerMessageId` is `null`, and never `[]`.
- **On `message.received`**, `message.id` is the id
  `client.inboundMessages.get()` takes, and `receivedAt` is when it was sent.
- **Media items are described, never linked.** On `message.received`,
  `media` holds `InboundMessageMediaItem`s (`contentType`, `filename`,
  `size`). On the three outbound events it holds
  `OutboundMessageMediaItem`s (`contentType`, `size`), with no filename.
  `size` is in bytes.
- **A redelivery carries the values its event was built with.** An event
  built before the API's 0.23.0 messaging change still has the old values
  when it is delivered again: `bytes` and `encoding` on a media item (`size`
  then reads `null`; the old members stay on `raw`), the causes
  `outcome_unknown` and `submission_interrupted` (they arrive as plain
  strings; treat them as `send_interrupted`), and `providerPartIds: []`
  (reads `[]`).
- Deliveries are at least once, and the three outbound events can arrive in
  any order. Dedupe on `event.eventId`, or on the pair (`message.id`,
  `event.type`). Never on the message id alone: that would drop the
  `message.delivered` or `message.failed` that follows the `message.sent` of
  the same message.

## Customers

`client.customers` lists the businesses you sell to and reads one.

```ts
const found = await client.customers.list({ code: "jpz3k" });
const [clinic] = found.customers;

if (clinic) {
  console.log(clinic.name, clinic.pbx, clinic.effectiveRegion);

  const calls = await client.pbx.callRecords.list({ customer: clinic.id });
  console.log(calls.callRecords.length);
}
```

**A customer's `id` is what the other resources take as `customer`** —
`client.pbx.callRecords.list({ customer })`, `pbx.subscribers.list` and
`pbx.devices.list`, and the fax-account calls. `code` is the platform's short
code for a customer: five lowercase letters and digits that never change, so
it finds one customer or none.

`ids` reads several customers by id in one request — the ids `list()` and
`get()` hand back — instead of one round trip each. It combines with `code`,
which narrows the same page further, and an empty list narrows nothing:

```ts
const page = await client.customers.list({
  ids: ["0198c4a1-4d5e-7f60-a172-3c4d5e6f7081", "0198c4a1-9b21-7e4f-8a32-5b6c7d8e9f01"],
});
```

**An account-wide credential only.** `customers:read` rides a credential
issued for your whole account. A credential issued for one customer never
holds it: the scope is dropped when the token is minted.

`pbx` says whether the customer has a phone system. When it is `false`,
`residential`, `callLimit`, `callLimitExternal`, `transports` and
`provisioningState` are all `null`. The order of `transports` is data: it is
the order the transports are offered in DNS, first preferred.

The list is newest first and walks by cursor like every other list here —
`after`, `before`, `pageSize`. A customer that is not on your account answers
**404**, not 403.

## Call records, subscribers, devices and click-to-dial

`client.pbx` is your customers' phone systems: who holds which extension,
what their phones have registered, what was called — and asking one of
those phones to place a call.

```ts
const clinic = "0198c4a1-4d5e-7f60-a172-3c4d5e6f7081";

const page = await client.pbx.callRecords.list({
  customer: clinic,
  startedAfter: "2026-09-01T00:00:00Z",
  startedBefore: "2026-09-30T23:59:59Z",
  direction: "inbound",
});

for (const call of page.callRecords) {
  console.log(call.startedAt, call.fromNumber, call.answeringExtension, call.durationSeconds);
}
```

**A `*Number` member is E.164 or `null`** — `fromNumber`, `toNumber` and
`dialedNumber` carry `+14075550101`, never an extension, a dial code or a star
code. An extension is in `fromExtension`, `routedByExtension` or
`answeringExtension` instead.

**Ask for the extended tier with `fields`.** `vendorId`, `origCallId`,
`termCallId`, `byAction`, `terminatedTo`, `codec`, `hostname`, `rawFromUri`,
`rawFromUser`, `rawToUser` and `rawRequestUser` are the phone system's own raw
values, served only when named. A sparse fieldset NARROWS rather than adds, so
name the standard members you still want beside them:

```ts
const raw = await client.pbx.callRecords.list({
  fields: ["direction", "startedAt", "vendorId", "terminatedTo"],
});
```

**Name a date range unless you mean the last two months.** The phone system
keeps one table per month, and your range picks which of them are opened at
all — so with no range you get the current month and the previous one, not
everything. A range wider than 13 months is refused with a 400.

**A record the phone system hides is left out of the list and served by
`get()`.** That asymmetry is its own portal's, not ours. Pass
`includeHidden: true` to put them back into a listing.

`direction` is `inbound`, `outbound` or `internal`; a word outside those is a
400 rather than an empty page. On a record you read back, though, `direction`
and `disposition` are both plain strings — the switch records one integer
carrying the pair, and one it has no word for arrives as its own digits.
Compare against the values you know rather than assuming there are no others.

**`recordingStatus` says where the call's recording stands:** `none`,
`processing`, `available` or `failed`. `available` means a recording is held;
it is not itself the audio — fetch it with `recordings(call.id)`, below.
`transcriptStatus` does the same for the transcript (`none`, `requested`,
`processing`, `available` or `failed`), and is `null` unless your credential
holds `pbx-transcripts:read`. Both are plain strings, like `direction`.

**`hasRecording` is deprecated in 0.15.0** (your editor strikes it through).
It is `true` exactly when `recordingStatus` is `available`, so it cannot tell
"on its way" from "never recorded" from "lost". Read `recordingStatus`
instead. The API still serves the old member until a later, announced release.

### Recordings and transcripts

```ts
for (const recording of await client.pbx.callRecords.recordings(call.id)) {
  console.log(recording.id, recording.duration, recording.contentType, recording.contentUrl);
}

for (const transcript of await client.pbx.callRecords.transcripts(call.id)) {
  console.log(transcript.id, transcript.status); // "ready", "pending" or "not_requested"
}
```

Both answer every **capture** of one call — a call can have more than one,
because the phone system's own capture id is `(call id, ccc id)` — and
neither is paginated: this is the captures of one call, bounded by its two
legs, never a walk over a growing table, so there is no `after`/`before`
cursor and nothing beyond the array you get back.

`recording.contentUrl` is a signed, time-limited link minted fresh on every
call. Do not cache it past its `expiresAt` or hand it to anyone else —
whoever holds the URL can fetch the audio with no further authorization. A
transcript has no link: its words are its `segments`.

**Save a recording with the extension its `contentType` names.** New
recordings are `audio/webm` (two-channel Opus: the first channel is the call's
first leg, the second the other party). Older ones may still be `audio/wav`.
Do not assume `.wav`.

`recording.callRecordId` and `transcript.callRecordId` name the ONE call
record the capture belongs to — the leg the phone system recorded. It need not
be the record you listed it through, and it is `null` when that record is in a
domain your credential cannot read or is not written yet.
`recording.recordingStatus` is always `available`, and
`transcript.transcriptStatus` uses the call record's vocabulary. It differs
from `transcript.status` in one case: after a request that ended without
words, `status` is `not_requested` (you may ask again) and `transcriptStatus`
is `failed`.

**0.16.0 removed `transcript.provider` and `transcript.model`.** The API
stopped sending them on 2026-10-01: which speech-to-text service made a
transcript is not part of it. Remove every read of them. Nothing replaces
them.

**0.16.0 also changed the transcript and the recording.** A `Transcript` has
a `channels` list — who is on each channel of a two-channel recording — and
each `TranscriptSegment` has a `channel` (0 or 1; 0 on a mono recording).
`cccId`, `byteSize`, `sha256`, `contentUrl` and `expiresAt` are removed from
`Transcript`, and the transcript download is gone: read `segments` instead.
`cccId` is removed from `Recording`. `Transcript.status` is deprecated: read
`transcriptStatus`. Faxes: `send()`, `cancel()`, `mediaLink()` and
`thumbnailLink()` now ask for JSON:API, and `MediaLink` gains `id`, `kind` and
`contentType` (`null` when an older server answers). Code that reads a removed
field, or BUILDS a `MediaLink` or `Transcript` value itself, no longer
type-checks: remove the reads, and add the new members (`null` is allowed).

`transcripts()` answers one item per **recording**, not one per transcript
that exists: a capture with no words yet still appears here, as a
`Transcript` with `transcriptStatus` of `none` or `requested`, no `segments` and
no `channels`, so you can tell "no transcript yet" from "no recording at all".
Needs `pbx-call-records:read` to fetch the call at all, and
`pbx-transcripts:read` — a separate grant, because the words of a call are
searchable and cheap to mine at scale in a way the call log itself is not —
to see whether anyone spoke.

#### Asking for a transcript, and reading its turns

```ts
import { TranscriptionCappedError, TranscriptRequestLimitedError } from "ringivo";

try {
  await client.pbx.callRecords.requestTranscript(call.id, recording.id);
} catch (error) {
  if (error instanceof TranscriptionCappedError || error instanceof TranscriptRequestLimitedError) {
    console.log("try again in", error.retryAfter, "seconds");
  } else throw error;
}

// later, or when the pbx.transcript.created webhook arrives:
const transcript = await client.pbx.callRecords.transcript(call.id, recording.id);
for (const turn of transcript.segments ?? []) {
  console.log(turn.speaker, turn.start, turn.text);
}
```

`requestTranscript()` returns at once. A 202 is a `pending` transcript; a
capture already transcribed answers the `ready` one and starts nothing new,
so it is safe to repeat. It needs `pbx-transcripts:write`. The refusals are
typed: `RecordingAudioMissingError` (409 — no audio for that capture),
`TranscriptionCappedError` (429 — the daily budget is spent; it resets at
00:00 UTC) and `TranscriptRequestLimitedError` (429 — the call was asked
about too often, 3 times a day by default across all of its captures). Both
429s carry `retryAfter` in seconds.

`transcript()` reads one capture with its `segments`, the turns of the
conversation, and its `channels`:

```ts
for (const { channel, party, role } of transcript.channels ?? []) {
  console.log(channel, party, role); // 0 "105" "callee", 1 "+15125550100" "caller"
}
```

`party` is an extension or an E.164 number. `role` is `caller` or `callee`,
and is absent when the call record does not say. **Which side is on which
channel is not fixed**, so read `role`; do not assume channel 0 is the
caller. `channels` is `null` where it is not served (the list and the
`requestTranscript()` answer) and `[]` for a one-channel recording. Until the words are ready it is a 404 whose `code` says why:
`transcript_not_requested`, `transcript_pending` or `transcript_failed`.

#### Waiting for a recording: webhooks, or polling the status

A recording lands about a minute after the call ends, and a transcript later
still. There are two ways to learn that it is ready.

**Webhooks (preferred).** Subscribe an endpoint to `pbx.recording.created`
and `pbx.transcript.created` (see [Webhook endpoints](#webhook-endpoints)).
The event body names what arrived but carries no link to it. Read its
`callRecordId` and ask for the media:

```ts
const event = JSON.parse(rawBody); // after verifyWebhook()
if (event.type === "pbx.recording.created") {
  const { callRecordId, callId } = event.data;
  const recordings =
    callRecordId !== null
      ? await client.pbx.callRecords.recordings(callRecordId)
      : null; // the call record was not written yet: list({ callId }) finds it
}
```

`callRecordId` and `contentType` are new in these payloads, so they are
**camelCase only**: they have no snake_case twin. The older members still carry
both spellings during the naming transition window (`callId` and `call_id`, for
example); read the camelCase ones.

**Polling.** If you cannot receive webhooks, read the call record again until
`recordingStatus` settles:

```ts
let record = await client.pbx.callRecords.get(call.id);
for (let i = 0; i < 20 && record.recordingStatus === "processing"; i++) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  record = await client.pbx.callRecords.get(call.id);
}

if (record.recordingStatus === "available") {
  const recordings = await client.pbx.callRecords.recordings(call.id);
} else if (record.recordingStatus === "failed") {
  // not here 15 minutes after the call ended; treat it as lost
} else {
  // "none": nothing was recorded
}
```

`failed` is not final: if a slow conversion completes later, the recording
lands, the status becomes `available` and `pbx.recording.created` is sent
as usual. Poll `transcriptStatus` the same way after `requestTranscript()`: it
moves from `requested` to `processing` to `available` or `failed`.

### Who is on the phone system, and what is registered

```ts
const people = await client.pbx.subscribers.list({ customer: clinic, search: "perkins" });
for (const person of people.subscribers) {
  console.log(person.user, person.displayName, person.kind);
}

const [person] = people.subscribers;
if (person) {
  const phones = await client.pbx.devices.list({ subscriber: person.id, registered: true });
  for (const phone of phones.devices) {
    console.log(phone.aor, phone.userAgent, phone.registrationExpiresAt);
  }
}
```

**`kind` says what a subscriber is.** A phone system holds people and
machines. `kind` is `user` for a person, and otherwise one of
`auto_attendant`, `call_queue`, `ai_agent`, `conference`, `department`, `site`,
`ring_group`, `trunk`, `time_of_day`, `domain` (the domain's settings template)
or `system`. `system` is any machine the platform has no word for yet — an
unknown marker is never read as `user`. `kind` is a plain `string`, so a word
added later arrives as itself; read one you do not know as `system`.

**For a click-to-call picker, ask for the people who have a phone:**

```ts
const callable = await client.pbx.subscribers.list({ kind: "user", hasDevices: true });
```

`kind` takes one word, a comma list (`"call_queue,auto_attendant"`) or an array
of words; a word the API does not know is a 400 that names the accepted
words. `hasDevices: false` asks for the subscribers with no registered device.
A subscriber's own devices are `subscriber.deviceIds`.

`search` is the directory box — one substring across the display name, both
halves of the person's name and the extension. `user` on `pbx.subscribers` is
the exact EXTENSION instead, and `101` does not match `1010`; `subscriber` on
`pbx.devices` is a **subscribers id**, not an extension.

**A device is one REGISTRATION, not one handset.** The row exists because
something sent a SIP REGISTER and it disappears when nothing does, so an
unplugged phone leaves no device at all and a phone that registered twice
leaves two. `registered: false` asks for the expired ones.

**A subscriber's and a device's timestamps are strings, not `Date`s** — the
only ones in this package that are. They come straight out of the phone
system, which has never published the format it writes them in, so the API
serves them unparsed and so do we: a date a year out would read exactly like
a date that is right. A call record's `startedAt`, `answeredAt` and
`releasedAt` ARE `Date`s, because those the switch stores as epochs.

### Asking somebody's phone to dial

```ts
const call = await client.pbx.subscribers.call(personId, {
  destination: "+13025556789",
  callerId: "+14075550101",
});

console.log(call.id, call.status); // 0198c4a1-… requested
```

The platform has that subscriber's phone place the call to `destination`, so
the call goes out as them rather than as you. The subscriber needs a registered
device: one with none, and the domain template (`kind: "domain"`), is refused
with a 422 titled `Not Callable`, and nothing is dialled. `autoAnswer: true` asks their
device to answer automatically where it supports that, and `device` says
which of their registrations to place it from.

**The 202 is not a call that happened.** It comes back the moment the
platform has accepted the request, so `status` is `requested` and nothing on
it says how the call went. `call.id` is the id the request was placed under,
and it finds the call record once the call has ended — see
[Finding the call a click-to-dial became](#finding-the-call-a-click-to-dial-became).

**There is no cancel, and this is not undoable.** Once the request is
accepted, the call is out of your hands.

**Retry only with the same key.** Every call carries an `Idempotency-Key`,
and the API requires it (a request without one is refused with a 400
`idempotency_key_required`). The client makes a fresh key for each call when
you do not pass one, and sends the same key again on the one retry it makes by
itself (after a 401). A second `call()` with no key is a second phone call to a
real person. If you intend to **retry** a call whose answer you never saw — a
timeout, a dropped connection — pass your own key and reuse it. The API returns
the first call's 202, with the same id, dials nothing, and tells you it did:

```ts
const call = await client.pbx.subscribers.call(personId, {
  destination: "+13025556789",
  idempotencyKey: "crm-task-8812-dial",
});

if (call.idempotentReplay) {
  console.log("this call was already placed");
}
```

A key is 1 to 255 printable ASCII characters, and it belongs to this endpoint
and to the customer or tenant your credential acts for. The API keeps it for
at least 24 hours. The same key with a different request (another destination,
another subscriber) is refused with a 422 `idempotency_key_reused`. The same
key while the first request still runs is refused with a 409
`idempotency_key_in_use`; send it again after `error.retryAfter` seconds,
with the same key — `isRetryable()` is `true` for it (see
[Retrying from a queue](#retrying-from-a-queue)). An empty key is sent as given
and refused with a 400 `idempotency_key_required`; only an omitted key gets a
fresh one. A key with a character above U+00FF never leaves the client
(`Headers` throws a `TypeError`), and one with another character that is not
printable ASCII, or longer than 255, is a 400 `idempotency_key_invalid`.
Nothing is dialled on these refusals, and only a 202 is kept against a key, so
after a refusal the same key may be sent again.

**A refused retry does not prove that nothing rang.** The API checks the
subscriber (404), your scope (403) and that the phone can be called (422
`Not Callable`) before it looks at the key. So if the first request placed the
call and the phone then went offline, the same-key retry gets the 422, not the
replay. Look at the call records before you conclude that no call was made.

The device must be that subscriber's own — one that is not is refused with a
422, whether it belongs to somebody else or does not exist, and nothing is
dialled. The pointer is `/data/attributes/device`. The check covers a
subscriber with the same extension on another domain, which is the case that would otherwise reach
a stranger.

A phone system that refuses or cannot be reached is a 502, with its own status
in `errors[0].meta.vendor_status`. **That one is safe to retry** — nothing was
dialled.

`call.callerId` is not an echo of what you sent: the platform stores caller
IDs as E.164 **without** the plus and answers with the spelling the called
party will see, so a `+1…` comes back as `1…`. It is `null` when the
subscriber's own caller ID was used.

### Finding the call a click-to-dial became

```ts
const call = await client.pbx.subscribers.call(personId, { destination: "+13025556789" });

// Later, once the call has ended — and inside the date range, see below:
const records = await client.pbx.callRecords.list({ callId: call.id });
for (const record of records.callRecords) {
  console.log(record.disposition, record.talkSeconds);
}
```

`callId` takes the `id` that `subscribers.call()` returned. The record appears once
the call has ended. It also takes a leg's SIP Call-ID (`origCallId` or
`termCallId` on a record) and the `callId` of a `pbx.recording.created` or
`pbx.transcript.created` webhook.

**The date range still applies.** The call id is matched only inside the
months your range covers, and with no `startedAfter` or `startedBefore` that is
the current and the previous month. To find an older call, pass a range that
covers when it was placed.

An empty page means the call has not ended yet, it was placed outside the
range, or the id names no call. It is never an error.

One call writes two records: the phone system rings the subscriber first,
then dials out. The list returns the visible dial-out record; add
`includeHidden: true` to get the hidden ring leg as well. A call record's own
`id` comes from the phone system's row, so it never equals `call.id`.

### Scopes, and what a read can reach

Reading the call log needs `pbx-call-records:read`. Subscribers **and** their
devices are both `pbx-users:read` — one scope covers the two. Click-to-dial
needs `pbx-calls:write`.

```ts
const phones = new Ringivo({
  baseUrl: "https://api.yourprovider.example",
  clientId: "0198c4a1-1f2e-7a3b-9c40-5f6e7d8a9b01",
  clientSecret: "9tK2xr4mQ7vBnZ1sD5hL0pWfC8jY3aE6",
  tenant: "0198c4a1-3d4e-7f50-a1b2-c3d4e5f6a7b8",
  scopes: ["pbx-call-records:read", "pbx-users:read", "pbx-calls:write"],
});
```

**Every one of these reads is narrowed to your own customers' phone systems,
and there is no unscoped form.** A credential that reaches no customer with
a phone system is refused with a **400** rather than handed an empty page, so
"nobody has one yet" never reads as "nobody has any users". Anything outside
your reach answers **404**, not 403.

## Record a text you already sent

When your own system sends texts through your own messaging-provider
account, record each one so it shows in your staff's threads. The platform
sends nothing: the text already left, and the call files it in the
conversation with your label in front of it. It needs `messages:record`.

```ts
const recorded = await client.messages.record({
  from: "+14075550142",
  to: "+13215550187",
  body: "Reminder: Rex is due for his rabies booster on Oct 24.",
  senderLabel: "Appointment reminder",
  providerMessageId: "01JC8ZA1F5T3R8C2P6M0L4JSWQ", // your provider's id
  providerPartIds: ["01JC8ZA1F5T3R8C2P6M0L4JSWQ"], // every part; a one-part text names its own id
  sentAt: new Date("2026-10-19T15:02:44Z"),
  mediaUrls: [], // up to 10 https links to media
  markConversationRead: false,
});
recorded.id, recorded.status, recorded.replayed;
recorded.media; // each an OutboundMessageMediaItem { contentType, size }
```

- **Staff see `"<senderLabel>: <body>"`.** A label is one line, has at
  least one visible character, and is 1 to 40 Unicode code points after its
  ends are trimmed. `record()` refuses a label that breaks the rule before
  any request; it never changes your label. `senderLabel(text)` makes a valid
  label from any text — a person's name, say — and throws only when nothing
  visible is left.
- **The provider message id is the dedupe key.** No `Idempotency-Key` is
  sent. A repeat with the same id and the same `from`, `to`, `body` and
  media count answers 200 with the first record (`replayed` is `true`); the
  same id with different content is a 409.
- **`mediaUrls` links to media of any type**: an image, a contact card
  (vCard), audio, video, a PDF or any other file, copied into the staff
  threads as you sent it. The limits are **at most 10 media items, at most
  10 MB each and at most 20 MB together**. The API refuses `text/plain` (put
  the text in `body`), a SMIL layout, HTML, XML, SVG and script, by the
  declared type and by the file's first bytes, with a 422. The answer
  describes each item in `recorded.media` by content type and size, never
  by your link.
- **Media is fetched during the call and never again**, so make new
  presigned links for each attempt. The API fetches all links at once and
  gives each one 10 seconds from the start of the call (redirects and DNS
  lookups included), then stores the media. It ends any request at
  30 seconds of its own time. `record()` waits at least 35 seconds
  (`RECORD_MIN_TIMEOUT_MS`) whatever the client's own `timeoutMs` is: the
  API's cut plus a margin, because the client's clock starts first. So you
  always get the API's own answer. A client that gives up sooner can abandon
  a record that is about to succeed; its retry is answered 200, with no
  second fetch. The floor is the whole request (connect, send and wait).
- **If any link fails, nothing is stored.** The `ApiError` names the link in
  `error.errors[0].source.pointer` (`/data/attributes/mediaUrls/<index>`)
  and the reason in `error.code`:

  | Status | `error.code` | What happened | What to do |
  |---|---|---|---|
  | 422 | `media_rejected` | The link, or what it served, can never be used. | Fix the link. Do not retry it unchanged. |
  | 504 | `media_timeout` | The link did not finish within 10 seconds of the call. | Retry after `error.retryAfter`, with a new link. |
  | 502 | `media_unreachable` | Its host answered 5xx, refused the connection, or does not resolve. | Retry after `error.retryAfter`, with a new link. |
  | 503 | `media_store_unavailable` | The platform could not keep the media right now. | Retry after `error.retryAfter`. |

  `isRetryable()` is `true` for the last three. When your links pass 20 MB
  together (counted after any decompression), the API stops downloading and
  answers 422 `media_rejected` with the pointer `/data/attributes/mediaUrls`:
  the list, not one link.
- **Refused before any request**: an empty provider id or part-id list, a
  `sentAt` that is not a valid `Date`, neither a body nor a media link, more
  than ten links, a link that is not `https`, a label that breaks the rule.
  A wrong type (one string where a list belongs) is a `TypeError`, every
  other refusal an `Error`. None of these is worth retrying.
- **`markConversationRead: true`** marks the staff threads read — for a
  reply a person typed in your own inbox. The default leaves them as they
  were.

The API also limits the label, `": "` and the body together to 1024 code
points; a longer text is a 422. Only a text from one of your numbers on your
own provider account can be recorded. No `message.sent` event is raised for
a recorded text, but its delivery reports raise `message.delivered` and
`message.failed` with `source: "recorded"`.

## Read the texts sent to your numbers

`client.inboundMessages` reads every text message (SMS or MMS) somebody sent
to one of your text-enabled numbers, newest first. It needs `numbers:read`
or `numbers:messaging`.

```ts
let page = await client.inboundMessages.list({
  number: "+13215550101", // your number: the one it was sent TO
  receivedAfter: "2026-09-01T00:00:00Z",
});
for (const message of page.messages) {
  console.log(message.from, message.kind, message.body, message.receivedAt);
}

if (page.nextCursor) {
  page = await client.inboundMessages.list({ number: "+13215550101", after: page.nextCursor });
}

const first = page.messages[0]; // a page can be empty
if (first) {
  const message = await client.inboundMessages.get(first.id);
}
```

- **This is the polling half of a pair.** The other half is the
  `message.received` webhook (see "Message events" above). Read this
  collection to catch up on what you missed while your endpoint was down,
  or instead of a webhook when you have no public callback URL. The event's
  `message.id` is the id `get()` takes.
- **Filters:** `number`, `from`, `kind` (`sms` or `mms`), `receivedAfter`,
  `receivedBefore` (both ends inclusive; a value that is not a date matches
  nothing) and `ids` (a list). Pages walk with `after` / `before` and
  `pageSize`, as on every list here.
- **`receivedAt` is when the message was sent**, and the date filters match
  it. `createdAt` is when the platform stored it.
- **Media is described, never carried**: `media` holds
  `InboundMessageMediaItem`s (`contentType`, `filename`, `size`) and no
  bytes or URL. `size` is in bytes; `filename` is the name the sender's
  carrier gave the item, or `null`. The platform does not serve the bytes,
  so ask your messaging provider for the file. `body` is `null` for an MMS
  with no caption.

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
the client had already replaced its token and retried once by then. Three
transcript refusals have subclasses of their own:
`RecordingAudioMissingError`, `TranscriptionCappedError` and
`TranscriptRequestLimitedError`.
Connection failures, timeouts and TLS errors are the platform's own
exceptions and are deliberately not wrapped.

A refusal from the **token exchange** is the same `ApiError`, and `code`
carries OAuth's vocabulary rather than the API's: `invalid_client` for a wrong
secret, `unauthorized_client` for a credential nobody granted this tenant,
`invalid_request` for a malformed ask, `invalid_scope` for a scope name
that does not exist or for scopes that narrowed to nothing, and
`unsupported_grant_type` for a `grant_type` this mint does not serve.

That last one should never reach you from this client, which sends
`grant_type: "client_credentials"` as a constant — so if it does, the mint
your `baseUrl` points at does not serve that grant, and the thing to check is
which deployment you are talking to. Do not read it as "my credential is not
allowed to use this grant": that is `unauthorized_client`, which is one of the
two causes wearing that code.

**Branch on `code`, never on the status.** Four of those five are a **400** —
every one but `invalid_client` — which is what RFC 6749 prescribes for a token
endpoint. `unauthorized_client` was a 403 until 2026-08-21; if you branched on
that status, move to `code`.

### Being rate-limited

A **429** carries `error.retryAfter` — the seconds the server asked you to
wait, or `undefined` if it did not say:

```ts
if (error instanceof ApiError && error.statusCode === 429) {
  const wait = error.retryAfter ?? 30; // your own backoff when it said nothing
  await new Promise((resume) => setTimeout(resume, wait * 1000));
}
```

Read it rather than the body. The rate limiter sits in front of the mint and
answers an **HTML page**, so `code` is null and `errors` is empty there — the
status and this number are the whole machine-readable answer. Both forms the
standard allows are handled for you, a count of seconds and an absolute date,
and you get seconds either way.

**This client does not retry for you.** It replaces an expired token and
retries once on a 401, and that is the only retry it performs — a 429 is
handed to you to back off from, because how long a fax send may sit is your
decision and not a library's.

### Retrying from a queue

`isRetryable(error)` is the API's retry contract — `true` for no answer
(Node's `fetch` timed out, or got no response: a refused connection, a reset,
a DNS or TLS failure), for 408, 429 and every 5xx, and for a 409 whose `code`
is `idempotency_key_in_use`. `false` for every other refusal (400, 401, 403,
404, every other 409, 422): the same request gets the same answer until
something changes first. `false` too for a `fetch` failure this client
caused (an unknown URL scheme, a forbidden port, a URL that does not parse),
and for anything this package did not throw for the API — a refusal before
any request included. Fix the request for a 400, another 409 or a 422 — never
retry those unchanged. A 401, 403 or 404 can be an account setting that is
fixed later, such as a missing scope. A queue may retry those slowly, after
the change.

**Retry with the same `Idempotency-Key`.** For `faxes.send()` and
`pbx.subscribers.call()`, a retry is safe only when it sends the key the first
attempt sent: pass your own `idempotencyKey` and keep it with the queued job.
A 409 `idempotency_key_in_use` means the first request with that key still
runs. Send the same request with the same key after `retryAfter`, and you get
the first request's answer. A new key can send the fax or ring the phone a
second time.

```ts
import { ApiError, isRetryable } from "ringivo";

try {
  await client.messages.record({ ... });
} catch (error) {
  if (isRetryable(error)) {
    // Unchanged means the same idempotency key too, for a send or a call.
    const wait = error instanceof ApiError ? error.retryAfter : undefined; // seconds, or undefined
    queue.retryLater(wait ?? yourBackoff(attempt));
  } else if (error instanceof ApiError && [401, 403, 404].includes(error.statusCode)) {
    // An account setting, such as a missing scope: retry slowly, and
    // alert someone to fix it.
    queue.retryLater(yourSlowBackoff(attempt));
  } else {
    queue.giveUp(); // 400, 422, any other 409, or refused before sending: fix the call
  }
}
```

## What is in the box

| | Scope | |
|---|---|---|
| `new Ringivo({ baseUrl, clientId, clientSecret, scopes, tenant, customer?, timeoutMs? })` | — | The client. `tenant` is required; `scopes` may not be empty. |
| `client.faxes.send({ faxAccount, to, file \| urls, … })` | `fax:write` | Send one fax. Resolves to the accepted `Fax`. |
| `client.faxes.get(faxId, { include? })` | `fax:read` | One fax, complete. |
| `client.faxes.list({ …filters, after?, before?, pageSize? })` | `fax:read` | A `FaxPage`: `faxes` plus `nextCursor`. |
| `client.faxes.cancel(faxId)` | `fax:write` | Withdraw a fax before it is answered. |
| `client.faxes.media(faxId, { format? })` | `fax:read` | The document's bytes, as a `Uint8Array`. |
| `client.faxes.mediaLink(faxId, { format? })` | `fax:read` | The URL and its expiry, as a `MediaLink`. |
| `client.faxes.thumbnailLink(faxId)` | `fax:read` | The first-page preview (a PNG): its URL and expiry, as a `MediaLink`. |
| `client.faxAccounts.list({ customer?, status?, after?, before?, pageSize? })` | `fax:read` | A `FaxAccountPage`: `accounts` plus `nextCursor`. |
| `client.faxAccounts.get(faxAccountId)` | `fax:read` | One `FaxAccount`. |
| `client.faxAccounts.numbers(faxAccountId)` | `fax:read` | Every `FaxAccountNumber` routed to it, all pages walked. |
| `client.faxAccounts.create({ customer, name, headerText?, defaultFromE164?, retentionDays?, retentionPages? })` | `fax-accounts:write` | Open an account for a customer. |
| `client.faxAccounts.update(faxAccountId, { … })` | `fax-accounts:write` | A sparse PATCH: only what you pass. |
| `client.faxAccounts.delete(faxAccountId)` | `fax-accounts:write` | Delete the account and its pages. 409 while numbers route to it. |
| `client.faxAccountUsers.list({ faxAccount?, user?, after?, before?, pageSize? })` | `fax:read` | A `FaxAccountUserPage`: `grants` plus `nextCursor`. Filter by the account, by the person, or by neither. |
| `client.faxAccountUsers.get(faxAccountUserId)` | `fax:read` | One `FaxAccountUser` — the grant's own id, not the account's or the person's. |
| `client.faxAccountUsers.create({ faxAccount, user })` | `fax-accounts:write` | Grant one person access to one account's faxes. |
| `client.faxAccountUsers.delete(faxAccountUserId)` | `fax-accounts:write` | Withdraw a grant. Nothing else changes. |
| `client.webhookEndpoints.list({ scopeType?, scopeId?, active?, after?, before?, pageSize? })` | `webhooks:read` | A `WebhookEndpointPage`: `endpoints` plus `nextCursor`. `fax:read` sees fax-account scopes only. |
| `client.webhookEndpoints.get(webhookEndpointId)` | `webhooks:read` | One `WebhookEndpoint`. Its `secret` is always `null` here. |
| `client.webhookEndpoints.create({ url, scopeType, scopeId, events, active? })` | `webhooks:write` | Register one. **The only response carrying the secret.** `events` names at least one type. `fax:write` may register a `fax_account` scope only. |
| `client.webhookEndpoints.update(webhookEndpointId, { url?, events?, active? })` | `webhooks:write` | A sparse PATCH: only what you pass. The event list replaces the old one and must name at least one type. |
| `client.webhookEndpoints.delete(webhookEndpointId)` | `webhooks:write` | Remove it. The fan-out stops; the deliveries survive. |
| `client.webhookEndpoints.rotateSecret(webhookEndpointId)` | `webhooks:write` | Mint a new secret. The old one signs for 24 more hours. |
| `client.webhookDeliveries.list({ endpoint?, eventType?, status?, after?, before?, pageSize? })` | `webhooks:read` | A `WebhookDeliveryPage`: what we still owe you (`pending`) and what we gave up on (`dead`). |
| `client.webhookDeliveries.get(webhookDeliveryId)` | `webhooks:read` | One `WebhookDelivery`. |
| `client.customers.list({ ids?, code?, after?, before?, pageSize? })` | `customers:read` | A `CustomerPage`: `customers` plus `nextCursor`. `ids` reads several customers by id in one request; `code` finds one customer. |
| `client.customers.get(customerId)` | `customers:read` | One `Customer`. Its `id` is what the `client.pbx` lists take as `customer`. |
| `client.pbx.callRecords.list({ customer?, startedAfter?, startedBefore?, direction?, fields?, subscriber?, callId?, includeHidden?, after?, before?, pageSize? })` | `pbx-call-records:read` | A `CallRecordPage`: `callRecords` plus `nextCursor`. The date range picks which months are read. `fields` asks for the extended tier (it narrows). `callId` finds the records that carry one call id: what a click-to-dial became, a leg's SIP Call-ID, or a recording webhook's `callId`. |
| `client.pbx.callRecords.get(callRecordId)` | `pbx-call-records:read` | One `CallRecord`. Serves a hidden record, which the list leaves out. |
| `client.pbx.callRecords.recordings(callRecordId)` | `pbx-call-records:read` | Every capture of that call, as a plain `readonly Recording[]` — NOT paginated: this is the captures of one call, not a walk over a table. Each `Recording.contentUrl` is a freshly minted, short-lived link. |
| `client.pbx.callRecords.transcripts(callRecordId)` | `pbx-call-records:read` + `pbx-transcripts:read` | One `Transcript` per capture — `status: "not_requested"` or `"pending"` and every other field `null` for one with no words yet. Also NOT paginated. |
| `client.pbx.callRecords.transcript(callRecordId, recordingId)` | `pbx-call-records:read` + `pbx-transcripts:read` | One `Transcript`, with its `segments`. A 404 `code` says whether it was not requested, is pending, or failed. |
| `client.pbx.callRecords.requestTranscript(callRecordId, recordingId)` | `pbx-call-records:read` + `pbx-transcripts:write` | Ask for one capture's transcript. Resolves to the `pending` (202) or `ready` (200) `Transcript`. Safe to repeat. |
| `client.pbx.subscribers.list({ customer?, user?, search?, kind?, hasDevices?, after?, before?, pageSize? })` | `pbx-users:read` | A `PbxSubscriberPage`: `subscribers` plus `nextCursor`. `user` is the exact extension; `search` is the directory box; `kind` is one word, a comma list or an array; `hasDevices` narrows to subscribers with (or without) a device. |
| `client.pbx.subscribers.get(subscriberId)` | `pbx-users:read` | One `PbxSubscriber`. Its `createdAt`/`updatedAt` are strings, not `Date`s. |
| `client.pbx.subscribers.call(subscriberId, { destination, callerId?, autoAnswer?, device?, idempotencyKey? })` | `pbx-calls:write` | Have that subscriber's phone place a call. Resolves to a `PbxCall` — an intent, not a call that happened. Sends an `Idempotency-Key` on every request (yours, or a fresh UUID); `idempotentReplay` says when the answer replays an earlier call. |
| `client.pbx.devices.list({ customer?, subscriber?, registered?, after?, before?, pageSize? })` | `pbx-users:read` | A `PbxDevicePage`: `devices` plus `nextCursor`. `subscriber` is a subscribers id, not an extension. |
| `client.pbx.devices.get(pbxDeviceId)` | `pbx-users:read` | One `PbxDevice` — one registration, not one handset. |
| `client.messages.record({ from, to, senderLabel, providerMessageId, providerPartIds, sentAt, body?, mediaUrls?, markConversationRead? })` | `messages:record` | Record a text you already sent. Resolves to an `OutboundMessage`; `replayed` is `true` on a repeat. |
| `client.inboundMessages.list({ number?, from?, kind?, receivedAfter?, receivedBefore?, ids?, after?, before?, pageSize? })` | `numbers:read` or `numbers:messaging` | An `InboundMessagePage`: `messages` plus `nextCursor`. |
| `client.inboundMessages.get(inboundMessageId)` | `numbers:read` or `numbers:messaging` | One `InboundMessage`. |
| `client.request(request, { timeoutMs? })` | — | Any endpoint this client does not wrap yet, with your credential. `timeoutMs` replaces the client's for this one request. |
| `verifyWebhook(payload, header, secret, { toleranceSeconds?, now? })` | — | Throws unless the body is genuine and fresh. |
| `parseMessageEvent(payload)` | — | A decoded `message.*` body as its own `MessageEvent` variant, told apart by `type`. Never throws. |
| `INBOUND_MESSAGE_EVENT_TYPES`, `OUTBOUND_MESSAGE_EVENT_TYPES` | — | The message event types by direction, for routing. |
| `FAILURE_CAUSES` | — | The `failure.cause` values the API documents for `message.failed`. |
| `senderLabel(text)` | — | Any text as a label that keeps the label rule. |
| `isRetryable(error)` | — | Whether the API's contract allows the same call again. |

`CallRecord`, `CallRecordPage`, `Customer`, `CustomerPage`, `Fax`,
`FaxAccount`, `FaxAccountNumber`, `FaxAccountPage`, `FaxAccountUser`,
`FaxAccountUserPage`, `FaxDocument`, `FaxPage`, `InboundMessage`,
`InboundMessageMediaItem`, `InboundMessagePage`, `MediaLink`, `MessageEvent`
(each of its variants), `MessageSender`, `OutboundMessage`,
`OutboundMessageMediaItem`, `PbxCall`,
`PbxDevice`, `PbxDevicePage`, `PbxSubscriber`, `PbxSubscriberPage`, `Recording`,
`Transcript`, `TranscriptChannel`, `TranscriptSegment`, `WebhookDelivery`, `WebhookDeliveryPage`, `WebhookEndpoint` and
`WebhookEndpointPage` are frozen plain objects, and each keeps the JSON it was
built from in `.raw` — so a member the API adds after this release reaches
you without a new SDK. A member the API did not send reads `null`.

The whole endpoint surface is typed from the OpenAPI document at
`src/_generated/schema.d.ts`. Those types are private: they are regenerated
wholesale by `scripts/generate.sh`, and none of them is published in this
package's own types.

## Licence

MIT.
