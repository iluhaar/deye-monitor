import { Schema } from "effect"
import type { EventCursor, EventQuery } from "../services/StorageService"

export const MAX_API_URL_LENGTH = 4096
export const MAX_API_QUERY_LENGTH = 2048
export const MAX_EVENT_CURSOR_LENGTH = 512
export const MAX_EVENT_DATE_LENGTH = 64
export const MAX_EVENT_CURSOR_ID_LENGTH = 128

const EVENT_QUERY_KEYS = new Set(["limit", "cursor", "from", "to"])

const LimitSchema = Schema.NumberFromString.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(100),
  ),
)

const RawEventsQuerySchema = Schema.Struct({
  limit: Schema.optional(LimitSchema),
  cursor: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
})

const CursorSchema = Schema.Struct({
  observedAt: Schema.String,
  id: Schema.String,
})

export class InvalidEventsQuery extends Error {
  readonly _tag = "InvalidEventsQuery"
}

export function validateEventsQueryBounds(url: URL): void {
  if (url.search.length > MAX_API_QUERY_LENGTH) throw new InvalidEventsQuery()

  const seen = new Set<string>()
  let parameterCount = 0

  for (const [key, value] of url.searchParams) {
    parameterCount += 1

    if (parameterCount > EVENT_QUERY_KEYS.size || !EVENT_QUERY_KEYS.has(key) || seen.has(key)) {
      throw new InvalidEventsQuery()
    }

    seen.add(key)

    if (key === "limit" && value.length > 3) throw new InvalidEventsQuery()

    if (key === "cursor" && value.length > MAX_EVENT_CURSOR_LENGTH) throw new InvalidEventsQuery()

    if ((key === "from" || key === "to") && value.length > MAX_EVENT_DATE_LENGTH) {
      throw new InvalidEventsQuery()
    }
  }
}

function normalizeTimestamp(value: string | undefined): string | null {
  if (value === undefined) return null

  if (value.length > MAX_EVENT_DATE_LENGTH) throw new InvalidEventsQuery()

  if (value.trim() === "") throw new InvalidEventsQuery()
  const millis = Date.parse(value)

  if (!Number.isFinite(millis)) throw new InvalidEventsQuery()

  return new Date(millis).toISOString()
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidEventsQuery()
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4)

  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))

    return new TextDecoder().decode(bytes)
  } catch {
    throw new InvalidEventsQuery()
  }
}

function decodeCursor(value: string | undefined): EventCursor | null {
  if (value === undefined) return null

  if (value.length > MAX_EVENT_CURSOR_LENGTH) throw new InvalidEventsQuery()

  if (value.trim() === "") throw new InvalidEventsQuery()

  let parsed: unknown

  try {
    parsed = JSON.parse(decodeBase64Url(value))
    const cursor = Schema.decodeUnknownSync(CursorSchema)(parsed)

    if (cursor.id.trim() === "" || cursor.id.length > MAX_EVENT_CURSOR_ID_LENGTH) {
      throw new InvalidEventsQuery()
    }

    const observedAt = normalizeTimestamp(cursor.observedAt)

    if (observedAt === null) throw new InvalidEventsQuery()

    return { observedAt, id: cursor.id }
  } catch (error) {
    if (error instanceof InvalidEventsQuery) throw error
    throw new InvalidEventsQuery()
  }
}

export function encodeEventCursor(cursor: EventCursor | null): string | null {
  if (cursor === null) return null

  if (cursor.id.length === 0 || cursor.id.length > MAX_EVENT_CURSOR_ID_LENGTH ||
    cursor.observedAt.length > MAX_EVENT_DATE_LENGTH) {
    throw new InvalidEventsQuery()
  }

  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ""

  for (const byte of bytes) binary += String.fromCharCode(byte)

  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")

  if (encoded.length > MAX_EVENT_CURSOR_LENGTH) throw new InvalidEventsQuery()

  return encoded
}

export function parseEventsQuery(
  url: URL,
  stationId: string,
): EventQuery {
  validateEventsQueryBounds(url)

  const input = {
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  }

  let decoded: Schema.Schema.Type<typeof RawEventsQuerySchema>

  try {
    decoded = Schema.decodeUnknownSync(RawEventsQuerySchema)(input)
  } catch {
    throw new InvalidEventsQuery()
  }

  const from = normalizeTimestamp(decoded.from)
  const to = normalizeTimestamp(decoded.to)

  if (from !== null && to !== null && from > to) {
    throw new InvalidEventsQuery()
  }

  return {
    stationId,
    limit: decoded.limit ?? 25,
    cursor: decodeCursor(decoded.cursor),
    from,
    to,
  }
}
