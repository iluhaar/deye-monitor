import type {
  EvaluatedTelemetrySnapshot,
  FreshnessInfo,
  FreshnessStatus,
  TelemetrySnapshot,
} from "./telemetry"

export const DEFAULT_FRESHNESS_THRESHOLD_SECONDS = 180

export type FreshnessReason =
  | "missing_timestamp"
  | "invalid_timestamp"
  | "future_timestamp"
  | "inconsistent_timestamp"
  | "stale"
  | "fresh"

export interface FreshnessEvaluation extends FreshnessInfo {
  readonly reason: FreshnessReason
}

/**
 * Only evidence names that a future, verified normalizer may explicitly emit
 * can establish grid state. In particular, grid power is deliberately not an
 * accepted signal: zero power is compatible with an energized grid.
 */
const VERIFIED_GRID_EVIDENCE = new Set([
  "grid_voltage",
  "grid_frequency",
  "grid_connected_status",
])

export function hasVerifiedGridEvidence(
  grid: TelemetrySnapshot["grid"],
): boolean {
  return (
    grid.confidence === "confirmed" &&
    (grid.status === "online" || grid.status === "offline") &&
    grid.evidence.some((name) => VERIFIED_GRID_EVIDENCE.has(name))
  )
}

function timestampMillis(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unavailable(reason: FreshnessReason): FreshnessEvaluation {
  return { status: "unavailable", ageSeconds: null, reason }
}

export function evaluateFreshness(
  snapshot: Pick<TelemetrySnapshot, "measuredAt" | "fetchedAt">,
  nowMs: number,
  thresholdSeconds = DEFAULT_FRESHNESS_THRESHOLD_SECONDS,
): FreshnessEvaluation {
  if (!Number.isFinite(nowMs)) return unavailable("invalid_timestamp")

  const measuredMs = timestampMillis(snapshot.measuredAt)
  const fetchedMs = timestampMillis(snapshot.fetchedAt)
  if (measuredMs === null || fetchedMs === null) {
    return unavailable(
      snapshot.measuredAt === null || snapshot.measuredAt === undefined
        ? "missing_timestamp"
        : "invalid_timestamp",
    )
  }

  // A reading from the future, or a server fetch timestamp from the future,
  // cannot be used to claim current state. A measured time after its fetch
  // time is likewise internally inconsistent.
  if (measuredMs > nowMs || fetchedMs > nowMs) {
    return unavailable("future_timestamp")
  }
  if (measuredMs > fetchedMs) {
    return unavailable("inconsistent_timestamp")
  }

  const safeThreshold =
    Number.isFinite(thresholdSeconds) && thresholdSeconds >= 0
      ? thresholdSeconds
      : DEFAULT_FRESHNESS_THRESHOLD_SECONDS
  const ageSecondsExact = Math.max(0, (nowMs - measuredMs) / 1000)
  const ageSeconds = Math.floor(ageSecondsExact)
  if (ageSecondsExact > safeThreshold) {
    return { status: "stale", ageSeconds, reason: "stale" }
  }
  return { status: "fresh", ageSeconds, reason: "fresh" }
}

/**
 * Re-evaluate a stored snapshot without changing the stored object. Stale,
 * missing, future, or unverified data can never produce online/offline.
 */
export function evaluateSnapshot(
  snapshot: TelemetrySnapshot,
  nowMs: number,
  thresholdSeconds = DEFAULT_FRESHNESS_THRESHOLD_SECONDS,
): EvaluatedTelemetrySnapshot {
  const freshness = evaluateFreshness(snapshot, nowMs, thresholdSeconds)
  if (snapshot.collectionAvailable === false) {
    return { ...snapshot, grid: { ...snapshot.grid, status: "unknown" },
      freshness: { status: "unavailable", ageSeconds: freshness.ageSeconds } }
  }
  const status: TelemetrySnapshot["grid"]["status"] =
    freshness.status === "fresh" && hasVerifiedGridEvidence(snapshot.grid)
      ? snapshot.grid.status
      : "unknown"

  return {
    ...snapshot,
    grid: { ...snapshot.grid, status },
    freshness: toFreshnessInfo(freshness),
  }
}

function toFreshnessInfo(evaluation: FreshnessEvaluation): FreshnessInfo {
  const status: FreshnessStatus = evaluation.status
  return { status, ageSeconds: evaluation.ageSeconds }
}

export function unavailableSnapshot(): {
  readonly grid: {
    readonly status: "unknown"
    readonly evidence: readonly string[]
    readonly confidence: "unverified"
    readonly voltageV: null
    readonly frequencyHz: null
    readonly powerW: null
  }
  readonly freshness: FreshnessInfo
} {
  return {
    grid: {
      status: "unknown",
      evidence: [],
      confidence: "unverified",
      voltageV: null,
      frequencyHz: null,
      powerW: null,
    },
    freshness: { status: "unavailable", ageSeconds: null },
  }
}
