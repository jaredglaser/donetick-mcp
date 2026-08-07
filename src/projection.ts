import { dueDateOf, humanizeDueIn } from "@/time";
import { frequencyHealth } from "@/frequency-health";
import {
  CHORE_STATUS,
  PRIORITY_LABEL,
  type Member,
  type ProjectedChore,
  type Project,
  type RawChore,
} from "@/types";

export function summarizeFrequency(chore: RawChore): string {
  // The same predicate the write side refuses on, so the two cannot describe one
  // chore differently. They used to enumerate these shapes independently and
  // disagreed three times, each caught a round apart.
  const health = frequencyHealth(chore);
  if (!health.ok) return `broken: ${health.detail}`;

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
    case "interval":
      return `every ${chore.frequency} ${String(meta.unit)}`;
    case "days_of_the_week": {
      const days = meta.days ?? [];
      // week_of_month and week_of_quarter pick one occurrence of the weekday, and
      // every_week does not. Measured against a chore due Thu 2026-09-10: [2]
      // scheduled the 2nd Saturday, [1,3] the next of either, and week_of_quarter [1]
      // the first of the quarter. Rendering only week_of_month described those as
      // "every saturday"; rendering every_week too describes a weekly chore as
      // monthly, which is the same error inverted.
      const picksAnOccurrence =
        meta.weekPattern === "week_of_month" || meta.weekPattern === "week_of_quarter";
      // Either field, matching Donetick's getOccurrences. Reading only `occurrences`
      // described a chore stored with the deprecated `weekNumbers` as weekly when it
      // is monthly.
      const occurrences =
        meta.occurrences && meta.occurrences.length > 0 ? meta.occurrences : (meta.weekNumbers ?? undefined);

      if (picksAnOccurrence && occurrences !== undefined && occurrences.length > 0) {
        const period = meta.weekPattern === "week_of_quarter" ? "quarter" : "month";
        return `the ${occurrences.map(ordinal).join(", ")} ${days.join("/")} of every ${period}`;
      }
      return `every ${days.join(", ")}`;
    }
    case "day_of_the_month": {
      // Donetick carries the calendar day in frequency, not in the metadata.
      // Donetick carries the calendar day in frequency, not in the metadata.
      return `the ${ordinal(chore.frequency as number)} of ${(meta.months ?? []).join(", ")}`;
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

/**
 * Reminder offsets are carried on the wire as signed values, because Donetick adds
 * them to the due date: negative is before, positive is an overdue nag after, zero is
 * at the due date. The direction is rendered rather than dropped, and the four flags
 * come with it, so a chore with notifications genuinely configured is distinguishable
 * from one holding the metadata-less shape that any edit silently switches off.
 */
function summarizeNotifications(chore: RawChore): ProjectedChore["notifications"] {
  const raw = chore.notificationMetadata?.templates;
  const templates: Array<{ value: number; unit: string }> = Array.isArray(raw)
    ? raw.filter(
        (t): t is { value: number; unit: string } =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as { value?: unknown }).value === "number" &&
          typeof (t as { unit?: unknown }).unit === "string",
      )
    : [];
  const meta = chore.notificationMetadata ?? {};
  const flagged = (key: string): boolean => meta[key] === true;

  return {
    enabled: chore.notification === true,
    // The sign is the whole meaning: Donetick adds the value to the due date, so
    // negative is a reminder before, positive is an overdue nag after, and 0 is at
    // the due date. Rendering Math.abs erased exactly the distinction this server
    // negates offsets to get right, so an overdue nag set in the web UI read back as
    // a reminder half an hour early.
    reminders: templates.map((t) => {
      if (t.value === 0) return `at the due date`;
      return `${Math.abs(t.value)}${t.unit} ${t.value < 0 ? "before" : "after"}`;
    }),
    // Without these a due-date-only notification read as "enabled, nothing
    // configured", identical to the metadata-less shape an edit silently switches
    // off. The two need to be tellable apart, since that is what this exists for.
    on_due_date: flagged("dueDate"),
    before_due: flagged("predue"),
    when_overdue: flagged("nagging"),
    on_completion: flagged("completion"),
  };
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
    notifications: summarizeNotifications(chore),
    last_completed_at: chore.lastCompletedDate ?? null,
    last_completed_by:
      chore.lastCompletedBy === null || chore.lastCompletedBy === undefined
        ? null
        : (lastBy?.displayName ?? `member #${chore.lastCompletedBy} (unknown)`),
  };
}
