# Deye field validation — Phase 1 public-contract research

**Status:** provisional public-contract inventory, not live-device validation
**Research date:** 2026-10-24
**Target named by the plan:** Deye SUN-6K-SG06LP1-EU-BM2; the target account, device, firmware, and measurements were not accessed.

## Scope and non-claims

This document records what can be established from public Deye documentation only. No Deye credentials, developer account, live account, station, device, or telemetry were used. Therefore:

- There is no verified production field mapping or sanitized live fixture yet.
- No value below is an observed measurement from the target inverter.
- A public example is not evidence that the same field exists on the target device.
- Grid state remains `unknown` until the live checklist below proves a direct signal. In particular, zero import/export power is not evidence of grid absence.

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

There is no live evidence in this repository. The table deliberately does **not** choose a production mapping.

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

1. **Record the test context.** Confirm the actual data center, application, account role (personal or business), target station, inverter serial/model, firmware, logger, and timezone. Use UTC-synchronized clocks. Do not infer any of these from the plan or a public example.
2. **Exercise authentication safely.** Call the token endpoint with secrets supplied by a secret manager; record only sanitized HTTP/body status, `code`, `success`, token type, and expiry metadata. For a business account, call `/v1.0/account/info` and retain only a redacted role/company reference. Verify expiry and invalidation behavior without logging tokens.
3. **Discover the topology.** Call `/v1.0/station/list` or `/v1.0/station/listWithDevice`, then `/v1.0/station/device`/`/v1.0/device/list` as permitted. Confirm which device is the exact target inverter and which logger/meter supplies the readings. Redact identifiers in any fixture.
4. **Enumerate actual points.** Call `/v1.0/device/measurePoints` for the target device. Save a sanitized list of exact returned keys, units, product ID, and time zone. Do not substitute names from another model or from a public example.
5. **Capture an online baseline.** At a known utility-grid-present time, call `/v1.0/station/latest` and `/v1.0/device/latest` at a conservative cadence. Record server receive time, HTTP status, body `code`/`success`, origin timestamp, exact key/unit/value triples, device state, and response age. Also record a normal zero-flow period if available; this is specifically a test that zero power is not treated as offline.
6. **Test controlled outage and restoration.** With an authorized person following electrical-safety procedures and an independent ground-truth method, capture several samples before, during, and after a known utility interruption and restoration. Do not use Deye control endpoints to induce an outage. Repeat at least two outage/restoration cycles if safe, and record the first cloud observation separately from the estimated physical switching time.
7. **Cross-check candidates.** Compare exact device points, station summary fields, device/station states, and alerts for every cycle. A field qualifies only if its semantics and unit are confirmed, it is present on this device/firmware, its timestamp is fresh, and it changes consistently with both outage and restoration. Keep `unknown` for missing, stale, contradictory, or communication-only evidence.
8. **Check history and delay.** Use `/v1.0/device/historyRaw` for a narrow window (within the five-day public limit) and the relevant exact point names. Compare history to latest responses and measure cloud reporting delay; do not treat a fetched response as a new physical observation.
9. **Exercise replay/clock handling.** Re-read an unchanged upstream sample, capture out-of-order/old samples if they occur, validate seconds versus milliseconds and date-time forms, and ensure a replay cannot create a second transition. Record clock skew and define the accepted range before production mapping.
10. **Respect service limits.** The public Best Practices page gives preliminary guidance of 100,000 calls/month, 60 QPM, and a 1–2 minute interval; it says current limits can be exposed in response headers and excess can return HTTP 429. Start below those figures, stagger calls, cache discovery, and treat the values as provisional until the application/account limits are confirmed.
11. **Write the evidence table.** For each accepted field, record exact upstream key, unit, source device, origin timestamp, server `fetchedAt`, known grid state, observed value/range, delay, failure behavior, and confidence. Store only sanitized fixtures. If no direct signal passes, document the failed candidates and leave the public API status `unknown`.

## Phase 1 gate

This research is complete only as a public-contract prerequisite. The plan's Phase 1 acceptance gate remains blocked by the absence of authorized live verification, exact target-device measurement points, outage/restoration observations, quota confirmation, and auth-expiry observations. No implementation should freeze a production grid mapping based on this document.
