# Release notes

## Unreleased — Added

- **Download the media of a received MMS.** Each media item of
  `inboundMessages.list()` and `get()` now has `contentUrl` (a string or
  `null`) and `expiresAt` (a `Date` or `null`). `contentUrl` is a signed
  link on your API host that downloads the file with no `Authorization`
  header, until `expiresAt` (five minutes). Every read makes new links. Both
  are `null` when the platform holds no file: the number is not connected to
  your phone system, the item is the message's text, the platform did not
  keep the file (for example, it is larger than 10 MB), or, for a
  customer-scoped credential, the file was kept for another customer or for
  your pool. `filename` is sender input: clean it before you use it as a
  file path.
- **`inboundMessages.downloadMedia(item)`** follows `contentUrl` and
  resolves to the bytes as a `Uint8Array`. It uses the same path as
  `faxes.media()`, so it never sends the bearer token. An item whose
  `contentUrl` is `null` is refused with an `Error` before any request. An
  expired or changed link is an `ApiError` with status 403 (read the message
  again for a fresh link), a file the platform no longer holds is a 404
  `not_found`, and too many downloads is a 429 with `retryAfter`. Downloads
  count against the API rate limit, 60 requests a minute from one client
  address; for a client credential, that limit is shared with your other
  API calls.
- **New type `InboundMessageMediaWithLink`**: the API's media item.
  `InboundMessage.media` now holds these. It extends
  `InboundMessageMediaItem`, which stays the `message.received` webhook's
  item, with no link. Code typed against `InboundMessageMediaItem` reads the
  new items unchanged. Migration: none, unless you build `InboundMessage`
  objects yourself; add `contentUrl: null, expiresAt: null` to each media
  item. The webhook's items do not change: to download a file, read the
  message with `inboundMessages.get(event.message.id)`.
- **The API now narrows a customer-scoped credential's reads.** In the same
  API release, `inboundMessages.list()` and `get()` with a customer-scoped
  credential return only the messages sent to numbers assigned to that
  customer. Before, they returned every message of the reseller. This is a
  server change; this client needs no change for it.
