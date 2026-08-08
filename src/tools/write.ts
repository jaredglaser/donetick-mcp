import {
  buildCreateRequest,
  concurrencyToken,
  mergeEditRequest,
  requireDueDateFor,
  type BuildContext,
  type ChoreRequestBody,
  type CreateInput,
  type EditInput,
} from "@/chore-request";
import { endpoints } from "@/endpoints";
import { loadChoreById, writeWithConcurrencyRetry } from "@/tools/chore-lookup";
import type { ToolContext } from "@/tools/context";
import { projectChore } from "@/projection";
import { safeName } from "@/resolve";
import {
  isArchivedChore,
  type ChoreDetails,
  type ChoreListRow,
  type Member,
  type Project,
  type ProjectedChore,
  type RawChore,
} from "@/types";

export type { ToolContext as WriteContext } from "@/tools/context";

export type CreateOutcome =
  | { kind: "created"; chore: ProjectedChore; warnings?: unknown }
  | { kind: "created_detail_unavailable"; id: number; message: string };

export type EditOutcome =
  | { kind: "edited"; chore: ProjectedChore; warning?: string }
  | { kind: "edited_detail_unavailable"; id: number; message: string };

export type DeleteOutcome =
  | { kind: "confirm_required"; message: string; chore: string }
  | { kind: "declined"; chore: string }
  | { kind: "deleted"; deleted: number; name: string };

async function loadBuildContext(ctx: ToolContext): Promise<BuildContext> {
  const [members, projects]: [Member[], Project[]] = await Promise.all([
    ctx.service.members(),
    ctx.service.projects(),
  ]);
  return { members, projects, now: ctx.now(), timezone: ctx.timezone };
}

function isValidCreatedId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * POST /api/v1/chores/ returns a bare number on success. Ids are positive
 * auto-increment, so 0 is falsy without being valid and a naive `if (!response)`
 * would report it as "no id returned" rather than as a bad one.
 */
function extractCreatedId(response: unknown): { id: number; warnings?: unknown } {
  if (isValidCreatedId(response)) return { id: response };
  if (response !== null && typeof response === "object" && "res" in response) {
    const envelope = response as { res: unknown; warnings?: unknown };
    if (isValidCreatedId(envelope.res)) return { id: envelope.res, warnings: envelope.warnings };
  }
  // The 200 means Donetick accepted the create, so the chore almost certainly exists
  // even though its id is unreadable here. Saying only "unexpected response" invites
  // a retry that makes a second one. The body is truncated because it is untrusted
  // and unbounded.
  const shown = JSON.stringify(response) ?? String(response);
  throw new Error(
    `create_chore expected POST ${endpoints.createChore()} to return the new chore's numeric id, got ${
      shown.length > 200 ? `${shown.slice(0, 200)}...` : shown
    }. Donetick answered 200, so the chore was probably created despite this; check list_chores before trying again, or a retry will make a second one.`,
  );
}

/**
 * The write body already carries every field this module computed for the write
 * (frequency, labels-for-write, assign strategy, and so on), so it is a better
 * source for the just-written state than a fresh GET, which is missing exactly
 * the fields a write requires (see ChoreDetails). The cast goes through unknown
 * because ChoreRequestBody's write-shaped fields (labelsV2 carries no name on
 * write, for example) are not structurally RawChore's read-shaped fields; callers layer a
 * read-shaped source over this to correct the fields that differ.
 */
function bodyAsRawFields(body: ChoreRequestBody): Partial<RawChore> {
  return body as unknown as Partial<RawChore>;
}

/**
 * Donetick's create inserts the row before several later steps that can fail, so a
 * failed create can still have produced a chore. The POST itself is the only part
 * wrapped here to trigger service.write's cache invalidation; the invalidation
 * must happen even if extractCreatedId rejects the response, since a chore may
 * still exist despite an unreportable id.
 */
