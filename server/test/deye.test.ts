import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import fixture from "./fixtures/deye-device-latest.json"
import {
  normalizeDeyeDeviceLatest,
  type DeyeDeviceLatestResponse,
} from "../src/domain/normalization"
import {
  DeyeAuthError,
  DeyeNotConfiguredError,
  DeyeRateLimitError,
  DeyeSchemaError,
  DeyeTimeoutError,
  DeyeUnavailableError,
} from "../src/errors/DeyeErrors"
import { makeDeyeRequestClient } from "../src/deye/DeyeClient"
import { resolveDeyeConfig } from "../src/deye/config"
import { makeDeyeLayer } from "../src/deye/DeyeLive"
import { DeyeRawService } from "../src/deye/DeyeRawService"
import { decodeLatestResponse, decodeTokenResponse } from "../src/deye/schemas"

const FIXED_NOW = Date.parse("2026-10-24T12:00:00.000Z")

interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

type FetchStep =
  | Response
  | Error
  | (() => Promise<Response>)

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fakeFetch(steps: readonly FetchStep[]) {
  const calls: FetchCall[] = []
  let index = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    const step = steps[index]
    index += 1
    if (step === undefined) throw new Error("unexpected fake request")
    if (step instanceof Error) throw step
    if (typeof step === "function") return step()
    return step
  }
  return { fetch, calls }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function hangingCancelStream(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel()
      return new Promise<void>(() => undefined)
    },
  })
}

function authSuccess(expiresIn = "5183999"): Response {
  return response({
    code: "1000000",
    success: true,
    accessToken: "Bearer token-that-must-not-leak",
    tokenType: "bearer",
    expiresIn,
    scope: "all",
  })
}

function latestSuccess(): Response {
  return response({
    code: "1000000",
    msg: "success",
    success: true,
    deviceDataList: [
      {
        deviceSn: "INVERTER_1",
        deviceType: "INVERTER",
        deviceState: 1,
        collectionTime: 1792851317,
        dataList: [
          { key: "GridVoltageL1L2", value: "221.10", unit: "V" },
          { key: "SOC", value: "100", unit: "%" },
          { key: "ProtocolVersion", value: "0201", unit: null },
          { key: "MissingReading", unit: null },
        ],
      },
    ],
  })
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://configured-region.example.test",
    appId: "app-id",
    appSecret: "app-secret",
    passwordHash: "lowercase-sha256",
    email: "operator@example.test",
    deviceSn: "INVERTER_1",
    deviceType: "INVERTER",
    timeoutMs: 20,
    maxRetries: 2,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    tokenSafetyMarginSeconds: 60,
    ...overrides,
  }
}

async function runLatest(
  layer: ReturnType<typeof makeDeyeLayer>,
  request: string | { readonly deviceSn: string; readonly deviceType?: string } = "",
) {
  return Effect.runPromise(latestProgram(layer, request))
}

function latestProgram(
  layer: ReturnType<typeof makeDeyeLayer>,
  request: string | { readonly deviceSn: string; readonly deviceType?: string } = "",
) {
  return Effect.provide(
    DeyeRawService.use((service) => service.readLatest(request)),
    layer,
  )
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    throw new Error("expected the Effect to fail")
  } catch (error) {
    return error
  }
}

