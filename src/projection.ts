import { dueDateOf, humanizeDueIn } from "@/time";
import { frequencyHealth } from "@/frequency-health";
import {
  CHORE_STATUS,
  isArchivedChore,
  PRIORITY_LABEL,
  type Member,
  type ProjectedChore,
  type Project,
  type RawChore,
} from "@/types";

export function summarizeFrequency(chore: RawChore): string {
  // The same predicate the write side refuses on, so the two cannot describe one
  // chore differently.
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
 * Traced through Donetick v0.1.76's NotificationPlanner.GenerateNotifications
 * (internal/notifier/service/planner.go:27-72). It reads exactly three things off
 * notificationMetadata: Templates, CircleGroup and CircleGroupID. The four booleans
 * dueDate, predue, nagging and completion are declared on the struct
 * (internal/chore/model/model.go:145-148) and read nowhere in the notifier package.
 *
 * So they are not settings, and reporting them as
 * on_due_date, before_due, when_overdue and on_completion told the caller a chore was
 * configured when nothing had been configured. Reminders are the whole of it.
 *
 * Offsets are signed on the wire because Donetick adds them to the due date: negative
 * is before, positive is an overdue nag after, zero is at the due date. The direction
 * is rendered rather than dropped.
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

  const reminders = templates.map((t) => {
    if (t.value === 0) return "at the due date";
    return `${Math.abs(t.value)}${t.unit} ${t.value < 0 ? "before" : "after"}`;
  });

  // The planner returns early on a chore with no due date and on a trigger
  // recurrence, so reminders on either send nothing at all.
  const silent =
    chore.notification === true &&
    (reminders.length === 0 || chore.nextDueDate === null || chore.frequencyType === "trigger");

  return {
    enabled: chore.notification === true,
    reminders,
    ...(silent
      ? {
          note:
            reminders.length === 0
              ? "Notifications are on but no reminders are set, so nothing is sent."
              : chore.frequencyType === "trigger"
                ? "Donetick sends no notifications for a trigger recurrence, so these reminders do nothing."
                : "Donetick sends no notifications for a chore with no due date, so these reminders do nothing.",
        }
      : {}),
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
    // Archived chores are absent from list_chores, so without this get_chore returned
    // one looking exactly like an active chore and the caller had no way to tell why
    // it could not be found again. Both views carry isActive.
    archived: isArchivedChore(chore),
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
