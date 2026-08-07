/**
 * Live wire-contract check against a real Donetick instance.
 *
 * The unit suite stubs fetch, so it proves this codebase is self-consistent, not
 * that Donetick's undocumented /api/v1 still behaves the way it was read. Every
 * fact this server depends on (field names, which view carries which field, what
 * a write requires, what a response echoes) was established by probing a live
 * instance, and several were wrong on first read. This script re-establishes
 * those facts after any Donetick upgrade and is the regression net for it.
 *
 * Not part of `bun test`: it needs a live instance and real credentials, and it
 * writes and deletes scratch chores. Run it deliberately with `bun run verify:live`.
 *
 * This script is not the server: it never speaks JSON-RPC and stdout is not a
 * transport here, so the "console.error only" rule in CLAUDE.md (stdout would
 * corrupt the protocol stream) does not apply. It prints its report to stdout on
 * purpose, so it can be piped or redirected like any other CLI report.
 */

import { DonetickClient } from "@/client";
import { parseConfig } from "@/config";
import { endpoints } from "@/endpoints";
import { DonetickError } from "@/errors";
import type { RawChore } from "@/types";

type Status = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

interface CheckOutcome {
  status?: Status;
  detail: string;
}

const results: CheckResult[] = [];

async function check(name: string, fn: () => Promise<CheckOutcome>): Promise<void> {
  try {
    const outcome = await fn();
    results.push({ name, status: outcome.status ?? "pass", detail: outcome.detail });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "fail", detail });
  }
}

interface ChoreCreateBody {
  name: string;
  description: string | null;
  nextDueDate: string | null;
  frequencyType: string;
  frequency: number;
  frequencyMetadata: Record<string, unknown>;
  assignStrategy: string;
  assignedTo: number | null;
  assignees: Array<{ userId: number }>;
  labelsV2: Array<{ labelId: number }>;
  priority: number;
  points: number | null;
  projectId: number | null;
  isRolling: boolean;
  isPrivate: boolean;
  requireApproval: boolean;
  completionWindow: number | null;
  notification: boolean;
}

async function main(): Promise<void> {
  const config = parseConfig(Bun.env);
  const client = new DonetickClient({
    baseUrl: config.baseUrl,
    token: config.token,
    timeoutMs: config.timeoutMs,
  });

  const runPrefix = `zzverify-live-${Date.now()}`;
  const scoped = (label: string): string => `${runPrefix}-${label}`;

  const createdChoreIds: number[] = [];

  function baseChoreBody(name: string, overrides: Partial<ChoreCreateBody> = {}): ChoreCreateBody {
    return {
      name,
      description: null,
      nextDueDate: new Date().toISOString(),
      frequencyType: "once",
      frequency: 1,
      frequencyMetadata: { timezone: config.timezone },
      assignStrategy: "no_assignee",
      assignedTo: null,
      assignees: [],
      labelsV2: [],
      priority: 0,
      points: null,
      projectId: null,
      isRolling: false,
      isPrivate: false,
      requireApproval: false,
      completionWindow: null,
      notification: false,
      ...overrides,
    };
  }

  /**
   * Also stands in as the "create returns a bare number" check: the caller of
   * this function gets the same shape assertion for free, so that check below
   * just calls this and reports what it got.
   */
  /**
 * Recurrence, labels, points and the approval flag live only on the chores list row.
 * GET /:id/details omits them, which the field-set check below proves. Reading a
 * round-trip from /details reports a false regression, so every shape assertion
 * about those fields must come from here.
 */
async function listRowById(id: number): Promise<Record<string, unknown>> {
  const rows = (await client.get(endpoints.listChores())) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`chore ${id} is not in the chores list`);
  return row;
}

