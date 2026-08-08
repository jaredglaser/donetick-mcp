import { Temporal } from "@js-temporal/polyfill";

/**
 * One table, so the tool schema and the bucketing cannot disagree. They did: SCOPES
 * carried a seventh value this type did not, rewritten to "all" at runtime, and
 * bucket's default arm answered anything unrecognized with zero chores rather than
 * an error. A scope that returns nothing reads as "you have none of those".
 */
export const DUE_SCOPES = [
  "all",
  "overdue",
  "due_today",
  "due_this_week",
  "due_within_days",
  "unscheduled",
] as const;

export type Scope = (typeof DUE_SCOPES)[number];

function zoned(instant: Date, tz: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(tz);
}

/**
 * The zone's UTC offset at a given instant, formatted the way RFC3339 wants it.
 *
 * Must be read at the write instant, not at a fixed date. Donetick converts the
 * stored timestamp to UTC and takes its hour and minute from there, so the offset
 * is what decides the wall-clock time the chore fires at. Reading it at the epoch
 * put Asia/Singapore permanently 30 minutes out (+07:30 in 1970, +08:00 now),
 * Pacific/Apia a day out, and every DST zone an hour out for half the year.
 *
 * No single stored value can be right across a DST boundary, which is Donetick's
 * own limitation; the offset in force when the caller sets the time is the reading
 * that matches what they meant.
 */
export function utcOffsetFor(timezone: string, at: Date): string {
  const offset = Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timezone).offset;
  // RFC3339 allows only [+-]HH:MM. Temporal emits seconds for the pre-standard local
  // mean times some zones carried before the 1900s, so a caller reading the offset at
  // an old instant can get -00:44:30, which Go's time.Parse refuses.
  return /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : offset.slice(0, 6);
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

/**
 * A chore's due date as an instant, or null when it has none Donetick can be held to.
 *
 * Shared because it was written three times, in the projection, in list_chores, and
 * in the registry's own filter, and none of the three checked the result. A row whose
 * nextDueDate was absent or unparseable became an Invalid Date, which is not null, so
 * bucket kept it out of `unscheduled`, and every NaN comparison is false, so it fell
 * out of `overdue`, `due_today`, and the rest as well. The chore was reachable only
 * through scope `all`, where it rendered as "in NaN minutes". Keeping the three in
 * agreement is the whole point of DUE_SCOPES being exhaustive.
 */
export function dueDateOf(nextDueDate: unknown): Date | null {
  if (typeof nextDueDate !== "string") return null;
  const parsed = new Date(nextDueDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
    default: {
      // Exhaustive: adding a Scope without a bucket for it is a compile error rather
      // than a listing that silently comes back empty.
      const unhandled: never = scope;
      throw new Error(`bucket has no rule for scope ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Elapsed time, not calendar days, and deliberately unlike everything else here.
 *
 * Measured 2026-08-08: across a spring-forward night a chore due tomorrow at the same
 * wall clock reads "in 23 hours" rather than "in 1 day", and "in 1 day" across a fall
 * back. CLAUDE.md called this DST-safe alongside the day-boundary helpers, which it
 * is not. It stays elapsed because that is what "due in" answers: the question is how
 * long you have, and on a 23-hour day you have 23 hours. startOfDay, addDays and
 * bucket are the calendar-based half, and they are what scope filtering uses.
 */
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
  const minutes = Math.floor(abs / 60_000);
  // Under a minute is "now", not "in 1 minute". Rounding up read as a deadline not
  // yet reached for something already due, and as one minute of grace for something
  // already overdue.
  if (minutes === 0) return "now";
  const unit = minutes === 1 ? "minute" : "minutes";
  return overdue ? `${minutes} ${unit} overdue` : `in ${minutes} ${unit}`;
}
