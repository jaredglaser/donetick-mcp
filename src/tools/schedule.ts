import { mergeEditRequest, type BuildContext } from "@/chore-request";
import { parseDueDate } from "@/dates";
import { endpoints } from "@/endpoints";
import { resolveMember } from "@/resolve";
import type { WriteContext } from "@/tools/write";
import type { RawChore } from "@/types";

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
}

export interface SetPriorityInput {
  chore_id?: number;
  priority: string | number;
}

export interface SetPriorityOutcome {
  kind: "priority_set";
  chore_id: number;
  priority: number;
}

export interface ArchiveInput {
  chore_id?: number;
}

export interface ArchiveOutcome {
  kind: "archived" | "unarchived";
  chore_id: number;
  name: string;
}

async function loadChoreFrom(
  chore_id: number | undefined,
  fetchAll: () => Promise<RawChore[]>,
  whichList: string,
): Promise<RawChore> {
  if (typeof chore_id !== "number") {
    throw new Error("chore_id is required.");
  }
  const all = await fetchAll();
  const found = all.find((chore) => chore.id === chore_id);
  if (!found) {
    throw new Error(`No chore with id ${chore_id} is in ${whichList}.`);
  }
  return found;
}

function loadActiveChore(chore_id: number | undefined, ctx: WriteContext): Promise<RawChore> {
  return loadChoreFrom(chore_id, () => ctx.service.chores(), "the active chore list");
}

/**
 * The default chore list excludes archived chores, so a chore being unarchived is by
 * definition absent from it. Resolving against the active cache here would make every
 * unarchiveChore call fail with "not found" on exactly the chore it is meant to act on.
 */
function loadArchivedChore(chore_id: number | undefined, ctx: WriteContext): Promise<RawChore> {
  return loadChoreFrom(chore_id, () => ctx.service.archivedChores(), "the archived chore list");
}

export async function rescheduleChore(input: RescheduleInput, ctx: WriteContext): Promise<RescheduleOutcome> {
  const existing = await loadActiveChore(input.chore_id, ctx);
  const parsed = parseDueDate(input.due_date, ctx.now(), ctx.timezone);
  const dueDate = parsed === null ? null : parsed.toISOString();
  // updatedAt is an optimistic-concurrency token Donetick checks against the stored
  // row. It must be the current instant, not existing.updatedAt: sourcing it from the
  // 10-second chore cache would make a concurrent web-UI edit produce an intermittent
  // 403 here.
  const updatedAt = ctx.now().toISOString();

  await ctx.service.write(() =>
    ctx.service.client.put(endpoints.updateDueDate(existing.id), { dueDate, updatedAt }),
  );

  // PUT /:id/dueDate returns the chore as it was before the update, so the response
  // body is never trusted for the new date; the value already computed is echoed back.
  return { kind: "rescheduled", chore_id: existing.id, due_date: dueDate };
}

function currentAssigneeIds(existing: RawChore): number[] {
  if (existing.assignees !== undefined) return existing.assignees.map((a) => a.userId);
  if (existing.assignedTo !== null && existing.assignedTo !== undefined) return [existing.assignedTo];
  return [];
}

export async function reassignChore(input: ReassignInput, ctx: WriteContext): Promise<ReassignOutcome> {
  const existing = await loadActiveChore(input.chore_id, ctx);
  const members = await ctx.service.members();
  const target = resolveMember(input.assignee, members);

  if (currentAssigneeIds(existing).includes(target.userId)) {
    const updatedAt = ctx.now().toISOString();
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
  const body = mergeEditRequest(existing, { add_assignees: [input.assignee] }, buildCtx);
  body.assignedTo = target.userId;

  await ctx.service.write(() => ctx.service.client.put(endpoints.editChore(), body));
  return { kind: "reassigned", chore_id: existing.id, assignee: target.displayName, method: "full_edit" };
}

const PRIORITY_VALUE: Record<string, number> = {
  none: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  p4: 4,
};

/**
 * Both a P-label and a raw 0-4 integer are accepted: the projection reports priority
 * as a P-label (see PRIORITY_LABEL), so a caller that just read a chore's priority and
 * wants to set it back, or copy it from another chore, has an integer in hand already.
 */
function resolvePriority(priority: string | number): number {
  if (typeof priority === "number") {
    if (Number.isInteger(priority) && priority >= 0 && priority <= 4) return priority;
    throw new Error(`Priority must be an integer 0 through 4 (0 means unset). Got ${priority}.`);
  }
  const value = PRIORITY_VALUE[priority.toLowerCase()];
  if (value === undefined) {
    throw new Error(`"${priority}" is not a priority. P1 is the most urgent, P4 is least, and none (0) is unset.`);
  }
  return value;
}

export async function setPriority(input: SetPriorityInput, ctx: WriteContext): Promise<SetPriorityOutcome> {
  const existing = await loadActiveChore(input.chore_id, ctx);
  const priority = resolvePriority(input.priority);

  await ctx.service.write(() => ctx.service.client.put(endpoints.updatePriority(existing.id), { priority }));

  return { kind: "priority_set", chore_id: existing.id, priority };
}

export async function archiveChore(input: ArchiveInput, ctx: WriteContext): Promise<ArchiveOutcome> {
  const existing = await loadActiveChore(input.chore_id, ctx);

  await ctx.service.write(() => ctx.service.client.put(endpoints.archiveChore(existing.id), {}));

  return { kind: "archived", chore_id: existing.id, name: existing.name };
}

export async function unarchiveChore(input: ArchiveInput, ctx: WriteContext): Promise<ArchiveOutcome> {
  const existing = await loadArchivedChore(input.chore_id, ctx);

  await ctx.service.write(() => ctx.service.client.put(endpoints.unarchiveChore(existing.id), {}));

  return { kind: "unarchived", chore_id: existing.id, name: existing.name };
}