export async function createChore(input: CreateInput, ctx: ToolContext): Promise<CreateOutcome> {
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new Error("create_chore requires a name.");
  }

  const buildCtx = await loadBuildContext(ctx);
  const body = buildCreateRequest(input, buildCtx);

  const { id, warnings } = await ctx.service.write(async () => {
    const response = await ctx.service.client.postEnvelope(endpoints.createChore(), body);
    return extractCreatedId(response);
  });

  let detail: ChoreDetails;
  try {
    detail = await ctx.service.choreDetails(id);
  } catch (error) {
    // The chore was created; only the confirmation fetch failed. A bare failure here
    // would tell the caller the create did not happen when it did.
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "created_detail_unavailable",
      id,
      message: `Chore ${id} was created, but its details could not be fetched to confirm it: ${message} Use get_chore with chore_id ${id} to check on it.`,
    };
  }

  const merged = { ...bodyAsRawFields(body), ...detail } as RawChore;
  const chore = projectChore(merged, buildCtx.members, buildCtx.projects, buildCtx.now);
  return warnings !== undefined ? { kind: "created", chore, warnings } : { kind: "created", chore };
}

export async function editChore(
  input: EditInput & { chore_id?: number },
  ctx: ToolContext,
): Promise<EditOutcome> {
  const existing = await loadChoreById(input.chore_id, ctx);
  const buildCtx = await loadBuildContext(ctx);

  // The body that actually landed, kept for the read-back merge below: it holds the
  // write-shaped fields /details omits, and after a retry it is the second one.
  //
  // `merged` is the row that body was built on, which after a retry is not `existing`.
  // Everything below that describes the write has to read this one: reporting labels
  // off the pre-retry row hid a label the other writer added, and comparing the stale
  // row's notification flag against the retried body's could invent the warning or
  // miss it.
  let body: ChoreRequestBody;
  let mergeBase: ChoreListRow = existing;

  const put = async (base: ChoreListRow): Promise<void> => {
    mergeBase = base;
    body = mergeEditRequest(base, input, buildCtx);
    // Inside put, so the retry re-checks. The clear lands on a separate endpoint
    // after this write, so the merged body still carries the old date and the guard
    // inside mergeEditRequest cannot see the state this call will leave behind. The
    // retry re-reads and re-merges, and the row it re-reads can have acquired a
    // completion window or an adaptive frequency in the meantime.
    if (input.due_date === null) {
      requireDueDateFor(null, body.frequencyType, body.completionWindow);
    }
    await ctx.service.write(() => ctx.service.client.put(endpoints.editChore(), body));
  };

  await writeWithConcurrencyRetry(input.chore_id, existing, put, ctx);

  // PUT /chores/ reads nextDueDate: null as "keep the current date" rather than as
  // "clear it" (verified live on v0.1.76: the field is only assigned when non-nil,
  // and the else branch reuses the old value). PUT /:id/dueDate does honour null, so
  // a clear has to go there. Without this, edit_chore advertised a capability that
  // silently did nothing and then reported success.
  if (input.due_date === null) {
    // Re-read first. existing predates the write just issued, so its stamp is already
    // behind the row and this endpoint refuses anything older. The only place two
    // writes hit one chore in sequence.
    ctx.service.invalidateChores();
    let written: ChoreListRow;
    try {
      written = await loadChoreById(existing.id, ctx);
    } catch (error) {
      // Guarded for the same reason the write below it is. This read sits between
      // two writes, and the main edit has already landed: reporting a read failure
      // as an edit failure invites a retry of a change that applied.
      return {
        kind: "edited_detail_unavailable",
        id: existing.id,
        message: `"${safeName(existing.name)}" was updated, but reading it back to clear its due date failed: ${
          error instanceof Error ? error.message : String(error)
        }. Everything else in the edit landed. Call reschedule_chore with due_date null to finish clearing it.`,
      };
    }
    try {
      await ctx.service.write(() =>
        ctx.service.client.put(endpoints.updateDueDate(written.id), {
          dueDate: null,
          updatedAt: concurrencyToken(written, ctx.now()),
        }),
      );
    } catch (error) {
      // The main edit landed. Saying "the edit failed" would invite a retry of a
      // change that already applied, so this names what did and did not happen.
      return {
        kind: "edited_detail_unavailable",
        id: existing.id,
        message: `"${safeName(existing.name)}" was updated, but clearing its due date failed: ${
          error instanceof Error ? error.message : String(error)
        }. Everything else in the edit landed. Call reschedule_chore with due_date null to finish clearing it.`,
      };
    }
  }

  // The edit has already landed. A failure past this point is a reporting failure,
  // not a write failure, and saying otherwise would invite the caller to retry a
  // change that already succeeded.
  let detail: ChoreDetails;
  try {
    detail = await ctx.service.choreDetails(existing.id);
  } catch (error) {
    return {
      kind: "edited_detail_unavailable",
      id: existing.id,
      message: `"${safeName(existing.name)}" was updated, but reading it back failed: ${
        error instanceof Error ? error.message : String(error)
      }. The edit itself succeeded; call get_chore to see the current state.`,
    };
  }
  // labelsV2 is forced back to the merge base rather than taken from body or detail:
  // body's labelsV2 is the write shape ({id}, no name) and edit input has no way to
  // change labels, while detail omits labelsV2 entirely. The base is the only source
  // with the read-shaped labels this edit actually left in place.
  const merged = {
    ...mergeBase,
    ...bodyAsRawFields(body!),
    ...detail,
    labelsV2: mergeBase.labelsV2 ?? null,
  } as RawChore;
  // The one field an unrelated edit can change on its own. mergeNotification turns
  // notifications off when the stored row has them on with no metadata, because the
  // alternative reaches a nil deref in a Donetick goroutine and takes the process
  // down. That tradeoff is argued in chore-request.ts and stated in edit_chore's
  // description, but the description is not what the caller reads after the write.
  const notificationsSwitchedOff = mergeBase.notification === true && body!.notification === false;

  return {
    kind: "edited",
    chore: projectChore(merged, buildCtx.members, buildCtx.projects, buildCtx.now),
    ...(notificationsSwitchedOff
      ? {
          warning: `Notifications on "${safeName(mergeBase.name)}" were switched off by this edit. Donetick had them enabled with no reminder settings stored, a combination it crashes on when written back. Pass notify with the reminders you want to turn them on again.`,
        }
      : {}),
  };
}

