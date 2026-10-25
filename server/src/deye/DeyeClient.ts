import {
  DeyeAuthError,
  DeyeRateLimitError,
  DeyeSchemaError,
  DeyeTimeoutError,
  DeyeUnavailableError,
  type DeyeFailure,
  type DeyeOperation,
} from "../errors/DeyeErrors"
import type { ResolvedDeyeConfig, DeyeRuntime } from "./config"
import { decodeBodyEnvelope } from "./schemas"

class RequestTimeoutSignal extends Error {}

class RequestCancelledSignal extends Error {
  readonly name = "AbortError"

  constructor() {
    super("deye request cancelled")
  }
}

class ResponseTooLargeSignal extends Error {}

class ResponseReadSignal extends Error {}

class TransientUnavailableSignal extends Error {
  constructor(readonly status: number | null) {
    super("transient upstream failure")
  }
}

/** Retain a typed non-retryable failure through an async Promise catch. */
class DeyeFailureSignal extends Error {
  constructor(readonly failure: DeyeFailure) {
    super("deye request failed")
  }
}

type RetryableSignal =
  | RequestTimeoutSignal
  | ResponseReadSignal
  | TransientUnavailableSignal
  | DeyeRateLimitError

interface FetchResult {
  readonly status: number
  readonly body: string | null
}

type FetchOutcome = FetchResult | RequestControlSignal

export interface DeyeRequestClient {
  readonly postJson: <T>(parameters: {
    readonly operation: DeyeOperation
    readonly path: string
    readonly body: unknown
    readonly authorization?: string
    readonly decode: (text: string) => T
    readonly signal?: AbortSignal
  }) => Promise<T>
}

function isFiniteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value)
}

function clampRandom(random: () => number): number {
  const value = random()

  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

function retryDelay(
  config: ResolvedDeyeConfig,
  retryIndex: number,
  random: () => number,
): number {
  const exponential = Math.min(
    config.retryMaxDelayMs,
    config.retryBaseDelayMs * 2 ** Math.min(retryIndex, 10),
  )

  // Full jitter would also be safe, but retaining at least half the bounded
  // exponential delay avoids immediately stampeding an upstream after a 429.
  return Math.min(
    config.retryMaxDelayMs,
    Math.max(0, Math.round(exponential * (0.5 + clampRandom(random) * 0.5))),
  )
}

function safeStatus(response: Response): number {
  return isFiniteInteger(response.status) ? response.status : 0
}

function bodyByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

type RequestControlSignal = RequestTimeoutSignal | RequestCancelledSignal

function isRequestControlSignal(error: unknown): error is RequestControlSignal {
  return error instanceof RequestTimeoutSignal || error instanceof RequestCancelledSignal
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined)
  } catch {
    // A response implementation may throw synchronously while being discarded.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    // The lock may already have been released by a non-standard response.
  }
}

/** Discard a response body without making cleanup part of request latency. */
function discardResponseBody(response: Response): void {
  const body = response.body

  if (body === null) return

  let reader: ReadableStreamDefaultReader<Uint8Array>

  try {
    reader = body.getReader()
  } catch {
    return
  }

  cancelReader(reader)
  // Do not wait for cancel(): a broken upstream stream must not hold the
  // request open, and releasing the lock is still safe while cancellation is
  // pending.
  releaseReader(reader)
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
  abortPromise: Promise<RequestControlSignal>,
): Promise<string> {
  const contentLength = response.headers.get("content-length")

  if (contentLength !== null) {
    const declared = Number(contentLength)

    if (Number.isFinite(declared) && declared > maxBytes) {
      discardResponseBody(response)
      throw new ResponseTooLargeSignal()
    }
  }

  const reader = response.body?.getReader()

  if (reader === undefined) {
    try {
      const result = await Promise.race([response.text(), abortPromise])

      if (isRequestControlSignal(result)) throw result
      const text = result

      if (bodyByteLength(text) > maxBytes) throw new ResponseTooLargeSignal()

      return text
    } catch (error) {
      if (isRequestControlSignal(error)) throw error

      if (error instanceof ResponseTooLargeSignal) throw error
      throw new ResponseReadSignal()
    }
  }

  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const next = await Promise.race([reader.read(), abortPromise])

      if (isRequestControlSignal(next)) throw next

      if (next.done) break
      const chunk = next.value
      total += chunk.byteLength

      if (total > maxBytes) {
        throw new ResponseTooLargeSignal()
      }

      chunks.push(chunk)
    }
  } catch (error) {
    cancelReader(reader)

    if (isRequestControlSignal(error)) throw error

    if (error instanceof ResponseTooLargeSignal) throw error
    throw new ResponseReadSignal()
  } finally {
    releaseReader(reader)
  }

  const output = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(output)
}

