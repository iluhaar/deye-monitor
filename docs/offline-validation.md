# Offline scenario validation

Run from `server/`:

```sh
npm ci
npm run verify
```

The gate runs lint, typecheck, all Workers-runtime tests, a Wrangler dry-run,
and isolated local D1 migration/schema/idempotence verification. Vitest uses
the test-only Wrangler configuration, synthetic credentials and migrated test
D1, not operator `.dev.vars`, local development persistence or remote D1.
No test needs live Deye access, an induced outage, or deployment credentials.

## Coverage map for ILL-76

| Scenario | Reproducible coverage |
| --- | --- |
| Cloud delay and fresh-to-stale stored reads; GET makes no upstream calls | `test/refresh-scenarios.test.ts`: 129-second synthetic age, unchanged source/fetch timestamps, stale after advancing read clock |
| Grid-present/zero-voltage/restored sequence with unapproved mapping; zero power is not outage evidence | `test/refresh-scenarios.test.ts`: fake HTTP → adapter → normalization → polling → real D1 → authenticated HTTP; unknown/unverified throughout, no events |
| Stale/missing/future source times and preservation of prior measurements | `test/refresh-scenarios.test.ts`, plus invalid/replayed/backward times in `test/ingestion.test.ts` |
| Communication loss, HTTP-200 auth errors, 429, malformed JSON | `test/refresh-scenarios.test.ts`: bounded actual adapter calls, sanitized HTTP failure, degraded stored read, no false events |
| Local API credential replacement and scoped authorization | `test/refresh-scenarios.test.ts`: replaced read/refresh values rejected before upstream work, new distinct values accepted; broader denial matrix in `test/refresh-api.test.ts` |
| Upstream token expiry/safety margin, invalidation, one reauthentication | `test/deye.test.ts`: synthetic clock/token responses; HTTP-200 failure also exercised through HTTP and D1 above |
| Request timeout/retry bounds, cancellation and finite ingestion timeout | `test/deye.test.ts`, `test/ingestion.test.ts`; HTTP timeout translation in `test/refresh-api.test.ts` uses a test polling Layer |
| Synthetic confirmed outage/restoration, unknown gaps, same-state recovery | `test/ingestion.test.ts`: real D1 history/context assertions using a deliberately confirmed test source, not the production classifier |
| Replay/throttling cannot duplicate a confirmed event; overlapping HTTP refreshes | `test/refresh-api.test.ts`: independent app/Layer instances, real D1 guard, call counts and event count |
| Lease takeover, stale-owner writes/releases, observation watermark, atomic rollback | `test/refresh-guard.test.ts`; delayed ingestion/failure metadata and transaction rollback in `test/ingestion.test.ts` |
| Stable authenticated responses, no-store, output bounds and real-D1 pagination | `test/refresh-api.test.ts`, `test/api-hardening.test.ts`, `test/api-pagination.test.ts` |

To run the newly added full-path scenarios alone:

```sh
npm test -- test/refresh-scenarios.test.ts
```

Most new scenarios traverse the entire refresh/read chain. Timeout and fencing
coverage is composed from the dedicated boundary and integration tests listed
above; it is not presented as a deployed multi-Worker or live timeout experiment.
The short retry delays and timing policies are test-only, not a polling policy.

Local working-tree verification for this pass: `npm run verify` passed lint,
typecheck, 250 tests across 13 files, Wrangler dry-run, and all three isolated
D1 migrations/schema with idempotent reapply. The new scenario file has 10
tests; its final response-sanitization assertions were also rerun separately,
with lint and `git diff --check` passing. This is local working-tree evidence,
not a pushed-commit, hosted-check or deployed-release attestation.

## Limits and remaining release gates

These tests validate implementation behavior, not a real grid classifier,
account quota, normal reporting cadence, or actual credential rotation. See
[operator evidence](validation-evidence.md) for the separately supplied local
live-refresh baseline. Exposed local credentials still require operator rotation
and confirmation that the old values fail; tests cannot attest that it happened.

ILL-76's broader release gate still depends on ILL-81 security/deployment evidence.
The 12-hour retention work is implemented locally; the operator deferred remaining
ILL-84 observability/health enhancements to Phase 2 / backlog, removing them as
an MVP blocker. The existing health endpoint remains unchanged.
Hosted checks, actual Access/edge-policy
deployment, production smoke tests and rollback validation are not proven by a
local pass. No deployment approval, confirmed production transition, or completion
of those dependencies is implied.
