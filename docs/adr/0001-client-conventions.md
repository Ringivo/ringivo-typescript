# ADR-0001: Client conventions — retries, errors, pages and per-call options

- Status: Accepted
- Date: 2026-11-02

## Context

Before 0.26.0 this package was careful about the API's own rules — no
default host, the scope and tenant gates, idempotency keys on the writes that
take them, a typed error with the API's error objects — but it differed from
the conventions most TypeScript API clients share. It did not retry, it named
the items of every list differently (`page.faxes`, `page.accounts`,
`page.grants`, …), it offered no way to walk a list except by hand, it let
transport errors through unwrapped, and its methods took no per-call options.
It also kept the client secret and the live bearer token on ordinary
properties, so `console.log(client)` printed both.

Nobody had built on the package yet, and `0.y.z` allows breaking changes
("Major version zero (0.y.z) is for initial development. Anything MAY change at
any time." — [semver §4](https://semver.org/#spec-item-4)), so this was the
moment to change shape.

## What the reference clients do

Read from source, not from their docs. Commits: openai-node `e572875`,
anthropic-sdk-typescript `ea8d7de`, stripe-node `6d5ed96` (all read
2026-11-02).

| Concern | openai-node / anthropic (Stainless-generated) | stripe-node | Elsewhere |
|---|---|---|---|
| Retries | `maxRetries` default **2** (`client.ts`: `options.maxRetries ?? 2` in anthropic; openai the same). Retries 408, 409, 429, ≥500 and connection errors; obeys `x-should-retry`. | `maxNetworkRetries` default **2** (`PlatformFunctions.getDefaultMaxNetworkRetries`). Retries connection errors, 409, ≥500; obeys `Stripe-Should-Retry`. | Stainless: "retries for connection errors, 408 timeouts, 429 rate limits, and 5xx server errors with exponential backoff" ([blog](https://www.stainless.com/blog/how-to-generate-a-typescript-sdk-from-your-openapi-spec)). Speakeasy: retries optional, configured per operation ([methodology](https://www.speakeasy.com/docs/sdks/languages/typescript/methodology-ts.md)). |
| Backoff | 0.5 s doubling to 8 s, up to 25 % jitter (`calculateDefaultRetryTimeoutMillis`); `Retry-After` and `retry-after-ms` honoured when 0–60 s, the default backoff otherwise. | exponential from a base delay, jitter between half and full, never under the base (`_getSleepTimeInMS`). | `Retry-After` is seconds or an HTTP-date ([RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)). |
| Idempotency | an `Idempotency-Key` generated for every non-GET when the API declares one (`defaultIdempotencyKey`), the same on every retry. | `Idempotency-Key` generated for every POST (`_defaultIdempotencyKey`), so a retry is deduplicated. | [IETF draft: the Idempotency-Key header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/). |
| Errors | one class per status: `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`, `RateLimitError`, `InternalServerError`, plus `APIConnectionError`, `APIConnectionTimeoutError`, `APIUserAbortError` (`core/error.ts`); `requestID` from `x-request-id`. | `StripeCardError`, `StripeInvalidRequestError`, … by error type. | — |
| Lists | `list()` answers a `PagePromise`: `await` for a page, `for await` for every item; `page.data`, `hasNextPage()`, `getNextPage()`, `iterPages()` (`core/pagination.ts`). | `for await (const c of stripe.customers.list())`, plus `autoPagingEach` / `autoPagingToArray` (README). | Stainless docs: "use the `for await … of` syntax to iterate through items across all pages". |
| Per-call options | a last `options` argument: `timeout`, `maxRetries`, `signal`, `headers`, `idempotencyKey`, `fetchOptions`; it overrides the client's. | a last options argument: `idempotencyKey`, `maxNetworkRetries`, `timeout`, `stripeAccount`. | Stainless: "Request-specific options override client options." |
| Transport | `fetch` injectable (`fetch`, `fetchOptions`); `defaultHeaders`. | `httpClient` injectable. | Speakeasy: "We use the `fetch()` API as our HTTP client", runs on Node, Bun, Deno, browsers. |
| Packaging | dual ESM/CJS through `exports`. `engines`: openai `>=22`; stripe `>=20`. | | Node: `"types"` first in an `exports` condition object, `"default"` last ([Node packages](https://nodejs.org/api/packages.html)). TypeScript: a library checks itself with Node-style resolution unless it is bundled, and should be checked with Are the Types Wrong before publish ([handbook](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)). Node 20 left support on 2026-04-30; 22 and 24 are the LTS lines ([schedule](https://github.com/nodejs/Release/blob/main/schedule.json)). |

## Decision

1. **Retry by default, 2 more times, and only what is safe to send twice.**
   Reads, DELETEs, the PATCH updates (setting a value twice leaves the same
   value), and a write that carries an `Idempotency-Key` the endpoint honours
   (`faxes.send()`, `pbx.subscribers.call()`). Never a POST without a key:
   unlike the Stainless and Stripe clients, this package cannot generate a key
   for every POST, because most of this API's POSTs do not read one, and a key
   the server ignores makes a retry a second create. Transient answers only:
   no answer, a timeout, 408, 429, 5xx, and the 409
   `idempotency_key_in_use` — not every 409, because on this API a 409 is a
   state that answers the same next time. Wait the server's `Retry-After` when
   it is 60 s or less; a longer one (a daily cap) is thrown at once with
   `retryAfter` — where openai-node retries on its own backoff instead, because
   on this API a long `Retry-After` names a quota reset, and a retry seconds
   later is refused again. Otherwise 0.5 s doubling to 8 s, less up to 25 % jitter. The
   one-time token refresh after a 401 is separate and does not count.
2. **One error class per status**, with the Stainless names, all `ApiError`s;
   the classes a `code` earns (`TranscriptionCappedError`, …) extend their
   status's class. No answer is `ApiConnectionError` / `ApiTimeoutError`; an
   aborted signal is `RequestAbortedError`. `ApiError.headers` carries the
   response headers.
3. **One `Page<T>` for every list**: `data`, `nextCursor`, `nextUrl`, `total`,
   `raw`, `hasNextPage()`, `getNextPage()`, `iterPages()`, and
   `[Symbol.asyncIterator]`. `list()` answers a `PagePromise` — a real
   `Promise` that is also async-iterable. A list asked for with `before` (the
   polling read) is one page.
4. **A last `RequestOptions` argument on every method** — `timeoutMs`,
   `maxRetries`, `signal`, `headers` — and client options `fetch`,
   `defaultHeaders`, `maxRetries`. Header precedence, lowest first: the
   client's `defaultHeaders`, the method's own (its `Accept` and
   `Content-Type`), the call's `headers`, then this package's `User-Agent`
   and `Authorization`. An `Idempotency-Key` in a call's `headers` makes that
   call resendable; one in `defaultHeaders` does not.
5. **No credential on a property.** The secret and the token live in
   `#private` fields and a module-private `WeakMap`; both classes define
   `util.inspect.custom`.
6. **Hand-written over generated, kept.** The generated types check every
   path and body at compile time, and nothing generated crosses the public
   boundary (see `src/models.ts`). A full generator (Stainless, Speakeasy)
   would give the conventions above for free, but not this API's grey-label
   and scope rules, or the hand-written documentation of every refusal.
7. **Every operation a client credential can make has a named method**
   (added 0.27.0). `client.request()` is the escape hatch for an operation
   the API adds before a release names it, never the documented way to reach
   one. An operation has no method for one of three written reasons only: the
   API takes a person's token for it and refuses a client credential (port
   order writes, buying numbers, a text-messaging create); it is the bytes
   behind a signed link, followed by a named method (`faxes.media()`,
   `faxes.thumbnail()`, `inboundMessages.downloadMedia()`,
   `pbx.callRecords.downloadRecording()`); or it is the token mint.
   `tests/coverage.test.ts` holds the table, exact both ways against the
   vendored spec, looks each method up on a real client, and checks each
   `PAT` exclusion against the operation's `security` in the spec.

   **When the API gains an operation, the spec sync stops landing — on
   purpose.** The upstream spec-sync job force-pushes the rolling `spec-sync`
   branch with the new spec and regenerated code; this gate then fails on that
   branch, so `spec-sync-land.yml` (which lands only a green ci) leaves it
   open. A fix pushed onto `spec-sync` is wiped by the next sync, so the
   procedure is a separate pull request:
   1. Branch from `main`. Copy the API description at the revision the
      rolling pull request names into `spec/openapi.yaml`, and run
      `npm run generate`.
   2. Add the method (or a written exclusion), its row in the coverage table,
      wire tests, and the README and CHANGELOG lines.
   3. Merge it. The next spec sync then finds `main` already carries that
      revision and either closes with no change or lands green. Until then the
      red rolling pull request is expected, not a fault.
   The same procedure covers an operation that changes shape.

## Alternatives rejected

- **No retries (the old behaviour), leaving it to the caller's queue.** Every
  reference client retries by default, so an integrator expects it, and a
  short in-call retry of a 503 or a dropped connection is what a queue would
  do first anyway. `maxRetries: 0` restores the old behaviour.
- **Generate an `Idempotency-Key` for every POST**, as Stainless and Stripe do.
  Safe only when the server reads the key; most of this API's POSTs do not.
- **Keep the per-resource item names** (`page.faxes`). They read well in one
  place and make every generic helper a lookup table.

## Gaps found, ranked, and where each stands

| # | Gap | Severity | State |
|---|---|---|---|
| 1 | `console.log(client)` printed the client secret and the bearer token | High | Fixed (0.26.0); `tests/secrets.test.ts` reads the built bundle too |
| 2 | No customer create, update, delete, phone system enable/remove; no phone-number reads or verbs; no regions | High | Fixed (0.26.0) |
| 3 | No automatic retries or backoff | High | Fixed, safe requests only (decision 1) |
| 4 | No `for await` over a list; a different item name on every page | Medium | Fixed (decision 3) |
| 5 | Errors not typed by status; transport failures unwrapped | Medium | Fixed (decision 2) |
| 6 | No per-call `signal`, `timeoutMs`, `maxRetries`, `headers` | Medium | Fixed (decision 4) |
| 7 | No injectable `fetch`, no `defaultHeaders` | Medium | Fixed |
| 8 | Open string types for region, transport, provisioning state | Low | Fixed on `Customer` and the new inputs (open unions) |
| 9 | Package described as a fax client; no package lint in CI | Low | Fixed; `publint --strict` runs in CI |
| 10 | Node 20 is past end of life | Low | Open: `engines` still `>=20`; Node 24 runs in CI. Dropping 20 means replacing the required `test-node20` check in the branch ruleset |
| 11 | The API takes no `Idempotency-Key` on a customer create, so a create cannot be retried safely | Medium | Open, an API change; the client sends a create once |
| 12 | No request id on responses, so an error cannot name the request for support (the reference clients expose `x-request-id`) | Low | Open, an API change; `ApiError.headers` will carry one when the API sends it |
| 13 | No raw-response accessor (`withResponse()`) | Low | Open; `client.request()` is the escape hatch |
| 14 | No check of how each module mode resolves the types | Low | Fixed: Are the Types Wrong 0.18.5 (`--pack .`) is green for node10, node16 CJS and ESM, and bundler, and runs in CI beside publint |
| 15 | `sort` reachable on no list, though the API sorts most of them | Low | Fixed: every list that the API sorts takes `sort`; the PBX lists take their exact values |

## Consequences

- 0.26.0 is a breaking release; CHANGELOG.md lists each change and its
  migration.
- A retry policy is now part of the contract: a new write that honours an
  `Idempotency-Key` must send one to be retried, and a new non-idempotent
  write must not be marked resendable.
