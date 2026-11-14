import { DurableObject } from "cloudflare:workers"
import { Schema } from "effect"
import { decodeEventCursor, encodeEventCursor } from "../api/query"
import type { Env } from "../env"
import type { EventCursor, GridEvent } from "../services/StorageService"
import { readStreamHistory } from "../storage/StreamHistory"

const MAX_SUBSCRIBERS = 100
const MAX_PAGE_BYTES = 32 * 1024
const encoder = new TextEncoder()
const CursorSchema = Schema.NullOr(Schema.Struct({ id: Schema.String, observedAt: Schema.String }))

const AttachmentSchema = Schema.Struct({
  stationId: Schema.String,
  cursor: CursorSchema,
  acknowledged: Schema.NullOr(Schema.String),
  awaitingAck: Schema.Boolean,
  expiresAt: Schema.Number,
})

const AckSchema = Schema.Struct({ type: Schema.Literal("ack"), cursor: Schema.String })

interface DeliveryReservation {
  readonly stationId: string
  readonly eventId: string
  readonly leaseUntil: string
  readonly attempts: number
}

function failure(code: string, message: string, status: number) {
  return Response.json({ ok: false, error: { code, message } }, { status,
    headers: { "Cache-Control": "no-store" } })
}

function eventMessage(event: GridEvent): string {
  if (event.evidence.length > 16 || event.evidence.some((item) => item.length > 64)) {
    throw new Error("invalid event")
  }

  const { stationId: _stationId, ...data } = event

  return JSON.stringify({ type: "grid.changed", version: 1,
    cursor: encodeEventCursor({ observedAt: event.observedAt, id: event.id }), data })
}