- **`webhookEndpoints.sendTest(id, { type? })` sends one test event to one
  endpoint.** It goes through the same path as a real delivery — the same
  signature, headers and addresses — once, with no retry. `type` is a type
  the endpoint may receive, or `webhook.test` for a plain ping; left out,
  the API sends the endpoint's first type; an empty or blank `type` is
  refused before any request. It resolves to a
  `WebhookTestDelivery`, normally `pending`. A 202 that is already `failed`
  means the test could not be queued. The refusals are `ApiError`s: 409 for
  a disabled endpoint, 422 for a type the endpoint may not receive
  (`source.pointer` `/eventType`), 429 past 5 tests a minute to one endpoint
  or from one account (or the API's own rate limit), and 503 when the API
  could not check that limit.
  The 429 and the 503 carry `retryAfter`, and `isRetryable()` is `true` for
  them. The call sends no `Idempotency-Key` and never sends a test again by
  itself: every send is a new test.
- **`client.webhookTestDeliveries`**: `get(id)` reads one test's result and
  `list({ endpoint?, ids?, after?, before?, pageSize? })` lists the results
  of the last 7 days. `WebhookTestDelivery` carries `status` (`pending`,
  `delivered` or `failed`), `statusCode`, `durationMs`, the first 1 KiB of
  your server's answer as `responseBody`, `error`, `attemptedAt` and the
  `endpointId`, which the API sends on every result.
- **`webhookTestDeliveries.wait(test, { intervalMs?, timeoutMs? })`** reads
  a result again until it is no longer `pending`, and resolves to it. A
  result that is already not `pending` comes back at once, with no read.
  It reads every 2 seconds for at most 150 seconds by default — longer than
  the 2 minutes after which the API marks a test with no result `failed`.
  Past `timeoutMs` it throws the new `WebhookTestTimeoutError`, whose
  `delivery` is the last result read. A 429 on a read with a `Retry-After`
  is waited out inside the deadline; any other refused read is thrown. The
  deadline is on the monotonic clock.
- **`test` on every `MessageEvent` variant.** `parseMessageEvent()` reads
  `test: true` when the body's `test` member is literally `true` — a test
  event sent with `sendTest()` — and `false` otherwise, on all four message
  variants and on `UnknownMessageEvent` (the `webhook.test` ping is one). A
  test carries the published example body for its type, so every id in it
  is illustrative: check `event.test` first and do not act on it. The parse
  still never throws.
- Migration: none. Every name is new; `MessageEvent` gains one member, so
  code that builds those objects itself must add `test`.

## 0.24.0 (2026-10-23) — Added

- **`pbx.subscribers.call()` sends an `Idempotency-Key`.** The API is about
  to require the header on click-to-dial and to refuse a call without it
  with a 400 `idempotency_key_required`. Versions before this one send no
  key, so their `call()` stops working when the API change ships. Pass
  `idempotencyKey` to retry a call whose answer you never saw: the same key
  with the same request returns the first call's 202, with the same id, and
  nothing is dialled. With no key, a fresh UUID is made for each call, and
  the client's own 401 retry sends that same key again. The same key with a
  different request is a 422 `idempotency_key_reused`; while the first
  request still runs it is a 409 `idempotency_key_in_use`. The Python client
  has the same change, as `idempotency_key=`.
- **`PbxCall.idempotentReplay`**: `true` when the API replayed an earlier
  call sent with the same key, and `false` for a call it accepted now. The
  body is the same either way, so this is the only way to tell them apart.
  Migration: none, unless you build `PbxCall` objects yourself; the member
  is new.

## 0.24.0 (2026-10-23) — Changed

- **`isRetryable()` is `true` for a 409 `idempotency_key_in_use`.** The API
  is about to answer that 409 when a request with the same
  `Idempotency-Key` still runs. Its contract is to send the same request
  again, WITH THE SAME KEY, after `retryAfter`; a new key could send the fax
  or ring the phone twice. Every other 409 stays `false`. The Python client
  changes in the same way. Migration: a queue that gave up on every 409 now
  retries this one; keep the key with the queued job.
- **An empty `idempotencyKey` is sent as given** — no change in this client,
  now written down and tested for `faxes.send()` and
  `pbx.subscribers.call()`. Only an omitted key gets a fresh UUID. The API
  refuses a blank key with a 400 `idempotency_key_required`, so a retry key
  that came out blank fails loudly instead of becoming a new key that sends
  or dials again. The Python client now does the same (it used to replace
  `""` with a fresh UUID).
- **The `faxes.send()` docs name the API's new answers to a reused key**: a
  422 `idempotency_key_reused` for the same key with a different request,
  and a 409 `idempotency_key_in_use` while the first send still runs.

## 0.23.0 (2026-10-22) — Breaking

These removals are part of one clean breaking release (0.23.0). The package
no longer carries code for the API's v1 naming cleanup.

- **Filter-name bridge removed.** The client no longer retries a refused
  filter with the old snake_case name. List calls send the camelCase names
  only (`filter[faxAccount]`, `filter[createdAfter]`, and so on), once.
  Migration: none for calls through `client.faxes`, `client.webhookEndpoints`
  and the other namespaces; against an API from before the rename, stay on
  0.16.x.
- **Snake_case and kebab-case response members no longer read.** `Fax` from
  `send()` and `cancel()` reads `clientReference` and `createdAt` only;
  `MediaLink` reads `expiresAt` and `byteSize` only; `Recording` and
  `Transcript` read `byteSize`, `contentUrl` and `expiresAt` only (not the
  kebab-case `byte-size`, `content-url`, `expires-at`). Migration: none,
  unless you parse raw bodies yourself; read the camelCase keys.
- **`faxes.send({ coverPage })` takes camelCase keys only.** `to_name` and
  `from_name` are no longer renamed; they are sent as given. Migration: pass
  `toName` and `fromName`.
- **Messaging follows the API's new messaging contract, and needs it.**
  The messaging surface below is new in this release, so no code written
  against 0.16.x changes. The Python client changes in the same way, with the
  same names.

  **Use 0.23.0 only with an API that has the change.** Against an API from
  before the change (for example, after the API change is rolled back), the
  API refuses EVERY record with a 400, also a record with no media:
  `messages.record()` always sends `mediaUrls` (as `[]` when you give no
  links), and that API does not know the member.

  **A redelivered webhook keeps the values it was built with.** When the API
  delivers an event again, it sends the stored body unchanged. So an event
  built before the API change still carries the old values, and
  `parseMessageEvent()` reads them as follows (it never throws on them):
  - A media item with `bytes` and `encoding`: `size` is `null`; `bytes` and
    `encoding` stay on `raw`.
  - The cause `outcome_unknown` or `submission_interrupted`: `failureCause`
    is that plain string, not in `FAILURE_CAUSES`. Treat it as
    `send_interrupted`.
  - `providerPartIds: []`: `providerPartIds` is `[]`.

  What the new contract is:
  - Each media item is described by `contentType` and `size` (bytes), with
    no `encoding`. An item on a received message also has `filename`.
  - The failure cause `send_interrupted` replaces `outcome_unknown` and
    `submission_interrupted`: treat the text as not sent (rarely, it may
    still arrive).
  - `providerPartIds` is `null`, not `[]`, for a message the provider never
    accepted.
  - The record call fetches all media links at once, each within 10 seconds
    of the call, and the API ends any request at 30 seconds of its own time.
    `record()` waits at least 35 seconds (`RECORD_MIN_TIMEOUT_MS`): a
    5-second margin, because the client's clock starts first. The floor is
    the whole request; in the Python client it is the wait for the answer.
  - A media link that fails has its own `code`: 422 `media_rejected`, 504
    `media_timeout`, 502 `media_unreachable`, 503 `media_store_unavailable`.
    When the links pass 20 MB together, the 422 `media_rejected` points at
    the list, `/data/attributes/mediaUrls`, not at one link. The record no
    longer answers 404, or 429 for media in flight.

## 0.23.0 (2026-10-22) — Added

- **Text messaging, at parity with the Python SDK.**
  `client.messages.record()` records a text your own system already sent;
  `senderLabel()` makes any text a valid label.
  `client.inboundMessages.list()` and `get()` read the texts sent to your
  numbers. `parseMessageEvent()` reads `message.received`, `message.sent`,
  `message.delivered` and `message.failed` as a union told apart by `type`,
  and anything else as an `UnknownMessageEvent` (`type: null`); it never
  throws. Route by direction with `INBOUND_MESSAGE_EVENT_TYPES` and
  `OUTBOUND_MESSAGE_EVENT_TYPES`. Media items are described, never carried:
  `OutboundMessageMediaItem` (`contentType`, `size`) on a recorded or sent
  message, and `InboundMessageMediaItem` (`contentType`, `filename`, `size`)
  on a received one. `record()` waits at least 35 seconds
  (`RECORD_MIN_TIMEOUT_MS`), the API's own cut plus a margin. A media link that fails
  names itself in `errors[0].source.pointer` and the reason in `code`.
- **`isRetryable(error)`**: the API's retry contract (no answer, 408, 429,
  5xx).
