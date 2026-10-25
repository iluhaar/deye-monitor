import type { D1Database } from "@cloudflare/workers-types"
import { Effect, Layer, Schema } from "effect"
import { evaluateFreshness, evaluateSnapshot } from "../domain/grid-status"
import type { TelemetrySnapshot } from "../domain/telemetry"
import { IngestionStorage, IngestionStorageError } from "../services/IngestionStorage"
import type { IngestionOutcome, IngestionStorageShape } from "../services/IngestionStorage"
import { makeRefreshGuard, observationKey } from "./RefreshGuard"
import type { RefreshGuardPolicy, RefreshLease, RefreshPollRecord } from "./RefreshGuard"

const SnapshotSchema = Schema.Struct({
  source: Schema.Literal("deye-cloud"), stationId: Schema.NonEmptyString,
  mappingRevision: Schema.NonEmptyString,
  grid: Schema.Struct({
    status: Schema.Literals(["online", "offline", "unknown"]),
    confidence: Schema.Literals(["confirmed", "unverified"]),
    evidence: Schema.Array(Schema.String),
    voltageV: Schema.NullOr(Schema.Finite), frequencyHz: Schema.NullOr(Schema.Finite),
    powerW: Schema.NullOr(Schema.Finite),
  }),
  battery: Schema.Struct({
    socPercent: Schema.NullOr(Schema.Finite.pipe(Schema.check(
      Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100),
    ))),
    powerW: Schema.NullOr(Schema.Finite),
    mode: Schema.Literals(["charging", "discharging", "idle", "unknown"]),
  }),
  home: Schema.Struct({ powerW: Schema.NullOr(Schema.Finite) }),
  measuredAt: Schema.NullOr(Schema.String), fetchedAt: Schema.String,
})

function canonical(value: string): boolean {
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value && value.length === 24
}

