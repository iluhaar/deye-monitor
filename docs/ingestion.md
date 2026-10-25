# Finite request-driven ingestion

The ingestion program is implemented independently of HTTP authorization and
scheduling. No Worker entrypoint invokes it yet. There is no refresh endpoint,
Cron trigger, production deployment, or approved Deye grid classifier.

## Composition

`server/src/runtime/ingestion.ts` exports `ingestionLayer`, an opt-in Effect
Layer for `PollingService`. It composes:

1. The configured raw, read-only Deye adapter, including bounded token handling.
2. `NormalizedLive`, which uses the configured upstream device, not the internal
   station ID, and applies the existing conservative normalizer.
3. `IngestionStorage` backed by D1 and the durable refresh guard.
4. A finite `PollingService.refresh(internalStationId)` invocation.

Construction performs no network I/O. Callers must provide the real regional
configuration and secrets out of source control, an existing internal station
row, all three D1 migrations, explicit timing/throttle policy, and a freshness
threshold. The eventual protected refresh handler is responsible for these
bindings. GET routes remain D1-only and never perform upstream requests.

The timing policy reserves a bounded acquisition interval, a finite work budget,
failure-recording time, and bounded best-effort release. The lease must exceed
the workflow budget plus twice the finalization budget to cover acquisition
response delay and release. The core work timeout includes upstream auth/data
requests, their retries/backoff, validation, and persistence. If the configured
budget is insufficient, collection times out safely; it does not extend the
lease. Storage assertions reject any expired/stale owner's late work.

No polling cadence or quota is inferred from these technical budgets. Live
account limits remain a separate activation check.

## Storage and outcomes

- First confirmed observations establish `grid_context` without an event.
- Subsequent fresh, verified changes create one event. Same-state observations
  advance the prior confirmed time without emitting another event.
- Unknown/unverified and newer stale observations may replace the latest
  snapshot, but never replace confirmed context or emit grid events. They mark
  an existing confirmed context with the first detected gap time.
- Equal/backward source times preserve the snapshot and confirmed observation.
  They record a replay/backward poll outcome and mark a gap, not an outage.
- Missing, invalid, inconsistent or future timestamps preserve the snapshot and
  record an unavailable poll. No untrusted source timestamp is persisted.
- Auth/rate-limit/payload/transport/timeouts preserve the snapshot, record only a
  sanitized failure category, and mark an existing context's gap.
- A later confirmed change across a gap records the new source observation time,
  previous confirmed observation time, and `gap_since`. These are bounds/context,
  not a claim about when physical switching occurred. Returning to the same
  confirmed status clears the gap without inventing a restoration event.

Observation commits atomically update snapshot, poll run, optional event,
confirmed context and guard watermark. Failure/replay metadata has a separate
fenced batch and cannot update observations. A station/epoch poll window makes
failure recording idempotent. If a timed-out database batch already committed,
failure metadata does not overwrite that successful poll or mark a false gap.
If its outcome is uncertain, the caller must not claim that no commit occurred;
the next source replay cannot duplicate a transition.

New poll rows retain a fencing epoch, outcome, safe error category, source time,
observation identity, start/completion times and latency. No token, serial,
credential, raw response or upstream exception text is stored or logged.

## Read-side failure semantics

The D1 read layer derives internal collection availability from the most recent
fenced poll. After an error/unavailable collection, effective grid state becomes
`unknown` and freshness is `unavailable`, while measurement/fetch timestamps,
values and source age remain those of the stored observation. Successful later
collection restores ordinary freshness evaluation. This internal flag is not
added to public response contracts, and reads do not mutate storage.

Retention must preserve each station's latest poll (or an equivalent durable
collection outcome), guard watermark/epoch and confirmed context. Deleting these
indiscriminately can reset failure, replay or transition history semantics.

## Verification and boundary

`server/test/ingestion.test.ts` runs against Workers-runtime D1 with real
migrations. It covers synthetic online/offline changes, gaps, replay, missing and
future time, stale readings, auth/unavailability, cancellation, contention,
lease loss, SQL rollback, replacement Effect Layers, authenticated stored-data
reads, and full adapter → normalizer → ingestion → D1 composition using fake
HTTP. The live Deye normalizer remains unknown/unverified with null directional
power; synthetic confirmed tests do not validate a production mapping.

Deployment, live upstream verification, stronger manual-refresh authorization,
HTTP throttle responses and release scenarios remain separate work.
