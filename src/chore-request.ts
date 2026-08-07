import { parseDueDate } from "@/dates";
import { buildFrequency, type FrequencyInput } from "@/frequency";
import { findMember, normalizeName } from "@/resolve";
import { PRIORITY_VALUE, type Member, type Project, type RawChore, type RawSubTask } from "@/types";

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

export interface EditInput extends Partial<Omit<CreateInput, "name" | "points">> {
  name?: string;
  // Null clears the value, which is why the merge checks this against undefined
  // rather than folding it into a ?? chain: under ?? an explicit null is nullish
  // and would fall through to the existing value exactly like an omitted field.
  points?: number | null;
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
        `"${name}" is not a member of this circle. Known members: ${members.map((m) => m.displayName).join(", ") || "none"}.`,
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
      `"${name}" is not a known project. Known projects: ${projects.map((p) => p.name).join(", ") || "none"}.`,
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
 * Donetick dereferences NextDueDate without a nil check in two places: the
 * completion handler when a chore has a completionWindow, and the skip scheduler's
 * adaptive arm. Either combination with no due date means the chore can be created
 * and then never completed or skipped, a 502 on every attempt, permanently.
 * Measured live for the completion-window case, including a window of 0.
 */
export function requireDueDateFor(
  dueDate: Date | null,
  frequencyType: string,
  completionWindow: number | null,
  isRolling = false,
): void {
  if (dueDate !== null) return;
  if (isRolling) {
    throw new Error(
      "A rolling chore needs a due date: it reschedules from its completion date, and Donetick binds " +
        'the two together. Turn rolling off first with reschedule_from: "due_date", or set a date ' +
        "rather than clearing it.",
    );
  }
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

/**
 * A due date is required whenever isRolling is set; Donetick binds them together.
 * Applied on both create and merge, so no path can produce isRolling with a null
 * nextDueDate.
 */
function ensureDueDateForRolling(dueDate: Date | null, isRolling: boolean, ctx: BuildContext): Date | null {
  if (isRolling && dueDate === null) {
    return parseDueDate("today", ctx.now, ctx.timezone);
  }
  return dueDate;
}

export function buildCreateRequest(input: CreateInput, ctx: BuildContext): ChoreRequestBody {
  const frequency = buildFrequency(input.frequency ?? { type: "once" }, ctx.timezone, ctx.now);
  const assigneeIds = resolveMemberIds(input.assignees, ctx.members);
  const isRolling = input.reschedule_from === "completion_date";

  const parsedDueDate = parseDueDate(input.due_date ?? null, ctx.now, ctx.timezone);
  const dueDate = ensureDueDateForRolling(parsedDueDate, isRolling, ctx);
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
    `"${existing.name}" is driven by a Donetick Thing. Editing it through this server would sever that link permanently, because Donetick drops the association on every edit and only restores it for a request that names the Thing. Edit this chore in the Donetick web UI. Every tool that rewrites the whole chore is blocked until then, reassign_chore included.`,
  );
}

/**
 * A chore whose stored recurrence Donetick cannot schedule. Reachable because this
 * server built "first saturday of every month" as day_of_the_month with days,
 * weekPattern and occurrences until 7d0940a, and the carry-forward branch spreads
 * frequencyMetadata wholesale, so an unrelated edit would re-send the broken shape
 * and report success. Measured: such a chore answers 500 on every completion, and
 * get_chore renders it as an ordinary monthly chore, so nothing else points at it.
 */
function assertSchedulableFrequency(existing: RawChore): void {
  const meta0 = (existing.frequencyMetadata ?? {}) as Record<string, unknown>;

  // An hourly interval carrying a time reschedules to the instant it is already at
  // from its second completion, so the chore sits permanently overdue while every
  // completion answers 200. Carrying that forward keeps it stuck.
  if (
    existing.frequencyType === "interval" &&
    meta0.unit === "hours" &&
    typeof meta0.time === "string" &&
    meta0.time.length > 0
  ) {
    throw new Error(
      `"${existing.name}" is an hourly chore carrying a time of day, which Donetick cannot advance: ` +
        "it resets the clock to that time before adding the hours, so the chore freezes on its " +
        'second completion. Pass frequency: {type: "interval", every: N, unit: "hours"} with no ' +
        "time to repair it, through edit_chore. Every tool that rewrites the whole chore is blocked until then, reassign_chore included.",
    );
  }

  const meta = (existing.frequencyMetadata ?? {}) as Record<string, unknown>;
  const nonEmptyArray = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
  const blocked = (detail: string, repair: string): never => {
    throw new Error(
      `"${existing.name}" has a recurrence Donetick cannot schedule: ${detail}, so every completion fails. ` +
        `${repair} Every tool that rewrites the whole chore is blocked until then, reassign_chore included.`,
    );
  };

  // Donetick's own validateFrequencyLogic is the authoritative list of these, and it
  // is dead code: its registration is commented out, so the binding accepts every
  // shape below and the failure surfaces later, from the scheduler, on completion.
  if (existing.frequencyType === "interval" && typeof meta.unit !== "string") {
    // Not a 500 like the others. scheduleNextDueDate dereferences Unit without a nil
    // check, and the router is built with gin.New() and no Recovery, so the panic
    // drops the connection and this arrives as a 502.
    blocked(
      "it is an interval with no unit, which crashes the request rather than failing it",
      'Pass frequency: {type: "interval", every: N, unit: "days"} through edit_chore to repair it.',
    );
  }

  if (existing.frequencyType === "days_of_the_week") {
    if (!nonEmptyArray(meta.days)) {
      blocked(
        "it is days_of_the_week with no days",
        'Pass frequency: {type: "days_of_the_week", days: ["monday"]} through edit_chore to repair it.',
      );
    }
    const pattern = meta.weekPattern;
    if (pattern === "week_of_month" || pattern === "week_of_quarter") {
      // getOccurrences reads either field, so either one being present is enough.
      if (!nonEmptyArray(meta.occurrences) && !nonEmptyArray(meta.weekNumbers)) {
        blocked(
          `it is a ${pattern} pattern with no occurrences`,
          `Pass frequency: {type: "days_of_the_week", days: ["saturday"], week_pattern: "${pattern}", occurrences: [1]} through edit_chore to repair it.`,
        );
      }
    }
  }

  if (existing.frequencyType !== "day_of_the_month") return;

  const hasWeekdays = nonEmptyArray(meta.days);
  if (hasWeekdays || !nonEmptyArray(meta.months)) {
    blocked(
      `it is day_of_the_month ${hasWeekdays ? "carrying weekday names" : "with no months"}`,
      'This server used to build "the first saturday of every month" that way. Pass frequency: ' +
        '{type: "days_of_the_week", days: ["saturday"], week_pattern: "week_of_month", occurrences: [1]} ' +
        "to repair it through edit_chore, or day_of_the_month with day_of_month and months.",
    );
  }

  // The day itself lives in `frequency`, not the metadata. Checked against the
  // scheduler's own bounds rather than against nullishness: 0 is not nullish, so a
  // chore stored with frequency 0 is carried forward verbatim and refused there.
  const day = existing.frequency;
  if (typeof day !== "number" || day <= 0 || day > 31) {
    blocked(
      `it is day_of_the_month with a day of ${String(day)}, outside the 1 to 31 Donetick accepts`,
      "Pass frequency: {type: \"day_of_the_month\", day_of_month: N, months: [...]} with a day in range through edit_chore to repair it.",
    );
  }
}

/**
 * GET /chores/:id/details omits assignStrategy, assignees, frequency,
 * frequencyMetadata, isRolling, isPrivate, labelsV2, notification,
 * notificationMetadata, points, and requireApproval, which is every field a write
 * requires. Merging onto it would silently drop recurrence, labels, points,
 * assignees, and the approval flag on every edit. Checking assignStrategy alone
 * would catch it, but three independent list-only fields being simultaneously
 * absent is a stronger signal that this is genuinely the wrong shape, rather than a
 * list row that happens to omit one optional field for a legitimate reason.
 */
function assertListRowShape(existing: RawChore): void {
  const looksLikeDetailsView =
    existing.assignStrategy === undefined &&
    existing.frequencyMetadata === undefined &&
    existing.labelsV2 === undefined;

  if (looksLikeDetailsView) {
    throw new Error(
      "mergeEditRequest received an object missing assignStrategy, frequencyMetadata, and " +
        "labelsV2 all at once. That is the shape of GET /chores/:id/details, not the " +
        "GET /chores/ list row. Merging onto /details would silently destroy recurrence, " +
        "labels, points, assignees, and the approval flag on this edit. Pass the list row " +
        "as `existing` instead.",
    );
  }
}

/**
 * Donetick has no partial update for most fields; PUT /api/v1/chores/ replaces the
 * whole object. The merge base must therefore be the /chores list row, never the
 * /details view or the trimmed ProjectedChore, or every field either of those drops
 * is destroyed on write.
 */
export function mergeEditRequest(existing: RawChore, input: EditInput, ctx: BuildContext): ChoreRequestBody {
  assertListRowShape(existing);
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

  // A list row always carries assignees, but assignedTo is treated as the
  // fallback source of truth here too: it is the field /details also has, so a
  // caller that hands in a single-assignee row missing the assignees array
  // (rather than a full /details object, which assertListRowShape above already
  // rejects) still keeps its one assignee instead of losing it.
  const existingAssignees =
    existing.assignees !== undefined
      ? existing.assignees.map((a) => a.userId)
      : existing.assignedTo !== null && existing.assignedTo !== undefined
        ? [existing.assignedTo]
        : [];

  const replaced = input.assignees !== undefined ? resolveMemberIds(input.assignees, ctx.members) : undefined;
  const added = input.add_assignees !== undefined ? resolveMemberIds(input.add_assignees, ctx.members) : [];
  const assigneeIds = replaced ?? [...new Set([...existingAssignees, ...added])];

  const carriedStrategy: AssignStrategy = input.assign_strategy
    ? validateAssignStrategy(input.assign_strategy)
    : existing.assignStrategy !== undefined
      ? validateAssignStrategy(existing.assignStrategy)
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
      : existing.nextDueDate === null
        ? null
        : new Date(existing.nextDueDate);
  const dueDate = ensureDueDateForRolling(parsedDueDate, isRolling, ctx);
  const completionWindowValue = input.completion_window ?? existing.completionWindow ?? null;
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
