import { Effect, Layer, Predicate } from "effect"
import { Hono } from "hono"
import type { Context } from "hono"
import type { Env } from "../env"
import {
  DEFAULT_FRESHNESS_THRESHOLD_SECONDS,
  evaluateSnapshot,
  unavailableSnapshot,
} from "../domain/grid-status"
import type {
  EvaluatedTelemetrySnapshot,
  TelemetrySnapshot,
} from "../domain/telemetry"
import { MissingBindingError, StorageError } from "../errors/StorageErrors"
import { storageLayer } from "../runtime/layers"
import { refreshLayer } from "../runtime/refresh"
import { PollingError, PollingService } from "../services/PollingService"
import type { TelemetryPoller } from "../services/PollingService"
import {
  StorageService,
  type EventPage,
  type EventQuery,
  type TelemetryStore,
} from "../services/StorageService"
import { requireBearerToken, requireRefreshToken } from "./auth"
import { encodeEventCursor, InvalidEventsQuery, parseEventsQuery } from "./query"

type JsonSuccess<T> = { readonly ok: true; readonly data: T }

type JsonFailure = {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

export interface AppOptions {
  readonly storageLayer?: Layer.Layer<TelemetryStore>
  readonly pollingLayer?: Layer.Layer<TelemetryPoller>
  readonly now?: () => number
}

const unavailableStatus = unavailableSnapshot()

function success<T>(data: T): JsonSuccess<T> {
  return { ok: true, data }
}

function failure(code: string, message: string): JsonFailure {
  return { ok: false, error: { code, message } }
}

function thresholdSeconds(env: Env): number {
  const value = Number(env.FRESHNESS_THRESHOLD_SECONDS)

  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_FRESHNESS_THRESHOLD_SECONDS
}

function stationId(env: Env): string | null {
  const value = env.STATION_ID?.trim()

  return value === undefined || value === "" ? null : value
}

async function runStorage<A>(
  program: Effect.Effect<
    A,
    MissingBindingError | StorageError,
    TelemetryStore
  >,
  layer: Layer.Layer<TelemetryStore>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(program, layer))
}

function storageFailureResponse(
  context: Context<{ Bindings: Env }>,
  cause: unknown,
): Response {
  if (Predicate.isTagged("MissingBindingError")(cause)) {
    return context.json(
      failure("STORAGE_UNAVAILABLE", "Storage is unavailable"),
      503,
    )
  }

  if (Predicate.isTagged("StorageError")(cause)) {
    return context.json(
      failure("STORAGE_UNAVAILABLE", "Storage is unavailable"),
      503,
    )
  }

  return context.json(failure("INTERNAL_ERROR", "Internal server error"), 500)
}

function evaluate(
  snapshot: TelemetrySnapshot | null,
  env: Env,
  nowMs: number,
): EvaluatedTelemetrySnapshot | null {
  return snapshot === null
    ? null
    : evaluateSnapshot(snapshot, nowMs, thresholdSeconds(env))
}

function publicSnapshot(snapshot: EvaluatedTelemetrySnapshot) {
  return {
    source: snapshot.source,
    grid: snapshot.grid,
    battery: snapshot.battery,
    home: snapshot.home,
    measuredAt: snapshot.measuredAt,
    fetchedAt: snapshot.fetchedAt,
    freshness: snapshot.freshness,
  }
}

function publicStatus(snapshot: EvaluatedTelemetrySnapshot | null) {
  if (snapshot === null) {
    return {
      source: null,
      grid: unavailableStatus.grid,
      measuredAt: null,
      fetchedAt: null,
      freshness: unavailableStatus.freshness,
    }
  }

  return {
    source: snapshot.source,
    grid: snapshot.grid,
    measuredAt: snapshot.measuredAt,
    fetchedAt: snapshot.fetchedAt,
    freshness: snapshot.freshness,
  }
}

