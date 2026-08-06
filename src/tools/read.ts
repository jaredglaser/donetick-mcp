import { projectChore } from "@/projection";
import { bucket, type Scope } from "@/time";
import { normalizeName } from "@/resolve";
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
  return zone && zone.length > 0 ? zone : fallback;
}

export function listChores(args: ListArgs, ctx: ListContext): ListResult {
  const scope: Scope = args.scope ?? "all";
  const limit = args.limit ?? 50;

  let rows = ctx.chores.filter((chore) => {
    const due = chore.nextDueDate === null ? null : new Date(chore.nextDueDate);
    return bucket(due, scope, ctx.now, zoneFor(chore, ctx.timezone), args.days ?? 7);
  });

  if (args.project !== undefined) {
    const wanted = normalizeName(args.project);
    const project = ctx.projects.find((p) => normalizeName(p.name) === wanted);
    rows = rows.filter((chore) => project !== undefined && chore.projectId === project.id);
  }

  if (args.assignee !== undefined) {
    const wanted = normalizeName(args.assignee);
    if (wanted === "unassigned") {
      rows = rows.filter((chore) => chore.assignedTo === null);
    } else {
      const member = ctx.members.find(
        (m) => normalizeName(m.displayName) === wanted || normalizeName(m.username) === wanted,
      );
      rows = rows.filter((chore) => member !== undefined && chore.assignedTo === member.userId);
    }
  }

  if (args.priority !== undefined) {
    const wanted = normalizeName(args.priority);
    rows = rows.filter((chore) => normalizeName(PRIORITY_LABEL[chore.priority] ?? "") === wanted);
  }

  if (args.label !== undefined) {
    const wanted = normalizeName(args.label);
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
    rows = rows.filter((chore) => normalizeName(chore.name).includes(wanted));
  }

  const sort = args.sort ?? "due_date";
  rows = [...rows].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "priority") {
      // Donetick priority is inverted and 0 means unset, so 0 sorts last.
      const rank = (p: number) => (p === 0 ? Number.MAX_SAFE_INTEGER : p);
      return rank(a.priority) - rank(b.priority);
    }
    const at = a.nextDueDate === null ? Number.MAX_SAFE_INTEGER : new Date(a.nextDueDate).getTime();
    const bt = b.nextDueDate === null ? Number.MAX_SAFE_INTEGER : new Date(b.nextDueDate).getTime();
    return at - bt;
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
