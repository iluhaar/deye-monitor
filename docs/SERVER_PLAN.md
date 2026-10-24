# Deye Monitor — Server Implementation Plan

## 1. Goal and scope

Build a small, reliable, read-only backend that periodically collects telemetry from Deye Cloud, normalizes it, detects verified utility-grid state transitions, and exposes a stable, authenticated HTTP API.

**In scope:** Deye Cloud integration, scheduled ingestion, normalized readings, freshness and confidence, historical grid events, REST API, authentication, observability, tests, deployment.

**Out of scope:** any UI, mobile or browser application, widgets, bots, notification delivery, inverter configuration/control, and multi-user account management.

### Hardware and upstream

- Inverter: Deye SUN-6K-SG06LP1-EU-BM2 (single phase, 6 kW).
- Battery: Deye SE-F5 Pro-C (5.12 kWh).
- Region: EMEA/APAC; confirm the actual account and API host during setup.
- Upstream OpenAPI/Swagger specification: https://eu1-developer.deyecloud.com/v2/api-docs
- Developer portal: https://developer.deyecloud.com/

Do **not** assume that the upstream schema or every measurement point is available for this exact device/firmware. Verify responses against the live account and the upstream OpenAPI document before freezing mappings.

## 2. Recommended stack

- TypeScript, Cloudflare Workers, **Effect v4** for application services, typed errors, dependency injection and retries; **Hono** for HTTP routing
- Effect Schema for decoding/validation where practical; avoid duplicating runtime schemas in Zod unless an integration requires it
- Cloudflare Cron Triggers for scheduled polling **only in Phase 5** (lowest priority; cadence subject to upstream rate limits)
- Cloudflare D1 for durable snapshots, verified transitions, and polling metadata
- Optional Cloudflare KV as a read cache **only if needed**; D1 is the initial source of truth to avoid KV eventual-consistency confusion
- Wrangler for local development, configuration, migrations, and deployment
- Vitest + Workers-compatible test harness for unit and integration tests

Keep infrastructure small: no VPS, Docker, WebSockets, or message queue for the MVP. Effect is **not** a replacement for Hono, D1, or Cloudflare Cron in this design. Verify exact Effect v4 package names/APIs against the installed version before implementation.

## 3. High-level architecture

```text
              Cloudflare Worker entrypoints
                /                      \
        Hono HTTP fetch            Cron scheduled
                \                      /
                 Effect application layer
                    /            \
           DeyeService         StorageService
           (Effect Layer)       (D1 Layer)
                 |                  |
           Deye Cloud API      Cloudflare D1
                 \                  /
              PollingService + grid evaluation
```

Hono owns request routing, authentication middleware, request/response mapping, and HTTP status codes. Effect v4 owns application workflows, dependency management, typed failures, timeout/retry policies, decoding, and testable service boundaries. The Cloudflare `fetch` and `scheduled` handlers each run **finite** Effect programs with request/execution-scoped environment bindings; do not start an infinite background Effect scheduler.

Recommended services: `DeyeService` for upstream read-only access; `StorageService` for D1 persistence; `TelemetryService` for normalized readings; `PollingService` for the ingestion workflow. Keep grid detection and freshness evaluation as pure domain functions unless effects are truly required. Compose live implementations with Effect Layers and replace them with test layers in unit/integration tests.

Key separation: upstream-specific payloads never leak directly into the public server API. The data-source interface should permit a future local telemetry provider without changing internal normalized domain models or HTTP contracts.

## 4. Deye Cloud integration

### Discovery and API contract verification

1. Confirm the correct regional API base URL and authentication flow.
2. Obtain credentials through the developer portal. Store credentials in Wrangler secrets, never source control.
3. Verify the actual path, HTTP method, request schema, response schema, token expiry and rate limits against the Swagger document.
4. Discover the station, inverter device, and serial/identifiers using available station/device listing methods.
5. Inspect available measurement points and latest inverter/station telemetry (candidate methods include `/v1.0/station/listWithDevice`, `/v1.0/station/latest`, `/v1.0/device/latest`, and `/v1.0/device/measurePoints`; names must be validated against the current spec).
6. Save sanitized samples/fixtures (remove credentials, serial numbers, and other identifiers).

