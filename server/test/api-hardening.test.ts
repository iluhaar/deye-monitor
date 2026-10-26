import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/api/app"
import { hasValidBearerToken } from "../src/api/auth"
import {
  MAX_API_QUERY_LENGTH,
  MAX_API_URL_LENGTH,
  MAX_EVENT_CURSOR_LENGTH,
  MAX_EVENT_DATE_LENGTH,
  encodeEventCursor,
} from "../src/api/query"
import type { Env } from "../src/env"
import { PollingService } from "../src/services/PollingService"
import { StorageService } from "../src/services/StorageService"
import type { EventQuery, GridEvent } from "../src/services/StorageService"
import { makeSnapshot, rateLimitBindings, TEST_CLIENT_IP } from "./helpers"

const READ_TOKEN = "r".repeat(32)
const REFRESH_TOKEN = "f".repeat(32)

const env: Env = {
  ...rateLimitBindings,
  API_BEARER_TOKEN: READ_TOKEN,
  API_REFRESH_TOKEN: REFRESH_TOKEN,
  REFRESH_ENABLED: "true",
  STATION_ID: "station-1",
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)

  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", TEST_CLIENT_IP)

  return new Request(`https://example.test${path}`, { ...init, headers })
}

function authorization(): HeadersInit {
  return { Authorization: `Bearer ${READ_TOKEN}` }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

function makeEvent(id: string): GridEvent {
  return {
    id,
    stationId: "station-1",
    status: "online",
    observedAt: "2026-10-24T11:00:00.000Z",
    previousStatus: null,
    previousObservedAt: null,
    evidence: ["grid_voltage"],
    source: "deye-cloud",
  }
}

function makeHarness(
  events: readonly GridEvent[] = [],
  nextCursor: EventQuery["cursor"] = null,
) {
  let snapshotReads = 0
  let eventReads = 0
  let refreshCalls = 0
  let lastLimit: number | null = null
  let lastCursor: EventQuery["cursor"] = null

  const storageLayer = Layer.succeed(StorageService, {
    getLatestSnapshot: () => Effect.sync(() => {
      snapshotReads += 1

      return null
    }),
    listEvents: (query) => Effect.sync(() => {
      eventReads += 1
      lastLimit = query.limit
      lastCursor = query.cursor

      return { events, nextCursor }
    }),
  })

  const pollingLayer = Layer.succeed(PollingService, {
    refresh: () => Effect.sync(() => {
      refreshCalls += 1

      return { status: "completed", outcome: "unverified", errorCategory: null } as const
    }),
  })

  return {
    app: createApp({ storageLayer, pollingLayer }),
    snapshotReads: () => snapshotReads,
    eventReads: () => eventReads,
    refreshCalls: () => refreshCalls,
    lastLimit: () => lastLimit,
    lastCursor: () => lastCursor,
  }
}

afterEach(() => vi.restoreAllMocks())

describe("bounded authenticated API contract", () => {
  it("accepts read secrets at the 32- and 4096-character boundaries", () => {
    for (const token of ["a".repeat(32), "b".repeat(4096)]) {
      const authorization = new Headers({ Authorization: `Bearer ${token}` })

      expect(hasValidBearerToken(new Request("https://example.test/api/v1/status", { headers: authorization }), token))
        .toBe(true)
    }

    const caseInsensitiveHeader = new Request("https://example.test/api/v1/status", {
      headers: { Authorization: `bearer ${READ_TOKEN}` },
    })

    expect(hasValidBearerToken(caseInsensitiveHeader, READ_TOKEN)).toBe(true)
  })

  it.each([
    { name: "short configured token", configured: "s".repeat(31), provided: "s".repeat(31) },
    { name: "long configured token", configured: "l".repeat(4097), provided: "l".repeat(4097) },
    { name: "short request token", configured: READ_TOKEN, provided: "s".repeat(31) },
    { name: "long request token", configured: READ_TOKEN, provided: "l".repeat(4097) },
  ])("fails closed for $name", ({ configured, provided }) => {
    const authorization = new Headers({ Authorization: `Bearer ${provided}` })

    expect(hasValidBearerToken(new Request("https://example.test/api/v1/status", { headers: authorization }), configured))
      .toBe(false)
  })

  it("rejects oversized Authorization headers before token comparison", () => {
    const token = "x".repeat(4097)
    const authorization = new Headers({ Authorization: `Bearer ${token}` })

    expect(hasValidBearerToken(new Request("https://example.test/api/v1/status", { headers: authorization }), READ_TOKEN))
      .toBe(false)
  })

  it("does not echo an invalid configured or supplied read secret", async () => {
    const secret = "short-config-secret"
    const harness = makeHarness()

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers: { Authorization: `Bearer ${secret}` } }),
      { ...env, API_BEARER_TOKEN: secret },
    )

    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    })
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(harness.snapshotReads()).toBe(0)
  })

  it("bounds the complete URL and query before authentication", async () => {
    const harness = makeHarness()
    const overlongQuery = `?${"x".repeat(MAX_API_QUERY_LENGTH + 1)}`
    const queryResponse = await harness.app.fetch(request(`/api/v1/status${overlongQuery}`), {})

    expect(queryResponse.status).toBe(414)
    expect(await queryResponse.json()).toEqual({
      ok: false,
      error: { code: "REQUEST_TOO_LARGE", message: "Request is too large" },
    })

    const overlongPath = `/api/v1/${"x".repeat(MAX_API_URL_LENGTH)}`
    const urlResponse = await harness.app.fetch(request(overlongPath), {})

    expect(urlResponse.status).toBe(414)
    expect(harness.snapshotReads()).toBe(0)
  })

  it("rejects unknown and repeated event parameters without reading storage", async () => {
    const harness = makeHarness()
    const requestSecret = "request-secret-not-for-errors"

    for (const path of [
      `/api/v1/events?unexpected=${requestSecret}`,
      "/api/v1/events?limit=1&limit=2",
      "/api/v1/events?from=2026-10-24T11:00:00Z&from=2026-10-24T12:00:00Z",
    ]) {
      const response = await harness.app.fetch(request(path, { headers: authorization() }), env)

      expect(response.status, path).toBe(400)
      const body = await response.json()

      expect(body, path).toEqual({
        ok: false,
        error: { code: "INVALID_QUERY", message: "Invalid events query" },
      })
      expect(JSON.stringify(body)).not.toContain(requestSecret)
    }

    expect(harness.eventReads()).toBe(0)
  })

  it("rejects every query string on non-event read routes", async () => {
    const harness = makeHarness()

    for (const path of ["/api/v1/status?", "/api/v1/telemetry?limit=1", "/api/v1/health?unused=yes"]) {
      const response = await harness.app.fetch(request(path, { headers: authorization() }), env)

      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({
        ok: false,
        error: { code: "INVALID_QUERY", message: "Invalid query" },
      })
    }

    expect(harness.snapshotReads()).toBe(0)
  })

  it("rejects an oversized cursor before base64 decoding", async () => {
    const harness = makeHarness()
    const atob = vi.spyOn(globalThis, "atob")
    const cursor = "a".repeat(MAX_EVENT_CURSOR_LENGTH + 1)

    const response = await harness.app.fetch(
      request(`/api/v1/events?cursor=${cursor}`, { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(400)
    expect(atob).not.toHaveBeenCalled()
    expect(harness.eventReads()).toBe(0)
  })

  it("accepts a cursor exactly at the encoded-length boundary", async () => {
    const harness = makeHarness()
    const cursorJson = JSON.stringify({ observedAt: "2026-10-24T11:00:00.000Z", id: "event-1" })
    const paddedJson = `${cursorJson}${" ".repeat(384 - cursorJson.length)}`
    const cursor = encodeBase64Url(paddedJson)

    expect(cursor).toHaveLength(MAX_EVENT_CURSOR_LENGTH)

    const response = await harness.app.fetch(
      request(`/api/v1/events?limit=100&cursor=${cursor}`, { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(200)
    expect(harness.lastLimit()).toBe(100)
    expect(harness.eventReads()).toBe(1)
  })

  it("preserves cursors emitted by the existing event pagination contract", async () => {
    const harness = makeHarness()
    const cursor = { observedAt: "2026-10-24T11:00:00.000Z", id: "event-123" }
    const encoded = encodeEventCursor(cursor)

    if (encoded === null) throw new Error("expected an event cursor")

    const response = await harness.app.fetch(
      request(`/api/v1/events?cursor=${encoded}`, { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(200)
    expect(harness.lastCursor()).toEqual(cursor)
  })

  it("rejects an oversized ID in a bounded decoded cursor", async () => {
    const harness = makeHarness()

    const cursor = encodeBase64Url(JSON.stringify({
      observedAt: "2026-10-24T11:00:00.000Z",
      id: "i".repeat(129),
    }))

    const response = await harness.app.fetch(
      request(`/api/v1/events?cursor=${cursor}`, { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(400)
    expect(harness.eventReads()).toBe(0)
  })

  it("bounds malformed date strings before Date.parse", async () => {
    const harness = makeHarness()
    const dateParse = vi.spyOn(Date, "parse")
    const malformedDate = "x".repeat(MAX_EVENT_DATE_LENGTH + 1)

    const response = await harness.app.fetch(
      request(`/api/v1/events?from=${malformedDate}`, { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(400)
    expect(dateParse).not.toHaveBeenCalled()
    expect(harness.eventReads()).toBe(0)
  })

  it("caps public event responses and returns a sanitized storage failure", async () => {
    const oversizedEvents = Array.from({ length: 101 }, (_, index) => makeEvent(`event-${index}`))
    const harness = makeHarness(oversizedEvents)

    const response = await harness.app.fetch(
      request("/api/v1/events?limit=100", { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable" },
    })
  })

  it("bounds accepted event fields and the complete response payload", async () => {
    const largestEvidence = Array.from({ length: 16 }, () => "e".repeat(64))
    const largestEvent = { ...makeEvent("i".repeat(128)), evidence: largestEvidence }
    const harness = makeHarness(Array.from({ length: 100 }, () => largestEvent))

    const response = await harness.app.fetch(
      request("/api/v1/events?limit=100", { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(200)
    expect(new TextEncoder().encode(await response.text()).byteLength).toBeLessThanOrEqual(1_000_000)

    const invalidHarness = makeHarness([
      { ...makeEvent("event-1"), evidence: ["e".repeat(65)] },
    ])

    const invalidResponse = await invalidHarness.app.fetch(
      request("/api/v1/events", { headers: authorization() }),
      env,
    )

    expect(invalidResponse.status).toBe(503)
    expect(await invalidResponse.json()).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE" },
    })
  })

  it("maps an oversized UTF-8 output cursor to a sanitized storage failure", async () => {
    const cursor = { observedAt: "2026-10-24T11:00:00.000Z", id: "漢".repeat(128) }
    const harness = makeHarness([], cursor)

    const response = await harness.app.fetch(
      request("/api/v1/events", { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(503)
    const body = await response.json()

    expect(body).toEqual({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable" },
    })
    expect(JSON.stringify(body)).not.toContain(cursor.id)
  })

  it("bounds snapshot fields before freshness parsing or public serialization", async () => {
    const oversizedTimestamp = "t".repeat(MAX_EVENT_DATE_LENGTH + 1)

    const storageLayer = Layer.succeed(StorageService, {
      getLatestSnapshot: () => Effect.succeed(makeSnapshot({ fetchedAt: oversizedTimestamp })),
      listEvents: () => Effect.succeed({ events: [], nextCursor: null }),
    })

    const app = createApp({ storageLayer })
    const dateParse = vi.spyOn(Date, "parse")

    const response = await app.fetch(
      request("/api/v1/telemetry", { headers: authorization() }),
      env,
    )

    expect(response.status).toBe(503)
    expect(dateParse).not.toHaveBeenCalled()
    expect(JSON.stringify(await response.json())).not.toContain(oversizedTimestamp)
  })

  it("rejects streamed bodies without consuming them", async () => {
    let pulls = 0
    let cancellations = 0

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancellations += 1

        return new Promise<void>(() => undefined)
      },
    })

    const init: RequestInit & { readonly duplex: "half" } = {
      method: "POST",
      headers: authorization(),
      body,
      duplex: "half",
    }

    const pending = request("/api/v1/status", init)
    const pullsBeforeRequest = pulls
    const harness = makeHarness()

    const response = await harness.app.fetch(pending, env)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Request body is not accepted" },
    })
    expect(pulls).toBe(pullsBeforeRequest)
    expect(cancellations).toBe(1)
  })

  it("rejects oversized body metadata without parsing it", async () => {
    const harness = makeHarness()

    const malformedHeaders: ReadonlyArray<readonly [string, string]> = [
      ["Content-Length", "9".repeat(21)],
      ["Content-Length", "not-a-length"],
      ["Content-Length", "00"],
      ["Transfer-Encoding", "chunked"],
    ]

    for (const [name, value] of malformedHeaders) {
      const headers = new Headers(authorization())
      headers.set(name, value)

      const response = await harness.app.fetch(
        request("/api/v1/status", { headers }),
        env,
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Request body is not accepted" },
      })
    }

    expect(harness.snapshotReads()).toBe(0)
  })

  it("accepts a zero-length HTTP refresh stream without reading it", async () => {
    const harness = makeHarness()

    const pending = request("/api/v1/refresh", {
      method: "POST",
      headers: {
        ...authorization(),
        "X-Refresh-Token": REFRESH_TOKEN,
        "Content-Length": "0",
      },
      body: "",
    })

    expect(pending.body).not.toBeNull()

    const response = await harness.app.fetch(pending, env)

    expect(response.status).toBe(200)
    expect(harness.refreshCalls()).toBe(1)
    expect(pending.bodyUsed).toBe(false)
  })

  it("rejects chunked refresh framing even when Content-Length is zero", async () => {
    const harness = makeHarness()

    const response = await harness.app.fetch(
      request("/api/v1/refresh", {
        method: "POST",
        headers: {
          ...authorization(),
          "X-Refresh-Token": REFRESH_TOKEN,
          "Content-Length": "0",
          "Transfer-Encoding": "chunked",
        },
      }),
      env,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "INVALID_REFRESH_REQUEST", message: "Refresh accepts no query or body" },
    })
    expect(harness.refreshCalls()).toBe(0)
  })

  it("preserves refresh authentication failures before body contract handling", async () => {
    const harness = makeHarness()

    const unauthorized = await harness.app.fetch(
      request("/api/v1/refresh", { method: "POST", body: "ignored" }),
      env,
    )

    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    })

    const forbidden = await harness.app.fetch(
      request("/api/v1/refresh", {
        method: "POST",
        headers: authorization(),
        body: "ignored",
      }),
      env,
    )

    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Refresh authorization required" },
    })
    expect(harness.refreshCalls()).toBe(0)
  })

  it("keeps refresh body and authorization failures sanitized and stable", async () => {
    const harness = makeHarness()

    const bodyResponse = await harness.app.fetch(
      request("/api/v1/refresh", {
        method: "POST",
        headers: { ...authorization(), "X-Refresh-Token": REFRESH_TOKEN },
        body: "ignored",
      }),
      env,
    )

    expect(bodyResponse.status).toBe(400)
    expect(await bodyResponse.json()).toEqual({
      ok: false,
      error: { code: "INVALID_REFRESH_REQUEST", message: "Refresh accepts no query or body" },
    })
    expect(harness.refreshCalls()).toBe(0)

    const deniedResponse = await harness.app.fetch(
      request("/api/v1/refresh", {
        method: "POST",
        headers: { ...authorization(), "X-Refresh-Token": "x".repeat(4097) },
      }),
      env,
    )

    expect(deniedResponse.status).toBe(403)
    expect(await deniedResponse.json()).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Refresh authorization required" },
    })
    expect(harness.refreshCalls()).toBe(0)
  })

  it("rejects a bare refresh query delimiter", async () => {
    const harness = makeHarness()

    const response = await harness.app.fetch(
      request("/api/v1/refresh?", {
        method: "POST",
        headers: { ...authorization(), "X-Refresh-Token": REFRESH_TOKEN },
      }),
      env,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "INVALID_REFRESH_REQUEST", message: "Refresh accepts no query or body" },
    })
    expect(harness.refreshCalls()).toBe(0)
  })
})
