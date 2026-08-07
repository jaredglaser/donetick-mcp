import { describe, expect, test } from "bun:test";
import { createChore, deleteChore, editChore, type WriteContext } from "../write";
import type { CreateInput } from "@/chore-request";
import { DonetickClient } from "@/client";
import { DonetickError } from "@/errors";
import type { Member, Project, RawChore } from "@/types";

const now = new Date("2026-08-06T16:00:00Z");
const tz = "America/New_York";

const members: Member[] = [
  { userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 0, pointsRedeemed: 0 },
  { userId: 2, username: "sam", displayName: "Sam", role: "member", points: 0, pointsRedeemed: 0 },
];
const projects: Project[] = [{ id: 4, name: "Household" }];

interface FakeOptions {
  /** A function lets a test change what the list returns between calls, for the retry path. */
  chores?: RawChore[] | (() => RawChore[]);
  archivedChores?: RawChore[];
  members?: Member[];
  projects?: Project[];
  choreDetails?: (id: number) => RawChore | Promise<RawChore>;
  post?: (path: string, body?: unknown) => unknown | Promise<unknown>;
  put?: (path: string, body?: unknown) => unknown | Promise<unknown>;
  del?: (path: string) => unknown | Promise<unknown>;
}

function fakeService(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const bodies: Array<{ path: string; body?: unknown }> = [];
  let invalidations = 0;

  const service = {
    chores: async () => {
      calls.push("GET chores");
      return typeof opts.chores === "function" ? opts.chores() : (opts.chores ?? []);
    },
    allChores: async () => (typeof opts.chores === 'function' ? opts.chores() : (opts.chores ?? [])),
    archivedChores: async () => {
      calls.push("GET archivedChores");
      return opts.archivedChores ?? [];
    },
    invalidateChores: () => {
      calls.push("invalidateChores");
    },
    members: async () => opts.members ?? members,
    projects: async () => opts.projects ?? projects,
    choreDetails: async (id: number) => {
      calls.push(`GET details ${id}`);
      if (!opts.choreDetails) throw new Error("no choreDetails handler configured for this test");
      return opts.choreDetails(id);
    },
    write: async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } finally {
        invalidations += 1;
      }
    },
    client: {
      post: async (path: string, body?: unknown) => {
        calls.push(`POST ${path}`);
        if (!opts.post) return undefined;
        return opts.post(path, body);
      },
      // create uses postEnvelope so it can see warnings alongside res. The fake
      // routes both to the same handler, and the warnings test below deliberately
      // goes through a real client instead, since only that crosses unwrap.
      postEnvelope: async (path: string, body?: unknown) => {
        calls.push(`POST ${path}`);
        if (!opts.post) return undefined;
        return opts.post(path, body);
      },
      put: async (path: string, body?: unknown) => {
        calls.push(`PUT ${path}`);
        bodies.push({ path, body });
        if (!opts.put) return undefined;
        return opts.put(path, body);
      },
      delete: async (path: string) => {
        calls.push(`DELETE ${path}`);
        if (!opts.del) return undefined;
        return opts.del(path);
      },
    },
  };

  return { service, calls, bodies, invalidations: () => invalidations };
}

function ctxFor(service: ReturnType<typeof fakeService>["service"]): WriteContext {
  return { service: service as never, now: () => now, timezone: tz };
}

// updatedAt at the precision Donetick actually sends. Without it every token
// expression collapses to the clock and the /dueDate clear's re-read is invisible.
const STORED_STAMP = "2026-08-06T10:00:00.111111111Z";

const listRow: RawChore = {
  id: 5,
  name: "Take out trash",
  updatedAt: STORED_STAMP,
  description: null,
  nextDueDate: "2026-08-10T12:00:00Z",
  assignedTo: 1,
  assignees: [{ userId: 1 }],
  assignStrategy: "keep_last_assigned",
  labelsV2: [{ id: 10, name: "Kitchen" }],
  priority: 2,
  status: 0,
  frequencyType: "daily",
  frequency: 1,
  frequencyMetadata: { timezone: tz },
  isRolling: false,
  isActive: true,
  isPrivate: false,
  requireApproval: true,
  notification: false,
  notificationMetadata: null,
  completionWindow: null,
  points: 3,
  projectId: 4,
  createdBy: 1,
  subTasks: [],
};

