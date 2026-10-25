import { Schema } from "effect"
import type { EventCursor, EventQuery } from "../services/StorageService"

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

function normalizeTimestamp(value: string | undefined): string | null {
  if (value === undefined) return null

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

  if (value.trim() === "") throw new InvalidEventsQuery()

  let parsed: unknown

  try {
    parsed = JSON.parse(decodeBase64Url(value))
    const cursor = Schema.decodeUnknownSync(CursorSchema)(parsed)

    if (cursor.id.trim() === "") throw new InvalidEventsQuery()
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
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ""

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

export function parseEventsQuery(
  url: URL,
  stationId: string,
): EventQuery {
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
