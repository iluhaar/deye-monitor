# Deye Monitor

This repository currently contains the documented server plan and the bounded
foundation: a Cloudflare Worker using Hono and Effect 4.0.6, the existing
conservative normalized-domain evaluator, authenticated read-only API routes,
and a D1 read layer with migrations. A read-only Deye adapter now composes with
conservative normalization and finite, fenced D1 ingestion. The ingestion
program is exposed through an opt-in, strongly authorized manual refresh endpoint.

## Implementation tracking

Implementation progress and issue status live in the [Linear epic ILL-69 — reliable read-only server MVP](https://linear.app/illiadotdev/issue/ILL-69/epic-deye-monitor-reliable-read-only-server-mvp). [`docs/SERVER_PLAN.md`](docs/SERVER_PLAN.md) and supporting docs are design/evidence references, not completion trackers.

Read-only adapter configuration and composition are documented in
[`docs/deye-adapter.md`](docs/deye-adapter.md).

The durable refresh guard and atomic observation-write contract are documented
in [`docs/refresh-protocol.md`](docs/refresh-protocol.md). Finite program
composition and outcome semantics are in [`docs/ingestion.md`](docs/ingestion.md).
Manual-refresh configuration and activation are in
[`docs/manual-refresh.md`](docs/manual-refresh.md).

Worker-side Cloudflare auth/read rate-limit bindings, deployment configuration,
credential rotation, and separate operator-side Access/WAF/DDoS controls are
documented in [`docs/security.md`](docs/security.md). The bindings default to 30
API attempts and 120 authenticated reads per client IP per 60 seconds. Because
successful reads also count as API attempts, the auth quota is the nominal
30-per-minute effective read ceiling at these defaults; the quotas are
independently configurable. Cloudflare limits are approximate per location, not
exact global quotas. Wrangler source configuration does not prove that a binding
or external access policy is deployed.

## Server development

```sh
cd server
npm ci
npm run verify
```

`npm run verify` is the local verification gate. It runs lint, typecheck, the
test suite, the Wrangler dry-run build, and an isolated D1 migration check in
sequence. Linting uses Oxlint with correctness rules and TypeScript/Vitest
plugins; warnings fail the lint check. `npm test` applies the configured D1
migrations in the Workers-runtime test database. The migration check separately
creates fresh temporary persistence under `/tmp/opencode`, applies the
configured migrations with Wrangler in local mode, checks the applied migration
set and expected schema, then reapplies to check idempotence. Its temporary
database is removed afterward; every D1 command uses an explicit
`--persist-to`, so this gate does not use or alter the operator's `.wrangler`
database or any remote D1 database. The individual lint, typecheck, test, and
build scripts remain available for focused runs.

## Local signoff

After the checks pass and the tested commit has been pushed, install the
[gh-signoff](https://github.com/basecamp/gh-signoff) GitHub CLI extension once
and post a status for `HEAD` from the repository root:

```sh
gh extension install basecamp/gh-signoff
gh signoff
```

`gh signoff` records a GitHub status; it does not run the checks. It requires
authenticated GitHub CLI access and, by default, refuses commits that have not
been pushed (refreshing a stale tracking ref before refusing). Posting a status
does not require it for merges: repository enforcement is separate and must be
configured by an administrator with `gh signoff install`.

The vendored [anti-slop](https://github.com/dmmulroy/anti-slop) generic and Effect
rules also run through `npm run lint`, with all rules enabled as errors. Source
and revision are recorded in `server/tools/oxlint/anti-slop/UPSTREAM.md`.

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
- `POST /api/v1/refresh` additionally requires a distinct `X-Refresh-Token`,
  explicit activation and upstream configuration. It rejects query/body input
  and uses persisted throttling; it is disabled by default.
- Required Cloudflare Worker bindings rate-limit all `/api/v1/*` attempts and
  authenticated read routes independently. They use the trusted edge-supplied
  `CF-Connecting-IP`; missing identity or limiter configuration fails closed.
  The read limit is separate from the durable D1 refresh throttle. See the
  [security runbook](docs/security.md) for exact defaults, Wrangler examples,
  and verification boundaries.
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
- The read-only Deye adapter composes with normalization and finite ingestion
  through the configured manual refresh route. No production calls
  have been made, and credentials are not test fixtures. Regional host/config,
  token-lifecycle live checks, polling cadence, power sign semantics, and the
  approved grid classifier still require validation.
- Finite ingestion atomically stores snapshots, poll metadata and verified
  transition history through the durable refresh guard. Cron is not wired;
  existing GET routes remain stored-data reads. Failed
  collection degrades effective status without replacing stored measurements.
  No deployment or production readiness is implied.
- The migration includes `stations`, `latest_snapshots`, `grid_events`,
  `poll_runs`, and a durable `refresh_guards` table. A second migration adds
  persisted throttling, observation watermarks, and commit assertions. A third
  adds last-confirmed context, gap metadata, and fenced poll outcomes. Apply all
  migrations before running the Worker. No migration stores credentials or
  access tokens.
