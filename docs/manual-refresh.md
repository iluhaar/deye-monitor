# Protected manual refresh

`POST /api/v1/refresh` runs one finite, read-only Deye collection and persists it
to D1. It does not control the inverter, schedule jobs, or make GET requests
fetch upstream data. It is disabled unless explicitly configured and enabled.

## Authorization and request contract

Refresh requires **both** headers:

- `Authorization: Bearer <API_BEARER_TOKEN>` — the existing read credential.
- `X-Refresh-Token: <API_REFRESH_TOKEN>` — a separate operator credential.

Both tokens must be 32–4096 non-whitespace characters and independently
cryptographically random; length checks alone do not guarantee entropy. The
refresh secret must be distinct from the read secret. This is scoped additional
authorization, not a claim of multi-factor authentication. A refresh token alone
does not grant read access. Missing or invalid read authorization returns `401`;
missing, weak, shared or incorrect refresh authorization returns `403` after read
authentication, including when refresh is unconfigured. Existing read secrets
outside these bounds will now fail with `401`; replace them securely and
coordinate callers before using the updated Worker.

Send no query string and no body. No client-provided station, device, region,
credential, cadence, or force flag is accepted. Unsupported methods never invoke
ingestion. Any refresh query (including a bare `?`) or body returns
`400 INVALID_REFRESH_REQUEST` after both authentication checks; an oversized full
URL returns `414 REQUEST_TOO_LARGE` before authentication. Responses use the
existing JSON envelope and `Cache-Control: no-store`.
After read authentication they vary on both `Authorization` and `X-Refresh-Token`.
Cross-origin access is not enabled.
Every `/api/v1/*` attempt, including refresh and successful requests, also counts
against the required per-client `API_AUTH_RATE_LIMITER` before credential
validation. Refresh is not a read route and does not consume
`API_READ_RATE_LIMITER`; authenticated read `GET`/`HEAD` routes use that separate
quota. The auth and read bindings use trusted `CF-Connecting-IP` only. The auth
quota counts successful reads too, so its default 30 attempts/minute is the
nominal effective per-client read ceiling despite the separate 120 reads/minute
quota. The quotas are independently configurable in Wrangler JSONC.
Quota denial is `429 RATE_LIMITED` without `Retry-After`; missing/invalid client
identity or an unavailable, malformed or failing binding fails closed with
`503 RATE_LIMIT_UNAVAILABLE` before protected storage or upstream calls. These
Worker quotas do not change token requirements/rotation or upstream collection
behavior, and do not replace refresh's independent persisted D1 interval and
lease. See the [security runbook](./security.md) for configuration and staging
verification details.
See the [security runbook](./security.md) for detailed request/public-output
bounds and validation ordering.
Do not put credentials in URLs, command history, source control or logs; use an
HTTP client that injects headers from secret storage.

## Operator configuration

Apply migrations from `server/` before starting the updated Worker:

```sh
npm run db:migrate:local
npm run dev
```

Local configuration belongs in ignored `server/.dev.vars`; production secrets
belong in Wrangler secret bindings. The Worker does not automatically import
`server/.env.deye`. No usable credentials are included in this guide.

| Binding | Requirement |
| --- | --- |
| `DB` | D1 binding with all three migrations applied |
| `STATION_ID` | Non-empty internal key, not the upstream device serial |
| `API_BEARER_TOKEN` | Secret read credential, 32–4096 non-whitespace characters. Out-of-range existing values fail `401`; securely replace before rollout. |
| `API_REFRESH_TOKEN` | Distinct secret refresh credential, 32–4096 non-whitespace characters |
| `REFRESH_ENABLED` | Exactly `true` to activate; unset/other values disable refresh |
| `REFRESH_MIN_INTERVAL_SECONDS` | Explicit integer `1..3600`; no default is inferred |
| `API_AUTH_RATE_LIMITER` | Required Cloudflare simple rate-limit binding; default 30 `/api/v1/*` attempts per 60 seconds |
| `API_READ_RATE_LIMITER` | Required Cloudflare simple rate-limit binding; default 120 authenticated read requests per 60 seconds |
| `DEYE_BASE_URL` | Explicit HTTPS regional base URL validated for the account |
| `DEYE_APP_ID`, `DEYE_APP_SECRET` | Developer application credentials, stored as secrets |
| `DEYE_PASSWORD_HASH` | Secret lowercase 64-character SHA-256 password digest, not plaintext |
| `DEYE_EMAIL` **or** `DEYE_USERNAME` **or** `DEYE_MOBILE` | Exactly one login identity, stored as a secret |
| `DEYE_COUNTRY_CODE` | Required with mobile identity |
| `DEYE_COMPANY_ID` | Optional business-member/company context |
| `DEYE_DEVICE_SN` | Configured inverter serial, kept out of public responses and D1 |
| `DEYE_DEVICE_TYPE` | Optional `INVERTER`; other device types are rejected |
| `FRESHNESS_THRESHOLD_SECONDS` | Existing freshness policy; default is 180 seconds, not a cloud-latency guarantee |

