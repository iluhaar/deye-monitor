# Operator validation evidence

## City-power-present baseline — 2026-11-02

Provenance: operator-pasted public responses from the locally running Worker,
followed by explicit confirmation that city power was available at the source
timestamp below. The agent did not make the live request. Only sanitized
telemetry is retained; request credentials are deliberately omitted.

The operator reports city power and battery backup only, with no generator.
This removes generator supply as a reported source ambiguity, but does not
independently validate the inverter wiring or a two-state mapping.

| Observation | Value |
| --- | --- |
| Endpoint sequence | `POST /api/v1/refresh`, then `GET /api/v1/telemetry` |
| Refresh result | `ok: true`, outcome `unverified` |
| Source timestamp (`measuredAt`) | `2026-11-02T22:02:22.000Z` |
| Adapter receive timestamp (`fetchedAt`) | `2026-11-02T22:04:30.891Z` |
| Source-to-fetch age | 128.891 seconds; includes sampling/upload/cache/network/clock effects, not measured request latency |
| Request start / client receive UTC | Not supplied; `fetchedAt` is the adapter timestamp, not a separately observed client time |
| Grid ground truth | Operator confirms city power available at the source timestamp; physical checking method and clock synchronization not supplied |
| Public grid readings | 225.3 V, 49.98 Hz; evidence labels `grid_voltage`, `grid_frequency` |
| Grid interpretation | `unknown`, confidence `unverified`; grid power `null` |
| Battery | SOC 100%; power `null`, mode `unknown` |
| Home power | 28 W |
| Refresh freshness | `fresh`, age 128 seconds |
| Subsequent GET | Same source/fetch timestamps and measurements; `fresh`, age 143 seconds |

This supports a grid-present baseline and an operator-exercised local
refresh/persist/read path. It is not a raw upstream point/unit fixture and does
not independently establish exact upstream keys, authentication response metadata,
token lifecycle, power direction, reporting cadence, account quotas, or typical
latency. One sample is insufficient to revise freshness or polling policy.

No outage/restoration observation exists in this record. Grid classification
remains unknown/unverified; no confirmed event should be inferred or backfilled.
Future outage/restoration evidence must be opportunistic, never induced.

The two local API credentials pasted with the request were exposed. The operator
intends to rotate both; completed rotation and rejection of the old values have
not been observed. These local API credentials are separate from Deye credentials
and upstream token-lifecycle validation.

Use the [field-validation checklist](deye-field-validation.md#concrete-live-verification-checklist)
for additional evidence. Tracking: ILL-75 (live account), ILL-71 (grid mapping),
ILL-74 (cadence/quotas). Unknown-only development is not blocked by these gaps.
