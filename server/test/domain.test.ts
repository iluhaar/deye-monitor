import { describe, expect, it } from "vitest"
import {
  evaluateFreshness,
  evaluateSnapshot,
} from "../src/domain/grid-status"
import { makeSnapshot, NOW } from "./helpers"

describe("conservative freshness and grid evaluation", () => {
  it.each([
    ["online", "grid_voltage"],
    ["online", "grid_frequency"],
    ["offline", "grid_connected_status"],
  ] as const)(
    "accepts a fresh confirmed %s state from %s evidence",
    (status, evidence) => {
      const evaluated = evaluateSnapshot(
        makeSnapshot({
          grid: {
            status,
            confidence: "confirmed",
            evidence: [evidence],
            voltageV: status === "online" ? 230 : null,
            frequencyHz: status === "online" ? 50 : null,
            powerW: 0,
          },
        }),
        NOW,
      )

      expect(evaluated.freshness).toEqual({ status: "fresh", ageSeconds: 60 })
      expect(evaluated.grid.status).toBe(status)
      expect(evaluated.grid.confidence).toBe("confirmed")
    },
  )

  it("degrades stale data to unknown without mutating the stored snapshot", () => {
    const stored = makeSnapshot({
      measuredAt: "2026-10-24T11:56:59.000Z",
    })
    const evaluated = evaluateSnapshot(stored, NOW)

    expect(evaluated.freshness.status).toBe("stale")
    expect(evaluated.grid.status).toBe("unknown")
    expect(stored.grid.status).toBe("online")
    expect(stored.freshness).toEqual({ status: "fresh", ageSeconds: 60 })
  })

  it("treats missing timestamps as unavailable and unknown", () => {
    const evaluated = evaluateSnapshot(
      makeSnapshot({ measuredAt: null }),
      NOW,
    )

    expect(evaluated.freshness).toEqual({
      status: "unavailable",
      ageSeconds: null,
    })
    expect(evaluated.grid.status).toBe("unknown")
  })

  it.each([
    {
      measuredAt: "2026-10-24T12:00:01.000Z",
      fetchedAt: "2026-10-24T11:59:30.000Z",
    },
    {
      measuredAt: "2026-10-24T11:59:00.000Z",
      fetchedAt: "2026-10-24T12:00:01.000Z",
    },
  ])("rejects future or inconsistent timestamps", (timestamps) => {
    const evaluated = evaluateSnapshot(makeSnapshot(timestamps), NOW)

    expect(evaluated.freshness.status).toBe("unavailable")
    expect(evaluated.grid.status).toBe("unknown")
  })

  it("rejects a measured timestamp later than fetchedAt", () => {
    const freshness = evaluateFreshness(
      {
        measuredAt: "2026-10-24T11:59:40.000Z",
        fetchedAt: "2026-10-24T11:59:30.000Z",
      },
      NOW,
    )

    expect(freshness.status).toBe("unavailable")
    expect(freshness.reason).toBe("inconsistent_timestamp")
  })

  it.each([
    {
      reason: "unverified evidence",
      confidence: "unverified" as const,
      evidence: ["grid_voltage"],
      voltageV: 230,
      frequencyHz: 50,
      powerW: 250,
    },
    {
      reason: "grid power or zero flow",
      confidence: "confirmed" as const,
      evidence: ["grid_power"],
      voltageV: null,
      frequencyHz: null,
      powerW: 0,
    },
  ])("does not infer an outage from $reason", (grid) => {
    const evaluated = evaluateSnapshot(
      makeSnapshot({
        grid: {
          status: "offline",
          ...grid,
        },
      }),
      NOW,
    )

    expect(evaluated.grid.status).toBe("unknown")
  })
})
