import { describe, expect, test } from "bun:test";
import { DonetickError } from "@/errors";
import { z } from "zod";
import { buildToolDefinitions, type McpExtras, type ToolResult } from "../index";

const service = {
  chores: async () => [],
  members: async () => [],
  projects: async () => [],
  choreDetails: async () => ({}),
  archivedChores: async () => [],
  allChores: async () => [],
  rawGet: async () => [],
  write: async (op: () => Promise<unknown>) => op(),
  invalidateChores: () => {},
};

const deps = {
  service: service as never,
  timezone: "America/New_York",
  now: () => new Date("2026-06-15T12:00:00Z"),
};

describe("buildToolDefinitions", () => {
  test("registers the plan 1 read tools", () => {
    const names = buildToolDefinitions(deps).map((tool) => tool.name);
    expect(names).toContain("list_chores");
    expect(names).toContain("get_chore");
    expect(names).toContain("list_activity");
    expect(names).toContain("list_members");
    expect(names).toContain("list_projects");
  });

  test("every tool has a non-empty description", () => {
    for (const tool of buildToolDefinitions(deps)) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  test("list_chores documents the inverted priority scale", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "list_chores");
    expect(tool?.description).toMatch(/P1/);
  });

  test("a tool that throws returns an error result rather than rejecting", async () => {
    const failing = {
      ...service,
      chores: async () => {
        throw new Error("instance down");
      },
    };
    const tools = buildToolDefinitions({ ...deps, service: failing as never });
    const listChoresTool = tools.find((t) => t.name === "list_chores")!;

    const result = await listChoresTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/instance down/);
  });
});

// Additional coverage below. The 4 tests above are a fixed contract.

const member1 = {
  userId: 1,
  username: "jared",
  displayName: "Jared",
  role: "member",
  points: 10,
  pointsRedeemed: 0,
};

const member2 = {
  userId: 2,
  username: "alex",
  displayName: "Alex",
  role: "member",
  points: 5,
  pointsRedeemed: 0,
};

