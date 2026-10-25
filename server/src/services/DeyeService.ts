import { Context, Effect } from "effect"
import type { TelemetrySnapshot } from "../domain/telemetry"
import type { DeyeFailure } from "../errors/DeyeErrors"

/**
 * Read-only normalized upstream boundary. NormalizedLive composes the raw
 * adapter and conservative normalizer for opt-in finite ingestion; ordinary
 * API reads remain D1-only.
 */
export interface DeyeReader {
  readonly readLatest: (
    stationId: string,
  ) => Effect.Effect<TelemetrySnapshot, DeyeFailure>
}

export const DeyeService = Context.Service<DeyeReader>(
  "deye-monitor/DeyeService",
)
