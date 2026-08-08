import { MONTHS, WEEKDAYS } from "@/frequency";
import type { RawChore } from "@/types";

/**
 * Whether Donetick's scheduler can advance a stored recurrence, and if not, what to
 * say about it.
 *
 * One predicate, because there were two. src/projection.ts described a recurrence to
 * the caller and src/chore-request.ts refused to carry one forward, and they
 * enumerated the same seven shapes independently. They disagreed three separate
 * times, each caught a round apart: an interval count of 0 was described as "every 0
 * days" while every edit refused it; an hourly interval with a time read as "every 4
 * hours" while every edit refused it; and a day_of_the_month row carrying weekday
 * names was refused by every edit while the projection correctly called it fine. Each
 * time the fix was to edit the other copy into agreement, and nobody deleted the
 * second copy. PRIORITY_VALUE in types.ts already argues this case: a hand-maintained
 * second copy is the worst place for a transcription slip, because every value still
 * looks plausible.
 *
 * Every shape below is measured against a live v0.1.76 container, and every one of
 * them is accepted by Donetick's request binding. Its own validateFrequencyLogic
 * would reject four of them, but that validator is dead code: its registration is
 * commented out, so the failure only appears later, from the scheduler, on the first
 * completion.
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

    // The stored side of the bound frequency.ts enforces on input. Checked here too
    // because this server wrote rows with an occurrence of 14 before that bound was
    // corrected, and nothing else notices them: measured, a week_of_quarter chore
    // with [14] answers 500 on every completion for monday, tuesday, saturday and
    // sunday, and the split moves with the calendar year, so the three that work
    // today are not safe either.
    if (picksAnOccurrence) {
      const stored = [...(meta.occurrences ?? []), ...(meta.weekNumbers ?? [])];
      const limit = meta.weekPattern === "week_of_quarter" ? 13 : 5;
      const outOfRange = stored.filter((n) => typeof n === "number" && n !== -1 && (n < 1 || n > limit));
      if (outOfRange.length > 0) {
        return broken(
          `a ${meta.weekPattern} pattern with an occurrence of ${outOfRange.join(", ")}, outside the 1 to ${limit} its scheduler can reach`,
          `Pass frequency: {type: "days_of_the_week", days: ["saturday"], week_pattern: "${meta.weekPattern}", occurrences: [1]}, or -1 for the last.`,
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
