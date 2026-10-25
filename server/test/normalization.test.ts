import { describe, expect, it } from "vitest"
import fixture from "./fixtures/deye-device-latest.json"
import {
  DEYE_DEVICE_LATEST_MAPPING_REVISION,
  normalizeDeyeDeviceLatest,
  type DeyeDeviceLatestResponse,
} from "../src/domain/normalization"
import { evaluateSnapshot } from "../src/domain/grid-status"

const fetchedAt = "2026-10-24T14:15:30.000Z"
const fixturePayload = fixture satisfies DeyeDeviceLatestResponse

function copyFixture(): DeyeDeviceLatestResponse {
  return structuredClone(fixturePayload)
}

function measurement(
  key: string,
  value: string | number | null,
  unit: string | null,
) {
  return { key, value, unit }
}

function withMeasurements(
  payload: DeyeDeviceLatestResponse,
  additions: readonly ReturnType<typeof measurement>[],
): DeyeDeviceLatestResponse {
  const device = payload.deviceDataList[0]

  if (device === undefined) throw new Error("fixture has no device")

  return {
    ...payload,
    deviceDataList: [
      {
        ...device,
        dataList: [...device.dataList, ...additions],
      },
    ],
  }
}

describe("Deye device/latest normalization", () => {
  it("maps the sanitized fixture without approving grid state or power direction", () => {
    const snapshot = normalizeDeyeDeviceLatest(fixturePayload, {
      stationId: "station-internal",
      fetchedAt,
      nowMs: Date.parse("2026-10-24T14:16:00.000Z"),
    })

    expect(snapshot.mappingRevision).toBe(DEYE_DEVICE_LATEST_MAPPING_REVISION)
    expect(snapshot.powerSignConvention).toBe("unverified")
    expect(snapshot.grid).toEqual({
      status: "unknown",
      confidence: "unverified",
      evidence: ["grid_voltage", "grid_frequency"],
      voltageV: 221.1,
      frequencyHz: 50.01,
      powerW: null,
    })
    expect(snapshot.battery).toEqual({
      socPercent: 100,
      powerW: null,
      mode: "unknown",
    })
    expect(snapshot.home.powerW).toBe(27)
    expect(snapshot.measuredAt).toBe("2026-10-24T14:15:17.000Z")
    expect(snapshot.fetchedAt).toBe(fetchedAt)
    expect(snapshot.freshness).toEqual({ status: "fresh", ageSeconds: 43 })
  })

  it("does not mutate the upstream payload", () => {
    const input = copyFixture()
    const before = structuredClone(input)

    normalizeDeyeDeviceLatest(input, "station-internal", fetchedAt)

    expect(input).toEqual(before)
  })

  it("keeps absent measurements null instead of zero-filling them", () => {
    const input = copyFixture()
    const device = input.deviceDataList[0]

    if (device === undefined) throw new Error("fixture has no device")

    const missing = new Set([
      "GridVoltageL1L2",
      "GridFrequency",
      "SOC",
      "TotalConsumptionPower",
    ])

    const payload: DeyeDeviceLatestResponse = {
      ...input,
      deviceDataList: [
        {
          ...device,
          dataList: device.dataList.filter(({ key }) => !missing.has(key)),
        },
      ],
    }

    const snapshot = normalizeDeyeDeviceLatest(payload, {
      stationId: "station-internal",
      fetchedAt,
    })

    expect(snapshot.grid.voltageV).toBeNull()
    expect(snapshot.grid.frequencyHz).toBeNull()
    expect(snapshot.grid.evidence).toEqual([])
    expect(snapshot.battery.socPercent).toBeNull()
    expect(snapshot.home.powerW).toBeNull()
  })

  it("does not equate contradictory grid power candidates", () => {
    const snapshot = normalizeDeyeDeviceLatest(fixturePayload, {
      stationId: "station-internal",
      fetchedAt,
    })

    expect(snapshot.grid.powerW).toBeNull()
    expect(snapshot.battery.powerW).toBeNull()
  })

  it("rejects contradictory duplicate values rather than choosing by order", () => {
    const payload = withMeasurements(fixturePayload, [
      measurement("GridVoltageL1L2", "220.00", "V"),
    ])

    const snapshot = normalizeDeyeDeviceLatest(payload, {
      stationId: "station-internal",
      fetchedAt,
    })

    expect(snapshot.grid.voltageV).toBeNull()
    expect(snapshot.grid.evidence).toEqual(["grid_frequency"])
  })

  it("does not infer an outage from zero flow", () => {
    const input = copyFixture()
    const device = input.deviceDataList[0]

    if (device === undefined) throw new Error("fixture has no device")

    const zeroFlowKeys = new Set([
      "TotalGridPower",
      "ExternalCTPowerL1L2",
      "BatteryPower",
      "TotalConsumptionPower",
    ])

    const payload: DeyeDeviceLatestResponse = {
      ...input,
      deviceDataList: [
        {
          ...device,
          dataList: device.dataList.map((item) =>
            zeroFlowKeys.has(item.key) ? { ...item, value: "0" } : item,
          ),
        },
      ],
    }

    const snapshot = normalizeDeyeDeviceLatest(payload, {
      stationId: "station-internal",
      fetchedAt,
    })

    expect(snapshot.grid.status).toBe("unknown")
    expect(snapshot.grid.confidence).toBe("unverified")
    expect(snapshot.grid.powerW).toBeNull()
    expect(snapshot.battery.mode).toBe("unknown")
  })

  it("treats malformed values and units as unavailable measurements", () => {
    const payload = withMeasurements(fixturePayload, [
      measurement("GridVoltageL1L2", "221.10", "A"),
      measurement("GridFrequency", "not-a-number", "Hz"),
      measurement("SOC", "101", "%"),
      measurement("SOC", "100", null),
    ])

    const snapshot = normalizeDeyeDeviceLatest(payload, {
      stationId: "station-internal",
      fetchedAt,
    })

    expect(snapshot.grid.voltageV).toBeNull()
    expect(snapshot.grid.frequencyHz).toBeNull()
    expect(snapshot.battery.socPercent).toBeNull()
  })

  it("rejects ambiguous millisecond-looking collection times", () => {
    const input = copyFixture()
    const device = input.deviceDataList[0]

    if (device === undefined) throw new Error("fixture has no device")

    const payload: DeyeDeviceLatestResponse = {
      ...input,
      deviceDataList: [
        { ...device, collectionTime: "1792851317000" },
      ],
    }

    const snapshot = normalizeDeyeDeviceLatest(payload, {
      stationId: "station-internal",
      fetchedAt,
      nowMs: Date.parse("2026-10-24T14:16:00.000Z"),
    })

    expect(snapshot.measuredAt).toBeNull()
    expect(snapshot.freshness).toEqual({
      status: "unavailable",
      ageSeconds: null,
    })
  })

  it("uses the origin Unix seconds as UTC and lets the evaluator reject stale data", () => {
    const snapshot = normalizeDeyeDeviceLatest(fixturePayload, {
      stationId: "station-internal",
      fetchedAt,
      nowMs: Date.parse("2026-10-24T14:20:00.000Z"),
      freshnessThresholdSeconds: 180,
    })

    expect(snapshot.measuredAt).toBe("2026-10-24T14:15:17.000Z")
    expect(snapshot.freshness).toEqual({ status: "stale", ageSeconds: 283 })
    expect(evaluateSnapshot(snapshot, Date.parse("2026-10-24T14:20:00.000Z")).grid.status).toBe(
      "unknown",
    )
  })

  it.each([
    {
      name: "measured timestamp is in the future",
      collectionTime: 1792851360,
      fetchedAt: "2026-10-24T14:15:30.000Z",
      nowMs: Date.parse("2026-10-24T14:15:45.000Z"),
      reason: "future_timestamp",
    },
    {
      name: "measured timestamp is after fetchedAt",
      collectionTime: 1792851340,
      fetchedAt: "2026-10-24T14:15:30.000Z",
      nowMs: Date.parse("2026-10-24T14:16:00.000Z"),
      reason: "inconsistent_timestamp",
    },
  ])("lets the existing evaluator reject $name", (testCase) => {
    const input = copyFixture()
    const device = input.deviceDataList[0]

    if (device === undefined) throw new Error("fixture has no device")

    const payload: DeyeDeviceLatestResponse = {
      ...input,
      deviceDataList: [{ ...device, collectionTime: testCase.collectionTime }],
    }

    const snapshot = normalizeDeyeDeviceLatest(payload, {
      stationId: "station-internal",
      fetchedAt: testCase.fetchedAt,
      nowMs: testCase.nowMs,
    })

    expect(snapshot.freshness.status).toBe("unavailable")
    const evaluated = evaluateSnapshot(snapshot, testCase.nowMs)
    expect(evaluated.freshness.status).toBe("unavailable")
    expect(evaluated.grid.status).toBe("unknown")
  })

  it.each(["9999999", 9999999])(
    "rejects a non-success device/latest code without echoing it",
    (code) => {
      expect(() =>
        normalizeDeyeDeviceLatest(
          { ...fixturePayload, code },
          { stationId: "station-internal", fetchedAt },
        ),
      ).toThrowError("device/latest response has an unsupported success code")
    },
  )

  it("allows an omitted response code for sanitized adapter payloads", () => {
    const snapshot = normalizeDeyeDeviceLatest(
      { ...fixturePayload, code: undefined },
      { stationId: "station-internal", fetchedAt },
    )

    expect(snapshot.grid.status).toBe("unknown")
  })

  it.each(["BATTERY", "COLLECTOR"])(
    "rejects a singleton explicitly typed %s device",
    (deviceType) => {
      const device = fixturePayload.deviceDataList[0]

      if (device === undefined) throw new Error("fixture has no device")

      const payload: DeyeDeviceLatestResponse = {
        ...fixturePayload,
        deviceDataList: [{ ...device, deviceType }],
      }

      expect(() =>
        normalizeDeyeDeviceLatest(payload, {
          stationId: "station-internal",
          fetchedAt,
        }),
      ).toThrowError("device/latest response contains a non-inverter device")
    },
  )

  it("keeps deliberate compatibility for a singleton with omitted type", () => {
    const device = fixturePayload.deviceDataList[0]

    if (device === undefined) throw new Error("fixture has no device")

    const payload: DeyeDeviceLatestResponse = {
      ...fixturePayload,
      deviceDataList: [{ ...device, deviceType: undefined }],
    }

    expect(
      normalizeDeyeDeviceLatest(payload, {
        stationId: "station-internal",
        fetchedAt,
      }).measuredAt,
    ).toBe("2026-10-24T14:15:17.000Z")
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite nowMs (%s)",
    (nowMs) => {
      expect(() =>
        normalizeDeyeDeviceLatest(fixturePayload, {
          stationId: "station-internal",
          fetchedAt,
          nowMs,
        }),
      ).toThrowError("nowMs must be a finite number when present")
    },
  )

  it("fails closed for an unsuccessful upstream envelope", () => {
    expect(() =>
      normalizeDeyeDeviceLatest(
        { ...fixturePayload, success: false },
        { stationId: "station-internal", fetchedAt },
      ),
    ).toThrowError("device/latest response was not successful")
  })
})
