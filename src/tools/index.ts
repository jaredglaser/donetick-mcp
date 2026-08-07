import { z } from "zod";
import { ASSIGN_STRATEGIES, type CreateInput, type EditInput } from "@/chore-request";
import { CONFIRM_KEY } from "@/confirm";
import { endpoints } from "@/endpoints";
import { DonetickError } from "@/errors";
import { FREQUENCY_TYPES, WEEK_PATTERNS } from "@/frequency";
import { resolveOne } from "@/resolve";
import { DUE_SCOPES, dueDateOf, humanizeDueIn } from "@/time";
import type { DonetickService } from "@/service";
import {
  approveChore,
  completeChore,
  nudgeChore,
  rejectChore,
  skipChore,
  undoChore,
  type ApprovalInput,
  type CompleteInput,
  type NudgeInput,
  type SkipInput,
  type UndoInput,
} from "@/tools/actions";
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
import { setSubtaskCompleted, type SetSubtaskInput } from "@/tools/subtasks";
import { createChore, deleteChore, editChore } from "@/tools/write";
import type { ToolContext } from "@/tools/context";
import { CHORE_HISTORY_STATUS, type Member, type RawChore } from "@/types";
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
   * (protocol revision 2026-07-28's multi-round-trip flow). content still carries a
   * text fallback of the same message, so a client on an older protocol era, or one
   * that ignores the sentinel, sees the question rather than a silently completed
   * action. Read only in src/index.ts.
   */
  confirmRequired?: { key: string; message: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, mcp?: McpExtras) => Promise<ToolResult>;
}

export type { ToolContext as ToolDeps } from "@/tools/context";

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  // A write that timed out or lost the connection says nothing about whether the
  // server acted on it. Reporting that as a flat failure reads as "it did not
  // happen", and the natural next move is a retry that duplicates the chore or
  // double-advances a completion.
  const caveat =
    error instanceof DonetickError && error.indeterminate
      ? " This request may or may not have been applied. Check with list_chores or get_chore before trying again."
      : "";
  return { content: [{ type: "text", text: `${message}${caveat}` }], isError: true };
}

/**
 * Every handler funnels through here so no tool ever rejects across the JSON-RPC
 * transport.
 *
 * It is also where invalidatesCache is honored. A 403, 404, or a 500 on an
 * id-scoped write all mean the cached list disagrees with the server about which
 * chores exist, and leaving it in place makes the next read repeat the same wrong
 * answer: the user is told a chore both exists and does not, until the TTL runs
 * out. Dropping it costs one refetch and only on an error path.
 */
function guardWith(
  service: DonetickService,
): (
  handler: (args: Record<string, unknown>, mcp?: McpExtras) => Promise<ToolResult>,
) => (args: Record<string, unknown>, mcp?: McpExtras) => Promise<ToolResult> {
  return (handler) => async (args, mcp) => {
    try {
      return await handler(args, mcp);
    } catch (error) {
      if (error instanceof DonetickError && error.invalidatesCache) {
        service.invalidateChores();
      }
      return fail(error);
    }
  };
}

/**
 * The tools that take an id and no name share this. The wording has to live
 * in the schema rather than in a handler's error: the SDK validates against the
 * schema before it calls the handler, so a caller passing a name gets zod's generic
 * rejection and never reaches the sentence explaining what to do instead.
 */
const choreIdSchema = z
  .number()
  .int()
  .describe(
    "The chore's numeric id. This tool does not take a name: call list_chores (with search to " +
      "narrow it) or get_chore first and pass the id it returns.",
  );

const FREQUENCY_UNIT_VALUES = ["hours", "days", "weeks", "months", "years"] as const;

const PRIORITY_VALUES = ["P1", "P2", "P3", "P4", "none"] as const;

const priorityEnumSchema = z
  .enum(PRIORITY_VALUES)
  .describe("Donetick's priority scale is inverted: P1 is the most urgent, P4 is least urgent, none means unset.");

