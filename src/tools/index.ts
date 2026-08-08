import { z } from "zod";
import { ASSIGN_STRATEGIES, type CreateInput, type EditInput } from "@/chore-request";
import { CONFIRM_KEY } from "@/confirm";
import { endpoints } from "@/endpoints";
import { DonetickError } from "@/errors";
import { FREQUENCY_TYPES, FREQUENCY_UNITS, WEEK_PATTERNS } from "@/frequency";
import { resolveOne, safeName } from "@/resolve";
import { DUE_SCOPES, addDays, dueDateOf, humanizeDueIn, startOfDay } from "@/time";
import { expectArray } from "@/service";
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
import { isMissingChoreError, loadChoreById } from "@/tools/chore-lookup";
import type { ToolContext } from "@/tools/context";
import {
  CHORE_HISTORY_STATUS,
  CHORE_STATUS_NAMES,
  isArchivedChore,
  MAX_PRIORITY,
  MIN_PRIORITY,
  PRIORITY_INPUT_VALUES,
  type ChoreListRow,
  type Member,
  type RawChore,
} from "@/types";
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
   * (protocol revision 2026-07-28's multi-round-trip flow). Read only in
   * src/index.ts, which turns it into inputRequired and drops content on that path,
   * so the message here is the only copy the caller sees. There is no text fallback;
   * an older protocol era is covered by the SDK's legacy shim, not by this type.
   */
  confirmRequired?: { key: string; message: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, mcp?: McpExtras) => Promise<ToolResult>;
}

/**
 * The hints a client uses to decide what it may do on the caller's behalf: which
 * tools it can auto-approve, which it should warn about, and which it can safely
 * retry. Without them list_chores and delete_chore look alike to a client, and on
 * one that declares no elicitation capability these are the only remaining guard on
 * the destructive path, since the confirmation prompt cannot be shown at all.
 *
 * openWorldHint is false throughout: every tool talks to one known Donetick instance.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/**
 * Same call, same end state, so a client may retry one that timed out.
 *
 * destructiveHint is stated rather than omitted: the spec defaults it to true for
 * anything not read-only, so leaving it out made every write here reach a client as
 * indistinguishable from delete_chore, which is the distinction these exist to draw.
 */
const IDEMPOTENT: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Removes or overwrites something the caller cannot get back from here. */
const DESTRUCTIVE: ToolAnnotations = { destructiveHint: true, openWorldHint: false };

/** Changes state, but only ever adds to it. */
const ADDITIVE: ToolAnnotations = { destructiveHint: false, openWorldHint: false };


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

const priorityEnumSchema = z
  .enum(PRIORITY_INPUT_VALUES)
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
        "trigger recurrence is not supported here; use the Donetick web UI for it. " +
        "A second caveat, for monthly and a months-unit interval specifically: Donetick adds a " +
        "month with Go's date arithmetic, which normalises September 31 to October 1, so a chore " +
        "due the 29th, 30th or 31st rolls forward into the next month on its first completion and " +
        "stays there. A chore due the 31st of August becomes a 1st-of-the-month chore and skips " +
        "September entirely. day_of_the_month handles month lengths properly and is the right " +
        "choice for a fixed calendar day. " +
        "One caveat that applies to all of them except days_of_the_week and yearly: Donetick " +
        "reschedules by adding elapsed time rather than by calendar, so a recurring chore drifts an " +
        "hour at each daylight-saving transition. A 9am daily chore becomes an 8am one from the " +
        "first completion after the autumn change. days_of_the_week holds its time of day across " +
        "the transition, so prefer it for anything that should stay at a particular hour. " +
        "The remaining three: once and no_repeat both mean a one-off that never recurs, and once " +
        "is the default, so prefer it. adaptive learns the interval from how the chore is actually " +
        "completed and requires a due date; do not use it unless the user asks for it by name, " +
        "since an adaptive chore that later loses its due date becomes permanently unskippable.",
    ),
  every: z.number().int().positive().optional().describe("Count for type interval, e.g. 3 for every 3 days."),
  unit: z.enum(FREQUENCY_UNITS).optional().describe("Unit for type interval. Defaults to days."),
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
        "for week_of_month and 1 to 13 for week_of_quarter, which counts across the whole quarter.",
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
        "the chore. For every other type set the hour through due_date. The stored time is a fixed " +
        "offset rather than a wall clock, so outside days_of_the_week it shifts by an hour at each " +
        "daylight-saving transition: 18:30 set in summer fires at 17:30 through the winter.",
    ),
});

