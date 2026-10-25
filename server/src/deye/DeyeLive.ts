import { Effect, Layer } from "effect"
import {
  DeyeAuthError,
  DeyeNotConfiguredError,
  DeyeRateLimitError,
  DeyeSchemaError,
  DeyeTimeoutError,
  DeyeUnavailableError,
  type DeyeFailure,
} from "../errors/DeyeErrors"
import {
  resolveDeyeConfig,
  type DeyeConfig,
  type DeyeRuntime,
  type ResolvedDeyeConfig,
} from "./config"
import { makeDeyeRequestClient } from "./DeyeClient"
import { DeyeRawService, type DeyeRawServiceShape } from "./DeyeRawService"
import { decodeLatestResponse, decodeTokenResponse } from "./schemas"
import type { DeyeLatest, DeyeLatestRequest } from "./types"

interface CachedToken {
  /** Kept only in this layer instance; never returned or persisted. */
  readonly authorization: string
  readonly validUntilMs: number
}

interface AuthenticationFlight {
  readonly controller: AbortController
  promise: Promise<CachedToken>
  subscribers: number
  settled: boolean
}

function safeNow(now: () => number): number {
  const value = now()
  return Number.isFinite(value) ? value : Date.now()
}

function asIsoTimestamp(now: () => number): string {
  return new Date(safeNow(now)).toISOString()
}

function asDeyeFailure(error: unknown): DeyeFailure {
  if (
    error instanceof DeyeNotConfiguredError ||
    error instanceof DeyeAuthError ||
    error instanceof DeyeRateLimitError ||
    error instanceof DeyeSchemaError ||
    error instanceof DeyeTimeoutError ||
    error instanceof DeyeUnavailableError
  ) {
    return error
  }
  return new DeyeUnavailableError({
    operation: "device_latest",
    status: null,
    attempts: 1,
  })
}

function credentialBody(config: ResolvedDeyeConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    appSecret: config.credentials.appSecret,
    password: config.credentials.password,
  }
  const identity = config.credentials.identity
  if (identity.kind === "email") body.email = identity.value
  if (identity.kind === "username") body.username = identity.value
  if (identity.kind === "mobile") {
    body.mobile = identity.value
    body.countryCode = identity.countryCode
  }
  if (config.credentials.companyId !== undefined) {
    body.companyId = config.credentials.companyId
  }
  return body
}

function normalizeAuthorization(accessToken: string): string {
  const token = accessToken.replace(/^Bearer\s+/iu, "").trim()
  return `Bearer ${token}`
}

function resolveLatestRequest(
  input: DeyeLatestRequest | string,
  defaultLatest: DeyeLatestRequest | null,
): DeyeLatestRequest | null {
  if (typeof input === "string") {
    const deviceSn = input.trim()
    if (deviceSn === "") return defaultLatest
    return {
      deviceSn,
      ...(defaultLatest?.deviceType === undefined
        ? {}
        : { deviceType: defaultLatest.deviceType }),
    }
  }

  const deviceSn = input.deviceSn.trim()
  if (deviceSn === "") return defaultLatest
  const deviceType = input.deviceType?.trim() || defaultLatest?.deviceType
  return {
    deviceSn,
    ...(deviceType === undefined ? {} : { deviceType }),
  }
}

/**
 * Construct the raw, upstream-specific service. Construction only validates
 * configuration and creates closures; it does not authenticate or perform
 * network I/O. The token cache therefore lives for this finite layer instance
 * only and is never a module/global cache.
 */
