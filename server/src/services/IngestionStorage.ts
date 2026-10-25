import { Context, Data, Effect } from "effect"
import type { TelemetrySnapshot } from "../domain/telemetry"
import type { AcquireRefreshResult, RefreshLease, RefreshPollRecord } from "../storage/RefreshGuard"
import type { RefreshGuardError } from "../storage/RefreshGuard"

export class IngestionStorageError extends Data.TaggedError("IngestionStorageError")<{}> {}

export type IngestionOutcome =
  | "accepted" | "unverified" | "stale" | "replay" | "backward"
  | "missing_timestamp" | "invalid_timestamp" | "future_timestamp" | "inconsistent_timestamp"

export interface IngestionStore {
  readonly acquire: (stationId: string) => Effect.Effect<AcquireRefreshResult, RefreshGuardError>
  readonly release: (lease: RefreshLease) => Effect.Effect<boolean, RefreshGuardError>
  readonly persist: (
    lease: RefreshLease, snapshot: TelemetrySnapshot, poll: RefreshPollRecord,
    nowMs: number, freshnessThresholdSeconds: number,
  ) => Effect.Effect<IngestionOutcome, IngestionStorageError | RefreshGuardError>
  readonly recordFailure: (
    lease: RefreshLease, poll: RefreshPollRecord,
  ) => Effect.Effect<void, RefreshGuardError>
}

export const IngestionStorage = Context.Service<IngestionStore>("deye-monitor/IngestionStorage")
