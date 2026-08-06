import { describe, expect, test } from "bun:test";
import { createChore, deleteChore, editChore, type WriteContext } from "../write";
import type { CreateInput } from "@/chore-request";
import type { Member, Project, RawChore } from "@/types";

const now = new Date("2026-08-06T16:00:00Z");
const tz = "America/New_York";

const members: Member[] = [
  { userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 0, pointsRedeemed: 0 },
  { userId: 2, username: "sam", displayName: "Sam", role: "member", points: 0, pointsRedeemed: 0 },
];
const projects: Project[] = [{ id: 4, name: "Household" }];

interface FakeOptions {
  chores?: RawChore[];
  members?: Member[];
  projects?: Project[];
  choreDetails?: (id: number) => RawChore | Promise<RawChore>;
  post?: (path: string, body?: unknown) => unknown | Promise<unknown>;
  put?: (path: string, body?: unknown) => unknown | Promise<unknown>;
  del?: (path: string) => unknown | Promise<unknown>;
}

function fakeService(opts: FakeOptions = {}) {
  const calls: string[] = [];
  let invalidations = 0;

  const service = {
    chores: async () => {
      calls.push("GET chores");
      return opts.chores ?? [];
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
      put: async (path: string, body?: unknown) => {
        calls.push(`PUT ${path}`);
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

  return { service, calls, invalidations: () => invalidations };
}

function ctxFor(service: ReturnType<typeof fakeService>["service"]): WriteContext {
  return { service: service as never, now: () => now, timezone: tz };
}

const listRow: RawChore = {
  id: 5,
  name: "Take out trash",
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
  attachments: [],
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
    const fake = fakeService({
      post: () => ({ res: 42, warnings: ["defaulted to once"] }),
      choreDetails: (id) => ({ ...listRow, id }),
    });

    const outcome = await createChore({ name: "Trash" }, ctxFor(fake.service));

    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") {
      expect(outcome.warnings).toEqual(["defaulted to once"]);
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
});

describe("deleteChore", () => {
  test("with no answer, returns confirm_required, makes no DELETE call, and names the chore and archiving", async () => {
    const fake = fakeService({ chores: [listRow] });

    const outcome = await deleteChore({ chore_id: 5 }, ctxFor(fake.service), undefined);

    expect(outcome.kind).toBe("confirm_required");
    if (outcome.kind === "confirm_required") {
      expect(outcome.chore).toBe("Take out trash");
      expect(outcome.message).toMatch(/Take out trash/);
      expect(outcome.message).toMatch(/archive/i);
    }
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  test("with confirm: false, returns declined and makes no DELETE call", async () => {
    const fake = fakeService({ chores: [listRow] });

    const outcome = await deleteChore({ chore_id: 5 }, ctxFor(fake.service), { confirm: false });

    expect(outcome).toEqual({ kind: "declined", chore: "Take out trash" });
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  test("with confirm: true, issues DELETE /api/v1/chores/<id>", async () => {
    const fake = fakeService({ chores: [listRow] });

    const outcome = await deleteChore({ chore_id: 5 }, ctxFor(fake.service), { confirm: true });

    expect(fake.calls).toContain("DELETE /api/v1/chores/5");
    expect(outcome).toEqual({ kind: "deleted", deleted: 5, name: "Take out trash" });
  });

  test("errors clearly when chore_id is absent", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(deleteChore({}, ctxFor(fake.service), undefined)).rejects.toThrow(/chore_id/);
  });

  test("resolves the chore before asking for confirmation, so a nonexistent id errors rather than prompting", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(deleteChore({ chore_id: 999 }, ctxFor(fake.service), undefined)).rejects.toThrow(
      /999/,
    );
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
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
