import { Context, Effect } from "effect"
import type { TelemetrySnapshot } from "../domain/telemetry"
import type { DeyeFailure } from "../errors/DeyeErrors"

/**
 * Read-only upstream boundary. Phase 2 defines the contract only; no live
 * adapter is installed until the regional API and field mappings are verified.
 */
export interface DeyeServiceShape {
  readonly readLatest: (
    stationId: string,
  ) => Effect.Effect<TelemetrySnapshot, DeyeFailure>
}

export const DeyeService = Context.Service<DeyeServiceShape>(
  "deye-monitor/DeyeService",
)