function jsonOf(result: { content: Array<{ type: "text"; text: string }>; isError?: boolean }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("get_chore merging", () => {
  test("merges the list row with /details rather than replacing it", async () => {
    const listRow = {
      id: 5,
      name: "Deep clean kitchen",
      nextDueDate: "2026-06-20T00:00:00Z",
      assignedTo: 1,
      priority: 2,
      status: 0,
      frequencyType: "interval",
      frequency: 3,
      requireApproval: true,
      labelsV2: [{ id: 1, name: "kitchen" }],
      createdBy: 1,
    };
    const fakeService = {
      ...service,
      chores: async () => [listRow],
      choreDetails: async () => ({
        lastCompletedDate: "2026-06-10T00:00:00Z",
        lastCompletedBy: 1,
      }),
      members: async () => [member1],
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const getChoreTool = tools.find((t) => t.name === "get_chore")!;

    const result = await getChoreTool.handler({ chore_id: 5 });
    expect(result.isError).toBeUndefined();
    const parsed = jsonOf(result) as Record<string, unknown>;

    // Detail-only field.
    expect(parsed.last_completed_at).toBe("2026-06-10T00:00:00Z");
    expect(parsed.last_completed_by).toBe("Jared");
    // List-only fields must survive the merge.
    expect(parsed.frequency).toBe("every 3 days");
    expect(parsed.requires_approval).toBe(true);
    expect(parsed.labels).toEqual(["kitchen"]);
  });

  test("accepts a name and resolves it", async () => {
    const listRow = {
      id: 7,
      name: "Water plants",
      nextDueDate: null,
      assignedTo: null,
      priority: 0,
      status: 0,
      frequencyType: "once",
      createdBy: 1,
    };
    const fakeService = {
      ...service,
      chores: async () => [listRow],
      members: async () => [member1],
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const getChoreTool = tools.find((t) => t.name === "get_chore")!;

    const result = await getChoreTool.handler({ name: "Water plants" });
    expect(result.isError).toBeUndefined();
    const parsed = jsonOf(result) as Record<string, unknown>;
    expect(parsed.id).toBe(7);
    expect(parsed.name).toBe("Water plants");
  });

  test("an ambiguous name returns an error result naming both candidates", async () => {
    const dupA = {
      id: 1,
      name: "Trash",
      nextDueDate: null,
      assignedTo: 1,
      priority: 0,
      status: 0,
      frequencyType: "once",
      createdBy: 1,
    };
    const dupB = {
      id: 2,
      name: "Trash",
      nextDueDate: null,
      assignedTo: 2,
      priority: 0,
      status: 0,
      frequencyType: "once",
      createdBy: 1,
    };
    const fakeService = {
      ...service,
      chores: async () => [dupA, dupB],
      members: async () => [member1, member2],
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const getChoreTool = tools.find((t) => t.name === "get_chore")!;

    const result = await getChoreTool.handler({ name: "Trash" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/id 1/);
    expect(result.content[0]?.text).toMatch(/id 2/);
  });

  test("neither chore_id nor name returns a clear error result rather than rejecting", async () => {
    const tools = buildToolDefinitions(deps);
    const getChoreTool = tools.find((t) => t.name === "get_chore")!;

    const result = await getChoreTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/chore_id|name/);
  });
});

describe("list_activity", () => {
  const historyRow = (overrides: Record<string, unknown>) => ({
    id: 100,
    choreId: 9,
    assignedTo: 1,
    completedBy: 1,
    dueDate: "2026-06-14T00:00:00Z",
    performedAt: "2026-06-14T09:00:00Z",
    notes: null,
    // 1 is a completion. Measured on v0.1.76: complete wrote 1, skip 2, a completion
    // awaiting sign-off 3, and a plain edit 6. The old fixture used 0, which is not
    // a value Donetick writes, so every list_activity test ran on a shape the wire
    // never produces.
    status: 1,
    createdAt: "2026-06-14T09:00:00Z",
    updatedAt: "2026-06-14T09:00:00Z",
    syncVersion: 1,
    ...overrides,
  });

  test("names the chore when the id is present in the chore list", async () => {
    const chore = {
      id: 9,
      name: "Water plants",
      nextDueDate: null,
      assignedTo: 1,
      priority: 0,
      status: 0,
      frequencyType: "once",
      createdBy: 1,
    };
    const fakeService = {
      ...service,
      chores: async () => [chore],
      members: async () => [member1],
      rawGet: async () => [historyRow({})],
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_activity")!;

    const result = await tool.handler({});
    expect(result.isError).toBeUndefined();
    const parsed = jsonOf(result) as Array<Record<string, unknown>>;
    expect(parsed[0]?.chore).toBe("Water plants");
  });

  test("marks a deleted chore rather than dropping the row or printing a bare id", async () => {
    const fakeService = {
      ...service,
      chores: async () => [],
      members: async () => [member1],
      rawGet: async () => [historyRow({ choreId: 42 })],
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_activity")!;

    const result = await tool.handler({});
    const parsed = jsonOf(result) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.chore).toBe("chore #42 (deleted)");
  });

  test("resolves completedBy to a display name, and tolerates an unknown member id", async () => {
    const chore = {
      id: 9,
      name: "Water plants",
      nextDueDate: null,
      assignedTo: 1,
      priority: 0,
      status: 0,
      frequencyType: "once",
      createdBy: 1,
    };
    const fakeService = {
      ...service,
      chores: async () => [chore],
      members: async () => [member1],
      rawGet: async () => [
        historyRow({ id: 100, completedBy: 1 }),
        historyRow({ id: 101, completedBy: 999 }),
      ],
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_activity")!;

    const result = await tool.handler({});
    expect(result.isError).toBeUndefined();
    const parsed = jsonOf(result) as Array<Record<string, unknown>>;
    expect(parsed[0]?.completed_by).toBe("Jared");
    expect(parsed[1]?.completed_by).toMatch(/999/);
  });

  test("clamps days over 90 rather than sending an unbounded window to Donetick", async () => {
    let requestedPath = "";
    const fakeService = {
      ...service,
      rawGet: async (path: string) => {
        requestedPath = path;
        return [];
      },
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_activity")!;

    const result = await tool.handler({ days: 500 });
    expect(result.isError).toBeUndefined();
    expect(requestedPath).toMatch(/limit=90/);
  });
});

describe("list_members and list_projects", () => {
  test("list_members returns the member list", async () => {
    const fakeService = { ...service, members: async () => [member1, member2] };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_members")!;

    const result = await tool.handler({});
    const parsed = jsonOf(result) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
  });

  test("list_projects returns the project list", async () => {
    const fakeService = { ...service, projects: async () => [{ id: 1, name: "Home" }] };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_projects")!;

    const result = await tool.handler({});
    const parsed = jsonOf(result) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([{ id: 1, name: "Home" }]);
  });
});

describe("list_chores archived scope", () => {
  const archivedRow = {
    id: 9,
    name: "Deep clean fridge",
    nextDueDate: null,
    assignedTo: null,
    priority: 0,
    status: 0,
    frequencyType: "once",
    createdBy: 1,
  };

  test("scope=archived returns archived chores and does not consult the cached active list", async () => {
    let choresCalled = false;
    const fakeService = {
      ...service,
      chores: async () => {
        choresCalled = true;
        return [];
      },
      archivedChores: async () => [archivedRow],
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_chores")!;

    const result = await tool.handler({ scope: "archived" });
    const parsed = jsonOf(result) as { chores: Array<{ id: number; name: string }> };

    expect(parsed.chores.map((c) => c.id)).toEqual([9]);
    expect(choresCalled).toBe(false);
  });

  test("scope other than archived still uses the cached active list", async () => {
    let archivedCalled = false;
    const fakeService = {
      ...service,
      chores: async () => [archivedRow],
      archivedChores: async () => {
        archivedCalled = true;
        return [];
      },
    };
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "list_chores")!;

    await tool.handler({ scope: "all" });

    expect(archivedCalled).toBe(false);
  });
});

describe("failure isolation", () => {
  test("every tool's handler survives the service throwing, not just list_chores", async () => {
    const failing = {
      chores: async () => {
        throw new Error("boom");
      },
      members: async () => {
        throw new Error("boom");
      },
      projects: async () => {
        throw new Error("boom");
      },
      choreDetails: async () => {
        throw new Error("boom");
      },
      archivedChores: async () => {
        throw new Error("boom");
      },
      rawGet: async () => {
        throw new Error("boom");
      },
      write: async (op: () => Promise<unknown>) => op(),
      invalidateChores: () => {},
    };
    const tools = buildToolDefinitions({ ...deps, service: failing as never });
    const argsByName: Record<string, Record<string, unknown>> = {
      list_chores: {},
      get_chore: { chore_id: 1 },
      list_activity: {},
      list_members: {},
      list_projects: {},
      create_chore: { name: "Test chore" },
      edit_chore: { chore_id: 1 },
      delete_chore: { chore_id: 1 },
      reschedule_chore: { chore_id: 1, due_date: null },
      reassign_chore: { chore_id: 1, assignee: "Jared" },
      set_priority: { chore_id: 1, priority: "P1" },
      archive_chore: { chore_id: 1 },
      unarchive_chore: { chore_id: 1 },
      complete_chore: { chore_id: 1 },
      skip_chore: { chore_id: 1 },
      undo_chore: { chore_id: 1 },
      approve_chore: { chore_id: 1 },
      reject_chore: { chore_id: 1 },
      nudge_chore: { chore_id: 1 },
      set_subtask_completed: { chore_id: 1, subtask: "wipe counters", completed: true },
    };

    expect(tools).toHaveLength(20);
    for (const tool of tools) {
      const result = await tool.handler(argsByName[tool.name] ?? {});
      expect(result.isError).toBe(true);
    }
  });

  test("tool names are unique and there are exactly 20", () => {
    const names = buildToolDefinitions(deps).map((tool) => tool.name);
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
  });
});


const writeMember1 = {
  userId: 1,
  username: "jared",
  displayName: "Jared",
  role: "admin",
  points: 0,
  pointsRedeemed: 0,
};

interface FakeWriteOptions {
  chores?: Array<Record<string, unknown>>;
  members?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
  choreDetails?: (id: number) => unknown;
  post?: (path: string, body?: unknown) => unknown;
  put?: (path: string, body?: unknown) => unknown;
  del?: (path: string) => unknown;
}

/** Same shape as the read-only `service` mock above, plus the `.client` write.ts and schedule.ts reach into. */
function fakeWriteService(opts: FakeWriteOptions = {}) {
  let deleteCalls = 0;
  const writeService = {
    chores: async () => opts.chores ?? [],
    archivedChores: async () => [],
    members: async () => opts.members ?? [writeMember1],
    projects: async () => opts.projects ?? [],
    choreDetails: async (id: number) => {
      if (!opts.choreDetails) throw new Error("no choreDetails handler configured for this test");
      return opts.choreDetails(id);
    },
    rawGet: async () => [],
    write: async <T>(op: () => Promise<T>): Promise<T> => op(),
    invalidateChores: () => {},
    client: {
      post: async (path: string, body?: unknown) => (opts.post ? opts.post(path, body) : undefined),
      postEnvelope: async (path: string, body?: unknown) =>
        opts.post ? opts.post(path, body) : undefined,
      put: async (path: string, body?: unknown) => (opts.put ? opts.put(path, body) : undefined),
      delete: async (path: string) => {
        deleteCalls += 1;
        return opts.del ? opts.del(path) : undefined;
      },
    },
  };
  return { service: writeService, deleteCalls: () => deleteCalls };
}

describe("write tool registration", () => {
  test("registers all eight write tools alongside the five read tools", () => {
    const names = buildToolDefinitions(deps).map((tool) => tool.name);
    for (const name of [
      "create_chore",
      "edit_chore",
      "delete_chore",
      "reschedule_chore",
      "reassign_chore",
      "set_priority",
      "archive_chore",
      "unarchive_chore",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("create_chore's description documents the interval frequency type", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "create_chore")!;
    expect(tool.description).toMatch(/interval/);
  });

  test("delete_chore's description points to archive_chore as the non-destructive alternative", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "delete_chore")!;
    expect(tool.description).toMatch(/archive_chore/);
  });

  test("set_priority's description states the inverted scale", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "set_priority")!;
    expect(tool.description).toMatch(/P1/);
  });
});

describe("delete_chore multi-round-trip confirmation", () => {
  const choreRow = {
    id: 3,
    name: "Take out trash",
    nextDueDate: null,
    assignedTo: null,
    priority: 0,
    status: 0,
    frequencyType: "once",
    createdBy: 1,
  };

  test("with no confirmation returns a confirmRequired sentinel and performs no delete", async () => {
    const { service: fakeService, deleteCalls } = fakeWriteService({ chores: [choreRow] });
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "delete_chore")!;

    const result: ToolResult = await tool.handler({ chore_id: 3 });
    expect(result.confirmRequired).toBeDefined();
    expect(result.confirmRequired?.key).toBe("confirm");
    expect(result.isError).toBeUndefined();
    expect(deleteCalls()).toBe(0);
  });

  test("with {confirm: true} in McpExtras performs the delete", async () => {
    const { service: fakeService, deleteCalls } = fakeWriteService({ chores: [choreRow] });
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "delete_chore")!;

    const mcp: McpExtras = { confirmation: { confirm: true } };
    const result: ToolResult = await tool.handler({ chore_id: 3 }, mcp);
    expect(result.confirmRequired).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(deleteCalls()).toBe(1);
  });

  test("with {confirm: false} in McpExtras does not delete", async () => {
    const { service: fakeService, deleteCalls } = fakeWriteService({ chores: [choreRow] });
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "delete_chore")!;

    const mcp: McpExtras = { confirmation: { confirm: false } };
    const result: ToolResult = await tool.handler({ chore_id: 3 }, mcp);
    expect(result.confirmRequired).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(deleteCalls()).toBe(0);
  });
});

describe("create_chore detail-unavailable reporting", () => {
  test("a created_detail_unavailable outcome is a success carrying the message, not isError", async () => {
    const { service: fakeService } = fakeWriteService({
      members: [writeMember1],
      projects: [],
      post: () => 42,
      choreDetails: () => {
        throw new Error("details endpoint down");
      },
    });
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "create_chore")!;

    const result = await tool.handler({ name: "New chore" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text) as { kind: string; message: string };
    expect(parsed.kind).toBe("created_detail_unavailable");
    expect(parsed.message).toMatch(/details endpoint down/);
  });
});

describe("an id that is real but not in the cached list", () => {
  // The dangerous case is an active chore the cache has not seen: created or edited
  // in the web UI within the TTL. Searching only the archived subset left it falling
  // through to /details, which omits every list-only field, so get_chore reported
  // "every 1 days" for a three-weekly chore and false for every flag, with no error.
  const listRow = {
    id: 42,
    name: "Gutters",
    nextDueDate: null,
    assignedTo: null,
    status: 0,
    createdBy: 1,
    isActive: true,
    frequencyType: "interval",
    frequency: 3,
    frequencyMetadata: { unit: "weeks" },
    assignStrategy: "no_assignee",
    assignees: [],
    labelsV2: [],
    priority: 2,
    points: 7,
    isRolling: true,
    isPrivate: false,
    requireApproval: true,
    notification: false,
    subTasks: [],
  };

  function toolsFor(overrides: Record<string, unknown>) {
    return buildToolDefinitions({
      ...deps,
      service: { ...service, ...overrides } as never,
    });
  }

  test("is resolved from the full list rather than from /details", async () => {
    let detailsCalled = false;
    const tools = toolsFor({
      chores: async () => [],
      allChores: async () => [listRow],
      choreDetails: async () => {
        detailsCalled = true;
        return { id: 42, name: "Gutters", frequencyType: "interval" };
      },
    });

    const parsed = jsonOf(await tools.find((t) => t.name === "get_chore")!.handler({ chore_id: 42 })) as {
      frequency: string;
      requires_approval: boolean;
      points: number | null;
    };

    expect(parsed.frequency).toBe("every 3 weeks");
    expect(parsed.requires_approval).toBe(true);
    expect(parsed.points).toBe(7);
    // /details is still fetched for the fields only it carries; what must not happen
    // is it being used as the merge base.
    expect(detailsCalled).toBe(true);
  });

  test("an archived chore resolves the same way", async () => {
    const tools = toolsFor({
      chores: async () => [],
      allChores: async () => [{ ...listRow, isActive: false }],
      choreDetails: async () => ({ id: 42, name: "Gutters" }),
    });

    const parsed = jsonOf(await tools.find((t) => t.name === "get_chore")!.handler({ chore_id: 42 })) as {
      frequency: string;
    };

    expect(parsed.frequency).toBe("every 3 weeks");
  });
});

describe("a chore id that does not exist", () => {
  test("a read failure that is not a missing id keeps its own reason", async () => {
    // The 500 branch above exists because /details answers a missing id with one.
    // Covering every other failure with the same sentence told the user their chore
    // was gone when the token had been revoked or the request had timed out.
    const failing = {
      ...service,
      chores: async () => [],
      choreDetails: async () => {
        throw new DonetickError("The request to https://donetick.test timed out after 15000ms.", {
          status: 0,
        });
      },
    };
    const tools = buildToolDefinitions({ ...deps, service: failing as never });
    const tool = tools.find((t) => t.name === "get_chore")!;

    const result = await tool.handler({ chore_id: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/timed out/);
    expect(result.content[0]!.text).not.toMatch(/does not exist|No chore with id/);
  });

  test("reads as not found, not as an instance fault", async () => {
    // The details endpoint answers a missing id with a 500, which errors.ts maps to
    // a generic instance error. Reporting that verbatim sends the user looking for
    // an outage instead of a typo.
    const failing = {
      ...service,
      chores: async () => [],
      choreDetails: async () => {
        throw new DonetickError("The Donetick instance returned an error.", { status: 500 });
      },
    };
    const tools = buildToolDefinitions({ ...deps, service: failing as never });

    for (const name of ["get_chore", "delete_chore"]) {
      const tool = tools.find((t) => t.name === name)!;
      const result = await tool.handler({ chore_id: 999999 });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/No chore with id 999999/);
      expect(result.content[0]?.text).not.toMatch(/instance returned an error/);
    }
  });
});


const actionChoreRow = {
  id: 7,
  name: "Take out trash",
  nextDueDate: "2026-06-20T00:00:00Z",
  assignedTo: 1,
  assignees: [{ userId: 1 }],
  priority: 2,
  status: 0,
  frequencyType: "interval",
  frequency: 3,
  requireApproval: false,
  createdBy: 1,
  subTasks: [{ id: 101, choreId: 7, name: "wipe counters", completedAt: null, orderId: 0 }],
};

describe("action tool registration", () => {
  test("registers all seven action tools, bringing the total to 20", () => {
    const names = buildToolDefinitions(deps).map((tool) => tool.name);
    for (const name of [
      "complete_chore",
      "skip_chore",
      "undo_chore",
      "approve_chore",
      "reject_chore",
      "nudge_chore",
      "set_subtask_completed",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
  });

  test("undo_chore's input schema has no name key, and chore_id is required rather than optional", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "undo_chore")!;
    expect(Object.keys(tool.inputSchema)).not.toContain("name");

    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ chore_id: 7 }).success).toBe(true);
  });

  test("complete_chore's description mentions approval", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "complete_chore")!;
    expect(tool.description).toMatch(/approval/i);
  });

  test("nudge_chore's description mentions needing another member", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "nudge_chore")!;
    expect(tool.description).toMatch(/another member/i);
  });

  test("undo_chore's description mentions the five-minute window", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "undo_chore")!;
    expect(tool.description).toMatch(/five minutes/i);
  });

  test("skip_chore's description mentions advancing to the next occurrence", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "skip_chore")!;
    expect(tool.description).toMatch(/next/i);
    expect(tool.description).toMatch(/without recording/i);
  });

  test("approve_chore and reject_chore both mention the admin or manager role requirement", () => {
    const tools = buildToolDefinitions(deps);
    expect(tools.find((t) => t.name === "approve_chore")!.description).toMatch(/admin or manager/i);
    expect(tools.find((t) => t.name === "reject_chore")!.description).toMatch(/admin or manager/i);
  });

  test("set_subtask_completed's description points at get_chore to see the checklist", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "set_subtask_completed")!;
    expect(tool.description).toMatch(/get_chore/);
  });

  test("nudge_chore's message and all_assignees are optional, and chore_id is required", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "nudge_chore")!;
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({ chore_id: 7 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  test("set_subtask_completed requires subtask and completed, not just chore_id", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "set_subtask_completed")!;
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({ chore_id: 7 }).success).toBe(false);
    expect(schema.safeParse({ chore_id: 7, subtask: "wipe counters", completed: true }).success).toBe(true);
  });

  test("complete_chore requires chore_id but completed_at, note, and completed_by are optional", () => {
    const tool = buildToolDefinitions(deps).find((t) => t.name === "complete_chore")!;
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ chore_id: 7 }).success).toBe(true);
  });
});

