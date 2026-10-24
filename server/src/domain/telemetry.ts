export type GridStatus = "online" | "offline" | "unknown"
export type GridConfidence = "confirmed" | "unverified"
export type FreshnessStatus = "fresh" | "stale" | "unavailable"
export type BatteryMode = "charging" | "discharging" | "idle" | "unknown"

export interface FreshnessInfo {
  readonly status: FreshnessStatus
  readonly ageSeconds: number | null
}

export interface GridReading {
  readonly status: GridStatus
  readonly evidence: readonly string[]
  readonly confidence: GridConfidence
  readonly voltageV: number | null
  readonly frequencyHz: number | null
  readonly powerW: number | null
}

export interface BatteryReading {
  readonly socPercent: number | null
  readonly powerW: number | null
  readonly mode: BatteryMode
}

export interface TelemetrySnapshot {
  readonly source: "deye-cloud"
  readonly stationId: string
  readonly grid: GridReading
  readonly battery: BatteryReading
  readonly home: { readonly powerW: number | null }
  readonly measuredAt: string | null
  readonly fetchedAt: string
  /** This value is persisted as metadata only; reads always recompute it. */
  readonly freshness: FreshnessInfo
}

export interface EvaluatedTelemetrySnapshot extends TelemetrySnapshot {
  readonly freshness: FreshnessInfo
  readonly grid: GridReading
}
