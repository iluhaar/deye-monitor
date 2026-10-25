# Read-only Deye adapter

The adapter is an upstream-specific, read-only boundary for Deye's
`device/latest` response. `server/src/deye` exports `DeyeRawService` and
`makeDeyeLayer`; the raw service returns a sanitized `DeyeLatest` result and
does not expose access or refresh tokens. Normalization remains a separate
domain step.

## Configuration

`DeyeConfig.baseUrl` must be an explicitly configured HTTPS host for the
account's Deye region. There is no default or inferred regional host. Supply
credentials explicitly from secret storage; do not put secret values in source,
fixtures, or this document. The API contract expects `passwordHash` (or the
equivalent `password` field) to be the lowercase SHA-256 password digest, not a
plaintext password. Configure exactly one identity: `email`, `username`, or
`mobile` with `countryCode`.

The following is a typed shape using placeholders for deployment-provided
secrets and configuration, not environment binding names or usable values:

```ts
import type { DeyeConfig } from "../server/src/deye"

const config = {
  baseUrl: configuredRegionalHttpsHost,
  credentials: {
    appId: configuredAppIdSecret,
    appSecret: configuredAppSecret,
    passwordHash: configuredLowercaseSha256PasswordHashSecret,
    email: configuredIdentitySecret,
  },
  latest: {
    deviceSn: configuredDeviceSn,
    deviceType: "INVERTER",
  },
} satisfies DeyeConfig
```

`deviceSn` is the upstream device serial. It is distinct from the internal
`stationId`, which is supplied to normalization and is the server's key.

## Construction and composition

Constructing `makeDeyeLayer(config)` only validates configuration and creates
closures; it does not authenticate or make a network request. A token cache is
scoped to that finite layer/service instance. Create and provide the layer for
one bounded invocation; do not retain or globally reuse the layer or
`DeyeRawService` across invocations.

The offline composition is a raw service result followed by the pure
normalizer. The caller supplies both `fetchedAt` and `nowMs`:

```ts
import { Effect } from "effect"
import { DeyeRawService, makeDeyeLayer } from "../server/src/deye"
import { normalizeDeyeDeviceLatest } from "../server/src/domain/normalization"

declare const internalStationId: string
declare const request: { deviceSn: string; deviceType?: string }
declare const nowMs: number

const readAndNormalize = Effect.gen(function* () {
  const raw = yield* DeyeRawService
  const latest = yield* raw.readLatest(request)

  return normalizeDeyeDeviceLatest(latest, {
    stationId: internalStationId,
    fetchedAt: latest.fetchedAt,
    nowMs,
  })
})

const oneInvocation = Effect.provide(
  readAndNormalize,
  makeDeyeLayer(config),
)
```

Executing the composed effect is the point at which upstream I/O may occur;
layer construction and normalization do not perform live I/O. Offline tests
can provide a deterministic `DeyeRuntime.fetch` implementation instead.

No upstream token-refresh endpoint is assumed: reauthentication uses token
issuance. Token reauthentication is bounded,
and request retries are bounded by the configured `maxRetries`,
`retryBaseDelayMs`, and `retryMaxDelayMs` values; neither path should become an
unbounded loop.

Each read propagates Effect interruption to the in-flight fetch and retry
backoff. Shared authentication is reference-counted: canceling one read does
not abort another active read, while an authentication request with no active
consumers is aborted and cannot populate the token cache. Discarded response
bodies are canceled without waiting on upstream stream cleanup.

## Current boundary and validation gates

- The current mapping retains measured voltage and frequency, nullable missing
  fields, and separate upstream source time (`collectionTime`/`measuredAt`)
  from server fetch time (`fetchedAt`). Grid status remains `unknown` and
  unverified, battery mode remains `unknown`, and power sign semantics are not
  approved.
- The adapter composes with finite ingestion and fenced D1 persistence through
  the opt-in [manual refresh endpoint](./manual-refresh.md). GET routes remain
  D1-only; Cron and live activation are not enabled by default.
- Before enabling live reads, validate account/region and HTTPS hostname
  configuration, token expiry and lifecycle behavior with live checks, polling
  cadence and quotas, and freshness safety. Unverified live reads may retain
  `unknown`/`null` values.
- Grid classification and power-sign semantics are separate mapping gates:
  confirmed grid states and directional power are allowed only after a
  separately approved mapping. This document does not claim deployment or
  production readiness for the offline adapter/tests.