### Validate utility-grid detection before implementation

The top-priority research item is identifying a **reliable direct signal of AC grid presence** from this inverter. Check available input-grid voltage, frequency, explicit grid-connected status, operation mode, and their real behavior during a known outage/restoration.

**Never infer grid absence solely from grid import/export power being zero.** A connected grid can have zero net power flow. Conversely, device connectivity loss is not necessarily a grid outage.

Write an evidence-based mapping table: upstream field, unit, timestamp, expected values, observed examples during grid present/absent, and confidence. If a reliable signal cannot be established, return `unknown` rather than claiming presence/absence.

### Adapter concerns

- Typed request/response models (generated from Swagger where viable; decode and validate actual responses using Effect Schema)
- Token caching and safe refresh, accounting for expiry
- Effect-managed timeouts, bounded retries with exponential backoff/jitter for transient failures; never retry permanent auth/schema errors
- Explicit tagged error types for upstream 401/403, rate limiting, timeouts, invalid payloads, and stale telemetry, translated to safe HTTP/poll outcomes
- Idempotent ingestion; normalize watts, percent, direction/sign conventions, and UTC timestamps
- Read-only API access; do not add upstream control/write operations

## 5. Normalized domain model

```ts
type GridStatus = "online" | "offline" | "unknown";
type Freshness = "fresh" | "stale" | "unavailable";
type DataSource = "deye-cloud";

interface TelemetrySnapshot {
  source: DataSource;
  stationId: string;          // internal identifier, not Deye credentials
  grid: {
    status: GridStatus;
    evidence: string[];      // normalized measurement names
    confidence: "confirmed" | "unverified";
    voltageV: number | null;
    frequencyHz: number | null;
    powerW: number | null;   // explicitly documented sign convention
  };
  battery: {
    socPercent: number | null;
    powerW: number | null;
    mode: "charging" | "discharging" | "idle" | "unknown";
  };
  home: { powerW: number | null };
  measuredAt: string | null; // origin measurement timestamp
  fetchedAt: string;         // server collection timestamp
  freshness: Freshness;
}
```

Do not invent measurements where the upstream payload omits them; use `null`. Keep the measured-at and fetched-at timestamps separate. Consider a configurable freshness threshold (start at three minutes for validation; tune based on actual Deye reporting cadence). If telemetry is older than this limit or lacks reliable grid evidence, effective grid status is `unknown`. Preserve the last verified state separately as historical context, not as the current answer.

## 6. Refresh and transition logic

**Phases 1–4 are request-driven; no Cron trigger is required.** Implement a protected, rate-limited refresh operation to retrieve and persist current upstream readings on demand, and make normal reads use stored data or an explicitly documented refresh policy. Design ingestion as a reusable finite Effect program, so Phase 5 can invoke that same operation from Cloudflare Cron without rewriting business logic. Avoid uncontrolled Deye requests for every HTTP API read.

Polling workflow:

1. Acquire a single-flight/idempotency guard keyed by station + refresh operation; ensure concurrent executions cannot duplicate events.
2. Fetch latest telemetry from Deye; validate and normalize.
3. Evaluate measurement freshness and grid presence based on verified fields.
4. Persist latest snapshot and refresh status.
5. Compare against the **last confirmed** grid state; write transition events only for validated online/offline changes with supporting timestamps.
6. Record errors and data gaps without manufacturing outage/restoration events.

If state temporarily becomes unknown, do not generate a false transition. If an eventual online/offline change is detected across a gap, preserve the observed transition time and avoid pretending to know the precise physical switching time.

The on-demand refresh operation is the initial ingestion mechanism and must require stronger authorization, server-side throttling, and concurrency control. Even a fresh HTTP response from Deye may contain an older measurement; return that distinction explicitly.

## 7. Durable storage (D1)

Proposed tables:

- `stations`: internal station ID, safe upstream mapping, source metadata
- `latest_snapshots`: one normalized latest record per station, measurement/fetch times, freshness and mapping revision
- `grid_events`: confirmed online/offline transitions, first observed time, optional last prior observation, evidence/source
- `poll_runs`: execution window, result, latency, upstream update time, error category

