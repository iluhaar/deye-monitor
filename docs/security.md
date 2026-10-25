# API deployment security runbook

This runbook separates controls implemented by the Worker from controls an
operator must configure at deployment. It is not evidence of a deployed or
verified environment. See [manual refresh](./manual-refresh.md) for the full
refresh configuration contract.

## Implemented in the Worker

- Every `/api/v1/*` route requires `Authorization: Bearer <read-token>`. The
  configured and supplied read tokens must be 32–4096 non-whitespace characters;
  the authorization header is limited to 4103 characters. Missing or invalid
  read authorization returns `401`; an unset/invalid secret fails closed.
  Existing read secrets outside these bounds will now fail with `401`; securely
  replace them and coordinate callers before using the hardened Worker.
- `POST /api/v1/refresh` additionally requires a distinct
  `X-Refresh-Token: <refresh-token>` of 32–4096 non-whitespace characters; it
  must not equal the read token.
  Missing, invalid, weak, shared, or incorrect refresh credentials return `403`
  after read authentication. Refresh is disabled unless `REFRESH_ENABLED` is
  exactly `true` and its required configuration is present.
- API request bounds are enforced at the Worker boundary: URLs over 4096
  JavaScript code units return `414 REQUEST_TOO_LARGE` before auth; non-refresh
  query strings over 2048 code units do likewise. On other read routes, any query
  (even a bare `?`) returns `400 INVALID_QUERY` after auth. `/events` permits only
  one each of `limit`, `cursor`, `from`, and `to`; `limit` is at most 3 characters
  and 1–100, cursor at most 512 characters with decoded ID at most 128, and dates
  at most 64 characters and must parse/order correctly. Invalid event queries
  return `400 INVALID_QUERY`.
- Bodies are not accepted or read/drained. A non-refresh body returns
  `400 INVALID_REQUEST` after auth; any refresh query (including bare `?`) or
  body returns `400 INVALID_REFRESH_REQUEST` after both auth checks. Refresh is
  exempt from the separate 2048-character query limit, but not the full URL limit.
- Public snapshots limit timestamps to 64 characters and evidence to at most 16
  non-empty items of at most 64 characters. Event output is limited to 100 rows,
  non-empty IDs of at most 128 characters, 64-character dates, and the same
  evidence bounds. The encoded next cursor is limited to 512 characters; the full
  events JSON envelope is limited to 1,000,000 UTF-8 bytes. Invalid persisted
  output, including an oversized encoded cursor, fails closed as
  `503 STORAGE_UNAVAILABLE`.
  D1 also enforces a persisted refresh interval and single-operation lease; these
  do not rate-limit reads. Responses are `no-store`. See [`auth.ts`](../server/src/api/auth.ts),
  [`app.ts`](../server/src/api/app.ts), [`query.ts`](../server/src/api/query.ts)
  and [manual refresh](./manual-refresh.md) for details.
- No CORS middleware or allowed-origin policy is implemented. Do not treat this
  API as browser-enabled; all `/api/v1/*` requests, including preflights, pass
  through bearer authentication.

## Required before enabling deployment

Keep `REFRESH_ENABLED` unset or set to anything other than `true` until all
prerequisites below are satisfied. Missing API credentials fail closed, but
missing operator/deployment controls are not automatically supplied by the
Worker.

1. Apply all three migrations to the target D1 database and configure the `DB`
   binding and non-empty internal `STATION_ID`.
2. Store `API_BEARER_TOKEN` and `API_REFRESH_TOKEN` as separate production secret
   bindings (for example, managed with Wrangler secret bindings), never as
   checked-in configuration, URLs, or logged request data. Generate both as
   independent cryptographically random secrets; the refresh length check alone
   does not establish entropy. Do not reuse either credential for another system.
3. Before enabling refresh, explicitly validate the regional HTTPS Deye host,
   required upstream credentials and device mapping, and an account-safe
   `REFRESH_MIN_INTERVAL_SECONDS` (integer `1..3600`; there is no inferred
   default). Keep refresh disabled if any prerequisite or cadence is uncertain.
4. Serve callers over HTTPS. Restrict access at the edge as described below.
   Neither Access nor edge rate-limit rules are configured by this source tree;
   verify them in the target Cloudflare account before relying on them.

## Deployment controls to configure

