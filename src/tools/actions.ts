import { carriesTimeOfDay, parseDueDate } from "@/dates";
import { zonedYmd } from "@/time";
import { endpoints } from "@/endpoints";
import { loadChoreById } from "@/tools/chore-lookup";
import { resolveMember } from "@/resolve";
import type { ToolContext } from "@/tools/context";

/** Same day in the given zone, which is not the same question as "within 24 hours". */
function isSameCalendarDay(a: Date, b: Date, tz: string): boolean {
  const left = zonedYmd(a, tz);
  const right = zonedYmd(b, tz);
  return left.y === right.y && left.m === right.m && left.d === right.d;
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

export async function completeChore(input: CompleteInput, ctx: ToolContext): Promise<CompleteOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);

  const body: Record<string, unknown> = {};
  let isPastCompletion = false;

  // Trimmed-empty is dropped rather than parsed, the way note is below. Making an
  // empty due_date a parse error was right for the tools that write a due date, and
  // it reached here too: completed_at is an optional string, so "" passed schema
  // validation and then failed the whole completion with due-date format help that
  // does not mention completions at all. Absent means "use Donetick's own clock".
  if (typeof input.completed_at === "string" && input.completed_at.trim() !== "") {
    const parsed = parseDueDate(input.completed_at, ctx.now(), ctx.timezone);
    if (parsed !== null) {
      const nowMs = ctx.now().getTime();
      // parseDueDate resolves a bare day to 09:00, which is the right default for
      // a due date and the wrong one for a completion: "today" before 09:00 local
      // resolves to later this morning and would be refused as a future time for
      // something the user just did. Same calendar day means now, since that is
      // what a bare "today" asks for; any other day keeps its resolved instant so
      // "yesterday" still records yesterday.
      //
      // Only when the caller named no time. Keyed on the calendar day alone this
      // also swallowed an explicit timestamp: "I did it at 8pm tonight", asked at
      // noon, recorded noon and reported plain success, which is the opposite of
      // the refusal the schema promises.
      const sameDay = isSameCalendarDay(parsed, ctx.now(), ctx.timezone);
      const defaultedHour = !carriesTimeOfDay(input.completed_at);
      const effective = defaultedHour && sameDay && parsed.getTime() > nowMs ? ctx.now() : parsed;

      if (effective.getTime() > nowMs) {
        throw new Error(
          `A completion time cannot be in the future. "${input.completed_at}" resolves to ${effective.toISOString()}.`,
        );
      }
      isPastCompletion = effective.getTime() < nowMs;
      // The wire field is completedTime, not completedAt or completedDate. A wrong
      // name here is silently ignored and Donetick records time.Now() with a 200.
      body.completedTime = effective.toISOString();
    }
  }

  if (input.note !== undefined && input.note !== "") {
    // notes is the current field; the deprecated note wins over it when both are
    // present, so note is never sent from here. An empty string is dropped rather
    // than sent: the binding is omitempty,min=1, so "" is a 400 for a value that
    // means the same as not passing one.
    body.notes = input.note;
  }

  if (input.completed_by !== undefined) {
    const members = await ctx.service.members();
    const member = resolveMember(input.completed_by, members);
    body.completedBy = member.userId;
  }

  const response = await ctx.service.write(() =>
    ctx.service.client.post(endpoints.completeChore(chore.id), body),
  );
  // Points move on completion, and list_members answers point-standing questions
  // off a cache with a five minute TTL.
  ctx.service.invalidateMembers();

  // A chore awaiting sign-off comes back 200 with the full chore object at status 3
  // and no message field at all, and its due date is unchanged.
  //
  // The response's status decides it; the cached flag is consulted only when the
  // response carries none. Under `status === 3 || chore.requireApproval` a completion
  // that actually landed was reported as pending whenever the chore merely had
  // approval enabled, with a stale next due date alongside it.
  const status = statusOf(response);
  const pendingApproval = status !== undefined ? status === 3 : chore.requireApproval === true;

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

  // Measured live on an adaptive chore completed early: Donetick rescheduled it to
  // the completion instant minus how early it was, so the next occurrence landed
  // before the completion and the chore was overdue the moment it was done. Later
  // completions land it a couple of milliseconds before now, permanently. Reporting
  // a bare success there hands back a date the caller has no reason to question.
  const nextDueInstant = nextDue.present && nextDue.value !== null ? new Date(nextDue.value) : null;
  const scheduledIntoThePast =
    nextDueInstant !== null &&
    !Number.isNaN(nextDueInstant.getTime()) &&
    nextDueInstant.getTime() < ctx.now().getTime();
  const pastNote = scheduledIntoThePast
    ? ` Donetick set the next occurrence to ${nextDueInstant.toISOString()}, which is already in the past, so the chore is overdue again immediately. An adaptive recurrence does this when a chore is completed earlier than its interval; reschedule_chore sets a real next date.`
    : "";

  // An archived chore is in no active list, so a completion or skip advances a due
  // date nobody will see. Donetick allows it and says nothing; every write tool here
  // reported plain success on one.
  const archivedNote =
    chore.isActive === false
      ? ` "${chore.name}" is archived, so it does not appear in any active list. Use unarchive_chore if that was not intended.`
      : "";

  const rollingNote =
    isPastCompletion && chore.isRolling === true
      ? " This is a rolling chore, which reschedules from its completion date, so backdating the completion also moved the next occurrence earlier."
      : "";

  return {
    id: chore.id,
    name: chore.name,
    completed: true,
    pending_approval: false,
    next_due_date: nextDue.present ? nextDue.value : null,
    message: `Completed "${chore.name}".${archivedNote}${rollingNote}${pastNote}${
      nextDue.present
        ? ""
        : " Donetick did not report a new due date, so the next occurrence is unknown here; call get_chore to see it."
    }`,
  };
}

