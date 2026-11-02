import { applyD1Migrations, env } from "cloudflare:test"
import { beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/api/app"
import { ingestionLayer } from "../src/runtime/ingestion"
import { rateLimitBindings, TEST_CLIENT_IP } from "./helpers"

const db = env.DB
const readToken = "synthetic-scenario-read-token-at-least-32-characters"
const refreshToken = "synthetic-scenario-refresh-token-at-least-32-characters"
const secretMarker = "synthetic-sensitive-upstream-message"

beforeAll(async () => { await applyD1Migrations(db, env.TEST_MIGRATIONS) })

async function scenario() {
  const id = crypto.randomUUID()
  const base = Math.floor(Date.now() / 1000) * 1000
  let clock = base
  let collectionTime: number | null = (base - 129_000) / 1000
  let voltage = "225.3"
  let failure: (() => Response) | null = null
  const paths: string[] = []

  await db.prepare(`INSERT INTO stations (id, source, mapping_revision, created_at, updated_at)
    VALUES (?, 'deye-cloud', 'synthetic-scenario', ?, ?)`)
    .bind(id, new Date(base).toISOString(), new Date(base).toISOString()).run()

  const fakeFetch: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname
    paths.push(path)

    if (path === "/v1.0/account/token") {
      return Response.json({ code: "1000000", success: true, accessToken: "synthetic-upstream-token",
        tokenType: "bearer", expiresIn: "5183999" })
    }

    if (path !== "/v1.0/device/latest") throw new Error("Unexpected fake upstream path")

    if (failure !== null) return failure()

    return Response.json({ code: "1000000", success: true, deviceDataList: [{
      deviceSn: "synthetic-inverter", deviceType: "INVERTER", deviceState: 1, collectionTime,
      dataList: [{ key: "GridVoltageL1L2", value: voltage, unit: "V" },
        { key: "GridFrequency", value: voltage === "0" ? "0" : "49.98", unit: "Hz" },
        { key: "TotalGridPower", value: "0", unit: "W" },
        { key: "SOC", value: "100", unit: "%" }],
    }] })
  }

  const pollingLayer = ingestionLayer(db, {
    baseUrl: "https://synthetic-region.example.test", appId: "synthetic-app",
    appSecret: "synthetic-app-secret", passwordHash: "synthetic-hash",
    email: "synthetic@example.invalid", deviceSn: "synthetic-inverter", deviceType: "INVERTER",
    maxRetries: 2, retryBaseDelayMs: 0, retryMaxDelayMs: 0,
  }, { workflowBudgetMs: 5000, leaseMs: 15_000, minimumIntervalMs: 60_000 },
  1000, 180, { fetch: fakeFetch, now: () => clock })

  const app = createApp({ pollingLayer, now: () => clock })

  const environment = { ...rateLimitBindings, DB: db, STATION_ID: id,
    API_BEARER_TOKEN: readToken, API_REFRESH_TOKEN: refreshToken, REFRESH_ENABLED: "true" }

  const headers = { Authorization: `Bearer ${readToken}`, "X-Refresh-Token": refreshToken,
    "CF-Connecting-IP": TEST_CLIENT_IP }

  async function call(path: string, method = "GET", credentials = { read: readToken, refresh: refreshToken }) {
    const sent = { ...headers, Authorization: `Bearer ${credentials.read}`, "X-Refresh-Token": credentials.refresh }
    const response = await app.request(`https://example.invalid/api/v1/${path}`, { method, headers: sent }, environment)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.clone().text()).not.toMatch(
      /synthetic-sensitive|synthetic-upstream-token|synthetic-inverter|synthetic-app-secret|synthetic-hash|synthetic-scenario|synthetic-rotated/,
    )

    return response
  }

  return { paths, base, call,
    rotateCredentials: (read: string, refresh: string) => {
      environment.API_BEARER_TOKEN = read
      environment.API_REFRESH_TOKEN = refresh
    },
    setTime: (value: number | null) => { collectionTime = value },
    setVoltage: (value: string) => { voltage = value },
    setFailure: (value: () => Response) => { failure = value },
    advanceReads: (ms: number) => { clock += ms },
    allowRefresh: () => db.prepare(`UPDATE refresh_guards SET lease_until='1970-01-01T00:00:00.000Z',
      next_allowed_at='1970-01-01T00:00:00.000Z' WHERE station_id=?`).bind(id).run(),
    events: () => db.prepare("SELECT count(*) AS count FROM grid_events WHERE station_id=?").bind(id).first(),
  }
}

