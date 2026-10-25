import { applyD1Migrations, env } from "cloudflare:test"
import { Effect, Layer, Schema } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/api/app"
import type { Env } from "../src/env"
import { RefreshConfigurationError, refreshConfiguration, refreshLayer } from "../src/runtime/refresh"
import { makePollingService, PollingError, PollingService } from "../src/services/PollingService"
import type { PollingResult } from "../src/services/PollingService"
import { emptyStorage, makeSnapshot, NOW } from "./helpers"
import { makeIngestionStorage } from "../src/storage/IngestionLive"

const bindings = env
const db = bindings.DB
const readToken = "synthetic-read-token-with-at-least-32-characters"
const refreshToken = "synthetic-refresh-token-with-at-least-32-characters"
const headers = { Authorization: `Bearer ${readToken}`, "X-Refresh-Token": refreshToken }

const baseEnv: Env = { API_BEARER_TOKEN: readToken, API_REFRESH_TOKEN: refreshToken,
  STATION_ID: "synthetic-station", REFRESH_ENABLED: "true" }

beforeAll(async () => { await applyD1Migrations(db, bindings.TEST_MIGRATIONS) })

function request(path = "/api/v1/refresh", init: RequestInit = {}) {
  return new Request(`https://example.invalid${path}`, { method: "POST", headers, ...init })
}

function stub(result: PollingResult = { status: "completed", outcome: "unverified", errorCategory: null }) {
  let calls = 0

  const app = createApp({ now: () => NOW, storageLayer: emptyStorage(makeSnapshot()),
    pollingLayer: Layer.succeed(PollingService, { refresh: () => Effect.sync(() => { calls += 1;

 return result }) }),
  })

  return { app, calls: () => calls }
}

