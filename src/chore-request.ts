import { parseDueDate } from "@/dates";
import { dueDateOf } from "@/time";
import { frequencyHealth } from "@/frequency-health";
import { buildFrequency, type FrequencyInput } from "@/frequency";
import { findMember, normalizeName, safeName } from "@/resolve";
import {
  PRIORITY_VALUE,
  type ChoreListRow,
  type Member,
  type Project,
  type RawChore,
  type RawSubTask,
} from "@/types";

const ASSIGN_STRATEGIES_TUPLE = [
  "no_assignee",
  "least_assigned",
  "least_completed",
  "random",
  "keep_last_assigned",
  "random_except_last_assigned",
  "round_robin",
] as const;

export type AssignStrategy = (typeof ASSIGN_STRATEGIES_TUPLE)[number];

export const ASSIGN_STRATEGIES: readonly AssignStrategy[] = ASSIGN_STRATEGIES_TUPLE;

export interface NotifyInput {
  due_date?: boolean;
  completion?: boolean;
  predue?: boolean;
  nagging?: boolean;
  reminders?: string[];
}

export interface CreateInput {
  name: string;
  description?: string;
  due_date?: string | null;
  frequency?: FrequencyInput;
  assign_strategy?: AssignStrategy;
  reschedule_from?: "due_date" | "completion_date";
  assignees?: string[];
  project?: string | null;
  priority?: string;
  points?: number;
  subtasks?: string[];
  require_approval?: boolean;
  is_private?: boolean;
  completion_window?: number;
  notify?: NotifyInput;
}

export interface EditInput extends Partial<Omit<CreateInput, "name" | "points" | "completion_window">> {
  name?: string;
  // Null clears the value, which is why the merge checks this against undefined
  // rather than folding it into a ?? chain: under ?? an explicit null is nullish
  // and would fall through to the existing value exactly like an omitted field.
  points?: number | null;
  completion_window?: number | null;
  add_assignees?: string[];
  add_subtasks?: string[];
}

export interface BuildContext {
  members: Member[];
  projects: Project[];
  now: Date;
  timezone: string;
}

export interface ChoreRequestBody {
  id?: number;
  /** Create only. On edit Donetick carries the stored value forward, which is what preserves archived state. */
  isActive?: boolean;
  /**
   * The version of the chore this body was merged onto, echoed back as an
   * optimistic-concurrency token. Verified on v0.1.76: sending the value the row
   * was read with is accepted, sending an older one is refused with 403 "chore has
   * been modified by another user", and sending nothing at all skips the check
   * entirely and overwrites whatever landed in between. Absent on a create, which
   * has no prior version to be stale against.
   */
  updatedAt?: string;
  name: string;
  /**
   * Never null, and never absent. Verified on v0.1.76: PUT /api/v1/chores/ with
   * description null, or with the key omitted, kills the connection and the proxy
   * answers 502. An empty string is accepted and reads back as empty. Since a
   * chore created without a description stores null, sending its own value back
   * unchanged is what triggers this, which made edit_chore fail on exactly the
   * chores most likely to exist.
   */
  description: string;
  nextDueDate: string | null;
  frequencyType: string;
  frequency: number;
  frequencyMetadata: Record<string, unknown>;
  assignStrategy: string;
  assignedTo: number | null;
  assignees: Array<{ userId: number }>;
  /**
   * Keyed `id`, matching Donetick's LabelReq. `labelId` is the join-row's name
   * (ChoreLabels.LabelID) and is rejected by the request binding, which requires
   * id > 0. Nothing caught it because the client only sends a non-empty list when
   * the merge base already had labels, and no scratch chore in the suite has one.
   */
  labelsV2: Array<{ id: number }>;
  priority: number;
  points: number | null;
  projectId: number | null;
  isRolling: boolean;
  isPrivate: boolean;
  requireApproval: boolean;
  completionWindow: number | null;
  notification: boolean;
  notificationMetadata?: {
    dueDate?: boolean;
    completion?: boolean;
    predue?: boolean;
    nagging?: boolean;
    templates?: Array<{ value: number; unit: string }>;
  };
  subTasks?: Array<{ id?: number; name: string; orderId: number; completedAt: string | null }>;
}

