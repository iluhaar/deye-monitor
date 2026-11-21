import { useCallback, useEffect, useRef, useState } from "react";
import {
  configurationIssue,
  readTelemetry,
  refreshTelemetry,
  type Telemetry,
} from "./api";

type Operation = "loading" | "refreshing" | null;

function formatNumber(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatAge(ageSeconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, ageSeconds));
  const units = [
    { value: Math.floor(totalSeconds / 86400), label: "day" },
    { value: Math.floor((totalSeconds % 86400) / 3600), label: "hour" },
    { value: Math.floor((totalSeconds % 3600) / 60), label: "minute" },
    { value: totalSeconds % 60, label: "second" },
  ]
    .filter(({ value }) => value > 0)
    .map(({ value, label }) => `${value} ${label}${value === 1 ? "" : "s"}`);

  if (units.length === 0) return "0 seconds";
  if (units.length === 1) return units[0];
  return `${units.slice(0, -1).join(", ")} and ${units[units.length - 1]}`;
}

function displayMode(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function App() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [operation, setOperation] = useState<Operation>("loading");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const loadInitial = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;

    const issue = configurationIssue();
    if (issue) {
      setError(issue);
      setOperation(null);
      busy.current = false;
      return;
    }

    try {
      setTelemetry(await readTelemetry());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read inverter data.");
    } finally {
      setOperation(null);
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const refresh = async () => {
    if (busy.current) return;
    const issue = configurationIssue(true);
    if (issue) {
      setError(issue);
      return;
    }

    busy.current = true;
    setOperation("refreshing");
    setError(null);

    try {
      const result = await refreshTelemetry();
      setTelemetry(result.telemetry);
      setError(result.warning);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh inverter data.");
    } finally {
      setOperation(null);
      busy.current = false;
    }
  };

  const refreshIssue = configurationIssue(true);

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">ENERGY MONITOR</p>
          <h1>Deye Monitor</h1>
          <p className="subtitle">Read-only inverter overview</p>
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={() => void refresh()}
          disabled={operation !== null || refreshIssue !== null}
        >
          {operation === "refreshing" ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {!error && refreshIssue && (
        <div className="message" role="status">
          Refresh is unavailable. {refreshIssue}
        </div>
      )}
      {operation === "loading" && (
        <div className="message" role="status">
          Loading latest readings…
        </div>
      )}
      {!operation && !error && !telemetry && (
        <div className="message" role="status">
          No readings have been stored yet. Use Refresh to request an update.
        </div>
      )}

      <section className="cards" aria-label="Inverter readings">
        <article className="card">
          <div className="card-heading">
            <h2>Grid</h2>
            <span className={`status status-${telemetry?.grid.status ?? "unknown"}`}>
              {displayMode(telemetry?.grid.status ?? "unknown")}
            </span>
          </div>
          <p className="main-value">
            {formatNumber(telemetry?.grid.powerW ?? null, "W")}
          </p>
          <p className="caption">Grid power</p>
          <dl className="details">
            <div>
              <dt>Voltage</dt>
              <dd>{formatNumber(telemetry?.grid.voltageV ?? null, "V")}</dd>
            </div>
            <div>
              <dt>Frequency</dt>
              <dd>{formatNumber(telemetry?.grid.frequencyHz ?? null, "Hz")}</dd>
            </div>
          </dl>
        </article>

        <article className="card">
          <div className="card-heading">
            <h2>Battery</h2>
            <span className="status status-neutral">
              {displayMode(telemetry?.battery.mode ?? "unknown")}
            </span>
          </div>
          <p className="main-value">
            {formatNumber(telemetry?.battery.socPercent ?? null, "%")}
          </p>
          <p className="caption">State of charge</p>
          <dl className="details">
            <div>
              <dt>Battery power</dt>
              <dd>{formatNumber(telemetry?.battery.powerW ?? null, "W")}</dd>
            </div>
          </dl>
        </article>

      </section>

      <footer className="timestamps">
        <p>
          <span>Measured</span>
          {formatTimestamp(telemetry?.measuredAt ?? null)}
        </p>
        <p>
          <span>Server fetched</span>
          {formatTimestamp(telemetry?.fetchedAt ?? null)}
        </p>
        <p>
          <span>Measurement freshness</span>
          {telemetry?.freshness.status ?? "Unavailable"}
          {telemetry?.freshness.ageSeconds !== null &&
            telemetry?.freshness.ageSeconds !== undefined &&
            ` · ${formatAge(telemetry.freshness.ageSeconds)}`}
        </p>
      </footer>
    </main>
  );
}

export default App;
