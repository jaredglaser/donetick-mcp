import { Temporal } from "@js-temporal/polyfill";
import { addDays, zonedYmd } from "@/time";

const WEEKDAY_INDEX: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const FORMAT_HELP =
  "Could not parse due date. Accepted formats: an RFC3339 timestamp, YYYY-MM-DD, " +
  '"today", "tomorrow", "yesterday", "in N days", "in N weeks", or a weekday name, ' +
  'optionally prefixed with "next" or "this".';

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_RE = /^in (\d+) (day|days|week|weeks)$/;
const WEEKDAY_RE = /^(?:(next|this) )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/;

/** Ten years, matching the cap list_chores puts on its own day window. */
const MAX_RELATIVE_DAYS = 3650;

/**
 * A bare date or relative phrase carries no time of day, so one is chosen: 09:00 in
 * the target zone. Midnight would make "due tomorrow" read as "in 14 hours" at 10am,
 * which is technically true and useless. 09:00 is a stated household assumption.
 */
export function parseDueDate(input: string, now: Date, tz: string): Date;
export function parseDueDate(input: string | null, now: Date, tz: string): Date | null;
export function parseDueDate(input: string | null, now: Date, tz: string): Date | null {
  if (input === null) return null;
  const trimmed = input.trim();
  // Null is the only way to say "no due date". An empty string used to mean it too,
  // which made the same value mean opposite things in two tools: reschedule_chore
  // read it as a clear, while edit_chore took the parse path, lost the stored date,
  // and let ensureDueDateForRolling substitute today 09:00 on a rolling chore. It
  // also broke the overload's promise, which types a string input as returning Date.
  //
  // Its own message, not FORMAT_HELP. The fall-through below throws FORMAT_HELP for
  // an empty string anyway, so this branch changed nothing and read as though it
  // did; a caller who sent "" meaning "clear it" needs to be told which value does
  // that, not handed a list of date formats none of which is what they wanted.
  if (trimmed === "") {
    throw new Error(
      'An empty due date is not a way to clear one: pass null for "no due date". ' + FORMAT_HELP,
    );
  }

  const instant = tryInstant(trimmed);
  if (instant) return instant;

  if (BARE_DATE_RE.test(trimmed)) {
    return nineAmOn(parsePlainDate(trimmed), tz);
  }

  // Only the RFC3339 and YYYY-MM-DD forms above are case/spacing sensitive
  // ("T"/"Z" and digit grouping carry meaning); the phrases below do not.
  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");

  if (lower === "today") return nineAmAtOffset(now, 0, tz);
  if (lower === "tomorrow") return nineAmAtOffset(now, 1, tz);
  if (lower === "yesterday") return nineAmAtOffset(now, -1, tz);

  const relative = RELATIVE_RE.exec(lower);
  if (relative) {
    const count = Number(relative[1]);
    const days = relative[2]!.startsWith("week") ? count * 7 : count;
    // Bounded, because the regex accepts any run of digits. Past four digits of year
    // toISOString switches to the extended form (+010240-04-26...), which Go's
    // RFC3339 binding rejects with an opaque 400, and far enough out Temporal throws
    // a RangeError that would surface instead of the format help.
    if (days > MAX_RELATIVE_DAYS) {
      throw new Error(
        `"${trimmed}" is too far ahead. Use at most ${MAX_RELATIVE_DAYS} days, or pass an explicit date.`,
      );
    }
    return nineAmAtOffset(now, days, tz);
  }

  const weekday = WEEKDAY_RE.exec(lower);
  if (weekday) {
    const targetDow = WEEKDAY_INDEX[weekday[2]!]!;
    const { y, m, d } = zonedYmd(now, tz);
    const todayDow = Temporal.PlainDate.from({ year: y, month: m, day: d }).dayOfWeek;
    let diff = targetDow - todayDow;
    // Never today: a same-weekday match rolls to next week, for "next", "this", and bare alike.
    if (diff <= 0) diff += 7;
    return nineAmAtOffset(now, diff, tz);
  }

  throw new Error(FORMAT_HELP);
}

/**
 * Whether the caller stated a time of day, or only a date that parseDueDate then
 * resolved to 09:00.
 *
 * complete_chore needs the difference. It clamps a future instant back to now so
 * that a bare "today" before 09:00 is not refused as future for something the user
 * has just done, but clamping an explicit timestamp would silently record a
 * different time than the one asked for.
 */
export function carriesTimeOfDay(input: string): boolean {
  return tryInstant(input.trim()) !== null;
}

function tryInstant(s: string): Date | null {
  try {
    return new Date(Temporal.Instant.from(s).epochMilliseconds);
  } catch {
    return null;
  }
}

function parsePlainDate(s: string): Temporal.PlainDate {
  try {
    return Temporal.PlainDate.from(s);
  } catch {
    throw new Error(FORMAT_HELP);
  }
}

/**
 * Constructs 09:00 on the given calendar date directly, rather than taking a day's
 * start instant and adding a nine-hour duration to it. The two diverge on a day whose
 * local midnight is skipped by a DST start (e.g. America/Santiago): the day's start is
 * already 01:00 there, and from that point the wall clock advances 1:1 with elapsed
 * time, so +9h duration lands at 10:00 local, not the intended 09:00.
 */
function nineAmOn(date: Temporal.PlainDate, tz: string): Date {
  const zdt = date.toZonedDateTime({ timeZone: tz, plainTime: "09:00" });
  return new Date(zdt.epochMilliseconds);
}

function nineAmAtOffset(now: Date, days: number, tz: string): Date {
  const target = addDays(now, days, tz);
  const { y, m, d } = zonedYmd(target, tz);
  return nineAmOn(Temporal.PlainDate.from({ year: y, month: m, day: d }), tz);
}