- **`FailureCause` and `FAILURE_CAUSES`**: the seven `failure.cause` values
  the API documents for `message.failed`. `failureCause` still accepts any
  other string: more causes can be added.
- **`client.request(request, { timeoutMs })`**: a timeout for one request.

## 0.23.0 (2026-10-22) — Fixed

- **An id of `"."` or `".."` is refused before any request**, on every
  method that takes one, as an empty id already was. URL parsing resolves
  those dot segments, so `inboundMessages.get("..")` was sent as `GET /v1/`.
- **`messages.record()` refuses `https:example.com` and
  `https:\\example.com` locally**, as the Python client does. The URL parser
  read both as `https://example.com/`, and the API then refused the string as
  sent with a 422.

## Earlier upgrade notes

Moved here from the README unchanged, except that their links now point back at the README; each applies to the version named.

### 0.12.0: the API's v1 naming cleanup

The API renamed its last snake_case names on the resource surface to
camelCase, with no alias. The ones this client touches are four `faxes`
filters, the `faxAccountUsers` filter, two `webhookEndpoints` filters, the
`webhookDeliveries` filter, the send acknowledgement's `clientReference` and
`createdAt`, and the media link's `expiresAt` and `byteSize`. **Your code does
not change:** the options and fields already had these names.

**The compatibility code is gone** (see CHANGELOG.md). 0.12.x to 0.16.x
asked with the new filter names and, when an API from before the rename
refused them with a 400, asked once more with the old names; they also read
the old snake_case and kebab-case response members. This release sends and
reads the camelCase names only: an API from before the rename answers that
400 to you. `faxes.send()`'s `coverPage` takes `toName` and `fromName`; a
snake_case `to_name` is sent as given, not renamed. `raw` and anything you
read through `client.request()` carry whatever the API sent.

