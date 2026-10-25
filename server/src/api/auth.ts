import type { Context, Next } from "hono"
import { Schema } from "effect"
import type { Env } from "../env"

const MIN_API_SECRET_LENGTH = 32
const MAX_API_SECRET_LENGTH = 4096
const BEARER_PREFIX = "Bearer "
const MAX_BEARER_HEADER_LENGTH = BEARER_PREFIX.length + MAX_API_SECRET_LENGTH

const ApiSecretSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\S+$/u)),
)

function isValidApiSecret(value: string | undefined): value is string {
  return value !== undefined && value.length >= MIN_API_SECRET_LENGTH &&
    value.length <= MAX_API_SECRET_LENGTH && Schema.is(ApiSecretSchema)(value)
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length

  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }

  return difference === 0
}

export function hasValidBearerToken(request: Request, configured: string | undefined): boolean {
  if (!isValidApiSecret(configured)) return false
  const authorization = request.headers.get("Authorization")

  if (authorization === null || authorization.length > MAX_BEARER_HEADER_LENGTH ||
    authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return false
  }

  const provided = authorization.slice(BEARER_PREFIX.length)

  if (!isValidApiSecret(provided)) return false

  return constantTimeEqual(provided, configured)
}

export async function requireBearerToken(
  context: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  if (!hasValidBearerToken(context.req.raw, context.env?.API_BEARER_TOKEN)) {
    return context.json(
      {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      },
      401,
    )
  }

  await next()
}

/** Refresh requires BOTH read access and a separate operator credential. */
export async function requireRefreshToken(
  context: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const configured = context.env.API_REFRESH_TOKEN
  const provided = context.req.header("X-Refresh-Token")
  context.header("Vary", "Authorization, X-Refresh-Token")

  if (!isValidApiSecret(configured) ||
    constantTimeEqual(configured, context.env.API_BEARER_TOKEN ?? "") ||
    provided === undefined || !isValidApiSecret(provided) || !constantTimeEqual(provided, configured)) {
    return context.json(
      {
        ok: false,
        error: { code: "FORBIDDEN", message: "Refresh authorization required" },
      },
      403,
    )
  }

  await next()
}
