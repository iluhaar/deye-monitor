import {
  evaluateFreshness,
  type FreshnessEvaluation,
} from "./grid-status"
import type {
  FreshnessInfo,
  PowerSignConvention as TelemetryPowerSignConvention,
  TelemetrySnapshot,
} from "./telemetry"

/**
 * The mapping is intentionally versioned separately from the upstream API
 * version.  This revision only describes fields that are safe to retain; it
 * does not approve a grid-state or directional-power mapping.
 */
export const DEYE_DEVICE_LATEST_MAPPING_REVISION =
  "deye-device-latest-unverified-v1" as const

export const UNVERIFIED_POWER_SIGN_CONVENTION = "unverified" as const

export type PowerSignConvention = TelemetryPowerSignConvention

/** The flexible measurement item returned by device/latest. */
export interface DeyeLatestMeasurement {
  readonly key: string
  readonly value: string | number | null
  readonly unit: string | null
}

/** The device item returned by device/latest. */
export interface DeyeLatestDevice {
  readonly deviceSn?: string | null
  readonly deviceType?: string | null
  readonly deviceState?: string | number | null
  readonly collectionTime?: string | number | null
  readonly dataList: readonly DeyeLatestMeasurement[]
}

/** The response envelope used by the sanitized device/latest fixture. */
export interface DeyeDeviceLatestResponse {
  readonly code?: string | number | null
  readonly msg?: string | null
  readonly success?: boolean
  /** Present on the adapter's sanitized result; absent in the raw fixture. */
  readonly fetchedAt?: string
  readonly deviceDataList: readonly DeyeLatestDevice[]
}

export interface NormalizeDeyeDeviceLatestOptions {
  /** Internal station key; upstream serials are deliberately not emitted. */
  readonly stationId: string
  /** Server receive time, supplied by the caller rather than sampled here. */
  readonly fetchedAt?: string
  /** Override only when versioning a deliberately different mapping. */
  readonly mappingRevision?: string
  /** Optional clock used to populate freshness metadata without hidden I/O. */
  readonly nowMs?: number
  readonly freshnessThresholdSeconds?: number
}

/**
 * A normalized snapshot carries provenance for persistence while remaining
 * assignable to the existing TelemetrySnapshot contract.
 */
export interface NormalizedTelemetrySnapshot extends TelemetrySnapshot {
  readonly mappingRevision: string
  readonly powerSignConvention: PowerSignConvention
}

export type DeyeNormalizationOptions = NormalizeDeyeDeviceLatestOptions

interface ValidatedNormalizeDeyeDeviceLatestOptions {
  readonly stationId: string
  readonly fetchedAt: string
  readonly mappingRevision: string
  readonly nowMs?: number
  readonly freshnessThresholdSeconds?: number
}

export class TelemetryNormalizationError extends Error {
  readonly code: "invalid_payload" | "invalid_options" | "ambiguous_device"

  constructor(
    message: string,
    code: TelemetryNormalizationError["code"] = "invalid_payload",
  ) {
    super(message)
    this.name = "TelemetryNormalizationError"
    this.code = code
  }
}

type RecordLike = Record<string, unknown>

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidPayload(message: string): never {
  throw new TelemetryNormalizationError(message, "invalid_payload")
}

function invalidOptions(message: string): never {
  throw new TelemetryNormalizationError(message, "invalid_options")
}

function ambiguousDevice(message: string): never {
  throw new TelemetryNormalizationError(message, "ambiguous_device")
}

function optionalString(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== "string") invalidPayload(`${field} must be a string`)
  return value
}

function optionalScalar(
  value: unknown,
  field: string,
): string | number | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== "string" && typeof value !== "number") {
    invalidPayload(`${field} must be a string, number, or null`)
  }
  return value
}

