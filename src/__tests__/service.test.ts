import { describe, expect, test } from "bun:test";
import { DonetickService } from "@/service";

function fakeClient(routes: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      get: async (path: string) => {
        calls.push(`GET ${path}`);
        if (!(path in routes)) throw new Error(`unexpected path ${path}`);
        return routes[path];
      },
      post: async (path: string) => {
        calls.push(`POST ${path}`);
        return { res: 1 };
      },
      put: async (path: string) => {
        calls.push(`PUT ${path}`);
        return { res: 1 };
      },
      delete: async (path: string) => {
        calls.push(`DELETE ${path}`);
        return undefined;
      },
    },
  };
}

const routes = {
  "/api/v1/chores/?includeSubtasks=true": [{ id: 1, name: "Trash" }],
  "/api/v1/circles/members": [
    { id: 99, userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 5, pointsRedeemed: 0 },
  ],
  "/api/v1/projects": [{ id: 4, name: "Garden" }],
};

describe("DonetickService", () => {
  test("requests the chore list with includeSubtasks", async () => {
    const fake = fakeClient(routes);
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    await service.chores();

    expect(fake.calls).toContain("GET /api/v1/chores/?includeSubtasks=true");
  });

  test("maps members using userId, not the join-row id", async () => {
    const fake = fakeClient(routes);
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    const members = await service.members();
    expect(members[0]?.userId).toBe(1);
    expect(members[0]?.displayName).toBe("Jared Glaser");
  });

  test("deduplicates members repeated by the notification-target join", async () => {
    const fake = fakeClient({
      ...routes,
      "/api/v1/circles/members": [
        { id: 99, userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 5, pointsRedeemed: 0 },
        { id: 99, userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 5, pointsRedeemed: 0 },
      ],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    expect((await service.members()).length).toBe(1);
  });

  test("caches the chore list across calls", async () => {
    const fake = fakeClient(routes);
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    await service.chores();
    await service.chores();

    expect(fake.calls.filter((c) => c.includes("chores")).length).toBe(1);
  });

  test("invalidates the chore cache after a write, even a failing one", async () => {
    const fake = fakeClient(routes);
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });
    await service.chores();

    await expect(
      service.write(async () => {
        throw new Error("write blew up");
      }),
    ).rejects.toThrow("write blew up");

    await service.chores();
    expect(fake.calls.filter((c) => c.includes("chores")).length).toBe(2);
  });

  test("write returns the inner result on success", async () => {
    const fake = fakeClient(routes);
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    expect(await service.write(async () => "done")).toBe("done");
  });

  test("a member row missing displayName falls back to username, and missing both falls back to a user id label", async () => {
    const fake = fakeClient({
      ...routes,
      "/api/v1/circles/members": [
        { id: 1, userId: 1, username: "jared", role: "admin", points: 0, pointsRedeemed: 0 },
        { id: 2, userId: 2, role: "member", points: 0, pointsRedeemed: 0 },
      ],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    const members = await service.members();
    expect(members.find((m) => m.userId === 1)?.displayName).toBe("jared");
    expect(members.find((m) => m.userId === 2)?.displayName).toBe("user 2");
  });

  test("two different members are both kept", async () => {
    const fake = fakeClient({
      ...routes,
      "/api/v1/circles/members": [
        { id: 1, userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 5, pointsRedeemed: 0 },
        { id: 2, userId: 2, username: "amy", displayName: "Amy Glaser", role: "member", points: 3, pointsRedeemed: 0 },
      ],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    const members = await service.members();
    expect(members.length).toBe(2);
    expect(members.map((m) => m.userId).sort()).toEqual([1, 2]);
  });

  test("members sharing the join-row id but with different userId are both kept", async () => {
    const fake = fakeClient({
      ...routes,
      "/api/v1/circles/members": [
        { id: 99, userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 5, pointsRedeemed: 0 },
        { id: 99, userId: 2, username: "amy", displayName: "Amy Glaser", role: "member", points: 3, pointsRedeemed: 0 },
      ],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    const members = await service.members();
    expect(members.length).toBe(2);
    expect(members.map((m) => m.userId).sort()).toEqual([1, 2]);
  });

  test("projects() tolerates the endpoint returning undefined instead of an array", async () => {
    const fake = fakeClient({ ...routes, "/api/v1/projects": undefined });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    expect(await service.projects()).toEqual([]);
  });

  test("archivedChores() requests the includeArchived variant and is not cached", async () => {
    const fake = fakeClient({
      ...routes,
      "/api/v1/chores/?includeSubtasks=true&includeArchived=true": [{ id: 1, name: "Trash" }],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    await service.archivedChores();
    await service.archivedChores();

    expect(
      fake.calls.filter((c) => c === "GET /api/v1/chores/?includeSubtasks=true&includeArchived=true").length,
    ).toBe(2);
  });

  test("member and project caches outlive the chore cache ttl", async () => {
    // The clock is injected rather than slept on: a real timer would make this
    // test depend on wall-clock scheduling instead of on the TTL being honored.
    const fake = fakeClient(routes);
    const clock = { value: 1_000 };
    const service = new DonetickService(fake.client as never, {
      cacheTtlMs: 10_000,
      now: () => clock.value,
    });

    await service.members();
    await service.chores();

    clock.value = 20_000;

    await service.members();
    await service.chores();

    expect(fake.calls.filter((c) => c.includes("circles/members")).length).toBe(1);
    expect(fake.calls.filter((c) => c.includes("includeSubtasks=true")).length).toBe(2);
  });

  test("write() invalidates the chore cache but not the member or project caches", async () => {
    const fake = fakeClient(routes);
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    await service.members();
    await service.write(async () => "ok");
    await service.members();

    expect(fake.calls.filter((c) => c.includes("circles/members")).length).toBe(1);
  });
});