/**
 * The optimistic-concurrency token for the id-scoped writes: the version the caller
 * read, sent back untouched.
 *
 * Measured on v0.1.76. The comparison is sent >= stored, and the stored value
 * carries nanosecond precision a Date round trip truncates downward, so it is
 * passed through as the original string rather than reformatted. Sending the
 * current time instead looks equivalent and is not: PUT /:id/assignee writes the
 * token it receives into the row, so a client whose clock runs ahead stamps the
 * chore with a future version and locks it out of editing until the skew passes.
 * The stored value is accepted by every endpoint that takes one, is never in the
 * future, and is a no-op when written back.
 *
 * Falls back to now only when the row carries no stamp, which leaves the write
 * unguarded rather than unmakeable.
 */
export function concurrencyToken(existing: RawChore, now: Date): string {
  return existing.updatedAt ?? now.toISOString();
}

function resolveMemberIds(names: string[] | undefined, members: Member[]): number[] {
  if (names === undefined) return [];
  return names.map((name) => {
    const found = findMember(name, members);
    if (!found) {
      throw new Error(
        `"${safeName(name)}" is not a member of this circle. Known members: ${members.map((m) => safeName(m.displayName)).join(", ") || "none"}.`,
      );
    }
    return found.userId;
  });
}

/**
 * In the builders rather than in create_chore, which is where the create guard used
 * to live alone. The merge had none, so edit_chore could rename a chore to "" or to
 * spaces, and reassign_chore routes through the same merge without ever naming one.
 */
function requireNonBlankName(name: string | undefined, tool: string): void {
  if (name !== undefined && name.trim().length === 0) {
    throw new Error(`${tool} cannot set a chore's name to an empty string.`);
  }
}

/** Null and undefined both mean "no project", so the one caller that clears can pass either. */
function resolveProjectId(name: string | null | undefined, projects: Project[]): number | null {
  if (name === undefined || name === null) return null;
  const wanted = normalizeName(name);
  const found = projects.find((p) => normalizeName(p.name) === wanted);
  if (!found) {
    throw new Error(
      `"${safeName(name)}" is not a known project. Known projects: ${projects.map((p) => safeName(p.name)).join(", ") || "none"}.`,
    );
  }
  return found.id;
}

function priorityValue(label: string | undefined, fallback: number): number {
  if (label === undefined) return fallback;
  const value = PRIORITY_VALUE[label.toLowerCase()];
  if (value === undefined) {
    throw new Error(`"${label}" is not a priority. Use P1 (most urgent) through P4, or none.`);
  }
  return value;
}

