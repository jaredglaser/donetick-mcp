import { parseDueDate } from "@/dates";
import { endpoints } from "@/endpoints";
import type { WriteContext } from "@/tools/write";
import type { RawChore } from "@/types";

async function loadChoreById(chore_id: number | undefined, ctx: WriteContext): Promise<RawChore> {
  if (typeof chore_id !== "number") {
    throw new Error("chore_id is required. Resolve a name to an id with list_chores or get_chore first.");
  }
  const all = await ctx.service.chores();
  const found = all.find((chore) => chore.id === chore_id);
  if (!found) {
    throw new Error(
      `No chore with id ${chore_id} is visible on this account. It may have been deleted or archived since the chore list was last read.`,
    );
  }
  return found;
}

function statusOf(response: unknown): number | undefined {
  if (response && typeof response === "object" && "status" in response) {
    const value = (response as Record<string, unknown>).status;
    if (typeof value === "number") return value;
  }
  return undefined;
}

/**
 * Distinguishes a response that omits nextDueDate from one that carries it as null,
 * since a plain `?? fallback` would treat both the same and mask an explicit clear.
 */
function nextDueDateOf(response: unknown): { present: boolean; value: string | null } {
  if (response && typeof response === "object" && "nextDueDate" in response) {
    const value = (response as Record<string, unknown>).nextDueDate;
    if (typeof value === "string" || value === null) return { present: true, value };
  }
  return { present: false, value: null };
}

function messageOf(response: unknown): string | undefined {
  if (response && typeof response === "object" && "message" in response) {
    const value = (response as Record<string, unknown>).message;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export interface CompleteInput {
  chore_id?: number;
  completed_at?: string;
  note?: string;
  completed_by?: string;
}

export interface CompleteOutcome {
  id: number;
  name: string;
  completed: boolean;
  pending_approval: boolean;
  next_due_date: string | null;
  message: string;
}

export async function completeChore(input: CompleteInput, ctx: WriteContext): Promise<CompleteOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);

  const body: Record<string, unknown> = {};
  let isPastCompletion = false;

  if (typeof input.completed_at === "string") {
    const parsed = parseDueDate(input.completed_at, ctx.now(), ctx.timezone);
    if (parsed !== null) {
      const nowMs = ctx.now().getTime();
      if (parsed.getTime() > nowMs) {
        throw new Error(
          `A completion time cannot be in the future. "${input.completed_at}" resolves to ${parsed.toISOString()}.`,
        );
      }
      isPastCompletion = parsed.getTime() < nowMs;
      // The wire field is completedTime, not completedAt or completedDate. A wrong
      // name here is silently ignored and Donetick records time.Now() with a 200.
      body.completedTime = parsed.toISOString();
    }
  }

  if (input.note !== undefined) {
    // notes is the current field; the deprecated note wins over it when both are
    // present, so note is never sent from here.
    body.notes = input.note;
  }

  if (input.completed_by !== undefined) {
    const members = await ctx.service.members();
    const member = members.find(
      (m) => m.displayName === input.completed_by || m.username === input.completed_by,
    );
    if (!member) {
      throw new Error(
        `"${input.completed_by}" is not a member of this circle. Known members: ${
          members.map((m) => m.displayName).join(", ") || "none"
        }.`,
      );
    }
    body.completedBy = member.userId;
  }

  const response = await ctx.service.write(() =>
    ctx.service.client.post(endpoints.completeChore(chore.id), body),
  );

  // A chore awaiting sign-off comes back 200 with the full chore object at status 3
  // and no message field at all, and its due date is unchanged. Status is the only
  // reliable signal; chore.requireApproval is a backup in case it is ever absent.
  const pendingApproval = statusOf(response) === 3 || chore.requireApproval === true;

  if (pendingApproval) {
    return {
      id: chore.id,
      name: chore.name,
      completed: false,
      pending_approval: true,
      next_due_date: chore.nextDueDate,
      message: `"${chore.name}" was submitted for approval and has not been completed. Its due date is unchanged. A circle admin or manager must sign off with approve_chore.`,
    };
  }

  const nextDue = nextDueDateOf(response);
  const rollingNote =
    isPastCompletion && chore.isRolling === true
      ? " This is a rolling chore, which reschedules from its completion date, so backdating the completion also moved the next occurrence earlier."
      : "";

  return {
    id: chore.id,
    name: chore.name,
    completed: true,
    pending_approval: false,
    next_due_date: nextDue.present ? nextDue.value : chore.nextDueDate,
    message: `Completed "${chore.name}".${rollingNote}`,
  };
}

