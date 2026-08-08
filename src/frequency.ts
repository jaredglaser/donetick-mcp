import { utcOffsetFor } from "@/time";

const FREQUENCY_TYPES_TUPLE = [
  "once",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "adaptive",
  "interval",
  "days_of_the_week",
  "day_of_the_month",
  "trigger",
  "no_repeat",
] as const;

export type FrequencyType = (typeof FREQUENCY_TYPES_TUPLE)[number];

export const FREQUENCY_TYPES: readonly FrequencyType[] = FREQUENCY_TYPES_TUPLE;

export const WEEK_PATTERNS = ["every_week", "week_of_month", "week_of_quarter"] as const;

export type WeekPattern = (typeof WEEK_PATTERNS)[number];

/**
 * The highest occurrence Donetick's scheduler can ever match in a period.
 *
 * 14 for a quarter, not 13. Q3 and Q4 are 92 days, which is thirteen weeks and one
 * day, so one weekday gets a fourteenth occurrence every year: measured 2026-08-08 on
 * v0.1.76, days ["wednesday"] with occurrences [14] completes and reschedules to
 * 2026-09-30, the fourteenth Wednesday of Q3 2026. A hard bound of 13 refused that
 * chore on the merge path, which made it uneditable and unreassignable through this
 * server.
 */
export function occurrenceLimitFor(weekPattern: string): number {
  return weekPattern === "week_of_quarter" ? 14 : 5;
}

/**
 * Whether the scheduler can match this stored occurrence.
 *
 * -1 means "the last" in `occurrences` and nothing at all in `weekNumbers`.
 * getOccurrences maps -1 to the string "last" on the Occurrences branch alone
 * (scheduler.go:201-207); the legacy WeekNumbers branch formats with %d, so a stored
 * -1 there becomes "-1", matches none of "1".."5" or "last", and the 730-day walk
 * exhausts into a 500 on every completion. The two arrays were checked as one list,
 * which is how a value that is valid in one and fatal in the other read as fine.
 */
export function isReachableOccurrence(
  value: unknown,
  weekPattern: string,
  field: "occurrences" | "weekNumbers",
): boolean {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  if (value === -1) return field === "occurrences";
  return value >= 1 && value <= occurrenceLimitFor(weekPattern);
}

export type FrequencyUnit = "hours" | "days" | "weeks" | "months" | "years";

export const FREQUENCY_UNITS: readonly FrequencyUnit[] = [
  "hours",
  "days",
  "weeks",
  "months",
  "years",
];

export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/**
 * The types whose scheduler reads frequencyMetadata.time. Every other type stores it
 * and keeps whatever clock time the due date already had, so accepting one there
 * reports a success for a schedule Donetick will not run.
 */
const TIME_AWARE_TYPES: readonly FrequencyType[] = ["interval", "days_of_the_week", "day_of_the_month"];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface FrequencyInput {
  type: FrequencyType;
  every?: number;
  unit?: FrequencyUnit;
  days?: string[];
  months?: string[];
  week_pattern?: WeekPattern;
  occurrences?: number[];
  time?: string;
  /** The calendar day for day_of_the_month, 1 to 31. Donetick carries it in `frequency`. */
  day_of_month?: number;
}

export interface FrequencyMetadata {
  timezone: string;
  unit?: FrequencyUnit;
  days?: string[];
  months?: string[];
  weekPattern?: WeekPattern;
  occurrences?: number[];
  time?: string;
}

export interface FrequencyOutput {
  frequencyType: FrequencyType;
  frequency: number;
  frequencyMetadata: FrequencyMetadata;
}