describe("protected manual refresh HTTP boundary", () => {
  it.each<{ name: string; sent: HeadersInit; expected: number }>([
    { name: "no credentials", sent: {}, expected: 401 },
    { name: "refresh credential alone", sent: { "X-Refresh-Token": refreshToken }, expected: 401 },
    { name: "wrong read bearer", sent: { ...headers, Authorization: "Bearer incorrect" }, expected: 401 },
    { name: "read bearer alone", sent: { Authorization: `Bearer ${readToken}` }, expected: 403 },
    { name: "wrong refresh credential", sent: { ...headers, "X-Refresh-Token": "incorrect" }, expected: 403 },
    { name: "refresh credential as read bearer", sent: { ...headers, Authorization: `Bearer ${refreshToken}` }, expected: 401 },
  ])("rejects $name without invoking ingestion", async ({ sent, expected }) => {
    const { app, calls } = stub()
    const response = await app.fetch(request(undefined, { headers: sent }), baseEnv)
    expect(response.status).toBe(expected)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(JSON.stringify(await response.json())).not.toContain(refreshToken)
    expect(calls()).toBe(0)
  })

  it.each([undefined, "", "short", readToken, " ".repeat(32), "x".repeat(4097)])(
    "fails closed for absent, weak, shared or invalid refresh configuration", async (configured) => {
      const { app, calls } = stub()
      const response = await app.fetch(request(), { ...baseEnv, API_REFRESH_TOKEN: configured })
      expect(response.status).toBe(403)
      expect(calls()).toBe(0)
    },
  )

  it.each(["?token=secret", "?stationId=override", "?force=true", "?API_REFRESH_TOKEN=secret"])(
    "rejects query input %s before invoking ingestion", async (query) => {
      const { app, calls } = stub()
      const response = await app.fetch(request(`/api/v1/refresh${query}`), baseEnv)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "INVALID_REFRESH_REQUEST" } })
      expect(calls()).toBe(0)
    },
  )

  it("never accepts credentials in a URL", async () => {
    const { app, calls } = stub()
    const response = await app.fetch(request(`/api/v1/refresh?token=${refreshToken}`, { headers: {} }), baseEnv)
    expect(response.status).toBe(401)
    expect(calls()).toBe(0)
  })

  it.each(["GET", "PUT", "DELETE", "OPTIONS"])("never refreshes for %s", async (method) => {
    const { app, calls } = stub()
    expect((await app.fetch(request(undefined, { method }), baseEnv)).status).toBe(404)
    expect(calls()).toBe(0)
  })

  it("rejects request bodies without reading them", async () => {
    const { app, calls } = stub()
    const response = await app.fetch(request(undefined, { body: JSON.stringify({ force: true }) }), baseEnv)
    expect(response.status).toBe(400)
    expect(calls()).toBe(0)
  })

  it.each([undefined, "false", "TRUE", "1"])("requires explicit activation: %s", async (enabled) => {
    const { app, calls } = stub()
    expect((await app.fetch(request(), { ...baseEnv, REFRESH_ENABLED: enabled })).status).toBe(503)
    expect(calls()).toBe(0)
  })

  it("requires an internal station and valid live configuration before using the production factory", async () => {
    const { app, calls } = stub()
    expect((await app.fetch(request(), { ...baseEnv, STATION_ID: "" })).status).toBe(503)
    expect(calls()).toBe(0)
    const response = await createApp().fetch(request(), baseEnv)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "SERVICE_NOT_CONFIGURED" } })
  })

  it("returns a stable success envelope with independently retained source/fetch time", async () => {
    const { app, calls } = stub()
    const response = await app.fetch(request(), baseEnv)
    expect(response.status).toBe(200)
    expect(response.headers.get("Vary")).toBe("Authorization, X-Refresh-Token")
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, data: { refresh: { outcome: "unverified" },
      telemetry: { measuredAt: "2026-10-24T11:59:00.000Z", fetchedAt: "2026-10-24T11:59:30.000Z",
        freshness: { status: "fresh", ageSeconds: 60 } } } })
    expect(JSON.stringify(body)).not.toMatch(/stationId|mappingRevision|collectionAvailable|synthetic-refresh-token/)
    expect(calls()).toBe(1)
  })

  it.each(["busy", "throttled"] as const)("returns safe persisted %s responses", async (status) => {
    const { app } = stub({ status, retryAfterSeconds: 23.1 })
    const response = await app.fetch(request(), baseEnv)
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("24")
    expect(await response.json()).toMatchObject({ ok: false, error: {
      code: status === "busy" ? "REFRESH_IN_PROGRESS" : "REFRESH_THROTTLED",
    } })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it.each([NaN, Infinity, -1, 10_000])("bounds Retry-After for %s", async (retryAfterSeconds) => {
    const { app } = stub({ status: "throttled", retryAfterSeconds })
    const response = await app.fetch(request(), baseEnv)
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
    expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(3600)
  })

  it.each([
    { category: "auth", code: "UPSTREAM_UNAVAILABLE", status: 502 },
    { category: "unavailable", code: "UPSTREAM_UNAVAILABLE", status: 502 },
    { category: "invalid_payload", code: "UPSTREAM_UNAVAILABLE", status: 502 },
    { category: "timeout", code: "REFRESH_TIMEOUT", status: 504 },
    { category: "rate_limit", code: "UPSTREAM_RATE_LIMITED", status: 503 },
    { category: "not_configured", code: "SERVICE_NOT_CONFIGURED", status: 503 },
    { category: "storage", code: "STORAGE_UNAVAILABLE", status: 503 },
  ] as const)("sanitizes completed $category failures", async ({ category, code, status }) => {
    const { app } = stub({ status: "completed", outcome: "error", errorCategory: category })
    const response = await app.fetch(request(), baseEnv)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ ok: false, error: { code } })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it.each(["storage", "configuration", "timeout"] as const)("sanitizes typed polling %s errors", async (category) => {
    const app = createApp({ pollingLayer: Layer.succeed(PollingService, {
      refresh: () => Effect.fail(new PollingError({ category })),
    }) })

    expect((await app.fetch(request(), baseEnv)).status).toBe(category === "timeout" ? 504 : 503)
  })

  it("does not disclose unexpected exceptions", async () => {
    const app = createApp({ pollingLayer: Layer.succeed(PollingService, {
      refresh: () => Effect.die(new Error("synthetic-secret SELECT credentials")),
    }) })

    const response = await app.fetch(request(), baseEnv)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false,
      error: { code: "INTERNAL_ERROR", message: "Internal server error" } })
  })
})

function configuredEnv(): Env {
  return { ...baseEnv, DB: db, STATION_ID: crypto.randomUUID(), REFRESH_MIN_INTERVAL_SECONDS: "180",
    DEYE_BASE_URL: "https://eu1-developer.deyecloud.com", DEYE_APP_ID: "synthetic-app-id",
    DEYE_APP_SECRET: "synthetic-app-secret", DEYE_PASSWORD_HASH: "0".repeat(64),
    DEYE_EMAIL: "synthetic@example.invalid", DEYE_DEVICE_SN: "synthetic-device", DEYE_DEVICE_TYPE: "INVERTER" }
}

