import { Effect, Layer } from "effect"
import type { Env } from "../src/env"
import type { TelemetrySnapshot } from "../src/domain/telemetry"
import { StorageService, type StorageServiceShape } from "../src/services/StorageService"

export const NOW = Date.parse("2026-10-24T12:00:00.000Z")

export function makeSnapshot(
  overrides: Partial<TelemetrySnapshot> = {},
): TelemetrySnapshot {
  return {
    source: "deye-cloud",
    stationId: "station-internal",
    grid: {
      status: "online",
      confidence: "confirmed",
      evidence: ["grid_voltage"],
      voltageV: 230,
      frequencyHz: 50,
      powerW: 0,
      ...overrides.grid,
    },
    battery: {
      socPercent: 50,
      powerW: 0,
      mode: "idle",
      ...overrides.battery,
    },
    home: { powerW: 100, ...overrides.home },
    measuredAt: "2026-10-24T11:59:00.000Z",
    fetchedAt: "2026-10-24T11:59:30.000Z",
    freshness: { status: "fresh", ageSeconds: 60 },
    ...overrides,
  }
}

export const authenticatedEnv: Env = {
  API_BEARER_TOKEN: "test-secret",
  STATION_ID: "station-1",
  FRESHNESS_THRESHOLD_SECONDS: "180",
}

export function authorizationHeaders(): HeadersInit {
  return { Authorization: "Bearer test-secret" }
}

export function storageLayer(
  implementation: Partial<StorageServiceShape> &
    Pick<StorageServiceShape, "getLatestSnapshot" | "listEvents">,
) {
  return Layer.succeed(StorageService, implementation)
}

export function emptyStorage(snapshot: TelemetrySnapshot | null = null) {
  return storageLayer({
    getLatestSnapshot: () => Effect.succeed(snapshot),
    listEvents: () =>
      Effect.succeed({ events: [], nextCursor: null }),
  })
}
