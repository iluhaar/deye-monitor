import { applyD1Migrations, env } from "cloudflare:test"
import type { D1Database } from "@cloudflare/workers-types"
import type { D1Migration } from "@cloudflare/vitest-plugin"
import { Effect } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { makeRefreshGuard, observationKey } from "../src/storage/RefreshGuard"
import type { RefreshLease } from "../src/storage/RefreshGuard"

const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const db = bindings.DB
const policy = { workflowBudgetMs: 90_000, leaseMs: 120_000, minimumIntervalMs: 180_000 }
const observedAt = "2026-01-01T00:00:00.000Z"
const newerAt = "2026-01-01T00:01:00.000Z"
const guard = makeRefreshGuard(db, policy)

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS)
})

async function station(): Promise<string> {
  const id = crypto.randomUUID()
  await db.prepare(`INSERT INTO stations (id, source, mapping_revision, created_at, updated_at)
    VALUES (?, 'deye-cloud', 'test', ?, ?)`).bind(id, observedAt, observedAt).run()
  return id
}

async function acquire(stationId: string): Promise<RefreshLease> {
  const result = await Effect.runPromise(guard.acquire(stationId))
  if (result.status !== "acquired") throw new Error(`unexpected ${result.status}`)
  return result.lease
}

async function expire(stationId: string) {
  await db.prepare(`UPDATE refresh_guards SET lease_until = ?, next_allowed_at = ?
    WHERE station_id = ?`).bind(observedAt, observedAt, stationId).run()
}

function writePoll(stationId: string, id = crypto.randomUUID()) {
  return db.prepare(`INSERT INTO poll_runs (id, station_id, window_key, started_at, result)
    VALUES (?, ?, ?, ?, 'success')`).bind(id, stationId, id, observedAt)
}

async function pollCount(stationId: string) {
  const row = await db.prepare("SELECT count(*) AS count FROM poll_runs WHERE station_id = ?")
    .bind(stationId).first<{ count: number }>()
  return row?.count
}

function writeSnapshot(stationId: string, time: string) {
  return db.prepare(`INSERT INTO latest_snapshots (
    station_id, source, grid_status, grid_evidence_json, grid_confidence,
    battery_mode, measured_at, fetched_at, freshness_status, mapping_revision, stored_at
  ) VALUES (?, 'deye-cloud', 'unknown', '[]', 'unverified', 'unknown', ?, ?, 'stale', 'test', ?)
  ON CONFLICT(station_id) DO UPDATE SET measured_at = excluded.measured_at`)
    .bind(stationId, time, time, time)
}

function writeEvent(stationId: string, time: string) {
  // Synthetic verified evidence exercises storage only, never the Deye classifier.
  return db.prepare(`INSERT INTO grid_events (
    id, station_id, status, observed_at, evidence_json, source, idempotency_key, created_at
  ) VALUES (?, ?, 'online', ?, '["synthetic_signal"]', 'deye-cloud', ?, ?)`)
    .bind(crypto.randomUUID(), stationId, time, observationKey(stationId, time), time)
}

