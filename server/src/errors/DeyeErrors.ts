import { Data } from "effect"

export class DeyeNotConfiguredError extends Data.TaggedError(
  "DeyeNotConfiguredError",
)<{}> {}

export type DeyeOperation = "token" | "device_latest"

export type DeyeErrorCategory =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "invalid_payload"
  | "unavailable"

/**
 * Authentication failures deliberately contain only safe upstream metadata.
 * In particular, response bodies, tokens and request credentials are never
 * attached to an error.
 */
export class DeyeAuthError extends Data.TaggedError("DeyeAuthError")<{
  readonly operation: DeyeOperation
  readonly status: number | null
  readonly code: string | null
}> {
  readonly category = "auth" as const
}

export class DeyeRateLimitError extends Data.TaggedError(
  "DeyeRateLimitError",
)<{
  readonly operation: DeyeOperation
  readonly status: 429
  readonly attempts: number
}> {
  readonly category = "rate_limit" as const
}

export class DeyeTimeoutError extends Data.TaggedError("DeyeTimeoutError")<{
  readonly operation: DeyeOperation
  readonly attempts: number
}> {
  readonly category = "timeout" as const
}

export type DeyeSchemaErrorReason =
  | "invalid_json"
  | "invalid_envelope"
  | "invalid_payload"
  | "payload_too_large"

export class DeyeSchemaError extends Data.TaggedError("DeyeSchemaError")<{
  readonly operation: DeyeOperation
  readonly reason: DeyeSchemaErrorReason
}> {
  readonly category = "invalid_payload" as const
}

export class DeyeUnavailableError extends Data.TaggedError(
  "DeyeUnavailableError",
)<{
  readonly operation: DeyeOperation
  readonly status: number | null
  readonly attempts: number
}> {
  readonly category = "unavailable" as const
}

/**
 * Kept for callers that only need the old coarse failure taxonomy. New live
 * adapter code returns one of the more specific tagged errors above.
 */
export class DeyeUpstreamError extends Data.TaggedError("DeyeUpstreamError")<{
  readonly category: DeyeErrorCategory
}> {}

export type DeyeFailure =
  | DeyeNotConfiguredError
  | DeyeAuthError
  | DeyeRateLimitError
  | DeyeTimeoutError
  | DeyeSchemaError
  | DeyeUnavailableError
  | DeyeUpstreamError
