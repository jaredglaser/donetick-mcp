import { z } from "zod";
import type { AssignStrategy, CreateInput, EditInput } from "@/chore-request";
import { endpoints } from "@/endpoints";
import { type FrequencyType, WEEK_PATTERNS } from "@/frequency";
import { resolveOne } from "@/resolve";
import { humanizeDueIn } from "@/time";
import type { DonetickService } from "@/service";
import {
  archiveChore,
  reassignChore,
  rescheduleChore,
  setPriority,
  unarchiveChore,
  type ArchiveInput,
  type ReassignInput,
  type RescheduleInput,
  type SetPriorityInput,
} from "@/tools/schedule";
import { createChore, deleteChore, editChore, type WriteContext } from "@/tools/write";
import type { Member, RawChore } from "@/types";
import { getChore, listChores, type ListArgs } from "@/tools/read";

export interface McpExtras {
  /** Present on a retry after the user answered a confirmation prompt. */
  confirmation?: { confirm: boolean };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /**
   * Present when the tool needs the caller's answer before it can proceed
   * (protocol revision 2026-07-28's multi-round-trip flow). content still
   * carries a text fallback of the same message, so a client on an older
   * protocol era, or a caller that ignores the sentinel, still sees the
   * question rather than a silently completed action. src/index.ts is the
   * only place this field is read; everywhere else it rides along unused.
   */
  confirmRequired?: { key: string; message: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, mcp?: McpExtras) => Promise<ToolResult>;
}

export interface ToolDeps {
  service: DonetickService;
  timezone: string;
  now: () => Date;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Every handler funnels through here so no tool ever rejects across the JSON-RPC transport. */
function guard(
  handler: (args: Record<string, unknown>, mcp?: McpExtras) => Promise<ToolResult>,
): (args: Record<string, unknown>, mcp?: McpExtras) => Promise<ToolResult> {
  return async (args, mcp) => {
    try {
      return await handler(args, mcp);
    } catch (error) {
      return fail(error);
    }
  };
}

// Local literal tuples for zod, since FREQUENCY_TYPES and ASSIGN_STRATEGIES are exported as
// readonly string[] (see the note on each) and z.enum needs a literal tuple to typecheck.
// A test in __tests__/index.test.ts asserts these agree with their source of truth so the
// two copies cannot silently drift.
export const FREQUENCY_TYPE_VALUES = [
  "once",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "adaptive",
  "interval",
  "days_of_the_week",
  "day_of_the_month",
  "trigger",
  "no_repeat",
] as const satisfies readonly FrequencyType[];

export const ASSIGN_STRATEGY_VALUES = [
  "no_assignee",
  "least_assigned",
  "least_completed",
  "random",
  "keep_last_assigned",
  "random_except_last_assigned",
  "round_robin",
] as const satisfies readonly AssignStrategy[];

const FREQUENCY_UNIT_VALUES = ["hours", "days", "weeks", "months", "years"] as const;

const PRIORITY_VALUES = ["P1", "P2", "P3", "P4", "none"] as const;

const priorityEnumSchema = z
  .enum(PRIORITY_VALUES)
  .describe("Donetick's priority scale is inverted: P1 is the most urgent, P4 is least urgent, none means unset.");

const frequencySchema = z.object({
  type: z
    .enum(FREQUENCY_TYPE_VALUES)
    .describe(
      '"Every 3 days" is type interval with every: 3 (every is required for interval). The fixed ' +
        "types daily, weekly, monthly, and yearly always step exactly one unit and ignore any count. " +
        'days_of_the_week repeats on specific weekdays via days. "First Saturday of every month" is ' +
        'type day_of_the_month with days: ["saturday"] and week_pattern: "week_of_month". trigger ' +
        "recurrence is not supported here; use the Donetick web UI for it.",
    ),
  every: z.number().int().positive().optional().describe("Count for type interval, e.g. 3 for every 3 days."),
  unit: z.enum(FREQUENCY_UNIT_VALUES).optional().describe("Unit for type interval. Defaults to days."),
  days: z
    .array(z.string())
    .optional()
    .describe("Weekday names, used by days_of_the_week and day_of_the_month."),
  months: z.array(z.string()).optional().describe("Month names, to restrict day_of_the_month further."),
  week_pattern: z
    .enum(WEEK_PATTERNS)
    .optional()
    .describe("For day_of_the_month: which occurrence of the weekday in days, e.g. week_of_month."),
  occurrences: z.array(z.number()).optional(),
  time: z.string().optional().describe("Time of day in HH:MM 24-hour format."),
});

const notifySchema = z.object({
  due_date: z.boolean().optional(),
  completion: z.boolean().optional(),
  predue: z.boolean().optional(),
  nagging: z.boolean().optional(),
  reminders: z
    .array(z.string())
    .max(5)
    .optional()
    .describe('Reminder offsets before the due date, like "30m", "1h", "2d". Donetick accepts at most 5.'),
});

const SCOPES = [
  "all",
  "overdue",
  "due_today",
  "due_this_week",
  "due_within_days",
  "unscheduled",
  "archived",
] as const;

/** Mirrors the keys Donetick's history endpoint actually returns; see corrections in the spec. */
interface RawHistoryRow {
  id: number;
  choreId: number;
  assignedTo: number | null;
  completedBy: number | null;
  dueDate: string | null;
  performedAt: string;
  notes: string | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  syncVersion?: number;
}

const MAX_HISTORY_DAYS = 90;
const DEFAULT_HISTORY_DAYS = 7;

/**
 * Task 13's zod schema also caps this, but that boundary is the MCP transport, not this
 * function's caller. Clamping here (rather than throwing) keeps a slightly-too-wide ask
 * useful instead of failing it outright, since the caller almost always just wants "as
 * much history as is reasonable to return."
 */
function clampHistoryDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HISTORY_DAYS;
  }
  return Math.min(Math.floor(value), MAX_HISTORY_DAYS);
}

