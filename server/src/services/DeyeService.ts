import { Context, Effect } from "effect"
import type { TelemetrySnapshot } from "../domain/telemetry"
import type { DeyeFailure } from "../errors/DeyeErrors"

/**
 * Read-only normalized upstream boundary. The live adapter currently lives
 * beside this contract and exposes DeyeRawService for separate normalization;
 * the existing API/storage runtime remains D1-only.
 */
export interface DeyeServiceShape {
  readonly readLatest: (
    stationId: string,
  ) => Effect.Effect<TelemetrySnapshot, DeyeFailure>
}

export const DeyeService = Context.Service<DeyeServiceShape>(
  "deye-monitor/DeyeService",
)