async function fetchAndRead(
  runtime: Required<Pick<DeyeRuntime, "fetch">>,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxResponseBytes: number,
  parentSignal?: AbortSignal,
): Promise<FetchOutcome> {
  const controller = new AbortController()

  const request = {
    ...init,
    signal: controller.signal,
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let abortReason: RequestControlSignal | null = null
  let resolveAbort!: (reason: RequestControlSignal) => void

  const abortPromise = new Promise<RequestControlSignal>((resolve) => {
    resolveAbort = resolve
  })

  const abort = (reason: RequestControlSignal): void => {
    if (abortReason !== null) return
    abortReason = reason
    controller.abort()
    resolveAbort(reason)
  }

  const onParentAbort = (): void => abort(new RequestCancelledSignal())

  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      onParentAbort()
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true })
    }
  }

  if (abortReason === null) {
    timer = setTimeout(() => abort(new RequestTimeoutSignal()), timeoutMs)
  }

  const operation = Promise.resolve()
    .then(() => {
      if (abortReason !== null) throw abortReason

      return runtime.fetch(url, request)
    })
    .then(async (response): Promise<FetchOutcome> => {
      if (abortReason !== null) {
        discardResponseBody(response)

        return abortReason
      }

      const status = safeStatus(response)

      // Error bodies are deliberately not read. This both avoids retaining
      // untrusted text and ensures a malformed/huge 401 cannot hide auth.
      if (status < 200 || status >= 300) {
        discardResponseBody(response)

        return { status, body: null }
      }

      try {
        return {
          status,
          body: await readResponseBody(response, maxResponseBytes, abortPromise),
        }
      } catch (error) {
        if (isRequestControlSignal(error)) return error
        throw error
      }
    })

  void operation.catch(() => undefined)

  try {
    const result = await Promise.race([operation, abortPromise])

    return result
  } catch (error) {
    if (isRequestControlSignal(error)) return error

    if (error instanceof ResponseTooLargeSignal || error instanceof ResponseReadSignal) {
      throw error
    }

    // Fetch/network/body implementation errors are transient, but their raw
    // message is intentionally discarded.
    throw new ResponseReadSignal()
  } finally {
    if (timer !== undefined) clearTimeout(timer)

    if (parentSignal !== undefined) {
      parentSignal.removeEventListener("abort", onParentAbort)
    }
  }
}

