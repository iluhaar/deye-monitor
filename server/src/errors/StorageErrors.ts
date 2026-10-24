import { Data } from "effect"

export class MissingBindingError extends Data.TaggedError("MissingBindingError")<{
  readonly binding: "DB"
}> {}

/** Internal storage failures intentionally carry no driver error or SQL text. */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "read_snapshot" | "read_events"
}> {}

export type StorageFailure = MissingBindingError | StorageError
