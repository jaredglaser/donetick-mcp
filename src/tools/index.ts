import { z } from "zod";
import { endpoints } from "@/endpoints";
import { resolveOne } from "@/resolve";
import { humanizeDueIn } from "@/time";
import type { DonetickService } from "@/service";
import type { Member, RawChore } from "@/types";
import { getChore, listChores, type ListArgs } from "@/tools/read";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
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
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(error);
    }
  };
}

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

  async function resolveChore(args: Record<string, unknown>): Promise<RawChore> {
    if (typeof args.chore_id === "number") {
      const all = await service.chores();
      const found = all.find((chore) => chore.id === args.chore_id);
      if (found) return found;
      // Not in the cached list (e.g. archived, or the cache is between refreshes).
      return service.choreDetails(args.chore_id);
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
  ];
}
