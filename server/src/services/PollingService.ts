import { Context, Data, Effect, Layer, Match } from "effect"
import { DeyeService } from "./DeyeService"
import type { DeyeReader } from "./DeyeService"
import { IngestionStorage } from "./IngestionStorage"
import type { IngestionOutcome, IngestionStore } from "./IngestionStorage"
import type { RefreshLease, RefreshPollRecord } from "../storage/RefreshGuard"
import type { RefreshErrorCategory, RefreshPollOutcome } from "../storage/RefreshGuard"

export class PollingError extends Data.TaggedError("PollingError")<{
  readonly category: "configuration" | "storage" | "timeout"
}> {}

export type PollingResult =
  | { readonly status: "busy" | "throttled"; readonly retryAfterSeconds: number }
  | { readonly status: "completed"; readonly outcome: IngestionOutcome | "error";
      readonly errorCategory: RefreshErrorCategory | null }

export interface PollingOptions {
  readonly workflowBudgetMs: number
  readonly finalizationBudgetMs: number
  readonly freshnessThresholdSeconds: number
}

export interface TelemetryPoller {
  readonly refresh: (stationId: string) => Effect.Effect<PollingResult, PollingError>
}

export const PollingService = Context.Service<TelemetryPoller>("deye-monitor/PollingService")

export function makePollingService(
  source: DeyeReader,
  storage: IngestionStore,
  options: PollingOptions,
  now: () => number = Date.now,
): TelemetryPoller {
  function refresh(stationId: string): Effect.Effect<PollingResult, PollingError> {
    return Effect.suspend(() => {
      if (!Number.isSafeInteger(options.workflowBudgetMs) ||
        !Number.isSafeInteger(options.finalizationBudgetMs) || options.finalizationBudgetMs <= 0 ||
        options.workflowBudgetMs <= options.finalizationBudgetMs ||
        !Number.isFinite(options.freshnessThresholdSeconds) || options.freshnessThresholdSeconds < 0 ||
        stationId.trim() === "") {
        return Effect.fail(new PollingError({ category: "configuration" }))
      }

      const startedMs = now()
      const id = crypto.randomUUID()

      const poll = (outcome: RefreshPollOutcome, errorCategory: RefreshErrorCategory | null): RefreshPollRecord => {
        const completedMs = Math.max(startedMs, now())

        return { id, startedAt: new Date(startedMs).toISOString(),
          completedAt: new Date(completedMs).toISOString(),
          latencyMs: Math.floor(completedMs - startedMs), measuredAt: null,
          result: "error", outcome, errorCategory }
      }

      function collect(lease: RefreshLease) {
        const work = Effect.gen(function* () {
          const snapshot = yield* source.readLatest(stationId)
          const record = poll("accepted", null)

          const outcome = yield* storage.persist(lease, snapshot, record,
            Date.parse(record.completedAt), options.freshnessThresholdSeconds)

          return { status: "completed", outcome, errorCategory: null } as const
        }).pipe(Effect.timeout(options.workflowBudgetMs - options.finalizationBudgetMs))

        return work.pipe(
          Effect.catch((error) => {
            // Only allowlisted categories survive; messages/payloads never do.
            const category = Match.value(error).pipe(
              Match.tag("TimeoutError", () => "timeout" as const),
              Match.tag("DeyeNotConfiguredError", () => "not_configured" as const),
              Match.orElse((cause) => "category" in cause ? cause.category : "storage" as const),
            )

            return storage.recordFailure(lease, poll("error", category)).pipe(
              Effect.timeout(options.finalizationBudgetMs),
              Effect.as({ status: "completed", outcome: "error", errorCategory: category } as const),
            )
          }),
          Effect.timeout(options.workflowBudgetMs),
        )
      }

      return Effect.acquireUseRelease(
        storage.acquire(stationId).pipe(Effect.timeout(options.finalizationBudgetMs)),
        (result) => Effect.gen(function* () {
          if (result.status === "acquired") return yield* collect(result.lease)

          return result
        }),
        (result) => result.status === "acquired"
          ? storage.release(result.lease).pipe(
            Effect.timeout(options.finalizationBudgetMs), Effect.catch(() => Effect.succeed(false)),
            Effect.asVoid,
          ) : Effect.void,
      ).pipe(Effect.mapError((error) => Match.value(error).pipe(
        Match.tag("TimeoutError", () => new PollingError({ category: "timeout" })),
        Match.orElse(() => new PollingError({ category: "storage" })),
      )))
    })
  }

  return { refresh }
}

export function pollingLayer(options: PollingOptions) {
  return Layer.effect(PollingService, Effect.gen(function* () {
    const source = yield* DeyeService
    const storage = yield* IngestionStorage

    return makePollingService(source, storage, options)
  }))
}
