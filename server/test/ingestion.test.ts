import { applyD1Migrations, env } from "cloudflare:test"
import type { D1Database } from "@cloudflare/workers-types"
import type { D1Migration } from "@cloudflare/vitest-plugin"
import { Effect, Layer } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { makeNormalizedDeyeService } from "../src/deye/NormalizedLive"
import { DeyeAuthError, DeyeUnavailableError } from "../src/errors/DeyeErrors"
import { DeyeService } from "../src/services/DeyeService"
import type { DeyeServiceShape } from "../src/services/DeyeService"
import { IngestionStorage, IngestionStorageError } from "../src/services/IngestionStorage"
import type { IngestionStorageShape } from "../src/services/IngestionStorage"
import { makePollingService, pollingLayer, PollingService } from "../src/services/PollingService"
import { makeD1Storage } from "../src/storage/D1Live"
import { ingestionStorageLayer, makeIngestionStorage } from "../src/storage/IngestionLive"
import type { TelemetrySnapshot } from "../src/domain/telemetry"
import { makeSnapshot } from "./helpers"
import { evaluateSnapshot } from "../src/domain/grid-status"
import { createApp } from "../src/api/app"
import { ingestionLayer } from "../src/runtime/ingestion"

const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const db = bindings.DB
const policy = { workflowBudgetMs: 1000, leaseMs: 5000, minimumIntervalMs: 60_000 }
const options = { workflowBudgetMs: 1000, finalizationBudgetMs: 200, freshnessThresholdSeconds: 180 }
const base = Date.now() - 60_000
const iso = (time: number) => new Date(time).toISOString()

beforeAll(async () => { await applyD1Migrations(db, bindings.TEST_MIGRATIONS) })

async function fixture() {
  const id = crypto.randomUUID()
  await db.prepare(`INSERT INTO stations (id, source, mapping_revision, created_at, updated_at)
    VALUES (?, 'deye-cloud', 'synthetic-test', ?, ?)`).bind(id, iso(base), iso(base)).run()
  let clock = base
  let input = makeSnapshot({ stationId: id, mappingRevision: "synthetic-test",
    measuredAt: iso(base - 1000), fetchedAt: iso(base) })
  let sourceEffect: Effect.Effect<TelemetrySnapshot, DeyeUnavailableError | DeyeAuthError> | null = null
  let calls = 0
  const source: DeyeServiceShape = { readLatest: () => Effect.suspend(() => {
    calls += 1
    return sourceEffect ?? Effect.succeed(input)
  }) }
  const storage = makeIngestionStorage(db, policy)
  const service = makePollingService(source, storage, options, () => clock)
  async function refresh() { return Effect.runPromise(service.refresh(id)) }
  async function next(status: "online" | "offline" | "unknown", extra: Partial<TelemetrySnapshot> = {}) {
    clock += 1000
    input = { ...input, measuredAt: iso(clock - 500), fetchedAt: iso(clock),
      grid: { ...input.grid, status, confidence: status === "unknown" ? "unverified" : "confirmed" }, ...extra }
    await db.prepare(`UPDATE refresh_guards SET lease_until=?, next_allowed_at=? WHERE station_id=?`)
      .bind(iso(base - 10_000), iso(base - 10_000), id).run()
  }
  return { id, source, storage, refresh, next, calls: () => calls,
    setInput: (value: TelemetrySnapshot) => { input = value },
    input: () => input,
    fail: (effect: typeof sourceEffect) => { sourceEffect = effect },
    snapshot: () => Effect.runPromise(makeD1Storage(db).getLatestSnapshot(id)),
    polls: () => db.prepare("SELECT * FROM poll_runs WHERE station_id=? ORDER BY started_at, id")
      .bind(id).all<Record<string, unknown>>(),
    events: () => db.prepare("SELECT * FROM grid_events WHERE station_id=? ORDER BY observed_at")
      .bind(id).all<Record<string, unknown>>(),
    context: () => db.prepare("SELECT * FROM grid_context WHERE station_id=?").bind(id)
      .first<Record<string, unknown>>(),
  }
}

