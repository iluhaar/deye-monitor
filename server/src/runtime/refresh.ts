import { Data, Effect, Layer } from "effect"
import { resolveDeyeConfig } from "../deye/config"
import type { DeyeConfig, DeyeRuntime } from "../deye/config"
import { DEYE_DEVICE_LATEST_MAPPING_REVISION } from "../domain/normalization"
import type { Env } from "../env"
import { PollingError, PollingService } from "../services/PollingService"
import type { RefreshGuardPolicy } from "../storage/RefreshGuard"
import { ingestionLayer } from "./ingestion"

export class RefreshConfigurationError extends Data.TaggedError("RefreshConfigurationError")<{}> {}

const FINALIZATION_BUDGET_MS = 5000

/** No inferred host, no default cadence, no I/O during configuration. */
export function refreshConfiguration(env: Env) {
  const interval = env.REFRESH_MIN_INTERVAL_SECONDS

  if (env.REFRESH_ENABLED !== "true" || interval === undefined || !/^[1-9]\d{0,3}$/u.test(interval) ||
    Number(interval) > 3600 || env.DB === undefined || !env.STATION_ID?.trim()) {
    throw new RefreshConfigurationError()
  }

  const config: DeyeConfig = {
    baseUrl: env.DEYE_BASE_URL, appId: env.DEYE_APP_ID, appSecret: env.DEYE_APP_SECRET,
    passwordHash: env.DEYE_PASSWORD_HASH, email: env.DEYE_EMAIL, username: env.DEYE_USERNAME,
    mobile: env.DEYE_MOBILE, countryCode: env.DEYE_COUNTRY_CODE, companyId: env.DEYE_COMPANY_ID,
    deviceSn: env.DEYE_DEVICE_SN, deviceType: env.DEYE_DEVICE_TYPE?.trim().toUpperCase(),
  }

  const resolved = resolveDeyeConfig(config)

  if (resolved === null || resolved.defaultLatest === null ||
    env.STATION_ID.trim() === resolved.defaultLatest.deviceSn ||
    !/^[a-f0-9]{64}$/u.test(resolved.credentials.password) ||
    (env.DEYE_DEVICE_TYPE !== undefined && env.DEYE_DEVICE_TYPE.trim().toUpperCase() !== "INVERTER")) {
    throw new RefreshConfigurationError()
  }

  // At most two token issuances and two latest-data requests (one reauth).
  // Each may exhaust its own finite retry and backoff budget.
  const requestBudget = (resolved.maxRetries + 1) * resolved.timeoutMs +
    resolved.maxRetries * resolved.retryMaxDelayMs

  const workflowBudgetMs = 4 * requestBudget + 10_000 + FINALIZATION_BUDGET_MS

  return { config, policy: { workflowBudgetMs,
    leaseMs: workflowBudgetMs + 2 * FINALIZATION_BUDGET_MS + 5000,
    minimumIntervalMs: Number(interval) * 1000 } satisfies RefreshGuardPolicy }
}

/** Only the authorized POST handler constructs/provides this request-scoped layer. */
export function refreshLayer(env: Env, freshnessThresholdSeconds: number, runtime: DeyeRuntime = {}) {
  const { config, policy } = refreshConfiguration(env)
  const db = env.DB!
  const live = ingestionLayer(db, config, policy, FINALIZATION_BUDGET_MS, freshnessThresholdSeconds, runtime)

  return Layer.effect(PollingService, Effect.gen(function* () {
    const polling = yield* PollingService

    return {
      refresh: (stationId: string) => {
        if (stationId !== env.STATION_ID!.trim()) {
          return Effect.fail(new PollingError({ category: "configuration" }))
        }

        return Effect.tryPromise({
          try: () => {
            const now = new Date().toISOString()

            return db.prepare(`INSERT INTO stations (id, source, mapping_revision, created_at, updated_at)
              VALUES (?, 'deye-cloud', ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
              .bind(stationId, DEYE_DEVICE_LATEST_MAPPING_REVISION, now, now).run()
          },
          catch: () => new PollingError({ category: "storage" }),
        }).pipe(Effect.timeout(FINALIZATION_BUDGET_MS),
          Effect.mapError(() => new PollingError({ category: "storage" })),
          Effect.andThen(polling.refresh(stationId)))
      },
    }
  })).pipe(Layer.provide(live))
}
