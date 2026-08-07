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
import { DonetickService } from "@/service";
import { editChore } from "@/tools/write";
import { parseConfig } from "@/config";
import { endpoints } from "@/endpoints";
import { DonetickError } from "@/errors";
import { concurrencyToken, mergeEditRequest } from "@/chore-request";
import type { Member, Project, RawChore } from "@/types";

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
  labelsV2: Array<{ id: number }>;
  priority: number;
  points: number | null;
  projectId: number | null;
  isRolling: boolean;
  isPrivate: boolean;
  requireApproval: boolean;
  completionWindow: number | null;
  notification: boolean;
  isActive?: boolean;
  subTasks?: Array<{ name: string; orderId: number; completedAt: string | null }>;
  notificationMetadata?: Record<string, unknown>;
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
   * Recurrence, labels, points and the approval flag live only on the chores list
   * row. GET /:id/details omits them, so reading a round-trip from there reports a
   * regression that is this script's own bug.
   */
  async function listRowById(id: number): Promise<Record<string, unknown>> {
    const rows = (await client.get(endpoints.listChores())) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`chore ${id} is not in the chores list`);
    return row;
  }

  /**
   * Create answers with a bare id, or with {res, warnings} when Donetick defaulted
   * a field. Both shapes are the contract, pinned by the check below; this helper
   * only needs the id out of either.
   */
  function createdIdOf(response: unknown): number {
    const bare =
      typeof response === "number"
        ? response
        : response && typeof response === "object" && "res" in response
          ? (response as { res: unknown }).res
          : undefined;
    if (typeof bare !== "number" || !Number.isInteger(bare) || bare <= 0) {
      throw new Error(
        `POST ${endpoints.createChore()} did not return a positive integer id, got ${JSON.stringify(response)}`,
      );
    }
    return bare;
  }

  async function createScratchChore(body: ChoreCreateBody): Promise<number> {
    const id = createdIdOf(await client.post(endpoints.createChore(), body));
    createdChoreIds.push(id);
    return id;
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

    await check("POST /chores/ answers {res: id}, with warnings alongside when it defaults a field", async () => {
      // Measured 2026-08-06 on the raw body, not through unwrap: create always
      // wraps, and adds warnings when it filled something in. The "bare number"
      // shape extractCreatedId also accepts is what unwrap produces downstream, not
      // anything Donetick sends. Omitting isActive reliably provokes a warning.
      //
      // postEnvelope, not post: post unwraps res and takes the siblings with it,
      // which left an earlier version of this check reporting "Donetick returned no
      // warnings" when it had returned some.
      const withDefault = await client.postEnvelope(
        endpoints.createChore(),
        baseChoreBody(scoped("warns")),
      );
      createdChoreIds.push(createdIdOf(withDefault));

      const siblings =
        withDefault && typeof withDefault === "object" && !Array.isArray(withDefault)
          ? Object.keys(withDefault).filter((key) => key !== "res")
          : [];
      const warnings =
        withDefault && typeof withDefault === "object" && "warnings" in withDefault
          ? (withDefault as { warnings: unknown }).warnings
          : undefined;

      if (warnings === undefined) {
        return {
          status: "warn",
          detail:
            "a create that omitted isActive drew no warnings, so create_chore's warnings field is " +
            `no longer exercised here. Siblings of res seen: ${siblings.join(", ") || "none"}.`,
        };
      }
      return {
        detail: `{res, ${siblings.join(", ")}}; warnings: ${JSON.stringify(warnings)}`,
      };
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
      "completing a recurrence schedules the date it describes, not just a round trip",
      async () => {
        // The old check here asserted only that weekPattern and occurrences survived
        // storage. They do: Donetick keeps frequency_meta_v2 as opaque JSON. What it
        // could not see is that the scheduler ignores them for day_of_the_month, so
        // the shape this server used to send produced a chore whose every completion
        // answered 500. Only a completion reveals that.
        //
        // Anchored on Thu 2026-09-10, where the answers are distinguishable: the next
        // Saturday is Sep 12, the first Saturday of the following month is Oct 3.
        const anchor = "2026-09-10T13:00:00Z";
        const dayOf = (value: unknown) =>
          typeof value === "string" ? new Date(value).toISOString().slice(0, 10) : String(value);

        const scheduleAfterCompleting = async (
          label: string,
          overrides: Partial<ChoreCreateBody>,
        ): Promise<string> => {
          const id = await createScratchChore(
            baseChoreBody(scoped(label), { nextDueDate: anchor, ...overrides }),
          );
          const response = (await client.post(endpoints.completeChore(id), {})) as Record<string, unknown>;
          return dayOf(response.nextDueDate);
        };

        const firstSaturday = await scheduleAfterCompleting("dow-occurrence", {
          frequencyType: "days_of_the_week",
          frequency: 1,
          frequencyMetadata: {
            days: ["saturday"],
            weekPattern: "week_of_month",
            occurrences: [1],
            timezone: config.timezone,
          },
        });
        if (firstSaturday !== "2026-10-03") {
          throw new Error(
            `days_of_the_week with occurrences [1] scheduled ${firstSaturday}, not the first Saturday 2026-10-03. buildFrequency maps "first saturday of every month" onto this type.`,
          );
        }

        const fifteenth = await scheduleAfterCompleting("dom-daynumber", {
          frequencyType: "day_of_the_month",
          frequency: 15,
          frequencyMetadata: { months: ["october"], timezone: config.timezone },
        });
        if (fifteenth !== "2026-10-15") {
          throw new Error(
            `day_of_the_month with frequency 15 scheduled ${fifteenth}, not 2026-10-15. buildFrequency puts the calendar day in frequency because of this.`,
          );
        }

        // The shape this server used to send, kept as a live tripwire: if Donetick
        // ever starts scheduling it, day_of_the_month grew weekday support and the
        // guard in buildFrequency can be revisited.
        const legacyId = await createScratchChore(
          baseChoreBody(scoped("dom-legacy"), {
            nextDueDate: anchor,
            frequencyType: "day_of_the_month",
            frequency: 1,
            frequencyMetadata: {
              days: ["saturday"],
              weekPattern: "week_of_month",
              occurrences: [1],
              timezone: config.timezone,
            },
          }),
        );
        let legacyRefused = false;
        try {
          await client.post(endpoints.completeChore(legacyId), {});
        } catch {
          legacyRefused = true;
        }
        if (!legacyRefused) {
          return {
            status: "warn",
            detail:
              "day_of_the_month with days and occurrences now completes, so it may have grown weekday support and buildFrequency's refusal could be relaxed",
          };
        }

        return {
          detail: "occurrences [1] gave 2026-10-03, day 15 gave 2026-10-15, weekday-shaped day_of_the_month still refuses to complete",
        };
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

    await check(
      "PUT /chores/ with only the name changed preserves every other field",
      async () => {
        // The endpoint this server can do the most damage with, and the one the
        // rest of the suite did not touch. Donetick has no partial update: the PUT
        // replaces the chore, so a field the merge fails to carry is not left alone,
        // it is erased. A rename is the smallest possible edit, which makes it the
        // sharpest probe: everything that changes here changed for no reason.
        //
        // The body goes through the real mergeEditRequest rather than a hand-built
        // one, so a regression in Donetick's binding and a regression in the merge
        // are both in scope.
        const [members, projects] = (await Promise.all([
          client.get(endpoints.circleMembers()),
          client.get(endpoints.projects()).then((p) => p ?? []),
        ])) as [Member[], Project[]];
        const someone = members[0]!.userId;

        const id = await createScratchChore(
          baseChoreBody(scoped("edit-preserve"), {
            frequencyType: "interval",
            frequency: 3,
            frequencyMetadata: { unit: "days", time: "", timezone: config.timezone },
            // Deliberately left without a description, which is both the default and
            // the case that used to 502. Giving this chore one is what let the crash
            // hide behind a passing check.
            priority: 2,
            points: 5,
            requireApproval: true,
            // Not rolling: ensureDueDateForRolling rewrites a lost due date to
            // today, so a rolling fixture turns "the date was destroyed" into
            // "the date is plausible" and the check cannot see the difference.
            isRolling: false,
            completionWindow: 4,
            // Populated on purpose. An empty assignee list cannot be emptied and a
            // chore with no subtasks cannot lose them, so a bare fixture makes the
            // destruction this check exists to catch impossible to observe.
            // keep_last_assigned, not the no_assignee default: a chore carrying
            // no_assignee with someone on it is the state mergeEditRequest promotes
            // away from, so leaving it here would make the promotion look like the
            // destruction this check hunts for.
            assignStrategy: "keep_last_assigned",
            assignedTo: someone,
            assignees: [{ userId: someone }],
            subTasks: [
              { name: "first", orderId: 0, completedAt: new Date().toISOString() },
              { name: "second", orderId: 1, completedAt: null },
            ],
            notification: true,
            notificationMetadata: { dueDate: true, templates: [{ value: 1, unit: "h" }] },
          }),
        );

        const before = (await listRowById(id)) as unknown as RawChore;

        const body = mergeEditRequest(
          before,
          { name: `${scoped("edit-preserve")}-renamed` },
          { members, projects, now: new Date(), timezone: config.timezone },
        );
        await client.put(endpoints.editChore(), body);

        const after = (await listRowById(id)) as unknown as RawChore;

        if (after.name === before.name) {
          throw new Error("the rename did not land, so this check proves nothing about the rest");
        }

        const preserved = [
          "nextDueDate",
          "assignedTo",
          "frequencyType",
          "frequency",
          "priority",
          "points",
          "requireApproval",
          "isRolling",
          "completionWindow",
          "assignStrategy",
          "isPrivate",
          "notification",
          "projectId",
        ] as const;

        const destroyed = preserved.filter(
          (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
        );
        if (destroyed.length > 0) {
          throw new Error(
            `a rename changed ${destroyed.length} unrelated field(s): ${destroyed
              .map((f) => `${f} ${JSON.stringify(before[f])} -> ${JSON.stringify(after[f])}`)
              .join("; ")}`,
          );
        }

        const deepFields = ["frequencyMetadata", "assignees", "subTasks", "notificationMetadata"] as const;
        const changed = deepFields.filter(
          (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
        );
        if (changed.length > 0) {
          throw new Error(
            `a rename changed ${changed
              .map((f) => `${f} ${JSON.stringify(before[f])} -> ${JSON.stringify(after[f])}`)
              .join("; ")}`,
          );
        }

        return { detail: `chore ${id}: renamed, and all ${preserved.length + 1} other fields intact` };
      },
    );

    await check("PUT /chores/ rejects a null description by dropping the connection", async () => {
      // The reason ChoreRequestBody.description is typed string and both builders
      // coerce to "". If this ever starts succeeding, that coercion can go, and if
      // it starts failing for "" as well, every edit in this server is broken and
      // this check is where that becomes visible.
      const id = await createScratchChore(baseChoreBody(scoped("null-desc"), { frequencyType: "daily" }));
      const row = (await listRowById(id)) as unknown as RawChore;
      const body = mergeEditRequest(
        row,
        { name: scoped("null-desc-renamed") },
        { members: [], projects: [], now: new Date(), timezone: config.timezone },
      ) as unknown as Record<string, unknown>;

      body.description = null;
      let nullRejected = false;
      try {
        await client.put(endpoints.editChore(), body);
      } catch {
        nullRejected = true;
      }

      body.description = "";
      await client.put(endpoints.editChore(), body);
      const after = (await listRowById(id)) as unknown as RawChore;
      if (after.name === row.name) {
        throw new Error('the edit with description "" did not land, so every edit in this server is broken');
      }

      return nullRejected
        ? { detail: 'null rejected as expected, "" accepted and the edit landed' }
        : {
            status: "warn",
            detail:
              'Donetick now accepts a null description on PUT /chores/. Nothing breaks, since both builders send "" regardless, but the coercion in chore-request.ts is no longer load-bearing.',
          };
    });

    await check("PUT /chores/ ignores nextDueDate: null, so a clear has to go to /:id/dueDate", async () => {
      // edit_chore advertises due_date: null. The full edit assigns nextDueDate only
      // when non-nil and otherwise keeps the stored value, so a null there is a 200
      // that changes nothing. editChore routes the clear to /:id/dueDate because of
      // this. If the full edit ever starts honouring null, that detour can go.
      const id = await createScratchChore(baseChoreBody(scoped("cleardue"), { frequencyType: "daily" }));
      const row = (await listRowById(id)) as unknown as RawChore;
      await client.put(endpoints.editChore(), {
        ...mergeEditRequest(row, {}, { members: [], projects: [], now: new Date(), timezone: config.timezone }),
        nextDueDate: null,
      });
      const afterFullEdit = (await listRowById(id)) as unknown as RawChore;

      await client.put(endpoints.updateDueDate(id), {
        dueDate: null,
        updatedAt: concurrencyToken(afterFullEdit, new Date()),
      });
      const afterTargeted = (await listRowById(id)) as unknown as RawChore;

      if (afterTargeted.nextDueDate !== null) {
        throw new Error("PUT /:id/dueDate no longer clears a due date, so edit_chore cannot clear one at all");
      }
      return afterFullEdit.nextDueDate === null
        ? {
            status: "warn",
            detail: "the full edit now honours nextDueDate: null, so editChore's separate /dueDate call is redundant",
          }
        : { detail: "full edit kept the date, targeted update cleared it" };
    });

    await check("edit_chore's real two-write sequence clears a due date and reports it", async () => {
      // Drives the production path rather than a hand-built one. The earlier check
      // re-reads the row between the two writes, which is exactly the step the
      // production code was missing, so it could not have caught the stale token.
      const service = new DonetickService(client, { cacheTtlMs: 0 });
      const ctx = { service, timezone: config.timezone, now: () => new Date() };
      const id = await createScratchChore(
        baseChoreBody(scoped("edit-clear"), { frequencyType: "daily", priority: 3 }),
      );
      service.invalidateChores();

      const outcome = await editChore({ chore_id: id, due_date: null, name: scoped("edit-clear-renamed") }, ctx);
      if (outcome.kind !== "edited") {
        throw new Error(`edit_chore reported ${outcome.kind}: ${JSON.stringify(outcome)}`);
      }

      const after = (await listRowById(id)) as unknown as RawChore;
      if (after.nextDueDate !== null) {
        throw new Error(`the due date was not cleared: still ${JSON.stringify(after.nextDueDate)}`);
      }
      if (after.name === scoped("edit-clear")) {
        throw new Error("the rename did not land, so the two writes did not both apply");
      }
      if (outcome.chore.due_date !== null) {
        throw new Error(
          `the tool reported due_date ${JSON.stringify(outcome.chore.due_date)} after clearing it`,
        );
      }
      return { detail: "both writes landed and the reported state matches the row" };
    });

    await check("frequencyMetadata.time is RFC3339, not HH:MM", async () => {
      // buildFrequency converts HH:MM because of this. Donetick binds
      // datetime=2006-01-02T15:04:05Z07:00 and the scheduler parses time.RFC3339, so
      // the HH:MM this server used to send was refused on every create that set one.
      const withClock = {
        frequencyType: "days_of_the_week",
        frequencyMetadata: { days: ["monday"], time: "1970-01-01T09:00:00-05:00", timezone: config.timezone },
      };
      const id = await createScratchChore(baseChoreBody(scoped("time-rfc"), withClock));
      const row = (await listRowById(id)) as unknown as RawChore;
      const stored = (row.frequencyMetadata as Record<string, unknown> | null)?.time;

      let hhmmRejected = false;
      try {
        const bad = await client.postEnvelope(
          endpoints.createChore(),
          baseChoreBody(scoped("time-hhmm"), {
            frequencyType: "days_of_the_week",
            frequencyMetadata: { days: ["monday"], time: "09:00", timezone: config.timezone },
          }),
        );
        createdChoreIds.push(createdIdOf(bad));
      } catch {
        hhmmRejected = true;
      }

      if (!hhmmRejected) {
        return {
          status: "warn",
          detail: `Donetick now accepts HH:MM for frequencyMetadata.time, so normalizeTime's conversion is no longer required. RFC3339 stored as ${JSON.stringify(stored)}.`,
        };
      }
      return { detail: `HH:MM refused, RFC3339 stored as ${JSON.stringify(stored)}` };
    });

    await check("a completion window with no due date makes completion fail, so the client refuses to create one", async () => {
      // Donetick dereferences NextDueDate without a nil check when a completion
      // window is set, so the chore can be created and then never completed. Verified
      // live: every /do answers 502. requireDueDateFor in chore-request.ts refuses the
      // combination rather than letting a caller make an uncompletable chore.
      const id = await createScratchChore(
        baseChoreBody(scoped("window"), { frequencyType: "daily", completionWindow: 4, nextDueDate: null }),
      );
      try {
        await client.post(endpoints.completeChore(id), {});
      } catch {
        return { detail: "completion refused as expected, which is why the client blocks the combination" };
      }
      return {
        status: "warn",
        detail:
          "a chore with a completion window and no due date now completes cleanly, so requireDueDateFor could allow the combination again",
      };
    });

    await check("PUT /:id/subtask ticks one item and an unrelated edit leaves it ticked", async () => {
      // The body field names here were chosen rather than read, which rule 5 warns
      // about, and nothing exercised the endpoint live until now. The second half
      // matters separately: carriedSubtasks sends only id, name, orderId and
      // completedAt, so completedBy and parentId survive only if Donetick keeps them.
      const id = await createScratchChore(
        baseChoreBody(scoped("subtask"), {
          frequencyType: "daily",
          subTasks: [{ name: "tick me", orderId: 0, completedAt: null }],
        }),
      );
      const created = (await listRowById(id)) as unknown as RawChore;
      const item = created.subTasks?.[0];
      if (item === undefined) throw new Error("the created chore came back with no subtasks");

      await client.put(endpoints.updateSubtask(id), {
        id: item.id,
        choreId: id,
        completedAt: new Date().toISOString(),
      });
      const ticked = (await listRowById(id)) as unknown as RawChore;
      const tickedItem = ticked.subTasks?.[0];
      if (!tickedItem?.completedAt) {
        throw new Error(
          `the subtask did not tick, so the body field names are wrong: ${JSON.stringify(ticked.subTasks)}`,
        );
      }

      await client.put(
        endpoints.editChore(),
        mergeEditRequest(ticked, { name: scoped("subtask-renamed") }, {
          members: [],
          projects: [],
          now: new Date(),
          timezone: config.timezone,
        }),
      );
      const after = (await listRowById(id)) as unknown as RawChore;
      const afterItem = after.subTasks?.[0];

      if (afterItem?.completedAt !== tickedItem.completedAt) {
        throw new Error(
          `a rename changed the subtask's completedAt: ${JSON.stringify(tickedItem.completedAt)} -> ${JSON.stringify(afterItem?.completedAt)}`,
        );
      }
      if (afterItem?.completedBy !== tickedItem.completedBy) {
        return {
          status: "warn",
          detail: `a rename changed completedBy from ${JSON.stringify(tickedItem.completedBy)} to ${JSON.stringify(afterItem?.completedBy)}; carriedSubtasks does not send it, so Donetick must be preserving it`,
        };
      }
      return { detail: "ticked, and the tick and its attribution both survived an unrelated edit" };
    });

    await check("PUT /:id/assignee stores the token it is given, so it must be the row's own", async () => {
      // Every endpoint that takes a token compares it; this one also writes it into
      // the row. A clock reading would stamp the chore with a version the sender's
      // own skew invented, and a later write trailing that value is refused.
      // concurrencyToken sends the stored value for exactly this reason.
      const roster = (await client.get(endpoints.circleMembers())) as Member[];
      const target = roster[roster.length - 1]!;
      const id = await createScratchChore(
        baseChoreBody(scoped("assignee-token"), {
          frequencyType: "daily",
          assignStrategy: "keep_last_assigned",
          assignedTo: roster[0]!.userId,
          assignees: roster.map((m) => ({ userId: m.userId })),
        }),
      );

      const before = (await listRowById(id)) as unknown as RawChore;
      if (before.updatedAt === undefined) {
        return { status: "warn", detail: "the list row no longer carries updatedAt" };
      }
      await client.put(endpoints.updateAssignee(id), {
        assignee: target.userId,
        updatedAt: concurrencyToken(before, new Date()),
      });
      const after = (await listRowById(id)) as unknown as RawChore;

      if (after.updatedAt !== before.updatedAt) {
        return {
          status: "warn",
          detail: `the stamp moved from ${before.updatedAt} to ${after.updatedAt}, so this endpoint no longer stores the token and concurrencyToken could send a clock reading again`,
        };
      }
      return { detail: "the stamp is unchanged, so the stored token was written back as a no-op" };
    });

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

    await check("the updatedAt token must be at least the stored value, which a Date round trip can undershoot", async () => {
      // Measured on v0.1.76. The comparison is sent >= stored, and stored carries
      // nanosecond precision, so rebuilding it through Date truncates downward and
      // lands just under. The same shape of failure happens with a plain "now" when
      // the server's clock runs ahead of the client's, which it did by a few
      // milliseconds here. concurrencyToken() in chore-request.ts exists for both.
      const id = await createScratchChore(baseChoreBody(scoped("token"), { frequencyType: "daily" }));
      const row = (await listRowById(id)) as unknown as RawChore;
      const stored = row.updatedAt;
      if (stored === undefined) {
        return {
          status: "warn",
          detail: "the chores list row no longer carries updatedAt, so concurrencyToken has nothing to read",
        };
      }

      const attempt = async (token: string): Promise<boolean> => {
        try {
          await client.put(endpoints.updateDueDate(id), {
            dueDate: new Date(Date.now() + 86_400_000).toISOString(),
            updatedAt: token,
          });
          return true;
        } catch {
          return false;
        }
      };

      const truncated = new Date(stored).toISOString();
      const truncatedRejected = truncated === stored ? null : !(await attempt(truncated));
      const rawAccepted = await attempt(stored);

      if (!rawAccepted) {
        throw new Error(
          `the row's own updatedAt (${stored}) was refused, so concurrencyToken cannot produce a token this endpoint accepts`,
        );
      }
      if (truncatedRejected === false) {
        return {
          status: "warn",
          detail:
            "a millisecond-truncated updatedAt is now accepted, so the precision half of concurrencyToken is no longer load-bearing",
        };
      }
      return {
        detail:
          truncatedRejected === null
            ? `stored stamp accepted; it had no sub-millisecond digits to lose`
            : `stored stamp accepted, its millisecond-truncated form refused`,
      };
    });

    await check("PUT /:id/dueDate with updatedAt succeeds and returns the pre-update chore", async () => {
      const id = await createScratchChore(baseChoreBody(scoped("duedate-echo"), { frequencyType: "daily" }));
      const before = (await client.get(endpoints.choreDetails(id))) as Record<string, unknown>;
      const row = (await listRowById(id)) as unknown as RawChore;
      const sentDueDate = new Date(Date.now() + 86_400_000).toISOString();
      const response = (await client.put(endpoints.updateDueDate(id), {
        dueDate: sentDueDate,
        updatedAt: concurrencyToken(row, new Date()),
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

    await check("approve flips the pending history row to completed, and reject writes its own", async () => {
      // Neither endpoint had ever been called live. This also settles what
      // list_activity's completions-only default does with an approval-gated chore:
      // approving rewrites the row rather than adding one, so an approved completion
      // shows up and a still-pending one correctly does not.
      const statusesFor = async (id: number): Promise<number[]> => {
        const rows = (await client.get(endpoints.choreHistory(7, true))) as Array<{
          choreId: number;
          status: number;
        }>;
        return rows.filter((r) => r.choreId === id).map((r) => r.status);
      };
      const pending = async (label: string): Promise<number> => {
        const id = await createScratchChore(
          baseChoreBody(scoped(label), { frequencyType: "daily", requireApproval: true }),
        );
        await client.post(endpoints.completeChore(id), {});
        return id;
      };

      const approved = await pending("approve");
      if (!(await statusesFor(approved)).includes(3)) {
        throw new Error("completing a requireApproval chore did not leave a pending history row");
      }
      await client.post(endpoints.approveChore(approved), {});
      const afterApprove = await statusesFor(approved);
      if (!afterApprove.includes(1)) {
        throw new Error(
          `approving left history at ${JSON.stringify(afterApprove)} rather than completed. list_activity filters to completed, so approved completions would vanish from it.`,
        );
      }

      const rejected = await pending("reject");
      await client.post(endpoints.rejectChore(rejected), {});
      const afterReject = await statusesFor(rejected);
      if (!afterReject.includes(4)) {
        return {
          status: "warn",
          detail: `rejecting left history at ${JSON.stringify(afterReject)}, not 4; CHORE_HISTORY_STATUS maps 4 to rejected`,
        };
      }
      return { detail: "approve rewrote 3 to 1, reject wrote 4" };
    });

    await check("POST /:id/nudge answers a bare {message} with no res envelope", async () => {
      // nudgeChore reads message off the top level. unwrap() discards every sibling
      // of res, so if this endpoint ever starts answering {res, message} like
      // /:id/do does, messageOf goes undefined, the "across 0 device(s)" detection
      // stops firing, and every nudge reports as delivered. Measured 2026-08-06:
      // bare {message}, no res.
      const roster = (await client.get(endpoints.circleMembers())) as Member[];
      if (roster.length < 2) {
        return {
          status: "warn",
          detail:
            "this circle has one member, and Donetick removes the caller from the nudge target list, " +
            "so the nudge contract cannot be exercised here",
        };
      }
      const other = roster.find((m) => m.userId !== roster[0]!.userId)!;
      const id = await createScratchChore(
        baseChoreBody(scoped("nudge"), {
          frequencyType: "daily",
          assignStrategy: "keep_last_assigned",
          assignedTo: other.userId,
          assignees: [{ userId: other.userId }],
        }),
      );

      const response = await client.post(endpoints.nudgeChore(id), {
        all_assignees: false,
        message: "",
      });

      if (response === null || typeof response !== "object") {
        throw new Error(`expected an object back, got ${JSON.stringify(response)}`);
      }
      if (!("message" in response)) {
        throw new Error(
          `the nudge response carries no readable message after unwrap: ${JSON.stringify(response)}. ` +
            "nudgeChore derives delivery from that string, so it would report every nudge as delivered.",
        );
      }
      const message = (response as { message: unknown }).message;
      if (typeof message !== "string") {
        throw new Error(`message is not a string: ${JSON.stringify(message)}`);
      }
      if (!/across \d+ device/i.test(message)) {
        return {
          status: "warn",
          detail: `the message no longer carries an "across N device(s)" count (${JSON.stringify(message)}), so nudgeChore's delivery detection is now inert`,
        };
      }
      return { detail: `bare {message}, no res envelope: ${JSON.stringify(message)}` };
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