Add unique constraints/indexes on station + polling window and event idempotency keys. Bound retention for raw/debug telemetry; preserve compact events longer. Store no Deye credentials or access tokens in D1.

## 8. REST API v1

All endpoints are read-only except the optional internal refresh endpoint. Version contracts under `/api/v1`.

| Method | Route | Responsibility |
| --- | --- | --- |
| GET | `/api/v1/status` | Effective grid state, evidence/confidence, age, measured/fetched times |
| GET | `/api/v1/telemetry` | Normalized latest snapshot |
| GET | `/api/v1/battery` | Battery SOC and charge/discharge state |
| GET | `/api/v1/events` | Paginated verified grid transitions, filters by range |
| GET | `/api/v1/health` | Sanitized service health and ingestion lag |
| POST | `/api/v1/refresh` | **Optional**, protected manual refresh with throttling |

Return a stable JSON envelope, predictable HTTP status codes, and machine-readable errors. Use cursor pagination on events. Include `Cache-Control` and timestamps so a successful request cannot be mistaken for a live inverter measurement.

Illustrative status response (values are examples only):

```json
{
  "grid": {
    "status": "online",
    "confidence": "confirmed",
    "evidence": ["grid_voltage"],
    "voltageV": 230
  },
  "source": "deye-cloud",
  "measuredAt": "2026-10-24T12:28:00Z",
  "fetchedAt": "2026-10-24T12:29:00Z",
  "freshness": { "status": "fresh", "ageSeconds": 60 }
}
```

**Freshness invariant:** A `200` response does not prove real-time data. Status must degrade to `unknown` if current evidence is too old or untrustworthy.

## 9. Security and operational requirements

- Deye App ID/Secret and refresh tokens are server-side secrets, never in repository, logs, error responses, or API output.
- Protect telemetry endpoints using scoped API tokens or Cloudflare Access, depending on deployment needs.
- Rate-limit requests, especially forced refresh. Implement CORS conservatively and never treat CORS as authentication.
- Validate inputs and upstream payloads with Effect Schema; apply response size limits and request timeouts.
- No device-control endpoints in MVP.
- Health checks should not disclose secrets or internal identifiers.
- Use structured logs and aggregate metrics for poll success, upstream latency, data age, auth failures, and transitions.

## 10. Proposed repository structure

Keep the backend in a dedicated top-level `server/` directory **from the beginning**. All server-specific source code, dependencies, database migrations, tests, and deployment configuration belong under `server/`. Use Effect v4 services and Layers internally, and Hono only at the HTTP boundary.

```text
deye-monitor/
├── docs/
│   ├── SERVER_PLAN.md
│   └── deye-field-validation.md       # produced after live verification
├── server/
│   ├── src/
│   │   ├── index.ts                   # Worker fetch + scheduled entrypoints
│   │   ├── api/
│   │   │   ├── app.ts                  # Hono router
│   │   │   ├── routes/
│   │   │   └── middleware/
│   │   ├── domain/
│   │   │   ├── telemetry.ts
│   │   │   └── grid-status.ts         # pure grid/freshness rules
│   │   ├── services/
│   │   │   ├── DeyeService.ts         # Effect service contract
│   │   │   ├── StorageService.ts
│   │   │   ├── TelemetryService.ts
│   │   │   └── PollingService.ts
│   │   ├── integrations/deye/
│   │   │   ├── DeyeClient.ts
│   │   │   ├── DeyeLive.ts            # Effect Layer implementation
│   │   │   ├── auth.ts
│   │   │   └── schemas.ts
│   │   ├── storage/
│   │   │   └── D1Live.ts              # Effect Layer implementation
│   │   ├── errors/
│   │   │   └── DeyeErrors.ts          # tagged application errors
│   │   └── runtime/
│   │       └── layers.ts              # Worker binding -> live Layers
│   ├── migrations/
│   ├── test/
│   ├── wrangler.jsonc
│   ├── tsconfig.json
│   └── package.json
├── .github/
│   └── workflows/                     # server checks and deployment
└── README.md
```

Each invocation builds/provides only the required Effect environment. Avoid unbounded background fibers or assumptions about global mutable token caches persisting between Worker invocations. Keep Deye tokens in memory only when safely scoped, or use a controlled persistent strategy if required.

