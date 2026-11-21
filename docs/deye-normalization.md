# Deye normalization limits

The current device/latest mapping is `deye-device-latest-offline-v2`. It adds a
provisional off-only rule using the operator-confirmed outage reading of
5.1 V and 0 Hz on 2026-11-21. Its original sample fixture is
an operator-supplied actual upstream response, used for offline normalization
only. Its receive time and independent ground-truth alignment are absent, so it
does not validate grid classification or a two-state mapping.

## Retained fields

The normalizer accepts the flexible string-valued `dataList` shape and validates
both numeric values and their units before retaining:

| Deye key | Required unit | Internal field | Disposition |
| --- | --- | --- | --- |
| `GridVoltageL1L2` | `V` | `grid.voltageV` | Used by the off-only rule |
| `GridFrequency` | `Hz` | `grid.frequencyHz` | Used by the off-only rule |
| `SOC` | `%` | `battery.socPercent` | Retained when it is in `0..100` |
| `TotalConsumptionPower` | `W` | `home.powerW` | Retained as a load magnitude only |

`TotalGridPower` and `ExternalCTPowerL1L2` are not interchangeable: the sample
contains `67 W` and `-72 W`, respectively, with no approved meaning or sign
direction. Therefore `grid.powerW` remains `null`. `BatteryPower` and other
directional power values likewise remain `null`; `battery.mode` is always
`unknown` and the snapshot carries `powerSignConvention: "unverified"`.

Missing, null-unit, non-numeric, out-of-range, or contradictory duplicate
measurements become `null`. The normalizer never fills a missing point with
zero, selects a similarly named fallback, mutates the upstream object, or
creates a transition event.

A singleton device with an omitted/`null` type is accepted for compatibility
with already-scoped adapter results. An explicitly typed non-`INVERTER` device
is rejected rather than being interpreted as an inverter.

`collectionTime` is interpreted only as Unix seconds. For example,
`1792851317` becomes `2026-10-24T14:15:17.000Z`; `Asia/Beirut` does not alter
that conversion. Millisecond-looking or malformed timestamps become an
unavailable measured time. The caller supplies `fetchedAt`; the normalizer
does not sample a clock or assume a reporting cadence. When a clock is supplied
explicitly, the existing freshness evaluator classifies stale, future, and
measured-after-fetch observations conservatively.

Grid output is `status: "offline"` and `confidence: "confirmed"` only when
both validated readings are present, voltage is in `0..10 V` inclusive, and
frequency is exactly `0 Hz`. The 10 V limit is a provisional residual-voltage
tolerance, not a general undervoltage threshold. All other combinations remain
`unknown`/`unverified`; grid-on classification awaits a known-on sample.
Read-time and ingestion evaluation still require fresh, available collection.
Missing, malformed, wrong-unit, or contradictory readings cannot establish
offline. Zero power alone is never outage evidence. Existing stored snapshots
are not reclassified; a successful refresh is needed to apply this mapping.