function fakeUpstream(waitForLatest?: () => Promise<void>) {
  let calls = 0
  const measuredAt = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000).toISOString()

  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls += 1
    const sent = new Headers(init?.headers)
    expect(sent.get("X-Refresh-Token")).toBeNull()
    expect(sent.get("Authorization")).not.toBe(`Bearer ${readToken}`)
    expect(sent.get("Authorization")).not.toBe(`Bearer ${refreshToken}`)
    const path = new URL(String(input)).pathname

    if (path === "/v1.0/account/token") {
      return Response.json({ success: true, code: "1000000", accessToken: "synthetic-upstream-token",
        expiresIn: "5183999", tokenType: "bearer" })
    }

    if (path !== "/v1.0/device/latest") throw new Error("Unexpected fake path")
    expect(JSON.parse(String(init?.body))).toMatchObject({ deviceList: ["synthetic-device"] })
    await waitForLatest?.()

    return Response.json({ success: true, code: "1000000", deviceDataList: [{ deviceSn: "synthetic-device",
      deviceType: "INVERTER", deviceState: 1, collectionTime: Date.parse(measuredAt) / 1000,
      dataList: [{ key: "GridVoltageL1L2", value: "230", unit: "V" }] }] })
  }

  return { fetch, calls: () => calls, measuredAt }
}

