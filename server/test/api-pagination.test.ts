import { applyD1Migrations, env } from "cloudflare:test"
import { Schema } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/api/app"
import type { Env } from "../src/env"

const bindings = env
const db = bindings.DB
const readToken = "synthetic-read-token-with-at-least-32-characters"
const from = "2026-10-24T10:00:00.000Z"
const to = "2026-10-24T12:00:00.000Z"

const EventSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["online", "offline"]),
  observedAt: Schema.String,
  previousStatus: Schema.NullOr(Schema.Literals(["online", "offline"])),
  previousObservedAt: Schema.NullOr(Schema.String),
  evidence: Schema.Array(Schema.String),
  source: Schema.Literals(["deye-cloud"]),
})

const EventPageSchema = Schema.Struct({
  ok: Schema.Literal(true),
  data: Schema.Struct({
    events: Schema.Array(EventSchema),
    nextCursor: Schema.NullOr(Schema.String),
  }),
})

interface PaginationEvent {
  readonly id: string
  readonly status: "online" | "offline"
  readonly observedAt: string
}

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS)
})

function eventRequest(cursor: string | null): Request {
  const params = new URLSearchParams({ limit: "2", from, to })

  if (cursor !== null) params.set("cursor", cursor)

  return new Request(`https://example.test/api/v1/events?${params}`, {
    headers: { Authorization: `Bearer ${readToken}` },
  })
}

async function readPage(response: Response) {
  expect(response.status).toBe(200)

  return Schema.decodeUnknownSync(EventPageSchema)(await response.json())
}

async function insertEvent(stationId: string, event: PaginationEvent): Promise<void> {
  await db.prepare(`INSERT INTO grid_events (
      id, station_id, status, observed_at, previous_status,
      previous_observed_at, evidence_json, source, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'deye-cloud', ?, ?)`)
    .bind(event.id, stationId, event.status, event.observedAt,
      '["synthetic_pagination_signal"]', event.id, event.observedAt)
    .run()
}

describe("authenticated event pagination over local D1", () => {
  it("returns every in-range event once in stable order across a tied-timestamp cursor", async () => {
    const stationId = crypto.randomUUID()
    const eventId = (label: string) => `${stationId}-${label}`

    const environment: Env = {
      DB: db,
      API_BEARER_TOKEN: readToken,
      STATION_ID: stationId,
    }

    const app = createApp()

    await db.prepare(`INSERT INTO stations (id, source, mapping_revision, created_at, updated_at)
      VALUES (?, 'deye-cloud', 'pagination-test', ?, ?)`)
      .bind(stationId, from, from)
      .run()

    const fixtureEvents: readonly PaginationEvent[] = [
      { id: eventId("outside-before"), status: "online", observedAt: "2026-10-24T09:59:59.999Z" },
      { id: eventId("at-from"), status: "online", observedAt: from },
      { id: eventId("tie-a"), status: "offline", observedAt: "2026-10-24T11:00:00.000Z" },
      { id: eventId("tie-b"), status: "online", observedAt: "2026-10-24T11:00:00.000Z" },
      { id: eventId("tie-c"), status: "offline", observedAt: "2026-10-24T11:00:00.000Z" },
      { id: eventId("at-to"), status: "offline", observedAt: to },
      { id: eventId("outside-after"), status: "online", observedAt: "2026-10-24T12:00:00.001Z" },
    ]

    for (const event of fixtureEvents) await insertEvent(stationId, event)

    const first = await readPage(await app.fetch(eventRequest(null), environment))

    expect(first.data.events.map((event) => event.id)).toEqual([
      eventId("at-to"),
      eventId("tie-c"),
    ])
    const firstCursor = first.data.nextCursor

    if (firstCursor === null) throw new Error("expected a cursor for the second page")

    const second = await readPage(await app.fetch(eventRequest(firstCursor), environment))

    expect(second.data.events.map((event) => event.id)).toEqual([
      eventId("tie-b"),
      eventId("tie-a"),
    ])
    const secondCursor = second.data.nextCursor

    if (secondCursor === null) throw new Error("expected a cursor for the final page")

    const third = await readPage(await app.fetch(eventRequest(secondCursor), environment))

    expect(third.data.events.map((event) => event.id)).toEqual([eventId("at-from")])
    expect(third.data.nextCursor).toBeNull()

    const eventIds: string[] = []
    const seenIds = new Set<string>()

    for (const event of [...first.data.events, ...second.data.events, ...third.data.events]) {
      eventIds.push(event.id)
      seenIds.add(event.id)
    }

    expect(eventIds).toEqual([
      eventId("at-to"),
      eventId("tie-c"),
      eventId("tie-b"),
      eventId("tie-a"),
      eventId("at-from"),
    ])
    expect(seenIds.size).toBe(5)
  })
})
