import { endpoints } from "@/endpoints";
import { loadChoreById } from "@/tools/chore-lookup";
import { resolveOne, safeName } from "@/resolve";
import type { ToolContext } from "@/tools/context";
import type { RawSubTask } from "@/types";

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

  const subtasks = chore.subTasks ?? [];
  if (subtasks.length === 0) {
    // Hedged, because this path never contacts the server. The row can come from a
    // cache that is up to its TTL old, so a chore deleted elsewhere is
    // indistinguishable here from a live one with an empty checklist, and stating the
    // second as fact is a claim this tool has not checked.
    throw new Error(
      `"${safeName(chore.name)}" has no subtasks, according to this server's cached copy of it. If you expected some, the chore may have changed or been deleted since that copy was read; get_chore will say.`,
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
