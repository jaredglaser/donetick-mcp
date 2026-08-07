import { dueDateOf, humanizeDueIn } from "@/time";
import {
  CHORE_STATUS,
  PRIORITY_LABEL,
  type Member,
  type ProjectedChore,
  type Project,
  type RawChore,
} from "@/types";

export function summarizeFrequency(chore: RawChore): string {
  const meta = chore.frequencyMetadata ?? {};
  switch (chore.frequencyType) {
    case "once":
      return "once";
    case "no_repeat":
      return "does not repeat";
    case "daily":
    case "weekly":
    case "monthly":
    case "yearly":
      return chore.frequencyType;
    case "interval": {
      // Rendered as broken rather than as ordinary. assertSchedulableFrequency
      // refuses these shapes on a write, so describing one as "every 0 days" left
      // the read side saying the chore was fine while every edit refused it.
      const count = chore.frequency;
      if (typeof meta.unit !== "string") return "broken: an interval with no unit";
      if (typeof count !== "number" || count <= 0) {
        return `broken: an interval of ${String(count)} ${meta.unit}`;
      }
      return `every ${count} ${meta.unit}`;
    }
    case "days_of_the_week": {
      const days = meta.days ?? [];
      if (days.length === 0) return "broken: days_of_the_week with no days";
      // week_of_month and week_of_quarter pick one occurrence of the weekday, and
      // every_week does not. Measured against a chore due Thu 2026-09-10: [2]
      // scheduled the 2nd Saturday, [1,3] the next of either, and week_of_quarter [1]
      // the first of the quarter. Rendering only week_of_month described those as
      // "every saturday"; rendering every_week too describes a weekly chore as
      // monthly, which is the same error inverted.
      if (
        meta.occurrences &&
        meta.occurrences.length > 0 &&
        meta.weekPattern &&
        meta.weekPattern !== "every_week"
      ) {
        const period = meta.weekPattern === "week_of_quarter" ? "quarter" : "month";
        return `the ${meta.occurrences.map(ordinal).join(", ")} ${days.join("/")} of every ${period}`;
      }
      return `every ${days.join(", ")}`;
    }
    case "day_of_the_month": {
      // Donetick carries the calendar day in frequency, not in the metadata.
      const day = chore.frequency;
      const months = meta.months ?? [];
      if (months.length === 0) return "broken: day_of_the_month with no months";
      const monthsPart = months.join(", ");
      // Donetick's scheduler refuses anything outside 1 to 31, so a stored 0 is not
      // "the 0th of October", it is a chore no completion can advance.
      if (typeof day !== "number" || day <= 0 || day > 31) {
        return `broken: day_of_the_month with a day of ${String(day)}`;
      }
      return `the ${ordinal(day)} of ${monthsPart}`;
    }
    case "adaptive":
      return "adaptive, learned from history";
    case "trigger":
      return "triggered by a thing";
    default:
      return chore.frequencyType;
  }
}

function ordinal(n: number): string {
  // Donetick's own frontend offers 1st through 4th and "Last", and -1 is how it
  // carries that. Without this, the projection reported "the -1th saturday".
  if (n === -1) return "last";
  const suffix = n % 10 === 1 && n % 100 !== 11
    ? "st"
    : n % 10 === 2 && n % 100 !== 12
      ? "nd"
      : n % 10 === 3 && n % 100 !== 13
        ? "rd"
        : "th";
  return `${n}${suffix}`;
}

export function projectChore(
  chore: RawChore,
  members: Member[],
  projects: Project[],
  now: Date,
): ProjectedChore {
  const dueDate = dueDateOf(chore.nextDueDate);
  const member = members.find((m) => m.userId === chore.assignedTo);
  const project = projects.find((p) => p.id === chore.projectId);
  const lastBy = members.find((m) => m.userId === chore.lastCompletedBy);

  return {
    id: chore.id,
    name: chore.name,
    due_date: chore.nextDueDate,
    due_in: humanizeDueIn(dueDate, now),
    is_overdue: dueDate !== null && dueDate.getTime() < now.getTime(),
    // An id this server cannot name is reported as an unknown member rather than as
    // null, which reads as "nobody is assigned". enrichHistoryRow in tools/index.ts
    // already made that distinction; these two disagreed about the same situation.
    assigned_to:
      chore.assignedTo === null || chore.assignedTo === undefined
        ? null
        : (member?.displayName ?? `member #${chore.assignedTo} (unknown)`),
    description: chore.description ?? null,
    is_private: chore.isPrivate === true,
    assign_strategy: chore.assignStrategy ?? null,
    assignees: (chore.assignees ?? [])
      .map((a) => members.find((m) => m.userId === a.userId)?.displayName ?? `member #${a.userId} (unknown)`),
    points: chore.points ?? null,
    is_rolling: chore.isRolling === true,
    labels: (chore.labelsV2 ?? []).map((label) => label.name),
    priority: PRIORITY_LABEL[chore.priority] ?? String(chore.priority),
    project: project?.name ?? null,
    frequency: summarizeFrequency(chore),
    status: CHORE_STATUS[chore.status] ?? String(chore.status),
    requires_approval: chore.requireApproval === true,
    completion_window: chore.completionWindow ?? null,
    subtasks: (chore.subTasks ?? []).map((sub) => ({
      name: sub.name,
      done: Boolean(sub.completedAt),
    })),
    last_completed_at: chore.lastCompletedDate ?? null,
    last_completed_by:
      chore.lastCompletedBy === null || chore.lastCompletedBy === undefined
        ? null
        : (lastBy?.displayName ?? `member #${chore.lastCompletedBy} (unknown)`),
  };
}
