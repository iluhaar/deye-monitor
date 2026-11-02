# Deye field validation — Phase 1 public-contract research

**Status:** provisional public-contract inventory with operator-supplied sample/inventory; no validated grid mapping
**Research date:** 2026-10-24
**Target named by the plan:** Deye SUN-6K-SG06LP1-EU-BM2. The agent made no live calls or account/device access; the repository includes an operator-supplied sanitized actual `device/latest` sample and exact advertised point inventory.

## Scope and non-claims

Public-contract statements in this document come from Deye documentation. No credentials or live account/device were accessed by the agent. Separately, the repository contains the operator-supplied sanitized actual sample and advertised point inventory noted above. Therefore:

- There is no verified production field mapping or independently reviewed live grid validation; the supplied sample and point inventory do not establish grid semantics.
- Public documentation examples below are not target measurements. The separately supplied actual upstream sample is provisional evidence, not a validated grid observation.
- A public example is not evidence that the same field exists on the target device.
- Grid state remains `unknown` until the checklist below proves a direct signal against independent ground truth. In particular, zero import/export power is not evidence of grid absence.

## Sources and retrieval record

| Source | Public evidence used | Limitation |
| --- | --- | --- |
| [EU Swagger](https://eu1-developer.deyecloud.com/v2/api-docs) | Swagger 2.0 document; EU host; operation paths, methods, request schemas, response schemas, descriptions | The raw response was 93,219 bytes and does not pass strict JSON parsing: the `latestDataRequest.deviceList` example contains an unquoted `12583SS`. The document was inspected as published; no generated client should trust it without validation. |
| [Developer Quick Start](https://developer.deyecloud.com/start) | Regional base URLs, token flow, password hashing, token expiry/revocation notes, personal/business-member flow | The page is client-rendered and its examples are documentation examples, not this account. |
| [API Documentation](https://developer.deyecloud.com/api) | Portal entry point for the OpenAPI document and endpoint summaries | The portal shell requires JavaScript; the direct Swagger URL above is the contract source used here. |
| [Best Practices](https://developer.deyecloud.com/best-practices) | Preliminary quota/rate guidance, logger upload cadence guidance, HTTP 429 and caching guidance | The page says the figures are preliminary and subject to change; they are not a stable quota contract. |
| [Open MCP tool documentation](https://developer.deyecloud.com/openmcp/docs/deye-open-mcp-tools.html) | Public wrapper summaries corroborating read-only station/device operations and response shapes | MCP wrappers are not a substitute for the target OpenAPI contract and were not used to access an account. |

The public Swagger declares `swagger: "2.0"`, `info.version: "1.0"`, `host: "eu1-developer.deyecloud.com:443"`, and `basePath: "/"`. It does not declare a global `securityDefinitions` object; authentication is described on individual operations.

An unauthenticated, credential-free probe was made only to establish response-envelope behavior. `POST /v1.0/station/list` with `{}` returned HTTP 200 and:

```json
{"msg":"auth token not found","code":"2101017","success":false}
```

The request did not access an account or return measurements. This is an observed edge response, not a promise that every failure uses HTTP 200; the Swagger also lists 401/403 responses. Error handling must inspect both HTTP status and the body envelope.

## Confirmed public contract

### Regional hosts

The Quick Start identifies these developer API base URLs:

| Data center | Public base URL | What remains unverified |
| --- | --- | --- |
| EU / EMEA, APAC | `https://eu1-developer.deyecloud.com` | Whether the target account is served here |
| US / AMEA | `https://us1-developer.deyecloud.com` | Whether the target account is served here |
| India | `https://india-developer.deyecloud.com` | Whether the target account is served here |

The supplied Swagger is the EU document. Do not select a production host from the inverter model or geography alone; confirm it with the account/application setup.

### Authentication facts

`POST /v1.0/account/token?appId={AppId}` is the public token operation. Its published request is JSON and contains:

- `appSecret` and `password` as schema-required fields;
- one login identity: `email`, `mobile`, or `username` (the operation description says one is required);
- `countryCode` when `mobile` is used;
- optional `companyId` to obtain a business-member token; without it, the documentation says the token is for the personal user.

The Swagger calls the password value “encrypted”, but technically this is a SHA-256 hash/digest, not reversible encryption. Quick Start additionally says it must be lowercase; read that as a lowercase hexadecimal digest, not as lowercasing the plaintext password. The response schema exposes `accessToken`, `refreshToken`, `expiresIn` (typed as a string), `tokenType`, `scope`, `uid`, `code`, `msg`, `requestId`, and `success`; only `requestId` and `success` are schema-required.

The Quick Start says:

- an access token expires after 60 days;
- resetting the password or modifying the role also expires it;
- issuing another token does not invalidate the original;
- `companyId` can be obtained through `POST /v1.0/account/info` for the business-member flow.

Every protected operation below declares a required `Authorization`/`authorization` header described as `Bearer {token}`. The header name is case-insensitive, but the token must not be logged or written to D1. The Swagger exposes no separate refresh-token operation. Although a `refreshToken` field is present in the token response, no refresh grant/path is documented here; do not assume OAuth refresh semantics.

### Read-only paths relevant to Phase 1

All paths in this table are `POST` in the published Swagger unless noted otherwise. Request bodies and limits are the public schema/description, not live-account behavior.

| Path | Public purpose and contract facts | Live limitation |
| --- | --- | --- |
| `/v1.0/account/info` | Account-to-organization relationship; bearer header; returns organization/company information | Needed to choose a business-member token, but no account was accessed. |
| `/v1.0/station/list` | List stations; body has optional `page` and `size` (published defaults/maxima) | Station IDs and station ownership are unknown. |
| `/v1.0/station/listWithDevice` | List stations with devices; optional `deviceType`, `page`, `size`; response includes station fields and device list items | Device membership, product ID, and exact target model are unverified. |
| `/v1.0/station/device` | Batch device lookup; body requires `stationIds`, with optional `page`/`size` | Requires a real station ID. |
| `/v1.0/station/detail` | Station detail; body requires `stationId` | Requires a real station ID. |
| `/v1.0/device/list` | Device list for business members; body has `page`/`size`; device items include SN/type/product ID, state, and last-update field | The summary is role-specific and the target account role is unknown. |
| `/v1.0/station/latest` | Latest station summary; body requires `stationId`; response names `batteryPower`, `batterySOC`, `chargePower`, `dischargePower`, `generationPower`, `consumptionPower`, `gridPower`, `purchasePower`, `wirePower`, `irradiateIntensity`, and `lastUpdateTime` | The schema gives no units, sign convention, grid semantics, or target-device availability. |
| `/v1.0/device/measurePoints` | Measurement-point names for a `deviceSn`; `deviceSn` required, `deviceType` optional; response includes string `measurePoints`, product ID, and time zone | The returned point set is device/firmware/account dependent and has not been retrieved. |
| `/v1.0/device/latest` | Latest data for a required `deviceList`; summary says up to 10 devices per batch; optional `deviceType` | `dataList` is flexible rather than a fixed inverter schema. |
| `/v1.0/device/historyRaw` | Raw device history by 10-digit Unix-second timestamps; `deviceSn`, `startTimestamp`, `endTimestamp`, and `measurePoints` required; published range is at most five days | The point names and timestamp behavior need live confirmation. |
| `/v1.0/device/history` | Aggregated device history; `granularity` 1/day, 2/day range, 3/month range, 4/year range per the description; measure points come from `/measurePoints` | Aggregation semantics and available points are not validated for the target. |
| `/v1.0/station/history/power` | Station history by Unix-second timestamps; description says the range must be at most 12 months | Summary fields still have no published units/sign convention. |
| `/v1.0/device/alertList` | Device alerts using Unix seconds; language query is available; description says a range must not exceed 30 days | The description mentions querying by `deviceId`, while the published request schema does not expose a `deviceId` property. Treat this as a contract inconsistency. |
| `/v1.0/station/alertList` | Station alerts using Unix seconds, paginated; description says the range must not exceed 180 days | Alert names and timing are not evidence of the target's grid state until tested. |

The Swagger also publishes configuration, station-creation/logger-registration, strategy, and device-control paths, including `/v1.0/order/*`, `/v1.0/strategy/*`, `/v1.0/config/*`, `/v1.0/station/create`, `/v1.0/device/addLogger`, `/v1.0/device/deleteLogger`, and `/v1.0/device/register`. They are outside this read-only research and must not be called by the MVP adapter.

### Response and timestamp facts that affect normalization

- Most responses use a `code`/`msg`/`requestId`/`success` envelope, but the schema does not require all of those fields. A successful HTTP response is not enough; decode `success` and validate the data fields.
- `/v1.0/device/latest` returns `collectionTime` as a Unix timestamp in seconds. Each flexible data item has string `key`, string `unit`, and string `value`; the public numeric example does not change the declared string type.
- `deviceState` is documented as `1` online, `2` alert, `3` offline. `connectStatus` examples describe `0` offline, `1` online, `2` alert. These are device/cloud connectivity states, not utility-grid states.
- Station latest fields are declared as numbers, but the public contract does not document watts, volts, hertz, import/export sign, phase, or whether a field is direct or derived.
- Station `lastUpdateTime` is typed as `date-time`; other station examples show integer-looking values. Device `updateTime` is typed as an integer but has a string-looking example. Validate actual responses and retain the original representation during research.
- Device and station alert requests use 10-digit Unix seconds. Alert records expose start/end times, status, level, impact, protocol name, and alert name, but not a guarantee that an alert is a direct grid measurement.
- The upstream response has no server `fetchedAt`. The adapter must add its own UTC receive time and keep it separate from the origin measurement/update time.

## Grid-signal inventory — unverified

The repository includes an operator-supplied sanitized actual `device/latest` sample and exact advertised point inventory; the agent made no live calls. The sample's receive-time and independent ground-truth alignment are absent, so it cannot validate grid state, cadence, or a production mapping. The table deliberately does **not** choose one.

| Public artifact or candidate | What the public contract confirms | Why it is not verified evidence | Current disposition |
| --- | --- | --- | --- |
| `gridPower`, `purchasePower`, `wirePower` in station latest/history | Named numeric fields exist in the station schemas | No unit, sign convention, direct-vs-derived meaning, freshness guarantee, or outage behavior is documented. Zero power can occur while a grid is connected. | Candidate telemetry only; never infer online/offline from zero/non-zero. |
| Flexible `deviceDataList[].dataList[]` from `/v1.0/device/latest` | A device can return arbitrary string `key`/`unit`/`value` items; `/measurePoints` supplies names | The fixed schema does not enumerate grid voltage, frequency, or status keys. The public example is for a generic device and is not the target's point list. | Discover exact keys on the target, then test; no mapping now. |
| `deviceState`, `connectStatus`, station `connectionStatus` | Public enums describe online/alert/offline or normal/all-offline/partial-offline states | These describe device/logger/cloud connectivity and can change because communications fail; they do not prove utility-grid presence. | Supporting health evidence only; not a grid signal. |
| `alertName` / `protocolName` from device or station alerts | Alert records have time, status, level, impact, and names; the Swagger includes the example text `AC_NoUtillity_Fault F35` | That text is a documentation example, not an observed alert. Catalog availability, translation, timing, clear behavior, and relation to the target firmware are unknown. | Candidate corroboration only; never authoritative without repeated live tests. |
| Direct grid voltage, frequency, or explicit grid-connected status | No fixed property with those semantics is defined in the public station/device schemas | Such a signal could exist as a device-specific measurement point, but its key, unit, range, and behavior are not published here. Inventing a key would be a guessed production mapping. | Highest-priority live discovery item. |
| `collectionTime`, `lastUpdateTime`, `updateTime`, alert times | The contract exposes origin/update timestamps in several formats | A timestamp establishes age/order, not physical grid state; clock skew, replay, and cloud delay are unknown. | Evidence-quality metadata only. |

**Phase 1 public conclusion:** no authoritative grid-presence signal is confirmed. Until a controlled live test establishes one, the server must expose `unknown` and preserve any last confirmed state only as historical context.

## Concrete live verification checklist

Run this only with an authorized account and an explicitly chosen regional host. Keep credentials, raw tokens, serial numbers, station IDs, and unredacted responses outside the repository.

This is an operator validation gate, not a development prerequisite: offline implementation and tests do not require live Deye calls. Nothing here authorizes a live request, outage, credential change, or deployment. The public-contract inventory and current sample are provisional; there is no validated two-state grid mapping. Until the evidence below is supplied and reviewed, `unknown` / `unverified` remains the safe default. Never manufacture a grid transition from a fixture, replay, missing data, or power flow.

1. **Record the test context.** Confirm the regional hostname, account role (personal or business), target model, firmware, logger model/type, and timezone. Record no account, application, company, station, device, or serial identifiers. Use UTC-synchronized clocks. Do not infer any of these from the plan or a public example.
2. **Exercise authentication safely.** If authorized, call the token endpoint with secrets supplied by a secret manager; record only sanitized HTTP/body status, `code`, `success`, token type, and expiry metadata. For a business account, call `/v1.0/account/info` and record role only. Do not reset a password or change a role solely for this test; record a pre-existing/independently scheduled lifecycle event, or mark a simulation/not tested. Mark each expiry, invalidation, and rotation result as **observed**, **simulated**, **documentation-only**, or **not tested**; never log tokens or imply a simulation is live evidence.
3. **Discover the topology.** Call `/v1.0/station/list` or `/v1.0/station/listWithDevice`, then `/v1.0/station/device`/`/v1.0/device/list` as permitted. Confirm which device is the exact target inverter and which logger/meter supplies the readings. Redact identifiers in any fixture.
4. **Enumerate actual points.** Call `/v1.0/device/measurePoints` for the target device. Save a sanitized list of exact returned keys, units, and time zone; omit product IDs and all account/device identifiers. Do not substitute names from another model or from a public example.
5. **Capture an online baseline.** At a known utility-grid-present time, call `/v1.0/station/latest` and `/v1.0/device/latest` at a conservative cadence. Record request-start and response-receive UTC times separately from each source timestamp, plus HTTP status, body `code`/`success`, exact key/unit/value triples, device state, and observed response age. Also record a normal zero-flow period if available; this is specifically a test that zero power is not treated as offline.
6. **Observe outage and restoration only if they occur.** Do not induce, request, or extend an outage for validation, and do not use Deye control endpoints. If a utility interruption and restoration occur naturally, capture samples around them with an independent ground-truth method. Record each ground-truth observation time separately from request, receive, and source times; distinguish estimated physical switching time from the first cloud observation. Seek additional independent cycles only when naturally available; otherwise leave this evidence incomplete.
7. **Cross-check candidates.** Compare exact device points, station summary fields, device/station states, and alerts for every cycle. A field qualifies only if its semantics and unit are confirmed, it is present on this device/firmware, its timestamp is fresh, and it changes consistently with both outage and restoration. Keep `unknown` for missing, stale, contradictory, or communication-only evidence.
8. **Check history and delay.** Use `/v1.0/device/historyRaw` for a narrow window (within the five-day public limit) and the relevant exact point names. Compare history to latest responses and measure cloud reporting delay; do not treat a fetched response as a new physical observation.
9. **Exercise replay/clock handling.** Re-read an unchanged upstream sample, capture out-of-order/old samples if they occur, validate seconds versus milliseconds and date-time forms, and ensure a replay cannot create a second transition. Record clock skew and define the accepted range before production mapping.
10. **Respect service limits.** The public Best Practices page gives preliminary guidance of 100,000 calls/month, 60 QPM, and a 1–2 minute interval; it says current limits can be exposed in response headers and excess can return HTTP 429. Start below those figures, stagger calls, cache discovery, and treat the values as provisional until the application/account limits are confirmed.
11. **Write the evidence record below.** For each candidate, record exact upstream key, unit, source timestamp, request/receive times, independently known grid state, observed value/range, delay, power direction if independently established, failure behavior, and confidence. Store only sanitized fixtures. If no direct signal passes, document the failed candidates and leave the public API status `unknown`.

### Sanitized operator evidence record — copy and complete only with authorized evidence

Use UTC ISO-8601 timestamps with `Z`. Write `unknown`, `not observed`, or `not tested` rather than guessing. Do not paste raw payloads or include secrets, tokens, account/application/company/station/device IDs, request IDs, serial numbers, or other operator identifiers. Keep any identifier-to-placeholder key outside this repository.

**Context (no identifiers):**

| Item | Sanitized value |
| --- | --- |
| Regional API hostname | `[e.g. public regional hostname; no IDs]` |
| Account role | `[personal / business / unknown]` |
| Inverter model / firmware | `[value / unknown]` |
| Logger model/type | `[value / unknown]` |
| Account/device timezone | `[IANA timezone / unknown]` |
| Validation date and clock synchronization | `[UTC date; method/status]` |

**Authentication lifecycle (do not record credentials or token values):**

| Check | Evidence mode (`observed` / `simulated` / `documentation-only` / `not tested`) | Sanitized outcome and UTC time | Expiry/invalidation/rotation behavior confirmed? |
| --- | --- | --- | --- |
| Token issuance / expiry metadata | `[ ]` | `[HTTP/body status, token type, expiresIn; issued at UTC]` | `[yes/no/unknown]` |
| Expiry or invalid-token response | `[ ]` | `[sanitized status/code and UTC time, or not tested]` | `[yes/no/unknown]` |
| Role/password invalidation | `[ ]` | `[sanitized outcome and UTC time, or not tested]` | `[yes/no/unknown]` |
| Credential rotation / replacement | `[ ]` | `[sanitized outcome and UTC time, or not tested]` | `[yes/no/unknown]` |

**Request/sample record (one row per response):**

| Request start UTC | Response received UTC (`fetchedAt`) | Source timestamp as returned / normalized UTC (`measuredAt`) | Endpoint category | HTTP + sanitized `code`/`success` | Exact point key / unit / value | Known grid state and independent source | Source age / request cadence / receive lag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `[ ]` | `[ ]` | `[ ]` | `[station latest / device latest / history / other]` | `[ ]` | `[ ]` | `[present / outage / restored / unknown; source]` | `[ ]` |

State the observed logger upload/source-sample cadence and API polling cadence separately. Calculate receive lag only where both source and receive times are available; note missing, repeated, out-of-order, or stale timestamps rather than treating fetch time as measurement time.

**Power semantics (candidate by exact field, no inference from names):**

| Exact key | Unit | Observed signed values | Independently established direction (`import` / `export` / other) and method | Sign convention (`confirmed` / `unresolved`) | Evidence mode and notes |
| --- | --- | --- | --- | --- | --- |
| `[ ]` | `[ ]` | `[ ]` | `[ ]` | `[ ]` | `[ ]` |

**Independent grid ground truth (one row per observation; do not manufacture events):**

| Ground-truth state (`present` / `outage` / `restored`) | Independent observation UTC | Method/source (not Deye telemetry) | First corresponding cloud source UTC | Request start UTC | Response receive UTC | Candidate field/value and interpretation |
| --- | --- | --- | --- | --- | --- | --- |
| `[ ]` | `[ ]` | `[ ]` | `[ ]` | `[ ]` | `[ ]` | `[ ]` |

**Disposition:** `[candidate mapping and limits, or no validated mapping]`; `[unknown/unverified default retained? yes/no]`; `[reviewer/date]`. A two-state mapping is not validated by a single sample, public example, simulated transition, zero/non-zero power, communication state, or alert example. Preserve `unknown` for absent, stale, contradictory, or communication-only evidence. Do not create transition records to fill gaps.

## Phase 1 gate

This research is complete only as a public-contract prerequisite. The repository has an operator-supplied sanitized actual sample and exact advertised point inventory, but their receive-time/ground-truth alignment is absent and the agent made no live calls. The Phase 1 gate remains blocked on independent review of target point semantics and live lifecycle, cadence/lag, quota, power-sign, and grid validation, including independently timestamped naturally occurring grid-present/outage/restored observations. No implementation should freeze a production grid mapping based on this document. Live calls are not required for development; without sufficient reviewed evidence, the mapping stays unvalidated and the safe result remains `unknown` / `unverified`.
