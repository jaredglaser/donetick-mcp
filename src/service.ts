import { TtlCache } from "@/cache";
import type { DonetickClient } from "@/client";
import { endpoints } from "@/endpoints";
import type { Member, Project, RawChore } from "@/types";

interface RawMember {
  id: number;
  userId: number;
  username?: string;
  displayName?: string;
  role?: string;
  points?: number;
  pointsRedeemed?: number;
}

const MEMBER_TTL_MS = 300_000;

export class DonetickService {
  private readonly choreCache: TtlCache<RawChore[]>;
  private readonly memberCache: TtlCache<Member[]>;
  private readonly projectCache: TtlCache<Project[]>;

  constructor(
    readonly client: DonetickClient,
    options: { cacheTtlMs: number },
  ) {
    this.choreCache = new TtlCache(
      async () => (await this.client.get(endpoints.listChores())) as RawChore[],
      options.cacheTtlMs,
    );
    this.memberCache = new TtlCache(async () => {
      const raw = (await this.client.get(endpoints.circleMembers())) as RawMember[];
      const seen = new Map<number, Member>();
      for (const row of raw) {
        if (seen.has(row.userId)) continue;
        seen.set(row.userId, {
          userId: row.userId,
          username: row.username ?? "",
          displayName: row.displayName || row.username || `user ${row.userId}`,
          role: row.role ?? "member",
          points: row.points ?? 0,
          pointsRedeemed: row.pointsRedeemed ?? 0,
        });
      }
      return [...seen.values()];
    }, MEMBER_TTL_MS);
    this.projectCache = new TtlCache(
      async () => ((await this.client.get(endpoints.projects())) ?? []) as Project[],
      MEMBER_TTL_MS,
    );
  }

  chores(): Promise<RawChore[]> {
    return this.choreCache.get();
  }

  archivedChores(): Promise<RawChore[]> {
    return this.client.get(endpoints.listChoresWithArchived()) as Promise<RawChore[]>;
  }

  members(): Promise<Member[]> {
    return this.memberCache.get();
  }

  projects(): Promise<Project[]> {
    return this.projectCache.get();
  }

  choreDetails(id: number): Promise<RawChore> {
    return this.client.get(endpoints.choreDetails(id)) as Promise<RawChore>;
  }

  rawGet(path: string): Promise<unknown> {
    return this.client.get(path);
  }

  /**
   * Donetick's CreateChore inserts the row before several later steps that can fail,
   * so a failed write can still have changed state. Invalidation runs in finally.
   */
  async write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.choreCache.invalidate();
    }
  }

  invalidateChores(): void {
    this.choreCache.invalidate();
  }
}
