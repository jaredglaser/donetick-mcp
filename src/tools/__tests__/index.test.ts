import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ASSIGN_STRATEGIES } from "@/chore-request";
import { FREQUENCY_TYPES } from "@/frequency";
import {
  ASSIGN_STRATEGY_VALUES,
  buildToolDefinitions,
  FREQUENCY_TYPE_VALUES,
  type McpExtras,
  type ToolResult,
} from "../index";

const service = {
  chores: async () => [],
  members: async () => [],
  projects: async () => [],
  choreDetails: async () => ({}),
  archivedChores: async () => [],
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
    status: 0,
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

    // Plan 2 Task 6 registered the eight write tools alongside the five read tools
    // from Plan 1, growing this count from 5 to 13. Plan 3 Task 3 registers the
    // seven action tools on top of that, growing it again to 20.
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

// Plan 2 Task 6 coverage below: the eight write tools, delete_chore's multi-round-trip
// confirmation, and the two drift guards tying the local zod option lists back to their
// domain source of truth.

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

describe("zod option lists agree with their domain source of truth", () => {
  test("the local frequency-type list equals FREQUENCY_TYPES", () => {
    expect(FREQUENCY_TYPES).toEqual(FREQUENCY_TYPE_VALUES);
  });

  test("the local assign-strategy list equals ASSIGN_STRATEGIES", () => {
    expect(ASSIGN_STRATEGIES).toEqual(ASSIGN_STRATEGY_VALUES);
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

describe("a chore id that does not exist", () => {
  test("reads as not found, not as an instance fault", async () => {
    // The details endpoint answers a missing id with a 500, which errors.ts maps to
    // a generic instance error. Reporting that verbatim sends the user looking for
    // an outage instead of a typo.
    const failing = {
      ...service,
      chores: async () => [],
      choreDetails: async () => {
        throw new Error("The Donetick instance returned an error.");
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

// Plan 3 Task 3 coverage below: registration of the seven action tools
// (complete_chore, skip_chore, undo_chore, approve_chore, reject_chore, nudge_chore,
// set_subtask_completed) that bring the surface from 13 tools to 20.

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

