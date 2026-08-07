import { parseDueDate } from "@/dates";
import { buildFrequency, type FrequencyInput } from "@/frequency";
import { normalizeName } from "@/resolve";
import type { Member, Project, RawChore, RawSubTask } from "@/types";

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

// Exported as readonly string[], mirroring FREQUENCY_TYPES in frequency.ts, so a
// caller comparing against a plain string array with bun:test's toEqual (which
// fixes the expected type from actual) does not need a literal-union match.
export const ASSIGN_STRATEGIES: readonly string[] = ASSIGN_STRATEGIES_TUPLE;

const PRIORITY_VALUE: Record<string, number> = {
  none: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  p4: 4,
};

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
  project?: string;
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
  // Widened to allow an explicit null in tests and callers. See the "clearing a
  // field" note on mergeEditRequest: this module cannot distinguish an explicit
  // null from an omitted field, so passing null does not clear the value.
  points?: number | null;
  add_assignees?: string[];
}

export interface BuildContext {
  members: Member[];
  projects: Project[];
  now: Date;
  timezone: string;
}

export interface ChoreRequestBody {
  id?: number;
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
  labelsV2: Array<{ labelId: number }>;
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

function resolveMemberIds(names: string[] | undefined, members: Member[]): number[] {
  if (names === undefined) return [];
  return names.map((name) => {
    const wanted = normalizeName(name);
    const found = members.find(
      (m) => normalizeName(m.displayName) === wanted || normalizeName(m.username) === wanted,
    );
    if (!found) {
      throw new Error(
        `"${name}" is not a member of this circle. Known members: ${members.map((m) => m.displayName).join(", ") || "none"}.`,
      );
    }
    return found.userId;
  });
}

function resolveProjectId(name: string | undefined, projects: Project[]): number | null {
  if (name === undefined) return null;
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
    return { value: Number(parsed[1]), unit: parsed[2]! };
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
 * Carries the existing notification settings forward when the edit does not touch
 * them. buildNotification alone cannot do this: notify === undefined there means
 * "turn notifications off", which is correct for a create (nothing to carry from)
 * but would silently strip an existing chore's reminders on every edit that does
 * not mention notify.
 */
function mergeNotification(
  notify: NotifyInput | undefined,
  existing: RawChore,
): Pick<ChoreRequestBody, "notification" | "notificationMetadata"> {
  if (notify !== undefined) return buildNotification(notify);
  return {
    notification: existing.notification ?? false,
    ...(existing.notificationMetadata
      ? { notificationMetadata: existing.notificationMetadata as ChoreRequestBody["notificationMetadata"] }
      : {}),
  };
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
 * A due date is required whenever isRolling is set; Donetick binds them together.
 * Applied identically on create and merge so a rolling chore never ends up with a
 * null nextDueDate regardless of which path produced isRolling: true.
 */
function ensureDueDateForRolling(dueDate: Date | null, isRolling: boolean, ctx: BuildContext): Date | null {
  if (isRolling && dueDate === null) {
    return parseDueDate("today", ctx.now, ctx.timezone);
  }
  return dueDate;
}

export function buildCreateRequest(input: CreateInput, ctx: BuildContext): ChoreRequestBody {
  const frequency = buildFrequency(input.frequency ?? { type: "once" }, ctx.timezone);
  const assigneeIds = resolveMemberIds(input.assignees, ctx.members);
  const isRolling = input.reschedule_from === "completion_date";

  const parsedDueDate = parseDueDate(input.due_date ?? null, ctx.now, ctx.timezone);
  const dueDate = ensureDueDateForRolling(parsedDueDate, isRolling, ctx);

  const strategy: AssignStrategy = input.assign_strategy
    ? validateAssignStrategy(input.assign_strategy)
    : assigneeIds.length > 0
      ? "keep_last_assigned"
      : "no_assignee";

  return {
    name: input.name,
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
    completionWindow: input.completion_window ?? null,
    ...buildNotification(input.notify),
    ...(input.subtasks ? { subTasks: buildSubtasks(input.subtasks) } : {}),
  };
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

  if (!existing.id || existing.id <= 0) {
    throw new Error(`Cannot edit a chore with id ${existing.id}. The existing chore's id must be a positive number.`);
  }

  const frequency =
    input.frequency !== undefined
      ? buildFrequency(input.frequency, ctx.timezone)
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

  const strategy: AssignStrategy = input.assign_strategy
    ? validateAssignStrategy(input.assign_strategy)
    : existing.assignStrategy !== undefined
      ? validateAssignStrategy(existing.assignStrategy)
      : assigneeIds.length > 0
        ? "keep_last_assigned"
        : "no_assignee";

  const isRolling =
    input.reschedule_from !== undefined
      ? input.reschedule_from === "completion_date"
      : existing.isRolling === true;

  const parsedDueDate =
    input.due_date !== undefined
      ? parseDueDate(input.due_date, ctx.now, ctx.timezone)
      : existing.nextDueDate === null
        ? null
        : new Date(existing.nextDueDate);
  const dueDate = ensureDueDateForRolling(parsedDueDate, isRolling, ctx);

  const subTasks = input.subtasks !== undefined ? buildSubtasks(input.subtasks) : carriedSubtasks(existing);

  return {
    id: existing.id,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description ?? "",
    nextDueDate: dueDate === null ? null : dueDate.toISOString(),
    frequencyType: frequency.frequencyType,
    frequency: frequency.frequency,
    frequencyMetadata: frequency.frequencyMetadata as unknown as Record<string, unknown>,
    assignStrategy: strategy,
    assignedTo: assigneeIds.includes(existing.assignedTo ?? -1) ? existing.assignedTo : (assigneeIds[0] ?? null),
    assignees: assigneeIds.map((userId) => ({ userId })),
    labelsV2: (existing.labelsV2 ?? []).map((label) => ({ labelId: label.id })),
    priority: priorityValue(input.priority, existing.priority),
    points: input.points ?? existing.points ?? null,
    projectId: input.project !== undefined ? resolveProjectId(input.project, ctx.projects) : (existing.projectId ?? null),
    isRolling,
    isPrivate: input.is_private ?? existing.isPrivate ?? false,
    requireApproval: input.require_approval ?? existing.requireApproval ?? false,
    completionWindow: input.completion_window ?? existing.completionWindow ?? null,
    ...mergeNotification(input.notify, existing),
    ...(subTasks ? { subTasks } : {}),
  };
}
