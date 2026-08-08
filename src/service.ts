import { TtlCache } from "@/cache";
import type { DonetickClient } from "@/client";
import { endpoints } from "@/endpoints";
import { isArchivedChore, type ChoreDetails, type ChoreListRow, type Member, type Project } from "@/types";

interface RawMember {
  id: number;
  userId: number;
  username?: string;
  displayName?: string;
  role?: string;
  /** False for a pending join request, which this endpoint returns alongside real members. */
  isActive?: boolean;
  points?: number;
  pointsRedeemed?: number;
}

const MEMBER_TTL_MS = 300_000;

/**
 * Every consumer below treats these as arrays and would otherwise surface a raw
 * TypeError to the model, naming an internal property or quoting a whole arrow
 * function. probe.ts already has this check and this wording, but it only runs after
 * a failure, so a healthy instance that starts answering with something else never
 * reaches it. Donetick returns [] for an empty circle, so a non-array means a proxy
 * or a version change rather than an empty result.
 */
function expectArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Donetick answered the ${what} request but did not return an array. The instance may be behind a proxy that is rewriting responses.`,
    );
  }
  return value as T[];
}

export class DonetickService {
  private readonly choreCache: TtlCache<ChoreListRow[]>;
  private readonly memberCache: TtlCache<Member[]>;
  private readonly projectCache: TtlCache<Project[]>;

  constructor(
    readonly client: DonetickClient,
    options: { cacheTtlMs: number; now?: () => number },
  ) {
    const now = options.now;
    this.choreCache = new TtlCache(
      async () => expectArray<ChoreListRow>(await this.client.get(endpoints.listChores()), "chore list"),
      options.cacheTtlMs,
      now,
    );
    this.memberCache = new TtlCache(async () => {
      const raw = expectArray<RawMember>(await this.client.get(endpoints.circleMembers()), "circle members");
      const seen = new Map<number, Member>();
      for (const row of raw) {
        // A pending join request comes back on this endpoint looking like a member.
        // Measured on v0.1.76 with a third account awaiting approval: it was
        // assignable, reported as the assignee, and its own account could not see
        // the chore at all. It also sat in the point standings list_members
        // advertises, at zero, dragging the ranking.
        if (row.isActive === false) continue;
        if (seen.has(row.userId)) continue;
        seen.set(row.userId, {
          userId: row.userId,
          username: row.username ?? "",
          // || rather than ??, deliberately. Donetick stores an unset display name as
          // "" and not as null, so ?? would keep the empty string and every tool that
          // names this person would name nobody. The fallback chain has to treat ""
          // as absent.
          displayName: row.displayName || row.username || `user ${row.userId}`,
          role: row.role ?? "member",
          points: row.points ?? 0,
          pointsRedeemed: row.pointsRedeemed ?? 0,
        });
      }
      return [...seen.values()];
    }, MEMBER_TTL_MS, now);
    this.projectCache = new TtlCache(
      async () => {
        // An empty body is a real Donetick answer for an account with no projects.
        const raw = await this.client.get(endpoints.projects());
        return raw === undefined || raw === null ? [] : expectArray<Project>(raw, "projects");
      },
      MEMBER_TTL_MS,
      now,
    );
  }

  chores(): Promise<ChoreListRow[]> {
    return this.choreCache.get();
  }

  /**
   * Every chore the account can see, active and archived, unfiltered. This is the
   * shape includeArchived actually returns, and it is what a lookup by id needs: a
   * chore can be missing from the cached active list without being archived, and
   * falling through to GET /:id/details for one produces a row with none of the
   * fields a projection reads.
   */
  async allChores(): Promise<ChoreListRow[]> {
    // The fourth loader, and the one whose failure produced the message the guard was
    // written for: archivedChores() filters this result, so a non-array here reached
    // the model as "(await this.allChores()).filter is not a function", quoting the
    // whole arrow function. Reached by unarchive_chore, delete_chore's resolve,
    // list_chores scope=archived, and every id fallback in loadChoreById.
    return expectArray<ChoreListRow>(
      await this.client.get(endpoints.listChoresWithArchived()),
      "archived chore list",
    );
  }

  /**
   * includeArchived=true returns active and archived chores together, not the
   * archived ones alone, so the filter here is what makes this the archived list.
   * The test is isActive === false rather than !isActive: the field is optional,
   * and a row that omits it must not be reported as archived.
   */
  async archivedChores(): Promise<ChoreListRow[]> {
    return (await this.allChores()).filter(isArchivedChore);
  }

  members(): Promise<Member[]> {
    return this.memberCache.get();
  }

  projects(): Promise<Project[]> {
    return this.projectCache.get();
  }

  choreDetails(id: number): Promise<ChoreDetails> {
    return this.client.get(endpoints.choreDetails(id)) as Promise<ChoreDetails>;
  }

  rawGet(path: string): Promise<unknown> {
    return this.client.get(path);
  }

  /**
   * Donetick's CreateChore inserts the row before several later steps that can fail,
   * so a failed write can still have changed state. Invalidation runs in finally.
   */
  async write<T>(operation: () => Promise<T>, options: { movesPoints?: boolean } = {}): Promise<T> {
    try {
      return await operation();
    } finally {
      this.choreCache.invalidate();
      // Same finally, same reason. The three point-moving tools called this after
      // the await, so a completion that timed out after landing left the member
      // cache holding the pre-completion total for the rest of its five minutes,
      // which is exactly the case the chore invalidation is in a finally for.
      if (options.movesPoints === true) this.memberCache.invalidate();
    }
  }

  invalidateChores(): void {
    this.choreCache.invalidate();
  }

  /**
   * For the writes that move points between members: completing, approving, and
   * undoing. Separate from write() because the member cache has a five minute TTL
   * and most writes cannot touch it, so invalidating it on every write would throw
   * away a cache that is right almost all of the time. list_members answers
   * point-standing questions off that cache, and read the pre-completion standing
   * for up to five minutes after a chore worth points was completed.
   */
  invalidateMembers(): void {
    this.memberCache.invalidate();
  }
}
