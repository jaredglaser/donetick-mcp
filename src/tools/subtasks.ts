import { endpoints } from "@/endpoints";
import { loadChoreById } from "@/tools/chore-lookup";
import { resolveOne, safeName } from "@/resolve";
import type { ToolContext } from "@/tools/context";
import type { ChoreListRow, RawSubTask } from "@/types";

function isDone(sub: RawSubTask): boolean {
  return Boolean(sub.completedAt);
}

export interface SetSubtaskInput {
  chore_id?: number;
  subtask?: string;
  completed?: boolean;
}

export interface SetSubtaskOutcome {
  chore_id: number;
  chore_name: string;
  subtask: string;
  completed: boolean;
}

/**
 * The chore's checklist as Donetick holds it now.
 *
 * Falls back to the cached row only when the fresh read fails, since this tool
 * resolves a name to an id and then writes that id: a stale list does not fail, it
 * writes to the wrong item.
 */
async function freshSubtasks(chore: ChoreListRow, ctx: ToolContext): Promise<RawSubTask[]> {
  try {
    const detail = (await ctx.service.choreDetails(chore.id)) as { subTasks?: RawSubTask[] | null };
    if (Array.isArray(detail.subTasks)) return detail.subTasks;
  } catch {
    // Fall through to the cached copy.
  }
  return chore.subTasks ?? [];
}

/**
 * Always sends the PUT even when the subtask is already in the requested state.
 * The endpoint is idempotent on the server side, subtask state resets every cycle
 * on a recurring chore, and short-circuiting here would need a second source of
 * truth for "current state" that could drift from what the caller wants written.
 */
export async function setSubtaskCompleted(
  input: SetSubtaskInput,
  ctx: ToolContext,
): Promise<SetSubtaskOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);

  if (typeof input.subtask !== "string") {
    throw new Error("subtask is required: the name of the checklist item to check or uncheck.");
  }
  if (typeof input.completed !== "boolean") {
    throw new Error("completed is required: true to check the subtask, false to uncheck it.");
  }

  // Read fresh, not from the cached row. A name is resolved to a subtask id here and
  // that id is what gets written, so a checklist edited out of band sends the write
  // somewhere else: measured, renaming a subtask while keeping its id made this tool
  // tick a task called "CALL THE PLUMBER" and report back the name it was given, and
  // replacing the checklist made it write an id that matched no row while reporting
  // success. GET /:id/details carries subTasks and is one uncached request.
  //
  // The cached row is the fallback, because a detail read failing is not a reason to
  // refuse a tick, and loadChoreById above has already established the chore exists.
  const subtasks = await freshSubtasks(chore, ctx);
  if (subtasks.length === 0) {
    throw new Error(
      `"${safeName(chore.name)}" has no subtasks.`,
    );
  }

  const subtask = resolveOne(
    input.subtask,
    subtasks,
    (sub) => sub.name,
    (sub) => (isDone(sub) ? "done" : "not done"),
  );

  await ctx.service.write(() =>
    ctx.service.client.put(endpoints.updateSubtask(chore.id), {
      id: subtask.id,
      choreId: chore.id,
      completedAt: input.completed ? ctx.now().toISOString() : null,
    }),
  );

  return {
    chore_id: chore.id,
    chore_name: chore.name,
    subtask: subtask.name,
    completed: input.completed,
  };
}