// A shape mimicking GET /details: missing assignStrategy, frequencyMetadata, and
// labelsV2 among other list-only fields. mergeEditRequest throws if handed this as
// the merge base, so any test that hands editChore this fixture and expects success
// proves the pre-edit merge base was the list row, not this object.
const detailsShapedRow = {
  id: 5,
  name: "Take out trash",
  description: null,
  nextDueDate: "2026-08-10T12:00:00Z",
  assignedTo: 1,
  priority: 2,
  status: 0,
  frequencyType: "daily",
  createdBy: 1,
  lastCompletedDate: null,
  lastCompletedBy: null,
  totalCompletedCount: 0,
} as unknown as RawChore;

describe("createChore", () => {
  test("posts to /api/v1/chores/ and then fetches details for the returned id", async () => {
    const fake = fakeService({
      post: () => 42,
      choreDetails: (id) => ({ ...listRow, id }),
    });

    const outcome = await createChore({ name: "Trash" }, ctxFor(fake.service));

    expect(fake.calls).toContain("POST /api/v1/chores/");
    expect(fake.calls).toContain("GET details 42");
    expect(outcome.kind).toBe("created");
  });

  test("sends both required enums, frequencyType and assignStrategy", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fake = fakeService({
      post: (_path, body) => {
        sentBody = body as Record<string, unknown>;
        return 1;
      },
      choreDetails: (id) => ({ ...listRow, id }),
    });

    await createChore({ name: "Trash" }, ctxFor(fake.service));

    expect(sentBody?.frequencyType).toBe("once");
    expect(sentBody?.assignStrategy).toBe("no_assignee");
    // Sent so Donetick stops warning about it on every create, which is what makes
    // the warnings channel a signal rather than noise.
    expect(sentBody?.isActive).toBe(true);
  });

  test("invalidates the cache even when the post fails", async () => {
    const fake = fakeService({
      post: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(createChore({ name: "Trash" }, ctxFor(fake.service))).rejects.toThrow(
      "instance unreachable",
    );
    expect(fake.invalidations()).toBe(1);
  });

  test("errors clearly if the response is not a number", async () => {
    const fake = fakeService({ post: () => ({ ok: true }) });

    await expect(createChore({ name: "Trash" }, ctxFor(fake.service))).rejects.toThrow(
      /numeric id/,
    );
  });

  test("errors clearly when name is absent", async () => {
    const fake = fakeService();

    await expect(createChore({} as CreateInput, ctxFor(fake.service))).rejects.toThrow(/name/i);
    expect(fake.calls).toEqual([]);
  });

  test("a response of 0 is rejected rather than treated as a missing-but-ok id", async () => {
    const fake = fakeService({ post: () => 0 });

    await expect(createChore({ name: "Trash" }, ctxFor(fake.service))).rejects.toThrow(
      /numeric id/,
    );
    expect(fake.calls).not.toContain("GET details 0");
  });

  test("when the follow-up detail fetch fails, reports the chore as created rather than failing outright", async () => {
    const fake = fakeService({
      post: () => 42,
      choreDetails: () => {
        throw new Error("timed out");
      },
    });

    const outcome = await createChore({ name: "Trash" }, ctxFor(fake.service));

    expect(outcome.kind).toBe("created_detail_unavailable");
    if (outcome.kind === "created_detail_unavailable") {
      expect(outcome.id).toBe(42);
      expect(outcome.message).toMatch(/42/);
      expect(outcome.message).toMatch(/timed out/);
    }
  });

  test("surfaces warnings from the create response when present", async () => {
    // Deliberately routed through a real DonetickClient over an injected fetch,
    // not through a fake standing in for the client. The fake used to return the
    // {res, warnings} envelope raw, one layer below the unwrapping the real client
    // always performs, so this test passed while unwrap discarded warnings and the
    // feature could not work at all. Anything asserting on a response shape has to
    // cross the layer that reshapes it.
    const client = new DonetickClient({
      baseUrl: "https://donetick.test",
      token: "t",
      timeoutMs: 1000,
      fetchFn: (async (_url: string, init?: { method?: string }) => {
        const payload =
          init?.method === "POST"
            ? { res: 42, warnings: ["defaulted to once"] }
            : { res: { ...listRow, id: 42 } };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const service = {
      members: async () => members,
      projects: async () => projects,
      choreDetails: async (id: number) => ({ ...listRow, id }),
      write: async <T>(operation: () => Promise<T>) => operation(),
      client,
    };

    const outcome = await createChore({ name: "Trash" }, ctxFor(service as never));

    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") {
      expect(outcome.warnings).toEqual(["defaulted to once"]);
    }
  });

  test("a bare numeric id still works, since Donetick only sends an envelope when it has something to say", async () => {
    const fake = fakeService({
      post: () => 42,
      choreDetails: (id) => ({ ...listRow, id }),
    });

    const outcome = await createChore({ name: "Trash" }, ctxFor(fake.service));

    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") {
      expect(outcome.warnings).toBeUndefined();
    }
  });
});

describe("editChore", () => {
  test("reads the chore from the cached list, not from choreDetails", async () => {
    const fake = fakeService({
      chores: [listRow],
      put: () => undefined,
      choreDetails: () => detailsShapedRow,
    });

    // If editChore merged onto choreDetails' return instead of the list row,
    // mergeEditRequest's assertListRowShape guard would throw here.
    await expect(
      editChore({ chore_id: 5, description: "updated" }, ctxFor(fake.service)),
    ).resolves.toBeDefined();

    expect(fake.calls).toContain("GET chores");
  });

  test("PUTs to the collection root with id in the body", async () => {
    let sentPath = "";
    let sentBody: Record<string, unknown> | undefined;
    const fake = fakeService({
      chores: [listRow],
      put: (path, body) => {
        sentPath = path;
        sentBody = body as Record<string, unknown>;
      },
      choreDetails: () => detailsShapedRow,
    });

    await editChore({ chore_id: 5, description: "updated" }, ctxFor(fake.service));

    expect(sentPath).toBe("/api/v1/chores/");
    expect(sentBody?.id).toBe(5);
  });

  test("preserves a field the input did not mention, end to end through this module", async () => {
    // requireApproval is one of the fields GET /details omits, so detailsShapedRow
    // deliberately leaves it out. If editChore only used the post-edit detail
    // fetch to build its result, this would come back false instead of true.
    const fake = fakeService({
      chores: [listRow],
      put: () => undefined,
      choreDetails: () => detailsShapedRow,
    });

    const result = await editChore({ chore_id: 5, description: "updated" }, ctxFor(fake.service));

    if (result.kind !== "edited") throw new Error("expected an edited outcome");

    expect(result.chore.requires_approval).toBe(true);
    expect(result.chore.labels).toEqual(["Kitchen"]);
  });

  test("errors clearly when chore_id is absent", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(editChore({ description: "x" }, ctxFor(fake.service))).rejects.toThrow(
      /chore_id/,
    );
  });

  test("errors clearly on a chore id absent from the cached list", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(editChore({ chore_id: 999, description: "x" }, ctxFor(fake.service))).rejects.toThrow(
      /999/,
    );
  });

  describe("optimistic concurrency", () => {
    const versioned = (updatedAt: string, overrides: Partial<RawChore> = {}): RawChore => ({
      ...listRow,
      updatedAt,
      ...overrides,
    });

    test("sends the merge base's updatedAt, not the current time", async () => {
      // Verified live on v0.1.76: sending the value the row was read with is
      // accepted, an older one is refused, and sending nothing skips the check and
      // overwrites whatever landed in between. The current time would always be
      // newer than the stored version, which is the one shape that reads as a
      // token while behaving like no token at all.
      let sent: Record<string, unknown> | undefined;
      const fake = fakeService({
        chores: [versioned("2026-08-06T10:00:00Z")],
        put: (_path, body) => {
          sent = body as Record<string, unknown>;
          return undefined;
        },
        choreDetails: () => detailsShapedRow,
      });

      await editChore({ chore_id: 5, name: "Renamed" }, ctxFor(fake.service));

      expect(sent?.updatedAt).toBe("2026-08-06T10:00:00Z");
    });

    test("omits updatedAt when the row carries none, rather than inventing one", async () => {
      let sent: Record<string, unknown> | undefined;
      const { updatedAt: _stamp, ...stampless } = listRow;
      const fake = fakeService({
        chores: [stampless as RawChore],
        put: (_path, body) => {
          sent = body as Record<string, unknown>;
          return undefined;
        },
        choreDetails: () => detailsShapedRow,
      });

      await editChore({ chore_id: 5, name: "Renamed" }, ctxFor(fake.service));

      expect(sent).not.toHaveProperty("updatedAt");
    });

    test("rebuilds on the newer version and retries once when Donetick reports a conflict", async () => {
      // Someone else edits between this server's read and its write. Donetick
      // refuses rather than letting the stale body overwrite them, and the fix is
      // to re-merge onto their version: input is a sparse patch, so their change
      // survives and only the caller's field is applied on top.
      const versions = [
        versioned("2026-08-06T10:00:00Z", { points: 5 }),
        versioned("2026-08-06T10:00:05Z", { points: 99 }),
      ];
      let read = 0;
      const sent: Array<Record<string, unknown>> = [];
      const fake = fakeService({
        chores: () => [versions[Math.min(read++, versions.length - 1)]!],
        put: (_path, body) => {
          sent.push(body as Record<string, unknown>);
          if (sent.length === 1) {
            throw new DonetickError("chore has been modified by another user", {
              status: 403,
              retryable: true,
              invalidatesCache: true,
            });
          }
          return undefined;
        },
        choreDetails: () => detailsShapedRow,
      });

      const outcome = await editChore({ chore_id: 5, name: "Renamed" }, ctxFor(fake.service));

      expect(outcome.kind).toBe("edited");
      expect(sent.length).toBe(2);
      expect(sent[0]?.updatedAt).toBe("2026-08-06T10:00:00Z");
      expect(sent[1]?.updatedAt).toBe("2026-08-06T10:00:05Z");
      // The other writer's change survives, and the caller's is applied on top.
      expect(sent[1]?.points).toBe(99);
      expect(sent[1]?.name).toBe("Renamed");
      expect(fake.calls).toContain("invalidateChores");
    });

    test("gives up after one retry rather than looping on a permission failure", async () => {
      let attempts = 0;
      const fake = fakeService({
        chores: [versioned("2026-08-06T10:00:00Z")],
        put: () => {
          attempts += 1;
          throw new DonetickError("Donetick refused: not your chore", {
            status: 403,
            retryable: true,
            invalidatesCache: true,
          });
        },
        choreDetails: () => detailsShapedRow,
      });

      await expect(editChore({ chore_id: 5, name: "Renamed" }, ctxFor(fake.service))).rejects.toThrow(
        /refused/,
      );
      expect(attempts).toBe(2);
    });

    test("does not retry an error that is not retryable", async () => {
      let attempts = 0;
      const fake = fakeService({
        chores: [versioned("2026-08-06T10:00:00Z")],
        put: () => {
          attempts += 1;
          throw new DonetickError("Donetick rejected the request: bad frequency", { status: 400 });
        },
        choreDetails: () => detailsShapedRow,
      });

      await expect(editChore({ chore_id: 5, name: "Renamed" }, ctxFor(fake.service))).rejects.toThrow(
        /bad frequency/,
      );
      expect(attempts).toBe(1);
    });
  });
});

describe("deleteChore", () => {
  // Takes the chore itself: the handler in tools/index.ts resolves it, including
  // the archived list, and hands it over. Resolution behavior is covered there.
  const archivedRow: RawChore = { ...listRow, id: 7, name: "Old chore", isActive: false };

  test("with no answer, returns confirm_required, makes no DELETE call, and names the chore and archiving", async () => {
    const fake = fakeService({});

    const outcome = await deleteChore(listRow, ctxFor(fake.service), undefined);

    expect(outcome.kind).toBe("confirm_required");
    if (outcome.kind === "confirm_required") {
      expect(outcome.chore).toBe("Take out trash");
      expect(outcome.message).toMatch(/Take out trash/);
      expect(outcome.message).toMatch(/archive/i);
    }
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  test("with confirm: false, returns declined and makes no DELETE call", async () => {
    const fake = fakeService({});

    const outcome = await deleteChore(listRow, ctxFor(fake.service), { confirm: false });

    expect(outcome).toEqual({ kind: "declined", chore: "Take out trash" });
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  test("with confirm: true, issues DELETE /api/v1/chores/<id>", async () => {
    const fake = fakeService({});

    const outcome = await deleteChore(listRow, ctxFor(fake.service), { confirm: true });

    expect(fake.calls).toContain("DELETE /api/v1/chores/5");
    expect(outcome).toEqual({ kind: "deleted", deleted: 5, name: "Take out trash" });
  });

  test("deletes an archived chore, which Donetick's DELETE accepts", async () => {
    // Verified live on 2026-08-06: archiving then deleting the same chore
    // succeeds and the row is gone. Refusing it here would be this server
    // inventing a restriction the API does not have.
    const fake = fakeService({});

    const outcome = await deleteChore(archivedRow, ctxFor(fake.service), { confirm: true });

    expect(fake.calls).toContain("DELETE /api/v1/chores/7");
    expect(outcome).toEqual({ kind: "deleted", deleted: 7, name: "Old chore" });
  });

  test("does not offer to archive a chore that is already archived", async () => {
    const fake = fakeService({});

    const outcome = await deleteChore(archivedRow, ctxFor(fake.service), undefined);

    expect(outcome.kind).toBe("confirm_required");
    if (outcome.kind === "confirm_required") {
      expect(outcome.message).toMatch(/already archived/);
      expect(outcome.message).not.toMatch(/archive it instead/);
      expect(outcome.message).toMatch(/history/);
    }
  });

  test("looks nothing up, because its caller already did", async () => {
    // The confirmation gate runs this twice per delete. Re-resolving on each pass
    // is what turned one lookup into four.
    const fake = fakeService({});

    await deleteChore(listRow, ctxFor(fake.service), { confirm: true });

    expect(fake.calls).not.toContain("GET chores");
    expect(fake.calls).not.toContain("GET archivedChores");
  });
});

describe("editChore when the read-back fails", () => {
  test("reports the edit as landed rather than as a failure", async () => {
    const fake = fakeService({ chores: [listRow] });
    fake.service.choreDetails = async () => {
      throw new Error("instance went away");
    };

    const result = await editChore({ chore_id: 5, description: "updated" }, ctxFor(fake.service));

    // The PUT already succeeded. Rejecting here would tell the caller to retry a
    // change that has in fact been applied.
    expect(result.kind).toBe("edited_detail_unavailable");
    if (result.kind !== "edited_detail_unavailable") throw new Error("unreachable");
    expect(result.id).toBe(5);
    expect(result.message).toMatch(/succeeded/i);
    expect(result.message).toMatch(/instance went away/);
  });

  test("still issued the PUT before failing to read back", async () => {
    const fake = fakeService({ chores: [listRow] });
    fake.service.choreDetails = async () => {
      throw new Error("nope");
    };

    await editChore({ chore_id: 5, description: "updated" }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/");
  });
});

describe("editChore clearing the due date", () => {
  test("issues the clear against /:id/dueDate, which is the endpoint that honours a null", async () => {
    // The full edit reads a null as "keep", so a clear that went there would be a
    // 200 that changed nothing and still reported success.
    const fake = fakeService({
      chores: [listRow],
      put: () => undefined,
      choreDetails: () => detailsShapedRow,
    });

    await editChore({ chore_id: 5, due_date: null }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/5/dueDate");
  });

  test("does not touch /dueDate when the edit leaves the date alone", async () => {
    const fake = fakeService({
      chores: [listRow],
      put: () => undefined,
      choreDetails: () => detailsShapedRow,
    });

    await editChore({ chore_id: 5, name: "Renamed" }, ctxFor(fake.service));

    expect(fake.calls.some((c) => c.includes("/dueDate"))).toBe(false);
  });
});

describe("clearing a due date that the chore cannot survive without", () => {
  test("is refused before anything is written", async () => {
    // The clear happens on a separate endpoint after the main write, so the merged
    // body still carries the old date and the guard inside mergeEditRequest sees a
    // valid state. Checking the end state here is what stops edit_chore from
    // manufacturing exactly the chore that guard exists to prevent.
    const windowed = { ...listRow, completionWindow: 4 };
    const fake = fakeService({ chores: [windowed], put: () => undefined, choreDetails: () => detailsShapedRow });

    await expect(
      editChore({ chore_id: 5, due_date: null }, ctxFor(fake.service)),
    ).rejects.toThrow(/completion window/i);

    expect(fake.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("an ordinary chore still clears", async () => {
    const fake = fakeService({ chores: [listRow], put: () => undefined, choreDetails: () => detailsShapedRow });

    await editChore({ chore_id: 5, due_date: null }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/5/dueDate");
  });
});

describe("the due-date clear's concurrency token", () => {
  test("comes from a row re-read after the main write, not from the pre-write row", async () => {
    // existing predates the PUT just issued, so its stamp is already behind the row
    // and this endpoint refuses anything older. With a fixture carrying no stamp,
    // every candidate expression collapsed to the clock and three mutations of this
    // block survived, including restoring the bare clock reading.
    const AFTER_WRITE = "2026-08-06T10:00:05.222222222Z";
    let read = 0;
    const fake = fakeService({
      chores: () => [read++ === 0 ? listRow : { ...listRow, updatedAt: AFTER_WRITE }],
      put: () => undefined,
      choreDetails: () => detailsShapedRow,
    });

    await editChore({ chore_id: 5, due_date: null }, ctxFor(fake.service));

    const clear = fake.bodies.find((b) => b.path.endsWith("/dueDate"));
    expect(clear).toBeDefined();
    expect((clear!.body as Record<string, unknown>).updatedAt).toBe(AFTER_WRITE);
    expect((clear!.body as Record<string, unknown>).dueDate).toBeNull();
  });
});

describe("an edit that switches notifications off says so", () => {
  // mergeNotification turns them off when the stored row has them on with no
  // metadata, because writing that shape back reaches a nil deref in a Donetick
  // goroutine and takes the process down. The tradeoff is right; the silence was
  // not. The caveat lived in edit_chore's description, which is not what a caller
  // reads after the write that performed it.
  test("warns when the stored row had them on with no metadata", async () => {
    const fake = fakeService({
      chores: [{ ...listRow, notification: true, notificationMetadata: null }],
      choreDetails: () => ({}) as unknown as RawChore,
    });

    const outcome = await editChore({ chore_id: 5, description: "poke" }, ctxFor(fake.service));

    expect(outcome.kind).toBe("edited");
    expect((outcome as { warning?: string }).warning).toMatch(/switched off/i);
  });

  test("stays quiet on a chore whose notifications were already off", async () => {
    const fake = fakeService({
      chores: [{ ...listRow, notification: false, notificationMetadata: null }],
      choreDetails: () => ({}) as unknown as RawChore,
    });

    const outcome = await editChore({ chore_id: 5, description: "poke" }, ctxFor(fake.service));

    expect((outcome as { warning?: string }).warning).toBeUndefined();
  });
});