describe("durable refresh protocol on real D1", () => {
  it("applies both migrations and permits only one concurrent acquisition across instances", async () => {
    const id = await station()
    const other = makeRefreshGuard(db, policy)
    const results = await Promise.all([
      Effect.runPromise(guard.acquire(id)), Effect.runPromise(other.acquire(id)),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["acquired", "busy"])
    const winner = results.find((r) => r.status === "acquired")!
    expect(winner.lease.epoch).toBe(1)
    expect(winner.lease.owner).toMatch(/^[0-9a-f-]{36}$/)
    const busy = results.find((r) => r.status === "busy")!
    if (busy.status === "acquired") throw new Error("expected busy")
    expect(busy.retryAfterSeconds).toBeGreaterThan(0)
    expect(busy.retryAfterSeconds).toBeLessThanOrEqual(180)
  })

  it("persists throttling after release, including a failed/no-observation attempt", async () => {
    const id = await station()
    const lease = await acquire(id)
    expect(await Effect.runPromise(guard.release(lease))).toBe(true)
    const next = await Effect.runPromise(makeRefreshGuard(db, policy).acquire(id))
    expect(next.status).toBe("throttled")
    expect(await Effect.runPromise(guard.release(lease))).toBe(false)
  })

  it("does not allow takeover when the lease expired but the throttle has not", async () => {
    const id = await station()
    await acquire(id)
    await db.prepare("UPDATE refresh_guards SET lease_until = ? WHERE station_id = ?")
      .bind(observedAt, id).run()
    expect((await Effect.runPromise(guard.acquire(id))).status).toBe("throttled")
  })

  it("increments the epoch on takeover; delayed workers cannot commit or release the new lease", async () => {
    const id = await station()
    const first = await acquire(id)
    await expire(id)
    const second = await acquire(id)
    expect(second.epoch).toBe(first.epoch + 1)
    expect(second.owner).not.toBe(first.owner)
    await expect(Effect.runPromise(guard.commit(first, [writePoll(id)], observedAt)))
      .rejects.toMatchObject({ _tag: "RefreshGuardError", operation: "commit" })
    expect(await Effect.runPromise(guard.release(first))).toBe(false)
    expect(await pollCount(id)).toBe(0)
    await Effect.runPromise(guard.commit(second, [writePoll(id)], observedAt))
    expect(await pollCount(id)).toBe(1)
  })

  it("rejects expired owners even without takeover", async () => {
    const id = await station()
    const lease = await acquire(id)
    await expire(id)
    await expect(Effect.runPromise(guard.commit(lease, [writePoll(id)], observedAt)))
      .rejects.toMatchObject({ operation: "commit" })
    expect(await pollCount(id)).toBe(0)
  })

  it("rejects forged owner/epoch tokens", async () => {
    const id = await station()
    const lease = await acquire(id)
    for (const forged of [{ ...lease, owner: "other" }, { ...lease, epoch: lease.epoch + 1 }]) {
      await expect(Effect.runPromise(guard.commit(forged, [writePoll(id)], observedAt)))
        .rejects.toMatchObject({ operation: "commit" })
      expect(await Effect.runPromise(guard.release(forged))).toBe(false)
    }
    expect(await pollCount(id)).toBe(0)
  })

  it("accepts only increasing observations; equal/backward/retried payloads never write", async () => {
    const id = await station()
    const lease = await acquire(id)
    await Effect.runPromise(guard.commit(lease, [writePoll(id)], newerAt))
    for (const time of [newerAt, observedAt]) {
      await expect(Effect.runPromise(guard.commit(lease, [writePoll(id)], time)))
        .rejects.toMatchObject({ operation: "commit" })
    }
    expect(await pollCount(id)).toBe(1)
    const watermark = await db.prepare(`SELECT last_observed_at, last_observation_key
      FROM refresh_guards WHERE station_id = ?`).bind(id).first()
    expect(watermark).toEqual({
      last_observed_at: newerAt, last_observation_key: observationKey(id, newerAt),
    })
    await expire(id)
    const next = await acquire(id)
    await expect(Effect.runPromise(guard.commit(next, [writePoll(id)], newerAt)))
      .rejects.toMatchObject({ operation: "commit" })
    await Effect.runPromise(guard.commit(next, [writePoll(id)], "2026-01-01T00:02:00.000Z"))
    expect(await pollCount(id)).toBe(2)
  })

  it("serializes concurrent commits of the same observation", async () => {
    const id = await station()
    const lease = await acquire(id)
    const results = await Promise.allSettled([
      Effect.runPromise(guard.commit(lease, [writePoll(id)], observedAt)),
      Effect.runPromise(guard.commit(lease, [writePoll(id)], observedAt)),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await pollCount(id)).toBe(1)
  })

  it("fences snapshot, event and poll writes together and rejects a duplicate event batch", async () => {
    const id = await station()
    const first = await acquire(id)
    await expire(id)
    const second = await acquire(id)
    const writes = [writeSnapshot(id, newerAt), writeEvent(id, newerAt), writePoll(id)]
    await expect(Effect.runPromise(guard.commit(first, writes, newerAt)))
      .rejects.toMatchObject({ operation: "commit" })
    expect(await db.prepare("SELECT measured_at FROM latest_snapshots WHERE station_id = ?")
      .bind(id).first()).toBeNull()
    expect(await db.prepare("SELECT id FROM grid_events WHERE station_id = ?")
      .bind(id).first()).toBeNull()
    expect(await pollCount(id)).toBe(0)
    await Effect.runPromise(guard.commit(second, writes, newerAt))
    await expect(Effect.runPromise(guard.commit(second,
      [writeSnapshot(id, observedAt), writeEvent(id, observedAt), writePoll(id)], observedAt)))
      .rejects.toMatchObject({ operation: "commit" })
    expect(await db.prepare("SELECT measured_at FROM latest_snapshots WHERE station_id = ?")
      .bind(id).first()).toEqual({ measured_at: newerAt })
    expect(await db.prepare("SELECT count(*) AS count FROM grid_events WHERE station_id = ?")
      .bind(id).first()).toEqual({ count: 1 })
    expect(await pollCount(id)).toBe(1)
  })

  it("honors an existing snapshot even before the guard has a watermark", async () => {
    const id = await station()
    await writeSnapshot(id, newerAt).run()
    const lease = await acquire(id)
    await expect(Effect.runPromise(guard.commit(lease,
      [writeSnapshot(id, observedAt)], observedAt))).rejects.toMatchObject({ operation: "commit" })
    expect(await db.prepare("SELECT measured_at FROM latest_snapshots WHERE station_id = ?")
      .bind(id).first()).toEqual({ measured_at: newerAt })
  })

  it("rolls back writes and watermark on SQL failure, allowing a safe retry", async () => {
    const id = await station()
    const lease = await acquire(id)
    const poll = writePoll(id)
    await expect(Effect.runPromise(guard.commit(lease, [poll, poll], observedAt)))
      .rejects.toMatchObject({ operation: "commit" })
    expect(await pollCount(id)).toBe(0)
    await Effect.runPromise(guard.commit(lease, [poll], observedAt))
    expect(await pollCount(id)).toBe(1)
    expect(await db.prepare("SELECT count(*) AS count FROM refresh_commit_checks").first())
      .toEqual({ count: 0 })
  })

  it("rolls the entire batch back if ownership is lost during its statements", async () => {
    const id = await station()
    const lease = await acquire(id)
    const loseLease = db.prepare("UPDATE refresh_guards SET lease_until = ? WHERE station_id = ?")
      .bind(observedAt, id)
    await expect(Effect.runPromise(guard.commit(lease, [writePoll(id), loseLease], observedAt)))
      .rejects.toMatchObject({ operation: "commit" })
    expect(await pollCount(id)).toBe(0)
    await Effect.runPromise(guard.commit(lease, [writePoll(id)], observedAt))
  })

  it.each(["not-a-date", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00+00:00", "9999-01-01T00:00:00.000Z"])(
    "rejects invalid/noncanonical/future observation time %s", async (time) => {
      const id = await station()
      const lease = await acquire(id)
      await expect(Effect.runPromise(guard.commit(lease, [writePoll(id)], time)))
        .rejects.toMatchObject({ operation: "commit" })
      expect(await pollCount(id)).toBe(0)
    },
  )

  it("fails closed for invalid budgets or missing stations without disclosing SQL", async () => {
    const id = await station()
    for (const bad of [
      { ...policy, leaseMs: policy.workflowBudgetMs },
      { ...policy, minimumIntervalMs: 0 },
      { ...policy, leaseMs: NaN },
    ]) {
      await expect(Effect.runPromise(makeRefreshGuard(db, bad).acquire(id)))
        .rejects.toMatchObject({ _tag: "RefreshGuardError", operation: "acquire" })
    }
    await expect(Effect.runPromise(guard.acquire("missing-secret-station")))
      .rejects.not.toThrow(/missing-secret-station|INSERT|FOREIGN KEY/)
  })
})