export interface SkipInput {
  chore_id?: number;
}

export interface SkipOutcome {
  id: number;
  name: string;
  next_due_date: string | null;
}

export async function skipChore(input: SkipInput, ctx: WriteContext): Promise<SkipOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);

  const response = await ctx.service.write(() =>
    ctx.service.client.post(endpoints.skipChore(chore.id), {}),
  );

  const nextDue = nextDueDateOf(response);
  return {
    id: chore.id,
    name: chore.name,
    next_due_date: nextDue.present ? nextDue.value : chore.nextDueDate,
  };
}

export interface UndoInput {
  chore_id?: number;
  name?: string;
}

export interface UndoOutcome {
  id: number;
  message: string;
}

/**
 * Takes chore_id only. Undo has a five-minute window on the calling account's own
 * action, and a completed non-recurring chore has isActive: false and drops out of
 * the active list name resolution searches, so name lookup could never find it.
 * complete_chore returns the id for exactly this reason.
 */
export async function undoChore(input: UndoInput, ctx: WriteContext): Promise<UndoOutcome> {
  if (typeof input.chore_id !== "number") {
    if (typeof input.name === "string") {
      throw new Error(
        `undo_chore takes chore_id only, not a name. "${input.name}" may no longer be in the active list this server searches by name, since a just-completed non-recurring chore has isActive: false. Use the id complete_chore returned.`,
      );
    }
    throw new Error(
      "undo_chore needs a chore_id. complete_chore returns the chore id in its result for exactly this purpose.",
    );
  }

  await ctx.service.write(() => ctx.service.client.post(endpoints.undoChore(input.chore_id!), {}));
  return { id: input.chore_id, message: "The most recent completion was undone." };
}

export interface ApprovalInput {
  chore_id?: number;
}

export interface ApprovalOutcome {
  id: number;
  name: string;
  approved: boolean;
}

export async function approveChore(input: ApprovalInput, ctx: WriteContext): Promise<ApprovalOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);
  await ctx.service.write(() => ctx.service.client.post(endpoints.approveChore(chore.id), {}));
  return { id: chore.id, name: chore.name, approved: true };
}

export async function rejectChore(input: ApprovalInput, ctx: WriteContext): Promise<ApprovalOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);
  await ctx.service.write(() => ctx.service.client.post(endpoints.rejectChore(chore.id), {}));
  return { id: chore.id, name: chore.name, approved: false };
}

export interface NudgeInput {
  chore_id?: number;
  message?: string;
  all_assignees?: boolean;
}

export interface NudgeOutcome {
  id: number;
  name: string;
  delivered: boolean;
  message: string;
}

export async function nudgeChore(input: NudgeInput, ctx: WriteContext): Promise<NudgeOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);
  const members = await ctx.service.members();

  // Donetick strips the caller from the nudge target list and returns 400 if nobody
  // is left, so a circle of one can never be nudged. Refuse before sending anything.
  if (members.length < 2) {
    throw new Error(
      "This circle has only one member, so there is nobody else to nudge. Donetick rejects a nudge with no remaining target once the caller is removed from the list.",
    );
  }

  const response = await ctx.service.write(() =>
    ctx.service.client.post(endpoints.nudgeChore(chore.id), {
      all_assignees: input.all_assignees ?? false,
      message: input.message ?? "",
    }),
  );

  const message = messageOf(response) ?? "Nudge sent.";
  // Nudge reaches registered mobile devices only, not Telegram or Pushover, and
  // reports 200 saying "across 0 device(s)" when nobody has one, which is a silent
  // no-op unless it is reported as such here.
  const delivered = !/across 0 device/i.test(message);

  return {
    id: chore.id,
    name: chore.name,
    delivered,
    message: delivered
      ? message
      : `${message} Nudge only reaches registered mobile devices, and nobody currently has one registered, so nothing was actually delivered.`,
  };
}
