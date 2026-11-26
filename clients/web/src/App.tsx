import { useEffect, useRef, useState } from "react";
import { configurationIssue, refreshTelemetry } from "./api";
import type { Telemetry } from "./api";
import ScheduleBar from "./ScheduleBar";
import {
  describeSchedule,
  kyivMinuteOfDay,
  outageGroupLabel,
  readTodayOutageSchedule,
} from "./outage-schedule";
import type { TodayOutageSchedule } from "./outage-schedule";

type Operation = "loading" | "refreshing" | null;

function formatNumber(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not available";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatAge(ageSeconds: number): string {
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

function displayMode(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function App() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [operation, setOperation] = useState<Operation>(() =>
    configurationIssue(true) ? null : "loading",
  );
  const [error, setError] = useState<string | null>(() => configurationIssue(true));
  const [notice, setNotice] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<TodayOutageSchedule | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const busy = useRef(false);

  const loadSchedule = async () => {
    try {
      setSchedule(await readTodayOutageSchedule());
      setScheduleError(null);
    } catch (error_) {
      setScheduleError(
        error_ instanceof Error ? error_.message : "Today's outage schedule is unavailable.",
      );
    } finally {
      setScheduleLoading(false);
    }
  };

  useEffect(() => {
    if (configurationIssue(true)) {
      return;
    }
    let active = true;
    busy.current = true;

    void refreshTelemetry()
      .then(
        (result) => {
          if (active) {
            setTelemetry(result.telemetry);
            setNotice(result.warning);
            setError(null);
          }
        },
        (error_: unknown) => {
          if (active) {
            setError(error_ instanceof Error ? error_.message : "Unable to read inverter data.");
          }
        },
      )
      .finally(() => {
        if (active) {
          setOperation(null);
          busy.current = false;
        }
      });

    return () => {
      active = false;
      busy.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void readTodayOutageSchedule()
      .then(
        (result) => {
          if (active) {
            setSchedule(result);
            setScheduleError(null);
          }
        },
        (error_: unknown) => {
          if (active) {
            setScheduleError(
              error_ instanceof Error ? error_.message : "Today's outage schedule is unavailable.",
            );
          }
        },
      )
      .finally(() => {
        if (active) {
          setScheduleLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = async () => {
    if (busy.current) {
      return;
    }
    setNotice(null);
    const issue = configurationIssue(true);
    if (issue) {
      setError(issue);
      return;
    }

    busy.current = true;
    setOperation("refreshing");
    setError(null);
    const schedulePromise = loadSchedule();

    try {
      const result = await refreshTelemetry();
      setTelemetry(result.telemetry);
      setNotice(result.warning);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "Unable to refresh inverter data.");
    } finally {
      await schedulePromise;
      setOperation(null);
      busy.current = false;
    }
  };

  const refreshIssue = configurationIssue(true);
  const measurementAgeSeconds = telemetry?.freshness.ageSeconds;
  const scheduleView = schedule
    ? describeSchedule(schedule, telemetry?.grid.status === "online")
    : null;
  const showNow = Boolean(scheduleView?.showBar && scheduleView.tone !== "neutral");
  const scheduleStatusClass =
    scheduleView?.tone === "off" ? "offline" : scheduleView?.tone === "on" ? "online" : "neutral";
  const scheduleHeadlineClass =
    scheduleView?.headline === "On" ||
    scheduleView?.headline === "Off" ||
    scheduleView?.headline === "Still on"
      ? ""
      : "unavailable";

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

      <section className="schedule" aria-label="Today's outage schedule">
        <article className="card">
          <div className="card-heading">
            <h2>Outage schedule</h2>
            <span className={`status status-${scheduleStatusClass}`}>
              {schedule ? outageGroupLabel(schedule.group) : "Group 4"}
            </span>
          </div>
          {scheduleLoading && !schedule ? (
            <p className="caption">Loading today&apos;s schedule…</p>
          ) : scheduleError && !schedule ? (
            <p className="detail-note">{scheduleError}</p>
          ) : schedule && scheduleView ? (
            <>
              <p className={`main-value ${scheduleHeadlineClass}`}>{scheduleView.headline}</p>
              <p className="caption">{scheduleView.detail}</p>
              {scheduleError && <p className="detail-note">{scheduleError}</p>}
              {scheduleView.showBar && (
                <ScheduleBar slots={schedule.slots} mark={showNow ? kyivMinuteOfDay() : null} />
              )}
              <p className="freshness-note">
                YASNO · Kyiv time
                {schedule.updatedOn ? ` · updated ${formatTimestamp(schedule.updatedOn)}` : ""}
              </p>
            </>
          ) : null}
        </article>
      </section>

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
