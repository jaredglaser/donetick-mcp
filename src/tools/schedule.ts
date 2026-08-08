import {
  concurrencyToken,
  mergeEditRequest,
  requireDueDateFor,
  type BuildContext,
  type ChoreRequestBody,
  currentAssigneeIds,
  notificationsOffWarning,
} from "@/chore-request";
import { parseDueDate } from "@/dates";
import { endpoints } from "@/endpoints";
import { loadArchivedChoreById, loadChoreById, writeWithConcurrencyRetry } from "@/tools/chore-lookup";
import { resolveMember, safeName } from "@/resolve";
import type { ToolContext } from "@/tools/context";
import {
  isArchivedChore,
  isPriorityValue,
  MAX_PRIORITY,
  MIN_PRIORITY,
  PRIORITY_LABEL,
  PRIORITY_VALUE,
  UNSET_PRIORITY,
  type ChoreListRow,
} from "@/types";

export interface RescheduleInput {
  chore_id?: number;
  due_date: string | null;
}

export interface RescheduleOutcome {
  kind: "rescheduled";
  chore_id: number;
  due_date: string | null;
}

export interface ReassignInput {
  chore_id?: number;
  assignee: string;
}

export interface ReassignOutcome {
  kind: "reassigned";
  chore_id: number;
  assignee: string;
  method: "fast" | "full_edit";
  /** Set when this write changed something the caller did not ask about. */
  warning?: string;
}

export interface SetPriorityInput {
  chore_id?: number;
  priority: string | number;
}

export interface SetPriorityOutcome {
  kind: "priority_set";
  chore_id: number;
  priority: string;
  message: string;
}

export interface ArchiveInput {
  chore_id?: number;
}

export interface ArchiveOutcome {
  kind: "archived" | "unarchived";
  chore_id: number;
  name: string;
  message?: string;
}

export async function rescheduleChore(input: RescheduleInput, ctx: ToolContext): Promise<RescheduleOutcome> {
  const existing = await loadChoreById(input.chore_id, ctx);
  const parsed = parseDueDate(input.due_date, ctx.now(), ctx.timezone);
  const dueDate = parsed === null ? null : parsed.toISOString();
  // This endpoint writes the due date directly, so it never passes through the
  // builders where the guard normally runs. Clearing the date on a chore with a
  // completion window leaves it uncompletable, and an adaptive frequency unskippable.
  //
  // Checked against the live row before refusing, never against the cached one. The
  // cached row's completion window can be up to a TTL out of date, so a window
  // removed on the phone made this refuse a clear that Donetick would have accepted,
  // and the message named a repair the caller had already made. Only on the refusal
  // path: the read costs nothing on the common one, and a guard that lets a clear
  // through is recoverable where a wrong refusal makes the chore uneditable here.
  if (parsed === null) {
    const live = await liveGuardFields(existing, ctx);
    requireDueDateFor(null, live.frequencyType, live.completionWindow);
  }
  const updatedAt = concurrencyToken(existing, ctx.now());

  await ctx.service.write(() =>
    ctx.service.client.put(endpoints.updateDueDate(existing.id), { dueDate, updatedAt }),
  );

  // PUT /:id/dueDate returns the chore as it was before the update, so the response
  // body is never trusted for the new date; the value already computed is echoed back.
  return { kind: "rescheduled", chore_id: existing.id, due_date: dueDate };
}

/**
 * The two fields requireDueDateFor reads, taken from GET /:id/details rather than
 * from the cached list row.
 *
 * Falls back to the cached values if that read fails. A refusal is the outcome either
 * way when the cached row says so, and turning a transient read failure into a
 * different error would hide the reason the write was blocked.
 */
async function liveGuardFields(
  existing: ChoreListRow,
  ctx: ToolContext,
): Promise<{ frequencyType: string; completionWindow: number | null }> {
  try {
    const detail = await ctx.service.choreDetails(existing.id);
    return {
      frequencyType: detail.frequencyType,
      completionWindow: detail.completionWindow ?? null,
    };
  } catch {
    return {
      frequencyType: existing.frequencyType,
      completionWindow: existing.completionWindow ?? null,
    };
  }
}