### 0.11.0

**0.11.0 breaks the whole `client.pbx` surface, on purpose.** The API renamed
it, and this release catches up in one step:

- **`pbx.users` is `pbx.subscribers`.** The API path `/v1/pbx/users` is gone,
  with no alias. `PbxUser`/`PbxUserPage`/`PbxUsers`/`ListPbxUsersOptions` are
  `PbxSubscriber`/`PbxSubscriberPage`/`PbxSubscribers`/
  `ListPbxSubscribersOptions`, and a page's rows are `page.subscribers`. The
  list now returns machines too — auto attendants, queues, AI agents — so a
  people-only list needs `{ kind: "user" }`. See
  [Who is on the phone system](https://github.com/Ringivo/ringivo-typescript/blob/main/README.md#who-is-on-the-phone-system-and-what-is-registered).
- **The links back to a subscriber moved:** `PbxDevice.pbxUserId` is
  `subscriberId`, `CallRecord.fromPbxUserId`/`toPbxUserId` are
  `fromSubscriberId`/`toSubscriberId`, and `user` on `devices.list()` and
  `callRecords.list()` is `subscriber`. `user` on `subscribers.list()` is still
  the extension.
- **`CallRecord` is the API's one clean shape.** `vendorType`, `fromUser`,
  `fromUri`, `toUser`, `toUri`, `dialed`, `byUser`, `termUser`, `tag`,
  `duration` and `talkTime` are gone. It now carries `fromNumber`, `toNumber`
  and `dialedNumber` (E.164 or `null`), `fromExtension`, `routedByExtension`,
  `answeringExtension`, `durationSeconds`, `talkSeconds`, `releaseCode`,
  `releaseText`, `tenantId` and `territory`, plus an extended tier you ask for
  with `fields`. See [Call records](https://github.com/Ringivo/ringivo-typescript/blob/main/README.md#call-records-subscribers-devices-and-click-to-dial).
- **The `direction` filter word `on-net` is `internal`** (a call that stayed
  inside one domain).
- **The wire moved to camelCase.** 0.10.x read the old kebab-case member
  names, which the current API no longer sends. Nothing to change in your code
  for this one beyond the renames above.

The scopes are unchanged: `pbx-users:read` still covers subscribers and their
devices.

### 0.8.0

**0.8.0 carries a webhook break you did not ask for.** It is the release that
first ships a change to `client.webhookEndpoints`: `create()` now **requires**
`events` and refuses an empty list, and `update()` never sends `null` — an
endpoint that named no events would be subscribed to every event type the
platform ever adds. Both are compile errors rather than 422s, so a typed
caller finds out at build time; see [Webhook endpoints](https://github.com/Ringivo/ringivo-typescript/blob/main/README.md#webhook-endpoints).
Nothing else in 0.8.0 changes an existing call — the rest is new: the
`client.pbx` surface and `client.customers`.

### 0.4.x

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
type and at construction — see "Your base URL, your tenant, your scopes" in the README for what changed and why.
