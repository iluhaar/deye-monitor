import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/api/app"
import { makeSnapshot, NOW, authenticatedEnv, authorizationHeaders, emptyStorage, storageLayer } from "./helpers"
import type { EventQuery, TelemetryStore } from "../src/services/StorageService"

async function readJson(response: Response) {
  return Schema.decodeUnknownSync(Schema.JsonObject)(await response.json())
}

function request(path: string, headers?: HeadersInit) {
  return new Request(`https://example.test${path}`, { headers })
}

describe("authenticated read API", () => {
  it("fails closed when unauthenticated", async () => {
    const app = createApp({ storageLayer: emptyStorage(), now: () => NOW })
    const response = await app.fetch(request("/api/v1/status"), authenticatedEnv)
    const body = await readJson(response)

    expect(response.status).toBe(401)
    expect(body).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("fails closed when the bearer secret is not configured", async () => {
    const app = createApp({ storageLayer: emptyStorage(), now: () => NOW })

    const response = await app.fetch(
      request("/api/v1/status", authorizationHeaders()),
      { STATION_ID: "station-1" },
    )

    expect(response.status).toBe(401)
  })

  it("returns a sanitized error when the D1 binding is missing", async () => {
    const app = createApp({ now: () => NOW })

    const response = await app.fetch(
      request("/api/v1/status", authorizationHeaders()),
      authenticatedEnv,
    )

    const body = await readJson(response)

    expect(response.status).toBe(503)
    expect(body).toEqual({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable" },
    })
    expect(JSON.stringify(body)).not.toMatch(/SELECT|stack|test-secret/i)
  })

  it("returns unknown and unavailable when no snapshot exists", async () => {
    const app = createApp({ storageLayer: emptyStorage(), now: () => NOW })

    const response = await app.fetch(
      request("/api/v1/status", authorizationHeaders()),
      authenticatedEnv,
    )

    const body = await readJson(response)

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty("data.grid.status", "unknown")
    expect(body).toHaveProperty("data.freshness", { status: "unavailable", ageSeconds: null })
  })

  it("re-evaluates freshness on every read", async () => {
    const cases = [
      {
        name: "fresh",
        snapshot: makeSnapshot(),
        expected: "online",
      },
      {
        name: "stale",
        snapshot: makeSnapshot({ measuredAt: "2026-10-24T11:56:59.000Z" }),
        expected: "unknown",
      },
      {
        name: "missing",
        snapshot: makeSnapshot({ measuredAt: null }),
        expected: "unknown",
      },
      {
        name: "future measured",
        snapshot: makeSnapshot({ measuredAt: "2026-10-24T12:00:01.000Z" }),
        expected: "unknown",
      },
      {
        name: "future fetched",
        snapshot: makeSnapshot({ fetchedAt: "2026-10-24T12:00:01.000Z" }),
        expected: "unknown",
      },
    ] as const

    for (const testCase of cases) {
      const app = createApp({
        storageLayer: emptyStorage(testCase.snapshot),
        now: () => NOW,
      })

      const response = await app.fetch(
        request("/api/v1/status", authorizationHeaders()),
        authenticatedEnv,
      )

      const body = await readJson(response)

      expect(body, testCase.name).toHaveProperty("data.grid.status", testCase.expected)
    }
  })

  it("uses a substituted Effect service rather than contacting D1", async () => {
    let called = false

    const fakeStorage: TelemetryStore = {
      getLatestSnapshot: (stationId) => {
        called = stationId === "station-1"

        return Effect.succeed(makeSnapshot())
      },
      listEvents: () => Effect.succeed({ events: [], nextCursor: null }),
    }

    const app = createApp({
      storageLayer: storageLayer(fakeStorage),
      now: () => NOW,
    })

    const response = await app.fetch(
      request("/api/v1/status", authorizationHeaders()),
      authenticatedEnv,
    )

    const body = await readJson(response)

    expect(response.status).toBe(200)
    expect(body).toHaveProperty("data.grid.status", "online")
    expect(called).toBe(true)
  })

  it("keeps health output sanitized", async () => {
    const app = createApp({
      storageLayer: emptyStorage(makeSnapshot()),
      now: () => NOW,
    })

    const response = await app.fetch(
      request("/api/v1/health", authorizationHeaders()),
      authenticatedEnv,
    )

    const body = await readJson(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      status: "ok",
      snapshotAvailable: true,
      ingestionLagSeconds: 30,
    })
    expect(JSON.stringify(body)).not.toMatch(/station-internal|test-secret/i)
  })

  it("validates event limits, ranges, and cursors", async () => {
    const queries: EventQuery[] = []

    const fakeStorage: TelemetryStore = {
      getLatestSnapshot: () => Effect.succeed(null),
      listEvents: (query) => {
        queries.push(query)

        return Effect.succeed({
          events: [],
          nextCursor: { observedAt: "2026-10-24T11:00:00.000Z", id: "event-1" },
        })
      },
    }

    const app = createApp({
      storageLayer: storageLayer(fakeStorage),
      now: () => NOW,
    })

    for (const path of [
      "/api/v1/events?limit=0",
      "/api/v1/events?limit=101",
      "/api/v1/events?from=2026-10-24T11:00:00Z&to=2026-10-24T10:00:00Z",
      "/api/v1/events?cursor=not-base64",
    ]) {
      const response = await app.fetch(
        request(path, authorizationHeaders()),
        authenticatedEnv,
      )

      expect(response.status, path).toBe(400)
      expect(await readJson(response)).toHaveProperty("error.code", "INVALID_QUERY")
    }

    const response = await app.fetch(
      request(
        "/api/v1/events?limit=2&from=2026-10-24T10:00:00Z&to=2026-10-24T12:00:00Z",
        authorizationHeaders(),
      ),
      authenticatedEnv,
    )

    const body = await readJson(response)

    expect(response.status).toBe(200)
    expect(queries[0]).toMatchObject({
      stationId: "station-1",
      limit: 2,
      from: "2026-10-24T10:00:00.000Z",
      to: "2026-10-24T12:00:00.000Z",
    })
    expect(body).toHaveProperty("data.nextCursor", expect.any(String))
  })
})