export function makeDeyeLive(
  config: DeyeConfig | undefined,
  runtime: DeyeRuntime = {},
): DeyeRawServiceShape {
  const resolvedConfig = resolveDeyeConfig(config)
  const now = runtime.now ?? Date.now

  if (resolvedConfig === null) {
    return {
      readLatest: () => Effect.fail(new DeyeNotConfiguredError()),
    }
  }

  const resolved = resolvedConfig
  const client = makeDeyeRequestClient(resolved, runtime)
  let cachedToken: CachedToken | null = null
  let authenticationInFlight: AuthenticationFlight | null = null

  function cancellationError(): Error {
    const error = new Error("deye operation cancelled")
    error.name = "AbortError"
    return error
  }

  async function authenticate(signal: AbortSignal): Promise<CachedToken> {
    const path = `/v1.0/account/token?appId=${encodeURIComponent(resolved.credentials.appId)}`
    const responsePromise = client.postJson({
      operation: "token",
      path,
      body: credentialBody(resolved),
      decode: decodeTokenResponse,
      signal,
    })
    void responsePromise.catch(() => undefined)
    const response = await responsePromise
    const issuedAtMs = safeNow(now)
    const validUntilMs =
      issuedAtMs +
      Math.max(
        0,
        response.expiresInSeconds - resolved.tokenSafetyMarginSeconds,
      ) *
        1000
    return {
      authorization: normalizeAuthorization(response.accessToken),
      validUntilMs,
    }
  }

  function releaseAuthenticationSubscriber(flight: AuthenticationFlight): void {
    flight.subscribers -= 1
    if (flight.subscribers === 0 && !flight.settled) {
      // The shared request has no remaining owners. An implementation that
      // ignores AbortSignal may still resolve later, so its completion handler
      // also checks subscribers before populating the cache.
      if (authenticationInFlight === flight) authenticationInFlight = null
      flight.controller.abort()
    }
  }

  function subscribeToAuthentication(
    flight: AuthenticationFlight,
    signal: AbortSignal,
  ): Promise<CachedToken> {
    if (signal.aborted) return Promise.reject(cancellationError())

    flight.subscribers += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      releaseAuthenticationSubscriber(flight)
    }

    let resolveAbort!: (error: Error) => void
    const aborted = new Promise<Error>((resolve) => {
      resolveAbort = resolve
    })
    const onAbort = (): void => {
      release()
      resolveAbort(cancellationError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()

    void flight.promise.catch(() => undefined)
    const result = Promise.race([flight.promise, aborted])
      .then((value) => {
        if (value instanceof Error) throw value
        return value
      })
      .finally(() => {
        signal.removeEventListener("abort", onAbort)
        release()
      })
    void result.catch(() => undefined)
    return result
  }

  function createAuthenticationFlight(): AuthenticationFlight {
    const controller = new AbortController()
    let flight!: AuthenticationFlight
    flight = {
      controller,
      promise: authenticate(controller.signal)
        .then((token) => {
          if (flight.subscribers > 0 && !flight.controller.signal.aborted) {
            cachedToken = token
          }
          return token
        })
        .finally(() => {
          flight.settled = true
          if (authenticationInFlight === flight) authenticationInFlight = null
        }),
      subscribers: 0,
      settled: false,
    }
    return flight
  }

  function acquireToken(
    forceReauthentication: boolean,
    signal: AbortSignal,
  ): Promise<CachedToken> {
    if (signal.aborted) return Promise.reject(cancellationError())
    if (forceReauthentication) cachedToken = null
    if (!forceReauthentication && cachedToken !== null) {
      if (safeNow(now) < cachedToken.validUntilMs) return Promise.resolve(cachedToken)
      cachedToken = null
    }
    if (authenticationInFlight === null) {
      authenticationInFlight = createAuthenticationFlight()
    }
    return subscribeToAuthentication(authenticationInFlight, signal)
  }

  function invalidateToken(token: CachedToken): boolean {
    if (cachedToken === token || cachedToken?.authorization === token.authorization) {
      cachedToken = null
      return true
    }
    // Another concurrent request has already installed a newer token. Do not
    // invalidate that replacement or trigger an unnecessary second reauth.
    return false
  }

  async function readLatestOperation(
    input: DeyeLatestRequest | string,
    signal: AbortSignal,
  ): Promise<DeyeLatest> {
    const request = resolveLatestRequest(input, resolved.defaultLatest)
    if (request === null) throw new DeyeNotConfiguredError()

    let reauthenticationCount = 0
    while (true) {
      // Authentication failures from this call are intentionally outside the
      // latest-data retry loop; a failed credential login cannot be fixed by
      // recursively authenticating forever.
      const token = await acquireToken(false, signal)
      try {
        const body = {
          deviceList: [request.deviceSn],
          ...(request.deviceType === undefined ? {} : { deviceType: request.deviceType }),
        }
        return await client.postJson({
          operation: "device_latest",
          path: "/v1.0/device/latest",
          body,
          authorization: token.authorization,
          decode: (text) => decodeLatestResponse(text, asIsoTimestamp(now)),
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw cancellationError()
        if (error instanceof DeyeAuthError) {
          const invalidated = invalidateToken(token)
          if (reauthenticationCount >= 1) throw error
          reauthenticationCount += 1
          // Deye publishes no refresh operation. Re-authentication uses the
          // configured credentials once, with the bound above preventing a
          // 401/403 loop.
          await acquireToken(invalidated, signal)
          continue
        }
        throw error
      }
    }
  }

  async function readLatestAsync(
    input: DeyeLatestRequest | string,
    signal: AbortSignal,
  ): Promise<DeyeLatest> {
    try {
      return await readLatestOperation(input, signal)
    } catch (error) {
      // Effect interruption owns the result once the signal is aborted. Keep
      // the underlying promise from rejecting after tryPromise has already
      // been interrupted; the request client still aborts/discards upstream
      // work through the same signal.
      if (signal.aborted) throw cancellationError()
      throw error
    }
  }

  return {
    readLatest: (input) =>
      Effect.tryPromise({
        try: (signal) => {
          const result = readLatestAsync(input, signal)
          void result.catch(() => undefined)
          return result
        },
        catch: asDeyeFailure,
      }),
  }
}

/** Compose the raw adapter as an Effect Layer; no request occurs here. */
export function makeDeyeLayer(
  config: DeyeConfig | undefined,
  runtime: DeyeRuntime = {},
): Layer.Layer<DeyeRawServiceShape> {
  return Layer.succeed(DeyeRawService, makeDeyeLive(config, runtime))
}

export const DeyeLive = makeDeyeLayer
export const deyeRawLayer = makeDeyeLayer