export interface SkipInput {
  chore_id?: number;
}

export interface SkipOutcome {
  id: number;
  name: string;
  next_due_date: string | null;
  message: string;
}

export async function skipChore(input: SkipInput, ctx: ToolContext): Promise<SkipOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);

  // A running or paused timer makes the skip a no-op that still answers 200.
  // Donetick's SkipChore looks for the chore's Started history row and switches on
  // `err == nil && PerformedAt != nil`; a timer row has a null PerformedAt, so
  // neither case matches and the default returns a nil error, which commits the
  // transaction. Every write in that function is below the switch, so the due date
  // does not move, no history row is written, and the session is not closed.
  // Measured against v0.1.76: due date unchanged, status still 1, history [Started].
  // Complete has no such condition on its own switch and works from either state.
  if (chore.status === 1 || chore.status === 2) {
    const state = chore.status === 1 ? "running" : "paused";
    throw new Error(
      `"${chore.name}" has a ${state} timer, and Donetick cannot skip a chore in that state: it answers 200 and does nothing, leaving the due date where it is. Complete it instead, which works from either timer state, or stop the timer in Donetick and skip it then.`,
    );
  }

  const response = await ctx.service.write(() =>
    ctx.service.client.post(endpoints.skipChore(chore.id), {}),
  );

  // Null rather than the pre-skip date. The value read before the write is the
  // occurrence that was just skipped, and reporting it under a field named
  // next_due_date is indistinguishable from a verified answer.
  const nextDue = nextDueDateOf(response);
  const archivedNote =
    chore.isActive === false
      ? ` "${chore.name}" is archived, so it does not appear in any active list. Use unarchive_chore if that was not intended.`
      : "";
  return {
    id: chore.id,
    name: chore.name,
    next_due_date: nextDue.present ? nextDue.value : null,
    message: nextDue.present
      ? `Skipped "${chore.name}".${archivedNote}`
      : `Skipped "${chore.name}".${archivedNote} Donetick did not report the new due date; call get_chore to see it.`,
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
 * Takes chore_id only. A completed non-recurring chore has isActive: false and drops
 * out of the active list name resolution searches, so name lookup could never find
 * it. complete_chore returns the id for exactly this reason.
 *
 * Donetick documents a five-minute window on the calling account's own action, but
 * see explainUndoFailure: on an instance behind UTC the window never opens at all.
 */
export async function undoChore(input: UndoInput, ctx: ToolContext): Promise<UndoOutcome> {
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

  try {
    await ctx.service.write(() => ctx.service.client.post(endpoints.undoChore(input.chore_id!), {}));
  } catch (error) {
    throw new Error(explainUndoFailure(error));
  }
  ctx.service.invalidateMembers();
  return { id: input.chore_id, message: "The most recent completion was undone." };
}

/**
 * Donetick blames the five-minute window for a failure that has nothing to do with
 * elapsed time, so retrying sooner is the one thing that cannot help.
 *
 * Its lookup is `created_at > cutoff` where cutoff is built in UTC but created_at was
 * written by the pure-Go SQLite driver as text carrying the server's own offset.
 * SQLite compares those as strings, so on a server behind UTC the stored value always
 * sorts earlier and the row is never found, a second after the completion or an hour.
 * Verified against a completion one second old on a UTC-4 instance.
 */
function explainUndoFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("No recent action found")) return message;

  return `${message}\n\nThe window is not the real cause, so retrying will not help. Donetick looks the completion up with a UTC cutoff against a timestamp its SQLite driver stored in the server's local offset, and compares the two as text, so on a server behind UTC no completion is ever recent enough. Reverse it by completing or rescheduling the chore back to where it was.`;
}

export interface ApprovalInput {
  chore_id?: number;
}

export interface ApprovalOutcome {
  id: number;
  name: string;
  /** Named rather than a boolean: approved false is what a failed approval looks like. */
  decision: "approved" | "rejected";
  message: string;
}

export async function approveChore(input: ApprovalInput, ctx: ToolContext): Promise<ApprovalOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);
  await ctx.service.write(() => ctx.service.client.post(endpoints.approveChore(chore.id), {}));
  ctx.service.invalidateMembers();
  return {
    id: chore.id,
    name: chore.name,
    decision: "approved",
    message: `The pending completion of "${chore.name}" was approved.`,
  };
}

export async function rejectChore(input: ApprovalInput, ctx: ToolContext): Promise<ApprovalOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);
  await ctx.service.write(() => ctx.service.client.post(endpoints.rejectChore(chore.id), {}));
  return {
    id: chore.id,
    name: chore.name,
    decision: "rejected",
    message: `The pending completion of "${chore.name}" was rejected. The chore is not marked done.`,
  };
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

export async function nudgeChore(input: NudgeInput, ctx: ToolContext): Promise<NudgeOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);
  const members = await ctx.service.members();

  // Donetick strips the caller from the nudge target list and returns 400 if nobody
  // is left, so a circle of one can never be nudged. Refuse before sending anything.
  if (members.length < 2) {
    throw new Error(
      "This circle has only one member, so there is nobody else to nudge. Donetick rejects a nudge with no remaining target once the caller is removed from the list.",
    );
  }

  // Not wrapped in service.write: a nudge sends a push notification and changes no
  // chore field, so invalidating the list would throw away a warm cache to refetch
  // an identical answer.
  const response = await ctx.service.client.post(endpoints.nudgeChore(chore.id), {
    all_assignees: input.all_assignees ?? false,
    message: input.message ?? "",
  });

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
