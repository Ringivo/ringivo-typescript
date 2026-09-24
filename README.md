# ringivo

The TypeScript and JavaScript client for the Ringivo API: send a fax, read
one, list them, cancel one, fetch its pages, manage your customers' fax
accounts, say who may read them, register the webhooks that tell you what
happened — and verify them when they arrive. It also lists your customers
and reads their phone systems: their call records, who holds which
extension, what their phones have registered, and click-to-dial.

```sh
npm install ringivo
```

Node 20 or newer. The only runtime dependency is `openapi-fetch`. The package
ships both ES modules and CommonJS, with types for each.

## Before you install 0.8.0

**0.8.0 carries a webhook break you did not ask for.** It is the release that
first ships a change to `client.webhookEndpoints`: `create()` now **requires**
`events` and refuses an empty list, and `update()` never sends `null` — an
endpoint that named no events would be subscribed to every event type the
platform ever adds. Both are compile errors rather than 422s, so a typed
caller finds out at build time; see [Webhook endpoints](#webhook-endpoints).
Nothing else in 0.8.0 changes an existing call — the rest is new: the
`client.pbx` surface and `client.customers`.

## Before you install 0.4.x

**0.2.x has no future.** It mints at `POST /v1/integration/token`, and that
endpoint is **deleted** on the platform — not deprecated, not serving out a
migration window. The day your provider ships that change, every 0.2.x call
fails at the token exchange. There is no version left to wait on.

**0.4.x needs a provider whose platform mints at `POST /oauth/token`.** Ask
your provider whether they have made that change.

This matters more than a version bump usually does, because an older platform
will not tell you no. That path already exists there, serving a different
population: it ignores `tenant` and `customer`, and answers **200** with a
token that carries no tenant at all. Nothing fails until you spend it, and then
every call is refused with a 403 that says nothing about the mint that caused
it. A version you cannot use looks exactly like a credential problem.

**Name your `tenant`.** It was optional in 0.3.0 and is required now, in the
type and at construction — see below for what changed and why.

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
`POST /v1/phone-numbers/{id}/routing` with `target_type: fax`, through
`client.request()`. `numbers()` reads back what is pointed at this account —
all of them, walking the pages for you, because a half-list of a fax
account's numbers looks exactly like a full one.

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
  `event_id`, because a retry carries the same one.

`verifyWebhook()` returns nothing and throws `SignatureVerificationError` on
any failure — a stale timestamp, the wrong secret, a malformed header, or no
header at all. That last one includes whatever your framework hands over when
the header is absent (`undefined`, `null`) or arrived twice (a `string[]`), so
the one `catch` above is enough to answer 400 and never 500.
During a secret rotation the header carries two signatures and either secret
verifies, so a rotation costs you no deliveries.

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
`client.pbx.callRecords.list({ customer })`, `pbx.users.list` and
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

## Call records, users, devices and click-to-dial

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
  console.log(call.startedAt, call.fromUri, call.toUser, call.duration);
}
```

**Name a date range unless you mean the last two months.** The phone system
keeps one table per month, and your range picks which of them are opened at
all — so with no range you get the current month and the previous one, not
everything. A range wider than 13 months is refused with a 400.

**A record the phone system hides is left out of the list and served by
`get()`.** That asymmetry is its own portal's, not ours. Pass
`includeHidden: true` to put them back into a listing.

`direction` is `inbound`, `outbound` or `on-net`; a word outside those is a
400 rather than an empty page. On a record you read back, though, `direction`
and `disposition` are both plain strings — the switch records one integer
carrying the pair, and one it has no word for arrives as its own digits.
Compare against the values you know rather than assuming there are no others.

### Recordings and transcripts

```ts
for (const recording of await client.pbx.callRecords.recordings(call.id)) {
  console.log(recording.id, recording.duration, recording.contentUrl);
}

for (const transcript of await client.pbx.callRecords.transcripts(call.id)) {
  console.log(transcript.id, transcript.status); // "ready" or "pending"
}
```

Both answer every **capture** of one call — a call can have more than one,
because the phone system's own capture id is `(call id, ccc id)` — and
neither is paginated: this is the captures of one call, bounded by its two
legs, never a walk over a growing table, so there is no `after`/`before`
cursor and nothing beyond the array you get back.

`recording.contentUrl` and `transcript.contentUrl` are signed, time-limited
links minted fresh on every call. Do not cache one past its `expiresAt` or
hand it to anyone else — whoever holds the URL can fetch that document with
no further authorization.

`transcripts()` answers one item per **recording**, not one per transcript
that exists: a capture with no words yet still appears here, as a
`Transcript` with `status: "pending"` and every other field `null`, so you
can tell "no transcript yet" from "no recording at all". Needs
`pbx-call-records:read` to fetch the call at all, and `pbx-transcripts:read`
— a separate grant, because the words of a call are searchable and cheap to
mine at scale in a way the call log itself is not — to see whether anyone
spoke.

### Who is on the phone system, and what is registered

```ts
const people = await client.pbx.users.list({ customer: clinic, search: "perkins" });
for (const person of people.users) {
  console.log(person.user, person.displayName, person.email);
}