describe("read-only Deye raw adapter", () => {
  it("decodes the sanitized device/latest shape without normalizing measurements", async () => {
    const http = fakeFetch([authSuccess(), latestSuccess()])
    const layer = makeDeyeLayer(config(), {
      fetch: http.fetch,
      now: () => FIXED_NOW,
      sleep: async () => undefined,
    })

    const result = await runLatest(layer)

    expect(result).toMatchObject({
      success: true,
      code: "1000000",
      msg: "success",
      fetchedAt: "2026-10-24T12:00:00.000Z",
    })
    expect(result.deviceDataList[0]).toMatchObject({
      deviceSn: "INVERTER_1",
      deviceType: "INVERTER",
      deviceState: 1,
      collectionTime: 1792851317,
    })
    expect(result.deviceDataList[0]?.dataList).toEqual([
      { key: "GridVoltageL1L2", value: "221.10", unit: "V" },
      { key: "SOC", value: "100", unit: "%" },
      { key: "ProtocolVersion", value: "0201", unit: null },
      { key: "MissingReading", value: null, unit: null },
    ])
    expect(http.calls).toHaveLength(2)
    expect(http.calls[0]?.url).toBe(
      "https://configured-region.example.test/v1.0/account/token?appId=app-id",
    )
    expect(http.calls[1]?.url).toBe(
      "https://configured-region.example.test/v1.0/device/latest",
    )
    expect(JSON.parse(String(http.calls[1]?.init?.body))).toEqual({
      deviceList: ["INVERTER_1"],
      deviceType: "INVERTER",
    })
    expect(http.calls[1]?.init?.headers).toMatchObject({
      Authorization: "Bearer token-that-must-not-leak",
    })
  })

  it("classifies malformed HTTP-200 JSON as a schema failure without retrying", async () => {
    const http = fakeFetch([authSuccess(), new Response("{malformed", { status: 200 })])
    const layer = makeDeyeLayer(config(), {
      fetch: http.fetch,
      sleep: async () => undefined,
    })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeSchemaError)
    expect((error as DeyeSchemaError).reason).toBe("invalid_json")
    expect(http.calls).toHaveLength(2)
  })

  it("enforces the response-size limit before decoding the body", async () => {
    const http = fakeFetch([
      authSuccess(),
      new Response(JSON.stringify({ success: true, deviceDataList: ["x".repeat(300)] }), {
        status: 200,
      }),
    ])
    const layer = makeDeyeLayer(config({ maxResponseBytes: 256 }), {
      fetch: http.fetch,
      sleep: async () => undefined,
    })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeSchemaError)
    expect((error as DeyeSchemaError).reason).toBe("payload_too_large")
    expect(http.calls).toHaveLength(2)
  })

  it("maps a HTTP-200 auth envelope failure without exposing its message", async () => {
    const secret = "message contains no credentials in this error"
    const http = fakeFetch([
      response({
        code: "2101017",
        msg: secret,
        success: false,
      }),
    ])
    const layer = makeDeyeLayer(config(), { fetch: http.fetch })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeAuthError)
    expect((error as DeyeAuthError).code).toBe("2101017")
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(http.calls).toHaveLength(1)
  })

  it("does not follow a credential POST redirect and treats it as non-retryable", async () => {
    const http = fakeFetch([
      new Response(null, {
        status: 307,
        headers: { Location: "https://attacker.example.test/collect" },
      }),
    ])
    const layer = makeDeyeLayer(config(), {
      fetch: http.fetch,
      sleep: async () => undefined,
    })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeUnavailableError)
    expect((error as DeyeUnavailableError).status).toBe(307)
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0]?.init?.redirect).toBe("manual")
  })

  it("rejects unsafe regional URLs and absolute paths from another origin", async () => {
    for (const baseUrl of [
      "https://user:password@configured-region.example.test",
      "https://configured-region.example.test/?query=1",
      "https://configured-region.example.test/#fragment",
      "https://configured-region.example.test/api",
    ]) {
      expect(resolveDeyeConfig(config({ baseUrl }))).toBeNull()
    }

    const http = fakeFetch([])
    const resolved = resolveDeyeConfig(config())
    if (resolved === null) throw new Error("expected test config to resolve")
    const client = makeDeyeRequestClient(resolved, {
      fetch: http.fetch,
      sleep: async () => undefined,
    })
    const error = await rejected(
      client.postJson({
        operation: "device_latest",
        path: "https://other-region.example.test/v1.0/device/latest",
        body: {},
        decode: () => undefined,
      }),
    )

    expect(error).toBeInstanceOf(DeyeUnavailableError)
    expect(http.calls).toHaveLength(0)
  })

  it("classifies explicit non-success codes even when success is true", async () => {
    const tokenHttp = fakeFetch([
      response({
        code: "2101017",
        success: true,
        accessToken: "Bearer token",
        tokenType: "bearer",
        expiresIn: "5183999",
      }),
    ])
    const tokenLayer = makeDeyeLayer(config(), { fetch: tokenHttp.fetch })
    const tokenError = await rejected(runLatest(tokenLayer))
    expect(tokenError).toBeInstanceOf(DeyeAuthError)
    expect(tokenHttp.calls).toHaveLength(1)

    const latestHttp = fakeFetch([
      authSuccess(),
      response({ code: "429", success: true, deviceDataList: [] }),
      response({ code: "429", success: true, deviceDataList: [] }),
      response({ code: "429", success: true, deviceDataList: [] }),
    ])
    const latestLayer = makeDeyeLayer(config({ maxRetries: 2 }), {
      fetch: latestHttp.fetch,
      sleep: async () => undefined,
    })
    const latestError = await rejected(runLatest(latestLayer))
    expect(latestError).toBeInstanceOf(DeyeRateLimitError)
    expect((latestError as DeyeRateLimitError).attempts).toBe(3)
    expect(latestHttp.calls).toHaveLength(4)
  })

  it("direct decoders reject contradictory success codes", () => {
    expect(() =>
      decodeTokenResponse(
        JSON.stringify({
          code: "2101017",
          success: true,
          accessToken: "Bearer token",
          expiresIn: "5183999",
        }),
      ),
    ).toThrow(DeyeAuthError)
    expect(() =>
      decodeLatestResponse(
        JSON.stringify({ code: "9999999", success: true, deviceDataList: [] }),
        "2026-10-24T14:15:30.000Z",
      ),
    ).toThrow(DeyeUnavailableError)
  })

  it.each([401, 403])("reauthenticates once after HTTP %s, then fails closed", async (status) => {
    const http = fakeFetch([
      authSuccess(),
      new Response("upstream auth failure", { status }),
      authSuccess(),
      new Response("upstream auth failure", { status }),
    ])
    const layer = makeDeyeLayer(config(), {
      fetch: http.fetch,
      sleep: async () => undefined,
    })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeAuthError)
    expect((error as DeyeAuthError).status).toBe(status)
    expect(http.calls).toHaveLength(4)
  })

  it("retries 429 only within the configured bound", async () => {
    const delays: number[] = []
    const http = fakeFetch([
      authSuccess(),
      response({ code: "429", success: false }, 429),
      response({ code: "429", success: false }, 429),
      response({ code: "429", success: false }, 429),
    ])
    const layer = makeDeyeLayer(config({ maxRetries: 2 }), {
      fetch: http.fetch,
      random: () => 1,
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeRateLimitError)
    expect((error as DeyeRateLimitError).attempts).toBe(3)
    expect(http.calls).toHaveLength(4)
    expect(delays).toHaveLength(2)
  })

  it("retries timeouts only within the configured bound", async () => {
    const http = fakeFetch([
      authSuccess(),
      () => new Promise<Response>(() => undefined),
      () => new Promise<Response>(() => undefined),
      () => new Promise<Response>(() => undefined),
    ])
    const layer = makeDeyeLayer(config({ timeoutMs: 1, maxRetries: 2 }), {
      fetch: http.fetch,
      sleep: async () => undefined,
    })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeTimeoutError)
    expect((error as DeyeTimeoutError).attempts).toBe(3)
    expect(http.calls).toHaveLength(4)
  })

  it("interrupts pending authentication without starting latest or filling the cache", async () => {
    const authStarted = deferred<void>()
    const firstAuthResponse = deferred<Response>()
    let authCalls = 0
    let authAborted = 0
    const calls: FetchCall[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes("/account/token")) {
        authCalls += 1
        if (authCalls === 1) {
          authStarted.resolve()
          init?.signal?.addEventListener("abort", () => {
            authAborted += 1
          })
          return firstAuthResponse.promise
        }
        return authSuccess()
      }
      return latestSuccess()
    }
    const layer = makeDeyeLayer(config(), { fetch })
    const fiber = Effect.runFork(latestProgram(layer))

    await authStarted.promise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(authAborted).toBe(1)
    expect(calls.filter(({ url }) => url.includes("/device/latest"))).toHaveLength(0)

    // A fetch implementation is allowed to ignore abort and resolve later.
    // That late token must not become a reusable cache entry.
    firstAuthResponse.resolve(authSuccess())
    await Promise.resolve()
    await Promise.resolve()
    await runLatest(layer)

    expect(authCalls).toBe(2)
    expect(calls.filter(({ url }) => url.includes("/device/latest"))).toHaveLength(1)
  })

  it("interrupts a pending latest request and does not retry it", async () => {
    const latestStarted = deferred<void>()
    const lateLatestResponse = deferred<Response>()
    let latestAborted = 0
    const calls: FetchCall[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes("/account/token")) return authSuccess()
      latestStarted.resolve()
      init?.signal?.addEventListener("abort", () => {
        latestAborted += 1
      })
      return lateLatestResponse.promise
    }
    const layer = makeDeyeLayer(config({ maxRetries: 2 }), { fetch })
    const fiber = Effect.runFork(latestProgram(layer))

    await latestStarted.promise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(latestAborted).toBe(1)
    expect(calls.filter(({ url }) => url.includes("/device/latest"))).toHaveLength(1)

    lateLatestResponse.resolve(latestSuccess())
    await Promise.resolve()
  })

  it("interrupts retry backoff before a later request can start", async () => {
    const backoffStarted = deferred<void>()
    let backoffSignal: AbortSignal | undefined
    const http = fakeFetch([authSuccess(), new Response(null, { status: 503 })])
    const layer = makeDeyeLayer(config({ maxRetries: 2 }), {
      fetch: http.fetch,
      sleep: async (_milliseconds, signal) => {
        backoffSignal = signal
        backoffStarted.resolve()
        return new Promise<void>(() => undefined)
      },
    })
    const fiber = Effect.runFork(latestProgram(layer))

    await backoffStarted.promise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(backoffSignal?.aborted).toBe(true)
    expect(http.calls.filter(({ url }) => url.includes("/device/latest"))).toHaveLength(1)
  })

  it("rejects a direct client operation promptly when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const resolved = resolveDeyeConfig(config())
    if (resolved === null) throw new Error("expected test config to resolve")
    const client = makeDeyeRequestClient(resolved, {
      fetch: async () => {
        calls += 1
        return latestSuccess()
      },
    })

    const error = await rejected(
      client.postJson({
        operation: "device_latest",
        path: "/v1.0/device/latest",
        body: {},
        signal: controller.signal,
        decode: () => undefined,
      }),
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe("AbortError")
    expect(calls).toBe(0)
  })

  it("rejects a direct client operation promptly when fetch is pending", async () => {
    const started = deferred<void>()
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const resolved = resolveDeyeConfig(config())
    if (resolved === null) throw new Error("expected test config to resolve")
    const client = makeDeyeRequestClient(resolved, {
      fetch: async (_input, init) => {
        requestSignal = init?.signal ?? undefined
        started.resolve()
        return new Promise<Response>(() => undefined)
      },
    })
    const request = client.postJson({
      operation: "device_latest",
      path: "/v1.0/device/latest",
      body: {},
      signal: controller.signal,
      decode: () => undefined,
    })

    await started.promise
    controller.abort()
    const error = await rejected(request)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe("AbortError")
    expect(requestSignal?.aborted).toBe(true)
  })

  it("rejects a direct client operation promptly while backoff is pending", async () => {
    const backoffStarted = deferred<void>()
    const controller = new AbortController()
    let backoffSignal: AbortSignal | undefined
    const http = fakeFetch([new Response(null, { status: 503 })])
    const resolved = resolveDeyeConfig(config({ maxRetries: 2 }))
    if (resolved === null) throw new Error("expected test config to resolve")
    const client = makeDeyeRequestClient(resolved, {
      fetch: http.fetch,
      sleep: async (_milliseconds, signal) => {
        backoffSignal = signal
        backoffStarted.resolve()
        return new Promise<void>(() => undefined)
      },
    })
    const request = client.postJson({
      operation: "device_latest",
      path: "/v1.0/device/latest",
      body: {},
      signal: controller.signal,
      decode: () => undefined,
    })

    await backoffStarted.promise
    controller.abort()
    const error = await rejected(request)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe("AbortError")
    expect(backoffSignal?.aborted).toBe(true)
    expect(http.calls.filter(({ url }) => url.includes("/device/latest"))).toHaveLength(1)
  })

  it("keeps shared authentication alive for another active consumer", async () => {
    const authStarted = deferred<void>()
    const authResponse = deferred<Response>()
    let authSignal: AbortSignal | undefined
    let authAborted = 0
    const calls: FetchCall[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes("/account/token")) {
        authSignal = init?.signal ?? undefined
        init?.signal?.addEventListener("abort", () => {
          authAborted += 1
        })
        authStarted.resolve()
        return authResponse.promise
      }
      return latestSuccess()
    }
    const layer = makeDeyeLayer(config(), { fetch })
    const first = Effect.runFork(latestProgram(layer))
    const second = Effect.runFork(latestProgram(layer))

    await authStarted.promise
    await Effect.runPromise(Fiber.interrupt(first))

    expect(authSignal?.aborted).toBe(false)
    expect(authAborted).toBe(0)

    authResponse.resolve(authSuccess())
    await Effect.runPromise(Fiber.join(second))

    expect(calls.filter(({ url }) => url.includes("/account/token"))).toHaveLength(1)
    expect(calls.filter(({ url }) => url.includes("/device/latest"))).toHaveLength(1)
  })

  it("cancels non-2xx response bodies without awaiting a hanging cancel", async () => {
    let canceled = false
    const responseBody = hangingCancelStream(() => {
      canceled = true
    })
    const responseWithBody = new Response(responseBody, { status: 401 })
    const body = responseWithBody.body
    const client = makeDeyeRequestClient(resolveDeyeConfig(config())!, {
      fetch: async () => responseWithBody,
    })

    const error = await rejected(
      client.postJson({
        operation: "device_latest",
        path: "/v1.0/device/latest",
        body: {},
        decode: () => undefined,
      }),
    )

    expect(error).toBeInstanceOf(DeyeAuthError)
    expect(canceled).toBe(true)
    expect(body?.locked).toBe(false)
  })

  it("cancels oversized response bodies rejected by Content-Length", async () => {
    let canceled = false
    const responseBody = hangingCancelStream(() => {
      canceled = true
    })
    const responseWithBody = new Response(responseBody, {
      status: 200,
      headers: {
        "content-length": "1024",
        "content-type": "application/json",
      },
    })
    const body = responseWithBody.body
    const client = makeDeyeRequestClient(resolveDeyeConfig(config({ maxResponseBytes: 16 }))!, {
      fetch: async () => responseWithBody,
    })

    const error = await rejected(
      client.postJson({
        operation: "device_latest",
        path: "/v1.0/device/latest",
        body: {},
        decode: () => undefined,
      }),
    )

    expect(error).toBeInstanceOf(DeyeSchemaError)
    expect((error as DeyeSchemaError).reason).toBe("payload_too_large")
    expect(canceled).toBe(true)
    expect(body?.locked).toBe(false)
  })

  it("discards a late response body after timeout aborts an ignored fetch", async () => {
    const lateResponse = deferred<Response>()
    let requestSignal: AbortSignal | undefined
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined
      return lateResponse.promise
    }
    const client = makeDeyeRequestClient(resolveDeyeConfig(config({ timeoutMs: 1, maxRetries: 0 }))!, {
      fetch,
    })
    const request = client.postJson({
      operation: "device_latest",
      path: "/v1.0/device/latest",
      body: {},
      decode: () => undefined,
    })

    const error = await rejected(request)
    expect(error).toBeInstanceOf(DeyeTimeoutError)
    expect(requestSignal?.aborted).toBe(true)

    let canceled = false
    const response = new Response(hangingCancelStream(() => {
      canceled = true
    }), { status: 200 })
    const body = response.body
    lateResponse.resolve(response)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(canceled).toBe(true)
    expect(body?.locked).toBe(false)
  })

  it("caches tokens per layer invocation and reauthenticates before the safety margin", async () => {
    let now = 0
    const http = fakeFetch([authSuccess("120"), latestSuccess(), latestSuccess(), authSuccess("120"), latestSuccess()])
    const layer = makeDeyeLayer(config({ tokenSafetyMarginSeconds: 60 }), {
      fetch: http.fetch,
      now: () => now,
      sleep: async () => undefined,
    })

    await runLatest(layer)
    now = 30_000
    await runLatest(layer)
    now = 61_000
    await runLatest(layer)

    const tokenCalls = http.calls.filter((call) => call.url.includes("/account/token"))
    expect(tokenCalls).toHaveLength(2)
    expect(http.calls).toHaveLength(5)
  })

  it("invalidates the terminal rejected token before the next operation", async () => {
    const http = fakeFetch([
      authSuccess(),
      new Response("expired", { status: 401 }),
      authSuccess(),
      new Response("expired", { status: 401 }),
      authSuccess(),
      latestSuccess(),
    ])
    const layer = makeDeyeLayer(config(), {
      fetch: http.fetch,
      sleep: async () => undefined,
    })

    const firstError = await rejected(runLatest(layer))
    expect(firstError).toBeInstanceOf(DeyeAuthError)
    const secondResult = await runLatest(layer)

    expect(secondResult.success).toBe(true)
    expect(http.calls.filter((call) => call.url.includes("/account/token"))).toHaveLength(3)
    expect(http.calls.filter((call) => call.url.includes("/device/latest"))).toHaveLength(3)
  })

  it("composes the full sanitized fixture through the raw Layer and normalizer offline", async () => {
    const adapterNow = Date.parse("2026-10-24T14:15:30.000Z")
    const http = fakeFetch([authSuccess(), response(fixture)])
    const layer = makeDeyeLayer(config(), {
      fetch: http.fetch,
      now: () => adapterNow,
      sleep: async () => undefined,
    })

    const raw = await runLatest(layer)
    const snapshot = normalizeDeyeDeviceLatest(raw as DeyeDeviceLatestResponse, {
      stationId: "station-internal",
      nowMs: Date.parse("2026-10-24T14:16:00.000Z"),
    })

    expect(raw.deviceDataList[0]?.dataList).toHaveLength(58)
    expect(
      raw.deviceDataList[0]?.dataList.find(({ key }) => key === "BatteryPower")?.value,
    ).toBe("-43")
    expect(snapshot.source).toBe("deye-cloud")
    expect(snapshot.measuredAt).toBe("2026-10-24T14:15:17.000Z")
    expect(snapshot.fetchedAt).toBe("2026-10-24T14:15:30.000Z")
    expect(snapshot.grid.status).toBe("unknown")
    expect(snapshot.grid.confidence).toBe("unverified")
    expect(snapshot.grid.powerW).toBeNull()
    expect(snapshot.battery).toEqual({
      socPercent: 100,
      powerW: null,
      mode: "unknown",
    })
    expect(JSON.stringify(snapshot)).not.toContain("-43")
    expect(JSON.stringify(snapshot)).not.toContain("-72")
  })

  it("fails closed when the regional host or credentials are not configured", async () => {
    let called = false
    const layer = makeDeyeLayer(undefined, {
      fetch: async () => {
        called = true
        return latestSuccess()
      },
    })

    const error = await rejected(runLatest(layer))

    expect(error).toBeInstanceOf(DeyeNotConfiguredError)
    expect(called).toBe(false)
  })
})
