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

export type FrequencyUnit = "hours" | "days" | "weeks" | "months" | "years";

const FREQUENCY_UNITS: readonly FrequencyUnit[] = ["hours", "days", "weeks", "months", "years"];

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const MONTHS = [
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

    case "days_of_the_week": {
      metadata.days = requireDays(input.days);
      return { frequencyType: "days_of_the_week", frequency: 1, frequencyMetadata: metadata };
    }

    case "day_of_the_month": {
      metadata.days = requireDays(input.days);
      if (input.months !== undefined) {
        metadata.months = normalizeNames(input.months, MONTHS, "month");
      }
      if (input.week_pattern !== undefined) {
        if (!WEEK_PATTERNS.includes(input.week_pattern)) {
          throw new Error(
            `Unknown week_pattern "${input.week_pattern}". Expected one of: ${WEEK_PATTERNS.join(", ")}`,
          );
        }
        metadata.weekPattern = input.week_pattern;
      }
      if (input.occurrences !== undefined) {
        metadata.occurrences = input.occurrences;
      }
      return { frequencyType: "day_of_the_month", frequency: 1, frequencyMetadata: metadata };
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

