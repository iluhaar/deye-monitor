# SERVER_PLAN review — Phase 1 blockers and contract gaps

**Review date:** 2026-10-24
**Scope:** public-contract research and plan review only. No credentials, live account, device, or telemetry were accessed.
**Related document:** [deye-field-validation.md](./deye-field-validation.md)

## Executive assessment

`SERVER_PLAN.md` has the correct safety posture in several important places: read-only upstream access, separate measured/fetched timestamps, `unknown` for unverified grid state, no fabricated transition while observations are unknown (while allowing a later confirmed transition across a gap with its honest observed time), and no Cron requirement before Phase 5. The public Swagger confirms the main read paths and their `POST` methods, but it does **not** prove that those paths or any measurement point are available for the named inverter/firmware/account.

Phase 1 cannot pass from public research alone. The target account, regional host, device topology, exact measurement points, cloud delay, quotas, and grid behavior still require authorized live verification. The implementation must not turn any candidate field below into a production mapping.

## Public-contract findings that affect the plan

| Plan area | Public evidence | Review consequence |
| --- | --- | --- |
| Host selection | The EU Swagger host is `eu1-developer.deyecloud.com:443`; Quick Start also documents `us1-developer.deyecloud.com` and `india-developer.deyecloud.com` | Keep regional host selection configurable and make the account/application's actual region a Phase 1 prerequisite. |
| Authentication | `POST /v1.0/account/token?appId={AppId}` uses an `appSecret`, SHA-256 password, one of email/mobile/username, optional `companyId`, and returns access/refresh token fields and `expiresIn` | Do not assume a standard OAuth refresh flow. The published paths contain no refresh-token operation. See auth freshness gap below. |
| Discovery | `/v1.0/station/list`, `/v1.0/station/listWithDevice`, `/v1.0/station/device`, `/v1.0/device/list` are public read paths | Replace the plan's “candidate methods” with an allowlisted adapter contract only after role/device behavior is tested. |
| Latest data | `/v1.0/station/latest` exposes names such as `gridPower`, `purchasePower`, and `wirePower`; `/v1.0/device/latest` returns flexible `key`/`unit`/`value` items and `collectionTime` | Names alone do not define units, sign, freshness, or grid semantics. The grid evaluator must remain `unknown` until exact live points are validated. |
| History/alerts | `/v1.0/device/historyRaw` uses 10-digit seconds and a published five-day limit; device alerts are limited to 30 days and station alerts to 180 days | Bound requests in the adapter and do not treat alert examples such as `AC_NoUtillity_Fault F35` as verified grid evidence. |
| Errors | A credential-free probe of `/v1.0/station/list` returned HTTP 200 with `success:false`, `code:2101017`, `msg:"auth token not found"`; the Swagger also lists 401/403 | Decode HTTP status **and** body-level `success`/`code`. A 200 response must not be considered a successful poll. |
| Quotas | Public Best Practices currently shows preliminary 100,000 calls/month, 60 QPM, and 1–2 minute polling guidance; it says figures may change and HTTP 429 can result | Treat these as operating guidance, not a contract. Confirm application/account limits and response headers before choosing Phase 5 cadence. |
| Swagger quality | The downloaded `/v2/api-docs` is Swagger 2.0 but contains malformed JSON in a public example (`[12583SS]`) | Validate the document before generation and retain handwritten runtime decoding for fields whose published types/examples conflict. |

The full path and field inventory is in `deye-field-validation.md`. It intentionally contains no live fixture or production mapping.

## Required plan changes before implementation

### 1. D1 durable single-flight locks need fencing, not only a lock row

The plan requires a station/refresh-operation single-flight guard and idempotent writes, but the proposed D1 tables do not include a lock or lease protocol. A durable row by itself does not stop a Worker that lost its lease, timed out upstream, or resumed late from writing after a newer poll has taken over.

Before Phase 3, specify and test a design with at least:

- a `refresh_locks` row keyed uniquely by station and operation;
- an owner nonce, lease expiry, acquisition time, and monotonically increasing fencing epoch/token;
- a transactionally conditional acquire/renew/release protocol, including expired-lock takeover;
- the fencing token checked on every snapshot/event/poll-run write so a stale worker cannot commit after lease loss;
- a lease duration derived from the complete timeout plus retry budget, plus a failure policy for a worker that exceeds it;
- a unique observation/event idempotency key independent of an in-memory request or Worker instance;
- tests with two concurrent refreshes, a delayed first worker, a lease expiry, a retry, and a replayed response.

D1 transactions and uniqueness constraints can help serialize conditional writes, but they are not a documented distributed lock/fencing service. Do not rely on an in-memory “single flight” or on a Worker invocation surviving long enough to release a lock. The plan should add the lock metadata and fencing behavior to the durable-storage design before implementing refresh.

### 2. Clock, ordering, and replayed observations are underspecified

The upstream contract supplies several different time forms:

