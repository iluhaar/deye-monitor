import type { RefreshResult, Telemetry } from "./api";

// External JSON starts unknown; endpoint guards below validate every consumed field.
// oxlint-disable-next-line quality/no-unsafe-dictionary-type
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export function isTelemetry(value: unknown): value is Telemetry | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  const { grid, battery, home, freshness } = value;
  return typeof value.source === "string"
    && (value.measuredAt === null || typeof value.measuredAt === "string")
    && typeof value.fetchedAt === "string"
    && isRecord(grid)
    && (grid.status === "online" || grid.status === "offline" || grid.status === "unknown")
    && Array.isArray(grid.evidence)
    && grid.evidence.every((item: unknown) => typeof item === "string")
    && (grid.confidence === "confirmed" || grid.confidence === "unverified")
    && isNullableNumber(grid.voltageV)
    && isNullableNumber(grid.frequencyHz)
    && isNullableNumber(grid.powerW)
    && isRecord(battery)
    && isNullableNumber(battery.socPercent)
    && isNullableNumber(battery.powerW)
    && (battery.mode === "charging" || battery.mode === "discharging"
      || battery.mode === "idle" || battery.mode === "unknown")
    && isRecord(home)
    && isNullableNumber(home.powerW)
    && isRecord(freshness)
    && (freshness.status === "fresh" || freshness.status === "stale" || freshness.status === "unavailable")
    && isNullableNumber(freshness.ageSeconds);
}

export function isRefreshResult(value: unknown): value is RefreshResult {
  return isRecord(value)
    && (value.refresh === undefined || (isRecord(value.refresh)
      && (value.refresh.outcome === undefined || typeof value.refresh.outcome === "string")
      && (value.refresh.reason === undefined || typeof value.refresh.reason === "string")));
}