/**
 * Takes the chore itself rather than an id, because its caller has already
 * resolved one: the confirmation gate means this runs twice for a single delete,
 * and re-resolving on each pass turned one lookup into four.
 */
export async function deleteChore(
  existing: RawChore,
  ctx: ToolContext,
  answer: { confirm: boolean } | undefined,
): Promise<DeleteOutcome> {
  if (answer === undefined) {
    // Offering "archive it instead" to a chore that is already archived would be
    // advice to do the thing that has been done, so the archived case makes the
    // point that matters there: the history is what is actually at stake.
    // The name is quoted through safeName and the id is stated, because this string
    // is what the human reads before approving a permanent delete and it is the only
    // copy they see. A name carrying quotes and a newline could otherwise end the
    // first sentence early and make the rest read as a separate, benign prompt.
    const label = `${JSON.stringify(safeName(existing.name))} (id ${existing.id})`;
    const message =
      isArchivedChore(existing)
        ? `Delete ${label}? It is already archived, so it is out of your active lists; deleting also removes its completion history, permanently.`
        : `Delete ${label}? This permanently removes the chore and its completion history. If you want to keep the history, archive it instead.`;
    return { kind: "confirm_required", chore: existing.name, message };
  }

  if (!answer.confirm) {
    return { kind: "declined", chore: existing.name };
  }

  await ctx.service.write(() => ctx.service.client.delete(endpoints.deleteChore(existing.id)));

  return { kind: "deleted", deleted: existing.id, name: existing.name };
}