describe("refresh activation and real D1 integration", () => {
  it.each([undefined, "", "0", "-1", "1.5", " 180", "3601", "NaN"])(
    "requires an explicit bounded refresh interval: %s", (interval) => {
      expect(() => refreshConfiguration({ ...configuredEnv(), REFRESH_MIN_INTERVAL_SECONDS: interval }))
        .toThrow(RefreshConfigurationError)
    },
  )

  it("derives a lease covering both auth/data retry budgets and finalization", () => {
    const resolved = refreshConfiguration(configuredEnv())
    expect(resolved.policy.minimumIntervalMs).toBe(180_000)
    expect(resolved.policy.workflowBudgetMs).toBe(151_000)
    expect(resolved.policy.leaseMs).toBe(166_000)
  })

  it.each([
    { DEYE_BASE_URL: undefined }, { DEYE_BASE_URL: "http://example.invalid" },
    { DEYE_APP_SECRET: undefined }, { DEYE_DEVICE_SN: "" }, { DEYE_PASSWORD_HASH: "plaintext" },
    { DEYE_USERNAME: "second-identity" }, { DEYE_DEVICE_TYPE: "LOGGER" },
    { STATION_ID: "synthetic-device" },
  ])("rejects incomplete/ambiguous live configuration before station writes", (missing) => {
    expect(() => refreshConfiguration({ ...configuredEnv(), ...missing })).toThrow(RefreshConfigurationError)
  })

  it("creates the configured internal station only for authorized refresh; GET stays stored-data-only", async () => {
    const environment = configuredEnv()
    const fake = fakeUpstream()
    const app = createApp({ pollingLayer: refreshLayer(environment, 180, { fetch: fake.fetch }) })
    const denied = await app.fetch(request(undefined, { headers: { Authorization: `Bearer ${readToken}` } }), environment)
    expect(denied.status).toBe(403)
    expect(await db.prepare("SELECT id FROM stations WHERE id=?").bind(environment.STATION_ID!).first()).toBeNull()
    const response = await app.fetch(request(), environment)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, data: { refresh: { outcome: "unverified" },
      telemetry: { measuredAt: fake.measuredAt, grid: { status: "unknown", confidence: "unverified", voltageV: 230 },
        freshness: { status: "fresh" } } } })
    expect(JSON.stringify(body)).not.toMatch(/synthetic-device|synthetic-app-secret|synthetic-upstream-token|stationId/)
    expect(fake.calls()).toBe(2)

    const stored = await app.fetch(new Request("https://example.invalid/api/v1/telemetry",
      { headers: { Authorization: `Bearer ${readToken}` } }), environment)

    expect(await stored.json()).toMatchObject({ ok: true, data: { measuredAt: fake.measuredAt } })
    expect(fake.calls()).toBe(2)
    // A different app/layer instance observes the persisted throttle.
    const second = createApp({ pollingLayer: refreshLayer(environment, 180, { fetch: fake.fetch }) })
    const throttled = await second.fetch(request(), environment)
    expect(throttled.status).toBe(429)
    expect(await throttled.json()).toMatchObject({ error: { code: "REFRESH_THROTTLED" } })
    expect(fake.calls()).toBe(2)
    expect((await db.prepare("SELECT count(*) AS count FROM poll_runs WHERE station_id=?")
      .bind(environment.STATION_ID!).first())).toEqual({ count: 1 })
  })

  it("returns predictable in-flight responses across instances without extra upstream calls or events", async () => {
    const environment = configuredEnv()
    let unblock!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { unblock = resolve })

    const fake = fakeUpstream(() => { started();

 return gate })

    const first = createApp({ pollingLayer: refreshLayer(environment, 180, { fetch: fake.fetch }) })
    const second = createApp({ pollingLayer: refreshLayer(environment, 180, { fetch: fake.fetch }) })
    const pending = first.fetch(request(), environment)

    try {
      await ready
      const overlap = await second.fetch(request(), environment)
      expect(overlap.status).toBe(429)
      expect(await overlap.json()).toMatchObject({ error: { code: "REFRESH_IN_PROGRESS" } })
      expect(Number(overlap.headers.get("Retry-After"))).toBeGreaterThan(0)
      expect(fake.calls()).toBe(2)
    } finally {
      unblock()
    }

    expect((await pending).status).toBe(200)
    expect(await db.prepare("SELECT count(*) AS count FROM poll_runs WHERE station_id=?")
      .bind(environment.STATION_ID!).first()).toEqual({ count: 1 })
    expect(await db.prepare("SELECT count(*) AS count FROM grid_events WHERE station_id=?")
      .bind(environment.STATION_ID!).first()).toEqual({ count: 0 })
  })

  it("records failed upstream auth safely and leaves stored measurements untouched", async () => {
    const environment = configuredEnv()
    const fake = fakeUpstream()
    const first = createApp({ pollingLayer: refreshLayer(environment, 180, { fetch: fake.fetch }) })
    const accepted = await first.fetch(request(), environment)

    const before = Schema.decodeUnknownSync(Schema.Struct({
      ok: Schema.Literal(true),
      data: Schema.Struct({ telemetry: Schema.Struct({ measuredAt: Schema.String, fetchedAt: Schema.String }) }),
    }))(await accepted.json())

    await db.prepare(`UPDATE refresh_guards SET lease_until='1970-01-01T00:00:00.000Z',
      next_allowed_at='1970-01-01T00:00:00.000Z' WHERE station_id=?`).bind(environment.STATION_ID!).run()
    let calls = 0

    const deniedFetch: typeof fetch = async (input, init) => {
      calls += 1

      if (new URL(String(input)).pathname === "/v1.0/account/token") return fake.fetch(input, init)

      return new Response("synthetic-sensitive-upstream-body", { status: 401 })
    }

    const second = createApp({ pollingLayer: refreshLayer(environment, 180, { fetch: deniedFetch }) })
    const failed = await second.fetch(request(), environment)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE", message: "Upstream refresh failed" } })
    expect(calls).toBe(4) // One bounded reauthentication, not an infinite loop.
    const stored = await second.fetch(new Request("https://example.invalid/api/v1/telemetry", { headers }), environment)
    expect(await stored.json()).toMatchObject({ data: {
      measuredAt: before.data.telemetry.measuredAt, fetchedAt: before.data.telemetry.fetchedAt,
      grid: { status: "unknown" }, freshness: { status: "unavailable" },
    } })

    const persisted = await db.prepare("SELECT * FROM poll_runs WHERE station_id=?")
      .bind(environment.STATION_ID!).all()

    expect(JSON.stringify(persisted)).not.toContain("synthetic-sensitive-upstream-body")
  })

  it("cannot duplicate a synthetic confirmed transition on HTTP replay or throttling", async () => {
    const environment = configuredEnv()
    const id = environment.STATION_ID!
    const now = Date.now()
    await db.prepare(`INSERT INTO stations (id, source, mapping_revision, created_at, updated_at)
      VALUES (?, 'deye-cloud', 'synthetic-grid-test', ?, ?)`)
      .bind(id, new Date(now).toISOString(), new Date(now).toISOString()).run()
    let calls = 0

    let snapshot = makeSnapshot({ stationId: id, mappingRevision: "synthetic-grid-test",
      measuredAt: new Date(now - 2000).toISOString(), fetchedAt: new Date(now - 1000).toISOString() })

    const polling = makePollingService({ readLatest: () => Effect.sync(() => { calls += 1;

 return snapshot }) },
      makeIngestionStorage(db, { workflowBudgetMs: 1000, leaseMs: 5000, minimumIntervalMs: 60_000 }),
      { workflowBudgetMs: 1000, finalizationBudgetMs: 200, freshnessThresholdSeconds: 180 })

    const app = createApp({ pollingLayer: Layer.succeed(PollingService, polling) })
    expect((await app.fetch(request(), environment)).status).toBe(200)
    snapshot = { ...snapshot, grid: { ...snapshot.grid, status: "offline", voltageV: 0, frequencyHz: 0 },
      measuredAt: new Date(now - 1000).toISOString(), fetchedAt: new Date(now).toISOString() }

    for (const expected of ["accepted", "replay"]) {
      await db.prepare(`UPDATE refresh_guards SET lease_until='1970-01-01T00:00:00.000Z',
        next_allowed_at='1970-01-01T00:00:00.000Z' WHERE station_id=?`).bind(id).run()
      const response = await app.fetch(request(), environment)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: { refresh: { outcome: expected } } })
    }

    expect((await app.fetch(request(), environment)).status).toBe(429)
    expect(calls).toBe(3)
    expect(await db.prepare("SELECT count(*) AS count FROM grid_events WHERE station_id=?")
      .bind(id).first()).toEqual({ count: 1 })
  })
})
