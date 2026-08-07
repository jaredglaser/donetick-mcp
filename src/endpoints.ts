const CHORES_BASE = "/api/v1/chores";

const DELETE_CHORE_PATH = new RegExp(`^${CHORES_BASE}/\\d+$`);

export const endpoints = {
  listChores: () => `${CHORES_BASE}/?includeSubtasks=true`,
  listChoresWithArchived: () => `${CHORES_BASE}/?includeSubtasks=true&includeArchived=true`,
  choreDetails: (id: number) => `${CHORES_BASE}/${id}/details`,
  createChore: () => `${CHORES_BASE}/`,
  editChore: () => `${CHORES_BASE}/`,
  deleteChore: (id: number) => `${CHORES_BASE}/${id}`,
  completeChore: (id: number) => `${CHORES_BASE}/${id}/do`,
  skipChore: (id: number) => `${CHORES_BASE}/${id}/skip`,
  undoChore: (id: number) => `${CHORES_BASE}/${id}/undo`,
  approveChore: (id: number) => `${CHORES_BASE}/${id}/approve`,
  rejectChore: (id: number) => `${CHORES_BASE}/${id}/reject`,
  nudgeChore: (id: number) => `${CHORES_BASE}/${id}/nudge`,
  updateDueDate: (id: number) => `${CHORES_BASE}/${id}/dueDate`,
  updateAssignee: (id: number) => `${CHORES_BASE}/${id}/assignee`,
  updatePriority: (id: number) => `${CHORES_BASE}/${id}/priority`,
  updateSubtask: (id: number) => `${CHORES_BASE}/${id}/subtask`,
  archiveChore: (id: number) => `${CHORES_BASE}/${id}/archive`,
  unarchiveChore: (id: number) => `${CHORES_BASE}/${id}/unarchive`,
  choreHistory: (days: number, members: boolean) =>
    `${CHORES_BASE}/history?limit=${days}&members=${members}`,
  circleMembers: () => "/api/v1/circles/members",
  projects: () => "/api/v1/projects",
} as const;

/**
 * Write paths scoped to a single chore id whose handlers answer a missing chore with
 * 500 rather than 404, so a 500 on one of these means the chore is gone rather than
 * that the instance is broken. errors.ts depends on this set. Nudge is deliberately
 * absent: it is the one id-scoped write that does return 404.
 */
export const ID_SCOPED_WRITE_PATHS = [
  "/do",
  "/skip",
  "/undo",
  "/approve",
  "/reject",
  "/dueDate",
  "/assignee",
  "/priority",
  "/subtask",
] as const;

/**
 * Archive and unarchive are id-scoped writes too, but they never look the chore up:
 * the repo matches on id AND created_by AND circle_id and reports a zero-row update
 * the same way whether the chore is absent or belongs to someone else. Both cases
 * surface as 500, so "the chore is gone" is only half the story, and it is the wrong
 * half when the caller has just read the chore out of the list.
 */
export const CREATOR_ONLY_WRITE_PATHS = ["/archive", "/unarchive"] as const;

/**
 * The two writes that also fail with a 500 when Donetick cannot compute the next
 * occurrence, which has nothing to do with whether the chore exists. Measured on
 * v0.1.76: a day_of_the_month chore with no months, or one shaped as a weekday
 * pattern, is created happily and then answers 500 on every completion.
 */
export const SCHEDULING_WRITE_PATHS = ["/do", "/skip"] as const;

export function isSchedulingWrite(path: string, method: string): boolean {
  return method !== "GET" && SCHEDULING_WRITE_PATHS.some((suffix) => path.endsWith(suffix));
}

export function isCreatorOnlyWrite(path: string, method: string): boolean {
  return method !== "GET" && CREATOR_ONLY_WRITE_PATHS.some((suffix) => path.endsWith(suffix));
}

export function isIdScopedWrite(path: string, method: string): boolean {
  if (method === "GET") return false;
  if (method === "DELETE") return DELETE_CHORE_PATH.test(path);
  return ID_SCOPED_WRITE_PATHS.some((suffix) => path.endsWith(suffix));
}
