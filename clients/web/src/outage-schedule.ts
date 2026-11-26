/** Kyiv city group 4, published by YASNO as 4.1. */
export const KYIV_OUTAGE_GROUP = "4.1";

export const OUTAGE_SCHEDULE_PATH = "/api/v1/outage-schedule";

export type OutageStatus = "scheduled" | "waiting" | "emergency" | "none" | "unknown" | "missing";

export interface OutageSlot {
  start: number;
  end: number;
  kind: "on" | "off" | "maybe";
}

export interface TodayOutageSchedule {
  group: string;
  date: string | null;
  status: OutageStatus;
  slots: Array<OutageSlot>;
  updatedOn: string | null;
}

export interface ScheduleView {
  headline: string;
  detail: string;
  tone: "on" | "off" | "neutral" | "emergency";
  showBar: boolean;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// External JSON starts unknown; the guards below validate every consumed field.
// oxlint-disable-next-line quality/no-unsafe-dictionary-type
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMinute(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1440;
}

function slotKind(type: string): OutageSlot["kind"] {
  if (type === "Definite") {
    return "off";
  }
  if (type === "NotPlanned") {
    return "on";
  }
  return "maybe";
}

function parseSlots(value: unknown): Array<OutageSlot> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const slots: Array<OutageSlot> = [];
  for (const item of value) {
    if (!isRecord(item) || !isMinute(item.start) || !isMinute(item.end) || item.start >= item.end) {
      return null;
    }
    if (typeof item.type !== "string" || item.type.length === 0) {
      return null;
    }
    slots.push({ start: item.start, end: item.end, kind: slotKind(item.type) });
  }
  slots.sort((left, right) => left.start - right.start);
  for (let index = 1; index < slots.length; index += 1) {
    if (slots[index].start < slots[index - 1].end) {
      return null;
    }
  }
  return slots;
}

function parseStatus(status: unknown): OutageStatus | null {
  if (status === "ScheduleApplies") {
    return "scheduled";
  }
  if (status === "WaitingForSchedule") {
    return "waiting";
  }
  if (status === "EmergencyShutdowns") {
    return "emergency";
  }
  if (status === "NoOutages") {
    return "none";
  }
  if (typeof status === "string") {
    return "unknown";
  }
  return null;
}

export function parseTodayOutageSchedule(
  payload: unknown,
  group = KYIV_OUTAGE_GROUP,
): TodayOutageSchedule | null {
  if (!isRecord(payload)) {
    return null;
  }
  const entry = payload[group];
  if (!isRecord(entry)) {
    return {
      group,
      date: null,
      status: "missing",
      slots: [],
      updatedOn: null,
    };
  }
  if (
    entry.updatedOn !== undefined &&
    entry.updatedOn !== null &&
    typeof entry.updatedOn !== "string"
  ) {
    return null;
  }
  const updatedOn = typeof entry.updatedOn === "string" ? entry.updatedOn : null;
  if (!isRecord(entry.today)) {
    return { group, date: null, status: "unknown", slots: [], updatedOn };
  }

  const dateMatch =
    typeof entry.today.date === "string" ? DATE_PREFIX.exec(entry.today.date) : null;
  if (!dateMatch) {
    return null;
  }
  const status = parseStatus(entry.today.status);
  if (!status) {
    return null;
  }
  if (status !== "scheduled") {
    return { group, date: dateMatch[1], status, slots: [], updatedOn };
  }
  const slots = parseSlots(entry.today.slots);
  if (!slots) {
    return null;
  }
  return { group, date: dateMatch[1], status, slots, updatedOn };
}

export function formatScheduleMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function outageGroupLabel(group: string): string {
  const match = /^(\d+)\.1$/.exec(group);
  return match ? `Group ${match[1]}` : `Group ${group}`;
}

export function kyivDateISO(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function kyivMinuteOfDay(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return 0;
  }
  return ((hour === 24 ? 0 : hour) * 60 + minute) % 1440;
}

function slotAt(slots: Array<OutageSlot>, minute: number): OutageSlot | null {
  return slots.find((slot) => minute >= slot.start && minute < slot.end) ?? null;
}

export function describeSchedule(schedule: TodayOutageSchedule, now = new Date()): ScheduleView {
  if (schedule.status === "missing") {
    return {
      headline: "Unavailable",
      detail: `${outageGroupLabel(schedule.group)} is not in the YASNO schedule.`,
      tone: "neutral",
      showBar: false,
    };
  }
  if (schedule.status === "waiting") {
    return {
      headline: "Not published",
      detail: "Today's schedule is not available yet.",
      tone: "neutral",
      showBar: false,
    };
  }
  if (schedule.status === "emergency") {
    return {
      headline: "Emergency",
      detail: "The hourly schedule does not apply.",
      tone: "emergency",
      showBar: false,
    };
  }
  if (schedule.status === "none") {
    return {
      headline: "No outages",
      detail: "No outages are planned today.",
      tone: "on",
      showBar: false,
    };
  }
  if (schedule.status !== "scheduled" || !schedule.date) {
    return {
      headline: "Unavailable",
      detail: "Today's schedule could not be read.",
      tone: "neutral",
      showBar: false,
    };
  }

  const off = schedule.slots.filter((slot) => slot.kind === "off");
  if (schedule.date !== kyivDateISO(now)) {
    return {
      headline: off.length === 0 ? "No outages" : "Scheduled",
      detail: "The published day is not today in Kyiv.",
      tone: "neutral",
      showBar: true,
    };
  }

  const current = slotAt(schedule.slots, kyivMinuteOfDay(now));
  const nextOff = off.find((slot) => slot.start > kyivMinuteOfDay(now));
  if (current?.kind === "off") {
    return {
      headline: "Off",
      detail: `Until ${formatScheduleMinute(current.end)}`,
      tone: "off",
      showBar: true,
    };
  }
  if (current?.kind === "maybe") {
    return {
      headline: "Possible",
      detail: `Possible outage until ${formatScheduleMinute(current.end)}`,
      tone: "neutral",
      showBar: true,
    };
  }
  if (!current) {
    return {
      headline: "Unknown",
      detail: "This part of the day is not in the schedule.",
      tone: "neutral",
      showBar: true,
    };
  }
  return {
    headline: "On",
    detail: nextOff
      ? `Outage at ${formatScheduleMinute(nextOff.start)}`
      : "No further outages today",
    tone: "on",
    showBar: true,
  };
}

export async function readTodayOutageSchedule(): Promise<TodayOutageSchedule> {
  let response: Response;
  try {
    response = await fetch(OUTAGE_SCHEDULE_PATH, { cache: "no-store" });
  } catch {
    throw new Error("Could not load today's outage schedule.");
  }
  if (!response.ok) {
    throw new Error("Today's outage schedule is unavailable.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Today's outage schedule is unreadable.");
  }
  const schedule = parseTodayOutageSchedule(payload);
  if (!schedule) {
    throw new Error("Today's outage schedule is invalid.");
  }
  return schedule;
}
