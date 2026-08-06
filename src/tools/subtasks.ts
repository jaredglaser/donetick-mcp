import { endpoints } from "@/endpoints";
import { resolveOne } from "@/resolve";
import type { WriteContext } from "@/tools/write";
import type { RawChore, RawSubTask } from "@/types";

async function loadChoreById(chore_id: number | undefined, ctx: WriteContext): Promise<RawChore> {
  if (typeof chore_id !== "number") {
    throw new Error("chore_id is required. Resolve a name to an id with list_chores or get_chore first.");
  }
  const all = await ctx.service.chores();
  const found = all.find((chore) => chore.id === chore_id);
  if (!found) {
    throw new Error(
      `No chore with id ${chore_id} is visible on this account. It may have been deleted or archived since the chore list was last read.`,
    );
  }
  return found;
}

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
 * Always sends the PUT even when the subtask is already in the requested state.
 * The endpoint is idempotent on the server side, subtask state resets every cycle
 * on a recurring chore, and short-circuiting here would need a second source of
 * truth for "current state" that could drift from what the caller actually wants
 * written, for no real cost saved.
 */
export async function setSubtaskCompleted(
  input: SetSubtaskInput,
  ctx: WriteContext,
): Promise<SetSubtaskOutcome> {
  const chore = await loadChoreById(input.chore_id, ctx);

  if (typeof input.subtask !== "string") {
    throw new Error("subtask is required: the name of the checklist item to check or uncheck.");
  }
  if (typeof input.completed !== "boolean") {
    throw new Error("completed is required: true to check the subtask, false to uncheck it.");
  }

  const subtasks = chore.subTasks ?? [];
  if (subtasks.length === 0) {
    throw new Error(`"${chore.name}" has no subtasks.`);
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