describe("finite ingestion on real D1", () => {
  it("persists a first confirmed baseline without inventing a transition", async () => {
    const f = await fixture()
    expect(await f.refresh()).toEqual({ status: "completed", outcome: "accepted", errorCategory: null })
    expect(await f.snapshot()).toMatchObject({ stationId: f.id, grid: { status: "online" },
      measuredAt: f.input().measuredAt, fetchedAt: f.input().fetchedAt })
    expect((await f.events()).results).toHaveLength(0)
    expect(await f.context()).toMatchObject({ status: "online", observed_at: f.input().measuredAt, gap_since: null })
    expect((await f.polls()).results).toHaveLength(1)
    expect(await f.refresh()).toMatchObject({ status: "throttled" })
    expect(f.calls()).toBe(1)
  })

  it("emits only changes and advances the last-confirmed observation on same-state readings", async () => {
    const f = await fixture()
    await f.refresh()
    await f.next("online")
    await f.refresh()
    const prior = f.input().measuredAt
    await f.next("offline")
    await f.refresh()
    await f.next("online")
    await f.refresh()
    const events = (await f.events()).results
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ status: "offline", previous_status: "online",
      previous_observed_at: prior, gap_since: null })
    expect(events[1]).toMatchObject({ status: "online", previous_status: "offline" })
    expect(events[0]!.idempotency_key).not.toBe(events[1]!.idempotency_key)
  })

  it("preserves confirmed context through unknown observations and records honest gap timing", async () => {
    const f = await fixture()
    await f.refresh()
    const prior = f.input().measuredAt
    await f.next("unknown")
    expect(await f.refresh()).toMatchObject({ outcome: "unverified" })
    expect((await f.events()).results).toHaveLength(0)
    const gap = (await f.context())!.gap_since
    expect(await f.snapshot()).toMatchObject({ grid: { status: "unknown" } })
    await f.next("offline")
    await f.refresh()
    expect((await f.events()).results[0]).toMatchObject({ status: "offline", observed_at: f.input().measuredAt,
      previous_observed_at: prior, gap_since: gap })
    expect(await f.context()).toMatchObject({ status: "offline", gap_since: null })
  })

  it("does not emit restoration when a gap returns to the same confirmed status", async () => {
    const f = await fixture()
    await f.refresh()
    await f.next("unknown")
    await f.refresh()
    await f.next("online")
    await f.refresh()
    expect((await f.events()).results).toHaveLength(0)
    expect(await f.context()).toMatchObject({ gap_since: null })
  })

  it("retains snapshot timestamps and history on equal/backward cloud replays", async () => {
    const f = await fixture()
    await f.refresh()
    const original = await f.snapshot()
    const measuredAt = f.input().measuredAt
    for (const [time, outcome] of [[measuredAt, "replay"], [iso(base - 5000), "backward"]] as const) {
      await f.next("offline", { measuredAt: time })
      expect(await f.refresh()).toMatchObject({ outcome })
      expect(await f.snapshot()).toEqual(original)
    }
    expect((await f.events()).results).toHaveLength(0)
    expect((await f.polls()).results.map((p) => p.outcome)).toEqual(["accepted", "replay", "backward"])
  })

  it.each([null, "invalid", "2099-01-01T00:00:00.000Z"])(
    "preserves the prior snapshot when source time is unavailable: %s", async (measuredAt) => {
      const f = await fixture()
      await f.refresh()
      const previous = await f.snapshot()
      await f.next("offline", { measuredAt })
      await f.refresh()
      expect(await f.snapshot()).toEqual({ ...previous, collectionAvailable: false })
      expect((await f.events()).results).toHaveLength(0)
      expect((await f.polls()).results[1]).toMatchObject({ result: "unavailable" })
    },
  )

  it("persists newer stale telemetry as unknown, without altering confirmed context", async () => {
    const f = await fixture()
    f.setInput({ ...f.input(), measuredAt: iso(base - 500_000) })
    expect(await f.refresh()).toMatchObject({ outcome: "stale" })
    expect(await f.snapshot()).toMatchObject({ freshness: { status: "stale" }, grid: { status: "unknown" } })
    expect(await f.context()).toBeNull()
    expect((await f.events()).results).toHaveLength(0)
  })

  it.each(["auth", "unavailable"] as const)("records %s failures without overwriting state or fabricating events", async (category) => {
    const f = await fixture()
    await f.refresh()
    const previous = await f.snapshot()
    await f.next("offline")
    f.fail(Effect.fail(category === "auth"
      ? new DeyeAuthError({ operation: "device_latest", status: 401, code: null })
      : new DeyeUnavailableError({ operation: "device_latest", status: 503, attempts: 1 })))
    expect(await f.refresh()).toMatchObject({ outcome: "error", errorCategory: category })
    const stored = await f.snapshot()
    expect(stored).toEqual({ ...previous, collectionAvailable: false })
    expect(evaluateSnapshot(stored!, base + 1000)).toMatchObject({
      grid: { status: "unknown" }, freshness: { status: "unavailable" },
      measuredAt: previous!.measuredAt, fetchedAt: previous!.fetchedAt,
    })
    expect((await f.events()).results).toHaveLength(0)
    expect((await f.polls()).results[1]).toMatchObject({ result: "error", error_category: category })
    expect((await f.context())!.gap_since).not.toBeNull()
    f.fail(null)
    await f.next("offline")
    await f.refresh()
    expect((await f.events()).results[0]).toMatchObject({ previous_status: "online", status: "offline" })
  })

  it("aborts the upstream Effect within the budget, records timeout and releases the lease", async () => {
    const f = await fixture()
    let aborted = false
    const source: DeyeServiceShape = { readLatest: () => Effect.tryPromise({
      try: (signal) => new Promise<TelemetrySnapshot>(() => {
        signal.addEventListener("abort", () => { aborted = true }, { once: true })
      }),
      catch: () => new DeyeUnavailableError({ operation: "device_latest", status: null, attempts: 1 }),
    }) }
    const polling = makePollingService(source, f.storage,
      { ...options, workflowBudgetMs: 300, finalizationBudgetMs: 200 })
    expect(await Effect.runPromise(polling.refresh(f.id))).toMatchObject({ outcome: "error", errorCategory: "timeout" })
    expect(aborted).toBe(true)
    expect(await f.snapshot()).toBeNull()
    expect((await f.polls()).results).toHaveLength(1)
    expect((await f.refresh()).status).toBe("throttled")
  })

  it("prevents overlapping workflows from making an extra upstream call", async () => {
    const f = await fixture()
    const slow: DeyeServiceShape = { readLatest: () => Effect.sleep(30).pipe(
      Effect.andThen(f.source.readLatest(f.id)),
    ) }
    const first = makePollingService(slow, f.storage, options, () => base)
    const second = makePollingService(slow, makeIngestionStorage(db, policy), options, () => base)
    const results = await Promise.all([
      Effect.runPromise(first.refresh(f.id)), Effect.runPromise(second.refresh(f.id)),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "completed"])
    expect(f.calls()).toBe(1)
    expect((await f.polls()).results).toHaveLength(1)
  })

  it("rejects malformed normalized readings without persisting invalid rows", async () => {
    const f = await fixture()
    f.setInput({ ...f.input(), battery: { ...f.input().battery, socPercent: 101 } })
    expect(await f.refresh()).toMatchObject({ outcome: "error", errorCategory: "storage" })
    expect(await f.snapshot()).toBeNull()
  })

  it("composes through replacement Layers", async () => {
    const f = await fixture()
    const live = pollingLayer(options).pipe(Layer.provide(Layer.merge(
      Layer.succeed(DeyeService, f.source), ingestionStorageLayer(db, policy),
    )))
    const result = await Effect.runPromise(Effect.gen(function* () {
      const polling = yield* PollingService
      return yield* polling.refresh(f.id)
    }).pipe(Effect.provide(live)))
    // Test timestamps are old enough to be stale with the real service clock.
    expect(result.status).toBe("completed")
    expect(await f.snapshot()).not.toBeNull()
  })

  it("supports a replacement storage Layer and sanitizes storage failures", async () => {
    const f = await fixture()
    const broken: IngestionStorageShape = { ...f.storage,
      persist: () => Effect.fail(new IngestionStorageError()),
    }
    const live = pollingLayer(options).pipe(Layer.provide(Layer.merge(
      Layer.succeed(DeyeService, f.source), Layer.succeed(IngestionStorage, broken),
    )))
    const result = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* PollingService).refresh(f.id)
    }).pipe(Effect.provide(live)))
    expect(result).toMatchObject({ outcome: "error", errorCategory: "storage" })
  })

  it("normalizes a read-only adapter result and stores unknown-only measurements", async () => {
    const f = await fixture()
    const raw = { readLatest: (request: string | { deviceSn: string }) => {
      expect(request).toBe("") // Not the internal station ID.
      return Effect.succeed({ success: true as const, code: "1000000", msg: null,
        fetchedAt: iso(base), deviceDataList: [{ deviceSn: "synthetic-not-real", deviceType: "INVERTER",
          deviceState: 1, collectionTime: Math.floor((base - 1000) / 1000),
          dataList: [{ key: "GridVoltageL1L2", value: "230", unit: "V" }] }] })
    } }
    const service = makePollingService(makeNormalizedDeyeService(raw), f.storage, options, () => base)
    expect(await Effect.runPromise(service.refresh(f.id))).toMatchObject({ outcome: "unverified" })
    expect(await f.snapshot()).toMatchObject({ grid: { status: "unknown", confidence: "unverified", voltageV: 230,
      powerW: null }, battery: { powerW: null, mode: "unknown" } })
    expect((await f.events()).results).toHaveLength(0)
  })

  it("rejects a delayed ingestion worker after lease loss, including its failure metadata", async () => {
    const f = await fixture()
    const delayed: DeyeServiceShape = { readLatest: () => Effect.tryPromise({
      try: async () => {
        await db.prepare("UPDATE refresh_guards SET lease_until=? WHERE station_id=?")
          .bind(iso(base - 1000), f.id).run()
        return f.input()
      },
      catch: () => new DeyeUnavailableError({ operation: "device_latest", status: null, attempts: 1 }),
    }) }
    await expect(Effect.runPromise(makePollingService(delayed, f.storage, options, () => base).refresh(f.id)))
      .rejects.toMatchObject({ _tag: "PollingError", category: "storage" })
    expect(await f.snapshot()).toBeNull()
    expect((await f.polls()).results).toHaveLength(0)
    expect(await f.context()).toBeNull()
  })

  it("rolls snapshot, event and context back together when transition insertion fails", async () => {
    const f = await fixture()
    await f.refresh()
    const original = await f.snapshot()
    const context = await f.context()
    await f.next("offline")
    // Exercise a genuine SQL failure after the snapshot and poll INSERTs.
    const trigger = `reject_event_${f.id.replaceAll("-", "")}`
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON grid_events
      WHEN NEW.station_id = '${f.id}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`).run()
    try {
      expect(await f.refresh()).toMatchObject({ outcome: "error", errorCategory: "storage" })
      expect(await f.snapshot()).toEqual({ ...original, collectionAvailable: false })
      expect(await f.context()).toMatchObject({ status: context!.status, observed_at: context!.observed_at })
      expect((await f.events()).results).toHaveLength(0)
      expect((await f.polls()).results.map((p) => p.result)).toEqual(["success", "error"])
    } finally {
      await db.prepare(`DROP TRIGGER ${trigger}`).run()
    }
    await f.next("offline")
    await f.refresh()
    expect((await f.events()).results).toHaveLength(1)
  })

  it("serves persisted telemetry and degrades authenticated reads after auth failure without upstream traffic", async () => {
    const f = await fixture()
    await f.refresh()
    const app = createApp({ now: () => base + 1000 })
    const environment = { DB: db, API_BEARER_TOKEN: "synthetic-api-token", STATION_ID: f.id }
    const headers = { Authorization: "Bearer synthetic-api-token" }
    const before = await app.request("http://localhost/api/v1/telemetry", { headers }, environment)
    expect(await before.json()).toMatchObject({ ok: true, data: {
      grid: { status: "online" }, measuredAt: f.input().measuredAt, fetchedAt: f.input().fetchedAt,
    } })
    await f.next("offline")
    f.fail(Effect.fail(new DeyeAuthError({ operation: "device_latest", status: 401, code: null })))
    await f.refresh()
    const after = await app.request("http://localhost/api/v1/status", { headers }, environment)
    expect(await after.json()).toMatchObject({ ok: true, data: {
      grid: { status: "unknown" }, freshness: { status: "unavailable" },
    } })
    expect(f.calls()).toBe(2)
    expect(after.headers.get("Cache-Control")).toBe("no-store")
    const health = await app.request("http://localhost/api/v1/health", { headers }, environment)
    expect(await health.json()).toMatchObject({ data: { status: "degraded" } })
  })

  it("composes adapter authentication, normalization, polling and D1 with fake HTTP only", async () => {
    const f = await fixture()
    const calls: string[] = []
    const fakeFetch: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push(path)
      let body: unknown
      if (path === "/v1.0/account/token") {
        body = { code: "1000000", success: true, accessToken: "synthetic-token-never-persist",
          tokenType: "bearer", expiresIn: "5183999" }
      } else if (path === "/v1.0/device/latest") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ deviceList: ["synthetic-inverter"] })
        body = { code: "1000000", success: true, deviceDataList: [{
          deviceSn: "synthetic-inverter", deviceType: "INVERTER", deviceState: 1,
          collectionTime: Math.floor(base / 1000),
          dataList: [{ key: "GridVoltageL1L2", value: "230", unit: "V" },
            { key: "SOC", value: "55", unit: "%" }],
        }] }
      } else {
        throw new Error("Unexpected fake HTTP path")
      }
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    }
    const live = ingestionLayer(db, { baseUrl: "https://eu1-developer.deyecloud.com",
      appId: "synthetic-app-id", appSecret: "synthetic-app-secret", passwordHash: "synthetic-hash",
      email: "synthetic@example.invalid", deviceSn: "synthetic-inverter", deviceType: "INVERTER",
    }, { workflowBudgetMs: 5000, leaseMs: 15_000, minimumIntervalMs: 60_000 },
    1000, 180, { fetch: fakeFetch, now: () => base })
    const result = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* PollingService).refresh(f.id)
    }).pipe(Effect.provide(live)))
    expect(result).toMatchObject({ outcome: "unverified" })
    expect(calls).toEqual(["/v1.0/account/token", "/v1.0/device/latest"])
    expect(await f.snapshot()).toMatchObject({ grid: { status: "unknown", voltageV: 230 },
      battery: { socPercent: 55, powerW: null }, fetchedAt: iso(base) })
    const persisted = JSON.stringify([await f.snapshot(), await f.polls(), await f.events()])
    expect(persisted).not.toMatch(/synthetic-token-never-persist|synthetic-inverter|synthetic-app-secret|synthetic-hash/)
  })

  it("rejects a timing policy that does not reserve finalization and release headroom", async () => {
    expect(() => ingestionLayer(db, undefined, { ...policy, leaseMs: 1200 }, 200, 180))
      .toThrow("Invalid ingestion timing policy")
  })

  it("does not overwrite an already-committed poll or mark a false gap on late timeout metadata", async () => {
    const f = await fixture()
    const acquired = await Effect.runPromise(f.storage.acquire(f.id))
    if (acquired.status !== "acquired") throw new Error("Expected lease")
    const poll = { id: crypto.randomUUID(), startedAt: iso(base), completedAt: iso(base),
      result: "success" as const, outcome: "accepted" as const, latencyMs: 0,
      measuredAt: f.input().measuredAt, errorCategory: null }
    try {
      await Effect.runPromise(f.storage.persist(acquired.lease, f.input(), poll, base, 180))
      await Effect.runPromise(f.storage.recordFailure(acquired.lease, { ...poll,
        result: "error", outcome: "error", errorCategory: "timeout" }))
      expect((await f.polls()).results).toHaveLength(1)
      expect((await f.polls()).results[0]).toMatchObject({ result: "success", outcome: "accepted" })
      expect(await f.context()).toMatchObject({ status: "online", gap_since: null })
      expect(await f.snapshot()).toMatchObject({ collectionAvailable: true })
    } finally {
      await Effect.runPromise(f.storage.release(acquired.lease))
    }
  })
})