- **CORS:** Keep cross-origin browser access denied. Do not add `Access-Control-Allow-Origin: *` or reflect arbitrary origins. If a future browser use case is approved, implement and test a narrow explicit origin/method/header allowlist (including preflight behavior) in the Worker; edge Access is not a CORS policy.
- **Cloudflare Access (recommended defense in depth):** Protect every reachable API entry point, not only the primary hostname: include `workers.dev`, preview deployment URLs, alternate Worker routes/domains, and any direct-origin path. Apply the same Access policy everywhere, or disable/remove entry points that cannot be protected; test that none bypass Access. Allow only named operator identities for interactive use, or explicitly approved service-auth principals for machine callers; limit refresh to the operator/service principal that needs it. Access does not replace the Worker bearer headers. Ensure callers can supply both layers of credentials, and do not create an anonymous bypass for health or read routes. Access is not configured or verified by this repository.
- **Edge rate limits:** Configure and verify Cloudflare rate-limit rules for `/api/v1/*` reads to constrain abusive traffic and bearer guessing, plus a separately stricter limit for `POST /api/v1/refresh`. Choose thresholds for expected clients and refresh cadence, key by the most reliable client identity available (and/or source IP), and alert on sustained blocks. Edge limits are not configured by this repo; Worker-side read throttling and authentication lockout are not implemented. Refresh's persisted D1 throttle remains the application-level guard, not a substitute for edge limits.
- Do not log `Authorization`, `X-Refresh-Token`, Access service-token headers, or secret-management payloads at the Worker, proxy, or monitoring layer. Do not put credentials in query strings.

## Credential rotation

There is one accepted read token and one accepted refresh token; the Worker has
no dual-token overlap or grace period. Generate replacement values independently
in the secret manager and coordinate clients before cutover. Rotate
`API_BEARER_TOKEN` and update every read caller (including refresh callers),
then rotate `API_REFRESH_TOKEN` and update only refresh callers. Secret updates
may briefly reject callers during propagation; schedule and observe the cutover.
With Wrangler, use its secret-binding update for each variable in the explicitly
selected deployment environment and enter values only at its secure prompt, not
as command arguments. Verify the new read credential on a harmless read before
retiring old client configuration; verify refresh authorization separately in
isolated staging without triggering a production collection.
Never copy values into this document, source control, tickets, terminal history,
or logs. If either credential is exposed, replace it promptly and review access
logs. Changing the read token invalidates refresh calls too because refresh
requires both credentials.

If a cutover fails, keep refresh disabled (`REFRESH_ENABLED` other than `true`)
while recovering. Restore the last-known-good configuration only if its
credentials are confirmed noncompromised; otherwise roll forward with fresh,
independent secrets and update callers. Verify recovery with a harmless
authenticated read and review that all clients received the intended credentials
before re-enabling refresh. Never roll back to a compromised token.

## Validation checklist

Run checks only against local or isolated staging configured for the test. The
following examples contain placeholders, not usable credentials; inject actual
test secrets from the approved secret store/client and never paste them into a
command or this document. The placeholder header is intentionally invalid and
can test rejection; for positive read authorization and read-only refresh
authorization checks, use a client that injects test secrets out of band. These
are instructions only; no live commands or deployment checks are performed by
this runbook.

```sh
curl -i http://127.0.0.1:8787/api/v1/status
curl -i http://127.0.0.1:8787/api/v1/status \
  -H 'Authorization: Bearer READ_TOKEN_PLACEHOLDER'
curl -i -X POST http://127.0.0.1:8787/api/v1/refresh \
  -H 'Authorization: Bearer READ_TOKEN_PLACEHOLDER'
curl -i -X OPTIONS http://127.0.0.1:8787/api/v1/status \
  -H 'Origin: https://untrusted.example' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
```

Confirm the unauthenticated read is `401`; a correctly authorized read reaches
the route (normally `200` with D1/station configured). Refresh with a valid read
token but no refresh token is `403`; with neither token it is `401`. In a local
environment where both test credentials are configured, separately verify
wrong, too-short, and read-token-reused refresh secrets are denied, and verify
that refresh while disabled returns `503` without upstream calls. Confirm
preflights are not granted an allow-origin response. Review deployed Access and
rate-limit configuration in Cloudflare and test expected allowed/blocked clients
there; do not infer configuration from this repository. Do not use a successful
production refresh as a health check: it calls the upstream service and is
subject to account limits. Follow [manual refresh](./manual-refresh.md) for any
separately approved refresh validation.

## Remaining source/deployment gaps

There is no in-Worker CORS allowlist, read-route rate limiter, authentication
lockout, or overlapping-token rotation support. Access policies and edge rate
rules are external deployment controls and are not represented or verified here.
The repository does not establish a production hostname, prove that secrets or
migrations are installed remotely, or verify hosted checks/deployment state.

## Development dependency note

The reported development dependency audit had zero findings. Dev-only overrides
use `undici` 7.30.1 where Miniflare pins 7.29.1, and `zod` 4.6.6 where the
Cloudflare Vitest plugin pins 4.6.5. These differ from the parent packages'
tested exact pins; local checks do not guarantee compatibility. Recheck after
dependency changes, and do not treat a clean audit as a compatibility guarantee.
