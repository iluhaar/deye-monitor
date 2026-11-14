import type { D1Database } from "@cloudflare/workers-types"
import { Schema } from "effect"
import type { EventCursor } from "../services/StorageService"
import { decodeEventRow, EventRowSchema } from "./D1Live"

/** Read oldest-first from the primary; cursor validation and replay share a transaction. */
export async function readStreamHistory(
  db: D1Database,
  stationId: string,
  cursor: EventCursor | null,
) {
  const session = db.withSession("first-primary")
  const boundary = cursor === null ? "" : "AND (observed_at > ? OR (observed_at = ? AND id > ?))"

  const values = cursor === null ? [stationId] : [
    stationId, cursor.observedAt, cursor.observedAt, cursor.id,
  ]

  const results = await session.batch([
    session.prepare(cursor === null
      ? "SELECT 1"
      : "SELECT 1 FROM grid_events WHERE station_id = ? AND observed_at = ? AND id = ?")
      .bind(...(cursor === null ? [] : [stationId, cursor.observedAt, cursor.id])),
    session.prepare(`SELECT id, station_id, status, observed_at, previous_status,
      previous_observed_at, evidence_json, source FROM grid_events
      WHERE station_id = ? ${boundary} ORDER BY observed_at ASC, id ASC LIMIT 100`).bind(...values),
  ])

  if (results[0].results.length === 0) return null

  return results[1].results.map((row) => decodeEventRow(Schema.decodeUnknownSync(EventRowSchema)(row)))
}