const [person] = people.users;
if (person) {
  const phones = await client.pbx.devices.list({ user: person.id, registered: true });
  for (const phone of phones.devices) {
    console.log(phone.aor, phone.userAgent, phone.registrationExpiresAt);
  }
}
```

`search` is the directory box — one substring across the display name, both
halves of the person's name and the extension. `user` on `pbx.users` is the
exact EXTENSION instead, and `101` does not match `1010`; `user` on
`pbx.devices` is a **users id**, not an extension.

**A device is one REGISTRATION, not one handset.** The row exists because
something sent a SIP REGISTER and it disappears when nothing does, so an
unplugged phone leaves no device at all and a phone that registered twice
leaves two. `registered: false` asks for the expired ones.

**A PBX user's and a device's timestamps are strings, not `Date`s** — the
only ones in this package that are. They come straight out of the phone
system, which has never published the format it writes them in, so the API
serves them unparsed and so do we: a date a year out would read exactly like
a date that is right. A call record's `startedAt`, `answeredAt` and
`releasedAt` ARE `Date`s, because those the switch stores as epochs.

### Asking somebody's phone to dial

```ts
const call = await client.pbx.users.call(personId, {
  destination: "+13025556789",
  callerId: "+14075550101",
});

console.log(call.id, call.status); // 0198c4a1-… requested
```

The platform has that subscriber's phone place the call to `destination`, so
the call goes out as them rather than as you. `autoAnswer: true` asks their
device to answer automatically where it supports that, and `device` says
which of their registrations to place it from.

**The 202 is not a call that happened.** It comes back the moment the
platform has accepted the request, so `status` is `requested` and nothing on
it says how the call went. `call.id` is the id the request was placed under,
and it finds the call record once the call has ended — see
[Finding the call a click-to-dial became](#finding-the-call-a-click-to-dial-became).

**There is no cancel, and this is not undoable.** Once the request is
accepted, the call is out of your hands.

**Do not retry this blindly — there is no idempotency key, and a retry is a
second phone call to a real person.**

The device must be that subscriber's own — one that is not is refused with a
422, whether it belongs to somebody else or does not exist, and nothing is
dialled. The pointer is `/data/attributes/device`. The check covers a user of
the same name on another domain, which is the case that would otherwise reach
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
const call = await client.pbx.users.call(personId, { destination: "+13025556789" });

// Later, once the call has ended — and inside the date range, see below:
const records = await client.pbx.callRecords.list({ callId: call.id });
for (const record of records.callRecords) {
  console.log(record.disposition, record.talkTime);
}
```

`callId` takes the `id` that `users.call()` returned. The record appears once
the call has ended.

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
| `client.pbx.callRecords.list({ customer?, startedAfter?, startedBefore?, direction?, user?, callId?, includeHidden?, after?, before?, pageSize? })` | `pbx-call-records:read` | A `CallRecordPage`: `callRecords` plus `nextCursor`. The date range picks which months are read. `callId` finds what a click-to-dial became. |
| `client.pbx.callRecords.get(callRecordId)` | `pbx-call-records:read` | One `CallRecord`. Serves a hidden record, which the list leaves out. |
| `client.pbx.callRecords.recordings(callRecordId)` | `pbx-call-records:read` | Every capture of that call, as a plain `readonly Recording[]` — NOT paginated: this is the captures of one call, not a walk over a table. Each `Recording.contentUrl` is a freshly minted, short-lived link. |
| `client.pbx.callRecords.transcripts(callRecordId)` | `pbx-call-records:read` + `pbx-transcripts:read` | One `Transcript` per capture — `status: "pending"` and every other field `null` for one with no words yet. Also NOT paginated. |
| `client.pbx.users.list({ customer?, user?, search?, after?, before?, pageSize? })` | `pbx-users:read` | A `PbxUserPage`: `users` plus `nextCursor`. `user` is the exact extension; `search` is the directory box. |
| `client.pbx.users.get(pbxUserId)` | `pbx-users:read` | One `PbxUser`. Its `createdAt`/`updatedAt` are strings, not `Date`s. |
| `client.pbx.users.call(pbxUserId, { destination, callerId?, autoAnswer?, device? })` | `pbx-calls:write` | Have that subscriber's phone place a call. Resolves to a `PbxCall` — an intent, not a call that happened. No idempotency key. |
| `client.pbx.devices.list({ customer?, user?, registered?, after?, before?, pageSize? })` | `pbx-users:read` | A `PbxDevicePage`: `devices` plus `nextCursor`. `user` is a users id, not an extension. |
| `client.pbx.devices.get(pbxDeviceId)` | `pbx-users:read` | One `PbxDevice` — one registration, not one handset. |
| `client.request(request)` | — | Any endpoint this client does not wrap yet, with your credential. |
| `verifyWebhook(payload, header, secret, { toleranceSeconds?, now? })` | — | Throws unless the body is genuine and fresh. |

`CallRecord`, `CallRecordPage`, `Customer`, `CustomerPage`, `Fax`,
`FaxAccount`, `FaxAccountNumber`, `FaxAccountPage`, `FaxAccountUser`,
`FaxAccountUserPage`, `FaxDocument`, `FaxPage`, `MediaLink`, `PbxCall`,
`PbxDevice`, `PbxDevicePage`, `PbxUser`, `PbxUserPage`, `Recording`,
`Transcript`, `WebhookDelivery`, `WebhookDeliveryPage`, `WebhookEndpoint` and
`WebhookEndpointPage` are frozen plain objects, and each keeps the JSON it was
built from in `.raw` — so a member the API adds after this release reaches
you without a new SDK. A member the API did not send reads `null`.

The whole endpoint surface is typed from the OpenAPI document at
`src/_generated/schema.d.ts`. Those types are private: they are regenerated
wholesale by `scripts/generate.sh`, and none of them is published in this
package's own types.

## Licence

MIT.
