# Durable refresh write boundary

`server/src/storage/RefreshGuard.ts` provides the D1 protocol used by future
finite ingestion. It does not enable refresh, call Deye, or change GET routes.
Apply migrations in order; `0002_refresh_protocol.sql` extends the reserved
guard without dropping existing rows.

## Acquisition and timing

- The internal station must already exist. The operation is fixed to `telemetry`.
- Acquisition is one conditional UPSERT using the database clock, a random
  owner nonce and an increasing fencing epoch. Takeover requires both the old
  lease and the persisted minimum interval to have expired.
- The caller supplies positive, bounded workflow, lease and minimum-interval
  budgets. The lease must exceed the workflow budget. Ingestion must enforce an
  outer finite timeout covering authentication, all upstream attempts/backoff,
  normalization and storage, and reserve time for finalization. Do not derive
  the lease from a single HTTP timeout. No live quota/cadence is implied by test
  policy values.
- There is deliberately no renewal. A worker exceeding its budget must abandon
  its result. Expiry/takeover never permits that worker to write or release a
  newer owner's lease.
- Release retains the epoch, throttle and observation watermark. Failed attempts
  consume the minimum interval too. Busy/throttled acquisition returns a bounded
  retry delay for the eventual HTTP boundary; it must not trigger upstream calls.

## Atomic observation commits

All ingestion snapshot, transition and associated poll-run statements must be
passed to `commit(lease, statements, observedAt)`, never run separately. These
are trusted internal statements prepared on the same D1 database, not SQL from
request input. They must target only the leased station and must not modify
guard/check tables. D1 `batch` supplies the transaction; assertions before and
after the writes reject invalid/expired ownership and roll back the whole batch.
The scratch assertion table is empty after success and after rollback.

Source observation time must be canonical UTC with milliseconds, not missing or
in the future. Equal/backward timestamps reject the whole observation batch,
even if its payload, request ID or mapping revision changed. `observationKey`
is the deterministic identity tuple `[source, internal station ID, source time]`;
it must also seed event idempotency keys. Successful commits persist the key
and high-water timestamp atomically. An existing latest snapshot is also checked
when a guard has no prior watermark. An older snapshot must never be replaced
by a newer fetch of the same cloud observation.

Missing/unreliable source time cannot enter the observation write path. Ingestion
must preserve the last stored snapshot and handle unavailable/replayed/failed
poll metadata separately. A fenced metadata-only path, typed outcome handling,
domain validation, last-confirmed context and actual snapshot/event statement
construction belong to ILL-80. The guard does not certify grid evidence or
implement transition logic. Synthetic verified test events are not approved
Deye mappings.

Guard errors contain only an operation tag; SQL/driver errors are not exposed.
A rejected/failed commit must not be treated as outage evidence. Guard rows must
not be deleted during normal retention: deleting them would reset epoch and
replay/throttle history.

## Verification

`server/test/refresh-guard.test.ts` applies both migrations to Workers-runtime D1
and exercises contention across instances, throttling/release, expired takeover,
owner/epoch fencing, atomic snapshot/event/poll writes, rollback/retry, persisted
watermarks, equal/backward/future observations and concurrent replay. It makes no
live upstream requests and does not require credentials.
