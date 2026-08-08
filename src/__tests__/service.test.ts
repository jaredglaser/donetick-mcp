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
        // Empty, not absent. Donetick stores an unset display name as "", which is why
        // the fallback chain is || and not ??. Every fixture here omitted the field,
        // and ?? handles an omitted field identically, so the comment saying || is
        // deliberate had no test that could tell.
        { id: 3, userId: 3, username: "sam", displayName: "", role: "member", points: 0, pointsRedeemed: 0 },
      ],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    const members = await service.members();
    expect(members.find((m) => m.userId === 1)?.displayName).toBe("jared");
    expect(members.find((m) => m.userId === 2)?.displayName).toBe("user 2");
    expect(members.find((m) => m.userId === 3)?.displayName).toBe("sam");
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
      "/api/v1/chores/?includeSubtasks=true&includeArchived=true": [
        { id: 1, name: "Trash", isActive: false },
      ],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    await service.archivedChores();
    await service.archivedChores();

    expect(
      fake.calls.filter((c) => c === "GET /api/v1/chores/?includeSubtasks=true&includeArchived=true").length,
    ).toBe(2);
  });

  test("archivedChores() drops the active chores the includeArchived variant returns alongside them", async () => {
    // Live check on 2026-08-06: includeArchived=true is a union of active and
    // archived, so without a filter every active chore is reported as archived.
    const fake = fakeClient({
      ...routes,
      "/api/v1/chores/?includeSubtasks=true&includeArchived=true": [
        { id: 1, name: "Trash", isActive: false },
        { id: 2, name: "Dishes", isActive: true },
        { id: 3, name: "Field absent" },
      ],
    });
    const service = new DonetickService(fake.client as never, { cacheTtlMs: 10_000 });

    expect((await service.archivedChores()).map((c) => c.id)).toEqual([1]);
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

describe("members the circle endpoint returns but the circle does not have", () => {
  // Measured on v0.1.76 with a third account awaiting approval: a pending join
  // request comes back on /circles/members looking exactly like a member. It was
  // assignable, reported as the assignee, and that account's own list_chores was
  // empty. It also sat in the point standings list_members advertises.
  test("a pending join request is filtered out", async () => {
    const service = new DonetickService(
      fakeClient({
        "/api/v1/circles/members": [
          { userId: 1, username: "jared", displayName: "Jared", isActive: true, points: 10 },
          { userId: 4, username: "pending", displayName: "Pending Person", isActive: false, points: 0 },
        ],
      }).client as never,
      { cacheTtlMs: 0 },
    );

    const members = await service.members();
    expect(members.map((m) => m.userId)).toEqual([1]);
  });

  test("a member with no isActive key is kept, since older rows may omit it", async () => {
    const service = new DonetickService(
      fakeClient({
        "/api/v1/circles/members": [{ userId: 1, username: "jared", displayName: "Jared" }],
      }).client as never,
      { cacheTtlMs: 0 },
    );

    expect((await service.members()).map((m) => m.userId)).toEqual([1]);
  });
});

describe("a response that is not the array every consumer assumes", () => {
  // These reached the model as raw TypeErrors naming an internal property, or in one
  // case quoting a whole arrow function. probe.ts has the right check and wording but
  // only runs after a failure, so a healthy instance that starts answering with
  // something else never reached it.
  test("a non-array chore list is an explained error, not a TypeError", async () => {
    const service = new DonetickService(
      fakeClient({ "/api/v1/chores/?includeSubtasks=true": "nope" }).client as never,
      { cacheTtlMs: 0 },
    );

    await expect(service.chores()).rejects.toThrow(/did not return an array/);
  });

  test("a non-array archived list is explained, not a TypeError quoting a filter", async () => {
    // archivedChores() filters this, so a non-array reached the model as
    // "(await this.allChores()).filter is not a function" with the whole arrow
    // function in the message. It was the fourth loader and the one the guard was
    // written for.
    const service = new DonetickService(
      fakeClient({ "/api/v1/chores/?includeSubtasks=true&includeArchived=true": "nope" }).client as never,
      { cacheTtlMs: 0 },
    );

    await expect(service.allChores()).rejects.toThrow(/did not return an array/);
    await expect(service.archivedChores()).rejects.toThrow(/did not return an array/);
  });

  test("an empty projects body is still a real answer, not an error", async () => {
    const service = new DonetickService(
      fakeClient({ "/api/v1/projects": undefined }).client as never,
      { cacheTtlMs: 0 },
    );

    expect(await service.projects()).toEqual([]);
  });
});


describe("a write that moves points", () => {
  // The chore invalidation is in write()'s finally because a failed write can still
  // have changed state. The member invalidation sat after the await, so a completion
  // that landed and then timed out left the pre-completion total for the whole five
  // minute TTL. Same reasoning, one predicate short.
  //
  // Exercised against the real service, because a fake that mirrors the intended
  // behaviour cannot tell whether the service still has it.
  function serviceWith(members: unknown) {
    const fake = fakeClient({ "/api/v1/circles/members": members });
    return new DonetickService(fake.client as never, { cacheTtlMs: 300_000 });
  }

  test("invalidates the member cache even when the write throws", async () => {
    const service = serviceWith([
      { userId: 1, username: "jared", displayName: "Jared", isActive: true, points: 50 },
    ]);
    await service.members();

    await expect(
      service.write(async () => {
        throw new Error("The request timed out after 15000ms.");
      }, { movesPoints: true }),
    ).rejects.toThrow(/timed out/);

    // A second read must go back to the client rather than answering from the cache.
    const before = service.members();
    expect(before).toBeInstanceOf(Promise);
    await before;
  });

  test("a write that does not move points leaves the member cache alone", async () => {
    let memberReads = 0;
    const client = {
      get: async (path: string) => {
        if (path.includes("members")) memberReads += 1;
        return [{ userId: 1, username: "j", displayName: "J", isActive: true, points: 0 }];
      },
    };
    const service = new DonetickService(client as never, { cacheTtlMs: 300_000 });

    await service.members();
    await service.write(async () => undefined);
    await service.members();

    expect(memberReads).toBe(1);
  });

  test("a write that moves points forces the next member read to refetch", async () => {
    let memberReads = 0;
    const client = {
      get: async (path: string) => {
        if (path.includes("members")) memberReads += 1;
        return [{ userId: 1, username: "j", displayName: "J", isActive: true, points: 0 }];
      },
    };
    const service = new DonetickService(client as never, { cacheTtlMs: 300_000 });

    await service.members();
    await service.write(async () => undefined, { movesPoints: true });
    await service.members();

    expect(memberReads).toBe(2);
  });
});
