import { describe, expect, test } from "bun:test";
import { buildToolDefinitions } from "../index";

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
    };

    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      const result = await tool.handler(argsByName[tool.name] ?? {});
      expect(result.isError).toBe(true);
    }
  });

  test("tool names are unique and there are exactly 5", () => {
    const names = buildToolDefinitions(deps).map((tool) => tool.name);
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });
});
