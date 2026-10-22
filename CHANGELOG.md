# Release notes

## Unreleased — Breaking

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

## Unreleased — Added

- **Text messaging, at parity with the Python SDK.**
  `client.messages.record()` records a text your own system already sent;
  `senderLabel()` makes any text a valid label.
  `client.inboundMessages.list()` and `get()` read the texts sent to your
  numbers. `parseMessageEvent()` reads `message.received`, `message.sent`,
  `message.delivered` and `message.failed` as a union told apart by `type`,
  and anything else as an `UnknownMessageEvent` (`type: null`); it never
  throws. Route by direction with `INBOUND_MESSAGE_EVENT_TYPES` and
  `OUTBOUND_MESSAGE_EVENT_TYPES`.
- **`isRetryable(error)`**: the API's retry contract (no answer, 408, 429,
  5xx).
- **`FailureCause` and `FAILURE_CAUSES`**: the eight `failure.cause` values
  the API documents for `message.failed`. `failureCause` still accepts any
  other string: more causes can be added.
- **`client.request(request, { timeoutMs })`**: a timeout for one request.

## Unreleased — Fixed

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
