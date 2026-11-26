import type { OutageSlot } from "./outage-schedule";

export default function ScheduleBar({
  slots,
  mark,
}: {
  slots: Array<OutageSlot>;
  mark: number | null;
}) {
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
      <div className="schedule-hours">
        <span>00:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}