All backend development and deployment commands run from `server/` (or explicitly target that directory). The CI workflows should install, test, build, and deploy the server using `server/` as their working directory.

Structure is proposed, not scaffolding committed by this plan.

## 11. Implementation phases and acceptance criteria

### Phase 1 — Verify the upstream integration
- [ ] Confirm regional host, credentials, auth, station/device discovery, and quotas.
- [ ] Retrieve actual latest station/device readings and measurement point definitions.
- [ ] Identify and validate an authoritative grid-presence signal against known online/offline states.
- [ ] Document field meanings and sanitized fixtures.
- [ ] **Gate:** if no reliable grid signal exists, expose `unknown` and document the limitation instead of guessing.

### Phase 2 — Backend foundation
- [ ] Initialize Cloudflare Worker + Hono + TypeScript + Effect v4, using Effect Schema for validation.
- [ ] Implement typed Deye read-only adapter as an Effect Layer, with token handling, bounded retries, timeouts, and tagged errors.
- [ ] Define normalized models and deterministic pure grid/freshness evaluator; model external dependencies with Effect service contracts.
- [ ] Create D1 migrations and an Effect-backed StorageService/D1Live implementation.
- [ ] Implement authenticated Hono GET endpoints; execute finite Effect programs and map typed failures to HTTP responses.
- [ ] **Gate:** integration tests use test Layers to confirm stable contracts and retry/error policies without contacting production Deye.

### Phase 3 — On-demand ingestion and history
- [ ] Implement a protected manual refresh operation using a finite Effect workflow (no Cron).
- [ ] Make concurrent refreshes idempotent and rate-limited.
- [ ] Save latest normalized snapshots and confirmed grid transitions to D1.
- [ ] Track refresh runs, upstream errors, and stale/data-gap conditions.
- [ ] **Gate:** refreshing explicitly works without any scheduler; replayed payloads and failures never generate duplicate or false events.

### Phase 4 — Hardening and deployment
- [ ] Configure secrets and production environment.
- [ ] Add CI for lint, typecheck, unit tests, and migration verification.
- [ ] Add logging/monitoring and bounded data retention.
- [ ] Exercise outage, restoration, Deye unavailability, token expiry, and stale-reading scenarios.
- [ ] Document local development, migrations, deployment, rollback, and incident triage.
- [ ] **Gate:** the request-driven API is deployed, usable, and accurately reports unknown/stale when data is unavailable, without scheduled jobs.

### Phase 5 — Scheduled polling (lowest priority)
- [ ] Verify Deye API quotas and real measurement update frequency before choosing a cadence.
- [ ] Add a Cloudflare Cron trigger that invokes the **existing** finite refresh/polling Effect workflow.
- [ ] Guard overlapping scheduled invocations and avoid duplicate transition events.
- [ ] Record scheduled poll runs, failures, and ingestion lag; adjust cadence and retry policy to quotas.
- [ ] **Gate:** scheduled polling reuses Phase 3 ingestion without changes to HTTP contracts, domain logic, or persistent data models.

## 12. Open decisions / risks

1. Does the device expose a confirmed grid-voltage/status signal in the EU Deye Cloud API? **Must verify first.**
2. How long is the upstream device-to-cloud reporting delay during outages and grid restoration? Measure rather than assume.
3. What are the current Deye API quotas and any restrictions on one-minute polling?
4. Does a connection outage prevent updated readings? Separate communication failure from utility-grid absence.
5. Should a later iteration support local Modbus/RS485? Keep the Effect service boundary now, do not implement it in MVP.
6. Is D1 alone sufficient for current traffic? Prefer the simplest solution first.

## 13. Definition of done

For Phases 1–4, the server is deployed, reads Deye Cloud with secrets protected, exposes a versioned authenticated API, distinguishes **online / offline / unknown** correctly using device-validated evidence and measurement timestamps, handles stale or unavailable upstream data safely, and keeps an idempotent history of verified transitions. Scheduled polling is an optional Phase 5 enhancement, not a requirement for initial delivery. No client-side code or documentation is part of this project plan.