function readMeasurement(value: unknown, index: number): DeyeLatestMeasurement {
  if (!isRecord(value)) {
    return invalidPayload(`dataList[${index}] must be an object`)
  }

  const key = value.key
  if (typeof key !== "string" || key.trim() === "") {
    return invalidPayload(`dataList[${index}].key must be a non-empty string`)
  }

  const rawUnit = value.unit
  if (rawUnit !== undefined && rawUnit !== null && typeof rawUnit !== "string") {
    return invalidPayload(`dataList[${index}].unit must be a string or null`)
  }

  const rawValue = value.value
  if (
    rawValue !== undefined &&
    rawValue !== null &&
    typeof rawValue !== "string" &&
    typeof rawValue !== "number"
  ) {
    return invalidPayload(
      `dataList[${index}].value must be a string, number, or null`,
    )
  }

  return {
    key,
    value: rawValue === undefined ? null : rawValue,
    unit: rawUnit === undefined ? null : rawUnit,
  }
}

function readDevice(value: unknown, index: number): DeyeLatestDevice {
  if (!isRecord(value)) {
    return invalidPayload(`deviceDataList[${index}] must be an object`)
  }

  const deviceSn = optionalString(value.deviceSn, `deviceDataList[${index}].deviceSn`)
  const deviceType = optionalString(
    value.deviceType,
    `deviceDataList[${index}].deviceType`,
  )
  const deviceState = optionalScalar(
    value.deviceState,
    `deviceDataList[${index}].deviceState`,
  )
  const collectionTime = optionalScalar(
    value.collectionTime,
    `deviceDataList[${index}].collectionTime`,
  )
  const rawDataList = value.dataList
  if (!Array.isArray(rawDataList)) {
    return invalidPayload(`deviceDataList[${index}].dataList must be an array`)
  }

  return {
    deviceSn,
    deviceType,
    deviceState,
    collectionTime,
    dataList: rawDataList.map(readMeasurement),
  }
}

function readResponse(value: unknown): DeyeDeviceLatestResponse {
  if (!isRecord(value)) return invalidPayload("device/latest response must be an object")

  if (value.success !== undefined && typeof value.success !== "boolean") {
    return invalidPayload("success must be a boolean when present")
  }
  if (value.success === false) {
    return invalidPayload("device/latest response was not successful")
  }
  if (
    value.code !== undefined &&
    value.code !== null &&
    typeof value.code !== "string" &&
    typeof value.code !== "number"
  ) {
    return invalidPayload("code must be a string or number when present")
  }
  if (
    value.code !== undefined &&
    value.code !== null &&
    value.code !== "1000000" &&
    value.code !== 1000000
  ) {
    return invalidPayload("device/latest response has an unsupported success code")
  }
  if (value.msg !== undefined && value.msg !== null && typeof value.msg !== "string") {
    return invalidPayload("msg must be a string when present")
  }

  if (!Array.isArray(value.deviceDataList)) {
    return invalidPayload("deviceDataList must be an array")
  }
  if (value.deviceDataList.length === 0) {
    return invalidPayload("deviceDataList must contain a device")
  }

  return {
    code: value.code as string | number | null | undefined,
    msg: value.msg as string | null | undefined,
    success: value.success as boolean | undefined,
    fetchedAt: value.fetchedAt as string | undefined,
    deviceDataList: value.deviceDataList.map(readDevice),
  }
}

function chooseDevice(devices: readonly DeyeLatestDevice[]): DeyeLatestDevice {
  const inverters = devices.filter(
    (device) => device.deviceType?.trim().toUpperCase() === "INVERTER",
  )
  if (inverters.length === 1) return inverters[0]
  if (inverters.length > 1) {
    return ambiguousDevice(
      "device/latest response contains more than one possible inverter",
    )
  }

  // Some older callers omit deviceType while passing a single already-scoped
  // device. Keep that compatibility deliberately; an explicit non-INVERTER
  // type must never be treated as an inverter.
  if (devices.length === 1) {
    const only = devices[0]
    if (only.deviceType === undefined || only.deviceType === null) return only
    return invalidPayload("device/latest response contains a non-inverter device")
  }

  return ambiguousDevice(
    "device/latest response contains no uniquely identified inverter",
  )
}