describe("complete_chore pending-approval regression at the registration layer", () => {
  test("a response at status 3 surfaces pending_approval rather than reporting success", async () => {
    const { service: fakeService } = fakeWriteService({
      chores: [{ ...actionChoreRow, requireApproval: true }],
      post: () => ({ ...actionChoreRow, requireApproval: true, status: 3 }),
    });
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "complete_chore")!;

    const result = await tool.handler({ chore_id: 7 });
    expect(result.isError).toBeUndefined();
    const parsed = jsonOf(result) as { completed: boolean; pending_approval: boolean; message: string };
    expect(parsed.completed).toBe(false);
    expect(parsed.pending_approval).toBe(true);
    expect(parsed.message).toMatch(/approval/i);
  });
});

describe("set_subtask_completed registration", () => {
  test("passes completed: false through to the module", async () => {
    const { service: fakeService } = fakeWriteService({
      chores: [{ ...actionChoreRow, subTasks: [{ id: 101, choreId: 7, name: "wipe counters", completedAt: "2026-06-01T00:00:00Z", orderId: 0 }] }],
      put: (_path, body) => body,
    });
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "set_subtask_completed")!;

    const result = await tool.handler({ chore_id: 7, subtask: "wipe counters", completed: false });
    expect(result.isError).toBeUndefined();
    const parsed = jsonOf(result) as { completed: boolean };
    expect(parsed.completed).toBe(false);
  });

  test("passes completed: true through to the module", async () => {
    const { service: fakeService } = fakeWriteService({
      chores: [actionChoreRow],
      put: (_path, body) => body,
    });
    const tools = buildToolDefinitions({ ...deps, service: fakeService as never });
    const tool = tools.find((t) => t.name === "set_subtask_completed")!;

    const result = await tool.handler({ chore_id: 7, subtask: "wipe counters", completed: true });
    expect(result.isError).toBeUndefined();
    const parsed = jsonOf(result) as { completed: boolean };
    expect(parsed.completed).toBe(true);
  });
});


