import type { D1Database } from "@cloudflare/workers-types"
import { Effect, Schema } from "effect"
import type { TelemetrySnapshot } from "../domain/telemetry"
import { MissingBindingError, StorageError } from "../errors/StorageErrors"
import type {
  EventPage,
  GridEvent,
  StorageServiceShape,
} from "../services/StorageService"

const FiniteNumberSchema = Schema.Finite
const BatterySocSchema = FiniteNumberSchema.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(100),
  ),
)

const SnapshotRowSchema = Schema.Struct({
  source: Schema.Literals(["deye-cloud"]),
  station_id: Schema.String,
  grid_status: Schema.Literals(["online", "offline", "unknown"]),
  grid_evidence_json: Schema.String,
  grid_confidence: Schema.Literals(["confirmed", "unverified"]),
  grid_voltage_v: Schema.NullOr(FiniteNumberSchema),
  grid_frequency_hz: Schema.NullOr(FiniteNumberSchema),
  grid_power_w: Schema.NullOr(FiniteNumberSchema),
  battery_soc_percent: Schema.NullOr(BatterySocSchema),
  battery_power_w: Schema.NullOr(FiniteNumberSchema),
  battery_mode: Schema.Literals(["charging", "discharging", "idle", "unknown"]),
  home_power_w: Schema.NullOr(FiniteNumberSchema),
  measured_at: Schema.NullOr(Schema.String),
  fetched_at: Schema.String,
  freshness_status: Schema.Literals(["fresh", "stale", "unavailable"]),
})

const EventRowSchema = Schema.Struct({
  id: Schema.String,
  station_id: Schema.String,
  status: Schema.Literals(["online", "offline"]),
  observed_at: Schema.String,
  previous_status: Schema.NullOr(Schema.Literals(["online", "offline"])),
  previous_observed_at: Schema.NullOr(Schema.String),
  evidence_json: Schema.String,
  source: Schema.Literals(["deye-cloud"]),
})

const EvidenceSchema = Schema.Array(Schema.String)

function decodeEvidence(value: string): readonly string[] {
  return Schema.decodeUnknownSync(EvidenceSchema)(JSON.parse(value))
}

function decodeSnapshotRow(value: unknown): TelemetrySnapshot {
  const row = Schema.decodeUnknownSync(SnapshotRowSchema)(value)
  return {
    source: row.source,
    stationId: row.station_id,
    grid: {
      status: row.grid_status,
      evidence: decodeEvidence(row.grid_evidence_json),
      confidence: row.grid_confidence,
      voltageV: row.grid_voltage_v,
      frequencyHz: row.grid_frequency_hz,
      powerW: row.grid_power_w,
    },
    battery: {
      socPercent: row.battery_soc_percent,
      powerW: row.battery_power_w,
      mode: row.battery_mode,
    },
    home: { powerW: row.home_power_w },
    measuredAt: row.measured_at,
    fetchedAt: row.fetched_at,
    // This persisted value is metadata from ingestion. Read handlers replace
    // it with a fresh evaluation before returning data.
    freshness: { status: row.freshness_status, ageSeconds: null },
  }
}

function canonicalUtcTimestamp(value: string): { value: string; millis: number } {
  const millis = Date.parse(value)
  const canonical = Number.isFinite(millis)
    ? new Date(millis).toISOString()
    : null
  if (canonical === null || value !== canonical) {
    throw new Error("invalid persisted event timestamp")
  }
  return { value: canonical, millis }
}

function decodeEventRow(value: unknown): GridEvent {
  const row = Schema.decodeUnknownSync(EventRowSchema)(value)
  if (row.id.trim() === "" || row.station_id.trim() === "") {
    throw new Error("invalid persisted event identity")
  }

  const observedAt = canonicalUtcTimestamp(row.observed_at)
  const previousObservedAt =
    row.previous_observed_at === null
      ? null
      : canonicalUtcTimestamp(row.previous_observed_at)
  const evidence = decodeEvidence(row.evidence_json)
  if (evidence.length === 0 || evidence.some((item) => item.trim() === "")) {
    throw new Error("invalid persisted event evidence")
  }
  if ((row.previous_status === null) !== (previousObservedAt === null)) {
    throw new Error("incoherent persisted prior event")
  }
  if (row.previous_status !== null) {
    if (row.previous_status === row.status) {
      throw new Error("incoherent persisted prior status")
    }
    if (previousObservedAt !== null && previousObservedAt.millis > observedAt.millis) {
      throw new Error("incoherent persisted prior timestamp")
    }
  }
  return {
    id: row.id,
    stationId: row.station_id,
    status: row.status,
    observedAt: observedAt.value,
    previousStatus: row.previous_status,
    previousObservedAt: previousObservedAt?.value ?? null,
    evidence,
    source: row.source,
  }
}

function missingBinding(): Effect.Effect<never, MissingBindingError> {
  return Effect.fail(new MissingBindingError({ binding: "DB" }))
}

export function makeD1Storage(db: D1Database | undefined): StorageServiceShape {
  if (!db) {
    return {
      getLatestSnapshot: () => missingBinding(),
      listEvents: () => missingBinding(),
    }
  }

  return {
    getLatestSnapshot: (stationId) =>
      Effect.tryPromise({
        try: async () => {
          const row = await db
            .prepare(
              `SELECT
                source, station_id, grid_status, grid_evidence_json,
                grid_confidence, grid_voltage_v, grid_frequency_hz,
                grid_power_w, battery_soc_percent, battery_power_w,
                battery_mode, home_power_w, measured_at, fetched_at,
                freshness_status
              FROM latest_snapshots
              WHERE station_id = ?
              LIMIT 1`,
            )
            .bind(stationId)
            .first<unknown>()
          return row === null ? null : decodeSnapshotRow(row)
        },
        catch: () => new StorageError({ operation: "read_snapshot" }),
      }),

    listEvents: (query) =>
      Effect.tryPromise({
        try: async () => {
          const where = ["station_id = ?"]
          const values: Array<string | number | null> = [query.stationId]

          if (query.from !== null) {
            where.push("observed_at >= ?")
            values.push(query.from)
          }
          if (query.to !== null) {
            where.push("observed_at <= ?")
            values.push(query.to)
          }
          if (query.cursor !== null) {
            // Newest-first ordering is made deterministic by the event id
            // tie-breaker. The cursor is an exclusive tuple boundary.
            where.push(
              "(observed_at < ? OR (observed_at = ? AND id < ?))",
            )
            values.push(
              query.cursor.observedAt,
              query.cursor.observedAt,
              query.cursor.id,
            )
          }

          values.push(query.limit + 1)
          const result = await db
            .prepare(
              `SELECT
                id, station_id, status, observed_at, previous_status,
                previous_observed_at, evidence_json, source
              FROM grid_events
              WHERE ${where.join(" AND ")}
              ORDER BY observed_at DESC, id DESC
              LIMIT ?`,
            )
            .bind(...values)
            .all<unknown>()

          const decoded = result.results.map(decodeEventRow)
          const hasNext = decoded.length > query.limit
          const events = hasNext ? decoded.slice(0, query.limit) : decoded
          const last = events.at(-1)
          return {
            events,
            nextCursor:
              hasNext && last
                ? { observedAt: last.observedAt, id: last.id }
                : null,
          } satisfies EventPage
        },
        catch: () => new StorageError({ operation: "read_events" }),
      }),
  }
}