function validateAssignStrategy(strategy: string): AssignStrategy {
  if (!(ASSIGN_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new Error(
      `"${strategy}" is not an assign strategy. Expected one of: ${ASSIGN_STRATEGIES.join(", ")}.`,
    );
  }
  return strategy as AssignStrategy;
}

function buildNotification(
  notify: NotifyInput | undefined,
): Pick<ChoreRequestBody, "notification" | "notificationMetadata"> {
  if (notify === undefined) return { notification: false };

  const templates = (notify.reminders ?? []).map((reminder) => {
    const parsed = /^(\d+)\s*([mhd])$/.exec(reminder.trim().toLowerCase());
    if (!parsed) {
      throw new Error(`"${reminder}" is not a reminder offset. Use forms like "30m", "1h", "2d".`);
    }
    // Negative, because Donetick adds the value to the due date rather than
    // subtracting it: value < 0 is its PreDue class, 0 is Due, and > 0 is Overdue.
    // Positive offsets made every reminder this server built an overdue nag, and the
    // schema promised the opposite. A chore already overdue gets nothing at all,
    // since the planner drops any template whose computed time has passed.
    return { value: -Number(parsed[1]), unit: parsed[2]! };
  });

  if (templates.length > 5) {
    throw new Error("Donetick accepts at most 5 reminder offsets per chore.");
  }

  return {
    notification: true,
    notificationMetadata: {
      dueDate: notify.due_date ?? false,
      completion: notify.completion ?? false,
      predue: notify.predue ?? false,
      nagging: notify.nagging ?? false,
      ...(templates.length > 0 ? { templates } : {}),
    },
  };
}

/**
 * Carries existing notification settings forward when the edit does not touch them.
 * buildNotification cannot: notify === undefined there means "turn them off", which
 * is right on a create and would strip an existing chore's reminders on an edit.
 *
 * Donetick's planner dereferences the metadata whenever notification is true, in a
 * bare goroutine whose panic would take the process down rather than being recovered
 * by the request middleware. A chore whose metadata column is null comes back as
 * notificationMetadata: null, so carrying the flag forward without it is the shape
 * that reaches that deref.
 */
function mergeNotification(
  notify: NotifyInput | undefined,
  existing: RawChore,
): Pick<ChoreRequestBody, "notification" | "notificationMetadata"> {
  if (notify !== undefined) return buildNotification(notify);
  if (existing.notificationMetadata) {
    return {
      notification: existing.notification ?? false,
      notificationMetadata: existing.notificationMetadata as ChoreRequestBody["notificationMetadata"],
    };
  }
  // notification true with no metadata is the combination that reaches the deref, so
  // it is never sent. Turning notification off is the safe half of the pair: a chore
  // stored that way already produces nothing, since every notification is generated
  // from the templates the missing metadata would have carried.
  return { notification: false };
}

function buildSubtasks(names: string[]): NonNullable<ChoreRequestBody["subTasks"]> {
  return names.map((name, index) => ({ name, orderId: index, completedAt: null }));
}

function carriedSubtasks(existing: RawChore): ChoreRequestBody["subTasks"] {
  const raw: RawSubTask[] = existing.subTasks ?? [];
  if (raw.length === 0) return undefined;
  return raw.map((task, index) => ({
    id: task.id,
    name: task.name,
    orderId: task.orderId ?? index,
    completedAt: task.completedAt,
  }));
}

/**
 * Donetick dereferences NextDueDate without a nil check in two places: the completion
 * handler when a chore has a completionWindow, and the skip scheduler's adaptive arm.
 *
 * The two are disjoint, which is why the messages below name one operation each
 * rather than both. Measured on v0.1.76 against a chore with no due date: a
 * completion window kills the connection on every completion, with a window of 0 or
 * of 4, and skips fine; an adaptive recurrence kills it on every skip and completes
 * fine. Either way the chore can be created and then permanently lose one of the two,
 * so both combinations are refused.
 *
 * Measure the crashing operation first if this is ever re-checked. Skipping the
 * completion-window chore gives it a due date, and the completion then answers a
 * plain "out of completion window" rather than the crash.
 */
export function requireDueDateFor(
  dueDate: Date | null,
  frequencyType: string,
  completionWindow: number | null,
): void {
  if (dueDate !== null) return;
  // Any window at all, including 0. Donetick gates the due-date deref on the pointer
  // being non-nil rather than on the value, and 0 is not nullish, so it survives the
  // ?? chain and reaches the wire as a real window. Measured: a chore with
  // completionWindow 0 and no due date answers 502 on every completion, same as 4.
  if (completionWindow !== null && completionWindow !== undefined) {
    throw new Error(
      "A chore with a completion window needs a due date: Donetick measures the window against it and cannot complete a chore that has none.",
    );
  }
  if (frequencyType === "adaptive") {
    throw new Error(
      "An adaptive chore needs a due date: Donetick's skip scheduler reads it without checking whether it is there, so the chore can be created and then never skipped.",
    );
  }
}

export function buildCreateRequest(input: CreateInput, ctx: BuildContext): ChoreRequestBody {
  const frequency = buildFrequency(input.frequency ?? { type: "once" }, ctx.timezone, ctx.now);
  const assigneeIds = resolveMemberIds(input.assignees, ctx.members);
  const isRolling = input.reschedule_from === "completion_date";

  const dueDate = parseDueDate(input.due_date ?? null, ctx.now, ctx.timezone);
  const completionWindowValue = input.completion_window ?? null;
  requireDueDateFor(dueDate, frequency.frequencyType, completionWindowValue);

  // A chore carrying no_assignee with someone on it reverts on the next completion:
  // Donetick's next-assignee step maps that strategy to nil and persists it. So an
  // assignment that lands and reports success is undone the first time anyone
  // completes the chore. Promoted rather than refused, since the caller asked for
  // the assignment, not for the strategy.
  const strategy: AssignStrategy = input.assign_strategy
    ? validateAssignStrategy(input.assign_strategy)
    : assigneeIds.length > 0
      ? "keep_last_assigned"
      : "no_assignee";

  requireNonBlankName(input.name, "create_chore");

  return {
    name: input.name,
    // Sent explicitly so warnings stays a signal. Donetick appends one for each of
    // frequency, priority, isActive and isPrivate that arrives nil, and this was the
    // only one never sent, so every create came back warning about it and a real
    // warning was indistinguishable from the noise.
    isActive: true,
    description: input.description ?? "",
    nextDueDate: dueDate === null ? null : dueDate.toISOString(),
    frequencyType: frequency.frequencyType,
    frequency: frequency.frequency,
    frequencyMetadata: frequency.frequencyMetadata as unknown as Record<string, unknown>,
    assignStrategy: strategy,
    assignedTo: assigneeIds[0] ?? null,
    assignees: assigneeIds.map((userId) => ({ userId })),
    labelsV2: [],
    priority: priorityValue(input.priority, 0),
    points: input.points ?? null,
    projectId: resolveProjectId(input.project, ctx.projects),
    isRolling,
    isPrivate: input.is_private ?? false,
    requireApproval: input.require_approval ?? false,
    completionWindow: completionWindowValue,
    ...buildNotification(input.notify),
    ...(input.subtasks ? { subTasks: buildSubtasks(input.subtasks) } : {}),
  };
}

/**
 * Donetick's EditChore dissociates a chore's Thing on every edit and only puts it
 * back when the request carries a thingTrigger. This server never sends one, and
 * cannot: it refuses trigger recurrence at the frequency layer and has no endpoint
 * to read a Thing's id from. So an edit would leave a trigger chore that never fires
 * again, with a 200 and nothing in the read-back to show for it.
 */
function assertNoThingTrigger(existing: RawChore): void {
  // frequencyType is the load-bearing half. Donetick's list query preloads
  // assignees, labels and subtasks but not thingChore, so the field is null on
  // every row this server merges from and a check on it alone never fires.
  // frequencyType is on the row and is "trigger" for exactly these chores.
  const isTrigger = existing.frequencyType === "trigger";
  const hasThing = existing.thingChore !== undefined && existing.thingChore !== null;
  if (!isTrigger && !hasThing) return;
  throw new Error(
    `"${safeName(existing.name)}" is driven by a Donetick Thing. Editing it through this server would sever that link permanently, because Donetick drops the association on every edit and only restores it for a request that names the Thing. Edit this chore in the Donetick web UI. Every tool that rewrites the whole chore is blocked until then, reassign_chore included.`,
  );
}

/**
 * Refuses to carry forward a stored recurrence Donetick's scheduler cannot advance.
 *
 * The carry-forward branch spreads frequencyMetadata wholesale, so an unrelated edit
 * would re-send a broken shape and report success, and get_chore would render it as
 * an ordinary recurrence. Called only when the caller passes no frequency of their
 * own, since passing one is the repair.
 *
 * The predicate itself lives in frequency-health.ts, shared with summarizeFrequency,
 * because the two used to enumerate these shapes independently and disagreed three
 * times.
 */
function assertSchedulableFrequency(existing: RawChore): void {
  const health = frequencyHealth(existing);
  if (health.ok) return;

  throw new Error(
    `"${safeName(existing.name)}" has a recurrence Donetick cannot schedule: it is ${health.detail}, so every completion fails. ` +
      `${health.repair} Every tool that rewrites the whole chore is blocked until then, reassign_chore included.`,
  );
}

/**
 * Donetick has no partial update for most fields; PUT /api/v1/chores/ replaces the
 * whole object. The merge base must therefore be the /chores list row, never the
 * /details view or the trimmed ProjectedChore, or every field either of those drops
 * is destroyed on write.
 *
 * ChoreListRow rather than RawChore is what enforces that. The /details view carries
 * none of the four fields ChoreListRow requires, so it is not assignable here and no
 * call site can reach this function with one. A runtime guard used to stand in for
 * that, guessing at the shape from three optional fields being absent at once.
 */
export function mergeEditRequest(existing: ChoreListRow, input: EditInput, ctx: BuildContext): ChoreRequestBody {
  assertNoThingTrigger(existing);

  if (!existing.id || existing.id <= 0) {
    throw new Error(`Cannot edit a chore with id ${existing.id}. The existing chore's id must be a positive number.`);
  }

  // Guarded only on the carry-forward branch. A caller passing frequency is replacing
  // the stored recurrence, which is the repair this refusal exists to prompt, so
  // checking before the merge refused the fix along with the problem.
  if (input.frequency === undefined) assertSchedulableFrequency(existing);

  const frequency =
    input.frequency !== undefined
      ? buildFrequency(input.frequency, ctx.timezone, ctx.now)
      : {
          frequencyType: existing.frequencyType,
          frequency: existing.frequency ?? 1,
          frequencyMetadata: {
            ...(existing.frequencyMetadata ?? {}),
            timezone: existing.frequencyMetadata?.timezone ?? ctx.timezone,
          },
        };

  // Widened deliberately. ChoreListRow requires assignStrategy and assignees because
  // every measured list row carries them, but that type is a cast over wire JSON
  // rather than a checked fact, and this merge is the one place a dropped field is
  // unrecoverable. So both are still read as if they might be absent: assignedTo is
  // the fallback for one, the assignee count for the other.
  const row = existing as RawChore;

  const existingAssignees =
    row.assignees !== undefined
      ? row.assignees.map((a) => a.userId)
      : existing.assignedTo !== null && existing.assignedTo !== undefined
        ? [existing.assignedTo]
        : [];

  const replaced = input.assignees !== undefined ? resolveMemberIds(input.assignees, ctx.members) : undefined;
  const added = input.add_assignees !== undefined ? resolveMemberIds(input.add_assignees, ctx.members) : [];
  const assigneeIds = replaced ?? [...new Set([...existingAssignees, ...added])];

  const carriedStrategy: AssignStrategy = input.assign_strategy
    ? validateAssignStrategy(input.assign_strategy)
    : row.assignStrategy !== undefined
      ? validateAssignStrategy(row.assignStrategy)
      : assigneeIds.length > 0
        ? "keep_last_assigned"
        : "no_assignee";

  // Promoted only when the caller did not name a strategy, so an explicit choice is
  // still honored. Left alone, a chore carrying no_assignee with someone on it
  // reverts on the next completion: Donetick's next-assignee step maps that strategy
  // to nil and persists it, so the assignment lands, reports success, and is undone
  // the first time anyone completes the chore.
  const strategy: AssignStrategy =
    input.assign_strategy === undefined &&
    carriedStrategy === "no_assignee" &&
    assigneeIds.length > 0
      ? "keep_last_assigned"
      : carriedStrategy;

  const isRolling =
    input.reschedule_from !== undefined
      ? input.reschedule_from === "completion_date"
      : existing.isRolling === true;

  // A null due_date is not expressed here: PUT /chores/ ignores nextDueDate: null
  // and keeps the stored value, so emitting null would describe an edit the server
  // will not perform. editChore issues the clear against PUT /:id/dueDate instead,
  // and this body carries the current date so the two agree about the interim state.
  const parsedDueDate =
    input.due_date !== undefined && input.due_date !== null
      ? parseDueDate(input.due_date, ctx.now, ctx.timezone)
      // dueDateOf rather than a bare new Date: it exists because this same parse was
      // written unchecked three times, and this was the fourth site, the only one
      // still skipping it. An unparseable stored date reached toISOString below and
      // failed the whole edit with a message that was only the words "Invalid Date".
      : dueDateOf(existing.nextDueDate);
  const dueDate = parsedDueDate;
  // Against undefined, not folded into a ?? chain, for the reason points is: under
  // ?? an explicit null is nullish and falls through to the stored value, so the
  // window could be set but never removed. That matters more here than elsewhere,
  // since a window the caller cannot clear then permanently blocks clearing the due
  // date, and nothing tells them the combination is unreachable.
  const completionWindowValue =
    input.completion_window !== undefined
      ? input.completion_window
      : (existing.completionWindow ?? null);
  requireDueDateFor(dueDate, frequency.frequencyType, completionWindowValue);

  // subtasks replaces; add_subtasks appends. Without the second, the only way to add
  // a checklist item was to resend every existing one, which also unticked them all,
  // because buildSubtasks emits no ids and a null completedAt.
  const carried = carriedSubtasks(existing);
  const subTasks =
    input.subtasks !== undefined
      ? buildSubtasks(input.subtasks)
      : input.add_subtasks !== undefined
        ? [
            ...(carried ?? []),
            ...input.add_subtasks.map((name, index) => ({
              name,
              orderId: (carried?.length ?? 0) + index,
              completedAt: null,
            })),
          ]
        : carried;

  requireNonBlankName(input.name, "edit_chore");

  return {
    id: existing.id,
    // Deliberately the value from the merge base, not the current time: it says
    // "apply this on top of the version I read", which is the whole point. Omitted
    // rather than faked when the row carries none, since inventing one would ask
    // Donetick to compare against a version that never existed.
    ...(existing.updatedAt !== undefined ? { updatedAt: existing.updatedAt } : {}),
    name: input.name ?? existing.name,
    description: input.description ?? existing.description ?? "",
    nextDueDate: dueDate === null ? null : dueDate.toISOString(),
    frequencyType: frequency.frequencyType,
    frequency: frequency.frequency,
    frequencyMetadata: frequency.frequencyMetadata as unknown as Record<string, unknown>,
    assignStrategy: strategy,
    assignedTo: assigneeIds.includes(existing.assignedTo ?? -1) ? existing.assignedTo : (assigneeIds[0] ?? null),
    assignees: assigneeIds.map((userId) => ({ userId })),
    labelsV2: (existing.labelsV2 ?? []).map((label) => ({ id: label.id })),
    priority: priorityValue(input.priority, existing.priority),
    // Checked against undefined, not with ??, so an explicit null clears the value
    // instead of falling through to the existing one. The schema advertises points
    // as nullable, and a ?? chain there turned "remove the points" into a silent
    // no-op that still reported success, which is worse than not offering it.
    points: input.points !== undefined ? input.points : (existing.points ?? null),
    // Checked against undefined so an explicit null clears it, matching points. A ??
    // chain here made "take this out of the project" a silent no-op that reported
    // success, which is the defect the points fix repaired on the neighbouring field.
    projectId:
      input.project !== undefined
        ? resolveProjectId(input.project, ctx.projects)
        : (existing.projectId ?? null),
    isRolling,
    isPrivate: input.is_private ?? existing.isPrivate ?? false,
    requireApproval: input.require_approval ?? existing.requireApproval ?? false,
    completionWindow: completionWindowValue,
    ...mergeNotification(input.notify, existing),
    ...(subTasks ? { subTasks } : {}),
  };
}
