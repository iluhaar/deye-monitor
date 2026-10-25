# Deye Monitor

This repository currently contains the documented server plan and the bounded
foundation: a Cloudflare Worker using Hono and Effect 4.0.6, the existing
conservative normalized-domain evaluator, authenticated read-only API routes,
and a D1 read layer with migrations. A read-only Deye adapter now composes with
conservative normalization and finite, fenced D1 ingestion. The ingestion
program is offline-tested but not exposed through an HTTP refresh endpoint.

## Implementation tracking

Implementation progress and issue status live in the [Linear epic ILL-69 — reliable read-only server MVP](https://linear.app/illiadotdev/issue/ILL-69/epic-deye-monitor-reliable-read-only-server-mvp). [`docs/SERVER_PLAN.md`](docs/SERVER_PLAN.md) and supporting docs are design/evidence references, not completion trackers.

Read-only adapter configuration and composition are documented in
[`docs/deye-adapter.md`](docs/deye-adapter.md).

The durable refresh guard and atomic observation-write contract are documented
in [`docs/refresh-protocol.md`](docs/refresh-protocol.md); ingestion and the
manual refresh endpoint are not connected to Worker entrypoints. Finite program
composition and outcome semantics are in [`docs/ingestion.md`](docs/ingestion.md).

## Server development

```sh
cd server
npm ci
npm run typecheck
npm test
npm run build
```

The local D1 database can be initialized with:

```sh
cd server
npm run db:migrate:local
npm run dev
```

For local authenticated requests, put `API_BEARER_TOKEN` and the internal
`STATION_ID` in `server/.dev.vars`; neither is committed. The API uses
`Authorization: Bearer <token>` and returns a stable `{ ok, data }` or
`{ ok, error }` JSON envelope. Successful and failed API responses are marked
`Cache-Control: no-store`.

## Current boundary and limitations

- `GET /api/v1/status`, `/telemetry`, `/battery`, `/events`, and `/health` are
  implemented and authenticated fail-closed.
- Reads use D1 and re-evaluate freshness from measurement and fetch timestamps;
  stored snapshots are not changed by reads. Event pagination is cursor-based,
  range-validated, and deterministic for tied timestamps.
- The D1 read boundary requires finite persisted numeric readings and nullable
  battery SOC in `0..100`. Persisted event timestamps must be canonical UTC
  `new Date(ms).toISOString()` values; verified events require non-empty
  evidence and coherent prior status/time fields. Invalid rows fail closed as
  sanitized storage errors.
- The current device/latest mapping retains measured voltage and frequency,
  nullable missing fields, and separate source and fetch times. Grid status
  remains `unknown`/unverified and battery mode remains `unknown`; no approved
  grid classifier is claimed. Zero power is not outage evidence.
- The read-only Deye adapter composes with normalization and finite ingestion,
  but no Worker entrypoint invokes it yet. No production calls
  have been made, and credentials are not test fixtures. Regional host/config,
  token-lifecycle live checks, polling cadence, power sign semantics, and the
  approved grid classifier still require validation.
- Finite ingestion atomically stores snapshots, poll metadata and verified
  transition history through the durable refresh guard. The refresh endpoint
  and Cron are not wired; existing API routes remain stored-data reads. Failed
  collection degrades effective status without replacing stored measurements.
  No deployment or production readiness is implied.
- The migration includes `stations`, `latest_snapshots`, `grid_events`,
  `poll_runs`, and a durable `refresh_guards` table. A second migration adds
  persisted throttling, observation watermarks, and commit assertions. A third
  adds last-confirmed context, gap metadata, and fenced poll outcomes. Apply all
  migrations before running the Worker. No migration stores credentials or
  access tokens.
