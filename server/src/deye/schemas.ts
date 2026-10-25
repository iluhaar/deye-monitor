import { Schema } from "effect"
import {
  DeyeAuthError,
  DeyeRateLimitError,
  DeyeSchemaError,
  DeyeUnavailableError,
  type DeyeFailure,
  type DeyeOperation,
} from "../errors/DeyeErrors"
import type { DeyeDeviceLatest, DeyeLatest, DeyeMeasurement } from "./types"

const CodeSchema = Schema.Union([Schema.String, Schema.Number])
export const DEYE_SUCCESS_CODE = "1000000"
const AUTH_CODES = new Set(["2101017", "2101018", "2101019", "401", "403"])
const RATE_LIMIT_CODES = new Set(["429", "2101029"])

const EnvelopeSchema = Schema.Struct({
  success: Schema.Boolean,
  code: Schema.optional(CodeSchema),
  msg: Schema.optional(Schema.String),
})

const TokenResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  code: Schema.optional(CodeSchema),
  msg: Schema.optional(Schema.String),
  accessToken: Schema.optional(Schema.String),
  expiresIn: Schema.optional(Schema.String),
  tokenType: Schema.optional(Schema.String),
})

const MeasurementSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.optional(Schema.NullOr(Schema.String)),
  unit: Schema.optional(Schema.NullOr(Schema.String)),
})

const UnixSecondsSchema = Schema.Int.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(9_999_999_999),
  ),
)

const DeviceLatestSchema = Schema.Struct({
  deviceSn: Schema.String,
  deviceType: Schema.optional(Schema.NullOr(Schema.String)),
  deviceState: Schema.optional(Schema.NullOr(Schema.Int)),
  collectionTime: Schema.optional(Schema.NullOr(UnixSecondsSchema)),
  dataList: Schema.optional(Schema.Array(MeasurementSchema)),
})

const LatestResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  code: Schema.optional(CodeSchema),
  msg: Schema.optional(Schema.String),
  deviceDataList: Schema.optional(Schema.Array(DeviceLatestSchema)),
})

type Envelope = Schema.Schema.Type<typeof EnvelopeSchema>

function schemaError(
  operation: DeyeOperation,
  reason: "invalid_json" | "invalid_envelope" | "invalid_payload",
): DeyeSchemaError {
  return new DeyeSchemaError({ operation, reason })
}

function parseJson(text: string, operation: DeyeOperation): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw schemaError(operation, "invalid_json")
  }
}

function decodeEnvelope(text: string, operation: DeyeOperation): Envelope {
  const value = parseJson(text, operation)
  try {
    return Schema.decodeUnknownSync(EnvelopeSchema)(value)
  } catch {
    throw schemaError(operation, "invalid_envelope")
  }
}

function codeString(code: string | number | undefined): string | null {
  return code === undefined ? null : String(code).trim()
}

function codeFailure(operation: DeyeOperation, code: string | null): DeyeFailure {
  if (code !== null && AUTH_CODES.has(code)) {
    return new DeyeAuthError({ operation, status: null, code })
  }
  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    return new DeyeRateLimitError({ operation, status: 429, attempts: 1 })
  }
  return new DeyeUnavailableError({ operation, status: null, attempts: 1 })
}

function assertSuccessfulEnvelope(
  envelope: Envelope,
  operation: DeyeOperation,
): void {
  const code = codeString(envelope.code)
  if (!envelope.success || (code !== null && code !== DEYE_SUCCESS_CODE)) {
    throw codeFailure(operation, code)
  }
}

export interface DecodedTokenResponse {
  readonly success: true
  readonly code: string | null
  readonly accessToken: string
  readonly expiresInSeconds: number
  readonly tokenType: string
}

function parseExpiresIn(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/u.test(trimmed)) return null
  const seconds = Number(trimmed)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

export function decodeTokenResponse(text: string): DecodedTokenResponse {
  const envelope = decodeEnvelope(text, "token")
  assertSuccessfulEnvelope(envelope, "token")
  let response: Schema.Schema.Type<typeof TokenResponseSchema>
  try {
    response = Schema.decodeUnknownSync(TokenResponseSchema)(parseJson(text, "token"))
  } catch {
    throw schemaError("token", "invalid_payload")
  }

  const accessToken = response.accessToken?.trim()
  const expiresInSeconds = response.expiresIn === undefined ? null : parseExpiresIn(response.expiresIn)
  const tokenType = response.tokenType?.trim() || "bearer"
  if (!accessToken || expiresInSeconds === null || tokenType.toLowerCase() !== "bearer") {
    throw schemaError("token", "invalid_payload")
  }

  return {
    success: true,
    code: codeString(envelope.code),
    accessToken,
    expiresInSeconds,
    tokenType,
  }
}

export interface DecodedLatestResponse {
  readonly success: true
  readonly code: string | null
  readonly msg: string | null
  readonly deviceDataList: readonly DeyeDeviceLatest[]
}

export function decodeLatestResponse(text: string, fetchedAt: string): DeyeLatest {
  const envelope = decodeEnvelope(text, "device_latest")
  assertSuccessfulEnvelope(envelope, "device_latest")
  let response: Schema.Schema.Type<typeof LatestResponseSchema>
  try {
    response = Schema.decodeUnknownSync(LatestResponseSchema)(parseJson(text, "device_latest"))
  } catch {
    throw schemaError("device_latest", "invalid_payload")
  }
  const deviceDataList: readonly DeyeDeviceLatest[] = (response.deviceDataList ?? []).map(
    (device): DeyeDeviceLatest => ({
      deviceSn: device.deviceSn,
      deviceType: device.deviceType ?? null,
      deviceState: device.deviceState ?? null,
      collectionTime: device.collectionTime ?? null,
      dataList: (device.dataList ?? []).map(
        (measurement): DeyeMeasurement => ({
          key: measurement.key,
          value: measurement.value ?? null,
          unit: measurement.unit ?? null,
        }),
      ),
    }),
  )

  return {
    success: true,
    code: codeString(envelope.code),
    msg: envelope.msg ?? null,
    deviceDataList,
    fetchedAt,
  }
}

export function decodeBodyEnvelope(text: string, operation: DeyeOperation): Envelope {
  const envelope = decodeEnvelope(text, operation)
  assertSuccessfulEnvelope(envelope, operation)
  return envelope
}
