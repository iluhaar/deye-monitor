# Deye normalization limits

The current device/latest mapping is `deye-device-latest-unverified-v1`. It is
deliberately a retention mapping, not an outage detector.

## Retained fields

The normalizer accepts the flexible string-valued `dataList` shape and validates
both numeric values and their units before retaining:

| Deye key | Required unit | Internal field | Disposition |
| --- | --- | --- | --- |
| `GridVoltageL1L2` | `V` | `grid.voltageV` | Retained as an unverified candidate |
| `GridFrequency` | `Hz` | `grid.frequencyHz` | Retained as an unverified candidate |
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

Grid output is always `status: "unknown"` and `confidence: "unverified"` in
this revision. A later separately approved mapping may add confirmed evidence;
this normalizer must not manufacture confirmed online/offline transitions from
the current fixture or from zero flow.
