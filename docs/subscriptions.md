# Server event subscriptions

The server uses **hibernating WebSockets**, not SSE or continuous polling.
Cloudflare holds desktop connections while the station's Durable Object sleeps.
The [desktop client](../clients/README.md#desktop-subscriptions) consumes this
protocol and displays OS notifications.

## Connection

Open `wss://your-worker.example/api/v1/events/subscribe` with these handshake
headers:

```http
Upgrade: websocket
Authorization: Bearer <API_BEARER_TOKEN>
Last-Event-ID: <optional last processed cursor>
```

Use a desktop WebSocket library that supports custom handshake headers. Native
browser WebSocket cannot set bearer headers; browser authentication would need a
separate design. Do not put tokens in URLs.

The Worker authenticates and applies the existing API-attempt and read rate
limits before forwarding the upgrade to the station object. It selects the
station server-side and does not forward the bearer token. Cloudflare supplies
the client IP; direct local requests need a synthetic `CF-Connecting-IP`.
Query parameters, bodies, and HEAD subscriptions are rejected.

Success is HTTP `101 Switching Protocols`. Non-upgrade requests return `426`.
The previous SSE endpoint `/api/v1/events/stream` is no longer implemented.

## Protocol, version 1

Messages are JSON text frames. First:

```json
{"type":"ready","version":1,"expiresAt":1794654000000}
```

Without a cursor, the connection replays retained history oldest-first and then
waits for committed changes. With `Last-Event-ID`, replay begins strictly after
that cursor. Each event looks like:

```json
{
  "type": "grid.changed",
  "version": 1,
  "cursor": "<opaque resume cursor>",
  "data": {
    "id": "event-id",
    "status": "offline",
    "observedAt": "2026-11-14T10:00:00.000Z",
    "previousStatus": "online",
    "previousObservedAt": "2026-11-14T09:59:00.000Z",
    "evidence": ["grid_voltage"],
    "source": "deye-cloud"
  }
}
```

The internal station ID is not returned. After a bounded page, the server sends:

```json
{"type":"checkpoint","cursor":"<last cursor in this page>","hasMore":false}
```

After processing the page and durably saving its cursor, acknowledge:

```json
{"type":"ack","cursor":"<checkpoint cursor>"}
```

**Always acknowledge a checkpoint, even when `hasMore` is false.** The server
allows only one unacknowledged page. An acknowledgement checks for any events
committed in the meantime; otherwise the server goes idle. This is flow control,
not polling. A stalled consumer cannot accumulate unlimited server-sent pages.
Repeated acknowledgements of the last acknowledged checkpoint are harmless.
Unexpected acknowledgements, binary messages, invalid JSON, and oversized
messages close the connection.

Pages contain at most 100 events and 32 KiB of event-message payloads, plus one
small checkpoint. Connection offsets and acknowledgement state are serialized
as WebSocket attachments, so they survive hibernation. Per-socket work is
serialized to prevent replay, acknowledgement, and publication races.

The client can send literal text `ping` and receive `pong` without waking the
object. WebSocket protocol ping/pong is also handled by Cloudflare. The server
does not run heartbeat timers.

## Reconnect and recovery

- Save the cursor only after processing an event/page.
- Reconnect after network loss, sleep/wake, or deployment with exponential
  backoff/jitter and the last processed cursor.
- Deduplicate using `data.id`; exactly-once delivery is not promised.
- History is retained for 12 hours, pruned on refresh. A missing/cross-station
  cursor returns HTTP `409 RESYNC_REQUIRED` before upgrade. After upgrade,
  `{"type":"resync.required","reason":"cursor_expired"}` closes with code 4009.
  Reload current status and reconnect without a cursor. Missing older events
  cannot be recovered.
- Invalid/unavailable storage produces sanitized HTTP `503` errors or
  `{"type":"stream.error","reason":"STORAGE_UNAVAILABLE"}` followed by close
  code 1011.
- Sessions have a one-hour authorization lifetime. `ready.expiresAt` tells the
  client when to reconnect with valid credentials. Expiration is enforced
  before further data delivery; activity after expiry produces
  `{"type":"reconnect","reason":"reauthenticate"}` and close code 4001.
  An idle connection is not woken solely to close it. Automatic ping replies do
  not extend authorization.

Read `/api/v1/status` separately for current freshness-evaluated status.
Historical changes are not claims about current grid state and should not all
be shown as fresh OS alerts after a long absence.

## Durable event-driven delivery

The normal refresh composition supplies `GridEventDelivery` to ingestion:

1. On a real confirmed transition, allocate the event ID.
2. **Before committing**, persist a delivery reservation and a safety alarm in
   the station's SQLite-backed Durable Object.
3. Only after arming succeeds, use the existing fenced D1 transaction to commit
   the snapshot, event, context, and poll metadata.
4. Attempt immediate publication. It reads committed history and wakes connected
   sockets; it does not trust an uncommitted event payload.
5. If the process crashes or the fast path fails after commit, the already-armed
   alarm retries. Reservations survive object restarts.
6. A reservation without a committed event is discarded only after its lease
   deadline passes according to **D1's clock**. The refresh fence forbids a
   later commit, so aborted ingestions cannot create phantom notifications.

This pre-commit reservation protocol closes the commit-to-wakeup crash gap
without a D1/Queue dual write or an always-running dispatcher. If arming fails,
the transition does not commit. A failed publication after commit does not
retroactively fail the stored observation. Retry delays back off to roughly one
minute while reservations remain; alarms stop when the outbox is drained.
There are no scheduled reads when only idle subscribers remain.

Reservations are a delivery signal, not a second event log. Successful fan-out
does not mean the OS showed a notification. Per-client processing is recovered
through acknowledgements/reconnect replay, bounded by D1 history retention.
Arbitrary D1 inserts outside ingestion do not trigger publication automatically.
Custom ingestion compositions must explicitly supply `GridEventDelivery`.

## Resources and deployment

- Maximum 100 simultaneous sockets per station, including concurrent handshakes.
- Uses `acceptWebSocket`, `getWebSockets`, and serialized attachments—not the
  non-hibernating `WebSocket.accept()` server API or a permanent in-memory registry.
- No timers, recurring database checks, or SSE streaming responses.
- Idle hibernation-eligible time does not consume Durable Object duration.
  Handshakes, replay/acknowledgement handlers, publication, retry alarms, and
  storage still consume quotas. This is free-tier-oriented, not a guarantee that
  every workload fits free quotas.

The existing `GRID_EVENT_STREAMS` binding, `GridEventStream` class identity, and
`grid-event-stream-v1` SQLite migration are retained. Both default and production
Wrangler configurations include the binding. No new D1 migration or secret is
required; durable reservations use the object's existing SQLite-backed storage.
No remote deployment is performed by this change.

Subscriptions do not enable upstream polling or change grid classification.
The current conservative normalizer still reports unverified/unknown grid
status; generating real on/off events requires a separately validated classifier.

References:
[Hibernating WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) ·
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
