import type { Context, Next } from "hono"
import type { Env } from "../env"

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

export function hasValidBearerToken(request: Request, configured: string | undefined): boolean {
  if (typeof configured !== "string" || configured.length === 0) return false
  const authorization = request.headers.get("Authorization")
  if (authorization === null) return false
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization)
  return match !== null && constantTimeEqual(match[1], configured)
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