An authorized, fully configured refresh creates the internal station row if
needed without replacing existing station metadata. It never persists upstream
credentials or the device serial. Bad authorization, disabled refresh, or invalid
configuration cannot create a station or trigger upstream requests.

Choose the minimum interval only after reviewing the account's call limits and
measured upload cadence (ILL-74). The accepted numeric range is an input bound,
**not permission to poll every second**. Keep refresh disabled until regional
host, credentials, identity/device mapping and an appropriate interval are
explicitly confirmed. No live activation or quota validation is claimed by the
offline tests.

## Outcomes

Successful collection returns `200`:

```json
{
  "ok": true,
  "data": {
    "refresh": { "outcome": "missing_timestamp" },
    "telemetry": null
  }
}
```

`telemetry` is the stored public snapshot with independently preserved
`measuredAt`, `fetchedAt` and freshly evaluated freshness, or `null` when no valid
observation exists. The example shows unavailable source time with no prior valid
observation; `null` is not a live device reading. Outcomes include `accepted`, `unverified`, `stale`, `replay`,
`backward`, and unavailable timestamp reasons. A `200` does not establish new,
fresh, or confirmed utility-grid evidence. Replay/backward/missing/invalid time
does not overwrite a newer snapshot; failed collection makes effective reads
unknown/unavailable while preserving stored measurements.

Errors use `{ "ok": false, "error": { "code": "...", "message": "..." } }`:

| HTTP | Code | Meaning |
| --- | --- | --- |
| `400` | `INVALID_REFRESH_REQUEST` | Query or body supplied |
| `414` | `REQUEST_TOO_LARGE` | Full request URL exceeds the limit; rejected before authentication |
| `401` / `403` | `UNAUTHORIZED` / `FORBIDDEN` | Read / refresh authorization denied |
| `429` | `REFRESH_IN_PROGRESS` | A durable lease is active |
| `429` | `REFRESH_THROTTLED` | Persisted minimum interval has not elapsed |
| `429` | `RATE_LIMITED` | Cloudflare auth quota exceeded; static sanitized response, no `Retry-After` |
| `502` | `UPSTREAM_UNAVAILABLE` | Sanitized upstream auth, decoding or transport failure |
| `503` | `SERVICE_NOT_CONFIGURED` | Refresh disabled or incomplete configuration |
| `503` | `RATE_LIMIT_UNAVAILABLE` | Required rate-limit binding missing, malformed or failed, or trusted client identity missing/invalid; no protected storage/upstream calls |
| `503` | `UPSTREAM_RATE_LIMITED` | Deye rejected collection due to rate limiting |
| `503` | `STORAGE_UNAVAILABLE` | Durable state could not be safely acquired, written or read |
| `504` | `REFRESH_TIMEOUT` | Finite collection budget exceeded |

The D1 `REFRESH_IN_PROGRESS` and `REFRESH_THROTTLED` outcomes include a positive
integer `Retry-After` in seconds and do not perform upstream requests.
`RATE_LIMITED` does not include `Retry-After`: the Cloudflare binding returns no
reset metadata. A binding-denied request makes no protected storage or upstream
calls. Failed upstream attempts also consume the persisted minimum interval;
there is no bypass or in-memory-only D1 throttle. Cloudflare's per-client limits
are approximate per location, not exact global quotas; shared-NAT clients share
the same IP quota. They do not replace Access, WAF, or DDoS controls.

The runtime lease budget covers two token issuances, two latest-data requests,
their worst-case configured retries/backoff, and storage/finalization headroom.
With current adapter defaults the workflow budget is 151 seconds and lease is
166 seconds; normal requests should finish sooner. Client cancellation interrupts
the finite Effect program and upstream work; release is bounded and best-effort.
An error/timeout is not proof that a submitted database transaction did not
commit. Inspect stored data and respect the throttle instead of forcing retries.

Set `REFRESH_ENABLED` to a value other than `true` to stop new refresh operations.
Rotate the two API credentials independently via secret storage. Already
authorized in-flight work remains subject to its existing finite budget and
lease; disabling new requests does not retroactively cancel it. For coordinated
rotation, cutover and recovery guidance, and deployment prerequisites for
Cloudflare Access and edge rate limits, see the [security runbook](./security.md).
Those edge controls are not configured or verified by this source tree.

## Verification boundary

`server/test/refresh-api.test.ts` tests authorization, invalid inputs, activation,
configuration bounds, sanitized envelopes, persisted throttling and overlapping
HTTP requests across instances. Full HTTP → adapter → normalizer → D1 tests use
fake upstream responses, not credentials or a live account. Synthetic confirmed
transitions test event idempotency only. The real normalizer remains
`unknown`/unverified with null directional power until its separate validation
gates pass. No Cron or production deployment is enabled by this change.
