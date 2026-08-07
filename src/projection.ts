import { humanizeDueIn } from "@/time";
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
      const unit = meta.unit ?? "days";
      const count = chore.frequency ?? 1;
      return `every ${count} ${unit}`;
    }
    case "days_of_the_week": {
      const days = meta.days ?? [];
      return days.length > 0 ? `every ${days.join(", ")}` : "on selected days";
    }
    case "day_of_the_month": {
      const months = meta.months ?? [];
      const monthsPart = months.length > 0 ? ` in ${months.join(", ")}` : "";
      if (meta.weekPattern === "week_of_month" && meta.occurrences && meta.occurrences.length > 0) {
        const ordinals = meta.occurrences.map(ordinal).join(", ");
        const days = meta.days ?? [];
        const dayPart = days.length > 0 ? ` ${days.join("/")}` : "";
        return `the ${ordinals}${dayPart} of every month${monthsPart}`;
      }
      return months.length > 0 ? `monthly in ${months.join(", ")}` : "monthly on a set day";
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
  const dueDate = chore.nextDueDate === null ? null : new Date(chore.nextDueDate);
  const member = members.find((m) => m.userId === chore.assignedTo);
  const project = projects.find((p) => p.id === chore.projectId);
  const lastBy = members.find((m) => m.userId === chore.lastCompletedBy);

  return {
    id: chore.id,
    name: chore.name,
    due_date: chore.nextDueDate,
    due_in: humanizeDueIn(dueDate, now),
    is_overdue: dueDate !== null && dueDate.getTime() < now.getTime(),
    assigned_to: member?.displayName ?? null,
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
    last_completed_by: lastBy?.displayName ?? null,
  };
}
