import type { D1Database } from "@cloudflare/workers-types"
import { Layer } from "effect"
import type { DeyeConfig, DeyeRuntime } from "../deye/config"
import { makeDeyeLayer } from "../deye/DeyeLive"
import { normalizedDeyeLayer } from "../deye/NormalizedLive"
import { pollingLayer } from "../services/PollingService"
import { ingestionStorageLayer } from "../storage/IngestionLive"
import type { RefreshGuardPolicy } from "../storage/RefreshGuard"

/** Opt-in composition for the future refresh handler. Construction performs no
 * I/O. GET routes deliberately do not use this layer. */
export function ingestionLayer(
  db: D1Database, config: DeyeConfig | undefined, policy: RefreshGuardPolicy,
  finalizationBudgetMs: number, freshnessThresholdSeconds: number,
  runtime: DeyeRuntime = {},
) {
  // Reserve lease headroom for release after the bounded workflow.
  if (!Number.isSafeInteger(finalizationBudgetMs) || finalizationBudgetMs <= 0 ||
    finalizationBudgetMs >= policy.workflowBudgetMs ||
    policy.leaseMs <= policy.workflowBudgetMs + 2 * finalizationBudgetMs) {
    throw new Error("Invalid ingestion timing policy")
  }
  const source = normalizedDeyeLayer.pipe(Layer.provide(makeDeyeLayer(config, runtime)))
  return pollingLayer({ workflowBudgetMs: policy.workflowBudgetMs,
    finalizationBudgetMs, freshnessThresholdSeconds }).pipe(Layer.provide(Layer.merge(
      source, ingestionStorageLayer(db, policy),
    )))
}
