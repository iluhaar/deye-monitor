import type { DeyeLatestRequest } from "./types"

/**
 * Credentials expected by Deye's token endpoint. `password` is the lowercase
 * SHA-256 digest required by that endpoint, not a plaintext password.
 */
export interface DeyeCredentials {
  readonly appId?: string
  readonly appSecret?: string
  readonly password?: string
  readonly passwordHash?: string
  readonly email?: string
  readonly mobile?: string
  readonly username?: string
  readonly countryCode?: string
  readonly companyId?: number | string
}

/**
 * Regional host selection is deliberately required at runtime. There is no
 * default host: the account/application's configured region must choose it.
 * Flat credential fields are accepted as a convenience for Worker bindings;
 * `credentials` takes precedence for fields it supplies.
 */
export interface DeyeConfig extends DeyeCredentials {
  readonly baseUrl?: string
  readonly credentials?: DeyeCredentials
  readonly deviceSn?: string
  readonly deviceType?: string
  readonly latest?: DeyeLatestRequest
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  /** Number of retries after the initial attempt. */
  readonly maxRetries?: number
  readonly retryBaseDelayMs?: number
  readonly retryMaxDelayMs?: number
  readonly tokenSafetyMarginSeconds?: number
}

export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_RETRY_BASE_DELAY_MS = 100
export const DEFAULT_RETRY_MAX_DELAY_MS = 2_000
export const DEFAULT_TOKEN_SAFETY_MARGIN_SECONDS = 60

export const MAX_RETRIES = 3
export const MAX_RESPONSE_BYTES = 10_000_000
export const MAX_RETRY_DELAY_MS = 30_000

export interface DeyeRuntime {
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly random?: () => number
  /** Optional signal lets retry backoff stop when its request is interrupted. */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export interface ResolvedDeyeCredentials {
  readonly appId: string
  readonly appSecret: string
  readonly password: string
  readonly identity:
    | { readonly kind: "email"; readonly value: string }
    | { readonly kind: "mobile"; readonly value: string; readonly countryCode: string }
    | { readonly kind: "username"; readonly value: string }
  readonly companyId: number | string | undefined
}

export interface ResolvedDeyeConfig {
  readonly baseUrl: string
  readonly credentials: ResolvedDeyeCredentials
  readonly defaultLatest: DeyeLatestRequest | null
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxRetries: number
  readonly retryBaseDelayMs: number
  readonly retryMaxDelayMs: number
  readonly tokenSafetyMarginSeconds: number
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function selectedCredential(config: DeyeConfig): DeyeCredentials {
  return { ...config, ...config.credentials }
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback
}

function boundedNonNegative(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), maximum)
    : fallback
}

/**
 * Resolve and validate non-secret configuration. A `null` result means the
 * adapter must fail closed with DeyeNotConfiguredError rather than guessing a
 * regional endpoint or an account/device identity.
 */
export function resolveDeyeConfig(config: DeyeConfig | undefined): ResolvedDeyeConfig | null {
  if (config === undefined || !nonEmpty(config.baseUrl)) return null

  let baseUrl: URL
  try {
    baseUrl = new URL(config.baseUrl)
  } catch {
    return null
  }
  // Credentials are sent to the token path, so a non-TLS endpoint is never a
  // valid live configuration. Tests can replace fetch without weakening this
  // production invariant.
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    baseUrl.pathname !== "/"
  ) {
    return null
  }

  const source = selectedCredential(config)
  const appId = source.appId?.trim()
  const appSecret = source.appSecret?.trim()
  const password = (source.passwordHash ?? source.password)?.trim()
  if (!nonEmpty(appId) || !nonEmpty(appSecret) || !nonEmpty(password)) return null

  const identities = [
    source.email !== undefined && nonEmpty(source.email)
      ? ({ kind: "email", value: source.email.trim() } as const)
      : null,
    source.mobile !== undefined && nonEmpty(source.mobile) && nonEmpty(source.countryCode)
      ? ({
          kind: "mobile",
          value: source.mobile.trim(),
          countryCode: source.countryCode.trim(),
        } as const)
      : null,
    source.username !== undefined && nonEmpty(source.username)
      ? ({ kind: "username", value: source.username.trim() } as const)
      : null,
  ].filter((identity): identity is NonNullable<typeof identity> => identity !== null)
  if (identities.length !== 1) return null

  const configuredLatest = config.latest
  const deviceSn = configuredLatest?.deviceSn.trim() || config.deviceSn?.trim()
  const deviceType = configuredLatest?.deviceType?.trim() || config.deviceType?.trim()
  const defaultLatest = nonEmpty(deviceSn)
    ? { deviceSn, ...(nonEmpty(deviceType) ? { deviceType } : {}) }
    : null

  const timeoutMs = boundedPositive(config.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000)
  const maxResponseBytes = boundedPositive(
    config.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
  )
  const maxRetries = boundedNonNegative(config.maxRetries, DEFAULT_MAX_RETRIES, MAX_RETRIES)
  const retryBaseDelayMs = boundedNonNegative(
    config.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
    MAX_RETRY_DELAY_MS,
  )
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    boundedNonNegative(config.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS, MAX_RETRY_DELAY_MS),
  )
  const tokenSafetyMarginSeconds = boundedNonNegative(
    config.tokenSafetyMarginSeconds,
    DEFAULT_TOKEN_SAFETY_MARGIN_SECONDS,
    86_400,
  )

  return {
    baseUrl: baseUrl.origin,
    credentials: {
      appId,
      appSecret,
      password,
      identity: identities[0],
      companyId: source.companyId,
    },
    defaultLatest,
    timeoutMs,
    maxResponseBytes,
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs,
    tokenSafetyMarginSeconds,
  }
}