export function buildFrequency(input: FrequencyInput, timezone: string, now: Date): FrequencyOutput {
  const metadata: FrequencyMetadata = { timezone };
  if (input.time !== undefined) {
    // Donetick rewrites the base date's clock back to the stored time before adding
    // the hours, so the step becomes idempotent whenever the count is not a whole
    // number of days. Measured on v0.1.76 with a time of 13:00Z, three completions
    // each: every 4 hours froze at 17:00Z and stayed there; every 24 and every 48
    // advanced correctly and held 13:00Z exactly; every 30 advanced 24 hours a step
    // rather than 30.
    //
    // Only the counts that are not multiples of 24. An earlier version refused every
    // hourly interval carrying a time, which blocked create, and through the matching
    // arm of assertSchedulableFrequency every edit and reassign, on chores that
    // behave exactly as configured.
    if (input.type === "interval" && (input.unit ?? "days") === "hours") {
      const every = input.every ?? 1;
      if (every % 24 !== 0) {
        throw new Error(
          `An interval of ${every} hours cannot carry a time of day: Donetick resets the clock to ` +
            "that time before adding the hours, so the chore freezes on its second completion and " +
            "stays overdue. Use a count that is a whole number of days (24, 48) if you need the " +
            "time kept, or drop time and put the starting hour on due_date as a full timestamp.",
        );
      }
    }
    if (!TIME_AWARE_TYPES.includes(input.type)) {
      const example = `2026-08-07T${input.time}:00${utcOffsetFor(timezone, now)}`;
      throw new Error(
        `Frequency type "${input.type}" ignores a time of day: Donetick reads it only for ` +
          `${TIME_AWARE_TYPES.join(", ")}. Put the hour on due_date instead, as a full timestamp ` +
          `carrying this circle's offset, for example "${example}". A bare date or a phrase like ` +
          '"tomorrow" resolves to 09:00 local and will not carry the hour you asked for.',
      );
    }
    metadata.time = normalizeTime(input.time, timezone, now);
  }

  switch (input.type) {
    case "once":
    case "no_repeat":
    case "adaptive":
      return { frequencyType: input.type, frequency: 1, frequencyMetadata: metadata };

    case "daily":
    case "weekly":
    case "monthly":
    case "yearly":
      // Donetick stores whatever count is sent here, but its scheduler always steps
      // exactly one unit for these fixed types and never reads the stored count.
      // Sending anything but 1 would leave a value in the database that misleads
      // anyone reading it back. "Every N days/weeks/..." belongs to "interval".
      if (input.type === "weekly" && input.days !== undefined) {
        throw new Error(
          "weekly does not take a days list; use days_of_the_week to pick specific weekdays",
        );
      }
      return { frequencyType: input.type, frequency: 1, frequencyMetadata: metadata };

    case "interval": {
      const every = requireCount(input.every, "every");
      const unit = input.unit ?? "days";
      if (!FREQUENCY_UNITS.includes(unit)) {
        throw new Error(`Unknown unit "${unit}". Expected one of: ${FREQUENCY_UNITS.join(", ")}`);
      }
      metadata.unit = unit;
      return { frequencyType: "interval", frequency: every, frequencyMetadata: metadata };
    }

    // weekPattern and occurrences belong here, not on day_of_the_month. Measured on
    // v0.1.76 against a chore due Thu 2026-09-10: plain gave the next Saturday
    // (Sep 12), occurrences [1] gave the first Saturday of the following month
    // (Oct 3), occurrences [-1] gave the last Saturday of the current one (Sep 26).
    // "First Saturday of every month" is this type, not day_of_the_month.
    case "days_of_the_week": {
      metadata.days = requireDays(input.days);
      if (input.week_pattern !== undefined) {
        if (!WEEK_PATTERNS.includes(input.week_pattern)) {
          throw new Error(
            `Unknown week_pattern "${input.week_pattern}". Expected one of: ${WEEK_PATTERNS.join(", ")}`,
          );
        }
        metadata.weekPattern = input.week_pattern;
      }
      if (input.week_pattern === "every_week" && input.occurrences !== undefined) {
        throw new Error(
          'week_pattern "every_week" means every matching weekday, so occurrences has nothing to ' +
            'pick from and Donetick ignores it. Use week_of_month or week_of_quarter, or drop ' +
            "occurrences.",
        );
      }
      if (input.week_pattern !== undefined && input.week_pattern !== "every_week") {
        // Measured: week_of_month with no occurrences answers 500 on every
        // completion. Donetick's scheduler requires at least one, and the chore is
        // created happily first, so this is the same never-completable shape as
        // day_of_the_month with no months.
        if (input.occurrences === undefined || input.occurrences.length === 0) {
          throw new Error(
            `week_pattern "${input.week_pattern}" needs occurrences. Donetick cannot schedule ` +
              "without them and answers 500 on every completion. Pass occurrences: [1] for the " +
              "first of each period, or [-1] for the last.",
          );
        }
        // Deliberately one below occurrenceLimitFor on a quarter, and this is the one
        // place the two sides differ on purpose. A quarter's fourteenth occurrence
        // exists only in Q3 and Q4 and only for the weekday the quarter starts on, so
        // a new chore asking for it schedules for some weekdays and answers 500 on
        // every completion for the rest, and which is which moves with the calendar
        // year. frequencyHealth allows a stored 14 because refusing one blocks every
        // whole-chore rewrite on a chore that may well be working; refusing it here
        // costs a caller nothing but a different number.
        const OCCURRENCE_LIMIT = input.week_pattern === "week_of_quarter" ? 13 : 5;
        const bad = input.occurrences.filter(
          (n) => !Number.isInteger(n) || (n !== -1 && (n < 1 || n > OCCURRENCE_LIMIT)),
        );
        if (bad.length > 0) {
          throw new Error(
            `${JSON.stringify(bad)} is not a valid occurrence for ${input.week_pattern}. Use -1 for the last, or 1 through ${OCCURRENCE_LIMIT}.` +
              (input.week_pattern === "week_of_quarter"
                ? " A quarter can hold a 14th of one weekday, but only in Q3 and Q4 and only for the weekday that quarter starts on, so it is not a schedule to choose."
                : ""),
          );
        }
      }
      if (input.occurrences !== undefined) {
        // Measured on v0.1.76: occurrences with no week_pattern is ignored outright.
        // A chore due Thu 2026-09-10 with occurrences [-1] and no pattern scheduled
        // Sat Sep 12, the plain next Saturday, not the last of the month. Accepting
        // it would build a schedule the caller did not ask for and report success.
        if (input.week_pattern === undefined) {
          throw new Error(
            'occurrences needs week_pattern. Donetick ignores it otherwise and falls back to every ' +
              'matching weekday. For "the first saturday of every month" pass week_pattern: ' +
              '"week_of_month" with occurrences: [1]; -1 is the last.',
          );
        }
        metadata.occurrences = input.occurrences;
      }
      return { frequencyType: "days_of_the_week", frequency: 1, frequencyMetadata: metadata };
    }

    // A calendar day number in named months, not a weekday. Donetick reads the
    // frequency field as the day and requires months to be non-empty; measured on
    // v0.1.76, frequency 15 with months ["october"] scheduled the 15th, and omitting
    // months made every completion answer 500 with the chore left unschedulable.
    case "day_of_the_month": {
      if (input.days !== undefined) {
        throw new Error(
          'day_of_the_month schedules a calendar day number, not a weekday. For "the first ' +
            'saturday of every month" use type days_of_the_week with days: ["saturday"], ' +
            'week_pattern: "week_of_month" and occurrences: [1].',
        );
      }
      const dayOfMonth = input.day_of_month;
      if (typeof dayOfMonth !== "number" || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        throw new Error(
          `day_of_the_month needs "day_of_month" as a whole number from 1 to 31, got ${JSON.stringify(dayOfMonth)}.`,
        );
      }
      if (input.months === undefined || input.months.length === 0) {
        throw new Error(
          'day_of_the_month needs "months". Donetick cannot schedule one without it, and the ' +
            "chore would be created and then fail every completion. List every month it should " +
            "run in, or use type monthly for every month.",
        );
      }
      metadata.months = normalizeNames(input.months, MONTHS, "month");
      return { frequencyType: "day_of_the_month", frequency: dayOfMonth, frequencyMetadata: metadata };
    }

    case "trigger":
      throw new Error(
        "trigger recurrence depends on Donetick Things, which this server does not manage. " +
          "Create a trigger-based chore in the Donetick web UI instead.",
      );

    default: {
      const exhaustive: never = input.type;
      throw new Error(`Unsupported frequency type "${exhaustive as string}"`);
    }
  }
}