- device `collectionTime` is documented as Unix seconds;
- station `lastUpdateTime` is typed as `date-time`, while a station example is integer-looking;
- device `updateTime` is typed as an integer but has a string-looking example;
- alert and raw-history requests use 10-digit Unix seconds;
- the upstream response does not supply the server's fetch time.

Add an explicit observation-time policy before freezing the domain model:

1. Preserve `sourceObservedAt`/origin time, server `receivedAt`/`fetchedAt`, original timestamp representation, and request metadata separately.
2. Normalize only after checking seconds versus milliseconds, parseability, reasonable future/past bounds, and the device/station timezone where applicable.
3. Define how much clock skew is accepted and how a missing, future, stale, equal, or backward timestamp is classified.
4. Give each normalized observation an idempotency/fingerprint basis. A `requestId` identifies a request, not necessarily a unique physical observation; the same cloud snapshot may be returned repeatedly.
5. Prevent an older or identical replay from overwriting a newer snapshot or creating a second grid transition. Record a data gap/replay rather than manufacturing an outage/restoration.
6. Store transition timing honestly: distinguish first observed online/offline time from the unknown physical switching time when cloud delay or a gap exists.

The three-minute freshness value in the plan is a validation starting point, not a public Deye guarantee. Tune it only after measuring logger upload cadence and outage/restoration delay. A fresh HTTP response containing an old `sourceObservedAt` must remain old.

### 3. Authentication freshness semantics need a state machine

The Quick Start says access tokens expire after 60 days, can expire after a password reset or role modification, and that issuing another token does not invalidate the original. The token response includes `expiresIn` and `refreshToken`, but the public Swagger has no refresh endpoint or documented refresh grant.

The plan should define, test, and document:

- token cache states (`valid`, near expiry, invalid, re-authentication required) and a safety margin before `expiresIn`;
- whether re-authentication calls `/account/token` with the original account credentials, and how that is serialized without persisting credentials/tokens in D1;
- behavior for HTTP 401/403 and body-level auth failures such as `code:2101017` with HTTP 200;
- whether a failed auth refresh leaves the last snapshot untouched and changes effective status to `unknown`/unavailable rather than `offline`;
- how a business-member `companyId` is retained as non-secret configuration and re-used after re-authentication;
- secret rotation, password/role invalidation, concurrent refresh attempts, and an operator-visible failure category without exposing secrets.

Token validity is not telemetry freshness. A valid token can return stale data; an invalid token is a collection failure, not evidence that the utility grid went offline. This distinction should be an explicit domain and persistence invariant.

## Outstanding blockers and ambiguities

1. **Exact device mapping:** public schemas do not establish that the named SUN model exposes voltage, frequency, explicit grid status, or any particular dynamic measurement key. The target product/firmware and logger must be confirmed live.
2. **Grid evidence:** public `gridPower`, `purchasePower`, and `wirePower` have no published units/sign semantics. Device/station online states only describe communication/device status. No production mapping is justified.
3. **Contract inconsistency:** the device-alert description mentions `deviceId`, but its published request schema does not expose that field. Validate the current response/request behavior before generating types.
4. **Quota and cadence:** public quota figures are preliminary. The plan must not promise one-minute polling or select a Cron cadence until application/account limits, response headers, and actual logger update frequency are known.
5. **Raw payload retention:** the plan asks for sanitized fixtures but also forbids identifiers and secrets in storage. Define a redaction/hash policy for station IDs, serials, request IDs, and dynamic field names before collecting fixtures.
6. **HTTP success semantics:** the API can return a transport-successful response with `success:false`; the adapter's typed error taxonomy must classify body-level auth, quota, validation, and upstream errors before retry decisions.
7. **Phase boundary:** public research may proceed alongside an independently safe foundation (schemas, error handling, storage, and tests), but it must not freeze production mappings or declare Phase 1 complete. Phase 1 is not complete until authorized live checks produce evidence.

## Recommended acceptance-test additions

Add these gates to the relevant phases without changing the public API contract:

- **Phase 1:** exact regional host/account role, sanitized station/device discovery, exact target measurement-point list, at least two known outage/restoration observations, measured cloud delay, and a direct-signal decision. If no signal passes, assert `unknown`.
- **Phase 2:** schema tests for malformed/missing fields, flexible string measurement values, body-level errors returned with HTTP 200, timestamp unit conflicts, and no secret/token logging.
- **Phase 3:** concurrent lock acquisition, fencing after lease expiry, stale-worker rejection, equal/backward timestamp handling, replayed payloads, duplicate event prevention, and auth-expiry behavior.
- **Phase 4:** credential rotation/role invalidation, upstream 401/403 and body-level auth failures, stale data during valid auth, Deye unavailability, and no false grid transition.
- **Phase 5:** quota/header observation, staggered polling, 429 backoff, logger cadence, and overlapping scheduled invocations using the same fenced finite refresh workflow.

Until these blockers are resolved, the safe public behavior specified by the plan is: serve the last stored observation with explicit age when available, degrade current grid state to `unknown` when evidence is stale/unavailable/untrusted, and never claim a verified device measurement from the public contract alone.