const INERT_FLAG =
  "Stored by Donetick and read by nothing. Its notification planner reads only the reminder " +
  "templates, so setting this alone sends nothing. Kept because Donetick's own web UI writes it.";

const notifySchema = z.object({
  due_date: z.boolean().optional().describe(INERT_FLAG),
  completion: z.boolean().optional().describe(INERT_FLAG),
  predue: z.boolean().optional().describe(INERT_FLAG),
  nagging: z.boolean().optional().describe(INERT_FLAG),
  reminders: z
    .array(z.string())
    .max(5)
    .optional()
    .describe(
      'Reminder offsets before the due date, like "30m", "1h", "2d". Donetick accepts at most 5, ' +
        "and this is the only field here that produces a notification: the four flags above are " +
        "stored but never read, so notify without reminders sends nothing. Two more cases send " +
        "nothing whatever you set here, because the planner returns early on both: a chore with no " +
        "due date, and a trigger recurrence. get_chore reports when a chore is in one of them.",
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
  /** Null on a timer-start row, which Donetick writes before anything is performed. */
  performedAt: string | null;
  notes: string | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  syncVersion?: number;
}

const MAX_HISTORY_DAYS = 90;
const DEFAULT_HISTORY_DAYS = 7;

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
  // safeName on both branches, so that what a row reports does not change shape with
  // the chore's archived state. Not an injection fix: this value is serialized by
  // ok() through JSON.stringify, which escapes a newline. The vector safeName exists
  // for is a thrown Error, which fail() renders as raw text.
  const label = chore
    ? isArchivedChore(chore)
      ? `${safeName(chore.name)} (archived)`
      : safeName(chore.name)
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

/**
 * How many days back Donetick must be asked for so its own filter cannot cut inside
 * the calendar window list_activity applies afterward.
 *
 * Its filter is `updated_at > now - limit days` on the server's UTC clock; ours is a
 * calendar cutoff in the caller's zone. The two do not line up, and a local day is
 * not always 24 hours, so the span is measured rather than assumed.
 */
function serverDayReach(days: number, now: Date, timezone: string): number {
  const cutoff = startOfDay(addDays(now, -(days - 1), timezone), timezone).getTime();
  const spanDays = (now.getTime() - cutoff) / 86_400_000;
  return Math.ceil(spanDays) + 1;
}

export function buildToolDefinitions(deps: ToolContext): ToolDefinition[] {
  const { service, timezone, now } = deps;
  const guard = guardWith(service);

  /**
   * The name path only. An id goes to loadChoreById, which is the single loader
   * every other tool uses and which already reaches archived chores through the
   * unfiltered list, so includeArchived says nothing about it.
   *
   * includeArchived is off by default because an archived chore should not compete
   * for a name with an active one, and on for delete_chore, whose whole job reaches
   * chores in either state.
   */
  async function resolveChore(
    args: Record<string, unknown>,
    { includeArchived = false }: { includeArchived?: boolean } = {},
  ): Promise<ChoreListRow> {
    if (typeof args.chore_id === "number") {
      return loadChoreById(args.chore_id, deps);
    }
    if (typeof args.name !== "string") {
      throw new Error("Pass either chore_id or name to identify the chore.");
    }
    const pool = async (): Promise<ChoreListRow[]> => {
      const active = await service.chores();
      if (!includeArchived) return active;
      const archived = await service.archivedChores();
      return [...active, ...archived];
    };
    const [all, members] = await Promise.all([pool(), service.members()]);
    return resolveOne(
      args.name,
      all,
      (chore) => chore.name,
      (chore) => {
        const due = dueDateOf(chore.nextDueDate);
        const who = members.find((m) => m.userId === chore.assignedTo)?.displayName ?? "unassigned";
        // resolveOne sanitizes the hint it is handed, so this is the second pass and
        // safeName is idempotent. It is here so the property holds at the site rather
        // than one call away, which is the only form a check can see.
        return `${humanizeDueIn(due, now())}, ${safeName(who)}`;
      },
    );
  }

  return [
    {
      name: "list_chores",
      annotations: READ_ONLY,
      description:
        "List chores from Donetick with filters. Use scope=overdue for what is late, scope=due_today for what is due now, and scope=archived for chores that have been archived. Priority filters use Donetick's inverted scale where P1 is the most urgent and 'none' means unset. Returns a trimmed view; call get_chore for full detail.",
      inputSchema: {
        scope: z.enum(SCOPES).optional().describe("Which chores to include. Defaults to all."),
        days: z.number().int().positive().max(3650).optional().describe(
          "The window size for scope=due_within_days, and read only with that scope. Passing days " +
            "with any other scope, or with none, changes nothing: you get the full scope you asked " +
            "for, not an N-day window. Capped at ten years, past which Temporal's arithmetic " +
            "throws a RangeError that would surface as an opaque tool failure.",
        ),
        project: z.string().optional(),
        priority: priorityEnumSchema.optional(),
        label: z.string().optional(),
        assignee: z.string().optional().describe(
          "A member name, or 'unassigned'. There is no 'me': this server cannot resolve the caller " +
            "to a member, so ask which member they are before filtering by person.",
        ),
        status: z
          .enum(CHORE_STATUS_NAMES)
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
      annotations: READ_ONLY,
      description:
        "Fetch one chore in full, including its subtasks and last-completion history. Accepts chore_id or name. Prefer this over list_chores when the user asks about a specific chore.",
      inputSchema: {
        chore_id: z.number().int().optional(),
        name: z.string().optional(),
      },
      handler: guard(async (args) => {
        // The list row is refetched, not taken from the cache. /details carries none
        // of the ChoreListRow-only fields, so points, requires_approval, is_private,
        // is_rolling, assign_strategy, assignees, labels, project and notifications
        // all come from the list, and every one of them was served up to a TTL stale
        // and stated as fact. Measured: points read 3 while the chore held 99, and
        // notifications read "off" on a chore with a reminder set. This is the tool
        // every other description points at for checking state, so it is the one
        // place a refetch is worth its request.
        service.invalidateChores();
        const resolved = await resolveChore(args);
        const [members, projects] = await Promise.all([service.members(), service.projects()]);

        // Diagnosed rather than surfaced. On a cache hit the id resolves out of a
        // stale list without ever reaching loadChoreById's probe, so a chore deleted
        // elsewhere reached here as a bare instance error. The cache is invalidated
        // too: nothing else on this path writes, so the same wrong answer would
        // otherwise repeat for the rest of the TTL.
        let detail: Partial<RawChore>;
        try {
          detail = (await service.choreDetails(resolved.id)) as Partial<RawChore>;
        } catch (error) {
          if (!isMissingChoreError(error)) throw error;
          service.invalidateChores();
          throw new Error(
            `No chore with id ${resolved.id} exists on this account any more. It was in the chore list this server just read, so it was most likely deleted in the last few seconds. Use list_chores to see what is there.`,
          );
        }
        // ChoreListRow and ChoreDetails are different views of a chore, and neither is
        // a superset of the other; the two types spell out which field lives where.
        // Detail spreads last so its fields win, but since /details never sets the
        // list-only keys at all, the spread cannot clobber them with undefined.
        const merged: RawChore = { ...resolved, ...detail };
        return ok(getChore(merged, members, projects, now()));
      }),
    },
    {
      name: "list_activity",
      annotations: READ_ONLY,
      description:
        "Recent chore completions across the circle. Answers questions like 'when did I last do X', 'who did what this week', and 'what got done'. Defaults to the last 7 days.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .max(MAX_HISTORY_DAYS)
          .optional()
          .describe(
            "How many calendar days back to look, in your timezone, the same unit list_chores uses. Defaults to 7, " +
              "capped at 90. Donetick filters on its own UTC clock and this server filters by calendar " +
              "day in yours, so it asks for a wider window than requested and narrows the result.",
          ),
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
        // The schema is the only bound: days is int().positive().max(90) there, and
        // the SDK validates before the handler runs, so a second clamp here could
        // only ever disagree with it.
        const days = typeof args.days === "number" ? args.days : DEFAULT_HISTORY_DAYS;
        const [raw, chores, members] = await Promise.all([
          // Derived from the cutoff, not from days. Donetick's `limit` is a day count
          // filtering `updated_at > now - limit` on its own UTC clock, so it has to
          // reach at least as far back as the calendar window below or the server
          // cuts inside it and drops rows this filter would have kept. days + 1 was
          // measured to run up to an hour short on a daylight-saving fall-back day,
          // where a local day is 25 hours; ceil of the real span plus one covers that
          // and any zone offset without pretending to know the shape of either.
          service.rawGet(endpoints.choreHistory(serverDayReach(days, now(), timezone), true)),
          service.chores(),
          service.members(),
        ]);
        // Refused rather than defaulted to an empty list, which is the same rule
        // src/time.ts holds for a scope and src/service.ts for every other array:
        // "nothing happened this week" is an answer, and a proxy rewriting the
        // response must not be able to produce it.
        const all = expectArray<RawHistoryRow>(raw, "chore history");

        // Narrowed here because Donetick's own filter is the wrong shape, not absent.
        // `limit` is a day count against `updated_at` on the server's UTC clock
        // (handler.go:2818, repository.go:911); `days`, `since`, `offset` and `page`
        // really are ignored. An earlier reading called all of them ignored, because
        // the probe behind it completed one chore twice in the same second, so both
        // rows carried the same `updated_at` and no day filter could separate them.
        //
        // Rows with no performedAt are kept: a timer start carries none, and it is
        // an action the caller asked about rather than an old one.
        // Calendar days in the caller's zone, the same unit list_chores means by
        // `days`. A rolling days * 86_400_000 window made one parameter name mean two
        // things: asking for 1 day of activity at 09:00 would drop what was done at
        // 08:00 yesterday, which is a thing a person would call yesterday.
        // -(days - 1), so days: 1 is today and days: 7 is today and the six before it.
        const cutoff = startOfDay(addDays(now(), -(days - 1), timezone), timezone).getTime();
        const rows = all.filter((row) => {
          const at = dueDateOf(row.performedAt);
          return at === null || at.getTime() >= cutoff;
        });

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
      annotations: READ_ONLY,
      description:
        "Circle members with their roles and point totals. Use this to turn a person's name into the id other tools need, and to answer point-standing questions.",
      inputSchema: {},
      handler: guard(async () => ok(await service.members())),
    },
    {
      name: "list_projects",
      annotations: READ_ONLY,
      description:
        "Projects used to group chores. Use the returned names with the project filter on list_chores.",
      inputSchema: {},
      handler: guard(async () => ok(await service.projects())),
    },
    {
      name: "create_chore",
      annotations: ADDITIVE,
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
        assign_strategy: z
          .enum(ASSIGN_STRATEGIES)
          .optional()
          .describe(
            "How Donetick picks the next assignee each time the chore recurs. keep_last_assigned " +
              "keeps whoever has it, round_robin cycles through the assignees in order, " +
              "least_assigned and least_completed pick by workload, random and " +
              "random_except_last_assigned pick at random, and no_assignee leaves it unassigned. " +
              "no_assignee alongside a non-empty assignees list is contradictory, so it is treated " +
              "as keep_last_assigned rather than silently discarding the people you named.",
          ),
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
      handler: guard(async (args) => ok(await createChore(args as unknown as CreateInput, deps))),
    },
    {
      name: "edit_chore",
      annotations: DESTRUCTIVE,
      description:
        "Edit an existing chore by chore_id. Every field you do not pass is preserved as it was, with one " +
        "exception: a chore whose notifications were switched on but whose notification settings row " +
        "is empty has them switched off by any edit, because the alternative crashes Donetick. Only the " +
        "fields you pass are changed. Pass due_date: null to clear the due date. assignees replaces the " +
        "full assignee list, while add_assignees adds to it without dropping anyone already assigned. " +
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
        assign_strategy: z
          .enum(ASSIGN_STRATEGIES)
          .optional()
          .describe(
            "How Donetick picks the next assignee each time the chore recurs. keep_last_assigned " +
              "keeps whoever has it, round_robin cycles through the assignees in order, " +
              "least_assigned and least_completed pick by workload, random and " +
              "random_except_last_assigned pick at random, and no_assignee leaves it unassigned. " +
              "no_assignee alongside a non-empty assignees list is contradictory, so it is treated " +
              "as keep_last_assigned rather than silently discarding the people you named.",
          ),
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
      handler: guard(async (args) => ok(await editChore(args as unknown as EditInput & { chore_id?: number }, deps))),
    },
    {
      name: "delete_chore",
      annotations: DESTRUCTIVE,
      description:
        "Permanently delete a chore and its completion history. Before deleting, this asks the user " +
        "to confirm through your client, which reissues the call once they answer. There is no confirm " +
        "parameter to pass and nothing for you to do about it: call it once. " +
        "If the goal is only to stop seeing a chore while keeping its history, use " +
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
        const outcome = await deleteChore(resolved, deps, mcp?.confirmation);
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
      annotations: IDEMPOTENT,
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
      handler: guard(async (args) => ok(await rescheduleChore(args as unknown as RescheduleInput, deps))),
    },
    {
      name: "reassign_chore",
      annotations: IDEMPOTENT,
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
      handler: guard(async (args) => ok(await reassignChore(args as unknown as ReassignInput, deps))),
    },
    {
      name: "set_priority",
      annotations: IDEMPOTENT,
      description:
        "Set a chore's priority. Donetick's scale is inverted: P1 is the most urgent, P4 is the least " +
        "urgent, and none (0) means unset.",
      inputSchema: {
        chore_id: choreIdSchema,
        priority: z
          .union([priorityEnumSchema, z.number().int().min(MIN_PRIORITY).max(MAX_PRIORITY)])
          .describe("A P-label or the equivalent 0-4 integer."),
      },
      handler: guard(async (args) => ok(await setPriority(args as unknown as SetPriorityInput, deps))),
    },
    {
      name: "archive_chore",
      annotations: IDEMPOTENT,
      description:
        "Archive a chore. This is the answer to \"I do not need this one anymore\": the chore stops " +
        "appearing in active lists but its completion history is kept, unlike delete_chore. " +
        "unarchive_chore reverses it.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await archiveChore(args as unknown as ArchiveInput, deps))),
    },
    {
      name: "unarchive_chore",
      annotations: IDEMPOTENT,
      description: "Restore a previously archived chore so it appears in active lists again.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await unarchiveChore(args as unknown as ArchiveInput, deps))),
    },
    {
      name: "complete_chore",
      annotations: DESTRUCTIVE,
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
      handler: guard(async (args) => ok(await completeChore(args as unknown as CompleteInput, deps))),
    },
    {
      name: "skip_chore",
      annotations: DESTRUCTIVE,
      description:
        "Skip a recurring chore's current occurrence, advancing it to its next due date without " +
        "recording it as completed.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await skipChore(args as unknown as SkipInput, deps))),
    },
    {
      name: "undo_chore",
      annotations: DESTRUCTIVE,
      description:
        "Undo the most recent completion of a chore. Expect this to fail: on the Donetick version this " +
        "server was verified against, the endpoint answers \"no recent action found\" immediately after " +
        "both a completion and a skip, well inside its own five-minute window. To put a wrongly " +
        "completed chore back, use reschedule_chore to restore the due date. Takes chore_id only, " +
        "never a name: a just-completed one-off chore drops out of " +
        "the active list this server searches by name. Use the id complete_chore returned.",
      inputSchema: {
        chore_id: z
          .number()
          .int()
          .describe(
            "The id complete_chore returned. This tool does not take a name, and unlike the other " +
              "id-only tools you cannot fall back to list_chores: a just-completed non-recurring " +
              "chore has isActive false and is absent from the list this server searches by name.",
          ),
      },
      handler: guard(async (args) => ok(await undoChore(args as unknown as UndoInput, deps))),
    },
    {
      name: "approve_chore",
      annotations: ADDITIVE,
      description:
        "Approve a chore completion that is waiting on sign-off, for a chore whose require_approval is " +
        "set (status pending_approval). Requires an admin or manager role in the circle.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await approveChore(args as unknown as ApprovalInput, deps))),
    },
    {
      name: "reject_chore",
      annotations: ADDITIVE,
      description:
        "Reject a chore completion that is waiting on sign-off, for a chore whose require_approval is " +
        "set (status pending_approval). Requires an admin or manager role in the circle.",
      inputSchema: {
        chore_id: choreIdSchema,
      },
      handler: guard(async (args) => ok(await rejectChore(args as unknown as ApprovalInput, deps))),
    },
    {
      name: "nudge_chore",
      annotations: ADDITIVE,
      description:
        "Send a reminder nudge for a chore to its assignee. Needs another member in the circle: Donetick " +
        "refuses to let you nudge yourself. The nudge reaches registered mobile devices only, not " +
        "Telegram or Pushover, so it can silently fail to deliver even when this call succeeds.",
      inputSchema: {
        chore_id: choreIdSchema,
        message: z.string().optional(),
        all_assignees: z.boolean().optional().describe("Nudge every assignee rather than just one."),
      },
      handler: guard(async (args) => ok(await nudgeChore(args as unknown as NudgeInput, deps))),
    },
    {
      name: "set_subtask_completed",
      annotations: IDEMPOTENT,
      description:
        "Check or uncheck one item on a chore's checklist, matched by name. Use get_chore first to see " +
        "the current subtask names and their state. Subtask completion resets at the start of each cycle " +
        "on a recurring chore.",
      inputSchema: {
        chore_id: choreIdSchema,
        subtask: z.string().describe("The checklist item's name, or a distinguishing substring of it."),
        completed: z.boolean().describe("true to check the item, false to uncheck it."),
      },
      handler: guard(async (args) => ok(await setSubtaskCompleted(args as unknown as SetSubtaskInput, deps))),
    },
  ];
}
