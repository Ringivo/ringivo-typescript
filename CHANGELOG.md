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
- **`client.request(request, { timeoutMs })`**: a timeout for one request.