const frequencySchema = z.object({
  type: z
    .enum(FREQUENCY_TYPES)
    .describe(
      '"Every 3 days" is type interval with every: 3 (every is required for interval). The fixed ' +
        "types daily, weekly, monthly, and yearly always step exactly one unit and ignore any count. " +
        "days_of_the_week repeats on specific weekdays via days, and takes week_pattern with " +
        'occurrences to pick one of them: "first saturday of every month" is days_of_the_week with ' +
        'days: ["saturday"], week_pattern: "week_of_month", occurrences: [1], and -1 means the last. ' +
        "day_of_the_month is a calendar day number instead, and needs day_of_month plus months. " +
        "trigger recurrence is not supported here; use the Donetick web UI for it.",
    ),
  every: z.number().int().positive().optional().describe("Count for type interval, e.g. 3 for every 3 days."),
  unit: z.enum(FREQUENCY_UNIT_VALUES).optional().describe("Unit for type interval. Defaults to days."),
  days: z
    .array(z.string())
    .optional()
    .describe("Weekday names, for days_of_the_week. day_of_the_month refuses them and takes day_of_month instead."),
  months: z.array(z.string()).optional().describe("Month names. Required by day_of_the_month, which cannot be scheduled without them, and used by nothing else."),
  week_pattern: z
    .enum(WEEK_PATTERNS)
    .optional()
    .describe(
      "For days_of_the_week: pick a particular occurrence of the weekday rather than every one. " +
        "week_of_month and week_of_quarter both require occurrences, and Donetick answers 500 on " +
        "every completion without them. every_week means every matching weekday and takes none.",
    ),
  occurrences: z
    .array(z.number())
    .optional()
    .describe(
      "Which occurrence of the weekday, counted inside the period week_pattern names. Requires " +
        "week_pattern: Donetick ignores occurrences without one and refuses them alongside " +
        "every_week. 1 is the first and -1 the last, and several may be given. The range is 1 to 5 " +
        "for week_of_month and 1 to 14 for week_of_quarter, which counts across the whole quarter.",
    ),
  day_of_month: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe("The calendar day for day_of_the_month, 1 to 31."),
  time: z.string().optional().describe(
      "Time of day in HH:MM 24-hour format. Donetick reads it only for interval, " +
        "days_of_the_week and day_of_the_month, and not for an hourly interval, where it freezes " +
        "the chore. For every other type set the hour through due_date.",
    ),
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
    .describe(
      'Reminder offsets before the due date, like "30m", "1h", "2d". Donetick accepts at most 5, ' +
        "and this is the only field here that produces a notification: the flags above are stored " +
        "but never read, so notify without reminders sends nothing.",
    ),
});

/**
 * The due-date scopes plus the one that changes which list is fetched rather than
 * how it is filtered. Derived from DUE_SCOPES so a scope cannot be advertised here
 * without bucket having a rule for it.
 */
const SCOPES = [...DUE_SCOPES, "archived"] as const;

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
 * The zod schema caps this too, but that boundary is the MCP transport rather than
 * this function's caller. Clamped rather than thrown so a slightly-too-wide ask
 * still returns as much history as is reasonable.
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

  // An archived chore keeps its history, which is the entire reason this server
  // steers users to archive rather than delete. Labelling those rows "(deleted)"
  // told them the safe operation had destroyed exactly what it preserves.
  const label = chore
    ? chore.isActive === false
      ? `${chore.name} (archived)`
      : chore.name
    : `chore #${row.choreId} (deleted)`;

  return {
    chore: label,
    // Named, not assumed. A rename writes a "rescheduled" row, and reporting every
    // row as a completion answered "when did I last do X" with the time X was
    // edited. Donetick writes one on every edit carrying a due date, which this
    // server now always sends, so they are common rather than rare.
    action: CHORE_HISTORY_STATUS[row.status] ?? `status ${row.status}`,
    completed_by: completedBy,
    performed_at: row.performedAt,
    due_date: row.dueDate,
    notes: row.notes,
  };
}

