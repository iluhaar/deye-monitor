import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { Data, Effect } from "effect"

export class RefreshGuardError extends Data.TaggedError("RefreshGuardError")<{
  readonly operation: "acquire" | "release" | "commit"
}> {}

export interface RefreshLease {
  readonly stationId: string
  readonly operation: "telemetry"
  readonly owner: string
  readonly epoch: number
  readonly leaseUntil: string
}

export type AcquireRefreshResult =
  | { readonly status: "acquired"; readonly lease: RefreshLease }
  | { readonly status: "busy" | "throttled"; readonly retryAfterSeconds: number }

export interface RefreshGuardPolicy {
  /** Must cover the full finite workflow, including auth, retries and storage. */
  readonly workflowBudgetMs: number
  readonly leaseMs: number
  /** Operator-configured, not a claim about the account's verified quota. */
  readonly minimumIntervalMs: number
}

// All lock decisions use the database clock, not the invoking isolate's clock.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

function validPolicy(policy: RefreshGuardPolicy): boolean {
  return [policy.workflowBudgetMs, policy.leaseMs, policy.minimumIntervalMs]
    .every((value) => Number.isSafeInteger(value) && value > 0 && value <= 3_600_000) &&
    policy.leaseMs > policy.workflowBudgetMs
}

function validObservedAt(value: string): boolean {
  const millis = Date.parse(value)
  return Number.isFinite(millis) && new Date(millis).toISOString() === value &&
    value.length === 24
}

export function observationKey(stationId: string, observedAt: string): string {
  return JSON.stringify(["deye-cloud", stationId, observedAt])
}

/**
 * Internal D1 write boundary for ILL-80. All snapshot/event/poll writes must go
 * through commit; plain D1 statements outside this boundary are not fenced.
 * No lease renewal: exceeding the finite budget requires abandoning the result.
 */
export function makeRefreshGuard(db: D1Database, policy: RefreshGuardPolicy) {
  function acquire(stationId: string): Effect.Effect<AcquireRefreshResult, RefreshGuardError> {
    return Effect.tryPromise({
      try: async (): Promise<AcquireRefreshResult> => {
        if (!validPolicy(policy) || stationId.trim() === "") throw new Error("invalid policy")
        const owner = crypto.randomUUID()
        const row = await db.prepare(`
          INSERT INTO refresh_guards (
            station_id, operation, lease_owner, fencing_epoch, lease_until,
            acquired_at, updated_at, next_allowed_at
          ) VALUES (?, 'telemetry', ?, 1,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?), ${NOW}, ${NOW},
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
          ON CONFLICT(station_id, operation) DO UPDATE SET
            lease_owner = excluded.lease_owner,
            fencing_epoch = refresh_guards.fencing_epoch + 1,
            lease_until = excluded.lease_until,
            acquired_at = excluded.acquired_at,
            updated_at = excluded.updated_at,
            next_allowed_at = excluded.next_allowed_at
          WHERE refresh_guards.lease_until <= ${NOW}
            AND refresh_guards.next_allowed_at <= ${NOW}
            AND refresh_guards.fencing_epoch < 9007199254740991
          RETURNING fencing_epoch, lease_until
        `).bind(stationId, owner, `+${policy.leaseMs / 1000} seconds`,
          `+${policy.minimumIntervalMs / 1000} seconds`)
          .first<{ fencing_epoch: number; lease_until: string }>()
        if (row !== null) {
          return { status: "acquired", lease: {
            stationId, operation: "telemetry", owner,
            epoch: row.fencing_epoch, leaseUntil: row.lease_until,
          } }
        }
        const blocked = await db.prepare(`
          SELECT lease_until > ${NOW} AS busy,
            MAX(1, CAST(ceil((julianday(MAX(lease_until, next_allowed_at)) -
              julianday('now')) * 86400) AS INTEGER)) AS retry_after
          FROM refresh_guards WHERE station_id = ? AND operation = 'telemetry'
        `).bind(stationId).first<{ busy: number; retry_after: number }>()
        if (blocked === null) throw new Error("missing guard")
        return {
          status: blocked.busy ? "busy" : "throttled",
          retryAfterSeconds: blocked.retry_after,
        }
      },
      catch: () => new RefreshGuardError({ operation: "acquire" }),
    })
  }

  function release(lease: RefreshLease): Effect.Effect<boolean, RefreshGuardError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await db.prepare(`
          UPDATE refresh_guards SET lease_until = ${NOW}, updated_at = ${NOW}
          WHERE station_id = ? AND operation = ? AND lease_owner = ?
            AND fencing_epoch = ? AND lease_until > ${NOW}
        `).bind(lease.stationId, lease.operation, lease.owner, lease.epoch).run()
        return result.meta.changes === 1
      },
      catch: () => new RefreshGuardError({ operation: "release" }),
    })
  }

  function assertion(lease: RefreshLease, observedAt?: string): D1PreparedStatement {
    return db.prepare(`
      INSERT INTO refresh_commit_checks (valid)
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM refresh_guards
        WHERE station_id = ? AND operation = ? AND lease_owner = ?
          AND fencing_epoch = ? AND lease_until > ${NOW}
          ${observedAt === undefined ? "" : `AND ? <= ${NOW}
            AND (last_observed_at IS NULL OR last_observed_at < ?)
            AND NOT EXISTS (SELECT 1 FROM latest_snapshots
              WHERE station_id = ? AND measured_at IS NOT NULL AND measured_at >= ?)`}
      ) THEN 1 ELSE 0 END
    `).bind(lease.stationId, lease.operation, lease.owner, lease.epoch,
      ...(observedAt === undefined ? [] : [observedAt, observedAt, lease.stationId, observedAt]))
  }

  /**
   * Atomic observation commit. Failure/replay poll metadata needs a separate
   * fenced metadata-only path in the ingestion implementation (ILL-80).
   * Equal/backward/future timestamps reject the WHOLE batch without side effects.
   * Source time is the observation identity: corrections at the same timestamp
   * (including a new mapping revision) cannot invent another physical observation.
   */
  function commit(
    lease: RefreshLease,
    statements: readonly D1PreparedStatement[],
    observedAt: string,
  ): Effect.Effect<void, RefreshGuardError> {
    return Effect.tryPromise({
      try: async () => {
        if (!validObservedAt(observedAt)) {
          throw new Error("invalid observation time")
        }
        const watermark = db.prepare(`
          UPDATE refresh_guards SET last_observed_at = ?, last_observation_key = ?, updated_at = ${NOW}
          WHERE station_id = ? AND operation = ? AND lease_owner = ? AND fencing_epoch = ?
        `).bind(observedAt, observationKey(lease.stationId, observedAt),
          lease.stationId, lease.operation, lease.owner, lease.epoch)
        await db.batch([
          assertion(lease, observedAt),
          ...statements,
          watermark,
          // Also reject a lease that expired while the batch was executing.
          assertion(lease),
          db.prepare("DELETE FROM refresh_commit_checks"),
        ])
      },
      // Never expose SQL, driver diagnostics, identifiers or upstream payloads.
      catch: () => new RefreshGuardError({ operation: "commit" }),
    })
  }

  return { acquire, release, commit }
}