export async function reassignChore(input: ReassignInput, ctx: ToolContext): Promise<ReassignOutcome> {
  const existing = await loadChoreById(input.chore_id, ctx);
  const members = await ctx.service.members();
  const target = resolveMember(input.assignee, members);

  // A chore carrying no_assignee takes the full edit even when the target is already
  // on it, because only the merge promotes the strategy. Donetick maps no_assignee to
  // nil when it picks the next assignee and persists that, so the fast path would
  // land, report success, and be undone by the first completion.
  const needsStrategyPromotion = existing.assignStrategy === "no_assignee";

  if (!needsStrategyPromotion && currentAssigneeIds(existing).includes(target.userId)) {
    const updatedAt = concurrencyToken(existing, ctx.now());
    await ctx.service.write(() =>
      ctx.service.client.put(endpoints.updateAssignee(existing.id), { assignee: target.userId, updatedAt }),
    );
    return { kind: "reassigned", chore_id: existing.id, assignee: target.displayName, method: "fast" };
  }

  // The fast /assignee endpoint rejects anyone not already in chore.Assignees
  // (internal/chore/handler.go:1262), so adding a new person requires the full
  // read-modify-write. mergeEditRequest carries every field it would otherwise
  // drop forward from `existing`; only assignedTo is overridden afterward, since
  // the merge keeps the pre-edit assignedTo as long as it is still among the
  // (now-larger) assignee set.
  const projects = await ctx.service.projects();
  const buildCtx: BuildContext = { members, projects, now: ctx.now(), timezone: ctx.timezone };

  // Rebuilt per attempt, so a retry merges onto the row that actually landed. The
  // warnings are computed here too: which side effects this write causes depends on
  // the base it merged onto, and reporting the first attempt's would describe a chore
  // that was never written.
  let body: ChoreRequestBody | undefined;
  let notificationsSwitchedOff = false;
  let strategyPromoted = false;

  const put = async (base: ChoreListRow): Promise<void> => {
    body = mergeEditRequest(base, { add_assignees: [input.assignee] }, buildCtx);
    body.assignedTo = target.userId;
    // This path goes through the same merge edit_chore does, so it causes the same
    // two side effects, and edit_chore warns about only one of them from only one of
    // the two tools that reach it.
    notificationsSwitchedOff = base.notification === true && body.notification === false;
    strategyPromoted = base.assignStrategy === "no_assignee" && body.assignStrategy !== "no_assignee";
    await ctx.service.write(() => ctx.service.client.put(endpoints.editChore(), body));
  };

  await writeWithConcurrencyRetry(input.chore_id, existing, put, ctx);

  const warnings = [
    notificationsSwitchedOff
      ? notificationsOffWarning(existing.name)
      : "",
    strategyPromoted
      ? `The assign strategy changed from no_assignee to ${body?.assignStrategy}, because a chore cannot both have an assignee and be set to assign nobody. Later occurrences will keep an assignee rather than reverting to unassigned.`
      : "",
  ].filter((w) => w.length > 0);

  return {
    kind: "reassigned",
    chore_id: existing.id,
    assignee: target.displayName,
    method: "full_edit",
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

/**
 * Both a P-label and a raw 0-4 integer are accepted: the projection reports priority
 * as a P-label (see PRIORITY_LABEL), so a caller that just read a chore's priority and
 * wants to set it back, or copy it from another chore, has an integer in hand already.
 */
function resolvePriority(priority: string | number): number {
  if (typeof priority === "number") {
    if (isPriorityValue(priority)) return priority;
    throw new Error(
      `Priority must be an integer ${MIN_PRIORITY} through ${MAX_PRIORITY} (${UNSET_PRIORITY} means unset). Got ${priority}.`,
    );
  }
  const value = PRIORITY_VALUE[priority.toLowerCase()];
  if (value === undefined) {
    throw new Error(`"${priority}" is not a priority. P1 is the most urgent, P4 is least, and none (0) is unset.`);
  }
  return value;
}

export async function setPriority(input: SetPriorityInput, ctx: ToolContext): Promise<SetPriorityOutcome> {
  const existing = await loadChoreById(input.chore_id, ctx);
  const priority = resolvePriority(input.priority);

  await ctx.service.write(() => ctx.service.client.put(endpoints.updatePriority(existing.id), { priority }));

  // A P-label, not the raw integer. Every read path in this codebase reports the
  // label, and handing back the inverted number on the one scale the repo warns
  // about three times invites "set to priority 1" being read as lowest.
  const label = PRIORITY_LABEL[priority] ?? String(priority);
  return {
    kind: "priority_set",
    chore_id: existing.id,
    priority: label,
    message:
      priority === UNSET_PRIORITY
        ? `"${safeName(existing.name)}" no longer has a priority set.`
        : `"${safeName(existing.name)}" is now ${label}, where P1 is the most urgent and P4 the least.`,
  };
}

export async function archiveChore(input: ArchiveInput, ctx: ToolContext): Promise<ArchiveOutcome> {
  const existing = await loadChoreById(input.chore_id, ctx);

  await ctx.service.write(() => ctx.service.client.put(endpoints.archiveChore(existing.id), {}));

  // Reported rather than refused. isActive false means two different things, and
  // they are indistinguishable from the row: a chore that was archived, and a
  // non-recurring chore that has been completed. Donetick archives both happily, so
  // refusing would have told someone their just-completed one-off was "already
  // archived" and pointed them at unarchive_chore, which returns it to the active
  // list with no due date.
  return {
    kind: "archived",
    chore_id: existing.id,
    name: existing.name,
    ...(isArchivedChore(existing)
      ? {
          message: `"${safeName(existing.name)}" was already out of your active lists, either archived or a one-off that has been completed. It is archived now either way.`,
        }
      : {}),
  };
}

export async function unarchiveChore(input: ArchiveInput, ctx: ToolContext): Promise<ArchiveOutcome> {
  const existing = await loadArchivedChoreById(input.chore_id, ctx);

  await ctx.service.write(() => ctx.service.client.put(endpoints.unarchiveChore(existing.id), {}));

  return { kind: "unarchived", chore_id: existing.id, name: existing.name };
}