export function buildToolDefinitions(deps: ToolContext): ToolDefinition[] {
  const { service, timezone, now } = deps;
  const writeCtx: ToolContext = { service, timezone, now };
  const guard = guardWith(service);

  /**
   * includeArchived widens both the id and the name path. It is off by default
   * because an archived chore should not compete for a name with an active one,
   * and on for delete_chore, whose whole job reaches chores in either state.
   */
  async function resolveChore(
    args: Record<string, unknown>,
    { includeArchived = false }: { includeArchived?: boolean } = {},
  ): Promise<RawChore> {
    const pool = async (): Promise<RawChore[]> => {
      const active = await service.chores();
      if (!includeArchived) return active;
      const archived = await service.archivedChores();
      return [...active, ...archived];
    };

    if (typeof args.chore_id === "number") {
      const all = await pool();
      const found = all.find((chore) => chore.id === args.chore_id);
      if (found) return found;

      // Unfiltered, because a chore can be missing from the cached active list
      // without being archived: anything created or edited elsewhere within the
      // cache TTL. Searching only the archived subset left that case falling through
      // to /details, which omits every list-only field, and projectChore has no way
      // to say "unknown", so get_chore answered "every 1 days" for a three-weekly
      // chore and false for every flag.
      const anywhere = (await service.allChores()).find((chore) => chore.id === args.chore_id);
      if (anywhere) return anywhere;
      // /details is the not-found probe here, never a data source: it omits every
      // list-only field, and projectChore reports a default for each rather than
      // saying it does not know. A successful read means the chore exists but is
      // invisible to both lists, which this server cannot describe truthfully.
      try {
        await service.choreDetails(args.chore_id);
      } catch (error) {
        // Only the statuses that actually mean "not there". A bare catch turned a
        // timeout, a revoked token, or a genuine instance fault into "that chore
        // does not exist", which sends the user looking for data they were told was
        // gone. The 500 is in here because /details answers a missing id with one.
        const missing =
          error instanceof DonetickError && (error.status === 404 || error.status >= 500);
        if (!missing) throw error;
        throw new Error(
          `No chore with id ${args.chore_id} exists on this account. Use list_chores to see what is there.`,
        );
      }
      throw new Error(
        `Chore ${args.chore_id} exists but is not in this account's chore list, so this server cannot read the fields it needs to describe it. Use list_chores to find it by name.`,
      );
    }
    if (typeof args.name !== "string") {
      throw new Error("Pass either chore_id or name to identify the chore.");
    }
    const [all, members] = await Promise.all([pool(), service.members()]);
    return resolveOne(
      args.name,
      all,
      (chore) => chore.name,
      (chore) => {
        const due = dueDateOf(chore.nextDueDate);
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
        days: z.number().int().positive().optional().describe(
          "The window size for scope=due_within_days, and read only with that scope. Passing days " +
            "with any other scope, or with none, changes nothing: you get the full scope you asked " +
            "for, not an N-day window.",
        ),
        project: z.string().optional(),
        priority: z.enum(["P1", "P2", "P3", "P4", "none"]).optional(),
        label: z.string().optional(),
        assignee: z.string().optional().describe(
          "A member name, or 'unassigned'. There is no 'me': this server cannot resolve the caller " +
            "to a member, so ask which member they are before filtering by person.",
        ),
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
        include_all_actions: z
          .boolean()
          .optional()
          .describe(
            "Include skips, rejections, timer starts, pending approvals and reschedules as well as " +
              "completions. Off by default, because a reschedule is written on every edit and would " +
              "read as a completion.",
          ),
      },
      handler: guard(async (args) => {
        const days = clampHistoryDays(args.days);
        const [raw, chores, members] = await Promise.all([
          service.rawGet(endpoints.choreHistory(days, true)),
          service.chores(),
          service.members(),
        ]);
        const rows = Array.isArray(raw) ? (raw as RawHistoryRow[]) : [];

        // History outlives archiving, so a row whose chore is not in the active
        // list is usually archived rather than deleted. The archived list is an
        // uncached request, so it is fetched only when a row actually misses.
        const missing = rows.some((row) => !chores.some((chore) => chore.id === row.choreId));
        const pool = missing ? [...chores, ...(await service.archivedChores())] : chores;

        const enriched = rows.map((row) => enrichHistoryRow(row, pool, members));
        return ok(
          args.include_all_actions === true
            ? enriched
            : enriched.filter((entry) => entry.action === "completed"),
        );
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
            'An RFC3339 timestamp, YYYY-MM-DD, or a phrase like "tomorrow", "in 3 days", or "next monday". A bare date or a phrase carries no time of day and resolves to 09:00 local; to set a different hour pass a full timestamp with an offset, like "2026-08-07T07:00:00-04:00". Omit for no due date.',
          ),
        frequency: frequencySchema.optional().describe("Defaults to a one-time chore (type once) when omitted."),
        assign_strategy: z.enum(ASSIGN_STRATEGIES).optional(),
        reschedule_from: z
          .enum(["due_date", "completion_date"])
          .optional()
          .describe("completion_date makes this a rolling chore, due N units after each completion."),
        assignees: z.array(z.string()).optional().describe("Member names to assign to the chore."),
        project: z.string().optional(),
        priority: priorityEnumSchema.optional(),
        points: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Points awarded on completion, a positive whole number. Donetick's ledger never awards " +
              "zero or a negative value, so a chore stored with one silently pays nothing.",
          ),
        subtasks: z.array(z.string()).optional(),
        require_approval: z.boolean().optional(),
        is_private: z.boolean().optional(),
        completion_window: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Hours before the due date within which the chore can be completed. Donetick's own " +
              "model comment says seconds; its handler multiplies by hours, and the handler is " +
              "what runs. A chore with a completion window also needs a due date. There is no " +
              "way to express 'no window' with a number: 0 sets a real window of zero hours, " +
              "which makes the chore uncompletable. Omit the field instead.",
          ),
        notify: notifySchema.optional(),
      },
      handler: guard(async (args) => ok(await createChore(args as unknown as CreateInput, writeCtx))),
    },
    {
      name: "edit_chore",
      description:
        "Edit an existing chore by chore_id. Every field you do not pass is preserved as it was; only the " +
        "fields you pass are changed. Pass due_date: null to clear the due date. assignees replaces the " +
        "full assignee list, while add_assignees adds to it without dropping anyone already assigned." +
        "Labels cannot be changed here: Donetick's label API needs session auth an API token cannot " +
        "provide, so a labels field is ignored and the edit still reports success. Add or remove a label " +
        "in the Donetick web UI.",
      inputSchema: {
        chore_id: z.number().int().describe("The chore to edit."),
        name: z
          .string()
          .optional()
          .describe(
            "Renames the chore. Pass this only when a different name was asked for. chore_id " +
              "already says which chore this is, so passing the current name here to identify it " +
              "rewrites the name to whatever wording or casing you typed.",
          ),
        description: z.string().optional(),
        due_date: z
          .string()
          .nullable()
          .optional()
          .describe('An RFC3339 timestamp, YYYY-MM-DD, a phrase like "tomorrow", or null to clear it. A bare date or a phrase resolves to 09:00 local; pass a full timestamp with an offset to set a different hour.'),
        frequency: frequencySchema.optional(),
        assign_strategy: z.enum(ASSIGN_STRATEGIES).optional(),
        reschedule_from: z.enum(["due_date", "completion_date"]).optional(),
        assignees: z
          .array(z.string())
          .optional()
          .describe(
            "Replaces the full assignee list. To leave a chore with nobody on it pass [] together " +
              'with assign_strategy: "no_assignee"; an empty list on its own leaves the old strategy ' +
              "in place and Donetick picks someone again on the next completion.",
          ),
        add_assignees: z.array(z.string()).optional().describe("Adds to the existing assignee list."),
        project: z
          .string()
          .nullable()
          .optional()
          .describe("The project to move the chore into, or null to take it out of its project."),
        priority: priorityEnumSchema.optional(),
        points: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Points awarded on completion, a positive whole number, or null to remove them."),
        subtasks: z
          .array(z.string())
          .optional()
          .describe(
            "Replaces the whole checklist. Any item not in this list is removed, and every item in " +
              "it comes back unchecked, including ones already ticked. To add an item without " +
              "disturbing the rest use add_subtasks; to tick or untick one use set_subtask_completed.",
          ),
        add_subtasks: z
          .array(z.string())
          .optional()
          .describe("Appends checklist items, keeping the existing ones and their ticked state."),
        require_approval: z.boolean().optional(),
        is_private: z.boolean().optional(),
        completion_window: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "Hours before the due date within which the chore can be completed. Donetick's own " +
              "model comment says seconds; its handler multiplies by hours, and the handler is " +
              "what runs. A chore with a completion window also needs a due date. Pass null to " +
              "remove the window; 0 is not 'off' and sets a real window of zero hours, which " +
              "makes the chore uncompletable.",
          ),
        notify: notifySchema
          .optional()
          .describe(
            "Replaces the whole notification setting. Any flag left out becomes false and any " +
              "reminder offset left out is dropped, so pass every flag and reminder you want kept.",
          ),
      },
      handler: guard(async (args) => ok(await editChore(args as unknown as EditInput & { chore_id?: number }, writeCtx))),
    },
    {
      name: "delete_chore",
      description:
        "Permanently delete a chore and its completion history. This asks for confirmation before " +
        "deleting: the first call reports what would be deleted, and a second call with the user's answer " +
        "actually deletes it. If the goal is only to stop seeing a chore while keeping its history, use " +
        "archive_chore instead. Archived chores can be deleted too, without unarchiving them first. " +
        "Only the chore's creator can delete it; Donetick rejects anyone else's attempt.",
      inputSchema: {
        chore_id: z.number().int().optional(),
        name: z.string().optional(),
      },
      handler: guard(async (args, mcp) => {
        // Resolved once, here, and handed over whole. Passing only the id made
        // deleteChore look the same chore up a second time, and across the two
        // elicitation rounds that doubled again.
        const resolved = await resolveChore(args, { includeArchived: true });
        const outcome = await deleteChore(resolved, writeCtx, mcp?.confirmation);
        if (outcome.kind === "confirm_required") {
          return {
            content: [{ type: "text", text: outcome.message }],
            confirmRequired: { key: CONFIRM_KEY, message: outcome.message },
          };
        }
        return ok(outcome);
      }),
    },
    {
      name: "reschedule_chore",
      description: "Change a chore's due date, or clear it.",
      inputSchema: {
        chore_id: choreIdSchema,
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
        "Reassign a chore to a different member. This sets who the current occurrence belongs to and " +
        "does not remove anyone already on it; use edit_chore with assignees to set the full list. To " +
        "leave a chore with nobody on it, call edit_chore with assignees: [] and assign_strategy set " +
        "to no_assignee. Adding someone not already on the chore rewrites the whole chore rather than " +
        "just the assignee field, since Donetick's fast assignee endpoint only accepts people already " +
        "assigned to it.",
      inputSchema: {
        chore_id: choreIdSchema,
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
        chore_id: choreIdSchema,
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
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await archiveChore(args as unknown as ArchiveInput, writeCtx))),
    },
    {
      name: "unarchive_chore",
      description: "Restore a previously archived chore so it appears in active lists again.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await unarchiveChore(args as unknown as ArchiveInput, writeCtx))),
    },
    {
      name: "complete_chore",
      description:
        "Mark a chore complete. Pass completed_at (e.g. \"yesterday\") to backdate a completion for " +
        "something already done; a time in the future is rejected. If the chore's require_approval is " +
        "set, Donetick records this as a request awaiting sign-off rather than a completion, and the " +
        "result reports pending_approval rather than claiming success. Returns the chore's id. " +
        "Backdating a rolling chore (one that reschedules from its completion " +
        "date rather than its due date) also moves its next occurrence earlier.",
      inputSchema: {
        chore_id: choreIdSchema,
        completed_at: z
          .string()
          .optional()
          .describe('When it was actually done, e.g. "yesterday" or an RFC3339 timestamp. Defaults to now.'),
        note: z.string().optional(),
        completed_by: z.string().optional().describe("A member name, if completing on someone else's behalf."),
      },
      handler: guard(async (args) => ok(await completeChore(args as unknown as CompleteInput, writeCtx))),
    },
    {
      name: "skip_chore",
      description:
        "Skip a recurring chore's current occurrence, advancing it to its next due date without " +
        "recording it as completed.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await skipChore(args as unknown as SkipInput, writeCtx))),
    },
    {
      name: "undo_chore",
      description:
        "Undo the most recent completion of a chore. Expect this to fail: on the Donetick version this " +
        "server was verified against, the endpoint answers \"no recent action found\" immediately after " +
        "both a completion and a skip, well inside its own five-minute window. To put a wrongly " +
        "completed chore back, use reschedule_chore to restore the due date. Takes chore_id only, " +
        "never a name: a just-completed one-off chore drops out of " +
        "the active list this server searches by name. Use the id complete_chore returned.",
      inputSchema: {
        chore_id: z.number().int().describe("The id complete_chore returned."),
      },
      handler: guard(async (args) => ok(await undoChore(args as unknown as UndoInput, writeCtx))),
    },
    {
      name: "approve_chore",
      description:
        "Approve a chore completion that is waiting on sign-off, for a chore whose require_approval is " +
        "set (status pending_approval). Requires an admin or manager role in the circle.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await approveChore(args as unknown as ApprovalInput, writeCtx))),
    },
    {
      name: "reject_chore",
      description:
        "Reject a chore completion that is waiting on sign-off, for a chore whose require_approval is " +
        "set (status pending_approval). Requires an admin or manager role in the circle.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await rejectChore(args as unknown as ApprovalInput, writeCtx))),
    },
    {
      name: "nudge_chore",
      description:
        "Send a reminder nudge for a chore to its assignee. Needs another member in the circle: Donetick " +
        "refuses to let you nudge yourself. The nudge reaches registered mobile devices only, not " +
        "Telegram or Pushover, so it can silently fail to deliver even when this call succeeds.",
      inputSchema: {
        chore_id: choreIdSchema,
        message: z.string().optional(),
        all_assignees: z.boolean().optional().describe("Nudge every assignee rather than just one."),
      },
      handler: guard(async (args) => ok(await nudgeChore(args as unknown as NudgeInput, writeCtx))),
    },
    {
      name: "set_subtask_completed",
      description:
        "Check or uncheck one item on a chore's checklist, matched by name. Use get_chore first to see " +
        "the current subtask names and their state. Subtask completion resets at the start of each cycle " +
        "on a recurring chore.",
      inputSchema: {
        chore_id: choreIdSchema,
        subtask: z.string().describe("The checklist item's name, or a distinguishing substring of it."),
        completed: z.boolean().describe("true to check the item, false to uncheck it."),
      },
      handler: guard(async (args) => ok(await setSubtaskCompleted(args as unknown as SetSubtaskInput, writeCtx))),
    },
  ];
}
