import { Effect, Layer, Predicate, Schema } from "effect"
import { Hono } from "hono"
import type { Context } from "hono"
import { isIP } from "node:net"
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
import {
  MAX_API_QUERY_LENGTH,
  MAX_API_URL_LENGTH,
  MAX_EVENT_CURSOR_ID_LENGTH,
  MAX_EVENT_DATE_LENGTH,
  encodeEventCursor,
  InvalidEventsQuery,
  parseEventsQuery,
  validateEventsQueryBounds,
} from "./query"

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
const eventsPath = "/api/v1/events"
const refreshPath = "/api/v1/refresh"

const readPaths = new Set([
  "/api/v1/status",
  "/api/v1/telemetry",
  "/api/v1/battery",
  eventsPath,
  "/api/v1/health",
])

const MAX_EVENTS_PAGE_SIZE = 100
const MAX_PUBLIC_EVIDENCE_COUNT = 16
const MAX_PUBLIC_EVIDENCE_LENGTH = 64
const MAX_EVENTS_RESPONSE_BYTES = 1_000_000
const MAX_CLIENT_IP_LENGTH = 45

const RATE_LIMITED_RESPONSE = {
  ok: false,
  error: { code: "RATE_LIMITED", message: "Too many requests" },
} as const

const RATE_LIMIT_UNAVAILABLE_RESPONSE = {
  ok: false,
  error: { code: "RATE_LIMIT_UNAVAILABLE", message: "Service temporarily unavailable" },
} as const

const RateLimitOutcomeSchema = Schema.Struct({ success: Schema.Boolean })

function success<T>(data: T): JsonSuccess<T> {
  return { ok: true, data }
}

function failure(code: string, message: string): JsonFailure {
  return { ok: false, error: { code, message } }
}

type RateLimitBindingName = "API_AUTH_RATE_LIMITER" | "API_READ_RATE_LIMITER"

async function enforceRateLimit(
  context: Context<{ Bindings: Env }>,
  bindingName: RateLimitBindingName,
): Promise<Response | null> {
  try {
    const ip = context.req.raw.headers.get("CF-Connecting-IP")

    if (ip === null || ip.length > MAX_CLIENT_IP_LENGTH || isIP(ip) === 0) {
      return context.json(RATE_LIMIT_UNAVAILABLE_RESPONSE, 503)
    }

    const binding = context.env?.[bindingName]

    if (binding === undefined || binding === null) {
      return context.json(RATE_LIMIT_UNAVAILABLE_RESPONSE, 503)
    }

    const outcome: unknown = await binding.limit({ key: ip })

    if (!Schema.is(RateLimitOutcomeSchema)(outcome)) {
      return context.json(RATE_LIMIT_UNAVAILABLE_RESPONSE, 503)
    }

    return outcome.success
      ? null
      : context.json(RATE_LIMITED_RESPONSE, 429)
  } catch {
    return context.json(RATE_LIMIT_UNAVAILABLE_RESPONSE, 503)
  }
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
  if (snapshot === null) return null

  if (snapshot.fetchedAt.length > MAX_EVENT_DATE_LENGTH ||
    (snapshot.measuredAt !== null && snapshot.measuredAt.length > MAX_EVENT_DATE_LENGTH) ||
    snapshot.grid.evidence.length > MAX_PUBLIC_EVIDENCE_COUNT ||
    snapshot.grid.evidence.some((evidence) => evidence.length === 0 ||
      evidence.length > MAX_PUBLIC_EVIDENCE_LENGTH)) {
    throw new StorageError({ operation: "read_snapshot" })
  }

  return evaluateSnapshot(snapshot, nowMs, thresholdSeconds(env))
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
  if (page.events.length > MAX_EVENTS_PAGE_SIZE) {
    throw new StorageError({ operation: "read_events" })
  }

  for (const event of page.events) {
    if (event.id.length === 0 || event.id.length > MAX_EVENT_CURSOR_ID_LENGTH ||
      event.observedAt.length > MAX_EVENT_DATE_LENGTH ||
      (event.previousObservedAt !== null && event.previousObservedAt.length > MAX_EVENT_DATE_LENGTH) ||
      event.evidence.length > MAX_PUBLIC_EVIDENCE_COUNT ||
      event.evidence.some((evidence) => evidence.length === 0 || evidence.length > MAX_PUBLIC_EVIDENCE_LENGTH)) {
      throw new StorageError({ operation: "read_events" })
    }
  }

  if (page.nextCursor !== null && (page.nextCursor.id.length === 0 ||
    page.nextCursor.id.length > MAX_EVENT_CURSOR_ID_LENGTH ||
    page.nextCursor.observedAt.length > MAX_EVENT_DATE_LENGTH)) {
    throw new StorageError({ operation: "read_events" })
  }

  let nextCursor: string | null

  try {
    nextCursor = encodeEventCursor(page.nextCursor)
  } catch (error) {
    if (!(error instanceof InvalidEventsQuery)) throw error

    throw new StorageError({ operation: "read_events" })
  }

  const data = {
    events: page.events.map((event) => ({
      id: event.id,
      status: event.status,
      observedAt: event.observedAt,
      previousStatus: event.previousStatus,
      previousObservedAt: event.previousObservedAt,
      evidence: event.evidence,
      source: event.source,
    })),
    nextCursor,
  }

  if (new TextEncoder().encode(JSON.stringify(success(data))).byteLength > MAX_EVENTS_RESPONSE_BYTES) {
    throw new StorageError({ operation: "read_events" })
  }

  return data
}

