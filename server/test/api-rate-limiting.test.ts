import { env as cloudflareEnv } from "cloudflare:test"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { RateLimit, RateLimitOptions, RateLimitOutcome } from "@cloudflare/workers-types"
import { createApp } from "../src/api/app"
import type { Env } from "../src/env"
import { PollingService } from "../src/services/PollingService"
import { StorageService } from "../src/services/StorageService"

const CLIENT_IP = "198.51.100.23"
const READ_TOKEN = "synthetic-read-token-with-at-least-32-characters"
const REFRESH_TOKEN = "synthetic-refresh-token-with-at-least-32-characters"

type TestRateLimitOutcome = RateLimitOutcome | undefined | null |
  { readonly success: string } | readonly RateLimitOutcome[]

interface TestRateLimiter {
  readonly binding: RateLimit
  readonly keys: string[]
}

function makeLimiter(
  decide: (options: RateLimitOptions) => TestRateLimitOutcome | Promise<TestRateLimitOutcome> =
    () => ({ success: true }),
): TestRateLimiter {
  const keys: string[] = []

  return {
    binding: {
      limit: async (options) => {
        keys.push(options.key)
        const outcome = await decide(options)

        // SAFETY: Malformed outcomes are deliberate inputs to response-hardening tests.
        return outcome as RateLimitOutcome
      },
    },
    keys,
  }
}

function makeHarness(
  authLimiter: RateLimit | null = makeLimiter().binding,
  readLimiter: RateLimit | null = makeLimiter().binding,
) {
  let snapshotReads = 0
  let eventReads = 0
  let refreshCalls = 0

  const app = createApp({
    storageLayer: Layer.succeed(StorageService, {
      getLatestSnapshot: () => Effect.sync(() => {
        snapshotReads += 1

        return null
      }),
      listEvents: () => Effect.sync(() => {
        eventReads += 1

        return { events: [], nextCursor: null }
      }),
    }),
    pollingLayer: Layer.succeed(PollingService, {
      refresh: () => Effect.sync(() => {
        refreshCalls += 1

        return { status: "completed", outcome: "unverified", errorCategory: null } as const
      }),
    }),
  })

  const env: Env = {
    API_AUTH_RATE_LIMITER: authLimiter ?? undefined,
    API_READ_RATE_LIMITER: readLimiter ?? undefined,
    API_BEARER_TOKEN: READ_TOKEN,
    API_REFRESH_TOKEN: REFRESH_TOKEN,
    REFRESH_ENABLED: "true",
    STATION_ID: "station-1",
  }

  return {
    app,
    env,
    snapshotReads: () => snapshotReads,
    eventReads: () => eventReads,
    refreshCalls: () => refreshCalls,
  }
}

function request(
  path: string,
  init: RequestInit = {},
  clientIp: string | null = CLIENT_IP,
): Request {
  const headers = new Headers(init.headers)

  if (clientIp !== null) headers.set("CF-Connecting-IP", clientIp)

  return new Request(`https://example.test${path}`, { ...init, headers })
}

function authorizedHeaders(): Headers {
  return new Headers({ Authorization: `Bearer ${READ_TOKEN}` })
}

const rateLimitedBody = {
  ok: false,
  error: { code: "RATE_LIMITED", message: "Too many requests" },
}

const unavailableBody = {
  ok: false,
  error: { code: "RATE_LIMIT_UNAVAILABLE", message: "Service temporarily unavailable" },
}

