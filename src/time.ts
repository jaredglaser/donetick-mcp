import { Temporal } from "@js-temporal/polyfill";

export type Scope =
  | "all"
  | "overdue"
  | "due_today"
  | "due_this_week"
  | "due_within_days"
  | "unscheduled";

function zoned(instant: Date, tz: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(tz);
}

/**
 * The zone's UTC offset, formatted the way RFC3339 wants it. Read at the epoch
 * rather than at a real instant on purpose: the only caller stamps a placeholder
 * date whose offset must match the one it writes.
 */
export function utcOffsetFor(timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timezone).offset;
}

/** A zone Temporal and Intl both recognize. Anything else throws at use time. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedYmd(instant: Date, tz: string): { y: number; m: number; d: number } {
  const z = zoned(instant, tz);
  return { y: z.year, m: z.month, d: z.day };
}

/** Calendar arithmetic, never fixed durations: some dates have no midnight and some days are not 24 hours long. */
export function startOfDay(instant: Date, tz: string): Date {
  return new Date(zoned(instant, tz).startOfDay().epochMilliseconds);
}

/**
 * Start of the day n calendar days away. The trailing startOfDay is load-bearing:
 * Temporal's add preserves wall-clock time, so adding a day to a date whose own
 * midnight was skipped by a DST start carries that 01:00 forward onto a day that
 * does have a midnight. Callers use this as an exclusive day boundary.
 */
export function addDays(instant: Date, n: number, tz: string): Date {
  return new Date(zoned(instant, tz).startOfDay().add({ days: n }).startOfDay().epochMilliseconds);
}

export function bucket(
  dueDate: Date | null,
  scope: Scope,
  now: Date,
  tz: string,
  withinDays = 7,
): boolean {
  if (scope === "all") return true;
  if (dueDate === null) return scope === "unscheduled";
  if (scope === "unscheduled") return false;

  const todayStart = startOfDay(now, tz);
  const tomorrowStart = addDays(now, 1, tz);

  switch (scope) {
    case "overdue":
      return dueDate.getTime() < now.getTime();
    case "due_today":
      return dueDate.getTime() >= todayStart.getTime() && dueDate.getTime() < tomorrowStart.getTime();
    case "due_this_week":
      return dueDate.getTime() >= todayStart.getTime() && dueDate.getTime() < addDays(now, 7, tz).getTime();
    case "due_within_days":
      return (
        dueDate.getTime() >= todayStart.getTime() &&
        dueDate.getTime() < addDays(now, withinDays, tz).getTime()
      );
    default:
      return false;
  }
}

export function humanizeDueIn(dueDate: Date | null, now: Date): string {
  if (dueDate === null) return "no due date";

  const deltaMs = dueDate.getTime() - now.getTime();
  const overdue = deltaMs < 0;
  const abs = Math.abs(deltaMs);

  const hours = Math.floor(abs / 3_600_000);
  const days = Math.floor(hours / 24);

  if (days >= 1) {
    const unit = days === 1 ? "day" : "days";
    return overdue ? `${days} ${unit} overdue` : `in ${days} ${unit}`;
  }
  if (hours >= 1) {
    const unit = hours === 1 ? "hour" : "hours";
    return overdue ? `${hours} ${unit} overdue` : `in ${hours} ${unit}`;
  }
  const minutes = Math.max(1, Math.floor(abs / 60_000));
  const unit = minutes === 1 ? "minute" : "minutes";
  return overdue ? `${minutes} ${unit} overdue` : `in ${minutes} ${unit}`;
}