describe("delete_chore resolution", () => {
  const active = {
    id: 5,
    name: "Take out trash",
    nextDueDate: null,
    assignedTo: null,
    status: 0,
    createdBy: 1,
    isActive: true,
    frequencyType: "daily",
    frequency: 1,
    frequencyMetadata: { timezone: "America/New_York" },
    assignStrategy: "no_assignee",
    assignees: [],
    labelsV2: [],
    priority: 0,
    isRolling: false,
    isPrivate: false,
    requireApproval: false,
    notification: false,
    subTasks: [],
  };
  const archived = { ...active, id: 9, name: "Old chore", isActive: false };

  function toolsFor(overrides: Record<string, unknown>) {
    return buildToolDefinitions({
      ...deps,
      service: { ...service, ...overrides } as never,
    });
  }

  test("finds an archived chore by name, which the description promises", async () => {
    // The capability used to stop at the id path: deleteChore searched both lists
    // but the handler resolved names against the active one, so delete_chore by
    // name on an archived chore failed with "nothing matches" and suggestions that
    // could not include it, while the description said archived chores were fine.
    const tools = toolsFor({
      chores: async () => [active],
      archivedChores: async () => [archived],
    });
    const tool = tools.find((t) => t.name === "delete_chore")!;

    const result = await tool.handler({ name: "Old chore" });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toMatch(/Old chore/);
  });

  test("finds an archived chore by id", async () => {
    const tools = toolsFor({
      chores: async () => [active],
      archivedChores: async () => [archived],
    });
    const tool = tools.find((t) => t.name === "delete_chore")!;

    const result = await tool.handler({ chore_id: 9 });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toMatch(/Old chore/);
  });

  test("other chore-scoped tools still do not resolve archived names", async () => {
    // Widening resolution everywhere would let an archived chore compete with an
    // active one for the same name, which is the wrong tradeoff outside delete.
    let archivedConsulted = false;
    const tools = toolsFor({
      chores: async () => [active],
      archivedChores: async () => {
        archivedConsulted = true;
        return [archived];
      },
    });
    const tool = tools.find((t) => t.name === "archive_chore")!;

    const result = await tool.handler({ name: "Old chore" });

    expect(result.isError).toBe(true);
    expect(archivedConsulted).toBe(false);
  });
});