export function makeIngestionStorage(db: D1Database, policy: RefreshGuardPolicy): IngestionStorageShape {
  const guard = makeRefreshGuard(db, policy)
  const read = <A>(operation: () => Promise<A>) => Effect.tryPromise({
    try: operation, catch: () => new IngestionStorageError(),
  })

  function persist(
    lease: RefreshLease, input: TelemetrySnapshot, poll: RefreshPollRecord,
    nowMs: number, threshold: number,
  ) {
    return Effect.gen(function* () {
      const snapshot = yield* Effect.try({
        try: () => {
          const decoded = Schema.decodeUnknownSync(SnapshotSchema)(input)
          if (decoded.stationId !== lease.stationId || !canonical(decoded.fetchedAt)) {
            throw new Error("invalid snapshot")
          }
          return { ...decoded, freshness: input.freshness }
        },
        catch: () => new IngestionStorageError(),
      })
      const freshness = evaluateFreshness(snapshot, nowMs, threshold)
      if (freshness.status === "unavailable" ||
        (snapshot.measuredAt !== null && !canonical(snapshot.measuredAt))) {
        const outcome: IngestionOutcome = freshness.status === "unavailable"
          ? freshness.reason as IngestionOutcome : "invalid_timestamp"
        yield* guard.recordPoll(lease, { ...poll, result: "unavailable", outcome,
          measuredAt: null, errorCategory: outcome })
        return outcome
      }
      const measuredAt = snapshot.measuredAt!
      const watermark = yield* read(() => db.prepare(`
        SELECT MAX(value) AS value FROM (
          SELECT last_observed_at AS value FROM refresh_guards WHERE station_id = ? AND operation = 'telemetry'
          UNION ALL SELECT measured_at AS value FROM latest_snapshots WHERE station_id = ?
        )`).bind(lease.stationId, lease.stationId).first<{ value: string | null }>())
      if (watermark?.value !== null && watermark?.value !== undefined && measuredAt <= watermark.value) {
        const outcome = measuredAt === watermark.value ? "replay" : "backward"
        yield* guard.recordPoll(lease, { ...poll, result: "stale", outcome,
          measuredAt, errorCategory: outcome })
        return outcome
      }
      const evaluated = evaluateSnapshot(snapshot, nowMs, threshold)
      const confirmed = evaluated.grid.status !== "unknown"
      const outcome: IngestionOutcome = freshness.status === "stale" ? "stale"
        : confirmed ? "accepted" : "unverified"
      const context = yield* read(() => db.prepare(`SELECT status, observed_at, gap_since
        FROM grid_context WHERE station_id = ?`).bind(lease.stationId)
        .first<{ status: "online" | "offline"; observed_at: string; gap_since: string | null }>())
      if (context !== null && (!canonical(context.observed_at) || context.observed_at >= measuredAt ||
        !["online", "offline"].includes(context.status) ||
        (context.gap_since !== null && !canonical(context.gap_since)))) {
        return yield* Effect.fail(new IngestionStorageError())
      }
      const writes = [db.prepare(`INSERT INTO latest_snapshots (
        station_id, source, grid_status, grid_evidence_json, grid_confidence,
        grid_voltage_v, grid_frequency_hz, grid_power_w, battery_soc_percent,
        battery_power_w, battery_mode, home_power_w, measured_at, fetched_at,
        freshness_status, mapping_revision, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(station_id) DO UPDATE SET
        source=excluded.source, grid_status=excluded.grid_status,
        grid_evidence_json=excluded.grid_evidence_json, grid_confidence=excluded.grid_confidence,
        grid_voltage_v=excluded.grid_voltage_v, grid_frequency_hz=excluded.grid_frequency_hz,
        grid_power_w=excluded.grid_power_w, battery_soc_percent=excluded.battery_soc_percent,
        battery_power_w=excluded.battery_power_w, battery_mode=excluded.battery_mode,
        home_power_w=excluded.home_power_w, measured_at=excluded.measured_at,
        fetched_at=excluded.fetched_at, freshness_status=excluded.freshness_status,
        mapping_revision=excluded.mapping_revision, stored_at=excluded.stored_at`)
        .bind(lease.stationId, snapshot.source, evaluated.grid.status,
          JSON.stringify(snapshot.grid.evidence), snapshot.grid.confidence,
          snapshot.grid.voltageV, snapshot.grid.frequencyHz, snapshot.grid.powerW,
          snapshot.battery.socPercent, snapshot.battery.powerW, snapshot.battery.mode,
          snapshot.home.powerW, measuredAt, snapshot.fetchedAt, freshness.status,
          snapshot.mappingRevision, poll.completedAt),
      db.prepare(`INSERT INTO poll_runs (
        id, station_id, window_key, started_at, completed_at, result, latency_ms,
        upstream_measured_at, error_category, observation_key, outcome, fencing_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
        .bind(poll.id, lease.stationId, String(lease.epoch), poll.startedAt,
          poll.completedAt, freshness.status === "stale" ? "stale" : "success",
          poll.latencyMs, measuredAt, observationKey(lease.stationId, measuredAt), outcome, lease.epoch)]
      if (confirmed) {
        if (context !== null && context.status !== evaluated.grid.status) {
          writes.push(db.prepare(`INSERT INTO grid_events (
            id, station_id, status, observed_at, previous_status, previous_observed_at,
            evidence_json, source, idempotency_key, created_at, gap_since
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'deye-cloud', ?, ?, ?)`)
            .bind(crypto.randomUUID(), lease.stationId, evaluated.grid.status, measuredAt,
              context.status, context.observed_at, JSON.stringify(snapshot.grid.evidence),
              observationKey(lease.stationId, measuredAt), poll.completedAt, context.gap_since))
        }
        writes.push(db.prepare(`INSERT INTO grid_context (station_id, status, observed_at, gap_since)
          VALUES (?, ?, ?, NULL) ON CONFLICT(station_id) DO UPDATE SET
          status=excluded.status, observed_at=excluded.observed_at, gap_since=NULL`)
          .bind(lease.stationId, evaluated.grid.status, measuredAt))
      } else {
        writes.push(db.prepare(`UPDATE grid_context SET gap_since=COALESCE(gap_since, ?)
          WHERE station_id=?`).bind(poll.completedAt, lease.stationId))
      }
      yield* guard.commit(lease, writes, measuredAt)
      return outcome
    })
  }

  return { acquire: guard.acquire, release: guard.release, persist, recordFailure: guard.recordPoll }
}

export function ingestionStorageLayer(db: D1Database, policy: RefreshGuardPolicy) {
  return Layer.succeed(IngestionStorage, makeIngestionStorage(db, policy))
}