async function sleepWithSignal(
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await sleep(milliseconds)

    return
  }

  if (signal.aborted) throw new RequestCancelledSignal()

  let resolveAbort!: (reason: RequestCancelledSignal) => void

  const abortPromise = new Promise<RequestCancelledSignal>((resolve) => {
    resolveAbort = resolve
  })

  const onAbort = (): void => resolveAbort(new RequestCancelledSignal())
  signal.addEventListener("abort", onAbort, { once: true })

  if (signal.aborted) onAbort()

  try {
    const result = await Promise.race([sleep(milliseconds, signal), abortPromise])

    if (result instanceof RequestCancelledSignal) throw result
  } catch (error) {
    if (signal.aborted) throw new RequestCancelledSignal()
    throw error
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function classifyHttpStatus(
  operation: DeyeOperation,
  status: number,
): RetryableSignal | DeyeFailureSignal | DeyeAuthError | DeyeRateLimitError | null {
  if (status === 401 || status === 403) {
    return new DeyeAuthError({ operation, status, code: null })
  }

  if (status === 429) {
    return new DeyeRateLimitError({ operation, status, attempts: 1 })
  }

  if (status >= 500 && status <= 599) {
    return new TransientUnavailableSignal(status)
  }

  if (status >= 300 && status < 400) {
    // Redirects are never followed: credentials must not be sent to another
    // origin, and a redirect is not a transient upstream failure.
    return new DeyeFailureSignal(
      new DeyeUnavailableError({ operation, status, attempts: 1 }),
    )
  }

  if (status < 200 || status >= 300) {
    return new DeyeFailureSignal(
      new DeyeUnavailableError({ operation, status, attempts: 1 }),
    )
  }

  return null
}

function isRetryableFailure(error: unknown): error is RetryableSignal {
  return (
    error instanceof RequestTimeoutSignal ||
    error instanceof ResponseReadSignal ||
    error instanceof TransientUnavailableSignal ||
    error instanceof DeyeRateLimitError
  )
}

function isAuthFailure(error: unknown): error is DeyeAuthError {
  return error instanceof DeyeAuthError
}

function failureForRetry(
  error: RetryableSignal,
  operation: DeyeOperation,
  attempts: number,
): DeyeFailure {
  if (error instanceof RequestTimeoutSignal) {
    return new DeyeTimeoutError({ operation, attempts })
  }

  if (error instanceof DeyeRateLimitError) {
    return new DeyeRateLimitError({ operation, status: 429, attempts })
  }

  return new DeyeUnavailableError({
    operation,
    status: error instanceof TransientUnavailableSignal ? error.status : null,
    attempts,
  })
}

export function makeDeyeRequestClient(
  config: ResolvedDeyeConfig,
  runtime: DeyeRuntime,
): DeyeRequestClient {
  const fetchImplementation = runtime.fetch ?? globalThis.fetch

  const sleep: NonNullable<DeyeRuntime["sleep"]> =
    runtime.sleep ??
    ((milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>

        const onAbort = (): void => {
          clearTimeout(timer)
          reject(new RequestCancelledSignal())
        }

        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        }, milliseconds)

        if (signal !== undefined) {
          signal.addEventListener("abort", onAbort, { once: true })

          if (signal.aborted) onAbort()
        }
      }))

  const random = runtime.random ?? Math.random

  async function postJson<T>(parameters: {
    readonly operation: DeyeOperation
    readonly path: string
    readonly body: unknown
    readonly authorization?: string
    readonly decode: (text: string) => T
    readonly signal?: AbortSignal
  }): Promise<T> {
    let parsedUrl: URL

    try {
      parsedUrl = new URL(parameters.path, `${config.baseUrl}/`)
    } catch {
      throw new DeyeUnavailableError({
        operation: parameters.operation,
        status: null,
        attempts: 0,
      })
    }

    const baseUrl = new URL(config.baseUrl)

    const allowedPath =
      (parameters.operation === "token" && parsedUrl.pathname === "/v1.0/account/token") ||
      (parameters.operation === "device_latest" && parsedUrl.pathname === "/v1.0/device/latest")

    const sameOrigin =
      parsedUrl.origin === baseUrl.origin &&
      parsedUrl.username === "" &&
      parsedUrl.password === ""

    if (!allowedPath || !sameOrigin) {
      throw new DeyeUnavailableError({
        operation: parameters.operation,
        status: null,
        attempts: 0,
      })
    }

    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    })

    if (parameters.authorization !== undefined) {
      headers.set("Authorization", parameters.authorization)
    }

    const body = JSON.stringify(parameters.body)
    const url = parsedUrl.toString()
    let attempt = 0

    while (true) {
      attempt += 1

      if (parameters.signal?.aborted) throw new RequestCancelledSignal()

      try {
        const fetchPromise = fetchAndRead(
          { fetch: fetchImplementation },
          url,
          { method: "POST", redirect: "manual", headers, body },
          config.timeoutMs,
          config.maxResponseBytes,
          parameters.signal,
        )

        const result = await fetchPromise

        if (result instanceof RequestCancelledSignal) {
          throw result
        }

        if (result instanceof RequestTimeoutSignal) {
          if (attempt > config.maxRetries) {
            throw new DeyeFailureSignal(
              failureForRetry(result, parameters.operation, attempt),
            )
          }

          await sleepWithSignal(
            sleep,
            retryDelay(config, attempt - 1, random),
            parameters.signal,
          )
          continue
        }

        if (parameters.signal?.aborted) throw new RequestCancelledSignal()
        const statusFailure = classifyHttpStatus(parameters.operation, result.status)

        if (statusFailure !== null) throw statusFailure

        if (result.body === null) {
          throw new DeyeSchemaError({
            operation: parameters.operation,
            reason: "invalid_payload",
          })
        }

        decodeBodyEnvelope(result.body, parameters.operation)

        return parameters.decode(result.body)
      } catch (error) {
        if (error instanceof RequestCancelledSignal || parameters.signal?.aborted) {
          throw new RequestCancelledSignal()
        }

        if (error instanceof DeyeSchemaError || isAuthFailure(error)) {
          throw error
        }

        if (error instanceof DeyeFailureSignal) {
          throw error.failure
        }

        if (error instanceof ResponseTooLargeSignal) {
          throw new DeyeSchemaError({
            operation: parameters.operation,
            reason: "payload_too_large",
          })
        }

        const retryable = isRetryableFailure(error)

        if (!retryable) {
          throw new DeyeUnavailableError({
            operation: parameters.operation,
            status: null,
            attempts: attempt,
          })
        }

        if (attempt > config.maxRetries) {
          throw failureForRetry(error, parameters.operation, attempt)
        }

        await sleepWithSignal(
          sleep,
          retryDelay(config, attempt - 1, random),
          parameters.signal,
        )
      }
    }
  }

  return {
    postJson: (parameters) => {
      const result = postJson(parameters)
      // Effect interruption can detach its promise continuation before a
      // fetch observes the abort. Keep that detached rejection handled while
      // preserving a promptly rejecting public operation for direct callers.
      void result.catch(() => undefined)

      return result
    },
  }
}

export { isAuthFailure }