/**
 * Device/latest declares collectionTime as Unix seconds.  Millisecond-looking
 * values are not silently divided: they are ambiguous and therefore treated
 * as an unavailable origin timestamp.
 */
function sourceTimestamp(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) return null

  const text =
    typeof value === "number" ? String(value) : value.trim()
  if (!/^\d+$/.test(text)) return null

  const seconds = Number(text)
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > 9_999_999_999
  ) {
    return null
  }

  const millis = seconds * 1000
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function canonicalFetchedAt(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalidOptions("fetchedAt must be a non-empty ISO timestamp")
  }

  const trimmed = value.trim()
  // A timezone-less local timestamp is ambiguous in a Worker and is rejected.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    return invalidOptions("fetchedAt must include an explicit timezone")
  }

  const millis = Date.parse(trimmed)
  if (!Number.isFinite(millis)) {
    return invalidOptions("fetchedAt must be a valid timestamp")
  }
  return new Date(millis).toISOString()
}

function normalizeOptions(
  options: NormalizeDeyeDeviceLatestOptions,
  payloadFetchedAt?: string,
): ValidatedNormalizeDeyeDeviceLatestOptions {
  if (!isRecord(options)) return invalidOptions("normalization options are required")

  const stationId = options.stationId
  if (typeof stationId !== "string" || stationId.trim() === "") {
    return invalidOptions("stationId must be a non-empty string")
  }

  const mappingRevision = options.mappingRevision ?? DEYE_DEVICE_LATEST_MAPPING_REVISION
  if (typeof mappingRevision !== "string" || mappingRevision.trim() === "") {
    return invalidOptions("mappingRevision must be a non-empty string")
  }

  if (
    options.nowMs !== undefined &&
    (typeof options.nowMs !== "number" || !Number.isFinite(options.nowMs))
  ) {
    return invalidOptions("nowMs must be a finite number when present")
  }
  if (
    options.freshnessThresholdSeconds !== undefined &&
    (typeof options.freshnessThresholdSeconds !== "number" ||
      !Number.isFinite(options.freshnessThresholdSeconds) ||
      options.freshnessThresholdSeconds < 0)
  ) {
    return invalidOptions(
      "freshnessThresholdSeconds must be a non-negative finite number",
    )
  }

  const fetchedAt = options.fetchedAt ?? payloadFetchedAt
  if (fetchedAt === undefined) {
    return invalidOptions("fetchedAt is required")
  }

  return {
    stationId: stationId.trim(),
    fetchedAt: canonicalFetchedAt(fetchedAt),
    mappingRevision: mappingRevision.trim(),
    nowMs: options.nowMs,
    freshnessThresholdSeconds: options.freshnessThresholdSeconds,
  }
}

const NUMERIC_STRING =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

