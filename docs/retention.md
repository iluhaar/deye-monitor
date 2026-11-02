# Twelve-hour history retention

The operator selected a **12-hour history window** for both:

- `poll_runs`, aged by `started_at` (attempt time, not cloud measurement time).
- `grid_events`, aged by `observed_at` (the source observation time).

The cutoff is calculated using D1's UTC clock. Rows strictly older than the
cutoff are deleted; rows exactly at the cutoff remain until they become older.
The policy is fixed in the ingestion storage boundary, not supplied by clients
or inferred from upstream timestamps. Existing station/time indexes support
the two station-scoped deletes; no migration is needed.

## When deletion runs

Authorized, acquired refresh attempts prune that station's history in the same
fenced D1 transaction that records their result. Successful, stale, unverified,
replayed/backward, missing/invalid/future-time and failed upstream attempts all
use the policy. A rejected, throttled or overlapping refresh does not prune.
Loss of lease ownership or a SQL failure rolls the whole transaction back,
including cleanup; it cannot partially delete history or commit a stale worker.

This is **request-driven cleanup, not an exact automatic TTL**. With no refreshes,
old rows can remain on disk and in event reads until the next acquired refresh.
It does not enable Cron or cause any new Deye requests. The first refresh after a
long idle period may delete a larger backlog and require more D1 work. A strict
wall-clock deletion deadline while idle would need separately authorized
scheduled maintenance; it is not claimed by this implementation.

## Current state is not history

Cleanup does not delete `stations`, `latest_snapshots`, `grid_context`, or
`refresh_guards`. These contain current readings, compact last-confirmed/gap
context, observation watermarks, fencing epochs and throttling state, not an
unbounded series of records. The current refresh epoch's poll record is protected
even if its supplied attempt timestamp is skewed; it supplies current
collection-availability status. Normal refresh attempts have current timestamps.

Thus the latest reading and compact operational context can be older than 12
hours. Their original timestamps remain visible and freshness is re-evaluated;
they are never silently made fresh by retaining them. Recent events can also
refer to an older prior observation through their timestamp fields. Deleting
the old event row must not reset this context or permit replayed transitions.
Other stations are untouched. No raw credentials or upstream tokens are stored
or added to support cleanup.

## Verification

```sh
cd server
npm test -- test/ingestion.test.ts test/refresh-guard.test.ts
npm run verify
```

Real migrated-D1 tests seed 13-hour-old and 11-hour-old history, then check
pruning during success, failure, replay and unavailable source time. They also
check station isolation, retained latest snapshot/confirmed context/watermark,
and inability of an expired ingestion worker to prune. Existing fencing and
transaction rollback tests remain in the gate.

This implements the retention part of ILL-84. The operator deferred the separate
health enhancements, structured logging and aggregate metrics to Phase 2 / backlog;
they no longer block the MVP. The existing health endpoint and this retention
policy remain unchanged. No deployed observability completion is claimed.
This policy supersedes that issue's earlier suggestion to retain compact
verified event history longer: both history tables now use the operator's
12-hour policy, with only compact current state retained separately.
