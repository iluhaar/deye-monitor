# Deye normalization limits

The current device/latest mapping is `deye-device-latest-battery-v4`. It uses
operator-confirmed off (5.1 V, 0 Hz) and on (227.5 V, 50.01 Hz) readings from
2026-11-21. Its original sample fixture is
an operator-supplied actual upstream response, used for offline normalization
only. Its receive time and independent ground-truth alignment are absent, so it
does not validate grid classification or a two-state mapping.

## Retained fields

The normalizer accepts the flexible string-valued `dataList` shape and validates
both numeric values and their units before retaining:

| Deye key | Required unit | Internal field | Disposition |
| --- | --- | --- | --- |
| `GridVoltageL1L2` | `V` | `grid.voltageV` | Used by the grid rules |
| `GridFrequency` | `Hz` | `grid.frequencyHz` | Used by the grid rules |
| `SOC` | `%` | `battery.socPercent` | Retained when it is in `0..100` |
| `BatteryPower` | `W` | `battery.powerW` | Negative charges, positive discharges, zero is idle |
| `TotalConsumptionPower` | `W` | `home.powerW` | Retained as a load magnitude only |

`TotalGridPower` and `ExternalCTPowerL1L2` are not interchangeable: the sample
contains `67 W` and `-72 W`, respectively, with no approved meaning or sign
direction. Therefore `grid.powerW` remains `null`.
Battery mode uses the operator-approved assumption: negative `BatteryPower`
means `charging`, positive means `discharging`, and exactly zero means `idle`.
The charging sample was `-510 W`; the positive/discharging direction is assumed,
not independently observed. Missing or invalid battery power yields null power
and `unknown` mode. No mode is inferred from grid state or SOC.
The snapshot retains `powerSignConvention: "unverified"` because grid-power
direction remains unverified and battery direction is partly assumed.

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
tolerance, not a general undervoltage threshold.
Grid output is `status: "online"` and `confidence: "confirmed"` when voltage
is in `207..253 V` and frequency is in `49..51 Hz`, both inclusive. This is a
conservative presence window for this 230 V / 50 Hz installation, not an
electrical safety assessment or a range established by exhaustive live testing.
All other combinations remain `unknown`/`unverified`.
Read-time and ingestion evaluation still require fresh, available collection.
Missing, malformed, wrong-unit, or contradictory readings cannot establish
either state. Zero power alone is never outage evidence. Existing stored snapshots
are not reclassified; a successful refresh is needed to apply this mapping.
