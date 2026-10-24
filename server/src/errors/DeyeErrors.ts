import { Data } from "effect"

export class DeyeNotConfiguredError extends Data.TaggedError(
  "DeyeNotConfiguredError",
)<{}> {}

export class DeyeUpstreamError extends Data.TaggedError("DeyeUpstreamError")<{
  readonly category: "auth" | "rate_limit" | "timeout" | "invalid_payload" | "unavailable"
}> {}

export type DeyeFailure = DeyeNotConfiguredError | DeyeUpstreamError
