# Deye Monitor

This repository currently contains the documented server plan and the bounded
start of Phase 2: a Cloudflare Worker using Hono and Effect 4.0.6, a
conservative normalized domain evaluator, authenticated read-only API routes,
and a D1 read layer with initial migrations.

## Implementation tracking

Implementation progress and issue status live in the [Linear epic ILL-69 — reliable read-only server MVP](https://linear.app/illiadotdev/issue/ILL-69/epic-deye-monitor-reliable-read-only-server-mvp). [`docs/SERVER_PLAN.md`](docs/SERVER_PLAN.md) and supporting docs are design/evidence references, not completion trackers.

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
- Grid state remains `unknown` unless a normalized snapshot explicitly carries
  confirmed, recognized grid evidence. Zero power is not outage evidence.
- No live Deye adapter, upstream calls, ingestion workflow, refresh endpoint,
  Cron trigger, or production D1 identifier is included yet. Regional API
  behavior and grid-field mappings must be verified before those are added.
- The migration includes `stations`, `latest_snapshots`, `grid_events`,
  `poll_runs`, and a reserved durable `refresh_guards` table. It stores no
  credentials or access tokens.