function publicEvents(page: EventPage) {
  return {
    events: page.events.map((event) => ({
      id: event.id,
      status: event.status,
      observedAt: event.observedAt,
      previousStatus: event.previousStatus,
      previousObservedAt: event.previousObservedAt,
      evidence: event.evidence,
      source: event.source,
    })),
    nextCursor: encodeEventCursor(page.nextCursor),
  }
}

function fetchedAgeSeconds(snapshot: EvaluatedTelemetrySnapshot | null, nowMs: number) {
  if (snapshot === null) return null
  const fetchedMs = Date.parse(snapshot.fetchedAt)

  if (!Number.isFinite(fetchedMs) || fetchedMs > nowMs) return null

  return Math.max(0, Math.floor((nowMs - fetchedMs) / 1000))
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>()
  const now = options.now ?? Date.now

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store")
    context.header("Vary", "Authorization")
    await next()
  })
  app.use("/api/v1/*", requireBearerToken)
  app.use("/api/v1/refresh", requireRefreshToken)

  app.post("/api/v1/refresh", async (context) => {
    if (new URL(context.req.url).search !== "" || context.req.raw.body !== null) {
      return context.json(failure("INVALID_REFRESH_REQUEST", "Refresh accepts no query or body"), 400)
    }

    const id = stationId(context.env)

    if (id === null || context.env.REFRESH_ENABLED !== "true") {
      return context.json(failure("SERVICE_NOT_CONFIGURED", "Refresh is not configured"), 503)
    }

    try {
      const layer = options.pollingLayer ?? refreshLayer(context.env, thresholdSeconds(context.env))

      const result = await Effect.runPromise(PollingService.use((polling) => polling.refresh(id))
        .pipe(Effect.provide(layer)), { signal: context.req.raw.signal })

      if (result.status !== "completed") {
        const retryAfter = Number.isFinite(result.retryAfterSeconds)
          ? Math.max(1, Math.min(3600, Math.ceil(result.retryAfterSeconds))) : 1

        context.header("Retry-After", String(retryAfter))

        return context.json(failure(result.status === "busy" ? "REFRESH_IN_PROGRESS" : "REFRESH_THROTTLED",
          result.status === "busy" ? "A refresh is already in progress" : "Refresh is temporarily throttled"), 429)
      }

      if (result.outcome === "error") {
        if (result.errorCategory === "timeout") {
          return context.json(failure("REFRESH_TIMEOUT", "Refresh timed out"), 504)
        }

        if (result.errorCategory === "not_configured") {
          return context.json(failure("SERVICE_NOT_CONFIGURED", "Refresh is not configured"), 503)
        }

        if (result.errorCategory === "storage") {
          return context.json(failure("STORAGE_UNAVAILABLE", "Storage is unavailable"), 503)
        }

        if (result.errorCategory === "rate_limit") {
          return context.json(failure("UPSTREAM_RATE_LIMITED", "Upstream service is temporarily limited"), 503)
        }

        return context.json(failure("UPSTREAM_UNAVAILABLE", "Upstream refresh failed"), 502)
      }

      const snapshot = await runStorage(StorageService.use((storage) => storage.getLatestSnapshot(id)),
        options.storageLayer ?? storageLayer(context.env))

      const evaluated = evaluate(snapshot, context.env, now())

      return context.json(success({ refresh: { outcome: result.outcome },
        telemetry: evaluated === null ? null : publicSnapshot(evaluated) }))
    } catch (error) {
      if (Predicate.isTagged("RefreshConfigurationError")(error)) {
        return context.json(failure("SERVICE_NOT_CONFIGURED", "Refresh is not configured"), 503)
      }

      if (error instanceof PollingError) {
        const category = error.category

        if (category === "timeout") return context.json(failure("REFRESH_TIMEOUT", "Refresh timed out"), 504)

        if (category === "configuration") {
          return context.json(failure("SERVICE_NOT_CONFIGURED", "Refresh is not configured"), 503)
        }

        return context.json(failure("STORAGE_UNAVAILABLE", "Storage is unavailable"), 503)
      }

      return storageFailureResponse(context, error)
    }
  })

  app.get("/api/v1/status", async (context) => {
    const id = stationId(context.env)

    if (id === null) {
      return context.json(
        failure("SERVICE_NOT_CONFIGURED", "Service is not configured"),
        503,
      )
    }

    try {
      const snapshot = await runStorage(
        StorageService.use((service) => service.getLatestSnapshot(id)),
        options.storageLayer ?? storageLayer(context.env),
      )

      return context.json(success(publicStatus(evaluate(snapshot, context.env, now()))))
    } catch (error) {
      return storageFailureResponse(context, error)
    }
  })

  app.get("/api/v1/telemetry", async (context) => {
    const id = stationId(context.env)

    if (id === null) {
      return context.json(
        failure("SERVICE_NOT_CONFIGURED", "Service is not configured"),
        503,
      )
    }

    try {
      const snapshot = await runStorage(
        StorageService.use((service) => service.getLatestSnapshot(id)),
        options.storageLayer ?? storageLayer(context.env),
      )

      const evaluated = evaluate(snapshot, context.env, now())

      return context.json(success(evaluated === null ? null : publicSnapshot(evaluated)))
    } catch (error) {
      return storageFailureResponse(context, error)
    }
  })

  app.get("/api/v1/battery", async (context) => {
    const id = stationId(context.env)

    if (id === null) {
      return context.json(
        failure("SERVICE_NOT_CONFIGURED", "Service is not configured"),
        503,
      )
    }

    try {
      const snapshot = await runStorage(
        StorageService.use((service) => service.getLatestSnapshot(id)),
        options.storageLayer ?? storageLayer(context.env),
      )

      const evaluated = evaluate(snapshot, context.env, now())

      return context.json(
        success(
          evaluated === null
            ? null
            : {
                battery: evaluated.battery,
                measuredAt: evaluated.measuredAt,
                fetchedAt: evaluated.fetchedAt,
                freshness: evaluated.freshness,
              },
        ),
      )
    } catch (error) {
      return storageFailureResponse(context, error)
    }
  })

  app.get("/api/v1/events", async (context) => {
    const id = stationId(context.env)

    if (id === null) {
      return context.json(
        failure("SERVICE_NOT_CONFIGURED", "Service is not configured"),
        503,
      )
    }

    let query: EventQuery

    try {
      query = parseEventsQuery(new URL(context.req.url), id)
    } catch (error) {
      if (error instanceof InvalidEventsQuery) {
        return context.json(
          failure("INVALID_QUERY", "Invalid events query"),
          400,
        )
      }

      return context.json(failure("INVALID_QUERY", "Invalid events query"), 400)
    }

    try {
      const page = await runStorage(
        StorageService.use((service) => service.listEvents(query)),
        options.storageLayer ?? storageLayer(context.env),
      )

      return context.json(success(publicEvents(page)))
    } catch (error) {
      return storageFailureResponse(context, error)
    }
  })

  app.get("/api/v1/health", async (context) => {
    const id = stationId(context.env)

    if (id === null) {
      return context.json(
        failure("SERVICE_NOT_CONFIGURED", "Service is not configured"),
        503,
      )
    }

    try {
      const snapshot = await runStorage(
        StorageService.use((service) => service.getLatestSnapshot(id)),
        options.storageLayer ?? storageLayer(context.env),
      )

      const nowMs = now()
      const evaluated = evaluate(snapshot, context.env, nowMs)
      const lag = fetchedAgeSeconds(evaluated, nowMs)

      return context.json(
        success({
          status: evaluated !== null && evaluated.freshness.status === "fresh" ? "ok" : "degraded",
          snapshotAvailable: evaluated !== null,
          ingestionLagSeconds: lag,
        }),
      )
    } catch (error) {
      return storageFailureResponse(context, error)
    }
  })

  app.onError((_error, context) =>
    context.json(failure("INTERNAL_ERROR", "Internal server error"), 500),
  )

  app.notFound((context) =>
    context.json(failure("NOT_FOUND", "Not found"), 404),
  )

  return app
}

export const app = createApp()
