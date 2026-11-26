import { formatScheduleMinute } from "./outage-schedule";
import type { OutageSlot } from "./outage-schedule";

function labelAlign(center: number): "start" | "center" | "end" {
  if (center < 0.18) {
    return "start";
  }
  if (center > 0.82) {
    return "end";
  }
  return "center";
}

export default function ScheduleBar({
  slots,
  mark,
}: {
  slots: Array<OutageSlot>;
  mark: number | null;
}) {
  const labeled = slots.filter((slot) => slot.kind !== "on");

  return (
    <div className="schedule-track">
      <div className="schedule-bar" aria-hidden="true">
        {slots.map((slot) => (
          <span
            key={`${slot.start}-${slot.end}`}
            className={`schedule-segment schedule-${slot.kind}`}
            style={{
              left: `${(slot.start / 1440) * 100}%`,
              width: `${((slot.end - slot.start) / 1440) * 100}%`,
            }}
          />
        ))}
        {mark !== null && (
          <span className="schedule-now" style={{ left: `${(mark / 1440) * 100}%` }} />
        )}
      </div>
      <div className="schedule-slot-labels">
        <span className="schedule-hours-end is-start">00:00</span>
        <span className="schedule-hours-end is-end">24:00</span>
        {labeled.map((slot) => {
          const center = (slot.start + slot.end) / 2 / 1440;
          return (
            <span
              key={`${slot.start}-${slot.end}`}
              className={`schedule-slot-label schedule-slot-label-${slot.kind} is-${labelAlign(center)}`}
              style={{ left: `${center * 100}%` }}
            >
              {formatScheduleMinute(slot.start)}–{formatScheduleMinute(slot.end)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