function enrichHistoryRow(row: RawHistoryRow, chores: RawChore[], members: Member[]) {
  const chore = chores.find((c) => c.id === row.choreId);
  const completedBy =
    row.completedBy === null
      ? null
      : (members.find((m) => m.userId === row.completedBy)?.displayName ??
        `member #${row.completedBy} (unknown)`);

  return {
    chore: chore ? chore.name : `chore #${row.choreId} (deleted)`,
    completed_by: completedBy,
    performed_at: row.performedAt,
    due_date: row.dueDate,
    notes: row.notes,
  };
}

export function buildToolDefinitions(deps: ToolDeps): ToolDefinition[] {
  const { service, timezone, now } = deps;
  const writeCtx: WriteContext = { service, timezone, now };

  async function resolveChore(args: Record<string, unknown>): Promise<RawChore> {
    if (typeof args.chore_id === "number") {
      const all = await service.chores();
      const found = all.find((chore) => chore.id === args.chore_id);
      if (found) return found;
      // Not in the cached list (e.g. archived, or the cache is between refreshes).
      // A failure here means the id does not exist, but the details endpoint answers
      // that with a 500, which errors.ts reads as an instance fault. Say what is
      // actually true instead, or the user goes looking for an outage.
      try {
        return await service.choreDetails(args.chore_id);
      } catch {
        throw new Error(
          `No chore with id ${args.chore_id} exists on this account. Use list_chores to see what is there.`,
        );
      }
    }
    if (typeof args.name !== "string") {
      throw new Error("Pass either chore_id or name to identify the chore.");
    }
    const [all, members] = await Promise.all([service.chores(), service.members()]);
    return resolveOne(
      args.name,
      all,
      (chore) => chore.name,
      (chore) => {
        const due = chore.nextDueDate === null ? null : new Date(chore.nextDueDate);
        const who = members.find((m) => m.userId === chore.assignedTo)?.displayName ?? "unassigned";
        return `${humanizeDueIn(due, now())}, ${who}`;
      },
    );
  }

  return [
    {
      name: "list_chores",
      description:
        "List chores from Donetick with filters. Use scope=overdue for what is late, scope=due_today for what is due now, and scope=archived for chores that have been archived. Priority filters use Donetick's inverted scale where P1 is the most urgent and 'none' means unset. Returns a trimmed view; call get_chore for full detail.",
      inputSchema: {
        scope: z.enum(SCOPES).optional().describe("Which chores to include. Defaults to all."),
        days: z.number().int().positive().optional().describe("Window for scope=due_within_days."),
        project: z.string().optional(),
        priority: z.enum(["P1", "P2", "P3", "P4", "none"]).optional(),
        label: z.string().optional(),
        assignee: z.string().optional().describe("A member name, or 'unassigned'."),
        status: z
          .enum(["idle", "in_progress", "paused", "pending_approval"])
          .optional()
          .describe("Use pending_approval to find completions waiting on sign-off."),
        search: z.string().optional(),
        sort: z.enum(["due_date", "priority", "name"]).optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      handler: guard(async (args) => {
        const scope = (args as { scope?: string }).scope;
        // scope=archived fetches the uncached includeArchived variant instead of the
        // regular cached list, which excludes archived chores entirely. That fetch has
        // already narrowed the set, so it is passed to listChores as scope "all" rather
        // than "archived", which bucket() does not know how to filter by.
        const [chores, members, projects] = await Promise.all([
          scope === "archived" ? service.archivedChores() : service.chores(),
          service.members(),
          service.projects(),
        ]);
        const listArgs: ListArgs = scope === "archived" ? { ...(args as ListArgs), scope: "all" } : (args as ListArgs);
        return ok(listChores(listArgs, { chores, members, projects, now: now(), timezone }));
      }),
    },
    {
      name: "get_chore",
      description:
        "Fetch one chore in full, including its subtasks and last-completion history. Accepts chore_id or name. Prefer this over list_chores when the user asks about a specific chore.",
      inputSchema: {
        chore_id: z.number().int().optional(),
        name: z.string().optional(),
      },
      handler: guard(async (args) => {
        const resolved = await resolveChore(args);
        const [detail, members, projects] = await Promise.all([
          service.choreDetails(resolved.id),
          service.members(),
          service.projects(),
        ]);
        // The chore list and GET /details are different views of a chore, and neither is
        // a superset: assignStrategy, assignees, frequency(Metadata), isRolling,
        // isPrivate, labelsV2, notification(Metadata), points, and requireApproval live
        // only on the list row, while lastCompletedDate, lastCompletedBy,
        // totalCompletedCount, notes, duration, startTime, and timerUpdatedAt live only
        // on /details. Detail spreads last so its fields win, but since /details never
        // sets the list-only keys at all, the spread cannot clobber them with undefined.
        const merged: RawChore = { ...resolved, ...(detail as Partial<RawChore>) };
        return ok(getChore(merged, members, projects, now()));
      }),
    },
    {
      name: "list_activity",
      description:
        "Recent chore completions across the circle. Answers questions like 'when did I last do X', 'who did what this week', and 'what got done'. Defaults to the last 7 days.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .max(MAX_HISTORY_DAYS)
          .optional()
          .describe("How many days back to look. Defaults to 7, capped at 90."),
      },
      handler: guard(async (args) => {
        const days = clampHistoryDays(args.days);
        const [raw, chores, members] = await Promise.all([
          service.rawGet(endpoints.choreHistory(days, true)),
          service.chores(),
          service.members(),
        ]);
        const rows = Array.isArray(raw) ? (raw as RawHistoryRow[]) : [];
        return ok(rows.map((row) => enrichHistoryRow(row, chores, members)));
      }),
    },
    {
      name: "list_members",
      description:
        "Circle members with their roles and point totals. Use this to turn a person's name into the id other tools need, and to answer point-standing questions.",
      inputSchema: {},
      handler: guard(async () => ok(await service.members())),
    },
    {
      name: "list_projects",
      description:
        "Projects used to group chores. Use the returned names with the project filter on list_chores.",
      inputSchema: {},
      handler: guard(async () => ok(await service.projects())),
    },
    {
      name: "create_chore",
      description:
        "Create a new chore. \"Every 3 days\" is frequency type interval with every: 3; the fixed types " +
        "daily, weekly, monthly, and yearly always repeat exactly once per unit and ignore any count you " +
        "pass. Priority uses Donetick's inverted scale: P1 is the most urgent, P4 is least urgent, and " +
        "none means unset. Labels cannot be set here, since Donetick's label API is unreachable with a " +
        "token; create the chore without labels and add them from the Donetick web UI if needed.",
      inputSchema: {
        name: z.string().describe("The chore's name."),
        description: z.string().optional(),
        due_date: z
          .string()
          .nullable()
          .optional()
          .describe(
            'An RFC3339 timestamp, YYYY-MM-DD, or a phrase like "tomorrow", "in 3 days", or "next monday". Omit for no due date.',
          ),
        frequency: frequencySchema.optional().describe("Defaults to a one-time chore (type once) when omitted."),
        assign_strategy: z.enum(ASSIGN_STRATEGY_VALUES).optional(),
        reschedule_from: z
          .enum(["due_date", "completion_date"])
          .optional()
          .describe("completion_date makes this a rolling chore, due N units after each completion."),
        assignees: z.array(z.string()).optional().describe("Member names to assign to the chore."),
        project: z.string().optional(),
        priority: priorityEnumSchema.optional(),
        points: z.number().optional(),
        subtasks: z.array(z.string()).optional(),
        require_approval: z.boolean().optional(),
        is_private: z.boolean().optional(),
        completion_window: z.number().optional(),
        notify: notifySchema.optional(),
      },
      handler: guard(async (args) => ok(await createChore(args as unknown as CreateInput, writeCtx))),
    },
    {
      name: "edit_chore",
      description:
        "Edit an existing chore by chore_id. Every field you do not pass is preserved as it was; only the " +
        "fields you pass are changed. Pass due_date: null to clear the due date. assignees replaces the " +
        "full assignee list, while add_assignees adds to it without dropping anyone already assigned.",
      inputSchema: {
        chore_id: z.number().int().describe("The chore to edit."),
        name: z.string().optional().describe("New name. Omitted means keep the current name."),
        description: z.string().optional(),
        due_date: z
          .string()
          .nullable()
          .optional()
          .describe('An RFC3339 timestamp, YYYY-MM-DD, a phrase like "tomorrow", or null to clear it.'),
        frequency: frequencySchema.optional(),
        assign_strategy: z.enum(ASSIGN_STRATEGY_VALUES).optional(),
        reschedule_from: z.enum(["due_date", "completion_date"]).optional(),
        assignees: z.array(z.string()).optional().describe("Replaces the full assignee list."),
        add_assignees: z.array(z.string()).optional().describe("Adds to the existing assignee list."),
        project: z.string().optional(),
        priority: priorityEnumSchema.optional(),
        points: z.number().nullable().optional(),
        subtasks: z.array(z.string()).optional(),
        require_approval: z.boolean().optional(),
        is_private: z.boolean().optional(),
        completion_window: z.number().optional(),
        notify: notifySchema.optional(),
      },
      handler: guard(async (args) => ok(await editChore(args as unknown as EditInput & { chore_id?: number }, writeCtx))),
    },
    {
      name: "delete_chore",
      description:
        "Permanently delete a chore and its completion history. This asks for confirmation before " +
        "deleting: the first call reports what would be deleted, and a second call with the user's answer " +
        "actually deletes it. If the goal is only to stop seeing a chore while keeping its history, use " +
        "archive_chore instead. Only the chore's creator can delete it; Donetick rejects anyone else's " +
        "attempt.",
      inputSchema: {
        chore_id: z.number().int().optional(),
        name: z.string().optional(),
      },
      handler: guard(async (args, mcp) => {
        const resolved = await resolveChore(args);
        const outcome = await deleteChore({ chore_id: resolved.id }, writeCtx, mcp?.confirmation);
        if (outcome.kind === "confirm_required") {
          return {
            content: [{ type: "text", text: outcome.message }],
            confirmRequired: { key: "confirm", message: outcome.message },
          };
        }
        return ok(outcome);
      }),
    },
    {
      name: "reschedule_chore",
      description: "Change a chore's due date, or clear it.",
      inputSchema: {
        chore_id: z.number().int(),
        due_date: z
          .string()
          .nullable()
          .describe(
            'An RFC3339 timestamp, YYYY-MM-DD, a phrase like "tomorrow" or "next monday", or null to clear the due date.',
          ),
      },
      handler: guard(async (args) => ok(await rescheduleChore(args as unknown as RescheduleInput, writeCtx))),
    },
    {
      name: "reassign_chore",
      description:
        "Reassign a chore to a different member. Adding someone who is not already on the chore rewrites " +
        "the whole chore rather than just the assignee field, since Donetick's fast assignee endpoint only " +
        "accepts people already assigned to it.",
      inputSchema: {
        chore_id: z.number().int(),
        assignee: z.string().describe("The member's name."),
      },
      handler: guard(async (args) => ok(await reassignChore(args as unknown as ReassignInput, writeCtx))),
    },
    {
      name: "set_priority",
      description:
        "Set a chore's priority. Donetick's scale is inverted: P1 is the most urgent, P4 is the least " +
        "urgent, and none (0) means unset.",
      inputSchema: {
        chore_id: z.number().int(),
        priority: z
          .union([priorityEnumSchema, z.number().int().min(0).max(4)])
          .describe("A P-label or the equivalent 0-4 integer."),
      },
      handler: guard(async (args) => ok(await setPriority(args as unknown as SetPriorityInput, writeCtx))),
    },
    {
      name: "archive_chore",
      description:
        "Archive a chore. This is the answer to \"I do not need this one anymore\": the chore stops " +
        "appearing in active lists but its completion history is kept, unlike delete_chore. " +
        "unarchive_chore reverses it.",
      inputSchema: {
        chore_id: z.number().int(),
      },
      handler: guard(async (args) => ok(await archiveChore(args as unknown as ArchiveInput, writeCtx))),
    },
    {
      name: "unarchive_chore",
      description: "Restore a previously archived chore so it appears in active lists again.",
      inputSchema: {
        chore_id: z.number().int(),
      },
      handler: guard(async (args) => ok(await unarchiveChore(args as unknown as ArchiveInput, writeCtx))),
    },
  ];
}