function requireCount(value: number | undefined, field: string): number {
  if (value === undefined) {
    throw new Error(`"${field}" is required for this frequency type`);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`"${field}" must be a positive whole number, got ${value}`);
  }
  return value;
}

function requireDays(days: string[] | undefined): string[] {
  if (!days || days.length === 0) {
    throw new Error('"days" must be a non-empty list of weekday names');
  }
  return normalizeNames(days, WEEKDAYS, "day");
}

function normalizeNames(
  values: string[],
  allowed: readonly string[],
  label: "day" | "month",
): string[] {
  return values.map((value) => {
    const lower = value.toLowerCase();
    if (!allowed.includes(lower)) {
      throw new Error(`Unknown ${label} name "${value}". Expected one of: ${allowed.join(", ")}`);
    }
    return lower;
  });
}

/**
 * Callers give HH:MM; Donetick wants a full RFC3339 instant.
 *
 * Verified live on v0.1.76: the binding is datetime=2006-01-02T15:04:05Z07:00 and
 * the scheduler parses with time.RFC3339, so "09:00" is a 400 on every create and
 * edit that supplies one. Every value the old HH:MM check accepted was a value
 * Donetick refused, which made the option unusable rather than merely wrong.
 *
 * The date is a placeholder: the scheduler reads only hour, minute and second. The
 * offset has to be the chore's zone as of now, since Donetick reads the clock parts
 * after converting to UTC, so the offset is what fixes the local firing time.
 */
function normalizeTime(time: string, timezone: string, now: Date): string {
  const match = TIME_RE.exec(time);
  if (!match) {
    throw new Error(`"time" must be in HH:MM 24-hour format, got "${time}"`);
  }
  const offset = utcOffsetFor(timezone, now);
  return `1970-01-01T${match[1]}:${match[2]}:00${offset}`;
}

