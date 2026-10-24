import { Context, Effect } from "effect"
import type { EvaluatedTelemetrySnapshot, TelemetrySnapshot } from "../domain/telemetry"
import type { StorageFailure } from "../errors/StorageErrors"

export interface EventCursor {
  readonly observedAt: string
  readonly id: string
}

export interface EventQuery {
  readonly stationId: string
  readonly limit: number
  readonly cursor: EventCursor | null
  readonly from: string | null
  readonly to: string | null
}

export interface GridEvent {
  readonly id: string
  readonly stationId: string
  readonly status: "online" | "offline"
  readonly observedAt: string
  readonly previousStatus: "online" | "offline" | null
  readonly previousObservedAt: string | null
  readonly evidence: readonly string[]
  readonly source: "deye-cloud"
}

export interface EventPage {
  readonly events: readonly GridEvent[]
  readonly nextCursor: EventCursor | null
}

export interface StorageServiceShape {
  readonly getLatestSnapshot: (
    stationId: string,
  ) => Effect.Effect<TelemetrySnapshot | null, StorageFailure>
  readonly listEvents: (
    query: EventQuery,
  ) => Effect.Effect<EventPage, StorageFailure>
}

export const StorageService = Context.Service<StorageServiceShape>(
  "deye-monitor/StorageService",
)

export type ReadSnapshot = EvaluatedTelemetrySnapshot
