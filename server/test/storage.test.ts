import type { D1Database } from "@cloudflare/workers-types"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeD1Storage } from "../src/storage/D1Live"

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    source: "deye-cloud",
    station_id: "station-1",
    grid_status: "online",
    grid_evidence_json: '["grid_voltage"]',
    grid_confidence: "confirmed",
    grid_voltage_v: 230,
    grid_frequency_hz: 50,
    grid_power_w: 0,
    battery_soc_percent: 50,
    battery_power_w: 0,
    battery_mode: "idle",
    home_power_w: 100,
    measured_at: "2026-10-24T11:59:00.000Z",
    fetched_at: "2026-10-24T11:59:30.000Z",
    freshness_status: "fresh",
    ...overrides,
  }
}

function eventRow(id: string, observedAt: string) {
  return {
    id,
    station_id: "station-1",
    status: "online",
    observed_at: observedAt,
    previous_status: null,
    previous_observed_at: null,
    evidence_json: '["grid_voltage"]',
    source: "deye-cloud",
  }
}

function database(firstValue: unknown, eventRows: readonly unknown[] = []) {
  const prepared: Array<{ sql: string; values: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      const state = { sql, values: [] as unknown[] }
      prepared.push(state)
      return {
        bind(...values: unknown[]) {
          state.values = values
          return {
            first: async <T>() => firstValue as T,
            all: async <T>() => ({ results: eventRows as T[] }),
          }
        },
      }
    },
  }
  return { db: db as unknown as D1Database, prepared }
}

describe("D1 storage boundary", () => {
  it.each([
    { grid_voltage_v: Number.POSITIVE_INFINITY },
    { battery_power_w: Number.NEGATIVE_INFINITY },
    { home_power_w: Number.NaN },
  ])("rejects non-finite persisted numeric fields", async (numericField) => {
    const { db } = database(snapshotRow(numericField))
    const storage = makeD1Storage(db)

    await expect(
      Effect.runPromise(storage.getLatestSnapshot("station-1")),
    ).rejects.toMatchObject({ _tag: "StorageError", operation: "read_snapshot" })
  })

  it.each([-1, 101, Number.POSITIVE_INFINITY])(
    "rejects persisted battery SOC outside 0..100: %s",
    async (socPercent) => {
      const { db } = database(snapshotRow({ battery_soc_percent: socPercent }))
      const storage = makeD1Storage(db)

      await expect(
        Effect.runPromise(storage.getLatestSnapshot("station-1")),
      ).rejects.toMatchObject({ _tag: "StorageError", operation: "read_snapshot" })
    },
  )

  it("accepts a nullable battery SOC", async () => {
    const { db } = database(snapshotRow({ battery_soc_percent: null }))
    const storage = makeD1Storage(db)

    const snapshot = await Effect.runPromise(
      storage.getLatestSnapshot("station-1"),
    )
    expect(snapshot?.battery.socPercent).toBeNull()
  })

  it("validates persisted snapshot JSON and sanitizes malformed rows", async () => {
    const { db } = database(snapshotRow({ grid_evidence_json: "not-json" }))
    const storage = makeD1Storage(db)

    const result = storage.getLatestSnapshot("station-1")
    await expect(Effect.runPromise(result)).rejects.toMatchObject({
      _tag: "StorageError",
      operation: "read_snapshot",
    })
    await expect(Effect.runPromise(result)).rejects.not.toMatchObject({
      message: expect.stringContaining("not-json"),
    })
  })

  it("maps driver failures to a typed, non-sensitive storage error", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              first: async () => {
                throw new Error("SELECT token=secret")
              },
            }
          },
        }
      },
    } as unknown as D1Database
    const storage = makeD1Storage(db)

    await expect(Effect.runPromise(storage.getLatestSnapshot("station-1"))).rejects.toMatchObject({
      _tag: "StorageError",
      operation: "read_snapshot",
    })
    await expect(Effect.runPromise(storage.getLatestSnapshot("station-1"))).rejects.not.toMatchObject({
      message: expect.stringContaining("token=secret"),
    })
  })

  it("uses a deterministic id tie-breaker for event pagination", async () => {
    const sameTime = "2026-10-24T11:00:00.000Z"
    const { db, prepared } = database(null, [
      eventRow("event-b", sameTime),
      eventRow("event-a", sameTime),
    ])
    const storage = makeD1Storage(db)

    const page = await Effect.runPromise(
      storage.listEvents({
        stationId: "station-1",
        limit: 1,
        cursor: { observedAt: sameTime, id: "event-z" },
        from: null,
        to: null,
      }),
    )

    expect(prepared[0].sql).toContain("ORDER BY observed_at DESC, id DESC")
    expect(prepared[0].sql).toContain("observed_at = ? AND id < ?")
    expect(prepared[0].values).toEqual(["station-1", sameTime, sameTime, "event-z", 2])
    expect(page.events).toHaveLength(1)
    expect(page.nextCursor).toEqual({ observedAt: sameTime, id: "event-b" })
  })

  it("validates malformed persisted event evidence", async () => {
    const { db } = database(null, [
      { ...eventRow("event-1", "2026-10-24T11:00:00.000Z"), evidence_json: "not-json" },
    ])
    const storage = makeD1Storage(db)

    await expect(
      Effect.runPromise(
        storage.listEvents({
          stationId: "station-1",
          limit: 25,
          cursor: null,
          from: null,
          to: null,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "StorageError", operation: "read_events" })
  })

  it.each([
    {
      name: "observed_at",
      row: eventRow("event-1", "2026-10-24T11:00:00Z"),
    },
    {
      name: "previous_observed_at",
      row: {
        ...eventRow("event-1", "2026-10-24T11:00:00.000Z"),
        previous_status: "offline",
        previous_observed_at: "2026-10-24T10:00:00Z",
      },
    },
  ])("rejects noncanonical persisted $name timestamps", async ({ row }) => {
    const { db } = database(null, [row])
    const storage = makeD1Storage(db)

    await expect(
      Effect.runPromise(
        storage.listEvents({
          stationId: "station-1",
          limit: 25,
          cursor: null,
          from: null,
          to: null,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "StorageError", operation: "read_events" })
  })

  it("rejects incoherent prior event fields", async () => {
    const { db } = database(null, [
      {
        ...eventRow("event-1", "2026-10-24T11:00:00.000Z"),
        previous_status: "offline",
        previous_observed_at: "2026-10-24T12:00:00.000Z",
      },
    ])
    const storage = makeD1Storage(db)

    await expect(
      Effect.runPromise(
        storage.listEvents({
          stationId: "station-1",
          limit: 25,
          cursor: null,
          from: null,
          to: null,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "StorageError", operation: "read_events" })
  })
})
