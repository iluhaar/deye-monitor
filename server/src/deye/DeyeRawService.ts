import { Context, Effect } from "effect"
import type { DeyeFailure } from "../errors/DeyeErrors"
import type { DeyeLatest, DeyeLatestRequest } from "./types"

/**
 * Upstream-specific boundary used by the live adapter before normalization.
 * It is intentionally separate from `services/DeyeService.ts`, whose
 * canonical contract remains the normalized domain snapshot consumed by the
 * existing D1-only routes.
 */
export interface DeyeRawServiceShape {
  readonly readLatest: (
    request: DeyeLatestRequest | string,
  ) => Effect.Effect<DeyeLatest, DeyeFailure>
}

export const DeyeRawService = Context.Service<DeyeRawServiceShape>(
  "deye-monitor/DeyeRawService",
)