function fetchedAgeSeconds(snapshot: EvaluatedTelemetrySnapshot | null, nowMs: number) {
  if (snapshot === null) return null
  const fetchedMs = Date.parse(snapshot.fetchedAt)

  if (!Number.isFinite(fetchedMs) || fetchedMs > nowMs) return null

  return Math.max(0, Math.floor((nowMs - fetchedMs) / 1000))
}

function queryLength(requestUrl: string): number {
  const queryStart = requestUrl.indexOf("?")

  if (queryStart === -1) return 0

  const fragmentStart = requestUrl.indexOf("#", queryStart)
  const queryEnd = fragmentStart === -1 ? requestUrl.length : fragmentStart

  return queryEnd - queryStart
}

function hasQuery(requestUrl: string): boolean {
  return requestUrl.includes("?")
}

function requestHasBody(request: Request): boolean {
  if (request.headers.has("Transfer-Encoding")) return true

  const contentLength = request.headers.get("Content-Length")

  // Workerd exposes an empty stream for HTTP POSTs framed with Content-Length: 0.
  // HTTP framing establishes emptiness; do not read or drain a request stream.
  if (contentLength !== null) return contentLength !== "0"

  return request.body !== null
}

function discardRequestBody(request: Request): void {
  const body = request.body

  if (body === null) return

  try {
    void Promise.resolve(body.cancel()).catch(() => undefined)
  } catch {
    // A locked or non-standard request stream must not delay rejection.
  }
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>()
  const now = options.now ?? Date.now

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store")
    context.header("Vary", "Authorization")
    await next()
  })
  app.use("/api/v1/*", async (context, next) => {
    const requestUrl = context.req.url

    if (requestUrl.length > MAX_API_URL_LENGTH) {
      return context.json(failure("REQUEST_TOO_LARGE", "Request is too large"), 414)
    }

    const querySize = queryLength(requestUrl)

    if (querySize > MAX_API_QUERY_LENGTH && context.req.path !== refreshPath) {
      return context.json(failure("REQUEST_TOO_LARGE", "Request is too large"), 414)
    }

    await next()
  })
  app.use("/api/v1/*", async (context, next) => {
    const response = await enforceRateLimit(context, "API_AUTH_RATE_LIMITER")

    if (response !== null) return response

    await next()
  })
  app.use("/api/v1/*", requireBearerToken)
  app.use("/api/v1/refresh", requireRefreshToken)
  app.use("/api/v1/*", async (context, next) => {
    const requestUrl = context.req.url

    if (requestHasBody(context.req.raw)) {
      discardRequestBody(context.req.raw)

      if (context.req.path === refreshPath) {
        return context.json(failure("INVALID_REFRESH_REQUEST", "Refresh accepts no query or body"), 400)
      }

      return context.json(failure("INVALID_REQUEST", "Request body is not accepted"), 400)
    }

    if (readPaths.has(context.req.path) && context.req.path !== eventsPath && hasQuery(requestUrl)) {
      return context.json(failure("INVALID_QUERY", "Invalid query"), 400)
    }

    if (context.req.path === eventsPath) {
      try {
        validateEventsQueryBounds(new URL(requestUrl))
      } catch {
        return context.json(failure("INVALID_QUERY", "Invalid events query"), 400)
      }
    }

    await next()
  })
  app.use("/api/v1/*", async (context, next) => {
    if (!readPaths.has(context.req.path) ||
      (context.req.method !== "GET" && context.req.method !== "HEAD")) {
      await next()

      return
    }

    const response = await enforceRateLimit(context, "API_READ_RATE_LIMITER")

    if (response !== null) return response

    await next()
  })

  app.post(refreshPath, async (context) => {
    if (hasQuery(context.req.url) || requestHasBody(context.req.raw)) {
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

  app.get(eventsPath, async (context) => {
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
