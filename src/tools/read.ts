import { projectChore } from "@/projection";
import { bucket, dueDateOf, isValidTimezone, type Scope } from "@/time";
import { findMember, normalizeName, safeName } from "@/resolve";
import { CHORE_STATUS, PRIORITY_LABEL, type Member, type ProjectedChore, type Project, type RawChore } from "@/types";

export interface ListArgs {
  scope?: Scope;
  days?: number;
  project?: string;
  priority?: string;
  label?: string;
  assignee?: string;
  status?: string;
  search?: string;
  sort?: "due_date" | "priority" | "name";
  limit?: number;
}

export interface ListContext {
  chores: RawChore[];
  members: Member[];
  projects: Project[];
  now: Date;
  timezone: string;
}

export interface ListResult {
  chores: ProjectedChore[];
  total: number;
  truncated: boolean;
}

/**
 * A chore can carry its own zone, and Donetick's scheduler honors it. Bucketing
 * everything by one global zone would make this server and the web UI disagree
 * about which day a chore is due.
 */
function zoneFor(chore: RawChore, fallback: string): string {
  const zone = chore.frequencyMetadata?.timezone;
  // Client-supplied: any circle member sets this on create, and Temporal throws on
  // an unrecognized zone, so one bad row would otherwise fail every scope-filtered
  // listing with a message about Temporal rather than about the chore.
  return zone && zone.length > 0 && isValidTimezone(zone) ? zone : fallback;
}

/**
 * Lists what does exist, so the caller can correct itself without another round trip.
 *
 * Sanitized here rather than at the three call sites, because these are the messages
 * where the attack works: fail() renders a thrown Error as plain text with newlines
 * intact, so a project or member name carrying one forges a whole extra line.
 */
function describeKnown(names: string[]): string {
  if (names.length === 0) return " There are none.";
  return ` Known: ${names.map(safeName).join(", ")}.`;
}

export function listChores(args: ListArgs, ctx: ListContext): ListResult {
  const scope: Scope = args.scope ?? "all";
  const limit = args.limit ?? 50;

  let rows = ctx.chores.filter((chore) => {
    const due = dueDateOf(chore.nextDueDate);
    return bucket(due, scope, ctx.now, zoneFor(chore, ctx.timezone), args.days ?? 7);
  });

  // An unmatched filter yielding zero rows reads as "you have nothing in
  // the Garage project" when the truth is "there is no Garage project". The caller
  // cannot tell those apart from an empty list, and the write path already throws
  // with suggestions on the same string.
  if (args.project !== undefined) {
    const wanted = normalizeName(args.project);
    const project = ctx.projects.find((p) => normalizeName(p.name) === wanted);
    if (project === undefined) {
      throw new Error(
        `"${safeName(args.project)}" is not a known project.${describeKnown(ctx.projects.map((p) => p.name))}`,
      );
    }
    rows = rows.filter((chore) => chore.projectId === project.id);
  }

  if (args.assignee !== undefined) {
    const wanted = normalizeName(args.assignee);
    if (wanted === "unassigned") {
      rows = rows.filter((chore) => chore.assignedTo === null);
    } else {
      const member = findMember(args.assignee, ctx.members);
      if (member === undefined) {
        throw new Error(
          `"${safeName(args.assignee)}" is not a member of this circle.${describeKnown(
            ctx.members.map((m) => m.displayName),
          )} Use "unassigned" for chores with nobody on them.`,
        );
      }
      rows = rows.filter((chore) => chore.assignedTo === member.userId);
    }
  }

  if (args.priority !== undefined) {
    const wanted = normalizeName(args.priority);
    rows = rows.filter((chore) => normalizeName(PRIORITY_LABEL[chore.priority] ?? "") === wanted);
  }

  if (args.label !== undefined) {
    const wanted = normalizeName(args.label);
    // Same reasoning as project and assignee above, and it matters most here: the
    // label API needs session auth, so a caller has no other way to learn which
    // labels exist and would read an empty list as "nothing is tagged that".
    const inUse = [...new Set(ctx.chores.flatMap((c) => (c.labelsV2 ?? []).map((l) => l.name)))];
    if (!inUse.some((name) => normalizeName(name) === wanted)) {
      throw new Error(
        `"${safeName(args.label)}" is not on any chore this server can see.${describeKnown(inUse)} Donetick's ` +
          "label API needs session auth, so a label attached to nothing is invisible here.",
      );
    }
    rows = rows.filter((chore) =>
      (chore.labelsV2 ?? []).some((label) => normalizeName(label.name) === wanted),
    );
  }

  if (args.status !== undefined) {
    const wanted = normalizeName(args.status);
    rows = rows.filter((chore) => normalizeName(CHORE_STATUS[chore.status] ?? "") === wanted);
  }

  if (args.search !== undefined) {
    const wanted = normalizeName(args.search);
    // A blank search matches every chore, since "x".includes("") is true, so it reads
    // as an unfiltered list rather than as the no-op it is. resolveOne rejects a blank
    // query for the same reason.
    if (wanted.length === 0) {
      throw new Error("search cannot be blank. Omit it to list without a name filter.");
    }
    rows = rows.filter((chore) => normalizeName(chore.name).includes(wanted));
  }

  const sort = args.sort ?? "due_date";
  const byDueDate = (a: RawChore, b: RawChore): number => {
    const at = dueDateOf(a.nextDueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = dueDateOf(b.nextDueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return at - bt;
  };
  rows = [...rows].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "priority") {
      // Donetick priority is inverted and 0 means unset, so 0 sorts last.
      const rank = (p: number) => (p === 0 ? Number.MAX_SAFE_INTEGER : p);
      const byRank = rank(a.priority) - rank(b.priority);
      // Chained, because equal priorities left Donetick's own row order showing
      // through: an undated "someday" chore sorted above one due tomorrow.
      return byRank !== 0 ? byRank : byDueDate(a, b);
    }
    return byDueDate(a, b);
  });

  const total = rows.length;
  const page = rows.slice(0, limit);

  return {
    chores: page.map((chore) => projectChore(chore, ctx.members, ctx.projects, ctx.now)),
    total,
    truncated: total > page.length,
  };
}

export function getChore(
  chore: RawChore,
  members: Member[],
  projects: Project[],
  now: Date,
): ProjectedChore {
  return projectChore(chore, members, projects, now);
}