/** Retain the class/binding identity from the original stream migration. */
export class GridEventStream extends DurableObject<Env> {
  #opening = 0
  #socketWork = new Map<WebSocket, Promise<void>>()
  #flushing: Promise<void> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Auto-responses and protocol ping/pong do not wake a hibernating object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return failure("UPGRADE_REQUIRED", "Use a WebSocket connection", 426)
    }

    const stationId = request.headers.get("X-Station-ID")

    if (stationId === null || this.env.DB === undefined) {
      return failure("SERVICE_NOT_CONFIGURED", "Subscriptions are not configured", 503)
    }

    const active = this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN)

    if (active.length + this.#opening >= MAX_SUBSCRIBERS) {
      return failure("SUBSCRIBER_LIMIT", "Too many subscribers", 429)
    }

    let cursor: EventCursor | null

    try {
      cursor = decodeEventCursor(request.headers.get("Last-Event-ID") ?? undefined)
    } catch {
      return failure("INVALID_CURSOR", "Invalid event cursor", 400)
    }

    this.#opening += 1

    try {
      // Check before upgrading; read again after acceptance to close the subscribe/publish race.
      const page = await readStreamHistory(this.env.DB, stationId, cursor)

      if (page === null) return failure("RESYNC_REQUIRED", "Event cursor is no longer available", 409)
      page.forEach(eventMessage)
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      const expiresAt = Date.now() + 60 * 60_000
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ stationId, cursor, acknowledged: encodeEventCursor(cursor),
        awaitingAck: false, expiresAt } satisfies Schema.Schema.Type<typeof AttachmentSchema>)
      server.send(JSON.stringify({ type: "ready", version: 1, expiresAt }))
      await this.#serialize(server, () => this.#catchUp(server))

      return new Response(null, { status: 101, webSocket: client })
    } catch {
      return failure("STORAGE_UNAVAILABLE", "Storage is unavailable", 503)
    } finally {
      this.#opening -= 1
    }
  }

  async #serialize(socket: WebSocket, operation: () => Promise<void>) {
    // Only transient in-flight work is in memory; offsets live in socket attachments.
    const prior = this.#socketWork.get(socket) ?? Promise.resolve()

    const work = prior.then(operation).catch(() => {
      this.#close(socket, "stream.error", "STORAGE_UNAVAILABLE", 1011)
    })

    this.#socketWork.set(socket, work)

    try {
      await work
    } finally {
      if (this.#socketWork.get(socket) === work) this.#socketWork.delete(socket)
    }
  }

  #close(socket: WebSocket, type: string, reason: string, code: number) {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type, reason }))
    socket.close(code, reason)
  }

  async #catchUp(socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN) return
    const state = Schema.decodeUnknownSync(AttachmentSchema)(socket.deserializeAttachment())

    if (Date.now() >= state.expiresAt) {
      this.#close(socket, "reconnect", "reauthenticate", 4001)

      return
    }

    // At most one bounded page may be unacknowledged. No per-client timer.
    if (state.awaitingAck) return

    if (this.env.DB === undefined) throw new Error("missing database")
    const events = await readStreamHistory(this.env.DB, state.stationId, state.cursor)

    if (events === null) {
      this.#close(socket, "resync.required", "cursor_expired", 4009)

      return
    }

    if (events.length === 0 || socket.readyState !== WebSocket.OPEN) return
    const messages = events.map(eventMessage)
    let bytes = 0
    let count = 0

    for (const message of messages) {
      const size = encoder.encode(message).byteLength

      if (bytes + size > MAX_PAGE_BYTES) break
      bytes += size
      count += 1
    }

    if (count === 0) throw new Error("oversized event")
    const last = events[count - 1]
    const cursor = { id: last.id, observedAt: last.observedAt }
    socket.serializeAttachment({ ...state, cursor, awaitingAck: true })

    for (const message of messages.slice(0, count)) socket.send(message)
    socket.send(JSON.stringify({ type: "checkpoint", cursor: encodeEventCursor(cursor),
      hasMore: count < events.length || events.length === 100 }))
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#serialize(socket, async () => {
      if (!Schema.is(Schema.String)(message) || message.length > 1024) {
        this.#close(socket, "protocol.error", "invalid_message", 1008)

        return
      }

      let ack: Schema.Schema.Type<typeof AckSchema>

      try {
        ack = Schema.decodeUnknownSync(AckSchema)(JSON.parse(message))
      } catch {
        this.#close(socket, "protocol.error", "invalid_message", 1008)

        return
      }

      const state = Schema.decodeUnknownSync(AttachmentSchema)(socket.deserializeAttachment())

      if (ack.cursor === state.acknowledged) return

      if (!state.awaitingAck || ack.cursor !== encodeEventCursor(state.cursor)) {
        this.#close(socket, "protocol.error", "invalid_ack", 1008)

        return
      }

      socket.serializeAttachment({ ...state, acknowledged: ack.cursor, awaitingAck: false })
      await this.#catchUp(socket)
    })
  }

  webSocketClose(socket: WebSocket): void {
    // Required by this project's pre-2026-04-07 compatibility date.
    socket.close(1000, "closed")
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "connection error")
  }

  /**
   * Durable outbox reservation BEFORE the fenced D1 commit. The commit is forbidden
   * unless this returns, so a crash after commit always has an already-armed retry.
   */
  async arm(stationId: string, eventId: string, leaseUntil: string): Promise<void> {
    if (this.env.DB === undefined || !Number.isFinite(Date.parse(leaseUntil))) {
      throw new Error("invalid delivery reservation")
    }

    await this.ctx.storage.transaction(async (storage) => {
      await storage.put(`delivery:${eventId}`, {
        stationId, eventId, leaseUntil, attempts: 0,
      } satisfies DeliveryReservation)
      const alarm = await storage.getAlarm()

      if (alarm === null || alarm > Date.now() + 5000) await storage.setAlarm(Date.now() + 5000)
    })
  }

  async publish(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing
    const work = this.#flush()
    this.#flushing = work

    try {
      await work
    } finally {
      this.#flushing = null
    }
  }

  async #flush(): Promise<void> {
    const reservations = await this.ctx.storage.list<DeliveryReservation>({ prefix: "delivery:", limit: 100 })

    if (reservations.size === 0) return
    // Persist a retry before external I/O, including if this invocation crashes.
    await this.ctx.storage.setAlarm(Date.now() + 30_000)
    let retryDelay = 60_000

    for (const [key, reservation] of reservations) {
      try {
        if (this.env.DB === undefined) throw new Error("missing database")

        // The database clock is authoritative: no event can commit after its fenced lease expires.
        const row = await this.env.DB.withSession("first-primary").prepare(`SELECT
          EXISTS(SELECT 1 FROM grid_events WHERE station_id = ? AND id = ?) AS committed,
          ? <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS expired`)
          .bind(reservation.stationId, reservation.eventId, reservation.leaseUntil)
          .first<{ committed: number; expired: number }>()

        if (row === null) throw new Error("missing delivery state")

        if (row.committed) {
          for (const socket of this.ctx.getWebSockets()) {
            await this.#serialize(socket, () => this.#catchUp(socket))
          }
        }

        if (row.committed || row.expired) {
          await this.ctx.storage.delete(key)
          continue
        }
      } catch {
        // Keep the reservation on storage/network failure; never invent a grid event.
      }

      const attempts = Math.min(reservation.attempts + 1, 10)
      retryDelay = Math.min(retryDelay, 1000 * 2 ** Math.min(attempts, 6))
      await this.ctx.storage.put(key, { ...reservation, attempts })
    }

    await this.ctx.storage.transaction(async (storage) => {
      const pending = await storage.list({ prefix: "delivery:", limit: 1 })

      if (pending.size === 0) {
        await storage.deleteAlarm()
      } else {
        await storage.setAlarm(Date.now() + retryDelay)
      }
    })
  }

  async alarm(): Promise<void> {
    await this.publish()
  }
}