async function createScratchChore(body: ChoreCreateBody): Promise<number> {
    const response = await client.post(endpoints.createChore(), body);
    if (typeof response !== "number" || !Number.isInteger(response) || response <= 0) {
      throw new Error(
        `POST ${endpoints.createChore()} did not return a bare positive integer id, got ${JSON.stringify(response)}`,
      );
    }
    createdChoreIds.push(response);
    return response;
  }

  try {
    // Reads.

    await check("GET /chores/?includeSubtasks=true returns an array", async () => {
      const rows = await client.get(endpoints.listChores());
      if (!Array.isArray(rows)) throw new Error(`expected an array, got ${JSON.stringify(rows)}`);
      return { detail: `${rows.length} chore(s)` };
    });

    await check("GET /circles/members rows carry both id and userId", async () => {
      const rows = await client.get(endpoints.circleMembers());
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`expected a non-empty array, got ${JSON.stringify(rows)}`);
      }
      const row = rows[0] as Record<string, unknown>;
      if (!("id" in row)) throw new Error(`member row is missing "id": ${JSON.stringify(row)}`);
      if (typeof row.userId !== "number") {
        throw new Error(`member row's "userId" is not a number: ${JSON.stringify(row)}`);
      }
      return { detail: `first row has id=${JSON.stringify(row.id)}, userId=${row.userId}` };
    });

    await check("GET /projects returns an array or an empty body", async () => {
      const response = await client.get(endpoints.projects());
      if (response !== undefined && !Array.isArray(response)) {
        throw new Error(`expected an array or an empty body, got ${JSON.stringify(response)}`);
      }
      return { detail: response === undefined ? "empty body" : `${response.length} project(s)` };
    });

    // Create and shape.

    await check("POST /chores/ returns a bare positive number, not an object", async () => {
      const id = await createScratchChore(baseChoreBody(scoped("bare-id"), { frequencyType: "daily" }));
      return { detail: `created chore ${id}` };
    });

    await check(
      'a chore created with frequencyType "interval", frequency 3, frequencyMetadata.unit "days" round-trips all three',
      async () => {
        const id = await createScratchChore(
          baseChoreBody(scoped("interval"), {
            frequencyType: "interval",
            frequency: 3,
            frequencyMetadata: { unit: "days", timezone: config.timezone },
          }),
        );
        const details = await listRowById(id);
        if (details.frequencyType !== "interval") {
          throw new Error(`frequencyType round-tripped as ${JSON.stringify(details.frequencyType)}, not "interval"`);
        }
        if (details.frequency !== 3) {
          throw new Error(`frequency round-tripped as ${JSON.stringify(details.frequency)}, not 3`);
        }
        const metadata = details.frequencyMetadata as Record<string, unknown> | null | undefined;
        if (!metadata || metadata.unit !== "days") {
          throw new Error(`frequencyMetadata.unit round-tripped as ${JSON.stringify(metadata)}, not "days"`);
        }
        return { detail: `chore ${id}: frequencyType, frequency, and frequencyMetadata.unit all intact` };
      },
    );

    await check(
      'day_of_the_month with weekPattern "week_of_month" and occurrences [-1] round-trips',
      async () => {
        const id = await createScratchChore(
          baseChoreBody(scoped("last-dom"), {
            frequencyType: "day_of_the_month",
            frequency: 1,
            frequencyMetadata: {
              days: ["monday"],
              weekPattern: "week_of_month",
              occurrences: [-1],
              timezone: config.timezone,
            },
          }),
        );
        const details = await listRowById(id);
        const metadata = details.frequencyMetadata as Record<string, unknown> | null | undefined;
        if (details.frequencyType !== "day_of_the_month") {
          throw new Error(`frequencyType round-tripped as ${JSON.stringify(details.frequencyType)}, not "day_of_the_month"`);
        }
        if (!metadata || metadata.weekPattern !== "week_of_month") {
          throw new Error(`weekPattern round-tripped as ${JSON.stringify(metadata?.weekPattern)}, not "week_of_month"`);
        }
        const occurrences = metadata.occurrences;
        if (!Array.isArray(occurrences) || occurrences.length !== 1 || occurrences[0] !== -1) {
          throw new Error(`occurrences round-tripped as ${JSON.stringify(occurrences)}, not [-1]`);
        }
        return { detail: `chore ${id}: weekPattern "week_of_month" and occurrences [-1] intact` };
      },
    );

    let approvalChoreId: number | undefined;
    await check(
      "the /chores list row and GET /:id/details expose different, non-overlapping field sets",
      async () => {
        const id = await createScratchChore(
          baseChoreBody(scoped("shape"), { frequencyType: "daily", requireApproval: true, points: 3 }),
        );
        approvalChoreId = id;

        const list = (await client.get(endpoints.listChores())) as Array<Record<string, unknown>>;
        const row = list.find((c) => c.id === id);
        if (!row) throw new Error(`chore ${id} was not found in GET ${endpoints.listChores()}`);

        const listOnlyFields = ["assignStrategy", "frequency", "frequencyMetadata", "labelsV2", "points", "requireApproval"];
        for (const field of listOnlyFields) {
          if (!(field in row)) throw new Error(`list row for chore ${id} is missing "${field}"`);
        }

        const details = (await client.get(endpoints.choreDetails(id))) as Record<string, unknown>;
        for (const field of listOnlyFields) {
          if (field in details) {
            throw new Error(
              `GET /:id/details for chore ${id} now carries "${field}", which used to be list-row-only. ` +
                "If /details has become a superset of the list row, the edit merge base in chore-request.ts " +
                "(mergeEditRequest, which insists on the list row precisely because /details drops this field) " +
                "could be simplified.",
            );
          }
        }

        const detailOnlyFields = ["lastCompletedDate", "totalCompletedCount"];
        for (const field of detailOnlyFields) {
          if (!(field in details)) throw new Error(`GET /:id/details for chore ${id} is missing "${field}"`);
        }

        return {
          detail: `chore ${id}: list row carries ${listOnlyFields.join(", ")} and /details carries neither those nor lacks ${detailOnlyFields.join(", ")}`,
        };
      },
    );

    // Writes.

    await check("PUT /:id/dueDate rejects a body that omits updatedAt", async () => {
      const id = await createScratchChore(baseChoreBody(scoped("duedate-missing"), { frequencyType: "daily" }));
      try {
        await client.put(endpoints.updateDueDate(id), { dueDate: new Date(Date.now() + 86_400_000).toISOString() });
      } catch (error) {
        if (error instanceof DonetickError) return { detail: `rejected: ${error.message}` };
        throw error;
      }
      return {
        status: "warn",
        detail:
          "Donetick accepted a dueDate update with no updatedAt. rescheduleChore in schedule.ts always sends " +
          "updatedAt regardless, so nothing in this server relies on the rejection, but the concurrency " +
          "contract documented here has loosened.",
      };
    });

    await check("PUT /:id/dueDate with updatedAt succeeds and returns the pre-update chore", async () => {
      const id = await createScratchChore(baseChoreBody(scoped("duedate-echo"), { frequencyType: "daily" }));
      const before = (await client.get(endpoints.choreDetails(id))) as Record<string, unknown>;
      const sentDueDate = new Date(Date.now() + 86_400_000).toISOString();
      const response = (await client.put(endpoints.updateDueDate(id), {
        dueDate: sentDueDate,
        updatedAt: new Date().toISOString(),
      })) as Record<string, unknown>;
      if (typeof response !== "object" || response === null || !("nextDueDate" in response)) {
        throw new Error(`expected an object with nextDueDate back, got ${JSON.stringify(response)}`);
      }
      if (response.nextDueDate === sentDueDate) {
        throw new Error(
          `response.nextDueDate (${JSON.stringify(response.nextDueDate)}) equals what was just sent. ` +
            "rescheduleChore in schedule.ts assumes this endpoint echoes the pre-update chore and deliberately " +
            "never trusts this field for the new date; if it now returns post-update state, that assumption is gone.",
        );
      }
      if (response.nextDueDate !== before.nextDueDate) {
        return {
          status: "warn",
          detail: `response.nextDueDate (${JSON.stringify(response.nextDueDate)}) differs from both what was sent and the pre-update read (${JSON.stringify(before.nextDueDate)}); it is at least not an echo of what was sent`,
        };
      }
      return { detail: `response.nextDueDate is the pre-update value ${JSON.stringify(response.nextDueDate)}, not the just-sent ${sentDueDate}` };
    });

    await check("PUT /:id/priority accepts 0 through 4 and round-trips", async () => {
      const id = await createScratchChore(baseChoreBody(scoped("priority"), { frequencyType: "daily" }));
      for (const priority of [0, 1, 2, 3, 4]) {
        await client.put(endpoints.updatePriority(id), { priority });
        const details = (await client.get(endpoints.choreDetails(id))) as Record<string, unknown>;
        if (details.priority !== priority) {
          throw new Error(`set priority ${priority}, read back ${JSON.stringify(details.priority)}`);
        }
      }
      return { detail: "0 through 4 all round-tripped" };
    });

    await check("POST /:id/do accepts a body of {}", async () => {
      const id = await createScratchChore(baseChoreBody(scoped("do-body"), { frequencyType: "daily" }));
      const response = await client.post(endpoints.completeChore(id), {});
      return { detail: `completed with an empty body; response status field: ${JSON.stringify((response as Record<string, unknown> | undefined)?.status)}` };
    });

    await check(
      "completing a requireApproval chore returns status 3 with no message field and leaves the due date unchanged",
      async () => {
        if (approvalChoreId === undefined) {
          throw new Error("no requireApproval chore available; the list/details shape check did not create one");
        }
        const before = (await client.get(endpoints.choreDetails(approvalChoreId))) as Record<string, unknown>;
        const response = (await client.post(endpoints.completeChore(approvalChoreId), {})) as Record<string, unknown>;
        if (response.status !== 3) {
          throw new Error(`expected status 3 (pending approval), got ${JSON.stringify(response.status)}`);
        }
        if ("message" in response) {
          throw new Error(`expected no "message" field on a pending-approval response, got ${JSON.stringify(response.message)}`);
        }
        const after = (await client.get(endpoints.choreDetails(approvalChoreId))) as Record<string, unknown>;
        if (after.nextDueDate !== before.nextDueDate) {
          throw new Error(
            `due date changed after a pending-approval completion: was ${JSON.stringify(before.nextDueDate)}, now ${JSON.stringify(after.nextDueDate)}`,
          );
        }
        return { detail: "status 3, no message field, due date unchanged" };
      },
    );

    await check('POST /:id/undo after a skip fails with a "no recent action" message', async () => {
      const id = await createScratchChore(baseChoreBody(scoped("skip"), { frequencyType: "daily" }));
      await client.post(endpoints.skipChore(id), {});
      try {
        await client.post(endpoints.undoChore(id), {});
      } catch (error) {
        if (error instanceof DonetickError) {
          if (!/no recent action/i.test(error.message)) {
            return {
              status: "warn",
              detail: `undo after a skip was rejected as expected, but the message no longer mentions "no recent action": ${error.message}`,
            };
          }
          return { detail: `rejected: ${error.message}` };
        }
        throw error;
      }
      throw new Error("undo after a skip succeeded; only completions should be undoable");
    });

    await check("PUT /:id/archive flips isActive to false and back, and moves the chore between the two lists", async () => {
      // Asserting the effect, not just a 200: an earlier version of this check
      // only proved neither call errored, which is how includeArchived being a
      // union of active and archived rather than the archived ones alone went
      // unnoticed until a smoke test showed active chores listed as archived.
      const id = await createScratchChore(baseChoreBody(scoped("archive"), { frequencyType: "daily" }));
      const rowById = async (path: string) =>
        ((await client.get(path)) as RawChore[]).find((row) => row.id === id);

      await client.put(endpoints.archiveChore(id), {});
      const archivedInPlain = await rowById(endpoints.listChores());
      const archivedInUnion = await rowById(endpoints.listChoresWithArchived());
      if (archivedInPlain !== undefined) {
        throw new Error(`chore ${id} still appears in the plain list after archiving`);
      }
      if (archivedInUnion?.isActive !== false) {
        throw new Error(
          `archived chore ${id} should read isActive false in the includeArchived list, got ${JSON.stringify(archivedInUnion?.isActive)}`,
        );
      }

      await client.put(endpoints.unarchiveChore(id), {});
      const restored = await rowById(endpoints.listChores());
      if (restored?.isActive !== true) {
        throw new Error(
          `chore ${id} should be back in the plain list with isActive true after unarchiving, got ${JSON.stringify(restored?.isActive)}`,
        );
      }
      return { detail: `chore ${id} left the plain list on archive and returned on unarchive` };
    });

    await check("includeArchived=true is a union of active and archived, so the archived list must be filtered", async () => {
      // service.archivedChores() filters on isActive === false because of this. If
      // Donetick ever narrows the parameter to archived-only, this check fails and
      // the filter can be revisited; until then, dropping it reports every active
      // chore as archived.
      const id = await createScratchChore(baseChoreBody(scoped("union"), { frequencyType: "daily" }));
      await client.put(endpoints.archiveChore(id), {});
      const union = (await client.get(endpoints.listChoresWithArchived())) as RawChore[];
      const active = union.filter((row) => row.isActive !== false);
      if (active.length === 0) {
        throw new Error(
          "includeArchived=true returned no active chores, so it may no longer be a union; revisit the filter in service.archivedChores()",
        );
      }
      return {
        detail: `${union.length} row(s) returned, ${active.length} of them active`,
      };
    });

    await check("DELETE /chores/:id accepts a chore that is archived", async () => {
      // delete_chore resolves ids against the archived list as well as the active
      // one because of this. If Donetick ever starts rejecting the archived case,
      // that lookup is offering something the API will not honor.
      const id = await createScratchChore(baseChoreBody(scoped("del-archived"), { frequencyType: "daily" }));
      await client.put(endpoints.archiveChore(id), {});
      await client.delete(endpoints.deleteChore(id));

      // Deleted here rather than by the cleanup pass, so drop it from that list or
      // the second delete reports a cleanup failure for a chore already gone.
      createdChoreIds.splice(createdChoreIds.indexOf(id), 1);

      const union = (await client.get(endpoints.listChoresWithArchived())) as RawChore[];
      if (union.some((row) => row.id === id)) {
        throw new Error(`archived chore ${id} survived a DELETE that reported success`);
      }
      return { detail: `archived chore ${id} deleted and gone from both lists` };
    });

    // Run after the writes above (do, skip, complete) so there is fresh history to inspect.
    await check(
      "GET /chores/history?limit=7&members=true returns an array whose rows carry choreId but no chore name",
      async () => {
        const rows = await client.get(endpoints.choreHistory(7, true));
        if (!Array.isArray(rows)) throw new Error(`expected an array, got ${JSON.stringify(rows)}`);
        if (rows.length === 0) {
          return { status: "warn", detail: "history is empty even after this run's writes; cannot confirm the row shape" };
        }
        const row = rows[0] as Record<string, unknown>;
        if (!("choreId" in row)) throw new Error(`history row is missing "choreId": ${JSON.stringify(row)}`);
        if ("name" in row) {
          throw new Error(
            `history row now carries "name" (${JSON.stringify(row.name)}). list_activity (tools/index.ts, ` +
              "enrichHistoryRow) joins choreId against the chore list specifically because history rows used " +
              "to lack a name; if that changed, the join is no longer necessary.",
          );
        }
        return { detail: `${rows.length} row(s); first row has choreId=${JSON.stringify(row.choreId)}, no name field` };
      },
    );
  } finally {
    // This script never creates a project: resolveProjectId in chore-request.ts only looks
    // projects up by name, this server has no create-project path, and there is no verified
    // delete-project endpoint to exercise (rule: never guess a wire field name or path). So
    // the only scratch objects this run can have made are chores.
    for (const id of createdChoreIds) {
      try {
        await client.delete(endpoints.deleteChore(id));
      } catch (error) {
        results.push({
          name: `cleanup: delete chore ${id}`,
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await check("cleanup left no scratch chores from this run behind", async () => {
      const rows = (await client.get(endpoints.listChoresWithArchived())) as Array<{ name: string }>;
      const leftover = rows.filter((row) => row.name.startsWith(runPrefix));
      if (leftover.length > 0) {
        throw new Error(
          `${leftover.length} chore(s) from this run were not cleaned up: ${leftover.map((r) => r.name).join(", ")}`,
        );
      }
      return { detail: `no chore named "${runPrefix}-*" remains` };
    });
  }
}

function printReport(): void {
  const marker: Record<Status, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const nameWidth = results.reduce((max, r) => Math.max(max, r.name.length), 0);

  console.log("");
  for (const r of results) {
    console.log(`[${marker[r.status]}] ${r.name.padEnd(nameWidth)}  ${r.detail}`);
  }

  const passCount = results.filter((r) => r.status === "pass").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  console.log("");
  console.log(`${passCount} passed, ${warnCount} warned, ${failCount} failed (${results.length} checks total)`);
}

main()
  .catch((error) => {
    results.push({
      name: "verify-live crashed before finishing",
      status: "fail",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  })
  .finally(() => {
    printReport();
    process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
  });
