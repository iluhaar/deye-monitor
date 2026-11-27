import { useEffect } from "react";
import { formatTimestamp, scheduleBadgeClass } from "./helper";
import ScheduleBar from "./ScheduleBar";
import { describeSchedule, kyivMinuteOfDay, outageGroupLabel } from "./outage-schedule";
import { useOutageSchedule } from "./useOutageSchedule";

export type ScheduleReload = () => Promise<void>;

export default function Schedule({
  gridOnline,
  reloadRef,
}: {
  gridOnline: boolean;
  reloadRef: { current: ScheduleReload | null };
}) {
  const { schedule, error, loading, reload } = useOutageSchedule();
  const scheduleView = schedule ? describeSchedule(schedule, gridOnline) : null;
  const showNow = Boolean(scheduleView?.showBar && scheduleView.tone !== "neutral");
  const scheduleStatusClass = scheduleBadgeClass(scheduleView?.headline);
  const scheduleHeadlineClass =
    scheduleView?.headline === "On" ||
    scheduleView?.headline === "Off" ||
    scheduleView?.headline === "Power on"
      ? ""
      : "unavailable";

  useEffect(() => {
    reloadRef.current = reload;
    return () => {
      reloadRef.current = null;
    };
  }, [reload, reloadRef]);

  return (
    <section className="schedule" aria-label="Today's outage schedule">
      <article className="card">
        <div className="card-heading">
          <h2>Outage schedule</h2>
          <span className={`status status-${scheduleStatusClass}`}>
            {schedule ? outageGroupLabel(schedule.group) : "Group 4"}
          </span>
        </div>
        {loading && !schedule ? (
          <p className="caption">Loading today&apos;s schedule…</p>
        ) : error && !schedule ? (
          <p className="detail-note">{error}</p>
        ) : schedule && scheduleView ? (
          <>
            <p className={`main-value ${scheduleHeadlineClass}`}>{scheduleView.headline}</p>
            <p className="caption">{scheduleView.detail}</p>
            {error && <p className="detail-note">{error}</p>}
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
  );
}
