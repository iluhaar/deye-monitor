import { useRef } from "react";
import { displayMode, formatAge, formatNumber, formatTimestamp } from "./helper";
import Schedule from "./Schedule";
import type { ScheduleReload } from "./Schedule";
import { useTelemetry } from "./useTelemetry";

function App() {
  const { telemetry, operation, error, notice, refreshIssue, refresh } = useTelemetry();
  const reloadSchedule = useRef<ScheduleReload | null>(null);
  const measurementAgeSeconds = telemetry?.freshness.ageSeconds;

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
          onClick={() => void refresh(() => reloadSchedule.current?.() ?? Promise.resolve())}
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
      {!error && notice && (
        <div className="message" role="status">
          {notice}
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
          <p className="main-value">{formatNumber(telemetry?.grid.powerW ?? null, "W")}</p>
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
          <p className="main-value">{formatNumber(telemetry?.battery.socPercent ?? null, "%")}</p>
          <p className="caption">State of charge</p>
          <dl className="details">
            <div>
              <dt>Battery power</dt>
              <dd>{formatNumber(telemetry?.battery.powerW ?? null, "W")}</dd>
            </div>
          </dl>
        </article>
      </section>

      <Schedule gridOnline={telemetry?.grid.status === "online"} reloadRef={reloadSchedule} />

      <footer className="timestamps">
        <p>
          <span>Inverter measurement time</span>
          {formatTimestamp(telemetry?.measuredAt ?? null)}
        </p>
        <p>
          <span>Last retrieved from Deye</span>
          {formatTimestamp(telemetry?.fetchedAt ?? null)}
        </p>
        <p>
          <span>Measurement age</span>
          {measurementAgeSeconds === null || measurementAgeSeconds === undefined
            ? "Not available"
            : formatAge(measurementAgeSeconds)}
        </p>
      </footer>
    </main>
  );
}

export default App;