describe("error reporting", () => {
  function toolsWith(fail: () => never) {
    return buildToolDefinitions({
      ...deps,
      service: { ...service, chores: fail } as never,
    });
  }

  test("drops the cached list when the error says the cache disagrees with the server", async () => {
    // Deleting the invalidatesCache branch used to leave the whole suite green,
    // because every fake here threw a plain Error and the instanceof check was
    // false in all of them.
    let invalidated = 0;
    const tools = buildToolDefinitions({
      ...deps,
      service: {
        ...service,
        invalidateChores: () => {
          invalidated += 1;
        },
        chores: () => {
          throw new DonetickError("gone", { status: 404, invalidatesCache: true });
        },
      } as never,
    });

    await tools.find((t) => t.name === "list_chores")!.handler({});

    expect(invalidated).toBe(1);
  });

  test("keeps the cache when the error does not implicate it", async () => {
    let invalidated = 0;
    const tools = buildToolDefinitions({
      ...deps,
      service: {
        ...service,
        invalidateChores: () => {
          invalidated += 1;
        },
        chores: () => {
          throw new DonetickError("bad request", { status: 400 });
        },
      } as never,
    });

    await tools.find((t) => t.name === "list_chores")!.handler({});

    expect(invalidated).toBe(0);
  });

  test("an indeterminate write warns against a blind retry", async () => {
    const tools = toolsWith(() => {
      throw new DonetickError("The request timed out after 15000ms.", {
        status: 0,
        indeterminate: true,
      });
    });

    const result = await tools.find((t) => t.name === "complete_chore")!.handler({ chore_id: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/may or may not have been applied/);
  });

  test("a determinate failure carries no such caveat, so a retry stays the obvious move", async () => {
    const tools = toolsWith(() => {
      throw new DonetickError("Donetick rejected the request: bad frequency", { status: 400 });
    });

    const result = await tools.find((t) => t.name === "complete_chore")!.handler({ chore_id: 1 });

    expect(result.content[0]!.text).not.toMatch(/may or may not/);
  });
});

describe("list_activity does not report edits as completions", () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 1,
    choreId: 9,
    assignedTo: 1,
    completedBy: 1,
    dueDate: "2026-06-14T00:00:00Z",
    performedAt: "2026-06-14T09:00:00Z",
    notes: null,
    status: 1,
    createdAt: "2026-06-14T09:00:00Z",
    updatedAt: "2026-06-14T09:00:00Z",
    ...overrides,
  });

  function toolsFor(rows: Array<Record<string, unknown>>) {
    return buildToolDefinitions({
      ...deps,
      service: {
        ...service,
        chores: async () => [{ id: 9, name: "Water plants", isActive: true }],
        members: async () => [{ userId: 1, username: "j", displayName: "Jared", role: "admin", points: 0, pointsRedeemed: 0 }],
        rawGet: async () => rows,
      } as never,
    });
  }

  test("a reschedule row is left out by default", async () => {
    // Donetick writes one on every edit that carries a due date, comparing the old
    // and new by pointer so it fires even when the date is unchanged. This server
    // always sends the date, so a plain rename produced a row that read as
    // "Jared completed Water plants".
    const tools = toolsFor([row({ status: 6 }), row({ id: 2, status: 1 })]);

    const parsed = jsonOf(await tools.find((t) => t.name === "list_activity")!.handler({})) as Array<{
      action: string;
    }>;

    expect(parsed.map((r) => r.action)).toEqual(["completed"]);
  });

  test("include_all_actions brings them back, each named", async () => {
    const tools = toolsFor([row({ status: 6 }), row({ id: 2, status: 2 }), row({ id: 3, status: 1 })]);

    const parsed = jsonOf(
      await tools.find((t) => t.name === "list_activity")!.handler({ include_all_actions: true }),
    ) as Array<{ action: string }>;

    expect(parsed.map((r) => r.action)).toEqual(["rescheduled", "skipped", "completed"]);
  });

  test("an unmapped status is reported rather than guessed at", async () => {
    const tools = toolsFor([row({ status: 99 })]);

    const parsed = jsonOf(
      await tools.find((t) => t.name === "list_activity")!.handler({ include_all_actions: true }),
    ) as Array<{ action: string }>;

    expect(parsed[0]!.action).toBe("status 99");
  });
});