function finiteNumber(value: string | number | null): number | null {
  if (value === null) return null
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  const trimmed = value.trim()
  if (!NUMERIC_STRING.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

type MeasurementPredicate = (value: number) => boolean

/**
 * A duplicate measurement is accepted only when every copy has the same
 * validated unit and value.  Contradictory copies are not resolved by order.
 */
function measurementValue(
  measurements: readonly DeyeLatestMeasurement[],
  key: string,
  unit: string,
  predicate: MeasurementPredicate = () => true,
): number | null {
  const matches = measurements.filter((measurement) => measurement.key === key)
  if (matches.length === 0) return null

  const values: number[] = []
  for (const measurement of matches) {
    if (measurement.unit !== unit) return null
    const value = finiteNumber(measurement.value)
    if (value === null || !predicate(value)) return null
    values.push(value)
  }

  const first = values[0]
  return values.every((value) => value === first) ? first : null
}

function freshnessInfo(evaluation: FreshnessEvaluation): FreshnessInfo {
  return {
    status: evaluation.status,
    ageSeconds: evaluation.ageSeconds,
  }
}

function initialFreshness(
  measuredAt: string | null,
  fetchedAt: string,
  options: ValidatedNormalizeDeyeDeviceLatestOptions,
): FreshnessInfo {
  if (options.nowMs === undefined) {
    return { status: "unavailable", ageSeconds: null }
  }

  return freshnessInfo(
    evaluateFreshness(
      { measuredAt, fetchedAt },
      options.nowMs,
      options.freshnessThresholdSeconds,
    ),
  )
}

function optionsFromArguments(
  optionsOrStationId: NormalizeDeyeDeviceLatestOptions | string,
  fetchedAt: string | undefined,
  nowMs: number | undefined,
): NormalizeDeyeDeviceLatestOptions {
  if (typeof optionsOrStationId !== "string") return optionsOrStationId
  return { stationId: optionsOrStationId, fetchedAt, nowMs }
}

export function normalizeDeyeDeviceLatest(
  payload: unknown,
  options: NormalizeDeyeDeviceLatestOptions,
): NormalizedTelemetrySnapshot
export function normalizeDeyeDeviceLatest(
  payload: unknown,
  stationId: string,
  fetchedAt: string,
  nowMs?: number,
): NormalizedTelemetrySnapshot
export function normalizeDeyeDeviceLatest(
  payload: unknown,
  optionsOrStationId: NormalizeDeyeDeviceLatestOptions | string,
  fetchedAt?: string,
  nowMs?: number,
): NormalizedTelemetrySnapshot {
  const response = readResponse(payload)
  const options = normalizeOptions(
    optionsFromArguments(optionsOrStationId, fetchedAt, nowMs),
    response.fetchedAt,
  )
  const device = chooseDevice(response.deviceDataList)
  const measurements = device.dataList
  const measuredAt = sourceTimestamp(device.collectionTime)

  const voltageV = measurementValue(
    measurements,
    "GridVoltageL1L2",
    "V",
    (value) => value >= 0,
  )
  const frequencyHz = measurementValue(
    measurements,
    "GridFrequency",
    "Hz",
    (value) => value >= 0,
  )
  const socPercent = measurementValue(
    measurements,
    "SOC",
    "%",
    (value) => value >= 0 && value <= 100,
  )

  // TotalConsumptionPower is a load magnitude, not a directional grid or
  // battery flow.  Do not substitute UPSLoadPower or any other similarly
  // valued field when this exact measurement is absent.
  const homePowerW = measurementValue(
    measurements,
    "TotalConsumptionPower",
    "W",
    (value) => value >= 0,
  )

  const evidence: string[] = []
  if (voltageV !== null) evidence.push("grid_voltage")
  if (frequencyHz !== null) evidence.push("grid_frequency")

  return {
    source: "deye-cloud",
    stationId: options.stationId,
    mappingRevision: options.mappingRevision ?? DEYE_DEVICE_LATEST_MAPPING_REVISION,
    powerSignConvention: UNVERIFIED_POWER_SIGN_CONVENTION,
    grid: {
      // No field in this fixture has an approved utility-grid classification.
      status: "unknown",
      evidence,
      confidence: "unverified",
      voltageV,
      frequencyHz,
      // TotalGridPower and ExternalCTPowerL1L2 have different, unverified
      // semantics and signs.  Neither is a normalized grid power value.
      powerW: null,
    },
    battery: {
      socPercent,
      // BatteryPower is signed, but its charge/discharge direction is not
      // established by the supplied evidence.
      powerW: null,
      mode: "unknown",
    },
    home: { powerW: homePowerW },
    measuredAt,
    fetchedAt: options.fetchedAt,
    freshness: initialFreshness(measuredAt, options.fetchedAt, options),
  }
}

/** Descriptive alias for callers that use the domain term rather than API path. */
export const normalizeDeyeTelemetry = normalizeDeyeDeviceLatest

/** Alias matching the adapter's `DeyeLatest` result name. */
export const normalizeDeyeLatest = normalizeDeyeDeviceLatest
