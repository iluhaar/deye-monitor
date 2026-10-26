import { Effect, Layer } from "effect"
import type { Env } from "../src/env"
import type { RateLimit } from "@cloudflare/workers-types"
import type { TelemetrySnapshot } from "../src/domain/telemetry"
import { StorageService, type TelemetryStore } from "../src/services/StorageService"

export const NOW = Date.parse("2026-10-24T12:00:00.000Z")
export const API_BEARER_TOKEN = "synthetic-test-secret-bearer-token-with-at-least-32-characters"
export const TEST_CLIENT_IP = "192.0.2.1"

function allowRateLimit(): RateLimit {
  return { limit: async () => ({ success: true }) }
}

export const rateLimitBindings: Pick<Env, "API_READ_RATE_LIMITER" | "API_AUTH_RATE_LIMITER"> = {
  API_READ_RATE_LIMITER: allowRateLimit(),
  API_AUTH_RATE_LIMITER: allowRateLimit(),
}

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
  ...rateLimitBindings,
  API_BEARER_TOKEN,
  STATION_ID: "station-1",
  FRESHNESS_THRESHOLD_SECONDS: "180",
}

export function authorizationHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${API_BEARER_TOKEN}`,
    "CF-Connecting-IP": TEST_CLIENT_IP,
  }
}

export function storageLayer(
  implementation: Partial<TelemetryStore> &
    Pick<TelemetryStore, "getLatestSnapshot" | "listEvents">,
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