describe("API rate limits", () => {
  it("limits every API auth attempt before credential checks and allows valid requests", async () => {
    const auth = makeLimiter()
    const read = makeLimiter()
    const harness = makeHarness(auth.binding, read.binding)

    const unauthorized = await harness.app.fetch(request("/api/v1/status"), harness.env)

    expect(unauthorized.status).toBe(401)
    expect(auth.keys).toEqual([CLIENT_IP])
    expect(read.keys).toEqual([])

    const allowed = await harness.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(allowed.status).toBe(200)
    expect(auth.keys).toEqual([CLIENT_IP, CLIENT_IP])
    expect(read.keys).toEqual([CLIENT_IP])
    expect(harness.snapshotReads()).toBe(1)
  })

  it("returns the static quota response before authentication or protected storage", async () => {
    const secret = "synthetic-limiter-internal-error-secret"
    const auth = makeLimiter(() => ({ success: false }))
    const harness = makeHarness(auth.binding)

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers: { Authorization: `Bearer ${secret}` } }),
      harness.env,
    )

    expect(response.status).toBe(429)
    const body = await response.json()

    expect(body).toEqual(rateLimitedBody)
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Vary")).toBe("Authorization")
    expect(response.headers.get("Retry-After")).toBeNull()
    expect(harness.snapshotReads()).toBe(0)
    expect(harness.eventReads()).toBe(0)
    expect(harness.refreshCalls()).toBe(0)
  })

  it("uses only the validated Cloudflare IP as key, isolated by binding", async () => {
    const auth = makeLimiter()
    const read = makeLimiter()
    const harness = makeHarness(auth.binding, read.binding)
    const headers = authorizedHeaders()
    headers.set("X-Forwarded-For", "203.0.113.9")
    headers.set("X-Real-IP", "203.0.113.10")

    const status = await harness.app.fetch(request("/api/v1/status", { headers }), harness.env)

    const firstEventsPage = await harness.app.fetch(
      request("/api/v1/events?limit=5", { headers }),
      harness.env,
    )

    const secondEventsPage = await harness.app.fetch(
      request("/api/v1/events?limit=6", { headers }),
      harness.env,
    )

    expect(status.status).toBe(200)
    expect(firstEventsPage.status).toBe(200)
    expect(secondEventsPage.status).toBe(200)
    expect(auth.keys).toEqual([CLIENT_IP, CLIENT_IP, CLIENT_IP])
    expect(read.keys).toEqual([CLIENT_IP, CLIENT_IP, CLIENT_IP])
    expect(auth.keys).not.toContain("203.0.113.9")
    expect(auth.keys).not.toContain("203.0.113.10")
  })

  it("keeps auth and read quotas isolated and denies a read before storage", async () => {
    const auth = makeLimiter()
    const read = makeLimiter(() => ({ success: false }))
    const harness = makeHarness(auth.binding, read.binding)

    const response = await harness.app.fetch(
      request("/api/v1/events?limit=10", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual(rateLimitedBody)
    expect(auth.keys).toEqual([CLIENT_IP])
    expect(read.keys).toEqual([CLIENT_IP])
    expect(harness.eventReads()).toBe(0)
    expect(harness.snapshotReads()).toBe(0)
    expect(harness.refreshCalls()).toBe(0)
  })

  it("applies read limits to GET and HEAD, but not to non-read methods", async () => {
    const auth = makeLimiter()
    const read = makeLimiter()
    const harness = makeHarness(auth.binding, read.binding)

    const get = await harness.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      harness.env,
    )

    const head = await harness.app.fetch(
      request("/api/v1/status", { method: "HEAD", headers: authorizedHeaders() }),
      harness.env,
    )

    const refresh = await harness.app.fetch(
      request("/api/v1/refresh", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${READ_TOKEN}`,
          "X-Refresh-Token": REFRESH_TOKEN,
        },
      }),
      harness.env,
    )

    expect(get.status).toBe(200)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(refresh.status).toBe(200)
    expect(auth.keys).toHaveLength(3)
    expect(read.keys).toEqual([CLIENT_IP, CLIENT_IP])
    expect(harness.snapshotReads()).toBe(3)
    expect(harness.refreshCalls()).toBe(1)
  })

  it("protects valid refresh attempts with the auth limiter before polling", async () => {
    const auth = makeLimiter()
    const read = makeLimiter(() => ({ success: false }))
    const harness = makeHarness(auth.binding, read.binding)

    const response = await harness.app.fetch(
      request("/api/v1/refresh", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${READ_TOKEN}`,
          "X-Refresh-Token": REFRESH_TOKEN,
        },
      }),
      harness.env,
    )

    expect(response.status).toBe(200)
    expect(auth.keys).toEqual([CLIENT_IP])
    expect(read.keys).toEqual([])
    expect(harness.refreshCalls()).toBe(1)
  })

  it("denies refresh before bearer, refresh-token, or poll processing", async () => {
    const auth = makeLimiter(() => ({ success: false }))
    const read = makeLimiter()
    const harness = makeHarness(auth.binding, read.binding)

    const response = await harness.app.fetch(
      request("/api/v1/refresh", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${READ_TOKEN}`,
          "X-Refresh-Token": REFRESH_TOKEN,
        },
      }),
      harness.env,
    )

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual(rateLimitedBody)
    expect(auth.keys).toEqual([CLIENT_IP])
    expect(read.keys).toEqual([])
    expect(harness.refreshCalls()).toBe(0)
  })

  it.each<{ name: string; ip: string | null; forwardedFor?: string }>([
    { name: "missing identity", ip: null, forwardedFor: CLIENT_IP },
    { name: "invalid identity", ip: "not-an-ip" },
    { name: "oversized identity", ip: "x".repeat(46) },
  ])("fails closed for $name without consulting a limiter", async ({ ip, forwardedFor }) => {
    const auth = makeLimiter()
    const read = makeLimiter()
    const harness = makeHarness(auth.binding, read.binding)

    const headers = new Headers({ Authorization: `Bearer ${READ_TOKEN}` })

    if (forwardedFor !== undefined) headers.set("X-Forwarded-For", forwardedFor)

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers }, ip),
      harness.env,
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(unavailableBody)
    expect(auth.keys).toEqual([])
    expect(read.keys).toEqual([])
    expect(harness.snapshotReads()).toBe(0)
  })

  it("fails closed when either required binding is absent", async () => {
    const missingAuth = makeHarness(null, makeLimiter().binding)

    const authResponse = await missingAuth.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      missingAuth.env,
    )

    expect(authResponse.status).toBe(503)
    expect(await authResponse.json()).toEqual(unavailableBody)
    expect(missingAuth.snapshotReads()).toBe(0)
    expect(missingAuth.eventReads()).toBe(0)
    expect(missingAuth.refreshCalls()).toBe(0)

    const missingRead = makeHarness(makeLimiter().binding, null)

    const readResponse = await missingRead.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      missingRead.env,
    )

    expect(readResponse.status).toBe(503)
    expect(await readResponse.json()).toEqual(unavailableBody)
    expect(missingRead.snapshotReads()).toBe(0)
    expect(missingRead.eventReads()).toBe(0)
    expect(missingRead.refreshCalls()).toBe(0)
  })

  it("fails closed for a malformed binding", async () => {
    // SAFETY: This deliberately violates RateLimit to exercise the runtime boundary check.
    const malformedBinding = Object.defineProperty({}, "limit", { value: 1 }) as RateLimit
    const harness = makeHarness(malformedBinding)

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(unavailableBody)
    expect(harness.snapshotReads()).toBe(0)
    expect(harness.eventReads()).toBe(0)
    expect(harness.refreshCalls()).toBe(0)
  })

  it.each([
    { name: "binding exception", decide: () => Promise.reject(new Error("synthetic-secret")) },
    { name: "missing result", decide: () => undefined },
    { name: "malformed result", decide: () => ({ success: "true" }) },
    { name: "array result", decide: () => [{ success: true }] },
  ])("returns a static 503 for $name without exposing details", async ({ decide }) => {
    const auth = makeLimiter(decide)
    const harness = makeHarness(auth.binding)

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(response.status).toBe(503)
    const body = await response.json()

    expect(body).toEqual(unavailableBody)
    expect(JSON.stringify(body)).not.toContain("synthetic-secret")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Vary")).toBe("Authorization")
    expect(response.headers.get("Retry-After")).toBeNull()
    expect(harness.snapshotReads()).toBe(0)
    expect(harness.eventReads()).toBe(0)
    expect(harness.refreshCalls()).toBe(0)
  })

  it("fails closed on read limiter exceptions and malformed outcomes", async () => {
    const read = makeLimiter(() => Promise.reject(new Error("synthetic-read-secret")))
    const harness = makeHarness(makeLimiter().binding, read.binding)

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(response.status).toBe(503)
    const body = await response.json()

    expect(body).toEqual(unavailableBody)
    expect(JSON.stringify(body)).not.toContain("synthetic-read-secret")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Vary")).toBe("Authorization")
    expect(response.headers.get("Retry-After")).toBeNull()
    expect(harness.snapshotReads()).toBe(0)
  })

  it("rejects malformed read limiter results before storage", async () => {
    const read = makeLimiter(() => ({ success: "true" }))
    const harness = makeHarness(makeLimiter().binding, read.binding)

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(unavailableBody)
    expect(harness.snapshotReads()).toBe(0)
    expect(harness.eventReads()).toBe(0)
    expect(harness.refreshCalls()).toBe(0)
  })

  it("does not rate limit non-API or unknown non-read routes", async () => {
    const auth = makeLimiter()
    const read = makeLimiter()
    const harness = makeHarness(auth.binding, read.binding)

    const root = await harness.app.fetch(request("/"), harness.env)

    const unknown = await harness.app.fetch(
      request("/api/v1/unknown", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(root.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(auth.keys).toEqual([CLIENT_IP])
    expect(read.keys).toEqual([])
  })

  it("uses the Wrangler-configured rate limit bindings in the local Worker runtime", async () => {
    expect(cloudflareEnv.API_AUTH_RATE_LIMITER).toBeDefined()
    expect(cloudflareEnv.API_READ_RATE_LIMITER).toBeDefined()

    const harness = makeHarness(
      cloudflareEnv.API_AUTH_RATE_LIMITER,
      cloudflareEnv.API_READ_RATE_LIMITER,
    )

    const response = await harness.app.fetch(
      request("/api/v1/status", { headers: authorizedHeaders() }),
      harness.env,
    )

    expect(response.status).toBe(200)
    expect(harness.snapshotReads()).toBe(1)
  })
})
