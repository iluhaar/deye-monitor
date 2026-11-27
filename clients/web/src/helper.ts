export function formatNumber(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

export function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not available";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatAge(ageSeconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, ageSeconds));
  const units = [
    { value: Math.floor(totalSeconds / 86_400), label: "day" },
    { value: Math.floor((totalSeconds % 86_400) / 3600), label: "hour" },
    { value: Math.floor((totalSeconds % 3600) / 60), label: "minute" },
    { value: totalSeconds % 60, label: "second" },
  ].flatMap(({ value, label }) =>
    value > 0 ? [`${value} ${label}${value === 1 ? "" : "s"}`] : [],
  );

  if (units.length === 0) {
    return "0 seconds";
  }
  if (units.length === 1) {
    return units[0];
  }
  return `${units.slice(0, -1).join(", ")} and ${units.at(-1)}`;
}

export function displayMode(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function scheduleBadgeClass(headline: string | undefined): string {
  if (headline === "Off") {
    return "offline";
  }
  if (headline === "On" || headline === "Power on" || headline === "No outages") {
    return "online";
  }
  return "neutral";
}