describe("offline refresh-to-HTTP scenarios with fake upstream and migrated D1", () => {
  it("rejects replaced local API credentials before upstream work and accepts independently rotated credentials", async () => {
    const f = await scenario()

    const rotated = { read: "synthetic-rotated-read-token-at-least-32-characters",
      refresh: "synthetic-rotated-refresh-token-at-least-32-characters" }

    f.rotateCredentials(rotated.read, rotated.refresh)
    expect((await f.call("telemetry")).status).toBe(401)
    expect((await f.call("refresh", "POST", { read: rotated.read, refresh: refreshToken })).status).toBe(403)
    expect((await f.call("refresh", "POST", { read: readToken, refresh: rotated.refresh })).status).toBe(401)
    expect(f.paths).toHaveLength(0)
    expect((await f.call("refresh", "POST", rotated)).status).toBe(200)
    const calls = f.paths.length
    expect((await f.call("telemetry", "GET", rotated)).status).toBe(200)
    expect(f.paths).toHaveLength(calls)
    expect(calls).toBe(2)
  })

  it("retains cloud delay, ages stored reads without upstream work and never classifies zero flow", async () => {
    const f = await scenario()
    const response = await f.call("refresh", "POST")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, data: { refresh: { outcome: "unverified" },
      telemetry: { measuredAt: new Date(f.base - 129_000).toISOString(), fetchedAt: new Date(f.base).toISOString(),
        grid: { status: "unknown", confidence: "unverified", voltageV: 225.3, frequencyHz: 49.98, powerW: null },
        battery: { socPercent: 100, powerW: null, mode: "unknown" }, freshness: { status: "fresh", ageSeconds: 129 } } } })
    const calls = f.paths.length
    f.advanceReads(60_000)
    expect(await (await f.call("telemetry")).json()).toMatchObject({ data: {
      measuredAt: new Date(f.base - 129_000).toISOString(), fetchedAt: new Date(f.base).toISOString(),
      grid: { status: "unknown" }, freshness: { status: "stale", ageSeconds: 189 },
    } })
    expect(f.paths).toHaveLength(calls)
    expect(await f.events()).toEqual({ count: 0 })
  })

  it("keeps simulated grid-present, zero-voltage and restored readings unknown without false events", async () => {
    const f = await scenario()

    for (const [index, voltage] of ["225.3", "0", "225.3"].entries()) {
      await f.allowRefresh()
      f.setTime((f.base - 129_000) / 1000 + index)
      f.setVoltage(voltage)
      const response = await f.call("refresh", "POST")
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: { refresh: { outcome: "unverified" },
        telemetry: { grid: { status: "unknown", confidence: "unverified", voltageV: Number(voltage) } } } })
    }

    expect(await f.events()).toEqual({ count: 0 })
  })

  it.each([
    { name: "stale", offset: -600_000, outcome: "stale", freshness: "stale" },
    { name: "missing", offset: null, outcome: "missing_timestamp", freshness: "unavailable" },
    { name: "future", offset: 86_400_000, outcome: "future_timestamp", freshness: "unavailable" },
  ])("preserves the last observation on $name source data without false transitions", async ({ offset, outcome, freshness }) => {
    const f = await scenario()
    f.setTime((f.base - 700_000) / 1000)
    expect((await f.call("refresh", "POST")).status).toBe(200)
    await f.allowRefresh()
    f.setTime(offset === null ? null : (f.base + offset) / 1000)
    const first = await f.call("refresh", "POST")
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ data: { refresh: { outcome } } })
    const read = await f.call("telemetry")
    expect(read.status).toBe(200)
    const expectedTime = offset !== null && offset < 0 ? f.base + offset : f.base - 700_000
    expect(await read.json()).toMatchObject({ data: { measuredAt: new Date(expectedTime).toISOString(),
      fetchedAt: new Date(f.base).toISOString(), grid: { status: "unknown" }, freshness: { status: freshness } } })
    expect(await f.events()).toEqual({ count: 0 })
  })

  it.each([
    { name: "HTTP-200 auth failure", response: () => Response.json({ code: "2101017", success: false, msg: secretMarker }),
      status: 502, code: "UPSTREAM_UNAVAILABLE", calls: 3 },
    { name: "429", response: () => new Response(secretMarker, { status: 429 }),
      status: 503, code: "UPSTREAM_RATE_LIMITED", calls: 3 },
    { name: "communication loss", response: () => new Response(secretMarker, { status: 503 }),
      status: 502, code: "UPSTREAM_UNAVAILABLE", calls: 3 },
    { name: "invalid payload", response: () => new Response("{invalid"),
      status: 502, code: "UPSTREAM_UNAVAILABLE", calls: 1 },
  ])("bounds $name attempts and preserves stored measurements through degraded reads", async ({ response, status, code, calls }) => {
    const f = await scenario()
    expect((await f.call("refresh", "POST")).status).toBe(200)
    await f.allowRefresh()
    const initialCalls = f.paths.length
    f.setFailure(response)
    const failed = await f.call("refresh", "POST")
    expect(failed.status).toBe(status)
    expect(await failed.json()).toMatchObject({ ok: false, error: { code } })
    expect(f.paths.length - initialCalls).toBe(calls)
    const stored = await f.call("telemetry")
    const body = await stored.json()
    expect(body).toMatchObject({ data: { measuredAt: new Date(f.base - 129_000).toISOString(),
      fetchedAt: new Date(f.base).toISOString(), grid: { status: "unknown", voltageV: 225.3 },
      freshness: { status: "unavailable" } } })
    expect(JSON.stringify(body)).not.toMatch(/synthetic-sensitive|synthetic-upstream-token|synthetic-inverter|synthetic-app-secret/)
    expect(f.paths.length - initialCalls).toBe(calls)
    expect(await f.events()).toEqual({ count: 0 })
  })
})
