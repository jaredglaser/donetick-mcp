import { MONTHS, WEEKDAYS, isReachableOccurrence, occurrenceLimitFor } from "@/frequency";
import type { RawChore } from "@/types";

/**
 * Whether Donetick's scheduler can advance a stored recurrence, and if not, what to
 * say about it.
 *
 * summarizeFrequency and assertSchedulableFrequency both call this. Do not add a
 * second enumeration: the description a reader gets and the refusal a writer gets
 * have to be one decision.
 *
 * Every shape below is accepted by Donetick's request binding. Its own
 * validateFrequencyLogic would reject four of them and is dead code, so the failure
 * arrives later, from the scheduler, on the first completion.
 */
export type FrequencyHealth =
  | { ok: true }
  | {
      ok: false;
      /** What is wrong, phrased to follow "it is" or "this chore is". */
      detail: string;
      /** What to pass through edit_chore to fix it. */
      repair: string;
    };

const broken = (detail: string, repair: string): FrequencyHealth => ({ ok: false, detail, repair });

/**
 * The names the scheduler will not match, from the same lists frequency.ts checks
 * input against.
 *
 * Case-insensitively, because Donetick is: the weekday arms lower both sides before
 * comparing and the month arm uses strings.EqualFold, so a stored "Saturday" runs
 * exactly as "saturday" does. A case-sensitive check here would refuse a chore that
 * works, and every tool that rewrites a whole chore goes through this predicate.
 */
function unknownNames(values: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(values)) return [];
  return (values as unknown[])
    .filter((value) => typeof value !== "string" || !allowed.includes(value.toLowerCase()))
    .map((value) => JSON.stringify(value) ?? String(value));
}

export function frequencyHealth(chore: RawChore): FrequencyHealth {
  const meta = chore.frequencyMetadata ?? {};
  const count = chore.frequency;
  const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

  if (chore.frequencyType === "interval") {
    // Not a 500 like the rest. scheduleNextDueDate dereferences Unit without a nil
    // check, and the router is built with gin.New() and no Recovery, so the panic
    // drops the connection and arrives as a 502.
    if (typeof meta.unit !== "string") {
      return broken(
        "an interval with no unit, which crashes the request rather than failing it",
        'Pass frequency: {type: "interval", every: N, unit: "days"}.',
      );
    }

    // Only counts that are not a whole number of days. Donetick rewrites the base
    // date's clock to the stored time before adding the hours, so the step is
    // idempotent unless the count divides evenly into a day. Measured with a time of
    // 13:00Z: every 4 hours froze at 17:00Z, every 24 and every 48 advanced correctly
    // and held 13:00Z, every 30 advanced 24 hours a step.
    if (
      meta.unit === "hours" &&
      typeof meta.time === "string" &&
      meta.time.length > 0 &&
      (typeof count !== "number" || count % 24 !== 0)
    ) {
      return broken(
        `an interval of ${String(count)} hours carrying a time of day, which freezes on its second completion`,
        'Drop the time, or use a count that is a whole number of days: frequency: {type: "interval", every: 24, unit: "hours", time: "09:00"}.',
      );
    }

    // Accepted and not schedulable in any useful sense: 0 completes without moving
    // the due date, and a negative count moves it backwards.
    if (typeof count !== "number" || count <= 0) {
      return broken(
        `an interval of ${String(count)} ${meta.unit}`,
        'Pass frequency: {type: "interval", every: N, unit: "days"} with a positive count.',
      );
    }

    return { ok: true };
  }

  if (chore.frequencyType === "days_of_the_week") {
    if (!nonEmpty(meta.days)) {
      return broken(
        "days_of_the_week with no days",
        'Pass frequency: {type: "days_of_the_week", days: ["monday"]}.',
      );
    }

    // The scheduler walks forward comparing each date's weekday name against this
    // list. A name it never matches exhausts the walk and returns an error, so the
    // chore answers 500 on every completion. Both arms behave this way: the plain one
    // gives up after 7 days, the occurrence one after 730.
    const badDays = unknownNames(meta.days, WEEKDAYS);
    if (badDays.length > 0) {
      return broken(
        `days_of_the_week listing ${badDays.join(", ")}, which is not a weekday its scheduler can match`,
        `Pass frequency: {type: "days_of_the_week", days: ["saturday"]}, using names from: ${WEEKDAYS.join(", ")}.`,
      );
    }

    const picksAnOccurrence =
      meta.weekPattern === "week_of_month" || meta.weekPattern === "week_of_quarter";
    // getOccurrences reads either field, so either one satisfies it.
    if (picksAnOccurrence && !nonEmpty(meta.occurrences) && !nonEmpty(meta.weekNumbers)) {
      return broken(
        `a ${meta.weekPattern} pattern with no occurrences`,
        `Pass frequency: {type: "days_of_the_week", days: ["saturday"], week_pattern: "${meta.weekPattern}", occurrences: [1]}.`,
      );
    }

    // Per array, not over the two concatenated. -1 is "the last" in `occurrences` and
    // matches nothing in the legacy `weekNumbers`, so merging them into one list made
    // a row that 500s on every completion read as healthy, and the projection then
    // described it as "the last monday of every month".
    if (picksAnOccurrence) {
      const pattern = String(meta.weekPattern);
      const unreachable = (["occurrences", "weekNumbers"] as const).flatMap((field) =>
        (meta[field] ?? [])
          .filter((n) => !isReachableOccurrence(n, pattern, field))
          .map((n) => `${JSON.stringify(n)} in ${field}`),
      );
      if (unreachable.length > 0) {
        return broken(
          `a ${pattern} pattern with ${unreachable.join(", ")}, which its scheduler never matches (1 to ${occurrenceLimitFor(pattern)}, or -1 for the last in occurrences)`,
          `Pass frequency: {type: "days_of_the_week", days: ["saturday"], week_pattern: "${pattern}", occurrences: [1]}, or -1 for the last.`,
        );
      }
    }

    return { ok: true };
  }

  if (chore.frequencyType === "day_of_the_month") {
    // Months only. Donetick's scheduler ignores `days` for this type entirely, and a
    // row carrying weekday names alongside months completes and reschedules
    // correctly, so refusing those blocked editing on working chores.
    if (!nonEmpty(meta.months)) {
      return broken(
        "day_of_the_month with no months",
        'Pass frequency: {type: "day_of_the_month", day_of_month: N, months: [...]}, or {type: "days_of_the_week", days: ["saturday"], week_pattern: "week_of_month", occurrences: [1]} if what you meant was the first saturday of every month.',
      );
    }

    const badMonths = unknownNames(meta.months, MONTHS);
    if (badMonths.length > 0) {
      return broken(
        `day_of_the_month listing ${badMonths.join(", ")}, which is not a month its scheduler can match`,
        `Pass frequency: {type: "day_of_the_month", day_of_month: N, months: [...]}, using names from: ${MONTHS.join(", ")}.`,
      );
    }

    // The day lives in `frequency`, not the metadata, and the scheduler refuses
    // anything outside 1 to 31. 0 matters because the carry-forward sends
    // `existing.frequency ?? 1` and 0 is not nullish.
    if (typeof count !== "number" || count <= 0 || count > 31) {
      return broken(
        `day_of_the_month with a day of ${String(count)}, outside the 1 to 31 Donetick accepts`,
        'Pass frequency: {type: "day_of_the_month", day_of_month: N, months: [...]} with a day in range.',
      );
    }

    return { ok: true };
  }

  return { ok: true };
}
